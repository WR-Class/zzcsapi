# 协议与渠道详解

> 本文从 README 拆出（v1.18.8）：README 只留协议速查表，本文收全量细节——原生出站、同协议直通、
> 客户端路由的工具调用方向与 Responses API（第四套报文，v1.18.38）、专用报文渠道的**输出收口**（v1.18.38 修正）、
> notion 渠道的**流断取回兜底**（v1.18.39）、四条逆向/订阅链（notion-agent / workbuddy / genspark / codex）的配置要点。
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

## 渠道字段 `dropParams`（可选，v1.18.33）

**渠道级「不发这些参数」**：出站前从这家渠道的请求报文里删掉指定的几个参数。

- 为什么需要它：有些上游只吃不下**某个参数**，而不是整条链路不通。现场例子——`agentrouter` 每天固定开放额度，但它对「`tools` + `reasoning_effort`」这个组合直接 400（`Function tools with reasoning_effort are not supported for gpt-6-astra`），而客户端（DSH）每次请求都同时带这两样，于是这个渠道对**我们** 100% 失败（19 行 0 成功）。参数是客户端发的、网关原样转发，客户端又不由我们控制 → 开关只能放在**渠道**上。
- 生效范围：**常规链路**（openai / anthropic / gemini / notion 协议渠道）与**同协议直通**都生效。
- **不适用**：`workbuddy` / `codex` / `genspark` / `notion-agent` 这四种协议自带专用报文构造（在自己的函数里从零组装报文，不经过常规出站构造）——给它们配 `dropParams` 会**静默不生效**（字段照样保存、照样显示，但报文里那几个参数不会被删）。
- **只接受白名单内的参数名**（`reasoning_effort`、`reasoning`、`verbosity`、`thinking`、`thinkingConfig`、`temperature`、`top_p`、`top_k`、`frequency_penalty`、`presence_penalty`、`logit_bias`、`logprobs`、`top_logprobs`、`n`、`seed`、`stop`、`stop_sequences`、`stream_options`、`tool_choice`、`parallel_tool_calls`、`response_format`、`service_tier`、`store`、`metadata`、`user`、`modalities`、`prediction`、`safetySettings`、`max_tokens`、`max_completion_tokens`、`maxOutputTokens`）。`messages` / `model` / `stream` / `tools` 这类**结构性字段一律不在白名单**——配错一个名字最多是"没生效"，绝不会把请求打残。写白名单外的名字会被 **400** 拒收并回带合法清单（不静默忽略：静默忽略正是"配了却没生效、然后对着一个 100% 失败的渠道排查半天"的成因）。
- 只删**这几个键**：出站副本上做浅拷贝再删，绝不原地改客户端报文对象（它在候选链里被多个渠道共用，原地删会把 A 家的怪癖串味给 B 家）；没配这个字段的渠道**零拷贝原样返回**，老配置行为一个字节不变。
- 控制台入口：渠道编辑弹窗的「不发这些参数」输入框（逗号或空格分隔），下方 chips 来自 `GET /admin/api/config` 下发的 `dropParamWhitelist`；框留空 = 提交 `[]` = **清空**（注意与 `weight` 的"留空 = 不动"语义不同）。

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

## OpenAI Responses API：`/v1/responses`（客户端第四套报文，v1.18.38）

以前 `/v1/responses` 被当成"透传"塞在 `handleOpenAIRequest` 的 POST 白名单里，可那个处理器按 `body.messages` 找对话，
而 Responses 客户端发的是 `body.input` —— 结果是"要么 404 无渠道、要么把 Responses 报文原样塞给 chat 上游"。
现在它是一个**真正的客户端路由**（第四套入站/出站报文），中间完全复用既有调度链：

```
Responses 请求 ──入站转换──▶ OpenAI chat 报文 ──dispatchRequest（同一条候选链/兜底/记账/限流/粘性）──▶ 上游
                                                                                    │
客户端 ◀──出站转换── response 对象 / Responses SSE 事件序列 ◀─────────────────────────┘
```

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/responses` | POST | `stream:false` 回 `response` 对象；`stream:true` 回 Responses 的 `event:` + `data:` 事件序列 |
| `/v1/responses/{id}` | GET / DELETE | 取回 / 删除已存响应（内存表：最近 **200** 条、TTL **1 小时**，重启即清空） |

**入站映射**（`responsesToOpenAI`）：

| Responses 字段 | chat 侧 |
| --- | --- |
| `instructions` | 顶层 `system` 消息（放最前） |
| `input` 字符串 | 一条 `user` 消息 |
| `input[]` 的 `message`（`developer` 角色） | `system` 消息（语义等同） |
| `input[]` 的 `input_text` | 文本；**纯文本时退回字符串**（老上游对数组 content 兼容性最差，能不变形态就不变） |
| `input[]` 的 `input_image` | `image_url` 块（因此**照旧受图片能力门约束**：带图只留 openai/anthropic/gemini 渠道） |
| `input[]` 的 `function_call` / `function_call_output` | `assistant.tool_calls` / `role:"tool"`（`call_id` 严格配对） |
| `tools[]`（扁平 `{type:'function',name,…}`） | chat 的嵌套 `{type:'function',function:{…}}` |
| `tool_choice` 的 `{type:'function',name}` | chat 的同名形态；`allowed_tools` 退成 `auto`（有损） |
| `max_output_tokens` | `max_completion_tokens`（与 `/v1/chat` 同口径，`clientBudgetOf` 认得它） |
| `temperature` / `top_p` / `metadata` / `parallel_tool_calls` / `reasoning.effort` | 同名/近似字段透传 |

**出站映射**（`openAIToResponsesResponse` / `createResponsesStreamConverter`）：正文 → `output[]` 里的 `message` item +
`output_text` part（另给一个 `output_text` 便利字段）；`reasoning_content` → `reasoning` item 的 `summary`；
`tool_calls` → `function_call` item；`usage` → `input_tokens` / `output_tokens` / `output_tokens_details.reasoning_tokens`。
`finish_reason:"length"` → `status:"incomplete"` + `incomplete_details.reason:"max_output_tokens"`（**不假装完成**）。
流式事件序列：`response.created` → `response.in_progress` → `output_item.added` → `content_part.added` →
`output_text.delta`×n → `output_text.done` → `content_part.done` → `output_item.done` → `response.completed`
（工具调用走 `function_call_arguments.delta/done`；`end()` 幂等，因为 `[DONE]` 与流收尾都会调它）。

**有损点（诚实说明）**：

- `previous_response_id` **不做服务端续接**：每次请求都是独立的一发，多轮对话请把历史放进 `input`（状态留在客户端）；
- **内置工具会被丢掉**：`web_search` / `file_search` / `computer_use` 这类没有 chat 对应物（只有 `type:'function'` 被转换）；
- `reasoning` item 只以**摘要**形式给出，没有加密的 reasoning 内容；`store` 只在**本网关内存表**里生效（1 小时 / 200 条 / 重启清零），
  它不代表上游保存了响应；
- 响应取回是**本进程内存态**，多实例/重启后取不到（404 会说明留存策略，不假装成功）。

**装配纪律（改这块必看）**：① `/v1/responses` **绝不设** `clientProto` —— 设了就会触发同协议直通，把 Responses 报文原样塞给 chat 上游；
② 两段路由共用**一次** `authGate`；③ chat 面与 Responses 面共用 `openAICandidateChain()`（各写一份候选顺序迟早出现"只在一边复现"的兜底故障）。
守卫是 `test/responses-api-e2e.test.js`。

## 专用报文渠道的「输出收口」（v1.18.38 修正）

notion / notion-agent / workbuddy / genspark / codex 这五条路径**自己构造上游报文**（不走常规出站构造），
也因此历史上**自己写响应**：非流式 `res.end(JSON.stringify(chat 报文))`、流式 `res.write(chat SSE 行)`。

对 OpenAI 客户端面（`/v1/chat/completions`）这没问题——那本来就是要的形态；但对**其它客户端面**等于把翻译层整个绕过去了。
公网现场（v1.18.38 部署后实测）：`/v1/responses` 客户端打到 **notion 渠道**，收到的是
`{"object":"chat.completion","id":"chatcmpl-notion-…"}`；Anthropic 面流式打到这些渠道时事件序列里**没有 `message_start`**。

根因两层，缺一层都修不好：

1. `tryChannel` 分派这五条路径时只透传了 `res` / `body` / `candidate` / …，把
   `onSuccessNonStream` / `onStreamChunk` / `streamPrelude` / `streamEpilogue` **四个输出钩子全丢了**
   （代码注释写着"anthropic 入口经 onStreamChunk 转换"——意图是对的，转发是漏的）；
2. 于是它们只能自己写响应，连"开场 / 收尾"都没有。

现在四条纪律（`specialNonStreamOut` / `specialStreamHead` / `specialStreamLine` / `specialStreamEnd`）：

- **非流式**一律交 `onSuccessNonStream`（各客户端面自己翻译），没有钩子时才自己写；
- **流式开场**写响应头后**立刻发 `streamPrelude`**（Responses 的 `response.created`、Anthropic 的 `message_start` 就靠它，漏了客户端会一直等第一帧）；
- **流式逐行**走 `onStreamChunk`，**有钩子时只写钩子的返回**——空串表示"这一帧不产出"，**绝不回退成原始 OpenAI 报文**
  （回退会把 chat 形态的 `data:` 行漏进 Responses / Anthropic 的事件流，客户端解析到一半就崩）；
- **流式收尾**先发 `streamEpilogue`（补 `finish_reason` / `[DONE]` / `message_stop`）再 `end()`。

**对 OpenAI 面字节等价**：`handleOpenAIRequest` 只设 `onSuccessNonStream`、不设另外三个钩子，所以
`/v1/chat/completions` 的报文形态与字节一个都没变（回归里有对照组）。

两条边界（诚实说明）：① **上游错误体仍然原样透传**（4xx 的 `shouldPassThrough4xx` 分支照旧不翻译，这是刻意纪律，见 [behavior.md](behavior.md)）；
② **候选链本身没动**——`workbuddy` / `genspark` **不在** Anthropic / Gemini 两条候选链里（那两条只兜底到
`notion` / `notion-agent` / `codex`），所以"某个客户端面能不能打到某条专用渠道"是**调度语义**，不是收口能决定的。

守卫：`test/special-channel-output-seam-e2e.test.js`（装配守卫 + 假 workbuddy / notion 上游 × 四套客户端面）。

## notion 渠道的「流断取回」兜底（v1.18.39）

`notion` 渠道的上游流是 `POST /api/v3/runInferenceTranscript` 的 NDJSON：`patch-start` → 若干 `patch` → 一条 `record-map`。
**`record-map` 才是权威全文**，`patch` 只是流式增量。三种现场会让客户端拿到残次品：
① 流里带 soft-block 错误（200 + `temporarily-unavailable`）② 200 但零内容 ③ 流被截断（只剩半截 `patch`、`record-map` 从没到）。
而这条线程在 Notion 侧**已经落库**（报文里 `saveAllThreadOperations: true`），答案是能取回来的。

**兜底 = 用同一 `threadId` 把同一份 `transcript` 再发一次**（`createThread:false` + `isPartialTranscript:true`）。

活体验证（真实 token、云端容器内跑，2026-10-06）：

| 形状 | 结果 |
| --- | --- |
| 首发 `createThread:true` | HTTP 200，6.3s，`{"patch-start":1,"patch":14,"record-map":1}`，正文到手 |
| **同一 threadId + `createThread:false`** | **HTTP 200，4.7s，同一条线程的 `record-map` 全文** ← 采用 |
| 同一 threadId + 上面再叠 `isPartialTranscript:true` | HTTP 200，4.8s，同上 |
| 空 `transcript` 的"只取回" | **400 `ValidationError`** —— 所以取回必须带 transcript，不能只读回 |
| `getInferenceTranscriptsForUser`（notion2api 点名的那个端点） | 试了 **18 种形状**（12 种 POST body + 6 种 GET 查询串）**全部被拒或返回非 JSON** → 不实现 |

四条纪律：

- **触发判据只有一个**：权威全文（`record-map` / `markdown-chat`）**没到**。到了就一个字节都不动 ——
  正常请求**零额外延迟、零额外额度**（回归里有"首发完整 → 上游只被打一次"的对照组）。
- **它不是廉价读回**：会让上游**重新走一次推理**（消耗额度），所以有次数上限（2 次）+ 总预算（≤30s），
  报文级错误（`isNotionError`）立刻放弃。
- **取回发生在写出任何字节之前**：流式面同样是先整体缓冲 NDJSON、解析、必要时取回，再开始写 ——
  绝不会"先给客户端写了半截再回填一段"。
- **取不回就如实失败**：渠道照旧记失败、调度器照旧切下一家（兜底不许伪装成成功）。
  账本里真取回过的行带 `note: "notion-refetch"`（一眼分得清"这发是兜底救回来的"）。

**诚实边界**：notion2api 的对应能力点名叫 `getInferenceTranscriptsForUser`（Go 侧 `loadFinalAnswerWithPolling`），
我们无法确认它的请求形状（18 种全败），因此**不实现**——发一个自己验不了的调用，等于把"兜底"变成"再多一次失败"。

守卫：`test/notion-refetch-fallback-e2e.test.js`。

## 工具调用：三条客户端路由的四个往返方向

**客户端路由的四个往返方向都完整支持工具调用**（v1.12 补齐 Gemini 这条入站方向，见 PT33）：

| 客户端路由 | 工具调用（出站/入站） | `tool_choice` 三态 | 工具结果的配对方式 |
| --- | --- | --- | --- |
| `/v1/chat/completions` | OpenAI `tool_calls` ⇄ 原样 | 完整 | `tool_call_id` |
| `/anthropic/v1/messages` | `tool_use` ⇄ `tool_calls` | `none` 表达不了（去掉 tools） | `tool_use_id` |
| `/gemini/v1beta/...` | `functionCall` ⇄ `tool_calls` | `AUTO`/`ANY`/`NONE` 全支持 | **按函数名配对**（id 由网关合成，见下） |
| `/v1/responses`（v1.18.38） | `function_call` item ⇄ `tool_calls` | `{type:'function',name}` 支持；`allowed_tools` 退 `auto` | `call_id` |

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
