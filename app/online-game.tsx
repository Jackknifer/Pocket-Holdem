"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  evaluateBest, formatChips, getPot, legalRaiseBounds, phaseLabel, preflopLabel, rankLabel, suitSymbol,
  type Card, type GameAction, type GameState, type Player,
} from "./game";
import type { OnlineChatMessage, OnlineClientMessage, OnlineRoomSnapshot, OnlineSession } from "./online";

type TurnTime = 30 | 120 | 300;
type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";
export type OnlineModelOption = { id: string; name: string; model: string; configured: boolean };

const SESSION_KEY = "pocket-online-session";
const NAME_KEY = "pocket-online-name";

function cardCode(card: Card): string {
  return `${rankLabel[card.rank]}${suitSymbol[card.suit]}`;
}

function OnlineCard({ card, hidden = false, small = false }: { card?: Card; hidden?: boolean; small?: boolean }) {
  if (!card && !hidden) return <span className={`playing-card card-slot ${small ? "card-small" : ""}`} aria-hidden="true" />;
  if (hidden) return <span className={`playing-card card-back ${small ? "card-small" : ""}`} aria-label="暗牌"><span>P</span></span>;
  const red = card?.suit === "h" || card?.suit === "d";
  return <span className={`playing-card dealt ${red ? "card-red" : ""} ${small ? "card-small" : ""}`} aria-label={cardCode(card!)}><b>{rankLabel[card!.rank]}</b><i>{suitSymbol[card!.suit]}</i></span>;
}

type SeatSide = "top" | "left" | "right" | "bottom";
type SeatPlacement = { x: number; y: number; side: SeatSide };
const SEATS: Record<number, SeatPlacement[]> = {
  2: [{ x: 50, y: 91, side: "bottom" }, { x: 50, y: 10, side: "top" }],
  3: [{ x: 50, y: 91, side: "bottom" }, { x: 17, y: 31, side: "left" }, { x: 83, y: 31, side: "right" }],
  4: [{ x: 50, y: 91, side: "bottom" }, { x: 13, y: 49, side: "left" }, { x: 50, y: 10, side: "top" }, { x: 87, y: 49, side: "right" }],
  5: [{ x: 50, y: 91, side: "bottom" }, { x: 14, y: 63, side: "left" }, { x: 25, y: 18, side: "left" }, { x: 75, y: 18, side: "right" }, { x: 86, y: 63, side: "right" }],
  6: [{ x: 50, y: 91, side: "bottom" }, { x: 13, y: 64, side: "left" }, { x: 17, y: 23, side: "left" }, { x: 50, y: 9, side: "top" }, { x: 83, y: 23, side: "right" }, { x: 87, y: 64, side: "right" }],
};

function OnlineSeat({ player, index, game, connected, modelThinking }: { player: Player; index: number; game: GameState; connected: boolean; modelThinking: boolean }) {
  const active = game.status === "playing" && game.currentPlayer === index;
  const winner = game.winners.some((group) => group.ids.includes(player.id));
  const placement = SEATS[game.players.length]?.[index] || SEATS[4][index];
  const state = !connected ? "已断线" : player.folded ? "已弃牌" : player.allIn ? "全下" : player.chips <= 0 ? "已出局" : player.lastAction;
  return (
    <div className={`seat ${player.isHuman ? "seat-you" : `seat-online-${index}`} seat-side-${placement.side} ${active ? "seat-active" : ""} ${player.folded ? "seat-folded" : ""} ${winner ? "seat-winner" : ""}`} style={{ "--seat-x": `${placement.x}%`, "--seat-y": `${placement.y}%` } as React.CSSProperties}>
      {!player.isHuman && <div className="opponent-cards" aria-label={`${player.name} 的手牌`}><OnlineCard card={player.hole[0]} hidden={!player.hole[0]} small /><OnlineCard card={player.hole[1]} hidden={!player.hole[1]} small /></div>}
      {active && <span className={`seat-turn-label ${player.isHuman ? "is-you" : ""}`}>{player.isHuman ? "你的回合" : modelThinking ? "模型思考中" : "正在行动"}</span>}
      <div className="seat-profile">
        <span className="seat-avatar">{player.avatar}</span>
        <span className="seat-copy"><strong>{player.name}{index === game.dealer && <em className="dealer-dot">D</em>}</strong><small>{state || "等待行动"}</small></span>
        <span className="seat-stack"><small>剩余</small><b>{formatChips(player.chips)}</b></span>
        {active && <span className="thinking"><i /><i /><i /></span>}
      </div>
      {player.bet > 0 && <span className="bet-tag"><small>本轮投入</small><strong>{formatChips(player.bet)}</strong></span>}
    </div>
  );
}

function messageTime(createdAt: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(createdAt);
}

function OnlineChat({ messages, viewerId, onSend, onClose }: {
  messages: OnlineChatMessage[];
  viewerId: string;
  onSend: (text: string) => boolean;
  onClose?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (onSend(text)) setDraft("");
  };

  return (
    <section className="online-chat" aria-label="房间聊天">
      <header className="online-chat-head"><span><strong>房间聊天</strong><small>仅当前房间可见</small></span>{onClose && <button type="button" onClick={onClose} aria-label="关闭聊天">×</button>}</header>
      <div className="online-chat-list" ref={listRef} aria-live="polite">
        {!messages.length && <p className="online-chat-empty">还没有消息，和牌友打个招呼吧。</p>}
        {messages.map((message) => message.kind === "system" ? (
          <div className="online-chat-system" key={message.id}><span>{message.text}</span></div>
        ) : (
          <article className={message.senderId === viewerId ? "is-me" : ""} key={message.id}>
            <span className="online-chat-avatar">{message.avatar}</span>
            <div><small>{message.name} · {messageTime(message.createdAt)}</small><p>{message.text}</p></div>
          </article>
        ))}
      </div>
      <div className="online-chat-compose">
        <input value={draft} maxLength={120} placeholder="输入消息…" aria-label="聊天消息" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        <button type="button" disabled={!draft.trim()} onClick={submit}>发送</button>
      </div>
    </section>
  );
}

async function roomRequest(path: string, body: Record<string, unknown>): Promise<OnlineSession> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as Partial<OnlineSession> & { error?: string };
  if (!response.ok || !payload.roomCode || !payload.playerId || !payload.token) throw new Error(payload.error || "联机服务暂时不可用");
  return { roomCode: payload.roomCode, playerId: payload.playerId, token: payload.token };
}

export function OnlineExperience({ capacity, turnTime, modelOptions, selectedModel, maxReasoning, onExit }: {
  capacity: number;
  turnTime: TurnTime;
  modelOptions: OnlineModelOption[];
  selectedModel: string;
  maxReasoning: boolean;
  onExit: () => void;
}) {
  const [name, setName] = useState(() => typeof window === "undefined" ? "" : localStorage.getItem(NAME_KEY) || "");
  const [joinCode, setJoinCode] = useState("");
  const [session, setSession] = useState<OnlineSession | null>(() => {
    if (typeof window === "undefined") return null;
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as OnlineSession | null; }
    catch { return null; }
  });
  const [snapshot, setSnapshot] = useState<OnlineRoomSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(session ? "connecting" : "offline");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showRaise, setShowRaise] = useState(false);
  const [raiseTo, setRaiseTo] = useState(40);
  const [now, setNow] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSeenCount, setChatSeenCount] = useState<number | null>(null);
  const [botCount, setBotCount] = useState(Math.min(1, capacity - 1));
  const configuredModels = modelOptions.filter((option) => option.configured);
  const [botModel, setBotModel] = useState(() => configuredModels.some((option) => option.id === selectedModel) ? selectedModel : configuredModels[0]?.id || "");

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let pollTimer: number | undefined;
    let failures = 0;
    const controller = new AbortController();
    const poll = async () => {
      if (disposed) return;
      try {
        const response = await fetch(`/api/online/rooms/${session.roomCode}/snapshot`, {
          headers: { authorization: `Bearer ${session.token}`, "x-pocket-player-id": session.playerId },
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({})) as { snapshot?: OnlineRoomSnapshot; error?: string };
        if (!response.ok || !payload.snapshot) throw new Error(payload.error || "房间状态暂时不可用");
        const recovered = failures > 0;
        failures = 0;
        setConnection("connected");
        if (recovered) setError("");
        setChatSeenCount((count) => count ?? payload.snapshot!.chat.length);
        setSnapshot(payload.snapshot);
      } catch (reason) {
        if (disposed || controller.signal.aborted) return;
        failures += 1;
        setConnection(failures > 6 ? "offline" : "reconnecting");
        if (failures > 6) setError(reason instanceof Error ? reason.message : "暂时无法恢复房间连接");
      }
      if (!disposed) pollTimer = window.setTimeout(poll, failures ? Math.min(5_000, 700 * failures) : 800);
    };
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [session]);

  useEffect(() => {
    if (!snapshot?.deadlineAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [snapshot?.deadlineAt]);

  const send = useCallback((message: OnlineClientMessage) => {
    if (!session || connection === "offline") {
      setError("正在恢复连接，请稍后再操作");
      return false;
    }
    void fetch(`/api/online/rooms/${session.roomCode}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.token}`,
        "x-pocket-player-id": session.playerId,
      },
      body: JSON.stringify(message),
      keepalive: message.type === "leave",
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { snapshot?: OnlineRoomSnapshot; error?: string };
      if (!response.ok) throw new Error(payload.error || "操作没有成功");
      if (payload.snapshot) setSnapshot(payload.snapshot);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "操作没有成功"));
    return true;
  }, [connection, session]);

  const sendChat = useCallback((text: string) => send({ type: "chat", messageId: crypto.randomUUID(), text }), [send]);

  const enter = async (kind: "create" | "join") => {
    const clean = name.trim();
    if (clean.length < 2) return setError("请输入 2–12 个字符的名字");
    if (kind === "join" && joinCode.length !== 6) return setError("请输入六位房间码");
    setBusy(true); setError("");
    try {
      const next = kind === "create"
        ? await roomRequest("/api/online/rooms", {
            name: clean, capacity, turnTime, botCount, modelProvider: botModel, maxReasoning,
          })
        : await roomRequest(`/api/online/rooms/${joinCode}/join`, { name: clean });
      localStorage.setItem(NAME_KEY, clean);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
      setSession(next);
      setConnection("connecting");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法进入房间");
    } finally { setBusy(false); }
  };

  const exitRoom = () => {
    if (snapshot?.status === "lobby") {
      send({ type: "leave" });
      sessionStorage.removeItem(SESSION_KEY);
    }
    setSession(null); setSnapshot(null); onExit();
  };

  if (!session) {
    return (
      <main className="online-shell">
        <header className="topbar online-topbar"><span className="brand"><span className="brand-mark">P</span><span className="brand-word">POCKET</span></span><span className="online-header-state"><i /> 私人联机房</span><button className="online-exit" onClick={onExit}>返回首页</button></header>
        <section className="online-entry">
          <div className="online-entry-copy"><span className="modal-kicker">POCKET / ONLINE</span><h1>和朋友，安静地打一桌。</h1><p>虚拟筹码牌局。房间状态、发牌和下注全部由服务端统一判定。</p></div>
          <section className="online-entry-card" aria-labelledby="online-entry-title">
            <div className="online-entry-head"><span><strong id="online-entry-title">进入私人牌桌</strong><small>{capacity} 人桌 · 每次行动最多 {turnTime} 秒</small></span><em>实时</em></div>
            <label className="online-field"><span>你的名字</span><input value={name} maxLength={12} autoComplete="nickname" placeholder="输入 2–12 个字符" onChange={(event) => setName(event.target.value)} /></label>
            <div className="online-ai-setup">
              <div className="online-ai-heading"><span><strong>AI 对手</strong><small>真人与 AI 可同桌</small></span><b>{botCount} 席</b></div>
              <div className="online-ai-count" aria-label="AI 席位数量">
                {Array.from({ length: capacity }, (_, count) => <button type="button" className={botCount === count ? "selected" : ""} key={count} onClick={() => setBotCount(count)}>{count}</button>)}
              </div>
              {botCount > 0 && <label className="online-model-select"><span>决策模型</span><select value={botModel} onChange={(event) => setBotModel(event.target.value)}><option value="">本机最高强度</option>{configuredModels.map((option) => <option value={option.id} key={option.id}>{option.name} · {option.model}</option>)}</select><small>{botModel ? `${maxReasoning ? "极致" : "标准"}思考 · 密钥仅在服务器使用` : "模型不可用时也会自动采用本机最高强度"}</small></label>}
            </div>
            <div className="online-room-actions">
              <button className="primary-button" disabled={busy} onClick={() => void enter("create")}>创建房间 <span>→</span></button>
              <div className="online-join-row"><input aria-label="六位房间码" value={joinCode} maxLength={6} placeholder="六位房间码" onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))} /><button disabled={busy} onClick={() => void enter("join")}>加入</button></div>
            </div>
            {error && <p className="online-error" role="alert">{error}</p>}
            <small className="online-entry-note">无需注册；刷新页面会自动恢复当前房间身份。</small>
          </section>
        </section>
      </main>
    );
  }

  if (!snapshot) {
    return <main className="loading-screen"><span className="brand-mark">P</span><p>{connection === "reconnecting" ? "正在恢复房间连接…" : "正在进入私人牌桌…"}</p>{error && <button className="text-button" onClick={exitRoom}>返回首页</button>}</main>;
  }

  if (!snapshot.game) {
    const me = snapshot.members.find((member) => member.id === snapshot.viewerId)!;
    const allReady = snapshot.members.length >= 2 && snapshot.members.every((member) => member.ready);
    return (
      <main className="online-shell">
        <header className="topbar online-topbar"><span className="brand"><span className="brand-mark">P</span><span className="brand-word">POCKET</span></span><span className={`online-header-state ${connection}`}><i />{connection === "connected" ? "房间已连接" : "正在恢复连接"}</span><button className="online-exit" onClick={exitRoom}>离开房间</button></header>
        <section className="online-room-wrap">
          <section className="online-room-card">
            <header className="online-room-head"><span><small>私人房间</small><strong>{snapshot.roomCode}</strong></span><button onClick={() => void navigator.clipboard?.writeText(snapshot.roomCode)}>复制房间码</button></header>
            <div className="online-room-summary"><span><small>席位</small><b>{snapshot.members.length} / {snapshot.capacity}</b></span><span><small>行动时限</small><b>{snapshot.turnTime} 秒</b></span><span><small>状态</small><b>{snapshot.message}</b></span></div>
            <div className="online-room-lower">
              <div className="online-member-grid" aria-label="房间玩家">
                {Array.from({ length: snapshot.capacity }, (_, index) => {
                  const member = snapshot.members.find((candidate) => candidate.seat === index);
                  return member ? <article className={`${member.ready ? "ready" : ""} ${member.isBot ? "is-bot" : ""}`} key={member.id}><span>{member.avatar}</span><div><strong>{member.name}{member.isHost ? " · 房主" : member.isBot ? " · AI" : ""}</strong><small>{member.isBot ? `${member.modelName || "本机最高强度"} · 已准备` : member.connected ? member.ready ? "已连接 · 已准备" : "已连接 · 未准备" : "连接已断开"}</small></div><i>{member.ready ? "✓" : index + 1}</i></article>
                    : <article className="empty" key={index}><span>{index + 1}</span><div><strong>等待加入</strong><small>分享上方房间码</small></div></article>;
                })}
              </div>
              <OnlineChat messages={snapshot.chat} viewerId={snapshot.viewerId} onSend={sendChat} />
            </div>
            {error && <p className="online-error" role="alert">{error}</p>}
            <footer className="online-room-footer">
              <button className={`online-ready-button ${me.ready ? "is-ready" : ""}`} onClick={() => send({ type: "ready", ready: !me.ready })}>{me.ready ? "取消准备" : "我已准备"}</button>
              {me.isHost ? <button className="primary-button" disabled={!allReady || connection !== "connected"} onClick={() => send({ type: "start" })}>开始发牌 <span>→</span></button> : <p>{allReady ? "等待房主开始发牌" : "所有玩家准备后开始"}</p>}
            </footer>
          </section>
        </section>
      </main>
    );
  }

  const game = snapshot.game;
  const human = game.players.find((player) => player.isHuman)!;
  const acting = game.status === "playing" ? game.players[game.currentPlayer] : null;
  const isHumanTurn = acting?.id === human.id;
  const due = Math.max(0, game.currentBet - human.bet);
  const bounds = legalRaiseBounds(game, human);
  const pot = getPot(game);
  const defaultRaise = Math.max(bounds.min, Math.min(bounds.max, Math.round(Math.max(bounds.min, pot * .6) / 10) * 10));
  const remaining = snapshot.deadlineAt ? now ? Math.max(0, Math.ceil((snapshot.deadlineAt - now) / 1000)) : snapshot.turnTime : 0;
  const handLabel = game.community.length >= 3 ? evaluateBest([...human.hole, ...game.community]).label : preflopLabel(human.hole);
  const memberConnections = new Map(snapshot.members.map((member) => [member.id, member.connected]));
  const me = snapshot.members.find((member) => member.id === snapshot.viewerId)!;

  const act = (action: GameAction) => {
    if (!isHumanTurn) return;
    if (send({ type: "action", actionId: crypto.randomUUID(), version: snapshot.version, action })) setShowRaise(false);
  };
  const closeChat = () => {
    setChatSeenCount(snapshot.chat.length);
    setChatOpen(false);
  };
  const toggleChat = () => {
    if (!chatOpen) setChatSeenCount(snapshot.chat.length);
    setChatOpen((open) => !open);
  };
  const unreadChat = chatOpen ? 0 : Math.max(0, snapshot.chat.length - (chatSeenCount ?? snapshot.chat.length));

  return (
    <main className="game-shell online-game-shell">
      <header className="topbar">
        <span className="brand"><span className="brand-mark">P</span><span className="brand-word">POCKET</span></span>
        <div className={`round-meta round-turn-status ${isHumanTurn ? "is-you" : ""}`} role="status" aria-live="polite"><span className="round-turn-avatar">{acting?.avatar || "P"}</span><span className="round-turn-copy"><small>房间 {snapshot.roomCode} · 第 {game.handNo} 手 · {phaseLabel(game.phase)} · 剩余 {remaining} 秒</small><strong>{acting ? isHumanTurn ? "轮到你操作" : `轮到 ${acting.name} 操作` : game.message}</strong></span><i className="round-turn-pulse" /></div>
        <div className="top-actions"><span className={`online-connection-pill ${connection}`}><i />{connection === "connected" ? "联机中" : "重连中"}</span><button className="online-chat-toggle" onClick={toggleChat} aria-expanded={chatOpen}>聊天{unreadChat > 0 && <b>{unreadChat}</b>}</button><button className="icon-button online-close-game" onClick={exitRoom} aria-label="返回首页">×</button></div>
      </header>
      {chatOpen && <aside className="online-chat-drawer"><OnlineChat messages={snapshot.chat} viewerId={snapshot.viewerId} onSend={sendChat} onClose={closeChat} /></aside>}
      <section className="workspace online-game-workspace">
        <section className="table-stage" aria-label="联机德州扑克牌桌">
          <div className="table-grid" />
          {game.players.map((player, index) => <OnlineSeat key={player.id} player={player} index={index} game={game} connected={memberConnections.get(player.id) ?? false} modelThinking={snapshot.aiThinking?.playerId === player.id} />)}
          <div className="board"><div className="pot-line"><span>当前底池</span><strong>{formatChips(pot || game.lastPot)}</strong></div><div className="community-cards" aria-label="公共牌">{Array.from({ length: 5 }, (_, index) => <OnlineCard key={index} card={game.community[index]} />)}</div><span className="phase-pill">{phaseLabel(game.phase)}</span><div className="board-bets"><small>本轮投入</small>{game.players.filter((player) => player.bet > 0).map((player) => <span key={player.id}><i>{player.avatar}</i>{formatChips(player.bet)}</span>)}</div></div>
          <div className="hero-hand"><div className="hero-cards"><OnlineCard card={human.hole[0]} /><OnlineCard card={human.hole[1]} /></div><div className="hand-readout"><small>当前牌型</small><strong>{handLabel}</strong></div></div>
          {game.status === "handOver" && <div className="result-card"><span className="result-kicker">本手结束</span><h2>{game.message}</h2><p>底池 {formatChips(game.lastPot)}</p>{me.isHost ? <button className="primary-button" onClick={() => send({ type: "nextHand" })}>下一手牌 <span>→</span></button> : <small>等待房主开始下一手</small>}</div>}
          {game.status === "gameOver" && <div className="result-card"><span className="result-kicker">对局结束</span><h2>{game.message}</h2><button className="primary-button" onClick={exitRoom}>返回首页</button></div>}
        </section>
      </section>
      <section className={`control-dock ${isHumanTurn ? "dock-your-turn" : "dock-waiting"}`} aria-label="联机行动控制">
        <div className="dock-context"><span className="timer-ring" style={{ "--progress": `${remaining / snapshot.turnTime * 360}deg` } as React.CSSProperties}><i>{remaining || "·"}</i></span><div><small>{isHumanTurn ? `决策时间 · ${remaining} 秒` : acting ? `${acting.name} 行动 · ${remaining} 秒` : `第 ${game.handNo} 手`}</small><strong>{isHumanTurn ? `${handLabel} · ${due === 0 ? "可以过牌" : `待跟注 ${formatChips(Math.min(due, human.chips))}`}` : `${handLabel} · 筹码 ${formatChips(human.chips)}`}</strong></div></div>
        <div className="action-area">
          {showRaise && bounds.max > bounds.min && <div className="raise-popover"><div className="raise-head"><span>加注到</span><strong>{formatChips(raiseTo)}</strong></div><input aria-label="加注金额" type="range" min={bounds.min} max={bounds.max} step={10} value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} /><div className="quick-bets"><button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, Math.round(pot * .5 / 10) * 10)))}>½ 底池</button><button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, Math.round(pot * .75 / 10) * 10)))}>¾ 底池</button><button onClick={() => setRaiseTo(Math.min(bounds.max, Math.max(bounds.min, pot)))}>满池</button><button onClick={() => setRaiseTo(bounds.max)}>全下</button></div><button className="confirm-raise" onClick={() => act(raiseTo >= bounds.max ? { type: "allIn" } : { type: "raise", amount: raiseTo })}>确认加注</button></div>}
          <div className="action-row"><button disabled={!isHumanTurn || connection !== "connected"} className="action-button quiet" onClick={() => act({ type: "fold" })}>弃牌</button><button disabled={!isHumanTurn || connection !== "connected"} className="action-button quiet" onClick={() => act({ type: "checkCall" })}>{due === 0 ? "过牌" : `跟注 ${formatChips(Math.min(due, human.chips))}`}</button><button disabled={!isHumanTurn || connection !== "connected" || bounds.max <= game.currentBet} className={`action-button dark ${showRaise ? "selected" : ""}`} onClick={() => { if (!showRaise) setRaiseTo(defaultRaise); setShowRaise((value) => !value); }}>加注</button></div>
        </div>
      </section>
    </main>
  );
}
