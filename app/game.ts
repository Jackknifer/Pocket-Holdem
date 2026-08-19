export type Suit = "s" | "h" | "d" | "c";
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export type Phase = "preflop" | "flop" | "turn" | "river" | "showdown";
export type GameStatus = "playing" | "handOver" | "gameOver";

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
  lastAction: string;
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
  tableMode?: "local" | "online";
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
  actedAt: Record<string, number>;
  handNo: number;
  smallBlind: number;
  bigBlind: number;
  blindLevel: number;
  winners: Winner[];
  message: string;
  log: LogEntry[];
  lastPot: number;
}

export type GameAction =
  | { type: "fold" }
  | { type: "checkCall" }
  | { type: "raise"; amount: number }
  | { type: "allIn" };

const SUITS: Suit[] = ["s", "h", "d", "c"];
const RANKS: Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const BLIND_LEVELS: Array<[number, number]> = [[10, 20], [15, 30], [25, 50], [40, 80], [60, 120], [100, 200], [150, 300], [250, 500]];

export const suitSymbol: Record<Suit, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
export const rankLabel: Record<Rank, string> = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A",
};

export type LocalAiProfile = {
  simulations: number;
  equityWeight: number;
  noiseScale: number;
  bluffFrequency: number;
  rangeInference: number;
  continueThresholdBias: number;
  raiseThresholdBias: number;
  callThresholdBias: number;
};

/** The built-in opponent has one deliberately strong competitive profile. */
export const LOCAL_AI_PROFILE: LocalAiProfile = {
  simulations: 420,
  equityWeight: 0.9,
  noiseScale: 0.018,
  bluffFrequency: 0.11,
  rangeInference: 1,
  continueThresholdBias: 0.018,
  raiseThresholdBias: -0.025,
  callThresholdBias: 0.012,
};

function makeDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank, id: `${rank}${suit}` })));
}

function secureRandomIndex(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const range = 0x1_0000_0000;
    const limit = range - (range % maxExclusive);
    const value = new Uint32Array(1);
    do crypto.getRandomValues(value); while (value[0] >= limit);
    return value[0] % maxExclusive;
  }
  return Math.floor(Math.random() * maxExclusive);
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = secureRandomIndex(i + 1);
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

function basePlayers(playerCount = 4): Player[] {
  const players: Player[] = [
    { id: "you", name: "你", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: true, avatar: "你", note: "你的座位", aggression: 0.5, lastAction: "" },
    { id: "mira", name: "Mira", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "M", note: "沉稳 · 紧手", aggression: 0.35, lastAction: "" },
    { id: "knox", name: "Knox", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "K", note: "敏锐 · 均衡", aggression: 0.58, lastAction: "" },
    { id: "aria", name: "Aria", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "A", note: "大胆 · 激进", aggression: 0.78, lastAction: "" },
    { id: "theo", name: "Theo", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "T", note: "理性 · 观察", aggression: 0.48, lastAction: "" },
    { id: "nova", name: "Nova", chips: 2000, hole: [], bet: 0, totalBet: 0, folded: false, allIn: false, isHuman: false, avatar: "N", note: "灵活 · 难测", aggression: 0.67, lastAction: "" },
  ];
  return players.slice(0, Math.max(2, Math.min(6, Math.round(playerCount))));
}

export function newSession(playerCount = 4): GameState {
  const players = basePlayers(playerCount);
  const initial: GameState = {
    tableMode: "local", players, deck: [], community: [], phase: "preflop", status: "handOver",
    dealer: secureRandomIndex(players.length), currentPlayer: -1, currentBet: 0, minRaise: 20,
    acted: [], actedAt: {}, handNo: 0, smallBlind: 10, bigBlind: 20, blindLevel: 1, winners: [], message: "",
    log: [], lastPot: 0,
  };
  return startNextHand(initial, true);
}

export type OnlinePlayerSeed = { id: string; name: string; avatar: string };

export function newOnlineSession(seats: OnlinePlayerSeed[]): GameState {
  const players = seats.slice(0, 6).map((seat) => ({
    id: seat.id,
    name: seat.name,
    chips: 2000,
    hole: [] as Card[],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isHuman: false,
    avatar: seat.avatar,
    note: "在线玩家",
    aggression: 0.5,
    lastAction: "",
  }));
  if (players.length < 2) throw new Error("联机牌局至少需要两位玩家");
  return startNextHand({
    tableMode: "online", players, deck: [], community: [], phase: "preflop", status: "handOver",
    dealer: secureRandomIndex(players.length), currentPlayer: -1, currentBet: 0, minRaise: 20,
    acted: [], actedAt: {}, handNo: 0, smallBlind: 10, bigBlind: 20, blindLevel: 1,
    winners: [], message: "", log: [], lastPot: 0,
  }, true);
}

function postBlind(players: Player[], index: number, amount: number, label: string): Player[] {
  return players.map((player, i) => {
    if (i !== index) return player;
    const paid = Math.min(player.chips, amount);
    return { ...player, chips: player.chips - paid, bet: paid, totalBet: paid, allIn: player.chips === paid, lastAction: `${label} ${paid}` };
  });
}

export function startNextHand(previous: GameState, first = false): GameState {
  const funded = previous.players.filter((player) => player.chips > 0);
  const human = previous.players.find((player) => player.isHuman);
  const onlineFinished = previous.tableMode === "online" && funded.length < 2;
  const localFinished = previous.tableMode !== "online" && (!human || human.chips <= 0 || funded.length < 2);
  if (onlineFinished || localFinished) {
    const champion = funded[0];
    return { ...previous, status: "gameOver", currentPlayer: -1, message: previous.tableMode === "online" && champion ? `${champion.name} 赢下了整场对局` : human?.chips ? "你赢下了整场对局" : "本场对局结束" };
  }

  const deck = shuffle(makeDeck());
  const handNo = previous.handNo + 1;
  const blindLevel = Math.min(BLIND_LEVELS.length, Math.floor((handNo - 1) / 5) + 1);
  const [smallBlind, bigBlind] = BLIND_LEVELS[blindLevel - 1];
  let players = previous.players.map((player) => ({
    ...player, hole: [] as Card[], bet: 0, totalBet: 0, folded: player.chips <= 0, allIn: false, lastAction: player.chips <= 0 ? "已出局" : "等待行动",
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

  players = postBlind(players, smallIndex, smallBlind, "小盲");
  players = postBlind(players, bigIndex, bigBlind, "大盲");
  const currentPlayer = nextSeat(players, bigIndex, (player) => !player.folded && !player.allIn && player.chips > 0);
  const state: GameState = {
    ...previous, players, deck, community: [], phase: "preflop", status: "playing", dealer,
    currentPlayer, currentBet: bigBlind, minRaise: bigBlind,
    smallBlind, bigBlind, blindLevel,
    acted: [], actedAt: {}, handNo, winners: [], message: "新一手牌", lastPot: 0,
    log: [{ id: Date.now(), text: `第 ${handNo} 手牌 · 盲注 ${smallBlind} / ${bigBlind}`, tone: "strong" }],
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
  const committed = getPot(state);
  const matchedByOpponent = Math.max(0, ...state.players.filter((player) => player.id !== winner.id).map((player) => player.totalBet));
  const uncalled = Math.max(0, winner.totalBet - matchedByOpponent);
  const pot = committed - uncalled;
  const players = state.players.map((player) => player.id === winner.id ? { ...player, chips: player.chips + committed, lastAction: `赢得 ${pot}` } : player);
  return addLog({
    ...state, players, status: "handOver", currentPlayer: -1, winners: [{ ids: [winner.id], amount: pot, label: "其余玩家弃牌" }],
    message: `${winner.name} 收下 ${pot}`, lastPot: pot,
  }, `${winner.name} 收下底池 ${pot}${uncalled ? `，退回未被跟注 ${uncalled}` : ""}`, "strong");
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
  deck.pop(); // 正式牌局每条公共牌街先烧一张牌。
  for (let i = 0; i < count; i += 1) {
    const card = deck.pop();
    if (card) community.push(card);
  }
  const players = state.players.map((player) => ({ ...player, bet: 0 }));
  const nextState: GameState = {
    ...state, players, deck, community, phase, currentBet: 0, minRaise: state.bigBlind, acted: [], actedAt: {},
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
    next.deck.pop();
    const count = next.community.length === 0 ? 3 : 1;
    for (let i = 0; i < count; i += 1) {
      const card = next.deck.pop();
      if (card) next.community.push(card);
    }
  }
  return showdown({ ...next, phase: "river" });
}

export function canPlayerRaise(state: GameState, player: Player): boolean {
  const maxTarget = player.bet + player.chips;
  if (player.folded || player.allIn || maxTarget <= state.currentBet) return false;
  const lastActedAt = state.actedAt?.[player.id];
  return lastActedAt === undefined || state.currentBet - lastActedAt >= state.minRaise;
}

export function applyAction(state: GameState, playerId: string, action: GameAction): GameState {
  if (state.status !== "playing") return state;
  const actorIndex = state.players.findIndex((player) => player.id === playerId);
  if (actorIndex !== state.currentPlayer || actorIndex < 0) return state;
  const actor = state.players[actorIndex];
  const players = [...state.players];
  let acted = [...state.acted];
  const actedAt = { ...(state.actedAt || {}) };
  let currentBet = state.currentBet;
  let minRaise = state.minRaise;
  let text = "";

  if (action.type === "fold") {
    players[actorIndex] = { ...actor, folded: true, lastAction: "弃牌" };
    acted = [...new Set([...acted, actor.id])];
    actedAt[actor.id] = currentBet;
    text = `${actor.name} 弃牌`;
  } else if (action.type === "checkCall") {
    const due = Math.max(0, currentBet - actor.bet);
    const paid = Math.min(due, actor.chips);
    players[actorIndex] = {
      ...actor, chips: actor.chips - paid, bet: actor.bet + paid, totalBet: actor.totalBet + paid,
      allIn: actor.chips === paid && paid > 0,
      lastAction: due === 0 ? "过牌" : paid < due ? `全下 ${paid}` : `跟注 ${paid}`,
    };
    acted = [...new Set([...acted, actor.id])];
    actedAt[actor.id] = currentBet;
    text = due === 0 ? `${actor.name} 过牌` : paid < due ? `${actor.name} 全下 ${paid}` : `${actor.name} 跟注 ${paid}`;
  } else {
    const maxTarget = actor.bet + actor.chips;
    const raiseOpen = canPlayerRaise(state, actor);
    const callTarget = Math.min(maxTarget, currentBet);
    const minimumTarget = currentBet + minRaise;
    let target = callTarget;
    if (raiseOpen && maxTarget > currentBet) {
      if (action.type === "allIn") target = maxTarget;
      else if (maxTarget < minimumTarget) target = maxTarget;
      else target = Math.max(minimumTarget, Math.min(maxTarget, action.amount));
    }
    const paid = target - actor.bet;
    const previousBet = currentBet;
    const isAllIn = paid > 0 && actor.chips === paid;
    const isRaise = target > previousBet;
    players[actorIndex] = {
      ...actor, chips: actor.chips - paid, bet: target, totalBet: actor.totalBet + paid, allIn: isAllIn,
      lastAction: isAllIn ? `全下 ${target}` : isRaise ? previousBet === 0 ? `下注 ${target}` : `加注至 ${target}` : previousBet > actor.bet ? `跟注 ${paid}` : "过牌",
    };
    if (isRaise) {
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
    actedAt[actor.id] = currentBet;
    text = isAllIn
      ? `${actor.name} 全下 ${paid}`
      : isRaise ? previousBet === 0 ? `${actor.name} 下注到 ${target}` : `${actor.name} 加注到 ${target}`
        : previousBet > actor.bet ? `${actor.name} 跟注 ${paid}` : `${actor.name} 过牌`;
  }

  const next = addLog({ ...state, players, acted, actedAt, currentBet, minRaise, message: text }, text);
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
  if (groups[0][1] === 3 && groups[1][1] >= 2) return { score: [6, groups[0][0], groups[1][0]], label: "葫芦" };
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
  const committed = getPot(state);
  const levels = [...new Set(state.players.map((player) => player.totalBet).filter(Boolean))].sort((a, b) => a - b);
  const awards = new Map<string, number>();
  const winnerGroups: Winner[] = [];
  let previous = 0;
  let uncalled = 0;

  const oddChipDistance = (player: Player): number => {
    const index = state.players.findIndex((candidate) => candidate.id === player.id);
    const distance = (index - state.dealer + state.players.length) % state.players.length;
    return distance === 0 ? state.players.length : distance;
  };

  for (const level of levels) {
    const contributors = state.players.filter((player) => player.totalBet >= level);
    const amount = (level - previous) * contributors.length;
    previous = level;
    if (contributors.length === 1) {
      const player = contributors[0];
      awards.set(player.id, (awards.get(player.id) || 0) + amount);
      uncalled += amount;
      continue;
    }
    const eligible = contributors.filter((player) => !player.folded);
    if (!eligible.length || !amount) continue;
    const evaluated = eligible.map((player) => ({ player, hand: evaluateBest([...player.hole, ...state.community]) }));
    const best = evaluated.reduce((top, item) => compareScore(item.hand.score, top.hand.score) > 0 ? item : top);
    const winners = evaluated
      .filter((item) => compareScore(item.hand.score, best.hand.score) === 0)
      .sort((a, b) => oddChipDistance(a.player) - oddChipDistance(b.player));
    const share = Math.floor(amount / winners.length);
    let remainder = amount - share * winners.length;
    winners.forEach(({ player }) => {
      const award = share + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      awards.set(player.id, (awards.get(player.id) || 0) + award);
    });
    winnerGroups.push({ ids: winners.map((item) => item.player.id), amount, label: best.hand.label });
  }

  const players = state.players.map((player) => {
    const award = awards.get(player.id) || 0;
    return { ...player, chips: player.chips + award, lastAction: award ? `赢得 ${award}` : player.lastAction };
  });
  const main = winnerGroups[0];
  const names = main?.ids.map((id) => players.find((player) => player.id === id)?.name).join("、") || "";
  const message = `${names} · ${main?.label || "胜出"}`;
  const pot = committed - uncalled;
  return addLog({
    ...state, players, phase: "showdown", status: "handOver", currentPlayer: -1,
    winners: winnerGroups, message, lastPot: pot,
  }, `${message}，底池 ${pot}${uncalled ? `，退回未被跟注 ${uncalled}` : ""}`, "strong");
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

function inferredRangeFloor(player: Player): number {
  const action = player.lastAction || "";
  const floor = action.includes("全下") ? 0.52
    : action.includes("加注") ? 0.43
      : action.includes("下注") ? 0.34
        : action.includes("跟注") ? 0.2 : 0;
  return floor * LOCAL_AI_PROFILE.rangeInference;
}

function drawRangedHole(pool: Card[], floor: number): { hole: Card[]; remaining: Card[] } {
  let selected: [number, number] = [0, 1];
  let bestStrength = -1;
  const attempts = floor > 0 ? 7 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const first = Math.floor(Math.random() * pool.length);
    let second = Math.floor(Math.random() * (pool.length - 1));
    if (second >= first) second += 1;
    const strength = preflopStrength([pool[first], pool[second]]);
    if (strength > bestStrength) { bestStrength = strength; selected = [first, second]; }
    if (strength >= floor) break;
  }
  const hole = [pool[selected[0]], pool[selected[1]]];
  const removed = new Set(selected);
  return { hole, remaining: pool.filter((_, index) => !removed.has(index)) };
}

export function estimateEquity(state: GameState, player: Player, simulations = 120): number {
  const opponents = state.players.filter((candidate) => candidate.id !== player.id && !candidate.folded && candidate.hole.length > 0);
  if (!opponents.length) return 1;
  const knownIds = new Set([...player.hole, ...state.community].map((card) => card.id));
  const unknownDeck = makeDeck().filter((card) => !knownIds.has(card.id));
  const futureBoardCount = 5 - state.community.length;
  let points = 0;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    let pool = shuffle(unknownDeck);
    const opponentHands: Card[][] = [];
    for (const opponent of opponents) {
      const draw = drawRangedHole(pool, inferredRangeFloor(opponent));
      opponentHands.push(draw.hole);
      pool = draw.remaining;
    }
    const board = [...state.community, ...pool.slice(0, futureBoardCount)];
    const hero = evaluateBest([...player.hole, ...board]);
    const rivals = opponentHands.map((hole) => evaluateBest([...hole, ...board]));
    const losses = rivals.filter((hand) => compareScore(hand.score, hero.score) > 0).length;
    if (losses) continue;
    const ties = rivals.filter((hand) => compareScore(hand.score, hero.score) === 0).length;
    points += 1 / (ties + 1);
  }
  return points / simulations;
}

function positionAdjustment(state: GameState, player: Player): number {
  const index = state.players.findIndex((candidate) => candidate.id === player.id);
  if (index === state.dealer) return 0.045;
  const firstToAct = nextSeat(state.players, state.dealer, (candidate) => !candidate.folded && !candidate.allIn);
  return index === firstToAct ? -0.025 : 0;
}

export function chooseAiAction(state: GameState, player: Player): GameAction {
  const due = Math.max(0, state.currentBet - player.bet);
  const pot = Math.max(state.bigBlind, getPot(state));
  const profile = LOCAL_AI_PROFILE;
  const equity = estimateEquity(state, player, profile.simulations);
  const made = handStrength(player, state.community);
  const noise = (Math.random() - 0.5) * profile.noiseScale;
  const strength = Math.max(0, Math.min(1, equity * profile.equityWeight + made * (1 - profile.equityWeight) + positionAdjustment(state, player) + noise));
  const potOdds = due / (pot + due);
  const stackToPot = player.chips / Math.max(pot, state.bigBlind);
  const personality = player.aggression;
  const bounds = legalRaiseBounds(state, player);
  const canRaise = bounds.max > state.currentBet;
  const bluffHasEquity = equity >= 0.24 && equity <= 0.64;
  const bluff = Math.random() < personality * profile.bluffFrequency && bluffHasEquity;

  if (state.phase === "preflop") {
    const activeCount = state.players.filter((candidate) => !candidate.folded && candidate.hole.length > 0).length;
    const opened = state.currentBet > state.bigBlind;
    const tableAllowance = Math.min(0.055, Math.max(0, activeCount - 2) * 0.014);
    const preflopScore = Math.max(0, Math.min(1, made + positionAdjustment(state, player) + personality * 0.04 + noise));
    const raisePressure = Math.max(0, state.currentBet / state.bigBlind - 1);
    const continueThreshold = opened
      ? 0.5 + Math.min(0.15, raisePressure * 0.022) - personality * 0.05 + profile.continueThresholdBias
      : 0.5 - tableAllowance - personality * 0.055 + profile.continueThresholdBias;
    const raiseThreshold = opened
      ? 0.94 - personality * 0.06 + profile.raiseThresholdBias
      : 0.84 - personality * 0.08 + profile.raiseThresholdBias;
    const mayRaise = !opened || (state.currentBet <= state.bigBlind * 3 && !player.lastAction.includes("加注"));

    if (due > 0) {
      if (due >= player.chips) return equity > Math.max(0.34, potOdds + 0.06 - personality * 0.05) ? { type: "allIn" } : { type: "fold" };
      if (!bluff && preflopScore < continueThreshold) return { type: "fold" };
      if (canRaise && mayRaise && (preflopScore > raiseThreshold || bluff)) {
        const baseSize = opened
          ? state.currentBet + Math.max(state.minRaise, Math.round(pot * (0.48 + personality * 0.18) / 10) * 10)
          : Math.max(state.currentBet + state.minRaise, state.bigBlind * 3);
        return { type: "raise", amount: Math.min(player.bet + player.chips, baseSize) };
      }
      return { type: "checkCall" };
    }

    if (canRaise && mayRaise && (preflopScore > raiseThreshold - 0.035 || bluff)) {
      const size = Math.max(state.currentBet + state.minRaise, state.bigBlind * 3);
      return { type: "raise", amount: Math.min(player.bet + player.chips, size) };
    }
    return { type: "checkCall" };
  }

  if (due > 0) {
    if (due >= player.chips) {
      return equity > Math.max(0.36, potOdds + 0.08 - personality * 0.05) ? { type: "allIn" } : { type: "fold" };
    }
    const requiredEquity = potOdds + 0.055 - personality * 0.035 + profile.callThresholdBias;
    if (!bluff && strength < requiredEquity) return { type: "fold" };
    if (stackToPot < 1.15 && equity > 0.59 - personality * 0.05) return { type: "allIn" };
    if (canRaise && (strength > 0.67 - personality * 0.11 + profile.raiseThresholdBias || bluff)) {
      const multiplier = 0.42 + personality * 0.34 + Math.max(0, equity - 0.6) * 0.7;
      const size = state.currentBet + Math.max(state.minRaise, Math.round(pot * multiplier / 10) * 10);
      return { type: "raise", amount: Math.min(player.bet + player.chips, size) };
    }
    return { type: "checkCall" };
  }

  if (stackToPot < 1 && equity > 0.66) return { type: "allIn" };
  if (canRaise && (strength > 0.53 - personality * 0.12 + profile.raiseThresholdBias || bluff)) {
    const size = Math.max(state.bigBlind, Math.round(pot * (0.34 + personality * 0.42) / 10) * 10);
    return { type: "raise", amount: Math.min(player.bet + player.chips, size) };
  }
  return { type: "checkCall" };
}

export function getBlindProgress(state: GameState): { handsRemaining: number | null; nextSmallBlind: number; nextBigBlind: number } {
  if (state.blindLevel >= BLIND_LEVELS.length) return { handsRemaining: null, nextSmallBlind: state.smallBlind, nextBigBlind: state.bigBlind };
  const handsRemaining = state.blindLevel * 5 - state.handNo;
  const [nextSmallBlind, nextBigBlind] = BLIND_LEVELS[state.blindLevel];
  return { handsRemaining, nextSmallBlind, nextBigBlind };
}

export function legalRaiseBounds(state: GameState, player: Player): { min: number; max: number } {
  const stackTarget = player.bet + player.chips;
  const max = canPlayerRaise(state, player) ? stackTarget : Math.min(stackTarget, state.currentBet);
  const min = Math.min(max, state.currentBet + state.minRaise);
  return { min, max };
}

export function phaseLabel(phase: Phase): string {
  return { preflop: "翻牌前", flop: "翻牌圈", turn: "转牌圈", river: "河牌圈", showdown: "摊牌" }[phase];
}

export function formatChips(amount: number): string {
  return new Intl.NumberFormat("zh-CN").format(amount);
}
