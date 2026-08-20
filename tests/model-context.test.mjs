import assert from "node:assert/strict";
import test from "node:test";
import { buildModelContext } from "../app/model-poker.ts";
import { newSession } from "../app/game.ts";

test("model context binds the actor to the complete opponent skill and public table frame", () => {
  const game = newSession(4);
  const actor = game.players.find((player) => player.id === "aria");
  assert.ok(actor);

  const context = buildModelContext(game, actor, 120, "aria");
  assert.equal(context.contextVersion, "2.0");
  assert.equal(context.role.skill.id, "aria");
  assert.equal(context.role.skill.version, "2.0");
  assert.equal(context.skillExecution.skillId, "aria");
  assert.equal(context.skillExecution.skillVersion, "2.0");
  assert.deepEqual(context.skillExecution.applyInOrder, [
    "guardrails", "decisionProtocol", "priorityOrder", "activeStreetRules", "decisionMatrix", "sizing", "outputRequirements",
  ]);
  assert.ok(context.skillExecution.activeStreetRules.length >= 3);
  assert.ok(context.skillExecution.decisionMatrix.length >= 5);
  assert.equal(context.actor.id, "aria");
  assert.match(context.actor.position, /BTN|SB|BB|UTG|HJ|CO|位置/);
  assert.equal(context.actionDeadlineSeconds, 120);
  assert.equal(context.gameRules.variant, "No-limit Texas Hold'em");
  assert.match(context.gameRules.board, /烧/);
  assert.match(context.informationBoundary.forbidden.join(" "), /hole cards|隐藏牌/);
});

test("model context passes decision clocks and tabled hands through as public signals", () => {
  const base = newSession(4);
  const game = {
    ...base,
    decisionTiming: { aria: { last: 8.2, hand: [8.2, 4.4], total: 16.4, samples: 2 } },
    revealedHands: [{
      handNo: 1, reachedShowdown: true, pot: 320, board: ["A♠", "K♦", "2♥", "7♣", "9♦"],
      reveals: [{ id: "mira", name: "Mira", hole: ["A♥", "Q♥"], label: "一对", won: true }],
    }],
  };
  const actor = game.players.find((player) => player.id === "aria");
  assert.ok(actor);

  const context = buildModelContext(game, actor, 120, "aria", { maxReasoning: false });
  assert.deepEqual(context.actor.decisionClock, { lastSeconds: 8.2, thisHandSeconds: [8.2, 4.4], averageSeconds: 8.2, decisions: 2 });
  assert.equal(context.players.find((player) => player.id === "mira").decisionClock, null);
  assert.equal(context.revealedHistory.length, 1);
  assert.deepEqual(context.revealedHistory[0].board, ["A♠", "K♦", "2♥", "7♣", "9♦"]);
  assert.deepEqual(context.revealedHistory[0].shownHands, ["Mira: A♥ Q♥ · 一对 · 获胜"]);
  assert.match(Object.values(context.publicSignals).join(" "), /decisionClock/);
  assert.match(context.informationBoundary.allowed.join(" "), /decisionClock/);

  assert.equal(context.competitiveProfile.level, "standard");
  assert.equal(context.competitiveProfile.simulations, 260);
  assert.equal(buildModelContext(game, actor, 120, "aria").competitiveProfile.level, "maximum");
  assert.equal(buildModelContext(game, actor, 120, "aria").competitiveProfile.simulations, 960);
});

test("a serialized context stays well inside the server payload limit", () => {
  const base = newSession(6);
  // Worst case: a full table, timing for every seat, the longest reveal history and log the engine keeps.
  const game = {
    ...base,
    log: Array.from({ length: 12 }, (_, index) => ({ id: index, text: `玩家 ${index} 加注到 1200，底池 4800，剩余筹码 3600`, tone: "muted" })),
    decisionTiming: Object.fromEntries(base.players.map((player) => [
      player.id, { last: 27.5, hand: [27.5, 18.25, 9.75, 4.5], total: 240.5, samples: 12 },
    ])),
    revealedHands: Array.from({ length: 6 }, (_, index) => ({
      handNo: index + 1, reachedShowdown: true, pot: 4800, board: ["A♠", "K♦", "10♥", "7♣", "9♦"],
      reveals: base.players.map((player) => ({
        id: player.id, name: player.name, hole: ["A♥", "Q♥"], label: "同花顺", won: player.id === "aria",
      })),
    })),
  };
  const actor = game.players.find((player) => player.id === "aria");
  assert.ok(JSON.stringify(buildModelContext(game, actor, 120, "aria")).length < 18_000);
});
