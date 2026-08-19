import {
  LOCAL_AI_PROFILE, estimateEquity, evaluateBest, getPot, legalRaiseBounds, phaseLabel, preflopLabel,
  rankLabel, suitSymbol, type GameAction, type GameState, type Player,
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

function cardCode(card: Player["hole"][number]): string {
  return `${rankLabel[card.rank]}${suitSymbol[card.suit]}`;
}

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

export function buildModelContext(game: GameState, player: Player, actionTimeSeconds: 30 | 120 | 300, skillId = player.id) {
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
      allIn: candidate.allIn, lastAction: candidate.lastAction,
    })),
    recentActions: game.log.slice(0, 10).map((entry) => entry.text).reverse(),
    gameRules: {
      variant: "No-limit Texas Hold'em",
      holeCards: "每位玩家两张暗牌；模型只能读取自己的 privateCards",
      board: "翻牌前后依次为翻牌 3 张、转牌 1 张、河牌 1 张，每条公共牌街前烧 1 张",
      bettingOrder: "翻牌前从大盲左侧开始；翻牌后从按钮左侧第一位仍在局玩家开始",
      headsUp: "单挑时按钮同时为小盲，翻牌前先行动，翻牌后最后行动；按钮拿到该手最后一张底牌",
      actionBoundary: "只能从 legalActions 选择；raise 金额必须位于 minRaiseTo 与 maxRaiseTo",
    },
    informationBoundary: {
      allowed: ["privateCards", "communityCards", "players 的公开筹码/下注/弃牌/行动", "recentActions", "skillExecution"],
      forbidden: ["其他玩家的 hole cards", "未发出的未来公共牌", "context 未提供的长期统计或心理信息"],
    },
    competitiveProfile: { level: "maximum", ...LOCAL_AI_PROFILE },
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
