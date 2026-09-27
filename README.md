# ZZCSAPI — 本地多渠道 AI 聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，**零依赖，仅 Node 18+**。
把所有中转 API key 集中在一处，对外同时暴露 **OpenAI / Anthropic / Gemini** 三种兼容端点。

## 特性

- 🚦 **多协议、多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：4xx 客户端错误之外，遇到 5xx / 超时 / 网络错误立刻试下一个渠道
- 🛡 **熔断冷却**：连续失败的渠道进入指数退避冷却期（1s, 2s, 4s ... 上限 60s）
- 🔍 **后台健康探测**：定时 GET 渠道的 models 端点，聚合 latency / 状态 / 真实模型清单
- 🌊 **流式透传**：SSE 全程转发；上游响应是 OpenAI 协议时自动转成 Anthropic/Gemini 流
- 🔐 **双层鉴权**：`GATEWAY_KEY`（客户端）+ `ADMIN_KEY`（控制台与管理 API）；未设置则**首启自动生成**随机密钥（日志可查、写入 config.json）
- 🖥 **Web 控制台**：浏览器打开 `http://127.0.0.1:8787/console` 看渠道状态、改优先级、启停渠道
- 📊 **统一模型清单**：`/v1/models`、`/anthropic/v1/models` 自动合并各协议所有可用模型

## 快速开始

### 方式一：Docker（推荐）

```powershell
# usage.json 是运行时持久化文件，不入仓库，首次部署先由模板生成
Copy-Item usage.example.json usage.json
docker compose up -d --build
# 控制台 http://127.0.0.1:8787/console
# 首次启动的 ADMIN_KEY / GATEWAY_KEY 打印在容器日志里：docker logs zzcsapi | grep ADMIN_KEY
# 想固定自己的密钥：根目录建 .env 写 ZZCSAPI_ADMIN_KEY=... / ZZCSAPI_GATEWAY_KEY=...
```

`docker-compose.yml` 挂载 `./config.json` 和 `./usage.json`。
⚠️ 这两个文件都**必须先在宿主机上存在**：`config.json` 由 `server.js` 首次运行自动从 `config.example.json` 生成；
`usage.json` 需要手动从 `usage.example.json` 复制。**若缺失，Docker 会把挂载点建成目录**，
服务不会崩（`ensureUsage` 有兜底），但用量统计将**无法落盘、每次重启归零**，且不易察觉。
`usage.json` 已列入 `.gitignore`（每次请求都会改写，提交它只会产生噪声 diff）。

### 方式二：裸 Node（18+）

```bash
# 1) 首次运行自动从 config.example.json 生成 config.json
node server.js

# 2) 编辑 config.json 填入真实渠道，再重启
node server.js
```

可选环境变量：

```bash
GATEWAY_KEY=xxx  node server.js    # 客户端必须带 Bearer xxx
ADMIN_KEY=yyy    node server.js    # 控制台 + /admin/* 必须带 Bearer yyy
ZZCSAPI_NOAUTH=1 node server.js    # 本地开发：完全关闭鉴权（仅限本机自用）
```

**密钥从哪来（分享/分发友好）**：

1. **显式设置** `ADMIN_KEY` / `GATEWAY_KEY` 环境变量 → 以你设置的为准（compose 场景写进 `.env` 的 `ZZCSAPI_ADMIN_KEY` / `ZZCSAPI_GATEWAY_KEY`）；
2. **没设置** → 首次启动自动生成 48 位随机密钥，**打印到容器日志**（`docker logs zzcsapi | grep ADMIN_KEY`）并写回 `config.json`（重启不变）；
3. **想换** → 环境变量优先级最高；或删掉 `config.json` 里的 `adminKey`/`gatewayKey` 后重启（会重新生成）。

只有显式开启 `ZZCSAPI_NOAUTH=1` 才完全不鉴权——否则密钥恒存在，不再有"空密钥 = 谁都能进"的洞。

## 在 DSH / Cursor / Cline 等客户端里配置

### OpenAI 协议
```
baseURL = http://127.0.0.1:8787/v1
apiKey  = <GATEWAY_KEY 的值；未显式设置时看容器日志里首启生成的那一串>
model   = <channels[*].models 里 alias，左边的键>
```

### Anthropic 协议（DSH 的 Anthropic 兼容地址）
```
baseURL = http://127.0.0.1:8787/anthropic
apiKey  = <GATEWAY_KEY>
model   = <alias>
```

> 鉴权三种写法都认：`Authorization: Bearer <GATEWAY_KEY>`、`x-api-key: <GATEWAY_KEY>`（**Anthropic SDK 的默认头**）、`?key=<GATEWAY_KEY>`。

### Gemini 协议
```
baseURL = http://127.0.0.1:8787/gemini/v1beta
apiKey  = <GATEWAY_KEY>
```

> **鉴权**：`x-goog-api-key: <GATEWAY_KEY>`（**Gemini SDK 的默认头**）、`?key=<GATEWAY_KEY>`、`Authorization: Bearer` 都行。
> **支持图片**：`parts` 里的 `inlineData`（base64）与 `fileData`（`fileUri` 直链）都会转成上游的图片块转发，
> 部件顺序保留。带图请求只走 `openai` 协议渠道（其余协议链会静默丢图，故被「图片能力门」裁掉）——
> 详见 [含图请求的候选裁剪](#含图请求的候选裁剪图片能力门)。

## Web 控制台

```
http://127.0.0.1:8787/console
```

首次打开会出一个「输入管理密钥」的小门，把 `ADMIN_KEY` 粘贴进去即可（页面记住它，之后**裸开 /console 就行**）。
也兼容一次性带参访问 `http://127.0.0.1:8787/console?key=YOUR_ADMIN_KEY`（key 会被收进浏览器并自动从地址栏抹掉，避免留在历史/截图里）。

> 控制台 HTML 壳本身不含任何密钥（零机密），放行；**管理 API 每次调用仍强制校验 Bearer**——"页面能开 ≠ 有权限"。
> 密钥失效（例如服务端换了密钥）时，页面会自动清掉旧密钥并重新弹门。

可做：

- 实时看每个渠道的健康 / 延迟 / 错误 / 探测时间
- 改 priority、启停某个渠道
- 触发单渠道或全量重新探测
- 看每个协议聚合后的模型清单

## 前端代码文档

> ⚠️ **强制约定：改代码必须同步改文档**（无论改动来自谁）。完整规则见 [`AGENTS.md`](AGENTS.md)。

### 前端文件与构建管线

生产控制台 `console.html` **不是手写的，是构建产物**：

```
node build/build.js
```

```
console-redesign.html ──(取 <style> 原文，逐字节复制)──┐
                                                      ├─→ console.html  (提交进仓库，server.js 直接读)
build/head.html   (到 <style> 为止的 head)            │
build/shell.html  (body 骨架：rail / topbar / viewport / drawer / mask)
build/app.js      (数据层 + 动作层 + 渲染，真实请求 /admin/api/*)
build/extra.css   (设计稿没覆盖的生产独有组件，全部复用设计令牌)
```

| 文件 | 角色 |
| --- | --- |
| `console-redesign.html` | **视觉唯一真源**（高保真静态原型，单文件零依赖，不请求后端，数据来自文件内 `DATA` 快照） |
| `build/head.html` · `build/shell.html` · `build/extra.css` · `build/app.js` | 生产适配层：骨架、生产独有样式、真实数据与交互 |
| `build/build.js` | 组装脚本（构建期自检：产物中 `</style>` 唯一 + head/shell 行数守卫，锚点漂移构建期爆错） |
| `console.html` | **构建产物**，已提交进仓库。**不要手改**——下次构建会被覆盖 |

**因此：改视觉/字号/留白/圆角 → 改 `console-redesign.html` 的 `<style>` → 重新 `node build/build.js`。**
改完请确认 `console.html` 同步更新（构建是覆盖式的，忘了构建就等于没改）。

> 生产与原型**变量名完全相同**（生产直接复用设计稿 CSS），不存在映射表。
> 生产独有能力（genspark 双导入、渠道级自定义请求头、密钥掩码↔明文切换、有效优先级角标、
> 真实测试/导入/Playground 请求）原型里没有，**原型不必追平**。

改前端前请先读这两份文档：

| 文档 | 用途 |
| --- | --- |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计文档](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | **动代码前过目**：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查）、前端独立审查 |

改完前端跑一遍自动化回归（零依赖，一条命令）：

```bash
node test/console-state.test.js           # 57 项断言，退出码非 0 = 有回归（含渠道表单权重：能填 → 能存 → 能显示；自动权重观测卡渲染）
node test/gemini-multimodal.test.js       # 41 项断言：图片转换 / 候选裁剪 / 原生 SDK 鉴权头（单元级）
node test/gemini-multimodal-e2e.test.js   # 22 项断言：真起「假上游 + 临时网关」，走完整 HTTP 链路（约 5 秒）
node test/anthropic-tools.test.js         # 60 项断言：Anthropic tool_use ↔ OpenAI tool_calls（含工具结果带图、id 往返、有状态流式）
node test/anthropic-tools-e2e.test.js     # 30 项断言：两轮工具回合（要工具 → 回传结果）真 HTTP 链路
node test/streaming-e2e.test.js           # 19 项断言：三协议流式（首块不丢字节 / 事件序列 / 收尾兜底）
node test/weighted-rr.test.js             # 31 项断言：加权轮询算法（3:1→75/25、平滑性、老配置零影响对照）
node test/weighted-rr-e2e.test.js         # 12 项断言：真 HTTP 数落点，验证实际分流比例与降级行为
node test/native-channels.test.js         # 78 项断言：原生出站双向转换（请求/响应/流式状态机/URL 鉴权头/错误体不翻译）
node test/native-channels-e2e.test.js     # 33 项断言：原生假上游 × 三条客户端路由，验证上游真的收到原生报文
node test/console-weight-e2e.test.js      # 18 项断言：控制台表单报文 → 真网关落库 → 真流量分流 → 表格那一格显示出来
node test/auto-weight.test.js             # 61 项断言：自动权重算法（健康系数/地板/死区平滑/份额封顶）＋**静默不变式**（观测不许改分流）
node test/auto-weight-e2e.test.js         # 29 项断言：真流量下预测会变、分流一字未动、配置往返旋钮不丢
```

它守住的是**「视口内输入控件的值必须跨重绘保留」**这条约定：控制台每 8 秒轮询一次，
`render()` 会重建当前页整个 DOM，输入控件的值只存在 DOM 里就会被重建为空
（表现：搜索词/草稿"一会儿自己没了"，PT22 / detailed §8.11）。
做法是从 `build/app.js` 现抠真实的渲染函数源码，在最小 DOM 桩里跑「输入 → 再渲染」并断言值仍在；
**新增带输入框的页面时请顺手补一条用例**（改名 `vModels` 等函数会让它报错，这是刻意的提醒）。

`test/gemini-multimodal.test.js` 守的是**「图片不能在翻译层被静默丢掉」**：它从 `server.js` 现抠
`geminiToOpenAI` / `bodyHasImages` / `filterCandidatesForImages` / `checkAuth` 的真实源码跑断言（也是零依赖，
两个协议命名变体、部件顺序、纯文本回退形态、能力门裁剪、原生 SDK 鉴权头与"管理面无提权"都在内）。

`test/gemini-multimodal-e2e.test.js` 是它的**端到端姊妹**：真起一个假上游 + 临时网关实例（**动态空闲端口**，
配置与用量写在系统临时目录，**绝不碰仓库里的 `config.json` / `usage.json`**，不出网、不烧额度），
验证客户端协议 → 网关 → 上游的实际字节与响应形态。单元级测试覆盖不到「函数都在、就是接头不对」的缺陷——
PT23（非流式 shim 缺 `json()`）就是被这个脚本一次性抓到的。


## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },
  "channels": [
    {
      "id": "vendor-a-openai",
      "name": "中转A (OpenAI)",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "protocol": "openai",                  // openai | anthropic | gemini
      "priority": 10,                        // 顺序：谁先试、谁兜底
      "weight": 3,                           // 分流：同模型候选里按比例轮询（不填/0 = 不参与，见「加权轮询」）
      "enabled": true,
      "proxy": "http://host.docker.internal:7897",  // 可选：HTTP 代理（见下方说明），留空/删掉 = 直连
      "models": {                            // alias -> upstream
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini"
      }
    },
    {
      "id": "vendor-anthropic",
      "name": "Anthropic 中转",
      "baseUrl": "https://api.example-c.com",
      "apiKey": "sk-ant-xxx",
      "protocol": "anthropic",
      "priority": 10,
      "models": {
        "claude-3-5-sonnet": "claude-3-5-sonnet-20241022"
      }
    },
    {
      "id": "vendor-gemini",
      "name": "Gemini 中转",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza-xxx",
      "protocol": "gemini",
      "priority": 10,
      "models": {
        "gemini-1.5-pro": "gemini-1.5-pro-latest"
      }
    }
  ]
}
```

> **渠道字段 `proxy`（可选）**：HTTP 代理地址（如 `http://host.docker.internal:7897`，容器经宿主机代理出网）。
> 对 `openai / anthropic / gemini / workbuddy / codex / genspark` 协议生效——**探测、测试、聊天全部经代理转发**（curl `-x` 子进程，undici fetch 不走代理）。
> 注意两点：流式响应经代理会**整体缓冲后一次性回放**（首字节延迟 ≈ 上游总耗时，与 CF 回退同款语义）；代理挂了渠道探测即失败、进冷却（诚实失败，不静默直连）。
> `notion` / `notion-agent` 不支持代理（官方 API 直连）。

### 协议说明

| protocol       | 探活 URL                  | 鉴权头              | 出站报文（网关发给上游）              | 网关对外路径                          |
| -------------- | ------------------------- | ------------------- | ------------------------------------- | ------------------------------------- |
| `openai`       | `GET /models`             | `Authorization: Bearer ...` | OpenAI 格式，原样转发          | `/v1/chat/completions` 之类     |
| `anthropic`    | `GET /v1/models`          | `x-api-key: ...` + `anthropic-version` | **原生 Anthropic 格式**：`POST /v1/messages` | `/anthropic/v1/messages`              |
| `gemini`       | `GET /v1beta/models`      | `x-goog-api-key: ...` | **原生 Gemini 格式**：`POST /v1beta/models/{model}:generateContent` | `/gemini/v1beta/models/{m}:{action}` |
| `notion`       | `POST getSpaces`          | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query`  | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） | Notion 官方 Agent API（公开 beta） |
| `arena`        | —                        | —                    | **已撤**：Arena.ai 逆向已整体移除（见 docs/arena-protocol.md 留档）  | **已撤**：Arena.ai 逆向已整体移除（见 docs/arena-protocol.md 留档）  |
| `workbuddy`    | 自检 `chat/completions`   | `Authorization: Bearer ...` | WorkBuddy 逆向（**必须走 curl 子进程**：上游对 Node/undici 的 TLS 指纹直接 ECONNRESET） | WorkBuddy 逆向（**必须走 curl 子进程**：上游对 Node/undici 的 TLS 指纹直接 ECONNRESET） |
| `codex`        | 一次令牌刷新             | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） |
| `genspark`     | `GET /api/is_login`      | `Cookie: session_id=...` | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期） | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期） |

#### 原生出站：`anthropic` / `gemini` 协议渠道可以直接聊天了

`protocol` 现在**同时决定出站报文格式**。以前它只管探活方式和对外路由，出站一律 OpenAI 格式 —— 于是「声明成 anthropic 协议的渠道」拿去敲 `/v1/messages` 必然 400，等于配了也用不了（Gemini 同理）。

现在两条方向都通了，**客户端说哪套协议、渠道讲哪套协议，互不绑定**：

| 客户端来的协议 | 渠道是 `openai` | 渠道是 `anthropic` | 渠道是 `gemini` |
| --- | --- | --- | --- |
| OpenAI（`/v1/chat/completions`） | 直通 | 转原生 `/v1/messages` | 转原生 `:generateContent` |
| Anthropic（`/anthropic/v1/messages`） | 转 OpenAI 出站 | 转原生再转回 Anthropic 响应 | 转原生 Gemini 出站 |
| Gemini（`/gemini/v1beta/...`） | 转 OpenAI 出站 | 转原生 Anthropic 出站 | 转原生 `:streamGenerateContent?alt=sse` |

- **怎么配**：`"protocol": "anthropic"` + `baseUrl`（如 `https://api.anthropic.com`，写不写 `/v1` 都认）+ `apiKey`；Gemini 填 `https://generativelanguage.googleapis.com`（`/v1`、`/v1beta` 都认）。模型行照旧：alias 是**客户端请求的名字**，上游是**真实模型名**（Gemini 会拼进 URL 路径）。
- **转发什么**：`system/developer` → 顶层 `system`（Anthropic）/ `systemInstruction`（Gemini）；`tool_calls` ⇄ `tool_use`（Anthropic）/ `functionCall`（Gemini）；工具结果 → `tool_result` / `functionResponse`（Gemini 按**函数名**配对，自动从上一轮工具调用里查）；图片 → `image` 块（base64/url）/ `inlineData`、`fileData`；`max_tokens`→`max_output_tokens`/`maxOutputTokens`；`stop`→`stop_sequences`/`stopSequences`；流式 → Anthropic 事件 / `alt=sse`。
- **上游报错照样原样返回**：错误体（如 `{"type":"error",...}`）不做翻译 —— 否则 400 会被伪装成"成功但空"的 200，最难查。
- **有损的地方（诚实说明）**：`tool_choice: "none"` 在 Anthropic 侧表达不了（保留 tools 就等于 auto，因此**直接去掉 tools**）；Anthropic 的 `cache_control`、`top_k`、thinking 签名在跨到内部 OpenAI 格式时会丢；`tool_use.id` 会被清洗成合法字符。原生渠道与客户端同为 Anthropic 时也走这一遍转换（不做同协议直通）。
- **调度顺序**：三种协议**同协议优先、跨协议在后**（`openai` 渠道仍然先被选中），原生协议渠道作为候选链尾部一层兜底，不影响你现有 `openai` 渠道的先后顺序。

> 中转渠道如果用 OpenAI 兼容但 `protocol` 想挂到 Anthropic 端点用，把 `protocol` 设成 `anthropic` 即可——网关会把请求体自动转成 OpenAI 格式丢给它，再把响应转回 Anthropic 格式。同理 Gemini。

#### notion-agent（Notion 官方 Agent API）

调用 Notion 工作区的 Custom Agent（需要 Business/Enterprise 版工作区，在 Notion 网页聊天侧栏创建代理）。

- **Base URL**：`https://api.notion.com`
- **API Key**：**集成令牌**（开发者门户 → 我的集成 → 复制内部令牌 `ntn_...`），且集成的能力必须勾选「**查看会话并与代理交互**」（测试版）
- ⚠️ **个人访问令牌（PAT）不行**：PAT 能列代理、能建会话，但执行时会被服务端直接拒绝（`session_failed`，零 credits 消耗）——这是令牌能力限制，不是配置错误
- **模型行**：alias 填对外模型名（如 `gpt-6-astra`），上游填**智能体名称**（如 `Magnificent Pioneer`）；一个智能体锁定一个模型，多个模型就建多个代理
- 会话中智能体的确认门（requires_action）自动批准（最多 5 次）
- 每次对话消耗工作区 AI credits，因此 notion-agent 渠道排在调度兜底链**最后**，仅当 openai/notion 渠道都失败时才启用

#### genspark（Genspark 网页会话反代）

把 Genspark 网页版的登录态当渠道用，走 `llm_proxy` 免费额度（详细逆向过程见 [`docs/genspark-claw-reverse-proxy-research.md`](docs/genspark-claw-reverse-proxy-research.md)）。

- **Base URL**：`https://www.genspark.ai`
- **API Key**：网页会话的 `session_id`（不是 JSON 里的 `gsk-` apiKey）。服务端会补全成 `session_id=…; agree_terms=1; gslogin=1`
- **代理必填**：容器经宿主机代理出网（如 `http://host.docker.internal:7897`），否则过不了地区门
- **探活**：`GET /api/is_login`，**免费、不消耗 credit**；网页端没有 models 接口，模型清单来自渠道别名配置
- **导入**：控制台「导入 genspark」（粘贴 session.enc JSON / 整段 cookie / 裸 session_id）或「导入 genspark JSON」（多选文件批量）→ `POST /admin/api/genspark-import`
  - `mode:'replace'`（默认）：覆盖首个 genspark 渠道的 key
  - `mode:'add'`：**一个会话建一个渠道**（多号 = 多份每日积分）；key 已存在则视为刷新
- ⚠️ **session 约 20 天过期**，过期后网页端重新登录、再导一份即可
- 请求头伪装：`User-Agent` / `Origin` / `Referer` / `request-id` / `traceparent`，SSE 聚合后再分发

## 调度顺序

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias
   · **协议匹配 = 同协议优先，跨协议兜底**：三条客户端路由都能用 `openai` / `anthropic` / `gemini` 三种协议的渠道
     （出站自动转原生格式，见「原生出站」），但**先在同协议的渠道里选**，同协议没有/都失败才用另外两种协议，
     最后才是 notion → notion-agent → workbuddy → genspark → codex 这些文本链兜底。
     你现有的 `openai` 渠道先后顺序因此**完全不受影响**（原生协议渠道只是候选链尾部多出来的一层）。
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数；同状态按**有效优先级**降序，再看 latency
4. **加权轮询**：填了 `weight` 的渠道按权重比例决定"谁排第一"（见下）
5. **含图请求**先按「图片能力门」裁剪候选（见下）；纯文本请求不受影响
6. 依次尝试直到成功；全部失败返回 502 + 错误详情

### 加权轮询（`weight`，真正的按比例分流）

`priority` 与 `weight` 分工不同，别混：

| 字段 | 管什么 | 语义 |
| --- | --- | --- |
| `priority` / `effPriority` | **顺序** | 谁先试、谁兜底（排序语义） |
| `weight` | **分流** | 同一模型候选里按权重比例决定谁排第一（分流语义） |

- **只有明确填了正数 `weight` 的渠道参与轮询**；不填（缺省 `0`）时行为与从前**完全一致**，老配置零影响。
  `weight: 0` 与不填等价（只做兜底，不参与分流）。
- 参与轮询的渠道来自**同一 (模型, 协议) 的候选集**，按权重比例分流：两个渠道 `3:1` ⇒ 长期 ≈ 75% / 25%。
- 算法是**平滑加权轮询**（nginx upstream 同款 smooth WRR，无随机数）：长期比例精确等于权重比，
  且**不会突发扎堆**（纯加权随机会连着命中同一个渠道）。
- 轮询只决定**谁是第一位**；其余候选保持原有「健康度 → 有效优先级 → 延迟」顺序作**兜底链**
  （如果轮到的那家正好挂了，下一个还是按老规矩顶上来）。图片生成候选（`/v1/images/generations`）同一套规则。
- 冷却中 / `status=down` / `weight=0` 的渠道**不进池**，其份额自动分给健康成员；
  它恢复后也不会"补发欠账"（不出现报复性突发）。
- 状态是内存态（重启清零，无副作用）。改权重三种方式，效果一样：
  · **控制台**：渠道页 → 该渠道「编辑」→ 表单里的「权重」框（留空 = 0 = 不参与），保存即生效并持久化；
  · 直接改 `config.json` 的 `"weight": 3` 后重启；
  · `POST /admin/api/channel` 带 `{id, weight}` ⇒ **立即生效并持久化，无需重启**。
- 可观测：`/admin/api/status` 每个渠道返回 `weight`（配置值）、`weightedHits`（被选中次数）、
  `weightedShare`（占全部加权轮询命中的百分比）；控制台**渠道表格有「权重 / 分流」列**（`3 · 24%`，
  悬停看命中次数），**渠道详情抽屉**顶部另有角标。没配权重的渠道显示 `—` 而不是 `0%`
  ——`0%` 会被误读成"配了但一次都没分到"。
- 权重接受任意非负数字（整数最好懂：`3:1` 就是 75/25；小数同样按比例算）。负数、非数字在控制台表单里
  就被挡下（不会发请求），绕过前端直接调接口也会被后端拒（400）——两边校验规则一致。

### 自动权重（观测版：只算不生效）

想让"同一个模型有很多渠道都提供、有的能用有的不能用、有的快有的慢"这件事**自动**按实测表现分流，
不用手填 `weight`。v1.6 先上**观测版**：后端按真实数据算出"若启用会怎么分"，控制台看得见，
但**一行都不碰真实路由**——手工 `weight` 仍是唯一生效的份额依据，不填就是零影响。

> **为什么不直接生效**：自动权重天然有反馈回路（份额改流量 → 流量改统计 → 统计改份额），
> 先让人对着真机数据确认它算得对，再打开开关，是成本最低的顺序。
> 所以配置里的 `"enabled": true` 目前**也只是把观测数据标成"已启用"**，不会改变分流；
> 真正的生效版本会在 README 与 `effective` 字段上同时声明。

**健康系数 `h`（0.2 ~ 1）** 由两个**已有**信号合成，不引入新统计：

| 信号 | 来源 | 作用 |
| --- | --- | --- |
| 成功率 | 滚动窗口 `ch.roll`（与「有效优先级」同一个窗口） | **主力**：`h = 1 − 失败率` |
| 速度 | 该渠道最近成功请求的延迟指数平均（EWMA） | **温和**惩罚：慢 2 倍只打到 `0.75`（默认 `latencyPenalty: 0.5`） |

**抗振荡三件套**（自动调权最怕的就是抖）：低频重算（`updateMs` 默认 30 秒）+ 指数平滑（`ewma` 0.5）+
死区（变化小于 `deadband` 10% 就不动）。另有四条护栏：

- **失败率样本不足不动**（`minSamples` 默认 10 条）：新渠道不被几次随机失败打死；
  注意**只管失败率这一项**——样本不足时该项按"满分 1"算，但**速度项仍独立生效**
  （所以一个刚上线、样本为 0 但延迟很慢的渠道，`h` 仍可能 < 1；这是刻意的，实测延迟不需要攒样本就够可信）；
- **地板**（`floor` 默认 0.2）：慢/差也不给 0——"慢"常常是长上下文模型在思考，饿死它反而丢质量；
- **单渠道上限**（`maxShare` 默认 70%）：防赢家通吃（最快的被打爆后反而更慢）。
  上限**只兜自动算出来的份额**；用户手填的 `weight` 永不封顶（手填是硬意图，护栏不该反过来压制它）；
- **冷却 / `down` 的渠道直接排除**（本来就进不了池），其份额分给健康成员。

配置项（`config.json` 顶层，全部可选，`config.example.json` 里有全量示例）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 预留开关：本版置 `true` 也只影响观测数据的标注，不改变分流 |
| `minSamples` | `10` | 滚动窗口样本少于它就**不按失败率扣分**（速度项不受此门槛约束） |
| `floor` | `0.2` | 健康系数地板 |
| `latencyPenalty` | `0.5` | 速度惩罚强度；`0` = 完全不看速度 |
| `maxShare` | `70` | 自动份额的单渠道上限（%）；手填权重不受限 |
| `updateMs` | `30000` | 健康系数重算间隔（毫秒，最小 1000） |
| `ewma` | `0.5` | 新值权重（指数平滑） |
| `deadband` | `0.1` | 死区（相对变化小于它就不动） |

可观测与界面：

- `/admin/api/status` 新增顶层 `autoWeight`：`enabled` / **`effective`（恒 `false`，一眼看出没生效）** /
  `knobs` / `at` / `models[]`。每个 `models` 条目 = 一个"被多个渠道提供的模型"：
  `candidates[]` 里给出预测份额 `share`、健康系数 `h`、基础权重 `base`、是否手填 `manual`、
  当前手工份额对照 `nowShare`、以及**判断依据**（`failRate` / `samples` / `latMs` / `speedRatio`）；
  `excluded[]` 是冷却或 down 而没参与分份额的候选；`manualOff` 表示当前压根没开加权轮询。
- 每个渠道新增 `autoH` / `autoFailRate` / `autoSamples` / `autoLatMs` / `autoSpeedRatio`。
- **控制台**：渠道页顶部有「自动权重 · 观测」卡，按模型列出预测份额（含"当前 x%"对照与被打折的原因）；
  渠道详情抽屉里有「自动权重（观测 · 只算不生效）」一节，把健康系数、样本数、失败率、延迟摊开。
  单候选模型不进卡（一个提供方谈不上分流，显示了只会是"100%"噪音）。

### 有效优先级（失败率自动降权）

同状态渠道不是死板按配置的 `priority` 排，而是按**有效优先级** `effPriority`：

```
effPriority = priority − 失败率 × 3
```

- 失败率取自**滚动窗口**（`ch.roll = {w,f}`，成功/失败各累加一次，样本 ≥ 5 才开始生效，累计 120 次后减半衰减）
- 也就是说：一个配置 `priority=10` 但近期失败率 40% 的渠道，有效优先级降为 `8.8`，会被配置 `priority=9` 的健康渠道反超
- 失败率回升时被新成功样本稀释，优先级**自动恢复**，不需要人工干预；配置值本身不被改写
- 失败计入点：主调度失败、探测失败都走 `recordUsage` → `bumpRoll`
- 控制台「渠道管理」在渠道被降权时显示 `→ 有效 X（失败率 Y%）` 角标（数据来自 `/admin/api/status` 的 `effectivePriority` / `rollFailRate` 字段）

### 含图请求的候选裁剪（图片能力门）

请求体里带图片时（内部统一格式 = OpenAI，即 `messages[].content` 数组里的 `image_url` block），候选链**只保留能原样/等价转发图片的渠道**：

```
IMAGE_CAPABLE_PROTOCOLS = ['openai', 'anthropic', 'gemini']      # server.js
```

- 三种协议各自的带图出站方式：`openai` 原样转发 `image_url`；`anthropic` 转成 `image` 块（`source.type = base64 | url`）；`gemini` 转成 `inlineData`（data URL）或 `fileData`（http 链接）。
- **为什么必须裁剪**：`notion` / `notion-agent` / `workbuddy` / `genspark` / `codex` 这几条链只把 `content` 当字符串用。把带图请求丢过去，图会被**静默丢掉、模型照样自信作答**——用户以为它看过图。这比直接失败更糟，所以宁可明确报错。
- **裁干净了怎么办**：返回 400 + `this request contains images, but no channel can forward them: only openai / anthropic / gemini protocol channels can carry images`（不是 404、不是降级重试、不是静默丢图）。
- **纯文本零影响**：`bodyHasImages()` 为假时函数原样返回同一个候选数组，排序与老行为逐字节一致。
- 三条客户端协议共用这道门：`/v1/chat/completions`、`/anthropic/v1/messages`、`/gemini/v1beta/...`（Anthropic 的 `image` block 与 Gemini 的 `inlineData`/`fileData` 都先转成内部 `image_url`，因此判定点统一）。
- 回归：`node test/gemini-multimodal.test.js`（含"含图 → 只留可转图渠道 / 纯文本 → 候选链原样"两组断言）+ `node test/native-channels-e2e.test.js`（原生化后仍带图）。

## 端点

| 路径                                | 方法 | 鉴权        | 说明                                  |
| ----------------------------------- | ---- | ----------- | ------------------------------------- |
| `/healthz`                          | GET  | 无          | 网关自身存活探针                      |
| `/console`                          | GET  | admin       | Web 控制台 HTML                       |
| `/admin/api/status`                 | GET  | admin       | 渠道详细状态（控制台用；含 `weight`/`weightedHits`/`weightedShare` 与自动权重观测 `autoWeight`、`autoH` 等字段） |
| `/admin/api/usage`                  | GET  | admin       | 用量统计（总量 / 按模型 / 按渠道 / 按天 / 近 200 条 / 24h 分布） |
| `/admin/api/usage/clear`            | POST | admin       | 清零用量统计                          |
| `/admin/api/recheck`                | POST | admin       | 立即重探测（body 可传 `{id}`）        |
| `/admin/api/channel`                | POST | admin       | 改渠道（`{id, priority?, enabled?, weight?}`，立即生效并持久化） |
| `/admin/api/channels`               | GET  | admin       | 渠道集合完整列表                      |
| `/admin/api/channels`               | POST | admin       | 新增 / 覆盖渠道（upsert，落库并立即探测一次） |
| `/admin/api/channels`               | DELETE | admin     | 删除渠道（body `{id}`）               |
| `/admin/api/probe`                  | POST | admin       | 临时探测上游模型清单（不落库，控制台「获取模型」用） |
| `/admin/api/test`                   | POST | admin       | 真发一次最小 chat 请求，返回首字延迟 / 总耗时 / 错误 |
| `/admin/api/codex-import`           | POST | admin       | 导入 codex 凭据（完整 JSON 或裸 `rt.1.` 开头 RT） |
| `/admin/api/codex-quota`            | GET  | admin       | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import`        | POST | admin       | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config`                 | GET  | admin       | 暴露接入信息（含 key 与 URL），仅本机 admin |
| `/admin/status` / `/admin/recheck`  | */POST | admin    | 旧版兼容路径                          |
| `/v1/models`                        | GET  | gateway     | OpenAI 聚合模型                       |
| `/v1/chat/completions`              | POST | gateway     | OpenAI chat（支持 stream）            |
| `/v1/embeddings`                    | POST | gateway     | 透传                                  |
| `/v1/images/generations`            | POST | gateway     | OpenAI 生图（需上游渠道支持图像接口）  |
| `/v1/responses` / `/v1/completions` | POST | gateway     | 透传                                  |
| `/anthropic/v1/models`              | GET  | gateway     | Anthropic 聚合模型                    |
| `/anthropic/v1/messages`            | POST | gateway     | Anthropic Messages（支持 stream）     |
| `/gemini/v1beta/models/{m}:generateContent`        | POST | gateway | Gemini 非流式（支持 `inlineData`/`fileData` 图片） |
| `/gemini/v1beta/models/{m}:streamGenerateContent`  | POST | gateway | Gemini 流式          |

## 行为细节

- **4xx 重试规则**：`400/422` 等明确请求本身错的不再切渠道，原样透传；`401/402/403/404/408/429` 是渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 切下一候选兜底。404 进兜底名单的动机：渠道「声明有此模型」但上游实际没有（别名表过期）时，下一个声明者很可能真的有。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
- **协议转换**：OpenAI ↔ Anthropic ↔ Gemini 三边都走内部 OpenAI 协议中转；**出站方向也按渠道的 `protocol` 走原生格式**（见「原生出站」），所以任一客户端协议都能打到任一协议的渠道上。
- **原生出站（`protocol: anthropic` / `gemini`）**：请求侧 `system`→顶层 `system`/`systemInstruction`、`tool_calls`→`tool_use`/`functionCall`、工具结果→`tool_result`/`functionResponse`（Gemini 按函数名配对）、图片→`image` 块/`inlineData`・`fileData`、`max_tokens`→`max_output_tokens`/`maxOutputTokens`、`stop`→`stop_sequences`/`stopSequences`；响应侧反向映射（`stop_reason`→`finish_reason`、`usageMetadata`→`usage`、`thinking`→`reasoning_content`）。
  · 流式：Anthropic 原生 SSE 事件与 Gemini `alt=sse` 分片都会**逐行翻译成 OpenAI 分片**，再交给该路由既有的流式转换器；上游异常断流时由收尾逻辑补 `finish_reason` + `[DONE]`（客户端不会一直等）。
  · 上游错误体不翻译（原样透传状态码与消息），避免 400 被伪装成"成功但空"。
  · 有损点：`tool_choice:"none"` 在 Anthropic 侧无对应语义（改为去掉 tools）；`cache_control`/`top_k`/thinking 签名在跨格式时丢弃；同协议（Anthropic 客户端 → Anthropic 渠道）也走一遍转换，不做直通。
- **工具调用（Anthropic tool_use ↔ OpenAI tool_calls）**：双向全字段映射，客户端可混用两套说法——
  · 请求侧：`tools[].input_schema` → `function.parameters`；`tool_choice` 的 `auto/any/tool/none` → `auto/required/{function}/none`；`disable_parallel_tool_use` → `parallel_tool_calls:false`；`stop_sequences` → `stop`；`system`（字符串或 block 数组）→ `system` 消息。
  · 会话侧：`tool_use` 块 → `assistant.tool_calls`（`input` 对象 ↔ `arguments` JSON 串）；`tool_result` → `role:"tool"`（`tool_call_id` 配对）。`is_error:true` 无对应字段，前缀 `[tool_error]` 显式告诉模型"这个工具失败了"（否则它会把失败信息当正常结果继续编）。
  · **工具结果里的图片**：OpenAI 的 `tool` 消息只允许文本部件，塞 `image_url` 会被上游 400 —— 网关把图**取出来补在紧随其后的 `user` 消息**里（带 `[tool_result image]` 锚点），视觉模型照样看得到；这种形态同样受「图片能力门」约束。
  · 响应侧：`tool_calls` → `tool_use` 块（id 走 `sanitizeToolId` 清洗，保证客户端回传 `tool_use_id` 时配对不裂）；`finish_reason` → `stop_reason`（`tool_calls`→`tool_use`、`length`→`max_tokens`、`stop`→`end_turn`、`content_filter`→`refusal`）；`usage.cached_tokens` → `cache_read_input_tokens`。
  · 刻意**丢弃**：`thinking` / `redacted_thinking`（OpenAI 格式上游无签名校验需求，把思维链塞回上下文反而有害）、`server_tool_use` / `web_search_tool_result` / `document`（无法在中转链复现）、`cache_control` / `metadata` / `top_k`。丢弃不影响结构完整性。
  · 上游限制会被原样透传：例如 thinking 类模型对"强制指定某个工具"会回 400（`Thinking mode does not support this tool_choice`），网关不吞不猜。
- **流式（SSE）**：三条客户端协议的流式都可用，且**首块字节与后续字节走同一条按行分发路径**（上游把整个流一次送到时不得丢字节，见 PT26）。
  · Anthropic 路由的流式转换是**有状态**的：`message_start` 每个请求只发一次，文本块只开一次，`tool_calls` 的 JSON 参数分片跨 chunk 累积后作为 `input_json_delta` 发出（否则流式工具调用必然碎）。
  · 上游不发 `[DONE]` 时，由收尾钩子补上关块 + `message_delta` + `message_stop`（客户端不会一直等）。
  · Gemini 的流式体现在 URL 动作（`:streamGenerateContent`），出站会显式带上 `stream:true`。
  · 流式失败细节见上文「流式失败」。
- **图片（多模态）**：三条客户端协议统一把图片转成内部 `image_url` block —— Gemini 的 `inlineData`（base64，`mimeType` 缺省 `image/png`）与 `fileData`（`fileUri` 直链）、Anthropic 的 `image`（`source.type='base64'` 与 `source.type='url'` 两种都认）都会被识别；**部件顺序保留**（先图后问 vs 先问后图对视觉模型有语义）。带图请求只走 `openai` / `anthropic` / `gemini` 三种协议的渠道，见「含图请求的候选裁剪」。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **鉴权写法**：网关密钥接受 `Authorization: Bearer <key>`、`?key=<key>`，以及**原生 SDK 的默认头**——Gemini 的 `x-goog-api-key`、Anthropic 的 `x-api-key`（仅对 `/v1/*` `/anthropic/*` `/gemini/*`；**管理面只认 Bearer / `?key=`**，客户端密钥语义不得混进管理面）。OpenAI SDK 走 Bearer，本来就通。
- **别名区分大小写不敏感**，upstream 透传原样。

## 计划中

- **自动权重「生效版」**：v1.6 只做到观测（算得出来、看得见，但一行不碰真实分流）。
  下一步才是把健康系数折进候选份额真正生效——需要同时解决"自动份额与手填权重并存谁优先"、
  "护栏（地板/上限）被反复触碰时如何告警"、"份额变化要不要写日志"三个问题
- Gemini **客户端路由**的工具调用透传：`/gemini/...` 目前只映射文本，`tools` / `functionCall` / `functionResponse` 会被丢掉（OpenAI 与 Anthropic 两条路由不受影响，见 docs/PONYTAIL_REVIEW.md PT33）
- 同协议直通（Anthropic 客户端 → Anthropic 渠道不做转换，省一层且有损点更少）
