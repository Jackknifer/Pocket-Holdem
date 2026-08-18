"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyAction, chooseAiAction, estimateEquity, evaluateBest, formatChips, getBlindProgress, getPot, legalRaiseBounds,
  newSession, phaseLabel, preflopLabel, rankLabel, startNextHand, suitSymbol,
  type Card, type Difficulty, type GameAction, type GameState, type Player,
} from "./game";
import { OPPONENT_SKILLS } from "./ai-skills";

type Settings = {
  difficulty: Difficulty;
  playerCount: PlayerCount;
  aiPace: AiPace;
  modelAiEnabled: boolean;
  modelProvider: string;
  sound: boolean;
  autoNext: boolean;
  reviewMode: ReviewMode;
};

type PlayerCount = 2 | 3 | 4 | 5 | 6;
type AiPace = "calm" | "natural" | "quick";
type ReviewMode = "training" | "standard";
type ModelStatus = { tone: "idle" | "working" | "ready" | "fallback"; text: string };
type ModelUsage = { input: number; output: number; total: number };
type ModelDecision = {
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
  usage?: ModelUsage | null;
  output?: string;
  assessment?: string;
  factors?: string[];
  skillApplication?: string;
  confidence?: number | null;
};
type ModelActionResult = ModelDecision & { action: GameAction; provider: string; model: string; note: string };
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
const DEFAULT_SETTINGS: Settings = {
  difficulty: "standard", playerCount: 4, aiPace: "calm", modelAiEnabled: false,
  modelProvider: "openai",
  sound: true, autoNext: false, reviewMode: "training",
};
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
  legalActions: { fold: true, checkCall: true, allIn: true, raise: true, minRaiseTo: 40, maxRaiseTo: 2000 },
};

function cardCode(card: Card): string {
  return `${rankLabel[card.rank]}${suitSymbol[card.suit]}`;
}

function buildModelContext(game: GameState, player: Player) {
  const due = Math.max(0, game.currentBet - player.bet);
  const bounds = legalRaiseBounds(game, player);
  const pot = getPot(game);
  const hand = game.community.length >= 3 ? evaluateBest([...player.hole, ...game.community]).label : preflopLabel(player.hole);
  const skill = OPPONENT_SKILLS[player.id];
  return {
    role: { name: player.name, personality: player.note, aggression: player.aggression, skill },
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
    legalActions: {
      fold: due > 0, checkCall: true, allIn: player.chips > 0,
      raise: bounds.max > game.currentBet, minRaiseTo: bounds.min, maxRaiseTo: bounds.max,
    },
  };
}

function normalizeModelAction(game: GameState, player: Player, decision: ModelDecision): GameAction | null {
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

function aiDecisionDelay(game: GameState, player: Player, pace: AiPace): number {
  const ranges: Record<AiPace, [number, number]> = {
    calm: [5_500, 4_500],
    natural: [3_500, 3_500],
    quick: [1_800, 2_200],
  };
  const [base, spread] = ranges[pace];
  const due = Math.max(0, game.currentBet - player.bet);
  const pot = Math.max(1, getPot(game));
  const isComplex = game.phase !== "preflop" || due >= game.bigBlind * 3 || due / (pot + due) >= 0.24;
  const complexityTime = isComplex ? 900 + Math.random() * 1_400 : 0;
  const shortStackAdjustment = player.chips <= game.bigBlind * 10 ? -600 : 0;
  return Math.max(1_400, Math.round(base + Math.random() * spread + complexityTime + shortStackAdjustment));
}

async function requestModelDecision(provider: string, context: unknown, signal: AbortSignal): Promise<ModelDecision> {
  const response = await fetch("/api/ai-decision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, context }),
    signal,
  });
  const payload = await response.json().catch(() => ({})) as ModelDecision & { error?: string };
  if (!response.ok) throw new Error(payload.error || "模型请求失败");
  return payload;
}

async function requestModelAction(game: GameState, player: Player, provider: string, signal: AbortSignal): Promise<ModelActionResult> {
  const payload = await requestModelDecision(provider, buildModelContext(game, player), signal);
  const action = normalizeModelAction(game, player, payload);
  if (!action) throw new Error("模型返回的动作无法执行");
  return {
    ...payload,
    action,
    provider: payload.provider || provider,
    model: payload.model || "未返回模型名",
    note: payload.note?.slice(0, 100) || "",
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

function Seat({ player, index, game, modelThinking }: { player: Player; index: number; game: GameState; modelThinking: boolean }) {
  const isActive = game.status === "playing" && game.currentPlayer === index;
  const showCards = game.phase === "showdown" && !player.folded;
  const winner = game.winners.some((group) => group.ids.includes(player.id));
  const seatName = player.isHuman ? "seat-you" : `seat-${player.id}`;
  const stateText = player.folded ? "已弃牌" : player.allIn ? "全下" : player.chips <= 0 ? "已出局" : "";
  const placement = SEAT_PLACEMENTS[game.players.length]?.[index] || SEAT_PLACEMENTS[4][index];

  return (
    <div
      className={`seat ${seatName} seat-side-${placement.side} ${isActive ? "seat-active" : ""} ${player.folded ? "seat-folded" : ""} ${winner ? "seat-winner" : ""}`}
      style={{ "--seat-x": `${placement.x}%`, "--seat-y": `${placement.y}%` } as React.CSSProperties}
    >
      {!player.isHuman && (
        <div className="opponent-cards" aria-label={`${player.name} 的手牌`}>
          <CardView card={showCards ? player.hole[0] : undefined} hidden={!showCards && player.hole.length > 0} small delay={80} />
          <CardView card={showCards ? player.hole[1] : undefined} hidden={!showCards && player.hole.length > 0} small delay={150} />
        </div>
      )}
      {isActive && <span className={`seat-turn-label ${player.isHuman ? "is-you" : ""}`}>{player.isHuman ? "你的回合" : modelThinking ? "模型思考中" : "正在行动"}</span>}
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
  const [timer, setTimer] = useState(24);
  const [raiseTo, setRaiseTo] = useState(40);
  const [showRaise, setShowRaise] = useState(false);
  const [panel, setPanel] = useState<"settings" | "help" | "stats" | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [savedSession, setSavedSession] = useState<SavedSession | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);
  const [testingModel, setTestingModel] = useState(false);
  const [modelThinkingId, setModelThinkingId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus>({ tone: "idle", text: "正在读取本地模型配置" });
  const [modelAudit, setModelAudit] = useState<ModelAuditEntry[]>([]);
  const recordedHand = useRef(0);

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
            difficulty: ["relaxed", "standard", "sharp"].includes(String(parsedSettings.difficulty)) ? parsedSettings.difficulty as Difficulty : DEFAULT_SETTINGS.difficulty,
            playerCount: [2, 3, 4, 5, 6].includes(Number(parsedSettings.playerCount)) ? parsedSettings.playerCount as PlayerCount : DEFAULT_SETTINGS.playerCount,
            aiPace: ["calm", "natural", "quick"].includes(String(parsedSettings.aiPace)) ? parsedSettings.aiPace as AiPace : DEFAULT_SETTINGS.aiPace,
            modelAiEnabled: Boolean(parsedSettings.modelAiEnabled),
            modelProvider: typeof parsedSettings.modelProvider === "string" ? parsedSettings.modelProvider : DEFAULT_SETTINGS.modelProvider,
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
          return selected ? { ...current, modelProvider: selected.id } : { ...current, modelAiEnabled: false };
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
    if (!hydrated || !game) return;
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
  const isHumanTurn = Boolean(game && human && game.status === "playing" && game.players[game.currentPlayer]?.isHuman);
  const due = game && human ? Math.max(0, game.currentBet - human.bet) : 0;
  const bounds = game && human ? legalRaiseBounds(game, human) : { min: 0, max: 0 };
  const pot = game ? getPot(game) : 0;
  const defaultRaise = Math.max(bounds.min, Math.min(bounds.max, Math.round(Math.max(bounds.min, pot * 0.6) / 10) * 10));
  const handLabel = human
    ? game && game.community.length >= 3 ? evaluateBest([...human.hole, ...game.community]).label : preflopLabel(human.hole)
    : "等待发牌";

  const playTone = useCallback((kind: "soft" | "confirm" | "win") => {
    if (!settings.sound || typeof window === "undefined") return;
    try {
      const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = kind === "win" ? 520 : kind === "confirm" ? 360 : 240;
      gain.gain.setValueAtTime(0.035, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.12);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.13);
    } catch { /* Audio is optional. */ }
  }, [settings.sound]);

  useEffect(() => {
    if (isHumanTurn) playTone("confirm");
  }, [isHumanTurn, playTone]);

  const act = useCallback((action: GameAction) => {
    if (!game || !human || !isHumanTurn) return;
    playTone(action.type === "fold" ? "soft" : "confirm");
    setShowRaise(false);
    setGame((current) => current ? applyAction(current, human.id, action) : current);
  }, [game, human, isHumanTurn, playTone]);

  useEffect(() => {
    if (!game || game.status !== "playing" || game.currentPlayer < 0) return;
    const player = game.players[game.currentPlayer];
    if (player.isHuman) return;
    const wait = aiDecisionDelay(game, player, settings.aiPace);
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      const selectedModel = modelOptions.find((item) => item.id === settings.modelProvider);
      const useModel = settings.modelAiEnabled && Boolean(selectedModel?.configured);
      let action: GameAction | null = null;
      let auditId = "";
      let fallbackDetail = "";
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
          const result = await requestModelAction(game, player, settings.modelProvider, controller.signal);
          action = result.action;
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
            output: result.output,
            completedAt: Date.now(),
          });
          if (!cancelled) setModelStatus({ tone: "ready", text: `${player.name} 已使用 ${providerName} 完成决策` });
        } catch (error) {
          fallbackDetail = controller.signal.aborted ? "请求已取消" : safeModelError(error);
          if (cancelled) updateModelAudit(auditId, { status: "fallback", detail: fallbackDetail });
          if (!cancelled) setModelStatus({ tone: "fallback", text: `${player.name}：${fallbackDetail}` });
        } finally {
          if (!cancelled) setModelThinkingId(null);
        }
      }
      if (cancelled) return;
      if (!action) {
        action = chooseAiAction(game, player);
        if (auditId) updateModelAudit(auditId, {
          status: "fallback", action: `本地 AI · ${describeModelAction(action, game, player)}`,
          detail: fallbackDetail || "模型未返回可执行动作", completedAt: Date.now(),
        });
      }
      setGame((current) => {
        if (!current || current.status !== "playing" || current.handNo !== game.handNo) return current;
        const actor = current.players[current.currentPlayer];
        if (!actor || actor.id !== player.id || actor.isHuman) return current;
        return applyAction(current, actor.id, action!);
      });
    }, wait);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [game, settings.aiPace, settings.modelAiEnabled, settings.modelProvider, modelOptions, addModelAudit, updateModelAudit]);

  useEffect(() => {
    const reset = window.setTimeout(() => setTimer(24), 0);
    if (!isHumanTurn) return () => window.clearTimeout(reset);
    const interval = window.setInterval(() => setTimer((value) => Math.max(0, value - 1)), 1000);
    return () => { window.clearTimeout(reset); window.clearInterval(interval); };
  }, [game?.currentPlayer, game?.handNo, game?.phase, isHumanTurn]);

  useEffect(() => {
    if (timer !== 0 || !game || !human || !isHumanTurn) return;
    const timeout = window.setTimeout(() => act(due === 0 ? { type: "checkCall" } : { type: "fold" }), 0);
    return () => window.clearTimeout(timeout);
  }, [timer, game, human, isHumanTurn, due, act]);

  useEffect(() => {
    if (!game || game.status !== "handOver" || recordedHand.current === game.handNo) return;
    recordedHand.current = game.handNo;
    const won = game.winners.some((winner) => winner.ids.includes("you"));
    setStats((current) => {
      const streak = won ? current.streak + 1 : 0;
      return {
        hands: current.hands + 1, wins: current.wins + (won ? 1 : 0), biggestPot: Math.max(current.biggestPot, game.lastPot),
        streak, bestStreak: Math.max(current.bestStreak, streak),
      };
    });
    if (won) playTone("win");
  }, [game, playTone]);

  useEffect(() => {
    if (!settings.autoNext || !game || game.status !== "handOver") return;
    const timeout = window.setTimeout(() => setGame((current) => current ? startNextHand(current) : current), 2600);
    return () => window.clearTimeout(timeout);
  }, [settings.autoNext, game]);

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
    localStorage.removeItem("pocket-active-session");
    setSavedSession(null);
    setModelAudit([]);
    setGame(newSession(settings.difficulty, settings.playerCount));
    setPanel(null); setShowRaise(false); recordedHand.current = 0;
  };

  const returnToLobby = () => {
    localStorage.removeItem("pocket-active-session");
    setSavedSession(null);
    setModelAudit([]);
    setGame(null);
    setPanel(null); setLogOpen(false); setShowRaise(false); recordedHand.current = 0;
  };

  const resumeSession = () => {
    if (!savedSession) return;
    if (savedSession.game.status === "handOver") recordedHand.current = savedSession.game.handNo;
    setGame({ ...savedSession.game, difficulty: settings.difficulty });
    setSavedSession(null);
  };

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "difficulty") setGame((current) => current ? { ...current, difficulty: value as Difficulty } : current);
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
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), selected.id === "minimax" ? 125_000 : 70_000);
    setTestingModel(true);
    setModelStatus({ tone: "working", text: `正在连接 ${selected.name} · ${selected.model}` });
    try {
      const result = await requestModelDecision(selected.id, MODEL_TEST_CONTEXT, controller.signal);
      if (!["fold", "checkCall", "raise", "allIn"].includes(String(result.action))) throw new Error("模型返回的动作无效");
      setModelStatus({ tone: "ready", text: `连接成功 · ${result.model || selected.model}` });
    } catch (error) {
      setModelStatus({ tone: "fallback", text: `连接失败：${safeModelError(error)}` });
    } finally {
      window.clearTimeout(timeout);
      setTestingModel(false);
    }
  };

  if (!hydrated) {
    return <main className="loading-screen"><span className="brand-mark">P</span><p>正在整理牌桌…</p></main>;
  }

  if (!game) return <Lobby settings={settings} stats={stats} savedSession={savedSession} modelOptions={modelOptions} modelStatus={modelStatus} testingModel={testingModel} onSelectModel={selectModel} onSetting={updateSetting} onStart={startSession} onResume={resumeSession} />;

  if (!human) return <main className="loading-screen"><span className="brand-mark">P</span><p>正在整理牌桌…</p></main>;

  const sessionTotal = game.players.reduce((sum, player) => sum + player.chips + player.totalBet, 0);
  const humanShare = sessionTotal ? Math.round((human.chips / sessionTotal) * 100) : 0;
  const mainWinner = game.winners[0];
  const blindProgress = getBlindProgress(game);
  const actingPlayer = game.status === "playing" && game.currentPlayer >= 0 ? game.players[game.currentPlayer] : null;
  const winnerIds = new Set(game.winners.flatMap((group) => group.ids));
  const reviewPlayers = game.players.filter((player) => player.hole.length === 2 && (
    settings.reviewMode === "training" || player.isHuman || (game.phase === "showdown" && !player.folded)
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
            <small>第 {game.handNo} 手 · {phaseLabel(game.phase)} · {game.players.length} 人桌</small>
            <strong>{actingPlayer ? actingPlayer.isHuman ? "轮到你操作" : modelThinkingId === actingPlayer.id ? `${actingPlayer.name} 正在调用模型` : `轮到 ${actingPlayer.name} 操作` : game.message}</strong>
          </span>
          <i className="round-turn-pulse" />
        </div>
        <div className="top-actions">
          <button className="icon-button audit-button" onClick={() => setLogOpen((value) => !value)} aria-label="行动与模型调用记录"><TinyIcon name="history" />{modelAudit[0] && <i className={`audit-light ${modelAudit[0].status}`} />}</button>
          <button
            className={`icon-button sound-toggle ${settings.sound ? "is-on" : "is-muted"}`}
            onClick={() => updateSetting("sound", !settings.sound)}
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
          <div><small>你的筹码</small><strong>{formatChips(human.chips)}</strong></div>
          <div className="stack-meter"><span style={{ width: `${humanShare}%` }} /></div>
          <p>占场上筹码 {humanShare}%</p>
          <button className="text-button" onClick={() => setLogOpen((value) => !value)}><TinyIcon name="history" /> 行动与模型记录</button>
        </aside>

        <section className="table-stage" aria-label="德州扑克牌桌">
          <div className="table-grid" />
          {game.players.map((player, index) => <Seat key={player.id} player={player} index={index} game={game} modelThinking={modelThinkingId === player.id} />)}

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

          <div className="hero-hand" aria-label="你的手牌">
            <div className="hero-cards">
              <CardView card={human.hole[0]} delay={40} />
              <CardView card={human.hole[1]} delay={120} />
            </div>
            <div className="hand-readout"><small>当前牌型</small><strong>{handLabel}</strong></div>
          </div>

          {game.status === "handOver" && (
            <div className="result-card has-review" role="status">
              <span className="result-kicker">本手结束</span>
              <h2>{game.message}</h2>
              <p>{mainWinner ? `${mainWinner.label} · 底池 ${formatChips(game.lastPot)}` : "底池已结算"}</p>
              <section className="hand-review" aria-label="本手所有底牌复盘">
                <header><strong>本手底牌复盘</strong><small>{settings.reviewMode === "training" ? "训练复盘 · 展示全部底牌" : "标准亮牌 · 仅显示你的牌与摊牌玩家"}</small></header>
                <div className="hand-review-grid">
                  {reviewPlayers.map((player) => {
                    const label = game.community.length >= 3
                      ? evaluateBest([...player.hole, ...game.community]).label
                      : preflopLabel(player.hole);
                    return (
                      <article className={`${player.folded ? "folded" : ""} ${winnerIds.has(player.id) ? "winner" : ""}`} key={player.id}>
                        <span>{player.avatar}</span>
                        <div><strong>{player.name}</strong><b>{player.hole.map(cardCode).join("  ")}</b><small>{label} · {winnerIds.has(player.id) ? "赢得底池" : player.folded ? "已弃牌" : "参与摊牌"}</small></div>
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
              <p>共完成 {stats.hands} 手牌，胜率 {stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0}%</p>
              <button className="primary-button" onClick={returnToLobby}>准备新对局</button>
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

      <section className={`control-dock ${isHumanTurn ? "dock-your-turn" : "dock-waiting"}`} aria-label="行动控制">
        <div className="dock-context" aria-label="本手决策信息">
          <span className="timer-ring" style={{ "--progress": `${timer / 24 * 360}deg` } as React.CSSProperties}><i>{isHumanTurn ? timer : "·"}</i></span>
          <div>
            <small>{isHumanTurn ? `决策时间 · ${timer} 秒` : `第 ${game.handNo} 手 · ${phaseLabel(game.phase)}`}</small>
            <strong>{isHumanTurn ? `${handLabel} · ${due === 0 ? "可以过牌" : `待跟注 ${formatChips(Math.min(due, human.chips))}`}` : `${handLabel} · 筹码 ${formatChips(human.chips)}`}</strong>
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
            <button disabled={!isHumanTurn} className="action-button quiet" onClick={() => act({ type: "checkCall" })}>{due === 0 ? "过牌" : `跟注 ${formatChips(Math.min(due, human.chips))}`} <kbd>C</kbd></button>
            <button disabled={!isHumanTurn || bounds.max <= game.currentBet} className={`action-button dark ${showRaise ? "selected" : ""}`} onClick={() => { if (!showRaise) setRaiseTo(defaultRaise); setShowRaise((value) => !value); }}>加注 <kbd>R</kbd></button>
          </div>
        </div>
      </section>

      {panel && (
        <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setPanel(null)}>
          <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button className="modal-close" onClick={() => setPanel(null)} aria-label="关闭"><TinyIcon name="close" /></button>
            {panel === "settings" && (
              <>
                <span className="modal-kicker">偏好</span><h2 id="modal-title">游戏设置</h2>
                <div className="settings-section">
                  <div className="settings-section-title"><strong>对手</strong><small>牌局中仍可调整，下一次决策生效</small></div>
                  <div className="setting-group"><span className="setting-label">对手强度</span><div className="segment-control">
                    {(["relaxed", "standard", "sharp"] as Difficulty[]).map((value) => <button key={value} className={settings.difficulty === value ? "active" : ""} onClick={() => updateSetting("difficulty", value)}>{{ relaxed: "轻松", standard: "标准", sharp: "敏锐" }[value]}</button>)}
                  </div><small>影响本地 AI 的判断、诈唬与容错；模型对手仍遵循各自技能。</small></div>
                  <div className="setting-group modal-pace"><span className="setting-label">思考节奏</span><div className="segment-control">
                    {(["calm", "natural", "quick"] as AiPace[]).map((value) => <button key={value} className={settings.aiPace === value ? "active" : ""} onClick={() => updateSetting("aiPace", value)}>{{ calm: "比赛", natural: "自然", quick: "紧凑" }[value]}</button>)}
                  </div><small>{settings.aiPace === "calm" ? "约 5.5–11 秒，复杂局面会多思考片刻。" : settings.aiPace === "quick" ? "约 1.8–5 秒，仍保留行动停顿。" : "约 3.5–8 秒，接近常见线上节奏。"}</small></div>
                </div>
                <div className="settings-section">
                  <div className="settings-section-title"><strong>复盘</strong><small>只影响结算后的底牌展示</small></div>
                  <div className="setting-group"><span className="setting-label">亮牌方式</span><div className="segment-control">
                    {(["training", "standard"] as ReviewMode[]).map((value) => <button key={value} className={settings.reviewMode === value ? "active" : ""} onClick={() => updateSetting("reviewMode", value)}>{value === "training" ? "训练复盘" : "标准亮牌"}</button>)}
                  </div><small>{settings.reviewMode === "training" ? "结算后展示所有底牌，适合学习对手线路。" : "仅展示你的牌和进入摊牌的玩家，更接近正式牌桌。"}</small></div>
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
                <p className="privacy-note">数据只保存在你的浏览器中，不会上传。</p>
              </>
            )}
          </section>
        </div>
      )}

    </main>
  );
}

function Lobby({ settings, stats, savedSession, modelOptions, modelStatus, testingModel, onSelectModel, onSetting, onStart, onResume }: {
  settings: Settings;
  stats: Stats;
  savedSession: SavedSession | null;
  modelOptions: ModelOption[];
  modelStatus: ModelStatus;
  testingModel: boolean;
  onSelectModel: (providerId: string | null) => Promise<void>;
  onSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onStart: () => void;
  onResume: () => void;
}) {
  const winRate = stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0;
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const provider = modelOptions.find((item) => item.id === settings.modelProvider) || modelOptions[0] || DEFAULT_MODEL_OPTIONS[0];
  const availableModels = modelOptions.filter((item) => item.configured);
  const difficultyLabel = { relaxed: "轻松", standard: "标准", sharp: "敏锐" }[settings.difficulty];
  const paceLabel = { calm: "比赛", natural: "自然", quick: "紧凑" }[settings.aiPace];
  const modelDetail = settings.modelAiEnabled
    ? provider.configured ? `${provider.name} · ${provider.model}` : provider.hint
    : "当前使用本地策略，可从项目配置启用模型";
  useEffect(() => {
    if (!modelPanelOpen) return;
    const close = (event: PointerEvent) => {
      if (!modelPickerRef.current?.contains(event.target as Node)) setModelPanelOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [modelPanelOpen]);
  const chooseModel = async (providerId: string | null) => {
    if (!providerId) setModelPanelOpen(false);
    await onSelectModel(providerId);
  };
  return (
    <main className="lobby-shell">
      <header className="topbar lobby-topbar">
        <span className="brand"><span className="brand-mark">P</span><span className="brand-word">POCKET</span></span>
        <span className="lobby-status"><i /> 对局尚未开始</span>
        <div className="top-actions"><span className="local-badge">仅在本机运行</span></div>
      </header>
      <section className="lobby-main">
        <div className="lobby-page">
          <div className="lobby-intro">
            <div className="lobby-intro-copy">
              <span className="modal-kicker">POCKET / 本地牌局</span>
              <h1>安静地，打一手好牌。</h1>
              <p>确认本场偏好。只有点击开始后，牌局才会正式创建。</p>
            </div>
            <dl className="lobby-basics" aria-label="固定对局信息">
              <div><dt>模式</dt><dd>单机牌局</dd></div>
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
                  <span className="setting-label">对手强度</span>
                  <div className="segment-control">
                    {(["relaxed", "standard", "sharp"] as Difficulty[]).map((value) => (
                      <button key={value} className={settings.difficulty === value ? "active" : ""} onClick={() => onSetting("difficulty", value)}>
                        {{ relaxed: "轻松", standard: "标准", sharp: "敏锐" }[value]}
                      </button>
                    ))}
                  </div>
                  <small>{settings.difficulty === "relaxed" ? "波动更大，适合熟悉规则。" : settings.difficulty === "sharp" ? "判断稳定，也会克制诈唬。" : "判断与随机性平衡，推荐。"}</small>
                </div>
                <div className="setting-group lobby-control-card lobby-player-count">
                  <span className="setting-label">对局人数</span>
                  <div className="segment-control player-count-control">
                    {([2, 3, 4, 5, 6] as PlayerCount[]).map((value) => <button key={value} className={settings.playerCount === value ? "active" : ""} onClick={() => onSetting("playerCount", value)}>{value} 人</button>)}
                  </div>
                  <small>你与 {settings.playerCount - 1} 位风格不同的 AI 同桌。</small>
                </div>
                <div className="setting-group lobby-control-card">
                  <span className="setting-label">思考节奏</span>
                  <div className="segment-control">
                    {(["calm", "natural", "quick"] as AiPace[]).map((value) => <button key={value} className={settings.aiPace === value ? "active" : ""} onClick={() => onSetting("aiPace", value)}>{{ calm: "比赛", natural: "自然", quick: "紧凑" }[value]}</button>)}
                  </div>
                  <small>{settings.aiPace === "calm" ? "约 5.5–11 秒，更接近比赛。" : settings.aiPace === "quick" ? "约 1.8–5 秒，节奏更紧凑。" : "约 3.5–8 秒，自然线上节奏。"}</small>
                </div>
                <div className={`lobby-model-picker ${modelPanelOpen ? "is-open" : ""}`} ref={modelPickerRef}>
                  <button type="button" className="lobby-model-entry" aria-haspopup="listbox" aria-expanded={modelPanelOpen} onClick={() => setModelPanelOpen((value) => !value)}>
                    <span className="lobby-model-symbol">AI</span>
                    <span className="lobby-model-copy"><strong>模型对手</strong><small>{modelDetail}</small></span>
                    <em className={`model-status ${modelStatus.tone}`}>{testingModel ? "连接中" : settings.modelAiEnabled ? modelStatus.text : "本地 AI"}</em>
                    <span className="lobby-model-open">选择 <b>{modelPanelOpen ? "↑" : "↓"}</b></span>
                  </button>
                  {modelPanelOpen && (
                    <div className="lobby-model-popover" role="listbox" aria-label="选择可用模型">
                      <div className="lobby-model-popover-head"><strong>本场决策模型</strong><small>选择后自动检测连接</small></div>
                      <button type="button" role="option" aria-selected={!settings.modelAiEnabled} className={!settings.modelAiEnabled ? "selected" : ""} onClick={() => chooseModel(null)}>
                        <span className="model-choice-mark">P</span><span><b>本地 AI</b><small>无需网络，始终可用</small></span><i>✓</i>
                      </button>
                      {availableModels.map((item) => (
                        <button type="button" role="option" aria-selected={settings.modelAiEnabled && item.id === settings.modelProvider} className={settings.modelAiEnabled && item.id === settings.modelProvider ? "selected" : ""} key={item.id} onClick={() => chooseModel(item.id)}>
                          <span className="model-choice-mark">{item.name.slice(0, 1)}</span><span><b>{item.name}</b><small>{item.model}</small></span><i>✓</i>
                        </button>
                      ))}
                      {!availableModels.length && <p>本地尚未识别到可用模型，请编辑 .env.local 后重启服务。</p>}
                      {availableModels.length > 0 && <p className={`lobby-model-popover-status ${modelStatus.tone}`} role="status" aria-live="polite">{testingModel ? "正在验证本地配置与模型响应…" : modelStatus.text}</p>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>
          <div className="lobby-footer">
            <div className="lobby-outside-meta">
              {savedSession && (
                <div className="saved-session-card">
                  <span><small>上次对局</small><strong>第 {savedSession.game.handNo} 手牌</strong></span>
                  <span><small>你的筹码</small><strong>{formatChips(savedSession.game.players.find((player) => player.isHuman)?.chips || 0)}</strong></span>
                  <button onClick={onResume}>继续</button>
                </div>
              )}
              <div className="lobby-selection-line" aria-label="当前选择">
                <span>当前选择</span><b>{settings.playerCount} 人</b><i /><b>{difficultyLabel}</b><i /><b>{paceLabel}</b><i /><b>{settings.modelAiEnabled ? provider.name : "本地 AI"}</b>
              </div>
              <div className="lobby-history" aria-label="本机历史记录">
                <span>本机记录</span><b>{stats.hands} 手牌</b><i /><b>{winRate}% 胜率</b><i /><b>最大 {formatChips(stats.biggestPot)}</b>
              </div>
            </div>
            <div className="lobby-launch">
              <button className="primary-button lobby-start" onClick={onStart}>{savedSession ? "开始新对局" : "确认并开始对局"} <span>→</span></button>
              <p className="start-note">点击后才会洗牌并创建第 1 手牌</p>
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
