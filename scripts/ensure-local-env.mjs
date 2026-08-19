import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const envPath = join(process.cwd(), ".env.local");

if (!existsSync(envPath)) {
  writeFileSync(
    envPath,
    `# Pocket Holdem 本地模型配置\n# 只填写你实际使用的供应商；保存后重启开发服务。\n\nOPENAI_API_KEY=\nOPENAI_MODEL=gpt-4.1-mini\nOPENAI_API_ENDPOINT=https://api.openai.com/v1/chat/completions\n\nDEEPSEEK_API_KEY=\nDEEPSEEK_MODEL=deepseek-v4-flash\nDEEPSEEK_API_ENDPOINT=https://api.deepseek.com/chat/completions\n\nMINIMAX_API_KEY=\nMINIMAX_MODEL=MiniMax-M2.7\nMINIMAX_API_ENDPOINT=https://api.minimax.io/anthropic/v1/messages\n\nKIMI_API_KEY=\nKIMI_MODEL=kimi-k2.6\nKIMI_API_ENDPOINT=https://api.moonshot.cn/v1/chat/completions\n\nGLM_API_KEY=\nGLM_MODEL=glm-5.2\nGLM_API_ENDPOINT=https://open.bigmodel.cn/api/paas/v4/chat/completions\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log("已创建 .env.local，请填写 API Key 后重启服务。\n");
}
