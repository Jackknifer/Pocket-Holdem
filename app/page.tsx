"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyAction, chooseAiAction, evaluateBest, formatChips, getPot, legalRaiseBounds,
  newSession, phaseLabel, preflopLabel, rankLabel, startNextHand, suitSymbol,
  type Card, type Difficulty, type GameAction, type GameState, type Player,
} from "./game";

type Settings = {
  difficulty: Difficulty;
  sound: boolean;
  autoNext: boolean;
  hints: boolean;
};

type Stats = {
  hands: number;
  wins: number;
  biggestPot: number;
  streak: number;
  bestStreak: number;
};

const DEFAULT_SETTINGS: Settings = { difficulty: "standard", sound: true, autoNext: false, hints: true };
const DEFAULT_STATS: Stats = { hands: 0, wins: 0, biggestPot: 0, streak: 0, bestStreak: 0 };

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
  const glyph = { sound: "◖", mute: "—", settings: "•••", help: "?", history: "↗", close: "×" }[name];
  return <span aria-hidden="true">{glyph}</span>;
}

function Seat({ player, index, game }: { player: Player; index: number; game: GameState }) {
  const isActive = game.status === "playing" && game.currentPlayer === index;
  const showCards = game.phase === "showdown" && !player.folded;
  const winner = game.winners.some((group) => group.ids.includes(player.id));
  const seatName = player.isHuman ? "seat-you" : `seat-${player.id}`;
  const stateText = player.folded ? "已弃牌" : player.allIn ? "全下" : player.chips <= 0 ? "已出局" : "";

  return (
    <div className={`seat ${seatName} ${isActive ? "seat-active" : ""} ${player.folded ? "seat-folded" : ""} ${winner ? "seat-winner" : ""}`}>
      {!player.isHuman && (
        <div className="opponent-cards" aria-label={`${player.name} 的手牌`}>
          <CardView card={showCards ? player.hole[0] : undefined} hidden={!showCards && player.hole.length > 0} small delay={80} />
          <CardView card={showCards ? player.hole[1] : undefined} hidden={!showCards && player.hole.length > 0} small delay={150} />
        </div>
      )}
      <div className="seat-profile">
        <span className="seat-avatar">{player.avatar}</span>
        <span className="seat-copy">
          <strong>{player.name}{index === game.dealer && <em className="dealer-dot">D</em>}</strong>
          <small>{stateText || formatChips(player.chips)}</small>
        </span>
        {isActive && <span className="thinking"><i /><i /><i /></span>}
      </div>
      {player.bet > 0 && <span className="bet-tag">{formatChips(player.bet)}</span>}
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
  const [showIntro, setShowIntro] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const recordedHand = useRef(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      let nextSettings = DEFAULT_SETTINGS;
      let nextStats = DEFAULT_STATS;
      try {
        const storedSettings = localStorage.getItem("pocket-settings");
        const storedStats = localStorage.getItem("pocket-stats");
        if (storedSettings) nextSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(storedSettings) };
        if (storedStats) nextStats = { ...DEFAULT_STATS, ...JSON.parse(storedStats) };
      } catch { /* Invalid local data falls back to safe defaults. */ }
      setSettings(nextSettings);
      setStats(nextStats);
      setShowIntro(!localStorage.getItem("pocket-welcomed"));
      setGame(newSession(nextSettings.difficulty));
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => { if (hydrated) localStorage.setItem("pocket-settings", JSON.stringify(settings)); }, [settings, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem("pocket-stats", JSON.stringify(stats)); }, [stats, hydrated]);

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
    const wait = 560 + Math.random() * 700;
    const timeout = window.setTimeout(() => {
      setGame((current) => {
        if (!current || current.status !== "playing") return current;
        const actor = current.players[current.currentPlayer];
        if (!actor || actor.isHuman) return current;
        return applyAction(current, actor.id, chooseAiAction(current, actor));
      });
    }, wait);
    return () => window.clearTimeout(timeout);
  }, [game]);

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
      if (panel || showIntro || !isHumanTurn || event.repeat) return;
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
  }, [act, bounds.max, defaultRaise, game, isHumanTurn, panel, showIntro, showRaise]);

  const hint = useMemo(() => {
    if (!game || !human || !settings.hints) return "";
    const category = game.community.length >= 3 ? evaluateBest([...human.hole, ...game.community]).score[0] : -1;
    if (due === 0) return category >= 2 ? "牌力领先，可以主动施压" : "无需投入筹码，可以免费看牌";
    if (category >= 3) return "强牌，可以考虑加注扩大底池";
    if (due <= Math.max(game.bigBlind, pot * 0.18)) return "跟注成本较低，继续观察也合理";
    return "对手给出较大压力，留意底池赔率";
  }, [game, human, settings.hints, due, pot]);

  const startFresh = (difficulty = settings.difficulty) => {
    setGame(newSession(difficulty));
    setPanel(null); setShowRaise(false); recordedHand.current = 0;
  };

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "difficulty") setGame((current) => current ? { ...current, difficulty: value as Difficulty } : current);
  };

  if (!game || !human) {
    return <main className="loading-screen"><span className="brand-mark">P</span><p>正在整理牌桌…</p></main>;
  }

  const sessionTotal = game.players.reduce((sum, player) => sum + player.chips + player.totalBet, 0);
  const humanShare = sessionTotal ? Math.round((human.chips / sessionTotal) * 100) : 0;
  const mainWinner = game.winners[0];

  return (
    <main className="game-shell">
      <header className="topbar">
        <button className="brand bare-button" onClick={() => setPanel("stats")} aria-label="打开对局数据">
          <span className="brand-mark">P</span><span className="brand-word">POCKET</span>
        </button>
        <div className="round-meta">
          <span>第 {game.handNo} 手牌</span><i />
          <span>{phaseLabel(game.phase)}</span><i />
          <span>盲注 {game.smallBlind} / {game.bigBlind}</span>
        </div>
        <div className="top-actions">
          <button className="icon-button" onClick={() => updateSetting("sound", !settings.sound)} aria-label={settings.sound ? "关闭声音" : "开启声音"}><TinyIcon name={settings.sound ? "sound" : "mute"} /></button>
          <button className="icon-button" onClick={() => setPanel("help")} aria-label="玩法帮助"><TinyIcon name="help" /></button>
          <button className="icon-button" onClick={() => setPanel("settings")} aria-label="游戏设置"><TinyIcon name="settings" /></button>
        </div>
      </header>

      <section className="workspace">
        <aside className="session-rail" aria-label="本场进度">
          <div><small>你的筹码</small><strong>{formatChips(human.chips)}</strong></div>
          <div className="stack-meter"><span style={{ width: `${humanShare}%` }} /></div>
          <p>占场上筹码 {humanShare}%</p>
          <button className="text-button" onClick={() => setLogOpen((value) => !value)}><TinyIcon name="history" /> 行动记录</button>
        </aside>

        <section className="table-stage" aria-label="德州扑克牌桌">
          <div className="table-grid" />
          {game.players.map((player, index) => <Seat key={player.id} player={player} index={index} game={game} />)}

          <div className="board">
            <div className="pot-line"><span>当前底池</span><strong>{formatChips(pot || game.lastPot)}</strong></div>
            <div className="community-cards" aria-label="公共牌">
              {Array.from({ length: 5 }, (_, index) => <CardView key={index} card={game.community[index]} delay={index * 90} />)}
            </div>
            <span className="phase-pill">{phaseLabel(game.phase)}</span>
          </div>

          <div className="hero-hand" aria-label="你的手牌">
            <div className="hero-cards">
              <CardView card={human.hole[0]} delay={40} />
              <CardView card={human.hole[1]} delay={120} />
            </div>
            <div className="hand-readout"><small>当前牌型</small><strong>{handLabel}</strong></div>
          </div>

          {game.status === "handOver" && (
            <div className="result-card" role="status">
              <span className="result-kicker">本手结束</span>
              <h2>{game.message}</h2>
              <p>{mainWinner ? `${mainWinner.label} · 底池 ${formatChips(game.lastPot)}` : "底池已结算"}</p>
              <button className="primary-button" onClick={() => setGame((current) => current ? startNextHand(current) : current)}>下一手牌 <span>↵</span></button>
            </div>
          )}

          {game.status === "gameOver" && (
            <div className="result-card" role="status">
              <span className="result-kicker">对局结束</span>
              <h2>{game.message}</h2>
              <p>共完成 {stats.hands} 手牌，胜率 {stats.hands ? Math.round(stats.wins / stats.hands * 100) : 0}%</p>
              <button className="primary-button" onClick={() => startFresh()}>重新开始</button>
            </div>
          )}
        </section>

        <aside className={`activity-panel ${logOpen ? "is-open" : ""}`} aria-label="行动记录">
          <div className="panel-head"><strong>本手记录</strong><button className="bare-button" onClick={() => setLogOpen(false)} aria-label="关闭记录"><TinyIcon name="close" /></button></div>
          <div className="log-list">
            {game.log.map((entry) => <p key={entry.id} className={entry.tone === "strong" ? "strong" : ""}>{entry.text}</p>)}
          </div>
        </aside>
      </section>

      <section className={`control-dock ${!isHumanTurn ? "dock-waiting" : ""}`} aria-label="行动控制">
        <div className="turn-status">
          <span className="timer-ring" style={{ "--progress": `${timer / 24 * 360}deg` } as React.CSSProperties}><i>{isHumanTurn ? timer : "·"}</i></span>
          <div><small>{isHumanTurn ? "轮到你了" : game.status === "playing" ? `${game.players[game.currentPlayer]?.name || "对手"} 正在思考` : "牌局已暂停"}</small><strong>{isHumanTurn ? handLabel : game.message}</strong></div>
        </div>

        {isHumanTurn && settings.hints && <p className="inline-hint">{hint}</p>}

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
                <div className="setting-group"><span className="setting-label">对手强度</span><div className="segment-control">
                  {(["relaxed", "standard", "sharp"] as Difficulty[]).map((value) => <button key={value} className={settings.difficulty === value ? "active" : ""} onClick={() => updateSetting("difficulty", value)}>{{ relaxed: "轻松", standard: "标准", sharp: "敏锐" }[value]}</button>)}
                </div><small>会影响对手的判断、诈唬频率和随机性。</small></div>
                <Toggle label="行动提示" detail="在你的回合显示简短的局面提醒" checked={settings.hints} onChange={(value) => updateSetting("hints", value)} />
                <Toggle label="自动下一手" detail="结算后自动继续，无需点击" checked={settings.autoNext} onChange={(value) => updateSetting("autoNext", value)} />
                <Toggle label="界面音效" detail="仅保留轻微的点击与结算提示" checked={settings.sound} onChange={(value) => updateSetting("sound", value)} />
                <button className="danger-link" onClick={() => startFresh()}>开始一场新对局</button>
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

      {showIntro && (
        <div className="modal-layer intro-layer">
          <section className="intro-card" role="dialog" aria-modal="true" aria-labelledby="intro-title">
            <span className="intro-mark">P</span>
            <span className="modal-kicker">单机德州扑克</span>
            <h1 id="intro-title">安静地，打一手好牌。</h1>
            <p>四人锦标赛，完整规则，三个有不同风格的对手。没有赌场噪音，只有判断与选择。</p>
            <div className="intro-details"><span>初始筹码 2,000</span><i /><span>盲注 10 / 20</span><i /><span>本地保存</span></div>
            <button className="primary-button intro-start" onClick={() => { localStorage.setItem("pocket-welcomed", "1"); setShowIntro(false); }}>开始第一手牌 <span>→</span></button>
          </section>
        </div>
      )}
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
