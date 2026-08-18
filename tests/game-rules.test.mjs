import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAction,
  canPlayerRaise,
  evaluateBest,
  legalRaiseBounds,
  LOCAL_AI_PROFILE,
  newSession,
} from "../app/game.ts";

const card = (rank, suit) => ({ rank, suit, id: `${rank}${suit}` });

test("the built-in opponent exposes one fixed maximum-strength profile", () => {
  assert.equal(LOCAL_AI_PROFILE.simulations, 420);
  assert.equal(LOCAL_AI_PROFILE.rangeInference, 1);
  assert.ok(LOCAL_AI_PROFILE.equityWeight >= 0.9);
  assert.ok(LOCAL_AI_PROFILE.noiseScale <= 0.02);
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
});
