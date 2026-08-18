import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig, loadEnv, type Plugin } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { handleAiDecisionRequest } from "./app/api/ai-decision/route";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

function localModelApi(): Plugin {
  return {
    name: "pocket-local-model-api",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use("/api/ai-decision", async (request, response, next) => {
        if (request.method !== "POST") return next();
        try {
          const chunks: Buffer[] = [];
          let length = 0;
          for await (const chunk of request) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            length += buffer.length;
            if (length > 64 * 1024) {
              response.statusCode = 413;
              response.setHeader("content-type", "application/json; charset=utf-8");
              response.end(JSON.stringify({ error: "请求内容过大" }));
              return;
            }
            chunks.push(buffer);
          }

          const localRequest = new Request("http://localhost/api/ai-decision", {
            method: "POST",
            headers: { "content-type": request.headers["content-type"] || "application/json" },
            body: new Uint8Array(Buffer.concat(chunks)),
          });
          const modelResponse = await handleAiDecisionRequest(localRequest);
          response.statusCode = modelResponse.status;
          modelResponse.headers.forEach((value, key) => response.setHeader(key, value));
          response.end(new Uint8Array(await modelResponse.arrayBuffer()));
        } catch {
          response.statusCode = 500;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "本地模型代理处理请求失败" }));
        }
      });
    },
  };
}

export default defineConfig(async ({ mode }) => {
  // Vite only exposes prefixed variables to browser code. Copy the complete local
  // env into this Node-only process so API keys remain server-side.
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      localModelApi(),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
