import type { GameAction, GameState } from "./game";

export type OnlineRoomStatus = "lobby" | "playing" | "finished";

export type OnlineMember = {
  id: string;
  name: string;
  avatar: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
};

export type OnlineRoomSnapshot = {
  roomCode: string;
  status: OnlineRoomStatus;
  capacity: number;
  turnTime: 30 | 120 | 300;
  viewerId: string;
  members: OnlineMember[];
  game: GameState | null;
  deadlineAt: number | null;
  version: number;
  message: string;
};

export type OnlineSession = {
  roomCode: string;
  playerId: string;
  token: string;
};

export type OnlineClientMessage =
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "action"; actionId: string; version: number; action: GameAction }
  | { type: "nextHand" }
  | { type: "sync" }
  | { type: "leave" }
  | { type: "ping" };

export type OnlineServerMessage =
  | { type: "snapshot"; snapshot: OnlineRoomSnapshot }
  | { type: "error"; message: string }
  | { type: "pong"; now: number };

