# Pocket-Holdem

Pocket-Holdem 是一款极简风格的德州扑克网页游戏：暖白、灰色和炭黑界面，支持本地单机、局域网联机、内置 AI 和可选的外部模型对手。

## 游戏内容

- 2–6 人无限注德州扑克，支持盲注轮换、边池、全下、烧牌和标准牌型结算。
- 本地 AI 使用固定最高强度策略；每个对手有独立的打法技能。
- 可选 30 / 120 / 300 秒统一行动时限。
- 联机模式支持私人房间、局域网加入、真人与 AI 混合席位及房间聊天。
- 桌面和手机浏览器自适应。

## 本地使用

需要 Node.js 22 或更高版本。

```bash
git clone https://github.com/Jackknifer/Pocket-Holdem.git
cd Pocket-Holdem
npm install
npm run dev
```

首次运行时，项目会自动创建根目录下的 `.env.local`。浏览器打开 `http://localhost:3000`，进入大厅后选择“本地对局”或“联机对局”。联机时，把终端显示的 `Network` 地址分享给同一局域网内的其他设备即可。

```bash
npm run lint
npm test
```

## 配置 AI 模型

API 配置只保存在本机服务端，不在网页中填写，也不会上传到 GitHub。

按下面步骤配置：

1. 先运行一次 `npm run dev`，让项目自动创建 `.env.local`。
2. 在项目根目录打开 `.env.local`。macOS 可以运行 `open -e .env.local`；Finder 中按 `Command + Shift + .` 可以显示这个隐藏文件。
3. 只填写你要使用的模型对应的 `API_KEY`、`MODEL` 和 `API_ENDPOINT`。
4. 保存文件后，在运行服务的终端按 `Control + C` 停止服务，再重新运行 `npm run dev`。
5. 回到大厅，打开模型选择器；显示为可用的模型即可作为 AI 对手使用。

例如配置 DeepSeek：

```env
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_API_ENDPOINT=https://api.deepseek.com/chat/completions
```

其他供应商使用以下变量：

```env
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
OPENAI_API_ENDPOINT=https://api.openai.com/v1/chat/completions

MINIMAX_API_KEY=
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_API_ENDPOINT=https://api.minimax.io/anthropic/v1/messages

KIMI_API_KEY=
KIMI_MODEL=kimi-k2.6
KIMI_API_ENDPOINT=https://api.moonshot.cn/v1/chat/completions

GLM_API_KEY=
GLM_MODEL=glm-5.2
GLM_API_ENDPOINT=https://open.bigmodel.cn/api/paas/v4/chat/completions
```

模型名可以直接修改为账号有权限使用的型号，例如 `MiniMax-M3`。如果模型没有显示为可用，请检查 API Key、模型名和接口地址，并确认已重启开发服务。API Key 只由本地服务端读取，浏览器不会接收或保存。

## 开源安全

仓库包含完整游戏源码、API 路由和模型适配器，但不包含真实 API Key、`.env.local`、本地 Wrangler 状态、构建产物或部署元数据。项目采用 MIT License。
