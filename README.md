# Pocket-Holdem

Pocket-Holdem 是一款极简风格的德州扑克网页游戏：暖白、灰色和炭黑界面，支持本地单机、AI 观战、局域网联机、内置 AI 和可选的外部模型对手。

## 游戏内容

- 2–6 人无限注德州扑克，支持盲注轮换、边池、全下、烧牌和标准牌型结算。
- 本地 AI 每个对手都有独立的打法技能；“深度思考”开关会同时提升本地 AI 的蒙特卡洛模拟预算和外部模型的推理档位。多人桌会按仍在局的对手数缩放模拟次数，让每次决策的耗时保持稳定。
- AI 观战模式：全部席位都是 AI，可统一或逐席位指定使用哪个 AI，随时暂停或结束。
- 可选 30 / 120 / 300 秒统一行动时限。
- 联机模式支持私人房间、局域网加入、真人与 AI 混合席位（可为 AI 席位单独指定模型）及房间聊天。
- 桌面和手机浏览器自适应。

## 发牌与行动规则

牌局采用标准无限注德州扑克流程：

- 每手按钮位顺时针轮换；多人桌由按钮左侧第一位活跃座位先收第一张底牌，按钮位收到每轮最后一张底牌。
- 单挑时按钮同时是小盲，翻牌前按钮先行动，翻牌后按钮最后行动。
- 每位玩家两张暗牌；翻牌前行动结束后烧一张发三张公共牌，转牌和河牌前各烧一张再发一张。
- 全下后自动按相同的烧牌和公共牌顺序补完牌面，最后按标准牌型、边池和奇数筹码规则结算。

## 亮牌规则

默认按国际赛事惯例（TDA 规则 15–17）公开信息：

- 进入摊牌的玩家必须亮出底牌，由牌面决定胜负；靠他人全部弃牌拿下底池时不需要亮牌。
- 每手结束的复盘会显示桌面 5 张公共牌，以及按上面规则应当公开的玩家底牌与成牌。
- 设置里的“亮牌与复盘”可切换为“全部底牌”，复盘时展示所有人的底牌，用于训练和分析。
- 已公开的底牌、公共牌以及各座位真实的决策用时都会作为公开信息传给 AI 模型，用来修正对手范围；未公开的底牌不会传给任何模型。

## AI 观战模式

在大厅选择“AI 观战”，全部席位都由 AI 接管：

- 席位使用已配置技能的对手名字（Iris、Mira、Knox、Aria、Theo、Nova），不会出现“我”或“你”。
- AI 来源可以统一指定一个，也可以逐席位分别指定本地 AI 或任意已配置的外部模型。
- 选定模型后会像本地对局一样立刻做一次连接测试，卡片上显示“检测中 / 已连接 / 不可用”，配置面板里能看到每个席位的测试结果，也可以手动“检测连接”重测。
- 牌桌底部的“暂停观战 / 继续观战”可以随时停下 AI 的行动，也可以直接结束这场牌局。
- 观战默认全程亮出所有底牌。关闭“观战全程亮牌”后牌桌只显示暗牌；无论开关如何，点击某个座位的牌都会展开这一手的底牌，再点一次收起。

## 本地使用

需要 Node.js 22 或更高版本。

从 GitHub 下载 ZIP 后，先解压，并在终端进入解压出来的项目目录（通常叫 `Pocket-Holdem-main`）。GitHub 不会包含 `node_modules`，所以第一次启动必须先安装依赖：

```bash
cd Pocket-Holdem-main
npm install
npm run dev
```

如果使用 Git 克隆，则把第一行替换为：

```bash
git clone https://github.com/Jackknifer/Pocket-Holdem.git
cd Pocket-Holdem
```

`npm install` 只需在首次下载后运行一次；如果跳过它，启动时会出现 `env: vinext: No such file or directory`。启动成功后，浏览器打开 `http://localhost:3000`，进入大厅后选择“本地对局”“AI 观战”或“联机对局”。联机时，把终端显示的 `Network` 地址分享给同一局域网内的其他设备即可。

首次运行会自动创建根目录下的 `.env.local`。如果终端提示“尚未安装项目依赖”，先运行 `npm install`，再运行 `npm run dev`。

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

本地对局的“模型对手”卡片、AI 观战的席位配置和联机房间的 AI 席位使用同一种弹出式模型列表：每行显示供应商、具体模型名，当前选中的一项带勾号。选中后会自动做一次连接测试，卡片上会显示“检测中 / 已连接 / 不可用”，失败时给出具体原因；观战的配置面板还可以手动点“检测连接”重测。

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
