import assert from "node:assert/strict";
import test from "node:test";
import { PokerRoom } from "../worker/poker-room.ts";

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async setAlarm(value) { this.alarmAt = value; }
  async deleteAlarm() { this.alarmAt = null; }
  async deleteAll() { this.values.clear(); this.alarmAt = null; }
}

class MockSocket {
  readyState = WebSocket.OPEN;
  attachment = null;
  messages = [];
  serializeAttachment(value) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return this.attachment; }
  send(value) { this.messages.push(JSON.parse(value)); }
  close() { this.readyState = WebSocket.CLOSED; }
}

function roomContext() {
  const sockets = [];
  return {
    storage: new MemoryStorage(),
    sockets,
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return sockets.filter((socket) => socket.readyState === WebSocket.OPEN); },
  };
}

function request(path, body) {
  return new Request(`https://room.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

test("the authoritative room starts only after readiness and isolates each player's cards", async () => {
  const ctx = roomContext();
  const room = new PokerRoom(ctx);
  const host = { playerId: "host", token: "h".repeat(64), name: "房主" };
  const guest = { playerId: "guest", token: "g".repeat(64), name: "玩家" };
  assert.equal((await room.fetch(request("/create", { ...host, code: "ABC234", capacity: 2, turnTime: 30 }))).status, 200);
  assert.equal((await room.fetch(request("/join", guest))).status, 200);

  const hostSocket = new MockSocket();
  hostSocket.serializeAttachment({ playerId: host.playerId, token: host.token, windowStartedAt: Date.now(), messagesInWindow: 0 });
  const guestSocket = new MockSocket();
  guestSocket.serializeAttachment({ playerId: guest.playerId, token: guest.token, windowStartedAt: Date.now(), messagesInWindow: 0 });
  ctx.sockets.push(hostSocket, guestSocket);

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "start" }));
  assert.equal((await ctx.storage.get("room")).status, "lobby");
  assert.match(hostSocket.messages.at(-1).message, /所有玩家准备/);

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "ready", ready: true }));
  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "ready", ready: true }));
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "start" }));
  const state = await ctx.storage.get("room");
  assert.equal(state.status, "playing");
  assert.ok(state.deadlineAt > Date.now());

  const hostSnapshot = hostSocket.messages.filter((message) => message.type === "snapshot").at(-1).snapshot;
  const guestSnapshot = guestSocket.messages.filter((message) => message.type === "snapshot").at(-1).snapshot;
  assert.deepEqual(hostSnapshot.game.players.map((player) => player.hole.length), [2, 0]);
  assert.deepEqual(guestSnapshot.game.players.map((player) => player.hole.length), [2, 0]);
  assert.notEqual(hostSnapshot.viewerId, guestSnapshot.viewerId);

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "chat", messageId: "message-1", text: "  大家好，开牌吧  " }));
  const chatSnapshot = guestSocket.messages.filter((message) => message.type === "snapshot").at(-1).snapshot;
  assert.equal(chatSnapshot.chat.at(-1).text, "大家好，开牌吧");
  assert.equal(chatSnapshot.chat.at(-1).name, host.name);
  assert.equal(chatSnapshot.chat.at(-1).kind, "player");
  const chatCount = (await ctx.storage.get("room")).chat.length;
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "chat", messageId: "message-1", text: "重复消息" }));
  assert.equal((await ctx.storage.get("room")).chat.length, chatCount);

  const actor = state.game.players[state.game.currentPlayer];
  const actorSocket = actor.id === host.playerId ? hostSocket : guestSocket;
  const beforeVersion = state.version;
  await room.webSocketMessage(actorSocket, JSON.stringify({ type: "action", actionId: "action-1", version: beforeVersion, action: { type: "checkCall" } }));
  const after = await ctx.storage.get("room");
  assert.equal(after.version, beforeVersion + 1);
  assert.match(after.game.message, /跟注|过牌/);

  await room.webSocketMessage(actorSocket, JSON.stringify({ type: "action", actionId: "action-1", version: beforeVersion, action: { type: "checkCall" } }));
  assert.equal((await ctx.storage.get("room")).version, after.version);
});
