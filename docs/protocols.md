# 协议与渠道详解

> 本文从 README 拆出（v1.18.8）：README 只留协议速查表，本文收全量细节——原生出站、同协议直通、
> 三条客户端路由的工具调用方向、四条逆向/订阅链（notion-agent / workbuddy / genspark / codex）的配置要点。
> 路由与调度语义见 [docs/scheduling.md](scheduling.md)；鉴权写法与管理面会话见 [docs/behavior.md](behavior.md)。

## 协议速查表

| protocol       | 探活 URL                  | 鉴权头              | 出站报文（网关发给上游）              | 网关对外路径                          |
| -------------- | ------------------------- | ------------------- | ------------------------------------- | ------------------------------------- |
| `openai`       | `GET /models`             | `Authorization: Bearer ...` | OpenAI 格式，原样转发          | `/v1/chat/completions` 之类     |
| `anthropic`    | `GET /v1/models`          | `x-api-key: ...` + `anthropic-version` | **原生 Anthropic 格式**：`POST /v1/messages` | `/anthropic/v1/messages`              |
| `gemini`       | `GET /v1beta/models`      | `x-goog-api-key: ...` | **原生 Gemini 格式**：`POST /v1beta/models/{model}:generateContent` | `/gemini/v1beta/models/{m}:{action}` |
| `notion`       | `POST getSpaces`          | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query`  | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） | Notion 官方 Agent API（公开 beta） |
| `arena`        | —                        | —                    | **已撤**：Arena.ai 逆向已整体移除（见 [docs/arena-protocol.md](arena-protocol.md) 留档）  | **已撤**：Arena.ai 逆向已整体移除（见 [docs/arena-protocol.md](arena-protocol.md) 留档）  |
| `workbuddy`    | 自检 `chat/completions`   | `Authorization: Bearer ...` | WorkBuddy 逆向（**必须走 curl 子进程**：上游对 Node/undici 的 TLS 指纹直接 ECONNRESET；token 是 JWT，新版 CodeBuddy 已把它加密，见下） | WorkBuddy 逆向（同上） |
| `codex`        | 一次令牌刷新             | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） |
| `genspark`     | `GET /api/is_login`      | `Cookie: session_id=...` | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期；**工具调用靠文本仿真**，上游会忽略原生 `tools`） | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期） |

## 渠道字段 `proxy`（可选）

- HTTP 代理地址（如 `http://host.docker.internal:7897`，容器经宿主机代理出网）。
- 对 `openai / anthropic / gemini / workbuddy / codex / genspark` 协议生效——**探测、测试、聊天全部经代理转发**（curl `-x` 子进程，undici fetch 不走代理）。
- 注意两点：流式响应经代理会**整体缓冲后一次性回放**（首字节延迟 ≈ 上游总耗时，与 CF 回退同款语义）；代理挂了渠道探测即失败、进冷却（诚实失败，不静默直连）。
- `notion` / `notion-agent` 不支持代理（官方 API 直连）。

## 原生出站：`anthropic` / `gemini` 协议渠道可以直接聊天了

`protocol` 现在**同时决定出站报文格式**。以前它只管探活方式和对外路由，出站一律 OpenAI 格式 —— 于是「声明成 anthropic 协议的渠道」拿去敲 `/v1/messages` 必然 400，等于配了也用不了（Gemini 同理）。

现在两条方向都通了，**客户端说哪套协议、渠道讲哪套协议，互不绑定**：

| 客户端来的协议 | 渠道是 `openai` | 渠道是 `anthropic` | 渠道是 `gemini` |
| --- | --- | --- | --- |
| OpenAI（`/v1/chat/completions`） | 直通 | 转原生 `/v1/messages` | 转原生 `:generateContent` |
| Anthropic（`/anthropic/v1/messages`） | 转 OpenAI 出站 | **同协议直通（v1.15，不翻译）** | 转原生 Gemini 出站 |
| Gemini（`/gemini/v1beta/...`） | 转 OpenAI 出站 | 转原生 Anthropic 出站 | **同协议直通（v1.15，不翻译）**；流式 `:streamGenerateContent?alt=sse` |

**同协议直通（v1.15）**：客户端协议与渠道协议相同的两个格子**一次翻译都不做**——出站用客户端原始报文
（Anthropic 只把 `model` 换成渠道的上游名；Gemini 的模型名本来就在 URL 路径里），响应（含流式 SSE 字节）
原样回传。省掉"客户端 → 内部 OpenAI → 原生"来回两趟，也就省掉了两处**有损点**：

- 内部 OpenAI 格式承载不了的字段，以前会在进、出两个方向上被静默丢掉：`thinking`（含 `budget_tokens`、
  `signature`）、`cache_control`、`top_k`、`metadata`、**多段 system**、`stop_sequences` 细节、
  `generationConfig.seed` / `thinkingConfig`、`safetySettings` …… 直通后原样到达上游、原样回到客户端。
- 回程不再被重排：`message_start` 不再是网关"补"出来的（上游那一个原样过去），也不会多出原生协议里
  根本没有的 `[DONE]`；`event: …` 行与分隔空行逐字节一致。

代价（诚实说）：入站那层"顺手的清洗"也不再执行——内部格式才需要的工具 id 清洗、参数方言修正都不做，
上游报什么错就透什么错；**图片能力门仍在选路阶段生效**（候选过滤用的是同一份转换结果，没有被绕过）。
只有"客户端协议 === 渠道协议"时才直通，跨协议照旧走转换（见下文）。

v1.18.8 起，同协议直通的 Anthropic 这格还带 **thinking 回放修复**（客户端弄丢 `signature` 时网关把上游
自己签的那枚补回去，四元键绝不跨渠道）：边界见 [docs/thinking-replay-design.md](thinking-replay-design.md)。

## 怎么配原生渠道

- **怎么配**：`"protocol": "anthropic"` + `baseUrl`（如 `https://api.anthropic.com`，写不写 `/v1` 都认）+ `apiKey`；Gemini 填 `https://generativelanguage.googleapis.com`（`/v1`、`/v1beta` 都认）。模型行照旧：alias 是**客户端请求的名字**，上游是**真实模型名**（Gemini 会拼进 URL 路径）。

## 工具调用：三条客户端路由的四个往返方向

**客户端路由的四个往返方向都完整支持工具调用**（v1.12 补齐 Gemini 这条入站方向，见 PT33）：

| 客户端路由 | 工具调用（出站/入站） | `tool_choice` 三态 | 工具结果的配对方式 |
| --- | --- | --- | --- |
| `/v1/chat/completions` | OpenAI `tool_calls` ⇄ 原样 | 完整 | `tool_call_id` |
| `/anthropic/v1/messages` | `tool_use` ⇄ `tool_calls` | `none` 表达不了（去掉 tools） | `tool_use_id` |
| `/gemini/v1beta/...` | `functionCall` ⇄ `tool_calls` | `AUTO`/`ANY`/`NONE` 全支持 | **按函数名配对**（id 由网关合成，见下） |

Gemini 这条路的两个细节（都与"Gemini 认函数名不认 id"有关）：

- `functionCall` / `functionResponse` 进站后转成真的 `assistant.tool_calls` / `role:"tool"` 报文，网关替它合成
  `call_g<n>_<name>` 形状的 id，并用**同名 FIFO 队列**把 `functionResponse` 配回正确的调用（同一轮里同一函数调两次也对得上）；
- 客户端若**只回结果、不带上文的 functionCall**（无状态用法），网关**不会**硬造 `tool_call_id` —— 那会让上游因
  "有 tool 消息却没有配对的 `assistant.tool_calls`"直接 400。这种情况退回为一段可读文本，结果照样进上下文。
- 有损点：`ANY` + 多个 `allowedFunctionNames` 在 OpenAI 侧只有"强制某一个"，因此会**同时把工具集收窄到白名单**、
  `tool_choice` 退化为 `required`（方向一致，但不是逐字等价）。

**转发什么**：`system/developer` → 顶层 `system`（Anthropic）/ `systemInstruction`（Gemini）；`tool_calls` ⇄ `tool_use`（Anthropic）/ `functionCall`（Gemini）；工具结果 → `tool_result` / `functionResponse`（Gemini 按**函数名**配对，自动从上一轮工具调用里查）；图片 → `image` 块（base64/url）/ `inlineData`、`fileData`；`max_tokens`→`max_output_tokens`/`maxOutputTokens`；`stop`→`stop_sequences`/`stopSequences`；流式 → Anthropic 事件 / `alt=sse`。

**上游报错照样原样返回**：错误体（如 `{"type":"error",...}`）不做翻译 —— 否则 400 会被伪装成"成功但空"的 200，最难查。

**有损的地方（诚实说明）**：`tool_choice: "none"` 在 Anthropic 侧表达不了（保留 tools 就等于 auto，因此**直接去掉 tools**）；Anthropic 的 `cache_control`、`top_k`、thinking 签名在跨到内部 OpenAI 格式时会丢；`tool_use.id` 会被清洗成合法字符。原生渠道与客户端同为 Anthropic 时也走这一遍转换（不做同协议直通）。

**调度顺序**：三种协议**同协议优先、跨协议在后**（`openai` 渠道仍然先被选中），原生协议渠道作为候选链尾部一层兜底，不影响你现有 `openai` 渠道的先后顺序。

> 中转渠道如果用 OpenAI 兼容但 `protocol` 想挂到 Anthropic 端点用，把 `protocol` 设成 `anthropic` 即可——网关会把请求体自动转成 OpenAI 格式丢给它，再把响应转回 Anthropic 格式。同理 Gemini。

## notion-agent（Notion 官方 Agent API）

调用 Notion 工作区的 Custom Agent（需要 Business/Enterprise 版工作区，在 Notion 网页聊天侧栏创建代理）。

- **Base URL**：`https://api.notion.com`
- **API Key**：**集成令牌**（开发者门户 → 我的集成 → 复制内部令牌 `ntn_...`），且集成的能力必须勾选「**查看会话并与代理交互**」（测试版）
- ⚠️ **个人访问令牌（PAT）不行**：PAT 能列代理、能建会话，但执行时会被服务端直接拒绝（`session_failed`，零 credits 消耗）——这是令牌能力限制，不是配置错误
- **模型行**：alias 填对外模型名（如 `gpt-6-astra`），上游填**智能体名称**（如 `Magnificent Pioneer`）；一个智能体锁定一个模型，多个模型就建多个代理
- 会话中智能体的确认门（requires_action）自动批准（最多 5 次）
- 每次对话消耗工作区 AI credits，因此 notion-agent 渠道排在调度兜底链**最后**，仅当 openai/notion 渠道都失败时才启用

## workbuddy（WorkBuddy 逆向，CodeBuddy 桌面端）

把 CodeBuddy/WorkBuddy 桌面端登录后的 Bearer JWT 当渠道用（`deepseek-v4.1-flash` 这类免费模型）。

- **Base URL**：`https://www.workbuddy.ai/v2`；**API Key**：`auth.accessToken` 的 **JWT**（`ey` 开头、三段点分；**别填 refreshToken**）
- **必须走 curl 子进程**：该上游对 Node/undici 的 TLS 指纹直接 `ECONNRESET`（Win Schannel / Linux OpenSSL 可过）
- **探活**：`/v2` 没有 `/models`（404），探测 = 一次真实轻量聊天（`max_tokens:1`，读到第一个 SSE 分片即判活）——所以成功探测本身就是"真凭实据"，可满血
- ⚠️ **auth 文件里的 token 已被加密（v1.14.1 起明确提示）**：新版 CodeBuddy 存的是
  `{"$wbEncrypted":1,"envelope":{"suite":1,"keyId":…,"nonce":…,"authTag":…,"ciphertext":…}}` —— **AES-GCM 密文，不是 JWT**，
  复制粘贴一定失败。网关会**在发请求前**就拦下并说明原因（不浪费一次往返、也不误记一次失败）。
  需要明文 JWT 时只能从客户端**实际请求**里取一份（`Authorization: Bearer eyJ…`）。
- ⚠️ **额度/频率用尽（HTTP 429 `code:6004`）不是渠道故障**：上游文案里直接写了重置时刻
  （`… your usage will reset at 2026-09-28 10:00:39 UTC+8 …`）。网关会：
  1. 按 `rate_limit` 记账（不把渠道冤枉成 `down`），并把 **冷却期精确对齐到那个重置时刻**
     （而不是按曲线猜个 1 小时——那会在额度早已回血后继续空等，或提早去撞墙）；
  2. 探测/测试的错误信息**原样带出上游文案**——早期版本会把它吞成一句
     `✗ workbuddy: non-SSE response`（JSON 判定漏了 `trim`，响应体以换行开头就误判），这正是"看不出为什么"的元凶；
  3. 上游说"可以换别的模型"：多配几个别名（`models` 里多写几条）就能在某个模型被限时切到另一个。
- 上游返回 HTML（CF 挑战页/代理错误页）时，错误信息会带上 **HTTP 码 + 响应开头**，不再是不可解释的 `non-SSE response`

## genspark（Genspark 网页会话反代）

把 Genspark 网页版的登录态当渠道用，走 `llm_proxy` 免费额度（详细逆向过程见 [docs/genspark-claw-reverse-proxy-research.md](genspark-claw-reverse-proxy-research.md)）。

- **Base URL**：`https://www.genspark.ai`
- **API Key**：网页会话的 `session_id`（不是 JSON 里的 `gsk-` apiKey）。服务端会补全成 `session_id=…; agree_terms=1; gslogin=1`
- **代理必填**：容器经宿主机代理出网（如 `http://host.docker.internal:7897`），否则过不了地区门
- **探活**：`GET /api/is_login`，**免费、不消耗 credit**；网页端没有 models 接口，模型清单来自渠道别名配置
- **导入**：控制台「导入 genspark」（粘贴 session.enc JSON / 整段 cookie / 裸 session_id）或「导入 genspark JSON」（多选文件批量）→ `POST /admin/api/genspark-import`
  - `mode:'replace'`（默认）：覆盖首个 genspark 渠道的 key
  - `mode:'add'`：**一个会话建一个渠道**（多号 = 多份每日积分）；key 已存在则视为刷新
- ⚠️ **session 约 20 天过期**，过期后网页端重新登录、再导一份即可
- 请求头伪装：`User-Agent` / `Origin` / `Referer` / `request-id` / `traceparent`，SSE 聚合后再分发
- **工具调用（v1.14 起可用，走文本仿真）**：该上游**静默忽略**原生 `tools` 参数（genspark2api 实测），
  所以网关自己把工具协议"写进对话"：
  1. 请求侧把 `tools` 定义 + 调用格式注入消息（`toolEmu`），历史里的 `tool_calls` / 工具结果渲染成文本；
     网页会话只认 `user` / `assistant` 两种角色，因此 `system`（包括仿真协议本身）会**折进第一条 user** ——
     否则协议根本到不了模型；
  2. 响应侧把回复里的 `[TOOL_CALL]{…}[/TOOL_CALL]` 解析回**真的** `tool_calls`（`finish_reason: "tool_calls"`），
     流式与非流式都发；解析不出来就照旧当纯文本，不会把普通回复吃掉。
  - 有损点（诚实说明）：这是**提示词级仿真**，靠模型自觉按格式输出 —— 模型不听话时不产生工具调用（但也不会报错，
    文字照常返回）；`tool_choice: "none"` 不会注入协议；上游侧看不到原生 `tools` 字段（塞了也是噪音，不塞）。
  - 同套路还用在 `notion` / `notion-agent` 两条链上（它们的上游同样不认原生 `tools`）。
  - **真机实测（v1.14 部署后）**：真实 Genspark 会话（渠道别名指向 Genspark 网页版模型），
    `tool_choice:"required"` 非流式 → 客户端收到 `tool_calls`（`get_weather` + `{"city":"北京"}`，`finish_reason:"tool_calls"`）；
    `tool_choice:"auto"` 流式 → SSE 里也是 `tool_calls` 分片 + `finish_reason:"tool_calls"`。
    也有过"模型先反问城市、没吐标记"的样本（`auto` 下偶发）——这正是上面那条有损点，多试一次或改用 `required` 即可。

## 图片（多模态）的统一转换

三条客户端协议统一把图片转成内部 `image_url` block —— Gemini 的 `inlineData`（base64，`mimeType` 缺省 `image/png`）与 `fileData`（`fileUri` 直链）、Anthropic 的 `image`（`source.type='base64'` 与 `source.type='url'` 两种都认）都会被识别；**部件顺序保留**（先图后问 vs 先问后图对视觉模型有语义）。带图请求只走 `openai` / `anthropic` / `gemini` 三种协议的渠道（候选裁剪规则见 [docs/scheduling.md](scheduling.md) 的「含图请求的候选裁剪」）。
