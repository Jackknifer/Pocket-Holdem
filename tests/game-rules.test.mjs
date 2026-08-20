import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAction,
  canPlayerRaise,
  estimateEquity,
  evaluateBest,
  legalRaiseBounds,
  LOCAL_AI_PROFILE,
  newOnlineSession,
  newSession,
  newSpectatorSession,
  simulationBudget,
  spectatorSeatProfiles,
  startNextHand,
} from "../app/game.ts";
import { OPPONENT_SKILLS } from "../app/ai-skills.ts";

const card = (rank, suit) => ({ rank, suit, id: `${rank}${suit}` });

test("the built-in opponent exposes one fixed maximum-strength profile", () => {
  assert.equal(LOCAL_AI_PROFILE.simulations, 420);
  assert.equal(LOCAL_AI_PROFILE.rangeInference, 1);
  assert.ok(LOCAL_AI_PROFILE.equityWeight >= 0.9);
  assert.ok(LOCAL_AI_PROFILE.noiseScale <= 0.02);
});

test("an online session deals unique private cards and ends only when one stack remains", () => {
  const game = newOnlineSession([
    { id: "one", name: "ONE", avatar: "O" },
    { id: "two", name: "TWO", avatar: "T" },
    { id: "three", name: "THREE", avatar: "H" },
  ]);
  assert.equal(game.tableMode, "online");
  assert.equal(game.players.length, 3);
  assert.ok(game.players.every((candidate) => candidate.hole.length === 2));
  assert.equal(new Set(game.players.flatMap((candidate) => candidate.hole.map((item) => item.id))).size, 6);
  assert.equal(game.deck.length, 46);

  const finished = startNextHand({
    ...game,
    status: "handOver",
    players: game.players.map((candidate, index) => ({ ...candidate, chips: index === 1 ? 6000 : 0 })),
  });
  assert.equal(finished.status, "gameOver");
  assert.match(finished.message, /TWO 赢下了整场对局/);
});

function player(id, chips, hole, extra = {}) {
  return {
    id, name: id.toUpperCase(), chips, hole, bet: 0, totalBet: 0, folded: false, allIn: false,
    isHuman: id === "a", avatar: id.toUpperCase(), note: "", aggression: 0.5, lastAction: "",
    ...extra,
  };
}

function state(players, extra = {}) {
  return {
    players, deck: [], community: [], phase: "preflop", status: "playing", dealer: 0,
    currentPlayer: 0, currentBet: 0, minRaise: 20, acted: [], actedAt: {}, handNo: 1,
    smallBlind: 10, bigBlind: 20, blindLevel: 1, winners: [], message: "", log: [],
    lastPot: 0, ...extra,
  };
}

test("heads-up button posts the small blind, acts first preflop, and a burn card precedes the flop", () => {
  let game = newSession(2);
  const button = game.players[game.dealer];
  const bigBlind = game.players[(game.dealer + 1) % 2];
  assert.equal(button.bet, game.smallBlind);
  assert.equal(bigBlind.bet, game.bigBlind);
  assert.equal(game.currentPlayer, game.dealer);
  assert.equal(game.deck.length, 48);

  game = applyAction(game, button.id, { type: "checkCall" });
  game = applyAction(game, bigBlind.id, { type: "checkCall" });
  assert.equal(game.phase, "flop");
  assert.equal(game.community.length, 3);
  assert.equal(game.deck.length, 44);
  assert.equal(game.currentPlayer, (game.dealer + 1) % 2);
});

test("a single short all-in does not reopen a raise", () => {
  const a = player("a", 900, [card(14, "s"), card(13, "s")], { bet: 100, totalBet: 100 });
  const b = player("b", 50, [card(2, "s"), card(2, "h")], { bet: 100, totalBet: 100 });
  let game = state([a, b], { currentPlayer: 1, currentBet: 100, minRaise: 100, acted: ["a"], actedAt: { a: 100 } });
  game = applyAction(game, "b", { type: "allIn" });
  assert.equal(game.currentBet, 150);
  assert.equal(game.currentPlayer, 0);
  assert.equal(canPlayerRaise(game, game.players[0]), false);
  assert.equal(legalRaiseBounds(game, game.players[0]).max, 150);
});

test("cumulative short all-ins reopen action once they total a full raise", () => {
  const a = player("a", 900, [card(14, "s"), card(13, "s")], { bet: 100, totalBet: 100 });
  const b = player("b", 50, [card(2, "s"), card(2, "h")], { bet: 100, totalBet: 100 });
  const c = player("c", 100, [card(3, "s"), card(3, "h")], { bet: 100, totalBet: 100 });
  let game = state([a, b, c], { currentPlayer: 1, currentBet: 100, minRaise: 100, acted: ["a"], actedAt: { a: 100 } });
  game = applyAction(game, "b", { type: "allIn" });
  game = applyAction(game, "c", { type: "allIn" });
  assert.equal(game.currentBet, 200);
  assert.equal(game.currentPlayer, 0);
  assert.equal(canPlayerRaise(game, game.players[0]), true);
  assert.deepEqual(legalRaiseBounds(game, game.players[0]), { min: 300, max: 1000 });
});

test("an unmatched all-in excess is returned instead of counted in the pot", () => {
  const a = player("a", 500, [card(2, "s"), card(3, "s")]);
  const b = player("b", 300, [card(14, "s"), card(14, "h")]);
  let game = state([a, b], {
    phase: "river",
    community: [card(4, "c"), card(7, "d"), card(9, "h"), card(11, "c"), card(12, "d")],
  });
  game = applyAction(game, "a", { type: "allIn" });
  game = applyAction(game, "b", { type: "checkCall" });
  assert.equal(game.status, "handOver");
  assert.equal(game.lastPot, 600);
  assert.equal(game.players[0].chips, 200);
  assert.equal(game.players[1].chips, 600);
  assert.match(game.log[0].text, /退回未被跟注 200/);
});

test("an odd split-pot chip goes to the first winning seat left of the button", () => {
  const a = player("a", 5, [card(14, "s"), card(13, "s")]);
  const b = player("b", 5, [card(14, "h"), card(13, "h")]);
  const c = player("c", 5, [card(12, "s"), card(11, "s")]);
  let game = state([a, b, c], {
    phase: "river", dealer: 0,
    community: [card(2, "s"), card(3, "h"), card(4, "d"), card(9, "c"), card(9, "d")],
  });
  game = applyAction(game, "a", { type: "allIn" });
  game = applyAction(game, "b", { type: "allIn" });
  game = applyAction(game, "c", { type: "allIn" });
  assert.equal(game.players[1].chips, 8);
  assert.equal(game.players[0].chips, 7);
  assert.equal(game.players[2].chips, 0);
});

test("two triplets correctly form a full house", () => {
  const result = evaluateBest([
    card(14, "s"), card(14, "h"), card(14, "d"),
    card(13, "s"), card(13, "h"), card(13, "d"), card(2, "c"),
  ]);
  assert.equal(result.label, "葫芦");
  assert.deepEqual(result.score, [6, 14, 13]);
  assert.equal(result.cards.length, 5);
  assert.deepEqual(result.cards.map((item) => item.rank), [14, 14, 14, 13, 13]);
});

test("the simulation budget keeps one decision in a similar time slice at every table size", () => {
  // Cost per decision is roughly simulations × (rivals + 1), so heads-up and three-handed
  // tables keep the full budget and bigger tables trade samples for a steady frame time.
  assert.equal(simulationBudget(960, 1), 960);
  assert.equal(simulationBudget(960, 2), 960);
  assert.equal(simulationBudget(960, 3), 640);
  assert.equal(simulationBudget(960, 4), 480);
  assert.equal(simulationBudget(960, 5), 384);
  assert.ok(simulationBudget(960, 5) * 6 < simulationBudget(960, 1) * 2 * 1.35);
  // A quality floor still applies, and a base below that floor is never scaled down.
  assert.equal(simulationBudget(260, 5), 160);
  assert.equal(simulationBudget(120, 5), 120);
});

test("the equity sampler still separates a monster from a dry hand", () => {
  const community = [card(4, "c"), card(7, "d"), card(9, "h")];
  const table = state(
    [player("a", 500, [card(14, "s"), card(14, "h")]), player("b", 500, [card(2, "d"), card(3, "c")])],
    { phase: "flop", community },
  );
  const aces = estimateEquity(table, table.players[0], 400);
  const airball = estimateEquity(table, table.players[1], 400);
  assert.ok(aces > 0.6, `aces on a dry flop should be a clear favourite, got ${aces}`);
  assert.ok(airball < 0.4, `three-high should be a clear underdog, got ${airball}`);
});

test("a spectator session seats only named skill opponents and honours per-seat AI choices", () => {
  const game = newSpectatorSession(4, { mira: "deepseek", knox: "glm" });
  assert.equal(game.tableMode, "spectator");
  assert.equal(game.players.length, 4);
  assert.ok(game.players.every((candidate) => !candidate.isHuman));
  assert.ok(game.players.every((candidate) => candidate.name !== "你" && candidate.avatar !== "你"));
  assert.deepEqual(game.players.map((candidate) => candidate.id), spectatorSeatProfiles(4).map((seat) => seat.id));
  assert.ok(game.players.every((candidate) => OPPONENT_SKILLS[candidate.id]));
  assert.equal(game.players.find((candidate) => candidate.id === "mira").aiProvider, "deepseek");
  assert.equal(game.players.find((candidate) => candidate.id === "knox").aiProvider, "glm");
  assert.equal(game.players.find((candidate) => candidate.id === "iris").aiProvider, "local");
  assert.deepEqual(game.revealedHands, []);
  assert.deepEqual(game.decisionTiming, {});
});

test("decision time is logged, accumulated per player, and cleared for each new hand", () => {
  const a = player("a", 500, [card(14, "s"), card(13, "s")]);
  const b = player("b", 500, [card(2, "s"), card(3, "h")]);
  let game = state([a, b], { phase: "flop", community: [card(4, "c"), card(7, "d"), card(9, "h")] });

  game = applyAction(game, "a", { type: "raise", amount: 40 }, 12.34);
  assert.deepEqual(game.decisionTiming.a, { last: 12.3, hand: [12.3], total: 12.3, samples: 1 });
  assert.match(game.log[0].text, /用时 12\.3 秒/);

  game = applyAction(game, "b", { type: "checkCall" });
  assert.equal(game.decisionTiming.b, undefined);
  assert.doesNotMatch(game.log[0].text, /用时/);

  game = applyAction(game, "b", { type: "checkCall" }, 5);
  game = applyAction(game, "a", { type: "checkCall" }, 3.05);
  assert.deepEqual(game.decisionTiming.a, { last: 3.1, hand: [12.3, 3.1], total: 15.4, samples: 2 });
  assert.deepEqual(game.decisionTiming.b, { last: 5, hand: [5], total: 5, samples: 1 });

  const next = startNextHand({ ...game, status: "handOver" });
  assert.deepEqual(next.decisionTiming.a, { last: 3.1, hand: [], total: 15.4, samples: 2 });
  assert.deepEqual(next.decisionTiming.b, { last: 5, hand: [], total: 5, samples: 1 });
});

test("a contested hand publishes the board and every tabled hand", () => {
  const a = player("a", 500, [card(2, "s"), card(3, "s")]);
  const b = player("b", 300, [card(14, "s"), card(14, "h")]);
  let game = state([a, b], {
    phase: "river",
    community: [card(4, "c"), card(7, "d"), card(9, "h"), card(11, "c"), card(12, "d")],
  });
  game = applyAction(game, "a", { type: "allIn" });
  game = applyAction(game, "b", { type: "checkCall" });

  const shown = game.revealedHands[0];
  assert.equal(shown.handNo, 1);
  assert.equal(shown.reachedShowdown, true);
  assert.equal(shown.pot, 600);
  assert.deepEqual(shown.board, ["4♣", "7♦", "9♥", "J♣", "Q♦"]);
  assert.deepEqual(shown.reveals.map((reveal) => reveal.id), ["a", "b"]);
  assert.deepEqual(shown.reveals.map((reveal) => reveal.won), [false, true]);
  assert.deepEqual(shown.reveals[1].hole, ["A♠", "A♥"]);
  assert.equal(shown.reveals[1].label, "一对");
});

test("a pot won because everyone folded is taken without showing a hand", () => {
  const a = player("a", 480, [card(2, "s"), card(3, "s")], { bet: 20, totalBet: 20 });
  const b = player("b", 460, [card(14, "s"), card(14, "h")], { bet: 40, totalBet: 40 });
  let game = state([a, b], { currentPlayer: 0, currentBet: 40, minRaise: 20, acted: ["b"], actedAt: { b: 40 } });
  game = applyAction(game, "a", { type: "fold" });

  assert.equal(game.status, "handOver");
  const shown = game.revealedHands[0];
  assert.equal(shown.reachedShowdown, false);
  assert.equal(shown.pot, 40);
  assert.deepEqual(shown.board, []);
  assert.deepEqual(shown.reveals, []);
});
