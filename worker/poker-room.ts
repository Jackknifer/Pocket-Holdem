import { applyAction, newOnlineSession, startNextHand, type GameAction, type GameState } from "../app/game.ts";
import type { OnlineChatMessage, OnlineMember, OnlineRoomSnapshot, OnlineServerMessage } from "../app/online.ts";

type TurnTime = 30 | 120 | 300;

type RoomMemberRecord = {
  id: string;
  token: string;
  name: string;
  avatar: string;
  seat: number;
  ready: boolean;
  joinedAt: number;
};

type RoomRecord = {
  code: string;
  status: "lobby" | "playing" | "finished";
  capacity: number;
  turnTime: TurnTime;
  hostId: string;
  members: RoomMemberRecord[];
  game: GameState | null;
  deadlineAt: number | null;
  version: number;
  message: string;
  chat: OnlineChatMessage[];
  recentActionIds: string[];
  updatedAt: number;
};

type SocketAttachment = {
  playerId: string;
  token: string;
  windowStartedAt: number;
  messagesInWindow: number;
  chatWindowStartedAt?: number;
  chatMessagesInWindow?: number;
};

const ROOM_KEY = "room";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function cleanName(value: unknown): string {
  return [...String(value || "")].filter((character) => character.charCodeAt(0) >= 32 && !"<>".includes(character)).join("").trim().slice(0, 12);
}

function cleanChatText(value: unknown): string {
  return [...String(value || "")]
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function cleanAction(value: unknown): GameAction | null {
  if (!value || typeof value !== "object") return null;
  const action = value as { type?: unknown; amount?: unknown };
  if (["fold", "checkCall", "allIn"].includes(String(action.type))) return { type: action.type as "fold" | "checkCall" | "allIn" };
  if (action.type === "raise" && typeof action.amount === "number" && Number.isFinite(action.amount)) {
    return { type: "raise", amount: Math.max(0, Math.min(10_000_000, Math.round(action.amount))) };
  }
  return null;
}

export class PokerRoom {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async room(): Promise<RoomRecord | null> {
    return await this.ctx.storage.get<RoomRecord>(ROOM_KEY) || null;
  }

  private async save(room: RoomRecord): Promise<void> {
    room.updatedAt = Date.now();
    await this.ctx.storage.put(ROOM_KEY, room);
    if (room.deadlineAt) await this.ctx.storage.setAlarm(room.deadlineAt);
    else await this.ctx.storage.deleteAlarm();
  }

  private member(room: RoomRecord, playerId: string, token: string): RoomMemberRecord | null {
    return room.members.find((candidate) => candidate.id === playerId && candidate.token === token) || null;
  }

  private connectedIds(): Set<string> {
    return new Set(this.ctx.getWebSockets().map((socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.playerId).filter(Boolean) as string[]);
  }

  private publicGame(game: GameState, viewerId: string): GameState {
    const revealShowdown = game.status === "handOver" && game.phase === "showdown";
    const viewerIndex = Math.max(0, game.players.findIndex((player) => player.id === viewerId));
    const rotated = [...game.players.slice(viewerIndex), ...game.players.slice(0, viewerIndex)];
    const rotateIndex = (index: number) => index < 0 ? index : (index - viewerIndex + game.players.length) % game.players.length;
    return {
      ...game,
      deck: [],
      dealer: rotateIndex(game.dealer),
      currentPlayer: rotateIndex(game.currentPlayer),
      players: rotated.map((player) => ({
        ...player,
        isHuman: player.id === viewerId,
        hole: player.id === viewerId || (revealShowdown && !player.folded) ? player.hole : [],
      })),
    };
  }

  private snapshot(room: RoomRecord, viewerId: string): OnlineRoomSnapshot {
    const connected = this.connectedIds();
    const members: OnlineMember[] = room.members.map((member) => ({
      id: member.id, name: member.name, avatar: member.avatar, seat: member.seat, ready: member.ready,
      connected: connected.has(member.id), isHost: member.id === room.hostId,
    }));
    return {
      roomCode: room.code, status: room.status, capacity: room.capacity, turnTime: room.turnTime, viewerId,
      members, game: room.game ? this.publicGame(room.game, viewerId) : null, deadlineAt: room.deadlineAt,
      version: room.version, message: room.message, chat: room.chat || [],
    };
  }

  private addSystemMessage(room: RoomRecord, text: string): void {
    this.addChatMessage(room, {
      id: crypto.randomUUID(), senderId: null, name: "牌桌", avatar: "P", text,
      createdAt: Date.now(), kind: "system",
    });
  }

  private addChatMessage(room: RoomRecord, message: OnlineChatMessage): void {
    room.chat = [...(room.chat || []), message].slice(-80);
  }

  private send(socket: WebSocket, message: OnlineServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, { type: "error", message });
  }

  private broadcast(room: RoomRecord): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.playerId) this.send(socket, { type: "snapshot", snapshot: this.snapshot(room, attachment.playerId) });
    }
  }

  private withDeadline(room: RoomRecord): RoomRecord {
    const playing = room.game?.status === "playing" && (room.game.currentPlayer ?? -1) >= 0;
    return { ...room, deadlineAt: playing ? Date.now() + room.turnTime * 1000 : null };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/create") return this.create(request);
    if (request.method === "POST" && url.pathname === "/join") return this.join(request);
    if (url.pathname === "/socket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") return this.connect(request);
    return json({ error: "联机房间接口不存在" }, 404);
  }

  private async create(request: Request): Promise<Response> {
    if (await this.room()) return json({ error: "房间号已被使用" }, 409);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = cleanName(body?.name);
    const code = String(body?.code || "").toUpperCase();
    const playerId = String(body?.playerId || "");
    const token = String(body?.token || "");
    const capacity = Math.max(2, Math.min(6, Number(body?.capacity) || 4));
    const turnTime = [30, 120, 300].includes(Number(body?.turnTime)) ? Number(body?.turnTime) as TurnTime : 120;
    if (name.length < 2 || !/^[A-Z2-9]{6}$/.test(code) || !playerId || token.length < 32) return json({ error: "创建房间参数无效" }, 400);
    const room: RoomRecord = {
      code, status: "lobby", capacity, turnTime, hostId: playerId,
      members: [{ id: playerId, token, name, avatar: name.slice(0, 1).toUpperCase(), seat: 0, ready: false, joinedAt: Date.now() }],
      game: null, deadlineAt: null, version: 1, message: "等待玩家加入", chat: [], recentActionIds: [], updatedAt: Date.now(),
    };
    this.addSystemMessage(room, `${name} 创建了房间`);
    await this.save(room);
    return json({ roomCode: code, playerId, token });
  }

  private async join(request: Request): Promise<Response> {
    const room = await this.room();
    if (!room) return json({ error: "没有找到这个房间" }, 404);
    if (room.status !== "lobby") return json({ error: "牌局已经开始，暂时不能加入" }, 409);
    if (room.members.length >= room.capacity) return json({ error: "房间已经坐满" }, 409);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const name = cleanName(body?.name);
    const playerId = String(body?.playerId || "");
    const token = String(body?.token || "");
    if (name.length < 2 || !playerId || token.length < 32) return json({ error: "加入房间参数无效" }, 400);
    if (room.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) return json({ error: "房间里已有同名玩家" }, 409);
    const usedSeats = new Set(room.members.map((member) => member.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat += 1;
    room.members.push({ id: playerId, token, name, avatar: name.slice(0, 1).toUpperCase(), seat, ready: false, joinedAt: Date.now() });
    room.version += 1;
    room.message = `${name} 加入了房间`;
    this.addSystemMessage(room, room.message);
    await this.save(room);
    this.broadcast(room);
    return json({ roomCode: room.code, playerId, token });
  }

  private async connect(request: Request): Promise<Response> {
    const room = await this.room();
    if (!room) return json({ error: "房间已经失效" }, 404);
    const url = new URL(request.url);
    const playerId = url.searchParams.get("playerId") || "";
    const token = url.searchParams.get("token") || "";
    if (!this.member(room, playerId, token)) return json({ error: "房间身份无效" }, 401);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({
      playerId, token, windowStartedAt: Date.now(), messagesInWindow: 0,
      chatWindowStartedAt: Date.now(), chatMessagesInWindow: 0,
    } satisfies SocketAttachment);
    queueMicrotask(() => this.broadcast(room));
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 2_048) return this.sendError(socket, "消息格式无效");
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return socket.close(1008, "身份无效");
    const now = Date.now();
    if (now - attachment.windowStartedAt > 2_000) {
      attachment.windowStartedAt = now;
      attachment.messagesInWindow = 0;
    }
    attachment.messagesInWindow += 1;
    socket.serializeAttachment(attachment);
    if (attachment.messagesInWindow > 20) return this.sendError(socket, "操作过于频繁");
    const room = await this.room();
    if (!room || !this.member(room, attachment.playerId, attachment.token)) return socket.close(1008, "房间身份已失效");
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; }
    catch { return this.sendError(socket, "消息格式无效"); }

    if (message.type === "ping") return this.send(socket, { type: "pong", now });
    if (message.type === "sync") return this.send(socket, { type: "snapshot", snapshot: this.snapshot(room, attachment.playerId) });

    const member = room.members.find((candidate) => candidate.id === attachment.playerId)!;
    if (message.type === "chat") {
      const text = cleanChatText(message.text);
      const messageId = String(message.messageId || "").slice(0, 80);
      if (!text || !messageId) return this.sendError(socket, "请输入聊天内容");
      if ((room.chat || []).some((item) => item.id === messageId)) return;
      if (!attachment.chatWindowStartedAt || now - attachment.chatWindowStartedAt > 5_000) {
        attachment.chatWindowStartedAt = now;
        attachment.chatMessagesInWindow = 0;
      }
      attachment.chatMessagesInWindow = (attachment.chatMessagesInWindow || 0) + 1;
      socket.serializeAttachment(attachment);
      if (attachment.chatMessagesInWindow > 5) return this.sendError(socket, "聊天发送得太快了，请稍后再试");
      this.addChatMessage(room, {
        id: messageId, senderId: member.id, name: member.name, avatar: member.avatar,
        text, createdAt: now, kind: "player",
      });
      await this.save(room);
      this.broadcast(room);
      return;
    }

    if (message.type === "ready" && room.status === "lobby") {
      member.ready = Boolean(message.ready);
      room.version += 1;
      room.message = member.ready ? `${member.name} 已准备` : `${member.name} 取消准备`;
    } else if (message.type === "start") {
      if (room.hostId !== member.id) return this.sendError(socket, "只有房主可以开始牌局");
      if (room.status !== "lobby" || room.members.length < 2 || room.members.some((candidate) => !candidate.ready)) return this.sendError(socket, "至少两人且所有玩家准备后才能开始");
      room.game = newOnlineSession([...room.members].sort((a, b) => a.seat - b.seat).map((candidate) => ({ id: candidate.id, name: candidate.name, avatar: candidate.avatar })));
      room.status = "playing";
      room.version += 1;
      room.message = "牌局开始";
      this.addSystemMessage(room, "所有玩家已准备，牌局开始");
      Object.assign(room, this.withDeadline(room));
    } else if (message.type === "action") {
      if (!room.game || room.status !== "playing") return this.sendError(socket, "牌局尚未开始");
      if (Number(message.version) !== room.version) return this.sendError(socket, "牌局状态已更新，正在同步");
      const actionId = String(message.actionId || "").slice(0, 80);
      if (!actionId || room.recentActionIds.includes(actionId)) return;
      const actor = room.game.players[room.game.currentPlayer];
      if (!actor || actor.id !== member.id) return this.sendError(socket, "现在还没有轮到你");
      const action = cleanAction(message.action);
      if (!action) return this.sendError(socket, "这个操作不合法");
      room.game = applyAction(room.game, member.id, action);
      room.recentActionIds = [...room.recentActionIds, actionId].slice(-80);
      room.version += 1;
      room.message = room.game.message;
      Object.assign(room, this.withDeadline(room));
    } else if (message.type === "nextHand") {
      if (room.hostId !== member.id) return this.sendError(socket, "只有房主可以开始下一手");
      if (!room.game || room.game.status !== "handOver") return this.sendError(socket, "当前不能开始下一手");
      room.game = startNextHand(room.game);
      room.status = room.game.status === "gameOver" ? "finished" : "playing";
      room.version += 1;
      room.message = room.game.message;
      this.addSystemMessage(room, `第 ${room.game.handNo} 手开始`);
      Object.assign(room, this.withDeadline(room));
    } else if (message.type === "leave" && room.status === "lobby") {
      room.members = room.members.filter((candidate) => candidate.id !== member.id);
      if (!room.members.length) {
        await this.ctx.storage.deleteAll();
        socket.close(1000, "已离开房间");
        return;
      }
      if (room.hostId === member.id) room.hostId = room.members[0].id;
      room.version += 1;
      room.message = `${member.name} 离开了房间`;
      this.addSystemMessage(room, room.message);
      socket.close(1000, "已离开房间");
    } else {
      return this.sendError(socket, "当前不能执行这个操作");
    }

    await this.save(room);
    this.broadcast(room);
  }

  async webSocketClose(): Promise<void> {
    const room = await this.room();
    if (room) this.broadcast(room);
  }

  async webSocketError(): Promise<void> {
    const room = await this.room();
    if (room) this.broadcast(room);
  }

  async alarm(): Promise<void> {
    const room = await this.room();
    if (!room?.game || room.game.status !== "playing" || !room.deadlineAt) return;
    if (Date.now() < room.deadlineAt) {
      await this.ctx.storage.setAlarm(room.deadlineAt);
      return;
    }
    const actor = room.game.players[room.game.currentPlayer];
    if (!actor) return;
    const due = Math.max(0, room.game.currentBet - actor.bet);
    room.game = applyAction(room.game, actor.id, due === 0 ? { type: "checkCall" } : { type: "fold" });
    room.version += 1;
    room.message = `${actor.name} 行动超时，已${due === 0 ? "自动过牌" : "自动弃牌"}`;
    this.addSystemMessage(room, room.message);
    Object.assign(room, this.withDeadline(room));
    await this.save(room);
    this.broadcast(room);
  }
}
