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
  strengthApplication?: string;
  risk?: string;
  confidence?: number | null;
  reasoningMode?: string;
  reasoningCharacters?: number | null;
};

function cardCode(card: Player["hole"][number]): string {
  return `${rankLabel[card.rank]}${suitSymbol[card.suit]}`;
}

export function buildModelContext(game: GameState, player: Player, actionTimeSeconds: 30 | 120 | 300, skillId = player.id) {
  const due = Math.max(0, game.currentBet - player.bet);
  const bounds = legalRaiseBounds(game, player);
  const pot = getPot(game);
  const hand = game.community.length >= 3 ? evaluateBest([...player.hole, ...game.community]).label : preflopLabel(player.hole);
  return {
    role: { name: player.name, personality: player.note, aggression: player.aggression, skill: OPPONENT_SKILLS[skillId] || OPPONENT_SKILLS.knox },
    round: { handNo: game.handNo, phase: phaseLabel(game.phase), dealerId: game.players[game.dealer]?.id, smallBlind: game.smallBlind, bigBlind: game.bigBlind },
    privateCards: player.hole.map(cardCode),
    communityCards: game.community.map(cardCode),
    handLabel: hand,
    estimatedEquityPercent: Math.round(estimateEquity(game, player, 48) * 100),
    pot,
    toCall: due,
    players: game.players.map((candidate) => ({
      id: candidate.id, name: candidate.name, chips: candidate.chips, currentBet: candidate.bet,
      totalInvested: candidate.totalBet, folded: candidate.folded, allIn: candidate.allIn, lastAction: candidate.lastAction,
    })),
    recentActions: game.log.slice(0, 10).map((entry) => entry.text).reverse(),
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
