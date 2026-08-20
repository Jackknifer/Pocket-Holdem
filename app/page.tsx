"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AI_SEAT_PROFILES, LOCAL_AI_PROFILE, applyAction, cardCode, chooseAiAction, evaluateBest, formatChips,
  getBlindProgress, getPot, legalRaiseBounds, newSession, newSpectatorSession, phaseLabel, preflopLabel, rankLabel,
  spectatorSeatProfiles, startNextHand, suitSymbol,
  type Card, type GameAction, type GameState, type Player,
} from "./game";
import { OPPONENT_SKILLS } from "./ai-skills";
import { ModelChoiceOptions, type ModelChoice } from "./model-choice";
import { OnlineExperience } from "./online-game";
import { buildModelContext, normalizeModelAction, type ModelDecision } from "./model-poker";

type Settings = {
  gameMode: GameMode;
  playerCount: PlayerCount;
  turnTime: TurnTime;
  spectatorAiMode: SpectatorAiMode;
  spectatorProvider: string;
  spectatorProviders: Record<string, string>;
  spectatorReveal: boolean;
  modelAiEnabled: boolean;
  modelProvider: string;
  maxReasoning: boolean;
  sound: boolean;
  autoNext: boolean;
  reviewMode: ReviewMode;
};

type PlayerCount = 2 | 3 | 4 | 5 | 6;
type GameMode = "local" | "spectator" | "online";
type TurnTime = 30 | 120 | 300;
type SpectatorAiMode = "shared" | "individual";
type ReviewMode = "training" | "standard";
type ModelStatus = { tone: "idle" | "working" | "ready" | "fallback"; text: string };
type ModelUsage = { input: number; output: number; total: number };
type ModelActionResult = Omit<ModelDecision, "action"> & { action: GameAction; provider: string; model: string; note: string };
type ModelOption = { id: string; name: string; model: string; configured: boolean; hint: string };
type ModelAuditEntry = {
  id: string;
  handNo: number;
  phase: string;
  playerName: string;
  provider: string;
  model: string;
  status: "requesting" | "success" | "fallback";
  action?: string;
  detail?: string;
  requestId?: string | null;
  latencyMs?: number;
  attempts?: number;
  recovered?: boolean;
  recovery?: "region" | "format" | null;
  region?: string | null;
  finishReason?: string | null;
  usage?: ModelUsage | null;
  output?: string;
  skillId?: string | null;
  skillRulesUsed?: string[];
  skillVerified?: boolean | null;
  reasoningMode?: string;
  reasoningCharacters?: number | null;
  completedAt?: number;
  createdAt: number;
};

type Stats = {
  hands: number;
  wins: number;
  biggestPot: number;
  streak: number;
  bestStreak: number;
};

type SavedSession = { game: GameState; savedAt: number; modelAudit?: ModelAuditEntry[] };

const DEFAULT_MODEL_OPTIONS: ModelOption[] = [
  { id: "openai", name: "OpenAI", model: "gpt-4.1-mini", configured: false, hint: "在 .env.local 设置 OPENAI_API_KEY" },
  { id: "deepseek", name: "DeepSeek", model: "deepseek-v4-flash", configured: false, hint: "在 .env.local 设置 DEEPSEEK_API_KEY" },
  { id: "minimax", name: "MiniMax", model: "MiniMax-M2.7", configured: false, hint: "在 .env.local 设置 MINIMAX_API_KEY" },
  { id: "kimi", name: "Kimi", model: "kimi-k2.6", configured: false, hint: "在 .env.local 设置 KIMI_API_KEY" },
  { id: "glm", name: "GLM", model: "glm-5.2", configured: false, hint: "在 .env.local 设置 GLM_API_KEY" },
];
const SPECTATOR_ROSTER = AI_SEAT_PROFILES;
const DEFAULT_SPECTATOR_PROVIDERS = Object.fromEntries(SPECTATOR_ROSTER.map((seat) => [seat.id, "local"]));
const DEFAULT_SETTINGS: Settings = {
  gameMode: "local", playerCount: 4, turnTime: 30, spectatorAiMode: "shared", spectatorProvider: "local",
  spectatorProviders: DEFAULT_SPECTATOR_PROVIDERS,
  spectatorReveal: true,
  modelAiEnabled: false,
  modelProvider: "openai", maxReasoning: true,
  sound: true, autoNext: false, reviewMode: "standard",
};

function gameModeLabel(mode: GameMode): string {
  return mode === "spectator" ? "AI 观战" : mode === "online" ? "联机对局" : "本地对局";
}

function modelDisplayName(id: string, options: ModelOption[]): string {
  if (id === "local") return "本地 AI";
  return options.find((item) => item.id === id)?.name || id;
}
const DEFAULT_STATS: Stats = { hands: 0, wins: 0, biggestPot: 0, streak: 0, bestStreak: 0 };

const MODEL_TEST_CONTEXT = {
  role: { name: "连接测试", personality: "均衡", aggression: 0.5, skill: OPPONENT_SKILLS.knox },
  round: { handNo: 0, phase: "翻牌前", dealerId: "knox", smallBlind: 10, bigBlind: 20 },
  privateCards: ["A♠", "K♣"], communityCards: [], handLabel: "高张组合", estimatedEquityPercent: 55,
  pot: 30, toCall: 10,
  players: [
    { id: "knox", name: "连接测试", chips: 1990, currentBet: 10, totalInvested: 10, folded: false, allIn: false, lastAction: "小盲注" },
    { id: "you", name: "你", chips: 1980, currentBet: 20, totalInvested: 20, folded: false, allIn: false, lastAction: "大盲注" },
  ],
  recentActions: ["你投入大盲注 20", "连接测试投入小盲注 10"],
  competitiveProfile: { level: "maximum", ...LOCAL_AI_PROFILE },
  actionDeadlineSeconds: 120,
  legalActions: { fold: true, checkCall: true, allIn: true, raise: true, minRaiseTo: 40, maxRaiseTo: 2000 },
};

function describeModelAction(action: GameAction, game: GameState, player: Player): string {
  if (action.type === "fold") return "弃牌";
  if (action.type === "allIn") return "全下";
  if (action.type === "raise") return `加注至 ${formatChips(action.amount)}`;
  return game.currentBet > player.bet ? `跟注 ${formatChips(Math.min(game.currentBet - player.bet, player.chips))}` : "过牌";
}

function safeModelError(error: unknown): string {
  const message = (error instanceof Error ? error.message : "").replace(/(?:sk-|key-)[a-z0-9_-]{8,}/gi, "[已隐藏密钥]").trim();
  if (/密钥|unauthorized|authentication|\b401\b|\b403\b/i.test(message)) return "认证失败，请检查本地 API Key";
  if (/余额|balance|quota|credit|insufficient/i.test(message)) return "模型账户余额或额度不足";
  if (/rate.?limit|too many|\b429\b/i.test(message)) return "调用过于频繁，请稍后重试";
  if (/model.*(?:not found|不存在|无权|access)|unknown model/i.test(message)) return "模型名称不可用或当前账号无权访问";
  if (/超时|abort|timeout|超过 \d+ 秒/i.test(message)) return "模型响应超时";
  if (/结构化|未知动作|无法执行|illegal|invalid action/i.test(message)) return "模型返回的动作无效";
  if (/地址|endpoint|connect|network|fetch/i.test(message)) return "无法连接模型服务，请检查本地 API 地址或网络";
  return message ? message.slice(0, 110) : "模型服务不可用";
}

function aiDecisionDelay(game: GameState, player: Player, turnTime: TurnTime): number {
  const ranges: Record<TurnTime, [number, number]> = {
    30: [6_500, 5_000],
    120: [10_000, 12_000],
    300: [12_000, 14_000],
  };
  const [base, spread] = ranges[turnTime];
  const due = Math.max(0, game.currentBet - player.bet);
  const pot = Math.max(1, getPot(game));
  const isComplex = game.phase !== "preflop" || due >= game.bigBlind * 3 || due / (pot + due) >= 0.24;
  const complexityTime = isComplex ? 900 + Math.random() * 1_400 : 0;
  const shortStackAdjustment = player.chips <= game.bigBlind * 10 ? -600 : 0;
  return Math.max(1_400, Math.min(turnTime * 1_000 - 1_500, Math.round(base + Math.random() * spread + complexityTime + shortStackAdjustment)));
}

async function requestModelDecision(provider: string, context: unknown, reasoning: "standard" | "max", signal: AbortSignal, actionTimeSeconds?: TurnTime): Promise<ModelDecision> {
  const response = await fetch("/api/ai-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, context, reasoning, ...(actionTimeSeconds ? { actionTimeSeconds } : {}) }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as ModelDecision & { error?: string };
  if (!response.ok) throw new Error(payload.error || "模型请求失败");
  return payload;
}

/** One connection test: the same probe hand for the local model card and for every spectator seat. */
async function probeModel(option: ModelOption, reasoning: "standard" | "max"): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), option.id === "minimax" ? 245_000 : 185_000);
  try {
    const result = await requestModelDecision(option.id, MODEL_TEST_CONTEXT, reasoning, controller.signal);
    if (!["fold", "checkCall", "raise", "allIn"].includes(String(result.action))) throw new Error("模型返回的动作无效");
    return result.model || option.model;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function requestModelAction(game: GameState, player: Player, provider: string, reasoning: "standard" | "max", signal: AbortSignal, actionTimeSeconds: TurnTime): Promise<ModelActionResult> {
  const payload = await requestModelDecision(provider, buildModelContext(game, player, actionTimeSeconds, player.id, { maxReasoning: reasoning === "max" }), reasoning, signal, actionTimeSeconds);
  const action = normalizeModelAction(game, player, payload);
  if (!action) throw new Error("模型返回的动作无法执行");
  return {
    ...payload,
    action,
    provider: payload.provider || provider,
    model: payload.model || "未返回模型名",
    note: payload.note?.slice(0, 240) || "",
  };
}

function CardView({ card, hidden = false, delay = 0, small = false }: { card?: Card; hidden?: boolean; delay?: number; small?: boolean }) {
  if (!card && !hidden) return <span className={`playing-card card-slot ${small ? "card-small" : ""}`} aria-hidden="true" />;
  if (hidden) return <span className={`playing-card card-back ${small ? "card-small" : ""}`} style={{ animationDelay: `${delay}ms` }} aria-label="暗牌"><span>P</span></span>;
  const red = card?.suit === "h" || card?.suit === "d";
  return (
    <span className={`playing-card dealt ${red ? "card-red" : ""} ${small ? "card-small" : ""}`} style={{ animationDelay: `${delay}ms` }} aria-label={`${rankLabel[card!.rank]} ${suitSymbol[card!.suit]}`}>
      <b>{rankLabel[card!.rank]}</b><i>{suitSymbol[card!.suit]}</i>
    </span>
  );
}

function ReviewCardCode({ card }: { card: Card }) {
  const red = card.suit === "h" || card.suit === "d";
  return (
    <span className={`review-card-code ${red ? "is-red" : ""}`} aria-label={cardCode(card)}>
      <b>{rankLabel[card.rank]}</b><i>{suitSymbol[card.suit]}</i>
    </span>
  );
}

function TinyIcon({ name }: { name: "sound" | "mute" | "settings" | "help" | "history" | "close" }) {
  const glyph = { sound: "♫", mute: "静", settings: "•••", help: "?", history: "↗", close: "×" }[name];
  return <span aria-hidden="true">{glyph}</span>;
}

type SeatSide = "top" | "left" | "right" | "bottom";
type SeatPlacement = { x: number; y: number; side: SeatSide };

const SEAT_PLACEMENTS: Record<number, SeatPlacement[]> = {
  2: [{ x: 50, y: 91, side: "bottom" }, { x: 50, y: 10, side: "top" }],
  3: [{ x: 50, y: 91, side: "bottom" }, { x: 17, y: 31, side: "left" }, { x: 83, y: 31, side: "right" }],
  4: [{ x: 50, y: 91, side: "bottom" }, { x: 13, y: 49, side: "left" }, { x: 50, y: 10, side: "top" }, { x: 87, y: 49, side: "right" }],
  5: [{ x: 50, y: 91, side: "bottom" }, { x: 14, y: 63, side: "left" }, { x: 25, y: 18, side: "left" }, { x: 75, y: 18, side: "right" }, { x: 86, y: 63, side: "right" }],
  6: [{ x: 50, y: 91, side: "bottom" }, { x: 13, y: 64, side: "left" }, { x: 17, y: 23, side: "left" }, { x: 50, y: 9, side: "top" }, { x: 83, y: 23, side: "right" }, { x: 87, y: 64, side: "right" }],
};

function Seat({ player, index, game, modelThinking, aiThinking, spectator, revealed, peeked, onPeek }: {
  player: Player;
  index: number;
  game: GameState;
  modelThinking: boolean;
  aiThinking: boolean;
  spectator: boolean;
  revealed: boolean;
  peeked: boolean;
  onPeek: () => void;
}) {
  const isActive = game.status === "playing" && game.currentPlayer === index;
  const dealt = player.hole.length > 0;
  // A hand tabled at showdown is the engine's call, so a spectator click cannot hide it again.
  const tabled = game.phase === "showdown" && !player.folded;
  // Every spectator click flips this seat away from the current default: hidden seats open, open seats close.
  const spectatorOpen = spectator && dealt && revealed !== peeked;
  const showCards = tabled || spectatorOpen;
  const canPeek = spectator && dealt && !tabled;
  const winner = game.winners.some((group) => group.ids.includes(player.id));
  const seatName = player.isHuman ? "seat-you" : `seat-${player.id}`;
  const stateText = player.folded ? "已弃牌" : player.allIn ? "全下" : player.chips <= 0 ? "已出局" : "";
  const placement = SEAT_PLACEMENTS[game.players.length]?.[index] || SEAT_PLACEMENTS[4][index];
  const handTag = showCards && player.hole.length === 2
    ? game.community.length >= 3 ? evaluateBest([...player.hole, ...game.community]).label : preflopLabel(player.hole)
    : "";

  return (
    <div
      className={`seat ${seatName} seat-side-${placement.side} ${isActive ? "seat-active" : ""} ${player.folded ? "seat-folded" : ""} ${winner ? "seat-winner" : ""}`}
      style={{ "--seat-x": `${placement.x}%`, "--seat-y": `${placement.y}%` } as React.CSSProperties}
    >
      {!player.isHuman && (
        <div className={`opponent-cards ${showCards || canPeek ? "is-open" : ""}`} aria-label={`${player.name} 的手牌`}>
          {canPeek ? (
            <button
              type="button" className="opponent-card-pair" onClick={onPeek} aria-pressed={showCards}
              title={showCards ? `收起 ${player.name} 的底牌` : `查看 ${player.name} 的底牌`}
              aria-label={showCards ? `收起 ${player.name} 的底牌` : `查看 ${player.name} 的底牌`}
            >
              <CardView card={showCards ? player.hole[0] : undefined} hidden={!showCards} small delay={80} />
              <CardView card={showCards ? player.hole[1] : undefined} hidden={!showCards} small delay={150} />
            </button>
          ) : (
            <span className="opponent-card-pair">
              <CardView card={showCards ? player.hole[0] : undefined} hidden={!showCards && dealt} small delay={80} />
              <CardView card={showCards ? player.hole[1] : undefined} hidden={!showCards && dealt} small delay={150} />
            </span>
          )}
          {handTag && <em className="opponent-hand-tag">{handTag}</em>}
        </div>
      )}
      {isActive && <span className={`seat-turn-label ${player.isHuman ? "is-you" : ""}`}>{player.isHuman ? "你的回合" : spectator ? modelThinking ? "模型思考中" : aiThinking ? "AI 思考中" : "正在行动" : modelThinking ? "模型思考中" : "正在行动"}</span>}
      <div className="seat-profile">
        <span className="seat-avatar">{player.avatar}</span>
        <span className="seat-copy">
          <strong>{player.name}{index === game.dealer && <em className="dealer-dot">D</em>}</strong>
          <small>{stateText || player.lastAction || player.note}</small>
        </span>
        <span className="seat-stack"><small>剩余</small><b>{formatChips(player.chips)}</b></span>
        {isActive && <span className="thinking"><i /><i /><i /></span>}
      </div>
      {player.bet > 0 && <span className="bet-tag"><small>本轮投入</small><strong>{formatChips(player.bet)}</strong></span>}
    </div>
  );
}

export default function Home() {
  const [game, setGame] = useState<GameState | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const [timer, setTimer] = useState<number>(DEFAULT_SETTINGS.turnTime);
  const [raiseTo, setRaiseTo] = useState(40);
  const [showRaise, setShowRaise] = useState(false);
  const [panel, setPanel] = useState<"settings" | "help" | "stats" | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);
  const [testingModel, setTestingModel] = useState(false);
  const [modelThinkingId, setModelThinkingId] = useState<string | null>(null);
  const [aiThinkingId, setAiThinkingId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ tone: "idle", text: "正在读取本地模型配置" });
  // Connection results for the spectator seats, keyed by provider id; untested providers are simply absent.
  const [providerTests, setProviderTests] = useState<Record<string, ModelStatus>>({});
  const [modelAudit, setModelAudit] = useState<ModelAuditEntry[]>([]);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [spectatorPaused, setSpectatorPaused] = useState(false);
  const [peekedSeats, setPeekedSeats] = useState<string[]>([]);
  const recordedHand = useRef(0);
  const soundedHand = useRef(0);
  const soundedBoard = useRef("");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let nextSettings = DEFAULT_SETTINGS;
      let nextStats = DEFAULT_STATS;
      try {
        const storedSettings = localStorage.getItem("pocket-settings");
        const storedStats = localStorage.getItem("pocket-stats");
        const storedSession = localStorage.getItem("pocket-active-session");
        localStorage.removeItem("pocket-model-credentials");
        if (storedSettings) {
          const parsedSettings = JSON.parse(storedSettings) as Partial<Settings>;
          nextSettings = {
            gameMode: ["local", "spectator", "online"].includes(String(parsedSettings.gameMode)) ? parsedSettings.gameMode as GameMode : DEFAULT_SETTINGS.gameMode,
            playerCount: [2, 3, 4, 5, 6].includes(Number(parsedSettings.playerCount)) ? parsedSettings.playerCount as PlayerCount : DEFAULT_SETTINGS.playerCount,
            turnTime: [30, 120, 300].includes(Number(parsedSettings.turnTime)) ? parsedSettings.turnTime as TurnTime : DEFAULT_SETTINGS.turnTime,
            spectatorAiMode: ["shared", "individual"].includes(String(parsedSettings.spectatorAiMode)) ? parsedSettings.spectatorAiMode as SpectatorAiMode : DEFAULT_SETTINGS.spectatorAiMode,
            spectatorProvider: typeof parsedSettings.spectatorProvider === "string" ? parsedSettings.spectatorProvider : DEFAULT_SETTINGS.spectatorProvider,
            spectatorProviders: parsedSettings.spectatorProviders && typeof parsedSettings.spectatorProviders === "object"
              ? { ...DEFAULT_SPECTATOR_PROVIDERS, ...Object.fromEntries(Object.entries(parsedSettings.spectatorProviders).filter(([id, provider]) => SPECTATOR_ROSTER.some((seat) => seat.id === id) && typeof provider === "string")) }
              : DEFAULT_SETTINGS.spectatorProviders,
            spectatorReveal: parsedSettings.spectatorReveal ?? DEFAULT_SETTINGS.spectatorReveal,
            modelAiEnabled: Boolean(parsedSettings.modelAiEnabled),
            modelProvider: typeof parsedSettings.modelProvider === "string" ? parsedSettings.modelProvider : DEFAULT_SETTINGS.modelProvider,
            maxReasoning: parsedSettings.maxReasoning ?? DEFAULT_SETTINGS.maxReasoning,
            sound: parsedSettings.sound ?? DEFAULT_SETTINGS.sound,
            autoNext: parsedSettings.autoNext ?? DEFAULT_SETTINGS.autoNext,
            reviewMode: ["training", "standard"].includes(String(parsedSettings.reviewMode)) ? parsedSettings.reviewMode as ReviewMode : DEFAULT_SETTINGS.reviewMode,
          };
        }
        if (storedStats) nextStats = { ...DEFAULT_STATS, ...JSON.parse(storedStats) };
        if (storedSession) {
          const parsed = JSON.parse(storedSession) as SavedSession;
          if (parsed.game && ["playing", "handOver"].includes(parsed.game.status)) {
            parsed.game.players = parsed.game.players.map((player) => ({ ...player, lastAction: player.lastAction || "等待行动" }));
            parsed.game.blindLevel ||= 1;
            parsed.game.actedAt ||= {};
            parsed.game.decisionTiming ||= {};
            parsed.game.revealedHands ||= [];
            if (Array.isArray(parsed.modelAudit)) setModelAudit(parsed.modelAudit.slice(0, 60));
            setSavedSession(parsed);
          }
        }
      } catch { /* Invalid local data falls back to safe defaults. */ }
      setSettings(nextSettings);
      setStats(nextStats);
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/model-config", { headers: { "Accept": "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("读取本地模型配置失败");
        return response.json() as Promise<{ models?: ModelOption[] }>;
      })
      .then((payload) => {
        if (!active || !Array.isArray(payload.models)) return;
        const options = payload.models.filter((item) => item && typeof item.id === "string" && typeof item.name === "string");
        setModelOptions(options.length ? options : DEFAULT_MODEL_OPTIONS);
        const configured = options.filter((item) => item.configured);
        setSettings((current) => {
          const selected = options.find((item) => item.id === current.modelProvider && item.configured) || configured[0];
          const hasCustomSetting = typeof window !== "undefined" && localStorage.getItem("pocket-settings") !== null;
          const shouldEnable = hasCustomSetting ? current.modelAiEnabled : Boolean(selected);
          return selected ? { ...current, modelProvider: selected.id, modelAiEnabled: shouldEnable } : { ...current, modelAiEnabled: false };
        });
        setModelStatus(configured.length
          ? { tone: "ready", text: `本地已载入 ${configured.length} 个可用模型` }
          : { tone: "idle", text: "请先在 .env.local 配置 API Key" });
      })
      .catch((error) => {
        if (active) setModelStatus({ tone: "fallback", text: safeModelError(error) });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => { if (hydrated) localStorage.setItem("pocket-settings", JSON.stringify(settings)); }, [settings, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem("pocket-stats", JSON.stringify(stats)); }, [stats, hydrated]);
  useEffect(() => {
    if (!hydrated || !game || game.tableMode !== "local") return;
    const timeout = window.setTimeout(() => localStorage.setItem("pocket-active-session", JSON.stringify({ game, modelAudit, savedAt: Date.now() })), 0);
    return () => window.clearTimeout(timeout);
  }, [game, modelAudit, hydrated]);

  const addModelAudit = useCallback((entry: ModelAuditEntry) => {
    setModelAudit((current) => [entry, ...current].slice(0, 60));
  }, []);

  const updateModelAudit = useCallback((id: string, update: Partial<ModelAuditEntry>) => {
    setModelAudit((current) => current.map((entry) => entry.id === id ? { ...entry, ...update } : entry));
  }, []);

  const human = game?.players.find((player) => player.isHuman);
  const viewer = human || game?.players[0];
  const isSpectator = game?.tableMode === "spectator";
  const isHumanTurn = Boolean(game && human && game.status === "playing" && game.players[game.currentPlayer]?.isHuman);
  const due = game && human ? Math.max(0, game.currentBet - human.bet) : 0;
  const bounds = game && human ? legalRaiseBounds(game, human) : { min: 0, max: 0 };
  const pot = game ? getPot(game) : 0;
  const defaultRaise = Math.max(bounds.min, Math.min(bounds.max, Math.round(Math.max(bounds.min, pot * 0.6) / 10) * 10));
  const handLabel = viewer
    ? game && game.community.length >= 3 ? evaluateBest([...viewer.hole, ...game.community]).label : preflopLabel(viewer.hole)
    : "等待发牌";

  const playTone = useCallback((kind: "deal" | "turn" | "clock" | "action" | "raise" | "fold" | "win" | "lose", force = false) => {
    if ((!settings.sound && !force) || typeof window === "undefined") return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const patterns: Record<typeof kind, Array<[number, number, number, number]>> = {
        deal: [[220, 0, .045, .016], [285, .065, .055, .018]],
        turn: [[420, 0, .08, .024], [560, .1, .12, .028]],
        clock: [[520, 0, .045, .014]],
        action: [[275, 0, .07, .017]],
        raise: [[310, 0, .065, .02], [410, .075, .09, .023]],
        fold: [[235, 0, .06, .018], [185, .065, .08, .015]],
        win: [[392, 0, .09, .024], [523, .1, .1, .027], [659, .21, .16, .03]],
        lose: [[294, 0, .1, .018], [247, .11, .15, .016]],
      };
      for (const [frequency, offset, duration, volume] of patterns[kind]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const start = context.currentTime + offset;
        oscillator.type = kind === "deal" || kind === "action" ? "sine" : "triangle";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(volume, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
        oscillator.connect(gain); gain.connect(context.destination);
        oscillator.start(start); oscillator.stop(start + duration + .01);
      }
      window.setTimeout(() => { void context.close(); }, 650);
    } catch { /* Audio is optional. */ }
  }, [settings.sound]);

  useEffect(() => {
    if (isHumanTurn) playTone("turn");
  }, [isHumanTurn, playTone]);

  // Seats the spectator clicked open or closed against the current default; cleared on every new deal.
  useEffect(() => { setPeekedSeats([]); }, [game?.handNo]);

  useEffect(() => {
    if (isHumanTurn && timer > 0 && timer <= 5) playTone("clock");
  }, [isHumanTurn, playTone, timer]);

  useEffect(() => {
    if (!game || game.status !== "playing" || soundedHand.current === game.handNo) return;
    soundedHand.current = game.handNo;
    soundedBoard.current = `${game.handNo}:0`;
    playTone("deal");
  }, [game, playTone]);

  useEffect(() => {
    if (!game || game.status !== "playing" || game.community.length === 0) return;
    const boardKey = `${game.handNo}:${game.community.length}`;
    if (soundedBoard.current === boardKey) return;
    soundedBoard.current = boardKey;
    playTone("deal");
  }, [game, playTone]);

  const act = useCallback((action: GameAction) => {
    if (!game || !human || !isHumanTurn) return;
    playTone(action.type === "fold" ? "fold" : action.type === "raise" || action.type === "allIn" ? "raise" : "action");
    setShowRaise(false);
    const spent = Math.max(0, settings.turnTime - timer);
    setGame((current) => current ? applyAction(current, human.id, action, spent) : current);
  }, [game, human, isHumanTurn, playTone, settings.turnTime, timer]);

  useEffect(() => {
    if (spectatorPaused || !game || game.status !== "playing" || game.currentPlayer < 0) return;
    const player = game.players[game.currentPlayer];
    if (player.isHuman) return;
    const wait = aiDecisionDelay(game, player, settings.turnTime);
    const controller = new AbortController();
    let cancelled = false;
    let delayTimer: number | undefined;
    let auditId = "";
    let auditSettled = false;
    const turnStartedAt = Date.now();
    const deadline = window.setTimeout(() => controller.abort(), settings.turnTime * 1_000);
    const runTurn = async () => {
      const providerId = isSpectator ? (player.aiProvider || "local") : settings.modelAiEnabled ? settings.modelProvider : "local";
      const selectedModel = modelOptions.find((item) => item.id === providerId);
      const useModel = providerId !== "local" && Boolean(selectedModel?.configured);
      let action: GameAction | null = null;
      let fallbackDetail = "";
      setAiThinkingId(player.id);
      if (useModel) {
        const providerName = selectedModel?.name || settings.modelProvider;
        auditId = `${game.handNo}-${player.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        addModelAudit({
          id: auditId, handNo: game.handNo, phase: phaseLabel(game.phase), playerName: player.name, provider: providerName,
          model: selectedModel?.model || "本地配置", status: "requesting", createdAt: Date.now(),
        });
        setModelThinkingId(player.id);
        setModelStatus({ tone: "working", text: `${player.name} 正在请求 ${selectedModel?.model || providerName}` });
        try {
          const result = await requestModelAction(game, player, providerId, settings.maxReasoning ? "max" : "standard", controller.signal, settings.turnTime);
          action = result.action;
          auditSettled = true;
          updateModelAudit(auditId, {
            status: "success", provider: providerName, model: result.model,
            action: describeModelAction(result.action, game, player), detail: result.note || "模型返回合法动作",
            requestId: result.requestId,
            latencyMs: result.latencyMs,
            attempts: result.attempts,
            recovered: result.recovered,
            recovery: result.recovery,
            region: result.region,
            finishReason: result.finishReason,
            usage: result.usage,
            skillId: result.skillId,
            skillRulesUsed: result.skillRulesUsed,
            skillVerified: result.skillVerified,
            reasoningMode: result.reasoningMode,
            reasoningCharacters: result.reasoningCharacters,
            output: result.output,
            completedAt: Date.now(),
          });
          if (!cancelled) setModelStatus({ tone: "ready", text: `${player.name} 已使用 ${providerName} 完成决策` });
        } catch (error) {
          if (cancelled) return;
          fallbackDetail = controller.signal.aborted ? `超过 ${settings.turnTime} 秒行动时限` : safeModelError(error);
          auditSettled = true;
          updateModelAudit(auditId, { status: "fallback", detail: fallbackDetail });
          setModelStatus({ tone: "fallback", text: `${player.name}：${fallbackDetail}` });
        } finally {
          if (!cancelled) setModelThinkingId(null);
        }
      }
      if (cancelled) return;
      if (!action) {
        action = chooseAiAction(game, player, { maxReasoning: settings.maxReasoning });
        if (auditId) {
          auditSettled = true;
          updateModelAudit(auditId, {
            status: "fallback", action: `本地 AI · ${describeModelAction(action, game, player)}`,
            detail: fallbackDetail || "模型未返回可执行动作", completedAt: Date.now(),
          });
        }
      }
      const remainingWait = Math.max(0, wait - (Date.now() - turnStartedAt));
      if (remainingWait > 0) await new Promise<void>((resolve) => { delayTimer = window.setTimeout(resolve, remainingWait); });
      if (cancelled) return;
      window.clearTimeout(deadline);
      playTone(action.type === "fold" ? "fold" : action.type === "raise" || action.type === "allIn" ? "raise" : "action");
      // The elapsed time a spectator actually watched, including the deliberate pacing delay.
      const thinkingSeconds = (Date.now() - turnStartedAt) / 1000;
      setGame((current) => {
        if (!current || current.status !== "playing" || current.handNo !== game.handNo) return current;
        const actor = current.players[current.currentPlayer];
        if (!actor || actor.id !== player.id || actor.isHuman) return current;
        return applyAction(current, actor.id, action!, thinkingSeconds);
      });
    };
    void runTurn();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(deadline);
      if (delayTimer) window.clearTimeout(delayTimer);
      if (auditId && !auditSettled) updateModelAudit(auditId, { status: "fallback", detail: "请求已取消（观战暂停或牌局状态变化）", completedAt: Date.now() });
      setAiThinkingId((current) => current === player.id ? null : current);
      setModelThinkingId((current) => current === player.id ? null : current);
    };
  }, [game, isSpectator, modelOptions, settings.maxReasoning, settings.modelAiEnabled, settings.modelProvider, settings.turnTime, spectatorPaused, addModelAudit, updateModelAudit, playTone]);

  useEffect(() => {
    if (spectatorPaused) return;
    const reset = window.setTimeout(() => setTimer(settings.turnTime), 0);
    if (!game || game.status !== "playing" || game.currentPlayer < 0) return () => window.clearTimeout(reset);
    const interval = window.setInterval(() => setTimer((value) => Math.max(0, value - 1)), 1000);
    return () => { window.clearTimeout(reset); window.clearInterval(interval); };
  }, [game, settings.turnTime, spectatorPaused]);

  useEffect(() => {
    if (timer !== 0 || !game || !human || !isHumanTurn) return;
    const timeout = window.setTimeout(() => act(due === 0 ? { type: "checkCall" } : { type: "fold" }), 0);
    return () => window.clearTimeout(timeout);
  }, [timer, game, human, isHumanTurn, due, act]);

  useEffect(() => {
    if (!game || game.tableMode === "spectator" || game.status !== "handOver" || recordedHand.current === game.handNo) return;
    recordedHand.current = game.handNo;
    const won = game.winners.some((winner) => winner.ids.includes("you"));
    setStats((current) => {
      const streak = won ? current.streak + 1 : 0;
      return {
        hands: current.hands + 1, wins: current.wins + (won ? 1 : 0), biggestPot: Math.max(current.biggestPot, game.lastPot),
        streak, bestStreak: Math.max(current.bestStreak, streak),
      };
    });
    playTone(won ? "win" : "lose");
  }, [game, playTone]);

  useEffect(() => {
    if ((!settings.autoNext && game?.tableMode !== "spectator") || spectatorPaused || !game || game.status !== "handOver") return;
    const timeout = window.setTimeout(() => setGame((current) => current ? startNextHand(current) : current), game.tableMode === "spectator" ? 1800 : 2600);
    return () => window.clearTimeout(timeout);
  }, [settings.autoNext, game, spectatorPaused]);

  // Manual reveals last only for the hand they were taken in: the next deal returns every seat to the default.
  const currentHandNo = game?.handNo ?? 0;
  useEffect(() => setPeekedSeats([]), [currentHandNo]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (panel || !isHumanTurn || event.repeat) return;
      if (event.key.toLowerCase() === "f") act({ type: "fold" });
      if (["c", " "].includes(event.key.toLowerCase())) { event.preventDefault(); act({ type: "checkCall" }); }
      if (event.key.toLowerCase() === "r" && bounds.max > game!.currentBet) {
        if (!showRaise) setRaiseTo(defaultRaise);
        setShowRaise((value) => !value);
      }
      if (event.key === "Escape") setShowRaise(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [act, bounds.max, defaultRaise, game, isHumanTurn, panel, showRaise]);

  const startSession = () => {
    if (settings.gameMode === "online") {
      setOnlineOpen(true);
      setPanel(null);
      return;
    }
    localStorage.removeItem("pocket-active-session");
    setSavedSession(null);
    setModelAudit([]);
    const providers = settings.gameMode === "spectator"
      ? Object.fromEntries(spectatorSeatProfiles(settings.playerCount).map((seat) => [seat.id, settings.spectatorAiMode === "shared" ? settings.spectatorProvider : settings.spectatorProviders[seat.id] || "local"]))
      : {};
    setSpectatorPaused(false);
    setPeekedSeats([]);
    setGame(settings.gameMode === "spectator" ? newSpectatorSession(settings.playerCount, providers) : newSession(settings.playerCount));
    setPanel(null); setShowRaise(false); recordedHand.current = 0;
  };

  const returnToLobby = () => {
    localStorage.removeItem("pocket-active-session");
    setSavedSession(null);
    setModelAudit([]);
    setGame(null);
    setSpectatorPaused(false);
    setPeekedSeats([]);
    setAiThinkingId(null);
    setModelThinkingId(null);
    setPanel(null); setLogOpen(false); setShowRaise(false); recordedHand.current = 0;
  };

  const resumeSession = () => {
    if (!savedSession) return;
    if (savedSession.game.status === "handOver") recordedHand.current = savedSession.game.handNo;
    setSpectatorPaused(false);
    setGame(savedSession.game);
    setSavedSession(null);
  };

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const selectModel = async (providerId: string | null) => {
    if (!providerId) {
      setSettings((current) => ({ ...current, modelAiEnabled: false }));
      setModelStatus({ tone: "idle", text: "本场使用本地 AI" });
      return;
    }
    const selected = modelOptions.find((item) => item.id === providerId);
    if (!selected?.configured) {
      setModelStatus({ tone: "fallback", text: selected?.hint || "请先在 .env.local 配置模型" });
      return;
    }
    setSettings((current) => ({ ...current, modelProvider: selected.id, modelAiEnabled: true }));
    setTestingModel(true);
    setModelStatus({ tone: "working", text: `正在连接 ${selected.name} · ${selected.model}` });
    try {
      const model = await probeModel(selected, settings.maxReasoning ? "max" : "standard");
      setModelStatus({ tone: "ready", text: `连接成功 · ${model}` });
    } catch (error) {
      setModelStatus({ tone: "fallback", text: `连接失败：${safeModelError(error)}` });
    } finally {
      setTestingModel(false);
    }
  };

  // Spectator seats run the same probe as the local card, keyed by provider so every seat shows its own result.
  const testProvider = async (providerId: string) => {
    if (!providerId || providerId === "local") return;
    const selected = modelOptions.find((item) => item.id === providerId);
    if (!selected?.configured) {
      setProviderTests((current) => ({ ...current, [providerId]: { tone: "fallback", text: selected?.hint || "请先在 .env.local 配置模型" } }));
      return;
    }
    setProviderTests((current) => ({ ...current, [providerId]: { tone: "working", text: `正在连接 ${selected.name} · ${selected.model}` } }));
    try {
      const model = await probeModel(selected, settings.maxReasoning ? "max" : "standard");
      setProviderTests((current) => ({ ...current, [providerId]: { tone: "ready", text: `连接成功 · ${model}` } }));
    } catch (error) {
      setProviderTests((current) => ({ ...current, [providerId]: { tone: "fallback", text: `连接失败：${safeModelError(error)}` } }));
    }
  };

  if (!hydrated) {
    return <main className="loading-screen"><span className="brand-mark">P</span><p>正在整理牌桌…</p></main>;
  }

  if (onlineOpen) return <OnlineExperience capacity={settings.playerCount} turnTime={settings.turnTime} modelOptions={modelOptions} selectedModel={settings.modelAiEnabled ? settings.modelProvider : ""} maxReasoning={settings.maxReasoning} onExit={() => setOnlineOpen(false)} />;

  if (!game) return <Lobby settings={settings} stats={stats} savedSession={savedSession} modelOptions={modelOptions} modelStatus={modelStatus} testingModel={testingModel} providerTests={providerTests} onTestProvider={testProvider} onSelectModel={selectModel} onSetting={updateSetting} onStart={startSession} onResume={resumeSession} />;

  if (!viewer) return <main className="loading-screen"><span className="brand-mark">P</span><p>正在整理牌桌…</p></main>;

  const sessionTotal = game.players.reduce((sum, player) => sum + player.chips + player.totalBet, 0);
  const railSeat = isSpectator
    ? game.players.reduce((top, player) => player.chips > top.chips ? player : top, game.players[0])
    : viewer;
  const humanShare = sessionTotal ? Math.round((railSeat.chips / sessionTotal) * 100) : 0;
  const mainWinner = game.winners[0];
  const blindProgress = getBlindProgress(game);
  const actingPlayer = game.status === "playing" && game.currentPlayer >= 0 ? game.players[game.currentPlayer] : null;
  const winnerIds = new Set(game.winners.flatMap((group) => group.ids));
  // International practice (TDA 15–17): only players who reach showdown must table their
  // cards. "全部底牌" and spectator reveal are the opt-in ways to see everything.
  const revealAllHands = settings.reviewMode === "training" || (isSpectator && settings.spectatorReveal);
  const reviewPlayers = game.players.filter((player) => player.hole.length === 2 && (
    revealAllHands || player.isHuman || peekedSeats.includes(player.id) || (game.phase === "showdown" && !player.folded)
  ));
  const successfulModelCalls = modelAudit.filter((entry) => entry.status === "success").length;
  const fallbackModelCalls = modelAudit.filter((entry) => entry.status === "fallback").length;

  return (
    <main className="game-shell">
      <header className="topbar">
        <button className="brand bare-button" onClick={() => setPanel("stats")} aria-label="打开对局数据">
          <span className="brand-mark">P</span><span className="brand-word">POCKET</span>
        </button>
        <div className={`round-meta round-turn-status ${actingPlayer?.isHuman ? "is-you" : ""}`} role="status" aria-live="polite">
          <span className="round-turn-avatar">{actingPlayer?.avatar || "P"}</span>
          <span className="round-turn-copy">
            <small>第 {game.handNo} 手 · {phaseLabel(game.phase)} · {game.players.length} 人桌{actingPlayer ? ` · 剩余 ${timer} 秒` : ""}</small>
            <strong>{isSpectator
              ? spectatorPaused ? "观战已暂停" : actingPlayer ? aiThinkingId === actingPlayer.id ? `${actingPlayer.name} 正在思考` : `轮到 ${actingPlayer.name} 操作` : game.message
              : actingPlayer ? actingPlayer.isHuman ? "轮到你操作" : modelThinkingId === actingPlayer.id ? `${actingPlayer.name} 正在调用模型` : `轮到 ${actingPlayer.name} 操作` : game.message}</strong>
          </span>
          <i className="round-turn-pulse" />
        </div>
        <div className="top-actions">
          <button className="icon-button audit-button" onClick={() => setLogOpen((value) => !value)} aria-label="行动与模型调用记录"><TinyIcon name="history" />{modelAudit[0] && <i className={`audit-light ${modelAudit[0].status}`} />}</button>
          <button
            className={`icon-button sound-toggle ${settings.sound ? "is-on" : "is-muted"}`}
            onClick={() => {
              const enabled = !settings.sound;
              updateSetting("sound", enabled);
              if (enabled) playTone("turn", true);
            }}
            aria-label={settings.sound ? "声音已开启，点击关闭" : "声音已关闭，点击开启"}
            aria-pressed={settings.sound}
            title={settings.sound ? "声音已开启，点击关闭" : "声音已关闭，点击开启"}
          ><TinyIcon name={settings.sound ? "sound" : "mute"} /></button>
          <button className="icon-button" onClick={() => setPanel("help")} aria-label="玩法帮助"><TinyIcon name="help" /></button>
          <button className="icon-button" onClick={() => setPanel("settings")} aria-label="游戏设置"><TinyIcon name="settings" /></button>
        </div>
      </header>

      <section className="workspace">
        <aside className="session-rail" aria-label="本场进度">
          <div><small>{isSpectator ? "筹码领先" : "你的筹码"}</small><strong>{formatChips(railSeat.chips)}</strong></div>
          <div className="stack-meter"><span style={{ width: `${humanShare}%` }} /></div>
          <p>{isSpectator ? `${railSeat.name} 占场上筹码 ${humanShare}%` : `占场上筹码 ${humanShare}%`}</p>
          <button className="text-button" onClick={() => setLogOpen((value) => !value)}><TinyIcon name="history" /> 行动与模型记录</button>
        </aside>

        <section className="table-stage" aria-label="德州扑克牌桌">
          <div className="table-grid" />
          {game.players.map((player, index) => (
            <Seat
              key={player.id} player={player} index={index} game={game}
              modelThinking={modelThinkingId === player.id} aiThinking={aiThinkingId === player.id}
              spectator={isSpectator} revealed={settings.spectatorReveal} peeked={peekedSeats.includes(player.id)}
              onPeek={() => setPeekedSeats((current) => current.includes(player.id) ? current.filter((id) => id !== player.id) : [...current, player.id])}
            />
          ))}

          <div className="board">
            <div className="pot-line"><span>当前底池</span><strong>{formatChips(pot || game.lastPot)}</strong></div>
            <div className="community-cards" aria-label="公共牌">
              {Array.from({ length: 5 }, (_, index) => <CardView key={index} card={game.community[index]} delay={index * 90} />)}
            </div>
            <span className="phase-pill">{phaseLabel(game.phase)}</span>
            <div className="board-bets" aria-label="本轮所有投注">
              <small>本轮投入</small>
              {game.players.filter((player) => player.bet > 0).map((player) => <span key={player.id}><i>{player.avatar}</i>{formatChips(player.bet)}</span>)}
              {!game.players.some((player) => player.bet > 0) && <em>尚无投入</em>}
            </div>
          </div>

          {!isSpectator && (
            <div className="hero-hand" aria-label="你的手牌">
              <div className="hero-cards">
                <CardView card={viewer.hole[0]} delay={40} />
                <CardView card={viewer.hole[1]} delay={120} />
              </div>
              <div className="hand-readout"><small>当前牌型</small><strong>{handLabel}</strong></div>
            </div>
          )}

          {isSpectator && spectatorPaused && <div className="spectator-paused-overlay" role="status"><strong>观战已暂停</strong><span>点击底部的“继续观战”恢复 AI 行动</span></div>}

          {game.status === "handOver" && (
            <div className="result-card has-review" role="status">
              <span className="result-kicker">本手结束</span>
              <h2>{game.message}</h2>
              <p>{mainWinner ? `${mainWinner.label} · 底池 ${formatChips(game.lastPot)}` : "底池已结算"}</p>
              <section className="hand-review" aria-label="本手公共牌与底牌复盘">
                <header><strong>本手复盘</strong><small>{revealAllHands ? "展示全部底牌" : "国际赛制 · 只有进入摊牌的玩家亮牌"}</small></header>
                <div className="review-board" aria-label="本手公共牌">
                  <small>公共牌</small>
                  <div className="review-board-cards">
                    {game.community.length
                      ? game.community.map((card) => <ReviewCardCode card={card} key={card.id} />)
                      : <em>本手未发出公共牌</em>}
                  </div>
                </div>
                <div className="hand-review-grid">
                  {reviewPlayers.map((player) => {
                    const best = game.community.length >= 3 ? evaluateBest([...player.hole, ...game.community]) : null;
                    const label = best ? best.label : preflopLabel(player.hole);
                    return (
                      <article className={`${player.folded ? "folded" : ""} ${winnerIds.has(player.id) ? "winner" : ""}`} key={player.id}>
                        <span>{player.avatar}</span>
                        <div>
                          <strong>{player.name}</strong>
                          <div className="review-hole-cards">{player.hole.map((card) => <ReviewCardCode card={card} key={card.id} />)}</div>
                          {best && best.cards.length === 5 && (
                            <div className="review-best-five"><small>成牌</small>{best.cards.map((card) => <ReviewCardCode card={card} key={`best-${card.id}`} />)}</div>
                          )}
                          <small>{label} · {winnerIds.has(player.id) ? "赢得底池" : player.folded ? "已弃牌" : "参与摊牌"}</small>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
              <button className="primary-button" onClick={() => setGame((current) => current ? startNextHand(current) : current)}>下一手牌 <span>↵</span></button>
              {blindProgress.handsRemaining !== null && <small className="blind-note">{blindProgress.handsRemaining === 0 ? "下一手" : `还有 ${blindProgress.handsRemaining} 手牌`}升级至 {blindProgress.nextSmallBlind} / {blindProgress.nextBigBlind}</small>}
            </div>
          )}

          {game.status === "gameOver" && (
            <div className="result-card" role="status">
              <span className="result-kicker">对局结束</span>
              <h2>{game.message}</h2>
              <p>{isSpectator
                ? `本场观战共 ${game.handNo} 手牌 · 最大底池 ${formatChips(Math.max(game.lastPot, ...(game.revealedHands || []).map((entry) => entry.pot), 0))}`
                : `共完成 ${stats.hands} 手牌，胜率 ${stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0}%`}</p>
              <button className="primary-button" onClick={returnToLobby}>{isSpectator ? "返回大厅" : "准备新对局"}</button>
            </div>
          )}
        </section>

        <aside className={`activity-panel ${logOpen ? "is-open" : ""}`} aria-label="行动与模型调用记录">
          <div className="panel-head"><span><strong>对局记录</strong><small>模型调用可核验</small></span><button className="bare-button" onClick={() => setLogOpen(false)} aria-label="关闭记录"><TinyIcon name="close" /></button></div>
          <div className="log-list">
            <section className="model-audit-log" aria-label="模型调用审计">
              <div className="log-section-title"><strong>模型调用</strong><small>{successfulModelCalls} 成功 · {fallbackModelCalls} 回退</small></div>
              {modelAudit.length === 0 ? <p className="model-audit-empty">本场尚无可核验的模型调用</p> : modelAudit.map((entry) => {
                const statusLabel = entry.status === "requesting" ? "请求中" : entry.status === "success" ? "模型已采用" : "已回退本地 AI";
                return (
                  <article className={`model-audit-entry ${entry.status}`} key={entry.id}>
                    <header><span><i />{entry.provider}</span><time>第 {entry.handNo} 手 · {entry.phase}</time></header>
                    <strong>{entry.playerName} · {statusLabel}</strong>
                    <small className="audit-model">{entry.model} · {new Date(entry.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</small>
                    {entry.action && <p>{entry.action}</p>}
                    {entry.detail && <em>{entry.detail}</em>}
                    {entry.status === "success" && (
                      <div className="audit-proof" aria-label="模型请求凭证">
                        <span>{entry.latencyMs === undefined ? "耗时未知" : `${(entry.latencyMs / 1000).toFixed(1)} 秒`}</span>
                        <span>{entry.attempts || 1} 次请求</span>
                        {entry.region && <span>{entry.region}</span>}
                        {entry.recovered && <span>{entry.recovery === "region" ? "区域恢复" : "格式恢复"}</span>}
                        {entry.usage && <span>Token {entry.usage.input} → {entry.usage.output}</span>}
                        {entry.reasoningMode && <span>推理：{["max", "xhigh"].includes(entry.reasoningMode) ? "极致" : entry.reasoningMode === "high" ? "标准" : entry.reasoningMode === "native" ? "模型原生" : entry.reasoningMode === "adaptive" ? "自适应" : entry.reasoningMode === "enabled" ? "已开启" : "模型默认"}</span>}
                        {entry.reasoningCharacters && <span>内部推理 {entry.reasoningCharacters} 字符</span>}
                        {entry.skillVerified === true && <span>Skill 已核验</span>}
                        {entry.skillVerified === false && <span>Skill 未核验</span>}
                        {entry.finishReason && <span>结束：{entry.finishReason}</span>}
                        {entry.requestId && <code title={entry.requestId}>ID {entry.requestId}</code>}
                      </div>
                    )}
                    {entry.output && (
                      <details className="audit-output">
                        <summary>查看模型实际输出</summary>
                        <pre>{entry.output}</pre>
                      </details>
                    )}
                  </article>
                );
              })}
            </section>
            <div className="log-section-title action-log-title"><strong>本手行动</strong><small>第 {game.handNo} 手</small></div>
            {game.log.map((entry) => <p className={`action-log-entry ${entry.tone === "strong" ? "strong" : ""}`} key={entry.id}>{entry.text}</p>)}
          </div>
        </aside>
      </section>

      {isSpectator ? (
        <section className={`control-dock spectator-dock ${spectatorPaused ? "is-paused" : ""}`} aria-label="观战控制">
          <div className="dock-context" aria-label="观战状态">
            <span className="timer-ring" style={{ "--progress": `${timer / settings.turnTime * 360}deg` } as React.CSSProperties}><i>{spectatorPaused ? "Ⅱ" : game.status === "playing" ? timer : "·"}</i></span>
            <div>
              <small>{spectatorPaused ? "观战已暂停" : actingPlayer ? `${actingPlayer.name} 行动 · ${timer} 秒` : `第 ${game.handNo} 手 · ${phaseLabel(game.phase)}`}</small>
              <strong>{spectatorPaused ? "AI 不会继续行动" : actingPlayer ? `${actingPlayer.name} 正在思考` : game.status === "handOver" ? "准备下一手" : game.message}</strong>
            </div>
          </div>
          <div className="spectator-control-row">
            <button className="action-button dark" onClick={() => setSpectatorPaused((value) => !value)}>{spectatorPaused ? "继续观战" : "暂停观战"}</button>
            <button className="action-button quiet" onClick={returnToLobby}>结束观战</button>
          </div>
        </section>
      ) : (
        <section className={`control-dock ${isHumanTurn ? "dock-your-turn" : "dock-waiting"}`} aria-label="行动控制">
          <div className="dock-context" aria-label="本手决策信息">
            <span className="timer-ring" style={{ "--progress": `${timer / settings.turnTime * 360}deg` } as React.CSSProperties}><i>{game.status === "playing" ? timer : "·"}</i></span>
            <div>
              <small>{isHumanTurn ? `决策时间 · ${timer} 秒` : actingPlayer ? `${actingPlayer.name} 行动 · ${timer} 秒` : `第 ${game.handNo} 手 · ${phaseLabel(game.phase)}`}</small>
              <strong>{isHumanTurn ? `${handLabel} · ${due === 0 ? "可以过牌" : `待跟注 ${formatChips(Math.min(due, human?.chips || 0))}`}` : `${handLabel} · 筹码 ${formatChips(human?.chips || 0)}`}</strong>
            </div>
          </div>

          <div className="action-area">
            {showRaise && bounds.max > bounds.min && (
              <div className="raise-popover">
                <div className="raise-head"><span>加注到</span><strong>{formatChips(raiseTo)}</strong></div>
                <input aria-label="加注金额" type="range" min={bounds.min} max={bounds.max} step={10} value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} />
                <div className="quick-bets">
                  <button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, Math.round(pot * .5 / 10) * 10)))}>½ 底池</button>
                  <button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, Math.round(pot * .75 / 10) * 10)))}>¾ 底池</button>
                  <button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, pot)))}>满池</button>
                  <button onClick={() => setRaiseTo(bounds.max)}>全下</button>
                </div>
                <button className="confirm-raise" onClick={() => act(raiseTo >= bounds.max ? { type: "allIn" } : { type: "raise", amount: raiseTo })}>确认加注</button>
              </div>
            )}
            <div className="action-row">
              <button disabled={!isHumanTurn} className="action-button quiet" onClick={() => act({ type: "fold" })}>弃牌 <kbd>F</kbd></button>
              <button disabled={!isHumanTurn} className="action-button quiet" onClick={() => act({ type: "checkCall" })}>{due === 0 ? "过牌" : `跟注 ${formatChips(Math.min(due, human?.chips || 0))}`} <kbd>C</kbd></button>
              <button disabled={!isHumanTurn || bounds.max <= game.currentBet} className={`action-button dark ${showRaise ? "selected" : ""}`} onClick={() => { if (!showRaise) setRaiseTo(defaultRaise); setShowRaise((value) => !value); }}>加注 <kbd>R</kbd></button>
            </div>
          </div>
        </section>
      )}

      {panel && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button className="modal-close" onClick={() => setPanel(null)} aria-label="关闭"><TinyIcon name="close" /></button>
            {panel === "settings" && (
              <>
                <span className="modal-kicker">偏好</span><h2 id="modal-title">游戏设置</h2>
                <div className="settings-section">
                  <div className="settings-section-title"><strong>对手决策</strong><small>{isSpectator ? "观战席位按开局配置的模型行动" : "本地 AI 会按下面的开关调整模拟预算"}</small></div>
                  <div className="setting-group modal-pace"><span className="setting-label">行动时限</span><div className="segment-control">
                    {([30, 120, 300] as TurnTime[]).map((value) => <button key={value} className={settings.turnTime === value ? "active" : ""} onClick={() => updateSetting("turnTime", value)}>{value} 秒</button>)}
                  </div><small>{settings.turnTime === 30 ? "参考 TDA 叫钟：25 秒行动，加最后 5 秒倒数。" : settings.turnTime === 120 ? "所有玩家统一 120 秒，适合大多数深度思考。" : "所有玩家统一 300 秒，为长时间极致思考保留空间。"}</small></div>
                  <Toggle label="模型极致思考" detail="外部模型发送最高推理档；本地 AI 开启时提高模拟预算并降低随机噪声" checked={settings.maxReasoning} onChange={(value) => updateSetting("maxReasoning", value)} />
                </div>
                <div className="settings-section">
                  <div className="settings-section-title"><strong>亮牌与复盘</strong><small>默认与国际比赛一致</small></div>
                  <div className="setting-group"><span className="setting-label">结算亮牌</span><div className="segment-control">
                    {(["standard", "training"] as ReviewMode[]).map((value) => <button key={value} className={settings.reviewMode === value ? "active" : ""} onClick={() => updateSetting("reviewMode", value)}>{value === "standard" ? "国际赛制" : "全部底牌"}</button>)}
                  </div><small>{settings.reviewMode === "standard" ? "按 TDA 规则：进入摊牌的玩家必须亮牌，弃牌与靠他人弃牌获胜的手牌不亮。" : "结算后展示所有底牌与公共牌，适合学习对手线路。"}</small></div>
                  {isSpectator && <Toggle label="观战全程亮牌" detail="关闭后牌桌只显示暗牌；无论开关如何，点击某个座位的牌都能单独展开或收起这一手" checked={settings.spectatorReveal} onChange={(value) => updateSetting("spectatorReveal", value)} />}
                </div>
                <div className="settings-section">
                  <div className="settings-section-title"><strong>流程与界面</strong><small>无限注德州 · 10 / 20 起始盲注</small></div>
                  <Toggle label="自动下一手" detail="结算后自动继续，无需点击" checked={settings.autoNext} onChange={(value) => updateSetting("autoNext", value)} />
                  <Toggle label="界面音效" detail="轮到你、操作和结算时播放轻微提示" checked={settings.sound} onChange={(value) => updateSetting("sound", value)} />
                </div>
                <button className="danger-link" onClick={returnToLobby}>退出并准备新对局</button>
              </>
            )}
            {panel === "help" && (
              <>
                <span className="modal-kicker">快速上手</span><h2 id="modal-title">五分钟学会德州扑克</h2>
                <div className="help-steps">
                  <div><b>01</b><p><strong>拿到两张底牌</strong><span>只有你能看见。用它们和桌上的公共牌组合。</span></p></div>
                  <div><b>02</b><p><strong>依次行动</strong><span>可以过牌、跟注、加注或弃牌。四轮下注后进入摊牌。</span></p></div>
                  <div><b>03</b><p><strong>组成最好的五张牌</strong><span>同花顺最大，其次四条、葫芦、同花、顺子、三条、两对、一对和高牌。</span></p></div>
                </div>
                <div className="key-guide"><span><kbd>F</kbd> 弃牌</span><span><kbd>C</kbd> 跟注 / 过牌</span><span><kbd>R</kbd> 加注</span></div>
              </>
            )}
            {panel === "stats" && (
              <>
                <span className="modal-kicker">本机记录</span><h2 id="modal-title">你的牌桌数据</h2>
                <div className="stats-grid">
                  <div><strong>{stats.hands}</strong><span>完成手数</span></div>
                  <div><strong>{stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0}%</strong><span>胜率</span></div>
                  <div><strong>{formatChips(stats.biggestPot)}</strong><span>最大底池</span></div>
                  <div><strong>{stats.bestStreak}</strong><span>最长连胜</span></div>
                </div>
                <p className="privacy-note">{isSpectator ? "AI 观战不计入本机记录，这里仍是你自己对局的数据。" : "数据只保存在你的浏览器中，不会上传。"}</p>
              </>
            )}
          </section>
        </div>
      )}

    </main>
  );
}

function Lobby({ settings, stats, savedSession, modelOptions, modelStatus, testingModel, providerTests, onTestProvider, onSelectModel, onSetting, onStart, onResume }: {
  settings: Settings;
  stats: Stats;
  savedSession: SavedSession | null;
  modelOptions: ModelOption[];
  modelStatus: ModelStatus;
  testingModel: boolean;
  providerTests: Record<string, ModelStatus>;
  onTestProvider: (providerId: string) => Promise<void>;
  onSelectModel: (providerId: string | null) => Promise<void>;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onStart: () => void;
  onResume: () => void;
}) {
  const winRate = stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0;
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const [spectatorPanelOpen, setSpectatorPanelOpen] = useState(false);
  // Which seat's model list is open inside the spectator popover; "shared" is the one-for-all row.
  const [spectatorEditing, setSpectatorEditing] = useState<string | null>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const spectatorPickerRef = useRef<HTMLDivElement>(null);
  const provider = modelOptions.find((item) => item.id === settings.modelProvider) || modelOptions[0] || DEFAULT_MODEL_OPTIONS[0];
  const availableModels = modelOptions.filter((item) => item.configured);
  const spectatorSeats = spectatorSeatProfiles(settings.playerCount);
  const localChoice: ModelChoice = { id: "local", name: "本地 AI", model: settings.maxReasoning ? "极致模拟" : "标准模拟", mark: "P" };
  const spectatorChoices: ModelChoice[] = [localChoice, ...availableModels];
  const spectatorSharedProvider = modelDisplayName(settings.spectatorProvider, modelOptions);
  // The card keeps one line, so per-seat mode lists the distinct sources instead of every seat.
  const spectatorSources = spectatorSeats
    .map((seat) => modelDisplayName(settings.spectatorProviders[seat.id] || "local", modelOptions))
    .filter((name, index, list) => list.indexOf(name) === index);
  const spectatorSummary = settings.spectatorAiMode === "shared"
    ? `全部 ${settings.playerCount} 席都调用 ${spectatorSharedProvider}`
    : `${settings.playerCount} 席分别指定 · ${spectatorSources.join(" / ")}`;
  const editingSeat = spectatorSeats.find((seat) => seat.id === spectatorEditing);
  // The external providers this configuration actually calls; local seats need no connection test.
  const spectatorProviderIds = (settings.spectatorAiMode === "shared"
    ? [settings.spectatorProvider]
    : spectatorSeats.map((seat) => settings.spectatorProviders[seat.id] || "local"))
    .filter((id) => id && id !== "local")
    .filter((id, index, list) => list.indexOf(id) === index);
  const spectatorTests = spectatorProviderIds.map((id) => providerTests[id]);
  const spectatorTesting = spectatorTests.some((test) => test?.tone === "working");
  // A running test outranks a failure, a failure outranks an untested seat, and only an all-clear reads 已连接.
  const spectatorTone: ModelStatus["tone"] = spectatorTesting
    ? "working"
    : spectatorTests.some((test) => test?.tone === "fallback") ? "fallback"
      : spectatorProviderIds.length && spectatorTests.every((test) => test?.tone === "ready") ? "ready" : "idle";
  const spectatorCardStatus = !spectatorProviderIds.length
    ? "本地"
    : spectatorTesting ? "检测中" : spectatorTone === "fallback" ? "不可用" : spectatorTone === "ready" ? "已连接" : "待检测";
  const spectatorStatusText = !spectatorProviderIds.length
    ? "全部席位都使用本地 AI，无需连接测试。"
    : spectatorProviderIds.length === 1
      ? providerTests[spectatorProviderIds[0]]?.text || `${modelDisplayName(spectatorProviderIds[0], modelOptions)} 尚未检测，可点击“检测连接”。`
      : spectatorProviderIds.map((id) => `${modelDisplayName(id, modelOptions)}：${providerTests[id]?.text || "尚未检测"}`).join("；");
  const seatTestTone = (id: string) => id === "local" ? "local" : providerTests[id]?.tone || "untested";
  const seatTestLabel = (id: string) => id === "local"
    ? "本地 AI，无需连接测试"
    : `${modelDisplayName(id, modelOptions)}：${providerTests[id]?.text || "尚未检测"}`;
  const timeLabel = `${settings.turnTime} 秒行动`;
  const modelCardStatus = testingModel
    ? "检测中"
    : settings.modelAiEnabled
      ? modelStatus.tone === "fallback" ? "不可用" : "已连接"
      : "本地";
  const modelDetail = settings.modelAiEnabled
    ? provider.configured ? `${provider.name} · ${provider.model}` : provider.hint
    : provider.configured ? `已就绪 ${provider.name} · ${provider.model}（点击切换）` : "当前使用本地策略，可从项目配置启用模型";
  useEffect(() => {
    if (!modelPanelOpen) return;
    const close = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelPanelOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelPanelOpen]);
  useEffect(() => {
    if (!spectatorPanelOpen) return;
    const close = (event: PointerEvent) => {
      if (spectatorPickerRef.current?.contains(event.target as Node)) return;
      setSpectatorPanelOpen(false);
      setSpectatorEditing(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [spectatorPanelOpen]);
  const chooseModel = async (providerId: string | null) => {
    if (!providerId) setModelPanelOpen(false);
    await onSelectModel(providerId);
  };
  return (
    <main className="lobby-shell">
      <header className="topbar lobby-topbar">
        <span className="brand"><span className="brand-mark">P</span><span className="brand-word">POCKET</span></span>
        <span className="lobby-status"><i /> 对局尚未开始</span>
        <div className="top-actions"><span className="local-badge">{settings.gameMode === "online" ? "虚拟筹码 · 私人房" : settings.gameMode === "spectator" ? "AI 观战 · 仅在本机运行" : "仅在本机运行"}</span></div>
      </header>
      <section className="lobby-main">
        <div className="lobby-page">
          <div className="lobby-intro">
            <div className="lobby-intro-copy">
              <span className="modal-kicker">POCKET / {settings.gameMode === "online" ? "私人联机" : settings.gameMode === "spectator" ? "AI 观战" : "本地牌局"}</span>
              <h1>安静地，打一手好牌。</h1>
              <p>{settings.gameMode === "online" ? "创建私人房间，或使用六位房间码加入朋友的牌桌。" : settings.gameMode === "spectator" ? "配置 AI 席位后开始观战，随时暂停或结束这场牌局。" : "确认本场偏好。只有点击开始后，牌局才会正式创建。"}</p>
            </div>
            <dl className="lobby-basics" aria-label="固定对局信息">
              <div><dt>规则</dt><dd>无限注德州</dd></div>
              <div><dt>起始筹码</dt><dd>2,000</dd></div>
              <div><dt>初始盲注</dt><dd>10 / 20</dd></div>
            </dl>
          </div>
          <section className="lobby-card" aria-labelledby="lobby-settings-title">
            <div className="lobby-config">
              <div className="lobby-section-head">
                <span><strong id="lobby-settings-title">对局设置</strong><small>只保留开局前需要选择的内容</small></span>
                <em>4 项</em>
              </div>
              <div className="lobby-controls-grid">
                <div className="setting-group lobby-control-card">
                  <span className="setting-label">对局模式</span>
                  <div className="segment-control">
                    <button className={settings.gameMode === "local" ? "active" : ""} onClick={() => { setSpectatorPanelOpen(false); onSetting("gameMode", "local"); }}>本地对局</button>
                    <button className={settings.gameMode === "spectator" ? "active" : ""} onClick={() => { setModelPanelOpen(false); onSetting("gameMode", "spectator"); }}>AI 观战</button>
                    <button className={settings.gameMode === "online" ? "active" : ""} onClick={() => { setModelPanelOpen(false); setSpectatorPanelOpen(false); onSetting("gameMode", "online"); }}>联机对局</button>
                  </div>
                  <small>{settings.gameMode === "online" ? "私人邀请码房，服务端统一发牌和验证行动。" : settings.gameMode === "spectator" ? "全桌都是 AI，你只负责观战。" : "牌局与记录只保存在本机。"}</small>
                </div>
                <div className="setting-group lobby-control-card lobby-player-count">
                  <span className="setting-label">对局人数</span>
                  <div className="segment-control player-count-control">
                    {([2, 3, 4, 5, 6] as PlayerCount[]).map((value) => <button key={value} className={settings.playerCount === value ? "active" : ""} onClick={() => onSetting("playerCount", value)}>{value} 人</button>)}
                  </div>
                  <small>{settings.gameMode === "online" ? `房间最多容纳 ${settings.playerCount} 位真人玩家。` : settings.gameMode === "spectator" ? `${settings.playerCount} 位 AI 同桌，自动轮流行动。` : `你与 ${settings.playerCount - 1} 位风格不同的 AI 同桌。`}</small>
                </div>
                <div className="setting-group lobby-control-card">
                  <span className="setting-label">行动时限</span>
                  <div className="segment-control">
                    {([30, 120, 300] as TurnTime[]).map((value) => <button key={value} className={settings.turnTime === value ? "active" : ""} onClick={() => onSetting("turnTime", value)}>{value} 秒</button>)}
                  </div>
                  <small>{settings.turnTime === 30 ? "参考 TDA 叫钟：25 秒行动并在最后 5 秒倒数。" : settings.turnTime === 120 ? "每位玩家统一 120 秒，适合大多数深度思考。" : "每位玩家统一 300 秒，为长时间极致思考保留空间。"}</small>
                </div>
                {settings.gameMode === "spectator" ? (
                  <div className={`lobby-model-picker ${spectatorPanelOpen ? "is-open" : ""}`} ref={spectatorPickerRef}>
                    <div className="lobby-model-card">
                      <button type="button" className="lobby-model-entry" aria-haspopup="dialog" aria-expanded={spectatorPanelOpen} onClick={() => { setSpectatorEditing(null); setSpectatorPanelOpen((value) => !value); }}>
                        <span className="lobby-model-symbol">观</span>
                        <span className="lobby-model-copy"><strong>观战 AI 配置</strong><small>{spectatorSummary}</small></span>
                        <span className="lobby-model-actions">
                          <em className={`model-status ${spectatorTone}`}>{spectatorCardStatus}</em>
                          <span className="lobby-model-open">配置 <b>{spectatorPanelOpen ? "↑" : "↓"}</b></span>
                        </span>
                      </button>
                      <div className="lobby-model-tools">
                        <button type="button" className={`lobby-model-reasoning-toggle ${settings.maxReasoning ? "is-on" : ""}`} role="switch" aria-checked={settings.maxReasoning} aria-label={`深度思考，当前为${settings.maxReasoning ? "极致" : "充分"}`} onClick={() => onSetting("maxReasoning", !settings.maxReasoning)}>
                          <b>深度思考</b><i />
                        </button>
                      </div>
                    </div>
                    {spectatorPanelOpen && (spectatorEditing ? (
                      <div className="lobby-model-popover spectator-popover" role="listbox" aria-label={`选择${editingSeat ? editingSeat.name : "全部席位"}使用的模型`}>
                        <div className="lobby-model-popover-head">
                          <button type="button" className="spectator-popover-back" onClick={() => setSpectatorEditing(null)} aria-label="返回席位列表">←</button>
                          <strong>{editingSeat ? `${editingSeat.name} 使用的模型` : `全部 ${settings.playerCount} 席使用的模型`}</strong>
                          <small>选择后自动检测</small>
                        </div>
                        <ModelChoiceOptions
                          choices={spectatorChoices}
                          value={editingSeat ? settings.spectatorProviders[editingSeat.id] || "local" : settings.spectatorProvider}
                          onPick={(id) => {
                            if (editingSeat) onSetting("spectatorProviders", { ...settings.spectatorProviders, [editingSeat.id]: id });
                            else onSetting("spectatorProvider", id);
                            setSpectatorEditing(null);
                            void onTestProvider(id);
                          }}
                        />
                        {availableModels.length === 0 && <p>本地尚未识别到可用模型，请编辑 .env.local 后重启服务。</p>}
                      </div>
                    ) : (
                      <div className="lobby-model-popover spectator-popover" role="dialog" aria-label="配置观战席位使用的 AI">
                        <div className="lobby-model-popover-head">
                          <strong>席位 AI 来源</strong>
                          <button
                            type="button" className="spectator-retest" disabled={!spectatorProviderIds.length || spectatorTesting}
                            onClick={() => spectatorProviderIds.forEach((id) => void onTestProvider(id))}
                          >{spectatorTesting ? "检测中…" : "检测连接"}</button>
                        </div>
                        <div className="segment-control spectator-mode-switch">
                          <button className={settings.spectatorAiMode === "shared" ? "active" : ""} onClick={() => onSetting("spectatorAiMode", "shared")}>统一一个 AI</button>
                          <button className={settings.spectatorAiMode === "individual" ? "active" : ""} onClick={() => onSetting("spectatorAiMode", "individual")}>每席单独配置</button>
                        </div>
                        <div className={`spectator-seat-list ${settings.spectatorAiMode === "shared" ? "is-single" : ""}`}>
                          {settings.spectatorAiMode === "shared" ? (
                            <button type="button" className="spectator-seat-row" onClick={() => setSpectatorEditing("shared")} title={seatTestLabel(settings.spectatorProvider)}>
                              <span><i>全</i>全部 {settings.playerCount} 席</span>
                              <b className="spectator-seat-value">
                                <em className={`spectator-seat-dot ${seatTestTone(settings.spectatorProvider)}`} aria-hidden="true" />
                                <span>{spectatorSharedProvider}</span>
                              </b>
                            </button>
                          ) : spectatorSeats.map((seat) => (
                            <button type="button" className="spectator-seat-row" key={seat.id} onClick={() => setSpectatorEditing(seat.id)} title={seatTestLabel(settings.spectatorProviders[seat.id] || "local")}>
                              <span><i>{seat.avatar}</i>{seat.name}</span>
                              <b className="spectator-seat-value">
                                <em className={`spectator-seat-dot ${seatTestTone(settings.spectatorProviders[seat.id] || "local")}`} aria-hidden="true" />
                                <span>{modelDisplayName(settings.spectatorProviders[seat.id] || "local", modelOptions)}</span>
                              </b>
                            </button>
                          ))}
                        </div>
                        <p className={`lobby-model-popover-status ${spectatorTone}`} role="status" aria-live="polite">{spectatorStatusText}</p>
                      </div>
                    ))}
                  </div>
                ) : settings.gameMode === "online" ? (
                  <div className="lobby-model-card lobby-online-info-card">
                    <div className="lobby-model-entry">
                      <span className="lobby-model-symbol">联</span>
                      <span className="lobby-model-copy"><strong>私人好友房</strong><small>六位房间码 · 游客身份 · 断线可恢复</small></span>
                      <span className="lobby-model-actions"><em className="model-status ready">可用</em><span className="lobby-model-open">实时</span></span>
                    </div>
                    <div className="lobby-model-tools"><span className="lobby-online-security">服务端洗牌 · 隐藏底牌 · 虚拟筹码</span></div>
                  </div>
                ) : <div className={`lobby-model-picker ${modelPanelOpen ? "is-open" : ""}`} ref={modelPickerRef}>
                  <div className="lobby-model-card">
                    <button type="button" className="lobby-model-entry" aria-haspopup="listbox" aria-expanded={modelPanelOpen} onClick={() => setModelPanelOpen((value) => !value)}>
                      <span className="lobby-model-symbol">AI</span>
                      <span className="lobby-model-copy"><strong>模型对手</strong><small>{modelDetail}</small></span>
                      <span className="lobby-model-actions">
                        <em className={`model-status ${modelStatus.tone}`}>{modelCardStatus}</em>
                        <span className="lobby-model-open">更换 <b>{modelPanelOpen ? "↑" : "↓"}</b></span>
                      </span>
                    </button>
                    <div className="lobby-model-tools">
                      <button type="button" className={`lobby-model-reasoning-toggle ${settings.maxReasoning ? "is-on" : ""}`} role="switch" aria-checked={settings.maxReasoning} aria-label={`深度思考，当前为${settings.maxReasoning ? "极致" : "充分"}`} onClick={() => onSetting("maxReasoning", !settings.maxReasoning)}>
                        <b>深度思考</b><i />
                      </button>
                    </div>
                  </div>
                  {modelPanelOpen && (
                    <div className="lobby-model-popover" role="listbox" aria-label="选择可用模型">
                      <div className="lobby-model-popover-head"><strong>本场决策模型</strong><small>选择后自动检测连接</small></div>
                      <ModelChoiceOptions
                        choices={[{ ...localChoice, model: "无需网络，始终可用" }, ...availableModels]}
                        value={settings.modelAiEnabled ? settings.modelProvider : "local"}
                        onPick={(id) => void chooseModel(id === "local" ? null : id)}
                      />
                      {!availableModels.length && <p>本地尚未识别到可用模型，请编辑 .env.local 后重启服务。</p>}
                      {availableModels.length > 0 && <p className={`lobby-model-popover-status ${modelStatus.tone}`} role="status" aria-live="polite">{testingModel ? "正在验证本地配置与模型响应…" : modelStatus.text}</p>}
                    </div>
                  )}
                </div>}
              </div>
            </div>
          </section>
          <div className="lobby-footer">
            <div className="lobby-outside-meta">
              {settings.gameMode === "local" && savedSession && (
                <div className="saved-session-card">
                  <span><small>上次对局</small><strong>第 {savedSession.game.handNo} 手牌</strong></span>
                  <span><small>你的筹码</small><strong>{formatChips(savedSession.game.players.find((player) => player.isHuman)?.chips || 0)}</strong></span>
                  <button onClick={onResume}>继续</button>
                </div>
              )}
              <div className="lobby-selection-line" aria-label="当前选择">
                <span>当前选择</span><b>{gameModeLabel(settings.gameMode)}</b><i /><b>{settings.playerCount} {settings.gameMode === "spectator" ? "席" : "人"}</b><i /><b>{timeLabel}</b><i /><b>{settings.gameMode === "online"
                  ? "私人好友房"
                  : settings.gameMode === "spectator"
                    ? settings.spectatorAiMode === "shared" ? `全席 ${spectatorSharedProvider}` : "逐席位配置"
                    : settings.modelAiEnabled ? provider.name : `本地 AI · ${settings.maxReasoning ? "极致" : "充分"}`}</b>
              </div>
              {settings.gameMode === "local" ? <div className="lobby-history" aria-label="本机历史记录">
                <span>本机记录</span><b>{stats.hands} 手牌</b><i /><b>{winRate}% 胜率</b><i /><b>最大 {formatChips(stats.biggestPot)}</b>
              </div> : settings.gameMode === "spectator" ? <div className="lobby-history" aria-label="观战说明">
                <span>观战功能</span><b>可暂停 / 继续</b><i /><b>全程亮牌可关闭</b><i /><b>每席一个 skill</b>
              </div> : <div className="lobby-history" aria-label="联机保护"><span>联机保护</span><b>服务端发牌</b><i /><b>行动校验</b><i /><b>断线恢复</b></div>}
            </div>
            <div className="lobby-launch">
              <button className="primary-button lobby-start" onClick={onStart}>{settings.gameMode === "online" ? "进入联机大厅" : savedSession ? "开始新对局" : "确认并开始对局"} <span>→</span></button>
              <p className="start-note">{settings.gameMode === "online" ? "进入后创建房间或输入房间码" : "点击后才会洗牌并创建第 1 手牌"}</p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="toggle-row">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <button type="button" className="toggle-switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><i aria-hidden="true" /></button>
    </div>
  );
}
