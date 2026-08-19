import assert from "node:assert/strict";
import test from "node:test";
import { applyMessage, publicGame } from "../worker/online-room.ts";

test("the authoritative room starts only after readiness and isolates each player's cards", async () => {
  const host = { id: "host", token: "h".repeat(64), name: "房主", avatar: "房", seat: 0, ready: false, joinedAt: Date.now() };
  const guest = { id: "guest", token: "g".repeat(64), name: "玩家", avatar: "玩", seat: 1, ready: false, joinedAt: Date.now() };
  let room = {
    code: "ABC234", status: "lobby", capacity: 2, turnTime: 30, hostId: host.id,
    members: [host, guest], game: null, deadlineAt: null, version: 1, message: "等待玩家加入",
    chat: [], recentActionIds: [], updatedAt: Date.now(),
  };

  assert.throws(() => applyMessage(structuredClone(room), host, { type: "start" }), /所有玩家准备/);
  room = applyMessage(room, host, { type: "ready", ready: true }).room;
  room = applyMessage(room, guest, { type: "ready", ready: true }).room;
  room = applyMessage(room, host, { type: "start" }).room;
  assert.equal(room.status, "playing");
  assert.ok(room.deadlineAt > Date.now());

  const hostGame = publicGame(room.game, host.id);
  const guestGame = publicGame(room.game, guest.id);
  assert.deepEqual(hostGame.players.map((player) => player.hole.length), [2, 0]);
  assert.deepEqual(guestGame.players.map((player) => player.hole.length), [2, 0]);

  room = applyMessage(room, host, { type: "chat", messageId: "message-1", text: "  大家好，开牌吧  " }).room;
  assert.equal(room.chat.at(-1).text, "大家好，开牌吧");
  assert.equal(room.chat.at(-1).name, host.name);
  const chatCount = room.chat.length;
  room = applyMessage(room, host, { type: "chat", messageId: "message-1", text: "重复消息" }).room;
  assert.equal(room.chat.length, chatCount);

  const actor = room.game.players[room.game.currentPlayer];
  const actorMember = room.members.find((member) => member.id === actor.id);
  const beforeVersion = room.version;
  room = applyMessage(room, actorMember, { type: "action", actionId: "action-1", version: beforeVersion, action: { type: "checkCall" } }).room;
  assert.equal(room.version, beforeVersion + 1);
  assert.match(room.game.message, /跟注|过牌/);

  const duplicateVersion = room.version;
  assert.throws(() => applyMessage(room, actorMember, { type: "action", actionId: "action-1", version: beforeVersion, action: { type: "checkCall" } }), /状态已更新/);
  assert.equal(room.version, duplicateVersion);
});
