import {
  cardCode, estimateEquity, evaluateBest, getLocalAiProfile, getPot, legalRaiseBounds, phaseLabel, preflopLabel,
  type GameAction, type GameState, type Player,
} from "./game.ts";
import { OPPONENT_SKILLS } from "./ai-skills.ts";

export type ModelDecision = {
  action?: string;
  amount?: number | null;
  note?: string;
  provider?: string;
  model?: string;
  requestId?: string | null;
  latencyMs?: number;
  attempts?: number;
  recovered?: boolean;
  recovery?: "region" | "format" | null;
  region?: string | null;
  finishReason?: string | null;
  usage?: { input: number; output: number; total: number } | null;
  output?: string;
  assessment?: string;
  rangeAnalysis?: string;
  potAnalysis?: string;
  factors?: string[];
  alternatives?: Array<{ action: string; reason: string }>;
  skillApplication?: string;
  skillId?: string;
  skillRulesUsed?: string[];
  skillVerified?: boolean | null;
  strengthApplication?: string;
  risk?: string;
  confidence?: number | null;
  reasoningMode?: string;
  reasoningCharacters?: number | null;
};

function dealtSeats(game: GameState): Player[] {
  const seats = game.players.filter((candidate) => candidate.hole.length > 0);
  return seats.length ? seats : game.players.filter((candidate) => candidate.chips > 0);
}

function positionLabel(game: GameState, player: Player): string {
  const seats = dealtSeats(game);
  const playerSeat = seats.findIndex((candidate) => candidate.id === player.id);
  const buttonSeat = seats.findIndex((candidate) => candidate.id === game.players[game.dealer]?.id);
  if (playerSeat < 0 || buttonSeat < 0) return "未知位置";
  const offset = (playerSeat - buttonSeat + seats.length) % seats.length;
  if (seats.length === 2) return offset === 0 ? "BTN / SB" : "BB";
  const labels = ["BTN", "SB", "BB", "UTG", "HJ", "CO"];
  return labels[offset] || `位置 ${offset + 1}`;
}

function streetRules(game: GameState, skill: (typeof OPPONENT_SKILLS)[string]) {
  if (game.phase === "preflop") return skill.preflop;
  if (game.phase === "flop") return skill.postflop.flop;
  if (game.phase === "turn") return skill.postflop.turn;
  return skill.postflop.river;
}

/** Public decision-clock signal for one seat: how long it actually took to act. */
function decisionClock(game: GameState, id: string) {
  const timing = game.decisionTiming?.[id];
  if (!timing || !timing.samples) return null;
  return {
    lastSeconds: timing.last,
    thisHandSeconds: timing.hand,
    averageSeconds: Number((timing.total / timing.samples).toFixed(1)),
    decisions: timing.samples,
  };
}

/** Cards that became public at the end of recent hands, newest first. */
function revealedHistory(game: GameState) {
  return (game.revealedHands || []).slice(0, 4).map((entry) => ({
    handNo: entry.handNo,
    pot: entry.pot,
    board: entry.board,
    reachedShowdown: entry.reachedShowdown,
    shownHands: entry.reveals.map((reveal) => `${reveal.name}: ${reveal.hole.join(" ")} · ${reveal.label}${reveal.won ? " · 获胜" : ""}`),
  }));
}

export function buildModelContext(
  game: GameState,
  player: Player,
  actionTimeSeconds: 30 | 120 | 300,
  skillId = player.id,
  options: { maxReasoning?: boolean } = {},
) {
  const deepReasoning = options.maxReasoning !== false;
  const due = Math.max(0, game.currentBet - player.bet);
  const bounds = legalRaiseBounds(game, player);
  const pot = getPot(game);
  const hand = game.community.length >= 3 ? evaluateBest([...player.hole, ...game.community]).label : preflopLabel(player.hole);
  const skill = OPPONENT_SKILLS[skillId] || OPPONENT_SKILLS.knox;
  const seats = dealtSeats(game);
  const visiblePlayers = game.players.filter((candidate) => !candidate.folded && candidate.hole.length > 0).length;
  const effectiveStack = Math.min(
    ...game.players
      .filter((candidate) => !candidate.folded && candidate.hole.length > 0)
      .map((candidate) => candidate.chips),
    player.chips,
  );
  const potOddsPercent = due > 0 ? Math.round((due / Math.max(1, pot + due)) * 100) : 0;
  const spr = Number((effectiveStack / Math.max(1, pot)).toFixed(2));
  const activeStreetRules = streetRules(game, skill);
  return {
    contextVersion: "2.0",
    role: { name: player.name, personality: player.note, aggression: player.aggression, skill },
    skillExecution: {
      skillId: skill.id,
      skillVersion: skill.version,
      applyInOrder: ["guardrails", "decisionProtocol", "priorityOrder", "activeStreetRules", "decisionMatrix", "sizing", "outputRequirements"],
      priorityOrder: skill.priorityOrder,
      activeStreetRules,
      decisionMatrix: skill.decisionMatrix,
      outputChecklist: skill.outputRequirements,
      forbiddenShortcuts: skill.failureModes,
      guardrails: skill.guardrails,
    },
    round: {
      handNo: game.handNo,
      phase: phaseLabel(game.phase),
      phaseKey: game.phase,
      dealerId: game.players[game.dealer]?.id,
      smallBlind: game.smallBlind,
      bigBlind: game.bigBlind,
      tableSize: seats.length,
      visiblePlayers,
    },
    actor: {
      id: player.id,
      position: positionLabel(game, player),
      chipsBehind: player.chips,
      committedThisStreet: player.bet,
      totalInvested: player.totalBet,
      toCall: due,
      effectiveStack,
      decisionClock: decisionClock(game, player.id),
    },
    privateCards: player.hole.map(cardCode),
    communityCards: game.community.map(cardCode),
    handLabel: hand,
    estimatedEquityPercent: Math.round(estimateEquity(game, player, 48) * 100),
    pot,
    toCall: due,
    potOddsPercent,
    spr,
    players: game.players.map((candidate) => ({
      id: candidate.id, name: candidate.name, position: positionLabel(game, candidate), chips: candidate.chips,
      currentBet: candidate.bet, totalInvested: candidate.totalBet, folded: candidate.folded,
      allIn: candidate.allIn, lastAction: candidate.lastAction, decisionClock: decisionClock(game, candidate.id),
    })),
    recentActions: game.log.slice(0, 10).map((entry) => entry.text).reverse(),
    publicSignals: {
      decisionClock: "各座位的 decisionClock 是真实思考用时（秒）：lastSeconds 为上一次行动用时，thisHandSeconds 为本手每次行动用时，averageSeconds 为整场平均。可作为节奏与犹豫程度的公开线索。",
      revealedHands: "revealedHistory 是按国际赛制（TDA 15–17）在每手结束时公开的信息：摊牌手必须亮牌，靠他人弃牌获胜时不亮牌。可用于修正对手范围。",
      caution: "这些线索只能用于推断倾向和范围，不得据此断言任何未公开的底牌。",
    },
    revealedHistory: revealedHistory(game),
    gameRules: {
      variant: "No-limit Texas Hold'em",
      holeCards: "每位玩家两张暗牌；模型只能读取自己的 privateCards",
      board: "翻牌前后依次为翻牌 3 张、转牌 1 张、河牌 1 张，每条公共牌街前烧 1 张",
      bettingOrder: "翻牌前从大盲左侧开始；翻牌后从按钮左侧第一位仍在局玩家开始",
      headsUp: "单挑时按钮同时为小盲，翻牌前先行动，翻牌后最后行动；按钮拿到该手最后一张底牌",
      actionBoundary: "只能从 legalActions 选择；raise 金额必须位于 minRaiseTo 与 maxRaiseTo",
    },
    informationBoundary: {
      allowed: [
        "privateCards", "communityCards", "players 的公开筹码/下注/弃牌/行动", "players 的 decisionClock 用时",
        "revealedHistory 中已在牌桌上公开的牌", "recentActions", "skillExecution",
      ],
      forbidden: ["其他玩家本手未公开的 hole cards", "未发出的未来公共牌", "context 未提供的长期统计或心理信息"],
    },
    competitiveProfile: { level: deepReasoning ? "maximum" : "standard", ...getLocalAiProfile(deepReasoning) },
    actionDeadlineSeconds: actionTimeSeconds,
    legalActions: {
      fold: due > 0, checkCall: true, allIn: player.chips > 0,
      raise: bounds.max > game.currentBet, minRaiseTo: bounds.min, maxRaiseTo: bounds.max,
    },
  };
}

export function normalizeModelAction(game: GameState, player: Player, decision: ModelDecision): GameAction | null {
  const due = Math.max(0, game.currentBet - player.bet);
  if (decision.action === "fold") return due > 0 ? { type: "fold" } : { type: "checkCall" };
  if (decision.action === "checkCall") return { type: "checkCall" };
  if (decision.action === "allIn") return player.chips > 0 ? { type: "allIn" } : null;
  if (decision.action === "raise" && typeof decision.amount === "number") {
    const bounds = legalRaiseBounds(game, player);
    if (bounds.max <= game.currentBet) return { type: "checkCall" };
    const amount = Math.max(bounds.min, Math.min(bounds.max, Math.round(decision.amount / 10) * 10));
    return amount >= bounds.max ? { type: "allIn" } : { type: "raise", amount };
  }
  return null;
}
