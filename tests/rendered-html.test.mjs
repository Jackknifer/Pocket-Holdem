import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Pocket game shell and sharing metadata", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Pocket — 单机德州扑克<\/title>/i);
  assert.match(html, /一场安静、专注且足够聪明的单机德州扑克体验/);
  assert.match(html, /正在整理牌桌/);
  assert.match(html, /http:\/\/localhost(?::3000)?\/og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("model configuration endpoint exposes availability without exposing secrets", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("model-config-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/model-config"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const text = JSON.stringify(await response.json());
  for (const provider of ["OpenAI", "DeepSeek", "MiniMax", "Kimi", "GLM"]) assert.match(text, new RegExp(provider));
  assert.doesNotMatch(text, /apiKey|Authorization|Bearer|sk-[a-z0-9]/i);
});

test("AI decision endpoint ignores browser-supplied secrets and only accepts local model ids", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("ai-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const context = { waitUntil() {}, passThroughOnException() {} };
  const response = await worker.fetch(
    new Request("http://localhost/api/ai-decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "browser-supplied", apiKey: "test-key-123456789", endpoint: "https://example.com", model: "fake", context: {} }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /.env.local|本地/);
});

test("all five official providers use their documented request shape", async () => {
  const providers = [
    ["openai", "OPENAI_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
    ["minimax", "MINIMAX_API_KEY"],
    ["kimi", "KIMI_API_KEY"],
    ["glm", "GLM_API_KEY"],
  ];
  for (const [, envName] of providers) process.env[envName] = "test-local-key-123456";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("provider-shape-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url: String(input), body, headers: init?.headers });
    const result = body.system ? {
      id: `mock-${body.model}`,
      model: body.model,
      content: [
        { type: "thinking", text: "brief" },
        { type: "text", text: '{"action":"checkCall","amount":null,"note":"连接正常"}' },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 120, output_tokens: 24 },
    } : {
      id: `mock-${body.model}`,
      model: body.model,
      choices: [{ finish_reason: "stop", message: { content: '{"action":"checkCall","amount":null,"note":"连接正常"}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
    };
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json", "x-request-id": `request-${body.model}` } });
  };
  try {
    for (const [provider] of providers) {
      const response = await worker.fetch(
        new Request("http://localhost/api/ai-decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, context: { legalActions: { checkCall: true } } }),
        }),
        { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
        { waitUntil() {}, passThroughOnException() {} },
      );
      assert.equal(response.status, 200, provider);
      const result = await response.json();
      assert.equal(result.requestId, `request-${result.model}`, provider);
      assert.match(result.output, /"action":"checkCall"/, provider);
      assert.deepEqual(result.usage, { input: 120, output: 24, total: 144 }, provider);
      assert.equal(result.attempts, 1, provider);
      assert.equal(result.recovered, false, provider);
    }
    const standardResponse = await worker.fetch(
      new Request("http://localhost/api/ai-decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "deepseek", reasoning: "standard", context: { legalActions: { checkCall: true } } }),
      }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(standardResponse.status, 200);
    assert.equal((await standardResponse.json()).reasoningMode, "high");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [, envName] of providers) delete process.env[envName];
  }

  const byProvider = Object.fromEntries(providers.map(([provider], index) => [provider, calls[index].body]));
  assert.deepEqual(byProvider.openai.response_format, { type: "json_object" });
  assert.deepEqual(byProvider.deepseek.thinking, { type: "enabled" });
  assert.equal(byProvider.deepseek.reasoning_effort, "max");
  assert.deepEqual(byProvider.deepseek.response_format, { type: "json_object" });
  assert.equal(byProvider.minimax.max_tokens, 32768);
  assert.equal(typeof byProvider.minimax.system, "string");
  assert.equal(byProvider.minimax.messages.length, 1);
  assert.deepEqual(byProvider.kimi.thinking, { type: "enabled" });
  assert.deepEqual(byProvider.kimi.response_format, { type: "json_object" });
  assert.deepEqual(byProvider.glm.thinking, { type: "enabled" });
  assert.equal(byProvider.glm.reasoning_effort, "max");
  assert.deepEqual(byProvider.glm.response_format, { type: "json_object" });
  assert.equal(calls[5].body.reasoning_effort, "high");
  for (const call of calls.filter((call) => !call.body.system)) {
    assert.equal(call.body.stream, false);
    assert.match(JSON.stringify(call.headers), /Bearer test-local-key-123456/);
  }
  const minimaxCall = calls.find((call) => call.body.system);
  assert.match(JSON.stringify(minimaxCall.headers), /X-Api-Key.*test-local-key-123456/);
  assert.match(JSON.stringify(minimaxCall.headers), /anthropic-version.*2023-06-01/);
  assert.match(minimaxCall.url, /\/anthropic\/v1\/messages$/);
});

test("DeepSeek and MiniMax retry their documented structured-output edge cases", async () => {
  process.env.DEEPSEEK_API_KEY = "test-local-key-123456";
  process.env.MINIMAX_API_KEY = "test-local-key-123456";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("provider-retry-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push(body);
    const isDeepSeek = body.model === "deepseek-v4-flash";
    const providerAttempt = calls.filter((call) => call.model === body.model).length;
    const firstAttempt = isDeepSeek ? "response_format" in body : providerAttempt === 1;
    const result = isDeepSeek
      ? firstAttempt ? {
          model: body.model,
          choices: [{ finish_reason: "stop", message: { content: "" } }],
        } : {
          model: body.model,
          choices: [{ finish_reason: "stop", message: { content: '<think>brief</think>{"action":"checkCall","amount":null,"note":"兼容成功"}' } }],
        }
      : firstAttempt ? {
          model: body.model,
          content: [],
          stop_reason: "max_tokens",
        } : {
          model: body.model,
          content: [{ type: "text", text: '{"action":"checkCall","amount":null,"note":"兼容成功"}' }],
          stop_reason: "end_turn",
        };
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    for (const provider of ["deepseek", "minimax"]) {
      const response = await worker.fetch(
        new Request("http://localhost/api/ai-decision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider, context: { legalActions: { checkCall: true } } }),
        }),
        { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
        { waitUntil() {}, passThroughOnException() {} },
      );
      assert.equal(response.status, 200, provider);
      assert.equal((await response.json()).recovered, true, provider);
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MINIMAX_API_KEY;
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[1].response_format, undefined);
  assert.equal(calls[3].max_tokens, 32768);
});

test("MiniMax falls back between its official global and mainland China regions", async () => {
  process.env.MINIMAX_API_KEY = "test-local-key-123456";
  process.env.MINIMAX_API_ENDPOINT = "https://api.minimax.io/anthropic/v1/messages";
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("minimax-region-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input, init) => {
    urls.push(String(input));
    if (String(input).includes("api.minimax.io")) {
      return new Response(JSON.stringify({ error: { message: "invalid api key for this region" } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    const body = JSON.parse(String(init?.body || "{}"));
    return new Response(JSON.stringify({
      model: body.model,
      content: [{ type: "text", text: '{"action":"checkCall","amount":null,"note":"中国区连接成功"}' }],
      stop_reason: "end_turn",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(
      new Request("http://localhost/api/ai-decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "minimax", context: { legalActions: { checkCall: true } } }),
      }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recovered, true);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_ENDPOINT;
  }
  assert.deepEqual(urls, [
    "https://api.minimax.io/anthropic/v1/messages",
    "https://api.minimaxi.com/anthropic/v1/messages",
  ]);
});

test("ships the complete game instead of starter preview assets", async () => {
  const [page, engine, css, packageJson, aiRoute, aiSkillsEntry, modelConfig, viteConfig] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/game.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ai-decision/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/ai-skills.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/model-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);
  const opponentSkillNames = ["mira", "knox", "aria", "theo", "nova"];
  const opponentSkillSources = await Promise.all(opponentSkillNames.map((name) => readFile(new URL(`../app/opponent-skills/${name}.ts`, import.meta.url), "utf8")));
  const aiSkills = [aiSkillsEntry, ...opponentSkillSources].join("\n");
  assert.match(page, /chooseAiAction/);
  assert.match(page, /行动与模型记录/);
  assert.match(page, /五分钟学会德州扑克/);
  assert.match(page, /确认并开始对局/);
  assert.match(page, /本轮投入/);
  assert.match(page, /pocket-active-session/);
  assert.doesNotMatch(page, /行动提示|模拟胜率|底池赔率/);
  assert.match(page, /对局人数/);
  assert.match(page, /对局模式/);
  assert.match(page, /本地对局/);
  assert.match(page, /联机对局/);
  assert.match(page, /即将开放/);
  assert.doesNotMatch(page, /对手强度/);
  assert.match(page, /思考节奏/);
  assert.match(page, /模型极致思考/);
  assert.match(page, /maxReasoning/);
  assert.match(page, /轮到你操作/);
  assert.match(page, /seat-turn-label/);
  assert.match(page, /DeepSeek/);
  assert.match(page, /MiniMax/);
  assert.match(page, /Kimi/);
  assert.match(page, /GLM/);
  assert.match(page, /.env.local/);
  assert.match(page, /选择后自动检测连接/);
  assert.match(page, /modelOptions/);
  assert.doesNotMatch(page, /modelOpponents|ModelSetup|测试当前模型/);
  assert.match(page, /requestModelAction/);
  assert.match(page, /aiDecisionDelay/);
  assert.match(page, /round-turn-status/);
  assert.match(page, /dock-context/);
  assert.doesNotMatch(page, /table-turn-indicator/);
  assert.match(page, /lobby-page/);
  assert.match(page, /lobby-controls-grid/);
  assert.match(page, /lobby-basics/);
  assert.match(page, /lobby-outside-meta/);
  assert.match(page, /lobby-model-popover/);
  assert.doesNotMatch(page, /lobby-model-dialog/);
  assert.match(page, /安静地，打一手好牌/);
  assert.doesNotMatch(page, /lobby-visual|mini-seat|idle-cards|lobby-snapshot/);
  assert.match(page, /localStorage\.removeItem\("pocket-model-credentials"\)/);
  assert.doesNotMatch(page, /secret-input|保存并自动调用|apiKey:\s*string/);
  assert.match(page, /ModelAuditEntry/);
  assert.match(page, /模型调用可核验/);
  assert.match(page, /查看模型实际输出/);
  assert.match(page, /模型请求凭证/);
  assert.match(page, /requestId/);
  assert.match(page, /本手底牌复盘/);
  assert.match(page, /训练复盘/);
  assert.match(page, /标准亮牌/);
  assert.match(page, /reviewMode/);
  assert.match(page, /声音已开启，点击关闭/);
  assert.match(page, /已回退本地 AI/);
  assert.match(page, /safeModelError/);
  assert.match(page, /JSON\.stringify\(\{ game, modelAudit, savedAt:/);
  assert.doesNotMatch(page, /JSON\.stringify\(\{[^}]*apiKey/);
  assert.match(page, /playerCount/);
  assert.match(page, /aiPace/);
  assert.match(page, /if \(!game\) return <Lobby/);
  assert.match(page, /newSession\(settings\.playerCount\)/);
  assert.match(engine, /function showdown/);
  assert.match(engine, /legalRaiseBounds/);
  assert.match(engine, /estimateEquity/);
  assert.match(engine, /inferredRangeFloor/);
  assert.match(engine, /LOCAL_AI_PROFILE/);
  assert.doesNotMatch(engine, /AI_DIFFICULTY_PROFILES|decisionLapse|difficulty:/);
  assert.match(engine, /BLIND_LEVELS/);
  assert.match(engine, /basePlayers\(playerCount/);
  assert.match(engine, /continueThreshold/);
  assert.match(engine, /canPlayerRaise/);
  assert.match(engine, /actedAt/);
  assert.match(engine, /退回未被跟注/);
  assert.match(engine, /正式牌局每条公共牌街先烧一张牌/);
  assert.match(aiRoute, /messages:/);
  assert.match(aiRoute, /thinking:\s*\{ type:\s*"enabled" \}/);
  assert.match(aiRoute, /reasoning_effort:\s*requestedReasoning === "max" \? "max" : "high"/);
  assert.match(aiRoute, /response_format:\s*\{ type:\s*"json_object" \}/);
  assert.match(aiRoute, /max_tokens:\s*requestedReasoning === "max" \? 32768 : 16384/);
  assert.match(aiRoute, /X-Api-Key/);
  assert.match(aiRoute, /anthropic-version/);
  assert.match(aiRoute, /cleanModelOutput/);
  assert.match(aiRoute, /readUsage/);
  assert.match(aiRoute, /requestAttempts/);
  assert.match(aiRoute, /getModelConfig/);
  assert.match(aiRoute, /redirect:\s*"error"/);
  assert.match(aiRoute, /validateConfiguredEndpoint/);
  assert.match(aiRoute, /<think>/);
  assert.match(aiRoute, /role\.skill/);
  assert.match(aiRoute, /skillApplication/);
  assert.match(aiRoute, /assessment/);
  assert.match(aiRoute, /confidence/);
  assert.match(aiRoute, /不要在最终 JSON 中输出隐藏思维链/);
  assert.match(aiRoute, /所有文本字段必须使用简体中文/);
  assert.match(aiRoute, /competitiveProfile/);
  assert.match(aiRoute, /strengthApplication/);
  assert.doesNotMatch(aiRoute, /console\.(?:log|error)/);
  assert.match(aiSkillsEntry, /\.\/opponent-skills/);
  for (const [index, name] of opponentSkillNames.entries()) {
    assert.match(opponentSkillSources[index], new RegExp(`id: "${name}"`));
    assert.ok(opponentSkillSources[index].length > 2_000, `${name} should have a detailed independent skill file`);
    for (const section of ["preflop", "postflop", "sizing", "adaptations", "decisionProtocol", "outputRequirements", "guardrails"]) {
      assert.match(opponentSkillSources[index], new RegExp(`${section}:`), `${name} should define ${section}`);
    }
  }
  assert.match(aiSkills, /紧凶价值手/);
  assert.match(aiSkills, /均衡策略手/);
  assert.match(aiSkills, /主动施压手/);
  assert.match(aiSkills, /读牌剥削手/);
  assert.match(aiSkills, /自适应变速手/);
  for (const envName of ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MINIMAX_API_KEY", "KIMI_API_KEY", "GLM_API_KEY", "POCKET_CUSTOM_MODELS_JSON"]) assert.match(modelConfig, new RegExp(envName));
  assert.match(modelConfig, /deepseek-v4-flash/);
  assert.match(modelConfig, /MiniMax-M2\.7/);
  assert.match(modelConfig, /anthropic\/v1\/messages/);
  assert.match(modelConfig, /kimi-k2\.6/);
  assert.match(modelConfig, /glm-5\.2/);
  assert.match(css, /--paper:\s*#f7f7f4/i);
  assert.match(css, /\.round-turn-status/);
  assert.match(css, /\.dock-context/);
  assert.doesNotMatch(css, /\.table-turn-indicator/);
  assert.match(css, /\.round-turn-status\s*\{[^}]*position:\s*absolute;[^}]*left:\s*50%;[^}]*transform:\s*translate\(-50%,-50%\)/i);
  assert.match(css, /\.seat-you\s*\{[^}]*left:\s*calc\(50% \+ clamp/i);
  assert.match(css, /\.hero-hand\s*\{[^}]*left:\s*calc\(50% - clamp/i);
  assert.doesNotMatch(css, /\.turn-announcer/);
  assert.match(css, /\.lobby-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/i);
  assert.match(css, /\.lobby-card\s*\{[^}]*width:\s*min\(820px,100%\);/i);
  assert.match(css, /\.lobby-controls-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2/i);
  assert.match(css, /\.lobby-control-card\s*\{[^}]*min-height:\s*150px;/i);
  assert.match(css, /\.lobby-control-card \.segment-control button\s*\{[^}]*height:\s*44px;[^}]*font-size:\s*13px;/i);
  assert.match(css, /@media \(max-width:\s*720px\)[\s\S]*?\.lobby-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/i);
  assert.match(css, /\.lobby-model-popover\s*\{/);
  assert.doesNotMatch(css, /\.lobby-model-dialog|\.model-setup|\.model-opponents/);
  assert.doesNotMatch(css, /\.lobby-visual|\.mini-seat|\.idle-cards/);
  assert.match(css, /\.model-audit-entry/);
  assert.match(css, /\.audit-proof/);
  assert.match(css, /\.audit-output/);
  assert.match(css, /\.hand-review-grid/);
  assert.match(css, /\.review-card-code/);
  assert.match(css, /font-variant-numeric:\s*lining-nums tabular-nums/);
  assert.match(css, /\.result-card\.has-review\s*\{[^}]*min\(760px/i);
  assert.match(css, /\.sound-toggle\.is-on/);
  assert.match(css, /\.settings-section/);
  assert.match(css, /\.lobby-reasoning-toggle/);
  assert.doesNotMatch(css, /\.decision-insight/);
  assert.match(css, /\.audit-light\.success/);
  assert.doesNotMatch(css, /#2f5a4a|green felt|casino/i);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|site-creator-vinext-starter/);
  assert.match(viteConfig, /pocket-local-model-api/);
  assert.match(viteConfig, /handleAiDecisionRequest/);
  assert.match(viteConfig, /loadEnv/);
  await assert.rejects(access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)));
});
