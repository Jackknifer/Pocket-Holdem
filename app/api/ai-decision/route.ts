import { getModelConfig, type ModelAdapter, type ModelEnvironment, type ServerModelConfig } from "../../model-config.ts";

type DecisionRequest = {
  provider?: string;
  context?: unknown;
  reasoning?: "standard" | "max";
  actionTimeSeconds?: number;
};

type MessageContent = string | Array<{ type?: string; text?: string; thinking?: string }> | null;
type ModelResponse = {
  id?: string;
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: MessageContent; reasoning_content?: string } }>;
  content?: MessageContent;
  stop_reason?: string;
  error?: { message?: string; code?: string | number };
  base_resp?: { status_code?: number; status_msg?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
};

type Decision = {
  action?: unknown;
  amount?: unknown;
  note?: unknown;
  assessment?: unknown;
  rangeAnalysis?: unknown;
  potAnalysis?: unknown;
  factors?: unknown;
  alternatives?: unknown;
  skillApplication?: unknown;
  strengthApplication?: unknown;
  risk?: unknown;
  confidence?: unknown;
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function validateConfiguredEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function readMessageContent(content: MessageContent | undefined): string {
  if (typeof content === "string") return content;
  return (content || []).filter((part) => typeof part.text === "string").map((part) => part.text).join("");
}

function parseDecision(text: string): Decision | null {
  const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = withoutThinking.indexOf("{");
  const lastBrace = withoutThinking.lastIndexOf("}");
  const extracted = firstBrace >= 0 && lastBrace > firstBrace ? withoutThinking.slice(firstBrace, lastBrace + 1) : "";
  for (const candidate of [fenced, withoutThinking, extracted]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as Decision;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* Try the next common response wrapper. */ }
  }
  return null;
}

function cleanModelOutput(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
}

function readReasoningCharacters(response: ModelResponse | null): number | null {
  const choiceReasoning = response?.choices?.[0]?.message?.reasoning_content;
  const blockReasoning = Array.isArray(response?.content)
    ? response.content.filter((part) => typeof part.thinking === "string").map((part) => part.thinking).join("")
    : "";
  const length = (choiceReasoning || "").length + blockReasoning.length;
  return length > 0 ? length : null;
}

function supportsOpenAiXHigh(model: string): boolean {
  return /codex-max|gpt-5\.(?:[2-9]|[1-9]\d)/i.test(model);
}

function reasoningMode(config: ServerModelConfig, compatibilityRetry: boolean, requested: "standard" | "max"): string {
  if (config.adapter === "deepseek") return requested === "max" ? "max" : "high";
  if (config.adapter === "glm" && /glm-5\.2/i.test(config.model)) return compatibilityRetry ? "provider-default" : requested === "max" ? "max" : "high";
  if (config.adapter === "kimi" && /kimi-k3/i.test(config.model)) return compatibilityRetry ? "provider-default" : requested === "max" ? "max" : "high";
  if (config.adapter === "kimi" && /kimi-k2\.7-code/i.test(config.model)) return "native";
  if (config.adapter === "glm" || config.adapter === "kimi") return compatibilityRetry ? "provider-default" : "enabled";
  if (config.adapter === "minimax") return /minimax-m3/i.test(config.model) ? compatibilityRetry ? "provider-default" : "adaptive" : "native";
  if (config.adapter === "openai" && /^(?:gpt-5|o[134])/i.test(config.model)) return compatibilityRetry ? "provider-default" : requested === "max" && supportsOpenAiXHigh(config.model) ? "xhigh" : "high";
  return "model-default";
}

function readUsage(response: ModelResponse | null): { input: number; output: number; total: number } | null {
  const usage = response?.usage;
  if (!usage) return null;
  const input = Math.max(0, Number(usage.input_tokens ?? usage.prompt_tokens ?? 0));
  const output = Math.max(0, Number(usage.output_tokens ?? usage.completion_tokens ?? 0));
  const total = Math.max(0, Number(usage.total_tokens ?? input + output));
  return input || output || total ? { input, output, total } : null;
}

function modelPayload(config: ServerModelConfig, contextText: string, compatibilityRetry = false, requestedReasoning: "standard" | "max" = "max"): Record<string, unknown> {
  const system = [
    "你是一名德州扑克对手，只能根据提供的公开牌局信息和自己的底牌决策。",
    "不得假设其他玩家的隐藏底牌。结合位置、筹码、底池赔率、牌力、对手行动和角色性格。",
    "输入中 role.skill 是该对手必须遵守的完整专属技能。决策前检查其中 identity、preflop 或当前 postflop 街、sizing、adaptations、stackAndTable、decisionProtocol、outputRequirements 与 guardrails；不得只读取 title 或 summary。",
    "以 objective 为长期目标，选择与当前局面相关的规则。skillApplication 必须明确指出本次实际采用的角色规则及其对动作的影响，不得只复述角色名称。",
    "本游戏没有低难度档。输入中的 competitiveProfile 表示固定最高竞技强度；不得故意犯错，完整考虑范围、组合、阻断牌、位置、SPR、底池赔率和行动线路，以长期期望值最大化。",
    requestedReasoning === "max" ? "本次启用极致思考：在内部尽可能充分验证候选动作、反例和尺度后再回答。" : "本次使用标准思考：保持严谨，但优先在合理延迟内完成决策。",
    "输入中的 actionDeadlineSeconds 是本次行动的硬性总时限。你必须自行分配思考与作答时间，并在该秒数内返回完整、合法的 JSON；超时会被自动判定为模型决策失败。",
    "必须从 legalActions 中选择合法动作。raise 时 amount 必须位于 minRaiseTo 与 maxRaiseTo 之间。",
    "在内部充分推理后再作答，但不要在最终 JSON 中输出隐藏思维链或逐步内心推演。最终答案可以简洁；用关键结论证明决策即可，不以最终文字长度代替推理质量。",
    "除 action 的英文枚举值外，所有文本字段必须使用简体中文。",
    "只返回一个 JSON 对象，不要 Markdown 或额外文字。严格使用：{\"action\":\"fold|checkCall|raise|allIn\",\"amount\":数字或null,\"note\":\"动作摘要\",\"assessment\":\"牌力结论\",\"rangeAnalysis\":\"范围与位置结论\",\"potAnalysis\":\"赔率、SPR与尺度结论\",\"factors\":[\"2至4项关键公开因素\"],\"alternatives\":[{\"action\":\"主要候选动作\",\"reason\":\"未选择原因\"}],\"skillApplication\":\"采用的角色规则\",\"strengthApplication\":\"最高竞技强度的具体体现\",\"risk\":\"主要风险与不确定性\",\"confidence\":0到100的整数}。各分析字段优先使用一到两句完整短句。",
  ].join("\n");

  if (config.adapter === "minimax") {
    return {
      model: config.model,
      system,
      messages: [{ role: "user", content: contextText }],
      stream: false,
      max_tokens: requestedReasoning === "max" ? 32768 : 16384,
      ...(!compatibilityRetry && /minimax-m3/i.test(config.model) ? { thinking: { type: "adaptive" } } : {}),
    };
  }

  const base = {
    model: config.model,
    messages: [{ role: "system", content: system }, { role: "user", content: contextText }],
    stream: false,
  };

  const openAiReasoning = /^(?:gpt-5|o[134])/i.test(config.model);
  const openAiEffort = requestedReasoning === "max" && supportsOpenAiXHigh(config.model) ? "xhigh" : "high";
  const kimiK3 = /kimi-k3/i.test(config.model);
  const kimiAlwaysThinking = /kimi-k2\.7-code/i.test(config.model);
  const adapters: Record<ModelAdapter, Record<string, unknown>> = {
    openai: openAiReasoning
      ? { max_completion_tokens: requestedReasoning === "max" ? 32768 : 16384, ...(!compatibilityRetry ? { reasoning_effort: openAiEffort, response_format: { type: "json_object" } } : {}) }
      : { max_tokens: 8192, ...(!compatibilityRetry ? { response_format: { type: "json_object" } } : {}) },
    deepseek: {
      max_tokens: requestedReasoning === "max" ? 32768 : 16384,
      thinking: { type: "enabled" },
      reasoning_effort: requestedReasoning === "max" ? "max" : "high",
      ...(!compatibilityRetry ? { response_format: { type: "json_object" } } : {}),
    },
    minimax: {},
    kimi: {
      max_completion_tokens: requestedReasoning === "max" ? 32768 : 16384,
      ...(!compatibilityRetry ? {
        ...(kimiK3 ? { reasoning_effort: requestedReasoning === "max" ? "max" : "high" } : kimiAlwaysThinking ? {} : { thinking: { type: "enabled" } }),
        response_format: { type: "json_object" },
      } : {}),
    },
    glm: {
      max_tokens: requestedReasoning === "max" ? 32768 : 16384,
      ...(!compatibilityRetry ? {
        thinking: { type: "enabled" },
        ...(/glm-5\.2/i.test(config.model) ? { reasoning_effort: requestedReasoning === "max" ? "max" : "high" } : {}),
        response_format: { type: "json_object" },
      } : {}),
    },
    generic: { max_tokens: 8192 },
  };
  return { ...base, ...adapters[config.adapter] };
}

function clientStatus(upstreamStatus: number): number {
  return [400, 401, 402, 403, 404, 408, 409, 422, 429].includes(upstreamStatus) ? upstreamStatus : 502;
}

function upstreamDetail(modelResponse: ModelResponse | null): string {
  const detail = modelResponse?.error?.message || modelResponse?.base_resp?.status_msg || "";
  return detail.replace(/(?:sk-|key-)[a-z0-9_-]{8,}/gi, "[已隐藏密钥]").trim().slice(0, 180);
}

function providerEndpoints(config: ServerModelConfig, configuredEndpoint: URL): URL[] {
  if (config.adapter !== "minimax") return [configuredEndpoint];
  const endpoint = new URL(configuredEndpoint);
  const isOfficialHost = ["api.minimax.io", "api.minimaxi.com"].includes(endpoint.hostname);
  if (isOfficialHost) endpoint.pathname = "/anthropic/v1/messages";
  const alternateHost = endpoint.hostname === "api.minimax.io"
    ? "api.minimaxi.com"
    : endpoint.hostname === "api.minimaxi.com" ? "api.minimax.io" : "";
  if (!alternateHost) return [endpoint];
  const alternate = new URL(endpoint);
  alternate.hostname = alternateHost;
  return [endpoint, alternate];
}

export async function handleAiDecisionRequest(request: Request, environment?: ModelEnvironment) {
  const startedAt = Date.now();
  let body: DecisionRequest;
  try {
    body = await request.json() as DecisionRequest;
  } catch {
    return jsonError("请求格式无效", 400);
  }

  const provider = body.provider?.trim().toLowerCase().slice(0, 64) || "";
  const requestedReasoning = body.reasoning === "standard" ? "standard" : "max";
  const actionTimeSeconds = [30, 120, 300].includes(Number(body.actionTimeSeconds)) ? Number(body.actionTimeSeconds) : null;
  if (!provider) return jsonError("请选择模型", 400);
  const config = getModelConfig(provider, environment);
  if (!config) return jsonError("此模型尚未在本地或站点服务器配置 API Key", 400);
  const endpoint = validateConfiguredEndpoint(config.endpoint);
  if (!endpoint) return jsonError("模型配置中的 API 地址无效", 500);

  const contextText = JSON.stringify(body.context ?? null);
  if (contextText.length > 18_000) return jsonError("牌局上下文过大", 413);

  const controller = new AbortController();
  const providerTimeoutMs = actionTimeSeconds
    ? 360_000
    : config.adapter === "minimax" ? 240_000 : config.adapter === "generic" ? 90_000 : 180_000;
  const timeoutMs = actionTimeSeconds ? Math.min(providerTimeoutMs, actionTimeSeconds * 1_000) : providerTimeoutMs;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abortForDisconnectedClient = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", abortForDisconnectedClient, { once: true });
  try {
    const supportsCompatibilityRetry = config.adapter !== "generic";
    const attempts = supportsCompatibilityRetry ? 2 : 1;
    const endpoints = providerEndpoints(config, endpoint);
    let regionalError = "";
    let requestAttempts = 0;
    endpointLoop: for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex += 1) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let response: Response;
        try {
          requestAttempts += 1;
          const headers: Record<string, string> = config.adapter === "minimax"
            ? {
                "X-Api-Key": config.apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
              }
            : {
                "Authorization": `Bearer ${config.apiKey}`,
                "Content-Type": "application/json",
              };
          response = await fetch(endpoints[endpointIndex], {
            method: "POST",
            headers,
            body: JSON.stringify(modelPayload(config, contextText, attempt > 0, requestedReasoning)),
            redirect: "error",
            signal: controller.signal,
          });
        } catch (error) {
          if (config.adapter === "minimax" && endpointIndex + 1 < endpoints.length && !(error instanceof Error && error.name === "AbortError")) {
            regionalError = "MiniMax 当前区域无法连接，已尝试另一官方区域";
            continue endpointLoop;
          }
          throw error;
        }

        const modelResponse = await response.json().catch(() => null) as ModelResponse | null;
        if (!response.ok) {
          const detail = upstreamDetail(modelResponse);
          const shouldTryOtherMiniMaxRegion = config.adapter === "minimax" && endpointIndex + 1 < endpoints.length && [401, 403].includes(response.status);
          if (shouldTryOtherMiniMaxRegion) {
            regionalError = detail || `MiniMax 当前区域返回 HTTP ${response.status}`;
            continue endpointLoop;
          }
          const requestShapeMayBeRejected = attempt === 0 && [400, 422].includes(response.status);
          if (requestShapeMayBeRejected) continue;
          return jsonError(detail || `模型服务返回 HTTP ${response.status}`, clientStatus(response.status));
        }
        if (modelResponse?.base_resp?.status_code && modelResponse.base_resp.status_code !== 0) {
          return jsonError(upstreamDetail(modelResponse) || "模型服务拒绝了请求", 502);
        }

        const choice = modelResponse?.choices?.[0];
        const outputText = config.adapter === "minimax"
          ? readMessageContent(modelResponse?.content)
          : readMessageContent(choice?.message?.content);
        const decision = parseDecision(outputText);
        const actionIsValid = decision && ["fold", "checkCall", "raise", "allIn"].includes(String(decision.action));
        if (!actionIsValid && attempt + 1 < attempts) continue;
        if (!decision) {
          const finishReason = config.adapter === "minimax" ? modelResponse?.stop_reason : choice?.finish_reason;
          const reason = ["length", "max_tokens"].includes(finishReason || "")
            ? "模型输出达到长度限制，未能返回完整动作"
            : "模型没有返回可用的结构化动作";
          return jsonError(reason, 502);
        }
        if (!actionIsValid) return jsonError("模型返回了未知动作", 502);

        const requestId = response.headers.get("x-request-id")
          || response.headers.get("minimax-request-id")
          || response.headers.get("trace-id")
          || modelResponse?.id
          || null;
        return Response.json({
          action: decision.action,
          amount: typeof decision.amount === "number" && Number.isFinite(decision.amount) ? decision.amount : null,
          note: typeof decision.note === "string" ? decision.note.slice(0, 320) : "",
          assessment: typeof decision.assessment === "string" ? decision.assessment.slice(0, 2400) : "",
          rangeAnalysis: typeof decision.rangeAnalysis === "string" ? decision.rangeAnalysis.slice(0, 2400) : "",
          potAnalysis: typeof decision.potAnalysis === "string" ? decision.potAnalysis.slice(0, 2400) : "",
          factors: Array.isArray(decision.factors)
            ? decision.factors.filter((item): item is string => typeof item === "string").slice(0, 10).map((item) => item.slice(0, 500))
            : [],
          alternatives: Array.isArray(decision.alternatives)
            ? decision.alternatives.filter((item) => item && typeof item === "object").slice(0, 5).map((item) => {
                const alternative = item as { action?: unknown; reason?: unknown };
                return {
                  action: typeof alternative.action === "string" ? alternative.action.slice(0, 40) : "",
                  reason: typeof alternative.reason === "string" ? alternative.reason.slice(0, 1200) : "",
                };
              })
            : [],
          skillApplication: typeof decision.skillApplication === "string" ? decision.skillApplication.slice(0, 2400) : "",
          strengthApplication: typeof decision.strengthApplication === "string" ? decision.strengthApplication.slice(0, 1600) : "",
          risk: typeof decision.risk === "string" ? decision.risk.slice(0, 2400) : "",
          confidence: typeof decision.confidence === "number" && Number.isFinite(decision.confidence)
            ? Math.max(0, Math.min(100, Math.round(decision.confidence)))
            : null,
          provider: config.name,
          model: modelResponse?.model || config.model,
          requestId,
          latencyMs: Date.now() - startedAt,
          attempts: requestAttempts,
          recovered: attempt > 0 || endpointIndex > 0,
          recovery: endpointIndex > 0 ? "region" : attempt > 0 ? "format" : null,
          region: config.adapter === "minimax"
            ? endpoints[endpointIndex].hostname === "api.minimaxi.com" ? "中国区" : "国际区"
            : null,
          finishReason: config.adapter === "minimax" ? modelResponse?.stop_reason || null : choice?.finish_reason || null,
          usage: readUsage(modelResponse),
          reasoningMode: reasoningMode(config, attempt > 0, requestedReasoning),
          reasoningCharacters: readReasoningCharacters(modelResponse),
          output: cleanModelOutput(outputText),
        });
      }
    }
    return jsonError(regionalError || "模型没有返回可执行动作", 502);
  } catch (error) {
    return jsonError(error instanceof Error && error.name === "AbortError" ? `模型响应超过 ${timeoutMs / 1000} 秒` : "无法连接模型服务，请检查服务器 API 地址或网络", 504);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortForDisconnectedClient);
  }
}

export const POST = handleAiDecisionRequest;
