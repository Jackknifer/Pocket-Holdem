/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
export { PokerRoom } from "./poker-room";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  POKER_ROOMS: DurableObjectNamespace;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
}

function randomRoomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join("");
}

async function onlineJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 4_096) throw new Error("请求内容过大");
  return await request.json() as Record<string, unknown>;
}

async function handleOnlineRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  try {
    if (request.method === "POST" && url.pathname === "/api/online/rooms") {
      const input = await onlineJson(request);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const code = randomRoomCode();
        const playerId = crypto.randomUUID();
        const token = randomToken();
        const room = env.POKER_ROOMS.getByName(code);
        const response = await room.fetch("https://room.internal/create", {
          method: "POST", headers, body: JSON.stringify({ ...input, code, playerId, token }),
        });
        if (response.status !== 409) return response;
      }
      return new Response(JSON.stringify({ error: "暂时无法分配房间号，请重试" }), { status: 503, headers });
    }

    const match = url.pathname.match(/^\/api\/online\/rooms\/([A-Z2-9]{6})(?:\/(join|socket))?$/i);
    if (!match) return new Response(JSON.stringify({ error: "联机接口不存在" }), { status: 404, headers });
    const code = match[1].toUpperCase();
    const action = match[2];
    const room = env.POKER_ROOMS.getByName(code);
    if (request.method === "POST" && action === "join") {
      const input = await onlineJson(request);
      const playerId = crypto.randomUUID();
      const token = randomToken();
      return room.fetch("https://room.internal/join", {
        method: "POST", headers, body: JSON.stringify({ ...input, playerId, token }),
      });
    }
    if (action === "socket" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const internal = new URL("https://room.internal/socket");
      internal.search = url.search;
      return room.fetch(new Request(internal, request));
    }
    return new Response(JSON.stringify({ error: "联机请求无效" }), { status: 400, headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "联机服务暂时不可用" }), { status: 400, headers });
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    if (url.pathname.startsWith("/api/online/")) return handleOnlineRequest(request, env);

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
