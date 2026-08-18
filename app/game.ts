export type Suit = "s" | "h" | "d" | "c";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type Phase = "preflop" | "flop" | "turn" | "river" | "showdown";
export type GameStatus = "playing" | "handOver" | "gameOver";
export type Difficulty = "relaxed" | "standard" | "sharp";

export interface Card {
  suit: Suit;
  rank: Rank;
  id: string;
}

export interface Player {
  id: string;
  name: string;
  chips: number;
  hole: Card[];
  bet: number;
  totalBet: number;
  folded: boolean;
  allIn: boolean;
  isHuman: boolean;
  avatar: string;
  note: string;
  aggression: number;
}

export interface Winner {
  ids: string[];
  amount: number;
  label: string;
}

export interface LogEntry {
  id: number;
  text: string;
  tone?: "muted" | "strong";
}

export interface GameState {
  players: Player[];
  deck: Card[];
  community: Card[];
  phase: Phase;
  status: GameStatus;
  dealer: number;
  currentPlayer: number;
  currentBet: number;
  minRaise: number;
  acted: string[];
  handNo: number;
  smallBlind: number;
  bigBlind: number;
  winners: Winner[];
  message: string;
  log: LogEntry[];
  difficulty: Difficulty;
  lastPot: number;
}

export type GameAction =
  | { type: "fold" }
  | { type: "checkCall" }
  | { type: "raise"; amount: number }
  | { type: "allIn" };

const SUITS: Suit[] = ["s", "h", "d", "c"];
const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export const suitSymbol: Record<Suit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
export const rankLabel: Record<Rank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A",
};

function makeDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank, id: `${rank}${suit}` })));
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function nextSeat(players: Player[], from: number, predicate: (player: Player) => boolean): number {
  for (let offset = 1; offset <= players.length; offset += 1) {
    const index = (from + offset) % players.length;
    if (predicate(players[index])) return index;
  }
  return -1;
}

function addLog(state: GameState, text: string, tone: LogEntry["tone"] = "muted"): GameState {
  return {
    ...state,
    log: [{ id: Date.now() + Math.random(), text, tone }, ...state.log].slice(0, 18),
  };
}

function basePlayers(): Player[] {
  return [
    { id: "you", name: "你", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: true, avatar: "你", note: "你的座位", aggression: 0.5 },
    { id: "mira", name: "Mira", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "M", note: "沉稳 · 紧手", aggression: 0.35 },
    { id: "knox", name: "Knox", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "K", note: "敏锐 · 均衡", aggression: 0.58 },
    { id: "aria", name: "Aria", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "A", note: "大胆 · 激进", aggression: 0.78 },
  ];
}

export function newSession(difficulty: Difficulty = "standard"): GameState {
  const initial: GameState = {
    players: basePlayers(), deck: [], community: [], phase: "preflop", status: "handOver",
    dealer: Math.floor(Math.random() * 4), currentPlayer: -1, currentBet: 0, minRaise: 20,
    acted: [], handNo: 0, smallBlind: 10, bigBlind: 20, winners: [], message: "",
    log: [], difficulty, lastPot: 0,
  };
  return startNextHand(initial, true);
}

function postBlind(players: Player[], index: number, amount: number): Player[] {
  return players.map((player, i) => {
    if (i !== index) return player;
    const paid = Math.min(player.chips, amount);
    return { ...player, chips: player.chips - paid, bet: paid, totalBet: paid, allIn: player.chips === paid };
  });
}

export function startNextHand(previous: GameState, first = false): GameState {
  const funded = previous.players.filter((player) => player.chips > 0);
  const human = previous.players.find((player) => player.isHuman);
  if (!human || human.chips <= 0 || funded.length < 2) {
    return { ...previous, status: "gameOver", currentPlayer: -1, message: human?.chips ? "你赢下了整场对局" : "本场对局结束" };
  }

  const deck = shuffle(makeDeck());
  let players = previous.players.map((player) => ({
    ...player, hole: [] as Card[], bet: 0, totalBet: 0, folded: player.chips <= 0, allIn: false,
  }));
  const dealer = first ? previous.dealer : nextSeat(players, previous.dealer, (player) => player.chips > 0);
  const activeCount = players.filter((player) => player.chips > 0).length;
  const smallIndex = activeCount === 2 ? dealer : nextSeat(players, dealer, (player) => player.chips > 0);
  const bigIndex = nextSeat(players, smallIndex, (player) => player.chips > 0);

  for (let round = 0; round < 2; round += 1) {
    for (let offset = 1; offset <= players.length; offset += 1) {
      const index = (dealer + offset) % players.length;
      if (players[index].chips <= 0) continue;
      const card = deck.pop();
      if (card) players[index] = { ...players[index], hole: [...players[index].hole, card] };
    }
  }

  players = postBlind(players, smallIndex, previous.smallBlind);
  players = postBlind(players, bigIndex, previous.bigBlind);
  const currentPlayer = nextSeat(players, bigIndex, (player) => !player.folded && !player.allIn && player.chips > 0);
  const handNo = previous.handNo + 1;
  const state: GameState = {
    ...previous, players, deck, community: [], phase: "preflop", status: "playing", dealer,
    currentPlayer, currentBet: Math.max(...players.map((player) => player.bet)), minRaise: previous.bigBlind,
    acted: [], handNo, winners: [], message: "新一手牌", lastPot: 0,
    log: [{ id: Date.now(), text: `第 ${handNo} 手牌 · 盲注 ${previous.smallBlind} / ${previous.bigBlind}`, tone: "strong" }],
  };
  return currentPlayer === -1 ? runToShowdown(state) : state;
}

export function getPot(state: GameState): number {
  return state.players.reduce((sum, player) => sum + player.totalBet, 0);
}

function remainingPlayers(state: GameState): Player[] {
  return state.players.filter((player) => !player.folded && player.hole.length > 0);
}

function needsAction(state: GameState, player: Player): boolean {
  return !player.folded && !player.allIn && player.chips > 0 && (!state.acted.includes(player.id) || player.bet !== state.currentBet);
}

function roundIsComplete(state: GameState): boolean {
  return state.players.filter((player) => !player.folded && !player.allIn && player.chips > 0)
    .every((player) => state.acted.includes(player.id) && player.bet === state.currentBet);
}

function awardUncontested(state: GameState, winner: Player): GameState {
  const pot = getPot(state);
  const players = state.players.map((player) => player.id === winner.id ? { ...player, chips: player.chips + pot } : player);
  return addLog({
    ...state, players, status: "handOver", currentPlayer: -1, winners: [{ ids: [winner.id], amount: pot, label: "其余玩家弃牌" }],
    message: `${winner.name} 收下 ${pot}`, lastPot: pot,
  }, `${winner.name} 收下底池 ${pot}`, "strong");
}

function progressAfterAction(state: GameState, actorIndex: number): GameState {
  const remaining = remainingPlayers(state);
  if (remaining.length === 1) return awardUncontested(state, remaining[0]);
  if (roundIsComplete(state)) return advanceStreet(state);
  const next = nextSeat(state.players, actorIndex, (player) => needsAction(state, player));
  if (next === -1) return advanceStreet(state);
  return { ...state, currentPlayer: next };
}

function advanceStreet(state: GameState): GameState {
  if (state.phase === "river") return showdown(state);
  const deck = [...state.deck];
  const community = [...state.community];
  let phase: Phase = "flop";
  const count = state.phase === "preflop" ? 3 : 1;
  if (state.phase === "flop") phase = "turn";
  if (state.phase === "turn") phase = "river";
  for (let i = 0; i < count; i += 1) {
    const card = deck.pop();
    if (card) community.push(card);
  }
  const players = state.players.map((player) => ({ ...player, bet: 0 }));
  const nextState: GameState = {
    ...state, players, deck, community, phase, currentBet: 0, minRaise: state.bigBlind, acted: [],
    message: phase === "flop" ? "翻牌" : phase === "turn" ? "转牌" : "河牌",
  };
  const actionable = players.filter((player) => !player.folded && !player.allIn && player.chips > 0);
  if (actionable.length <= 1) return runToShowdown(nextState);
  const currentPlayer = nextSeat(players, state.dealer, (player) => !player.folded && !player.allIn && player.chips > 0);
  return addLog({ ...nextState, currentPlayer }, nextState.message);
}

function runToShowdown(state: GameState): GameState {
  const next = { ...state, deck: [...state.deck], community: [...state.community] };
  while (next.community.length < 5) {
    const card = next.deck.pop();
    if (card) next.community.push(card);
  }
  return showdown({ ...next, phase: "river" });
}

export function applyAction(state: GameState, playerId: string, action: GameAction): GameState {
  if (state.status !== "playing") return state;
  const actorIndex = state.players.findIndex((player) => player.id === playerId);
  if (actorIndex !== state.currentPlayer || actorIndex < 0) return state;
  const actor = state.players[actorIndex];
  const players = [...state.players];
  let acted = [...state.acted];
  let currentBet = state.currentBet;
  let minRaise = state.minRaise;
  let text = "";

  if (action.type === "fold") {
    players[actorIndex] = { ...actor, folded: true };
    acted = [...new Set([...acted, actor.id])];
    text = `${actor.name} 弃牌`;
  } else if (action.type === "checkCall") {
    const due = Math.max(0, currentBet - actor.bet);
    const paid = Math.min(due, actor.chips);
    players[actorIndex] = {
      ...actor, chips: actor.chips - paid, bet: actor.bet + paid, totalBet: actor.totalBet + paid,
      allIn: actor.chips === paid && paid > 0,
    };
    acted = [...new Set([...acted, actor.id])];
    text = due === 0 ? `${actor.name} 过牌` : paid < due ? `${actor.name} 全下 ${paid}` : `${actor.name} 跟注 ${paid}`;
  } else {
    const maxTarget = actor.bet + actor.chips;
    const requested = action.type === "allIn" ? maxTarget : action.amount;
    const target = Math.max(actor.bet, Math.min(maxTarget, requested));
    const paid = target - actor.bet;
    const previousBet = currentBet;
    players[actorIndex] = {
      ...actor, chips: actor.chips - paid, bet: target, totalBet: actor.totalBet + paid, allIn: actor.chips === paid,
    };
    if (target > currentBet) {
      const raiseSize = target - currentBet;
      currentBet = target;
      if (raiseSize >= minRaise) {
        minRaise = raiseSize;
        acted = [actor.id];
      } else {
        acted = [...new Set([...acted, actor.id])];
      }
    } else {
      acted = [...new Set([...acted, actor.id])];
    }
    text = action.type === "allIn" || actor.chips === paid
      ? `${actor.name} 全下 ${paid}`
      : previousBet === 0 ? `${actor.name} 下注到 ${target}` : `${actor.name} 加注到 ${target}`;
  }

  const next = addLog({ ...state, players, acted, currentBet, minRaise, message: text }, text);
  return progressAfterAction(next, actorIndex);
}

interface EvaluatedHand { score: number[]; label: string; }

function compareScore(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

function evaluateFive(cards: Card[]): EvaluatedHand {
  const ranks = cards.map((card) => card.rank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  ranks.forEach((rank) => counts.set(rank, (counts.get(rank) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique: number[] = [...new Set(ranks)];
  if (unique[0] === 14) unique.push(1);
  let straightHigh = 0;
  for (let i = 0; i <= unique.length - 5; i += 1) {
    if (unique[i] - unique[i + 4] === 4) { straightHigh = unique[i]; break; }
  }
  if (flush && straightHigh) return { score: [8, straightHigh], label: straightHigh === 14 ? "皇家同花顺" : "同花顺" };
  if (groups[0][1] === 4) return { score: [7, groups[0][0], groups[1][0]], label: "四条" };
  if (groups[0][1] === 3 && groups[1][1] === 2) return { score: [6, groups[0][0], groups[1][0]], label: "葫芦" };
  if (flush) return { score: [5, ...ranks], label: "同花" };
  if (straightHigh) return { score: [4, straightHigh], label: "顺子" };
  if (groups[0][1] === 3) return { score: [3, groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)], label: "三条" };
  const pairs = groups.filter((group) => group[1] === 2).sort((a, b) => b[0] - a[0]);
  if (pairs.length >= 2) {
    const kicker = groups.find((group) => group[1] === 1)?.[0] || 0;
    return { score: [2, pairs[0][0], pairs[1][0], kicker], label: "两对" };
  }
  if (pairs.length === 1) {
    const kickers = groups.filter((group) => group[1] === 1).map((group) => group[0]).sort((a, b) => b - a);
    return { score: [1, pairs[0][0], ...kickers], label: "一对" };
  }
  return { score: [0, ...ranks], label: "高牌" };
}

export function evaluateBest(cards: Card[]): EvaluatedHand {
  if (cards.length < 5) return { score: [-1], label: preflopLabel(cards) };
  let best: EvaluatedHand = { score: [-1], label: "" };
  for (let a = 0; a < cards.length - 4; a += 1)
    for (let b = a + 1; b < cards.length - 3; b += 1)
      for (let c = b + 1; c < cards.length - 2; c += 1)
        for (let d = c + 1; d < cards.length - 1; d += 1)
          for (let e = d + 1; e < cards.length; e += 1) {
            const hand = evaluateFive([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (compareScore(hand.score, best.score) > 0) best = hand;
          }
  return best;
}

export function preflopLabel(cards: Card[]): string {
  if (cards.length < 2) return "等待发牌";
  if (cards[0].rank === cards[1].rank) return `口袋 ${rankLabel[cards[0].rank]}`;
  const high = cards[0].rank > cards[1].rank ? cards[0] : cards[1];
  return `${rankLabel[high.rank]} 高牌${cards[0].suit === cards[1].suit ? " · 同花" : ""}`;
}

function showdown(state: GameState): GameState {
  const pot = getPot(state);
  const levels = [...new Set(state.players.map((player) => player.totalBet).filter(Boolean))].sort((a, b) => a - b);
  const awards = new Map<string, number>();
  const winnerGroups: Winner[] = [];
  let previous = 0;

  for (const level of levels) {
    const contributors = state.players.filter((player) => player.totalBet >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    const eligible = contributors.filter((player) => !player.folded);
    if (!eligible.length || !amount) continue;
    const evaluated = eligible.map((player) => ({ player, hand: evaluateBest([...player.hole, ...state.community]) }));
    const best = evaluated.reduce((top, item) => compareScore(item.hand.score, top.hand.score) > 0 ? item : top);
    const winners = evaluated.filter((item) => compareScore(item.hand.score, best.hand.score) === 0);
    const share = Math.floor(amount / winners.length);
    let remainder = amount - share * winners.length;
    winners.forEach(({ player }) => {
      const award = share + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      awards.set(player.id, (awards.get(player.id) || 0) + award);
    });
    winnerGroups.push({ ids: winners.map((item) => item.player.id), amount, label: best.hand.label });
  }

  const players = state.players.map((player) => ({ ...player, chips: player.chips + (awards.get(player.id) || 0) }));
  const main = winnerGroups[0];
  const names = main?.ids.map((id) => players.find((player) => player.id === id)?.name).join("、") || "";
  const message = `${names} · ${main?.label || "胜出"}`;
  return addLog({
    ...state, players, phase: "showdown", status: "handOver", currentPlayer: -1,
    winners: winnerGroups, message, lastPot: pot,
  }, `${message}，赢得 ${pot}`, "strong");
}

function preflopStrength(cards: Card[]): number {
  if (cards.length < 2) return 0;
  const [a, b] = cards;
  const high = Math.max(a.rank, b.rank);
  const low = Math.min(a.rank, b.rank);
  let value = (high - 2) / 16 + (low - 2) / 32;
  if (a.rank === b.rank) value = 0.52 + (high - 2) / 24;
  if (a.suit === b.suit) value += 0.07;
  if (Math.abs(a.rank - b.rank) <= 2) value += 0.06;
  if (high === 14 && low >= 10) value += 0.12;
  return Math.min(1, value);
}

function handStrength(player: Player, community: Card[]): number {
  if (community.length < 3) return preflopStrength(player.hole);
  const result = evaluateBest([...player.hole, ...community]);
  const category = Math.max(0, result.score[0]);
  return Math.min(1, 0.12 + category * 0.115 + (result.score[1] || 0) / 100);
}

export function chooseAiAction(state: GameState, player: Player): GameAction {
  const due = Math.max(0, state.currentBet - player.bet);
  const pot = Math.max(state.bigBlind, getPot(state));
  const noiseScale = state.difficulty === "relaxed" ? 0.24 : state.difficulty === "sharp" ? 0.08 : 0.15;
  const noise = (Math.random() - 0.5) * noiseScale;
  const strength = Math.max(0, Math.min(1, handStrength(player, state.community) + noise));
  const pressure = due / (pot + due);
  const personality = player.aggression;
  const canRaise = player.chips > due + state.minRaise;
  const bluff = Math.random() < personality * (state.difficulty === "sharp" ? 0.09 : 0.045);

  if (due > 0) {
    if (due >= player.chips) {
      return strength > 0.68 - personality * 0.12 ? { type: "allIn" } : { type: "fold" };
    }
    if (!bluff && strength < 0.28 + pressure * 0.55 - personality * 0.08) return { type: "fold" };
    if (canRaise && (strength > 0.73 - personality * 0.14 || bluff)) {
      const size = state.currentBet + Math.max(state.minRaise, Math.round(pot * (0.35 + personality * 0.35) / 10) * 10);
      return { type: "raise", amount: Math.min(player.bet + player.chips, size) };
    }
    return { type: "checkCall" };
  }

  if (canRaise && (strength > 0.58 - personality * 0.16 || bluff)) {
    const size = Math.max(state.bigBlind, Math.round(pot * (0.3 + personality * 0.4) / 10) * 10);
    return { type: "raise", amount: Math.min(player.bet + player.chips, size) };
  }
  return { type: "checkCall" };
}

export function legalRaiseBounds(state: GameState, player: Player): { min: number; max: number } {
  const max = player.bet + player.chips;
  const min = Math.min(max, state.currentBet + state.minRaise);
  return { min, max };
}

export function phaseLabel(phase: Phase): string {
  return { preflop: "翻牌前", flop: "翻牌圈", turn: "转牌圈", river: "河牌圈", showdown: "摊牌" }[phase];
}

export function formatChips(amount: number): string {
  return new Intl.NumberFormat("zh-CN").format(amount);
}
