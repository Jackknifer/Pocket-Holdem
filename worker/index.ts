/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleOnlineRequest } from "./online-room";
import { handleAiDecisionRequest } from "../app/api/ai-decision/route.ts";
import { getPublicModelConfigs, type ModelEnvironment } from "../app/model-config.ts";

interface Env {
  [key: string]: unknown;
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

async function publicModelRequestAllowed(db: D1Database, request: Request): Promise<boolean> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS model_rate_limits (
    fingerprint TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (fingerprint, window_start)
  )`).run();
  const address = request.headers.get("cf-connecting-ip") || "local-preview";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
  const fingerprint = Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const windowStart = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  await db.prepare(`INSERT INTO model_rate_limits (fingerprint, window_start, request_count) VALUES (?, ?, 1)
    ON CONFLICT(fingerprint, window_start) DO UPDATE SET request_count = request_count + 1`)
    .bind(fingerprint, windowStart).run();
  const row = await db.prepare("SELECT request_count FROM model_rate_limits WHERE fingerprint = ? AND window_start = ?")
    .bind(fingerprint, windowStart).first<{ request_count: number }>();
  return Number(row?.request_count || 0) <= 90;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("strict-transport-security", "max-age=31536000");
  headers.set("content-security-policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const modelEnvironment: ModelEnvironment = { ...process.env, ...env };
    let response: Response;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    } else if (url.pathname.startsWith("/api/online/")) {
      response = await handleOnlineRequest(request, env.DB, modelEnvironment);
    } else if (request.method === "GET" && url.pathname === "/api/model-config") {
      const models = getPublicModelConfigs(modelEnvironment);
      response = Response.json({ models, configuredCount: models.filter((model) => model.configured).length });
    } else if (request.method === "POST" && url.pathname === "/api/ai-decision") {
      response = !env.DB || await publicModelRequestAllowed(env.DB, request)
        ? await handleAiDecisionRequest(request, modelEnvironment)
        : Response.json({ error: "当前网络的模型调用次数已达每小时上限" }, { status: 429 });
    } else {
      response = await handler.fetch(request, env, ctx);
    }
    return withSecurityHeaders(response);
  },
};

export default worker;
