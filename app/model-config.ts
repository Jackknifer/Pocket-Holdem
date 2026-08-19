export type ModelAdapter = "openai" | "deepseek" | "minimax" | "kimi" | "glm" | "generic";

export type ServerModelConfig = {
  id: string;
  name: string;
  endpoint: string;
  model: string;
  apiKey: string;
  adapter: ModelAdapter;
  keyEnv?: string;
};

export type PublicModelConfig = Pick<ServerModelConfig, "id" | "name" | "model"> & {
  configured: boolean;
  hint: string;
};

export type ModelEnvironment = Record<string, unknown>;

type StandardModelDefinition = Omit<ServerModelConfig, "apiKey" | "endpoint" | "model"> & {
  keyEnv: string;
  endpointEnv: string;
  modelEnv: string;
  defaultEndpoint: string;
  defaultModel: string;
};

const STANDARD_MODELS: StandardModelDefinition[] = [
  {
    id: "openai", name: "OpenAI", adapter: "openai", keyEnv: "OPENAI_API_KEY",
    endpointEnv: "OPENAI_API_ENDPOINT", modelEnv: "OPENAI_MODEL",
    defaultEndpoint: "https://api.openai.com/v1/chat/completions", defaultModel: "gpt-4.1-mini",
  },
  {
    id: "deepseek", name: "DeepSeek", adapter: "deepseek", keyEnv: "DEEPSEEK_API_KEY",
    endpointEnv: "DEEPSEEK_API_ENDPOINT", modelEnv: "DEEPSEEK_MODEL",
    defaultEndpoint: "https://api.deepseek.com/chat/completions", defaultModel: "deepseek-v4-flash",
  },
  {
    id: "minimax", name: "MiniMax", adapter: "minimax", keyEnv: "MINIMAX_API_KEY",
    endpointEnv: "MINIMAX_API_ENDPOINT", modelEnv: "MINIMAX_MODEL",
    defaultEndpoint: "https://api.minimax.io/anthropic/v1/messages", defaultModel: "MiniMax-M2.7",
  },
  {
    id: "kimi", name: "Kimi", adapter: "kimi", keyEnv: "KIMI_API_KEY",
    endpointEnv: "KIMI_API_ENDPOINT", modelEnv: "KIMI_MODEL",
    defaultEndpoint: "https://api.moonshot.cn/v1/chat/completions", defaultModel: "kimi-k2.6",
  },
  {
    id: "glm", name: "GLM", adapter: "glm", keyEnv: "GLM_API_KEY",
    endpointEnv: "GLM_API_ENDPOINT", modelEnv: "GLM_MODEL",
    defaultEndpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions", defaultModel: "glm-5.2",
  },
];

function clean(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 64) : "";
}

function isAdapter(value: unknown): value is ModelAdapter {
  return ["openai", "deepseek", "minimax", "kimi", "glm", "generic"].includes(String(value));
}

function customModels(environment: ModelEnvironment): ServerModelConfig[] {
  const raw = clean(environment.POCKET_CUSTOM_MODELS_JSON);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const id = safeId(item.id);
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 60) : "";
      const endpoint = typeof item.endpoint === "string" ? item.endpoint.trim() : "";
      const model = typeof item.model === "string" ? item.model.trim().slice(0, 200) : "";
      const apiKeyEnv = typeof item.apiKeyEnv === "string" ? item.apiKeyEnv.trim() : "";
      const inlineApiKey = typeof item.apiKey === "string" ? item.apiKey.trim() : "";
      const apiKey = clean(apiKeyEnv ? environment[apiKeyEnv] : undefined, inlineApiKey);
      const adapter = isAdapter(item.adapter) ? item.adapter : "generic";
      if (!id || !name || !endpoint || !model) return [];
      return [{ id, name, endpoint, model, apiKey, adapter, keyEnv: apiKeyEnv || undefined }];
    });
  } catch {
    return [];
  }
}

export function getServerModelConfigs(environment: ModelEnvironment = process.env): ServerModelConfig[] {
  const standard = STANDARD_MODELS.map((definition) => ({
    id: definition.id,
    name: definition.name,
    adapter: definition.adapter,
    keyEnv: definition.keyEnv,
    apiKey: clean(environment[definition.keyEnv]),
    endpoint: clean(environment[definition.endpointEnv], definition.defaultEndpoint),
    model: clean(environment[definition.modelEnv], definition.defaultModel),
  }));
  const seen = new Set(standard.map((item) => item.id));
  return [...standard, ...customModels(environment).filter((item) => !seen.has(item.id))];
}

export function getModelConfig(id: string, environment: ModelEnvironment = process.env): ServerModelConfig | undefined {
  return getServerModelConfigs(environment).find((item) => item.id === id && item.apiKey.length >= 8);
}

export function getPublicModelConfigs(environment: ModelEnvironment = process.env): PublicModelConfig[] {
  return getServerModelConfigs(environment).map(({ id, name, model, apiKey, keyEnv }) => ({
    id,
    name,
    model,
    configured: apiKey.length >= 8,
    hint: apiKey.length >= 8 ? "已从服务器安全配置载入" : `在 .env.local 或站点服务器设置 ${keyEnv || "对应的 API Key"}`,
  }));
}
