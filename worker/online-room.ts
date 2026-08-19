import { applyAction, newOnlineSession, startNextHand, type GameAction, type GameState } from "../app/game.ts";
import type { OnlineChatMessage, OnlineMember, OnlineRoomSnapshot } from "../app/online.ts";

type TurnTime = 30 | 120 | 300;

export type RoomMemberRecord = {
  id: string;
  token: string;
  name: string;
  avatar: string;
  seat: number;
  ready: boolean;
  joinedAt: number;
};

export type RoomRecord = {
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

type StoredRoom = { room: RoomRecord; revision: number };
type MessageBody = Record<string, unknown>;

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

class RoomRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function randomToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

function randomRoomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join("");
}

function cleanName(value: unknown): string {
  return [...String(value || "")].filter((character) => character.charCodeAt(0) >= 32 && !"<>".includes(character)).join("").trim().slice(0, 12);
}

function cleanChatText(value: unknown): string {
  return [...String(value || "")]
    .filter((character) => character.charCodeAt(0) >= 32)
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

function addChatMessage(room: RoomRecord, message: OnlineChatMessage): void {
  room.chat = [...(room.chat || []), message].slice(-80);
}

function addSystemMessage(room: RoomRecord, text: string): void {
  addChatMessage(room, {
    id: crypto.randomUUID(), senderId: null, name: "牌桌", avatar: "P", text,
    createdAt: Date.now(), kind: "system",
  });
}

function withDeadline(room: RoomRecord): RoomRecord {
  const playing = room.game?.status === "playing" && (room.game.currentPlayer ?? -1) >= 0;
  return { ...room, deadlineAt: playing ? Date.now() + room.turnTime * 1000 : null };
}

function applyExpiredTurn(room: RoomRecord): RoomRecord {
  if (!room.game || room.game.status !== "playing" || !room.deadlineAt || Date.now() < room.deadlineAt) return room;
  const actor = room.game.players[room.game.currentPlayer];
  if (!actor) return room;
  const due = Math.max(0, room.game.currentBet - actor.bet);
  room.game = applyAction(room.game, actor.id, due === 0 ? { type: "checkCall" } : { type: "fold" });
  room.version += 1;
  room.message = `${actor.name} 行动超时，已${due === 0 ? "自动过牌" : "自动弃牌"}`;
  addSystemMessage(room, room.message);
  return withDeadline(room);
}

export function publicGame(game: GameState, viewerId: string): GameState {
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

async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS online_rooms (
      code TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS online_presence (
      room_code TEXT NOT NULL,
      player_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (room_code, player_id)
    )`),
  ]);
}

async function loadRoom(db: D1Database, code: string): Promise<StoredRoom | null> {
  const row = await db.prepare("SELECT state, revision FROM online_rooms WHERE code = ?").bind(code).first<{ state: string; revision: number }>();
  if (!row) return null;
  try { return { room: JSON.parse(row.state) as RoomRecord, revision: Number(row.revision) }; }
  catch { throw new RoomRequestError(500, "房间状态损坏，请重新创建房间"); }
}

async function writeRoom(db: D1Database, code: string, expectedRevision: number, room: RoomRecord): Promise<boolean> {
  room.updatedAt = Date.now();
  const result = await db.prepare("UPDATE online_rooms SET state = ?, revision = revision + 1, updated_at = ? WHERE code = ? AND revision = ?")
    .bind(JSON.stringify(room), room.updatedAt, code, expectedRevision).run();
  return Number(result.meta.changes || 0) === 1;
}

async function currentRoom(db: D1Database, code: string): Promise<StoredRoom> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stored = await loadRoom(db, code);
    if (!stored) throw new RoomRequestError(404, "没有找到这个房间");
    if (!stored.room.deadlineAt || Date.now() < stored.room.deadlineAt) return stored;
    const room = applyExpiredTurn(structuredClone(stored.room));
    if (await writeRoom(db, code, stored.revision, room)) return { room, revision: stored.revision + 1 };
  }
  throw new RoomRequestError(409, "房间刚刚发生变化，请重试");
}

async function touchPresence(db: D1Database, code: string, playerId: string): Promise<void> {
  await db.prepare(`INSERT INTO online_presence (room_code, player_id, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(room_code, player_id) DO UPDATE SET last_seen = excluded.last_seen`)
    .bind(code, playerId, Date.now()).run();
}

async function connectedIds(db: D1Database, code: string): Promise<Set<string>> {
  const result = await db.prepare("SELECT player_id FROM online_presence WHERE room_code = ? AND last_seen >= ?")
    .bind(code, Date.now() - 5_000).all<{ player_id: string }>();
  return new Set((result.results || []).map((row) => row.player_id));
}

async function snapshot(db: D1Database, room: RoomRecord, viewerId: string): Promise<OnlineRoomSnapshot> {
  await touchPresence(db, room.code, viewerId);
  const connected = await connectedIds(db, room.code);
  const members: OnlineMember[] = room.members.map((member) => ({
    id: member.id, name: member.name, avatar: member.avatar, seat: member.seat, ready: member.ready,
    connected: connected.has(member.id), isHost: member.id === room.hostId,
  }));
  return {
    roomCode: room.code, status: room.status, capacity: room.capacity, turnTime: room.turnTime, viewerId,
    members, game: room.game ? publicGame(room.game, viewerId) : null, deadlineAt: room.deadlineAt,
    version: room.version, message: room.message, chat: room.chat || [],
  };
}

function authenticate(room: RoomRecord, request: Request): RoomMemberRecord {
  const playerId = request.headers.get("x-pocket-player-id") || "";
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const member = room.members.find((candidate) => candidate.id === playerId && candidate.token === token);
  if (!member) throw new RoomRequestError(401, "房间身份无效");
  return member;
}

async function readBody(request: Request): Promise<MessageBody> {
  if (Number(request.headers.get("content-length") || 0) > 4_096) throw new RoomRequestError(413, "请求内容过大");
  return await request.json().catch(() => { throw new RoomRequestError(400, "请求格式无效"); }) as MessageBody;
}

async function createRoom(db: D1Database, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = cleanName(body.name);
  const capacity = Math.max(2, Math.min(6, Number(body.capacity) || 4));
  const turnTime = [30, 120, 300].includes(Number(body.turnTime)) ? Number(body.turnTime) as TurnTime : 120;
  if (name.length < 2) throw new RoomRequestError(400, "请输入 2–12 个字符的名字");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = randomRoomCode();
    const playerId = crypto.randomUUID();
    const token = randomToken();
    const room: RoomRecord = {
      code, status: "lobby", capacity, turnTime, hostId: playerId,
      members: [{ id: playerId, token, name, avatar: name.slice(0, 1).toUpperCase(), seat: 0, ready: false, joinedAt: Date.now() }],
      game: null, deadlineAt: null, version: 1, message: "等待玩家加入", chat: [], recentActionIds: [], updatedAt: Date.now(),
    };
    addSystemMessage(room, `${name} 创建了房间`);
    const result = await db.prepare("INSERT OR IGNORE INTO online_rooms (code, state, revision, updated_at) VALUES (?, ?, 1, ?)")
      .bind(code, JSON.stringify(room), room.updatedAt).run();
    if (Number(result.meta.changes || 0) === 1) {
      await touchPresence(db, code, playerId);
      return response({ roomCode: code, playerId, token });
    }
  }
  throw new RoomRequestError(503, "暂时无法分配房间号，请重试");
}

async function joinRoom(db: D1Database, code: string, request: Request): Promise<Response> {
  const body = await readBody(request);
  const name = cleanName(body.name);
  if (name.length < 2) throw new RoomRequestError(400, "请输入 2–12 个字符的名字");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stored = await currentRoom(db, code);
    const room = structuredClone(stored.room);
    if (room.status !== "lobby") throw new RoomRequestError(409, "牌局已经开始，暂时不能加入");
    if (room.members.length >= room.capacity) throw new RoomRequestError(409, "房间已经坐满");
    if (room.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) throw new RoomRequestError(409, "房间里已有同名玩家");
    const playerId = crypto.randomUUID();
    const token = randomToken();
    const usedSeats = new Set(room.members.map((member) => member.seat));
    let seat = 0;
    while (usedSeats.has(seat)) seat += 1;
    room.members.push({ id: playerId, token, name, avatar: name.slice(0, 1).toUpperCase(), seat, ready: false, joinedAt: Date.now() });
    room.version += 1;
    room.message = `${name} 加入了房间`;
    addSystemMessage(room, room.message);
    if (await writeRoom(db, code, stored.revision, room)) {
      await touchPresence(db, code, playerId);
      return response({ roomCode: code, playerId, token });
    }
  }
  throw new RoomRequestError(409, "房间刚刚发生变化，请重试");
}

export function applyMessage(room: RoomRecord, member: RoomMemberRecord, message: MessageBody): { room: RoomRecord; deleted?: boolean } {
  if (message.type === "ready" && room.status === "lobby") {
    member.ready = Boolean(message.ready);
    room.version += 1;
    room.message = member.ready ? `${member.name} 已准备` : `${member.name} 取消准备`;
  } else if (message.type === "start") {
    if (room.hostId !== member.id) throw new RoomRequestError(403, "只有房主可以开始牌局");
    if (room.status !== "lobby" || room.members.length < 2 || room.members.some((candidate) => !candidate.ready)) throw new RoomRequestError(409, "至少两人且所有玩家准备后才能开始");
    room.game = newOnlineSession([...room.members].sort((a, b) => a.seat - b.seat).map((candidate) => ({ id: candidate.id, name: candidate.name, avatar: candidate.avatar })));
    room.status = "playing";
    room.version += 1;
    room.message = "牌局开始";
    addSystemMessage(room, "所有玩家已准备，牌局开始");
    room = withDeadline(room);
  } else if (message.type === "action") {
    if (!room.game || room.status !== "playing") throw new RoomRequestError(409, "牌局尚未开始");
    if (Number(message.version) !== room.version) throw new RoomRequestError(409, "牌局状态已更新，正在同步");
    const actionId = String(message.actionId || "").slice(0, 80);
    if (!actionId || room.recentActionIds.includes(actionId)) return { room };
    const actor = room.game.players[room.game.currentPlayer];
    if (!actor || actor.id !== member.id) throw new RoomRequestError(409, "现在还没有轮到你");
    const action = cleanAction(message.action);
    if (!action) throw new RoomRequestError(400, "这个操作不合法");
    room.game = applyAction(room.game, member.id, action);
    room.recentActionIds = [...room.recentActionIds, actionId].slice(-80);
    room.version += 1;
    room.message = room.game.message;
    room = withDeadline(room);
  } else if (message.type === "chat") {
    const text = cleanChatText(message.text);
    const messageId = String(message.messageId || "").slice(0, 80);
    if (!text || !messageId) throw new RoomRequestError(400, "请输入聊天内容");
    if (room.chat.some((item) => item.id === messageId)) return { room };
    if (room.chat.filter((item) => item.senderId === member.id && item.createdAt > Date.now() - 5_000).length >= 5) throw new RoomRequestError(429, "聊天发送得太快了，请稍后再试");
    addChatMessage(room, { id: messageId, senderId: member.id, name: member.name, avatar: member.avatar, text, createdAt: Date.now(), kind: "player" });
  } else if (message.type === "nextHand") {
    if (room.hostId !== member.id) throw new RoomRequestError(403, "只有房主可以开始下一手");
    if (!room.game || room.game.status !== "handOver") throw new RoomRequestError(409, "当前不能开始下一手");
    room.game = startNextHand(room.game);
    room.status = room.game.status === "gameOver" ? "finished" : "playing";
    room.version += 1;
    room.message = room.game.message;
    addSystemMessage(room, `第 ${room.game.handNo} 手开始`);
    room = withDeadline(room);
  } else if (message.type === "leave" && room.status === "lobby") {
    room.members = room.members.filter((candidate) => candidate.id !== member.id);
    if (!room.members.length) return { room, deleted: true };
    if (room.hostId === member.id) room.hostId = room.members[0].id;
    room.version += 1;
    room.message = `${member.name} 离开了房间`;
    addSystemMessage(room, room.message);
  } else if (message.type !== "sync" && message.type !== "ping") {
    throw new RoomRequestError(409, "当前不能执行这个操作");
  }
  return { room };
}

async function messageRoom(db: D1Database, code: string, request: Request): Promise<Response> {
  const message = await readBody(request);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stored = await currentRoom(db, code);
    const room = structuredClone(stored.room);
    const member = authenticate(room, request);
    const result = applyMessage(room, member, message);
    if (result.deleted) {
      const removed = await db.prepare("DELETE FROM online_rooms WHERE code = ? AND revision = ?").bind(code, stored.revision).run();
      if (Number(removed.meta.changes || 0) === 1) {
        await db.prepare("DELETE FROM online_presence WHERE room_code = ?").bind(code).run();
        return response({ left: true });
      }
    } else if (await writeRoom(db, code, stored.revision, result.room)) {
      return response({ snapshot: await snapshot(db, result.room, member.id) });
    }
  }
  throw new RoomRequestError(409, "房间刚刚发生变化，请重试");
}

async function roomSnapshot(db: D1Database, code: string, request: Request): Promise<Response> {
  const stored = await currentRoom(db, code);
  const member = authenticate(stored.room, request);
  return response({ snapshot: await snapshot(db, stored.room, member.id) });
}

export async function handleOnlineRequest(request: Request, db: D1Database): Promise<Response> {
  try {
    await ensureSchema(db);
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/online/rooms") return createRoom(db, request);
    const match = url.pathname.match(/^\/api\/online\/rooms\/([A-Z2-9]{6})(?:\/(join|snapshot|message))?$/i);
    if (!match) throw new RoomRequestError(404, "联机接口不存在");
    const code = match[1].toUpperCase();
    const action = match[2];
    if (request.method === "POST" && action === "join") return joinRoom(db, code, request);
    if (request.method === "GET" && action === "snapshot") return roomSnapshot(db, code, request);
    if (request.method === "POST" && action === "message") return messageRoom(db, code, request);
    throw new RoomRequestError(400, "联机请求无效");
  } catch (error) {
    const status = error instanceof RoomRequestError ? error.status : 500;
    return response({ error: error instanceof Error ? error.message : "联机服务暂时不可用" }, status);
  }
}
