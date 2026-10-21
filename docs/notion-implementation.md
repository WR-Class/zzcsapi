# notion 反代实现文档（可照做）

> **这份文档解决什么问题**：把「notion 渠道到底是怎么实现的、我该怎么配、出问题怎么查」一次讲清。
> 与另外两份的区别：`docs/protocols.md` 里那四节是**协议层细节**，`docs/notion-attachment-upload-research.md` 是**逆向取证留档**（含三次误判）。
> 本文是**实现与使用手册**——按它能把一条 notion 渠道从零配到能跑，跑不通时按 §12 的表对照定位。
>
> 代码位置以**符号名**为准（行号会漂移）：`notion.js`（908 行，逆向协议全在这一个文件）、
> `notion-agent.js`（331 行，官方 Agent API）、`server.js` 的 `tryNotionChannel` / `tryNotionAgentChannel`。

---

## 1. 先分清：`notion` 不是一条路，是两条

网关支持两个**完全独立**的 notion 渠道协议。它们只是都叫 notion，实现、鉴权、计费毫无关系：

| | `protocol: "notion"` | `protocol: "notion-agent"` |
| --- | --- | --- |
| 本质 | **逆向** Notion 网页版 AI 聊天的内部接口 | 调 **Notion 官方** Agent API（公开 beta） |
| 端点 | `POST /api/v3/runInferenceTranscript` | `POST https://api.notion.com/v1/sessions` |
| 鉴权 | **Cookie `token_v2`**（浏览器里那个） | **集成令牌 `ntn_...`**（开发者门户，Bearer） |
| baseUrl | `https://app.notion.com`（或 `https://www.notion.so`） | `https://api.notion.com` |
| 模型 | Notion 内部 33 个代号（gpt/claude/gemini/grok/kimi/deepseek/glm） | 工作区里**你自己建的 Custom Agent**，一个代理锁一个模型 |
| 计费 | 账号的 Notion AI 额度（6 小时窗口） | 工作区 **AI credits** |
| 门槛 | 有 Notion 账号且 AI 可用 | 需要 **Business/Enterprise** 工作区 |
| 在候选链里的位置 | openai 池之后的一层兜底 | **最末尾**（只在前面全挂时接住） |
| 相关文件 | `notion.js` + `tryNotionChannel` | `notion-agent.js` + `tryNotionAgentChannel` |

**给要用的人一句话建议**：手上有 Notion 账号，就走 `notion`（免费额度、模型多）；有企业工作区和集成令牌，才考虑 `notion-agent`。

---

## 2. 一次请求的完整链路

以 OpenAI 客户端 `POST /v1/chat/completions`、模型 `claude-sonnet4-6` 为例：

```
客户端
  │  Authorization: Bearer <GATEWAY_KEY>
  ▼
Host/Origin 门 → authGate → 限流/封禁 → 路由 /v1/chat/completions
  │
  ▼
openAICandidateChain(model)          ← 逐层拼候选，每层都过 channelsServing()
  │  ① openai 池（你启用的 openai 渠道，全部排在前面）
  │  ② notion 池          ← 你配的 notion 渠道在这里
  │  ③ notion-agent 池
  │  ④ workbuddy → genspark → codex → hark → opencode（尾部兜底）
  ▼
按顺序 tryChannel()：openai 渠道全成功 → notion 根本不会被调用
  │                  （这正是「份额一列 notion 恒 0」的正常情形）
  ▼
tryNotionChannel()                    ← server.js
  │ 1. ensureNotionAccount(ch)        ← token_v2 → getSpaces → userId/spaceId（缓存 1h）
  │ 2. toolEmu.emulateRequest()       ← 有 tools 就转文本仿真
  │ 3. compactMessagesForNotion()     ← 超 16 万字符才压缩
  │ 4. notion.buildNotionTranscript() ← messages → 四类 step
  │ 5. notion.notionBuildPayload()    ← 包成 runInferenceTranscript 报文
  │ 6. notion.notionFetch()           ← 出站通道链：curl → h2 → fetch
  │ 7. notion.createNotionStreamParser() ← NDJSON → 增量/全文
  │ 8. 伪流式：整段解析完再按 SSE 分片写出
  ▼
客户端（OpenAI / Anthropic / Gemini / Responses 四套报文都由「输出收口」统一）
```

**关键认知**：notion 渠道**不是**一个"有 `/models` 就能直连的上游"。它的模型目录是**硬编码的 33 个代号**，
它只认 `transcript` 这种私有报文，它的响应是 **NDJSON patch 流**而不是 SSE。
所以网关对它是"**自己造报文、自己解响应**"，走的是和 `workbuddy`/`genspark`/`codex`/`hark` 同一类「专用报文渠道」的路子。

---

## 3. 逆向协议本体

### 3.1 端点清单

| 端点 | 用途 | 是否消耗 AI 额度 |
| --- | --- | --- |
| `POST /api/v3/runInferenceTranscript` | **主推理**（返回 NDJSON 流） | ✅ 消耗 |
| `POST /api/v3/getSpaces` | 凭据发现：`token_v2` → `userId` / `spaceId` | ❌ |
| `POST /api/v3/getAIUsageEligibility` | 查 6 小时窗口用量 | ❌ |
| `POST /api/v3/getAvailableModels` | 刷新模型代号表（只读，诊断用） | ❌ |
| `POST /api/v3/getInferenceTranscriptsForUser` | 列线程清单（**不是**成品正文，网关只用它做诊断） | ❌ |

### 3.2 鉴权：Cookie，不是 Bearer

```
Cookie: token_v2=<那一长串>; notion_user_id=<userId>
```

配套头（缺任何一个都可能被软墙，见 §4）：

```
Content-Type: application/json
Accept: application/x-ndjson
User-Agent: <NOTION_UA，Chrome/145 桌面版>
x-notion-space-id: <spaceId>
x-notion-active-user-header: <userId>
notion-audit-log-platform: web
notion-client-version: 23.13.20260228.0625
origin: <baseUrl>
referer: <baseUrl>/ai
```

> ⚠️ `token_v2` 在浏览器 F12 里看到的是 **URL 编码后**的（`v03%3A...`）。网关的配置里存的就是**原样那一串**（当前 8 条渠道长度 537/601），
> `notionDiscoverAccount` 会直接用，**不做解码**——所以别手工 decode 再填。

### 3.3 请求体（`notionBuildPayload`）

```jsonc
{
  "traceId": "<uuid4>",
  "spaceId": "<spaceId>",
  "threadId": "<uuid4>",            // 首发自造；流断兜底时复用同一个（见 §10）
  "threadType": "workflow",          // 或 "markdown-chat"（仅 vertex- 前缀模型）
  "createThread": true,              // 兜底重发时改 false
  "generateTitle": true,
  "saveAllThreadOperations": true,   // ★ 线程落库——流断能取回的前提
  "setUnreadState": true,
  "isPartialTranscript": false,      // 兜底重发时改 true
  "asPatchResponse": true,
  "isUserInAnySalesAssistedSpace": false,
  "isSpaceSalesAssisted": false,
  "threadParentPointer": { "table": "space", "id": "<spaceId>", "spaceId": "<spaceId>" },
  "transcript": [ /* 四类 step，见 §3.4 */ ],
  "debugOverrides": {
    "emitAgentSearchExtractedResults": true,
    "cachedInferences": {},
    "annotationInferences": {},
    "emitInferences": false
  }
}
```

### 3.4 `transcript` 的四类 step

这是整个逆向的核心：Notion 的对话不是 `messages` 数组，而是**操作序列**。

| step 类型 | 数量 | 作用 |
| --- | --- | --- |
| `config` | 1（第一条） | `type`（线程类型）、`model`（**内部代号**）、`modelFromUser`、`useWebSearch`、真带附件时加 `enableCsvAttachmentSupport` |
| `context` | 1 | 时区、当前时间、`userId`、`spaceId` |
| `user` | n | `value: [[文本]]`（注意是**二维数组**）+ `userId` + `createdAt` |
| `agent-inference` | n | 助手历史：`value: [{type:'text', content:'...'}]` |

两条容易踩的规则（都在 `buildNotionTranscript` 里）：

1. **`system` 不进 transcript**。Notion 会拒绝身份劫持式 system（"You are Claude Code" 之类），所以
   `sanitizeSystemPrompt` 先剥掉已知 agent 身份行（opencode / claude code / cursor / copilot / codex… 一长串），
   剩下的用 `reframeSystemPrompt` 包一层"用户偏好"的话术，**并入第一条 user 消息**。
2. **没有 user 消息直接报错**（`{error:'no user message'}`）——纯 system 的请求打不动它。

### 3.5 响应：NDJSON 流

不是 SSE，是**一行一个 JSON 对象**，解析器（`createNotionStreamParser`）认这四类：

```jsonc
{"type":"patch-start"}                                    // 开始
{"type":"patch","v":[ ...patch 操作... ]}                  // 增量（多条）
{"type":"record-map","recordMap":{...}}                    // ★ 权威全文
{"type":"markdown-chat","value":...}                       // markdown-chat 线程类型下的权威全文
```

其余 `type` 一律忽略（`dt !== 'patch'` 且不是那两类时直接 return）。

`patch` 里的操作（`o` 字段）：

- `a` = 新增/赋值（`/s/-` 是新段落注册，`/s/N/value/M` 是段落内 value 块）
- `x` = 追加文本
- `p` = 替换文本（只认 `/content` 或 `/text` 路径）

段落角色靠 `type` 判（`classifySeg`）：`text`=正文、`title`=元信息（丢弃）、
含 `agent-inference`/`thinking`/`reasoning`=**思考**、含 `tool`/`search`/`citation`=工具。
还有个 `<lang ...>` 标记要跨块剥离（`stripLangTags`），因为标记可能被切在两个 patch 之间。

**`record-map` 才是权威全文**——`patch` 只是流式增量，可能截断。这条直接决定了 §10 的兜底设计。

### 3.6 模型代号表（33 个，2026-09-06 快照）

对外模型名 → Notion 内部代号。内部代号是 `形容词-名词` 形状，是**硬编码在 `notion.js` 的 `NOTION_MODEL_MAP`** 里的：

| 对外名 | 内部代号 | 对外名 | 内部代号 |
| --- | --- | --- | --- |
| `gpt-6-astra` | `orlando-quinn` | `claude-sonnet4.6` | `almond-croissant-low` |
| `gpt-5.6-sol` | `orange-mousse` | `claude-sonnet5` | `angel-cake-high` |
| `gpt-5.6-terra` | `orchid-muffin` | `claude-opus4.6` | `avocado-froyo-medium` |
| `gpt-5.6-luna` | `olive-jellyroll` | `claude-opus4.7` | `apricot-sorbet-high` |
| `gpt-5.2` | `oatmeal-cookie` | `claude-opus4.8` | `ambrosia-tart-high` |
| `gpt-5.4` | `oval-kumquat-medium` | `claude-opus5` | `agave-flan` |
| `gpt-5.4-mini` | `oregon-grape-medium` | `claude-haiku4.5` | `anthropic-haiku-4.5` |
| `gpt-5.4-nano` | `otaheite-apple-medium` | `fable-5.1` | `assam-chai` |
| `gpt-5.5` | `opal-quince-medium` | `fable-5` | `acai-budino-high` |
| `gemini-3.5flash` | `vertex-gemini-3.5-flash` | `kimi-k3` | `fireworks-kimi-k3` |
| `gemini-3.6flash` | `vertex-gemini-3.6-flash` | `kimi-2.7` | `fireworks-kimi-k2.7` |
| `gemini-3.7flash` | `grapefruit-zeppole` | `kimi-2.6` | `fireworks-kimi-k2.6` |
| `gemini-3.1pro` | `galette-medium-thinking` | `deepseek-v4pro` | `baseten-deepseek-v4-pro` |
| `gemini-3flash` | `gingerbread` | `deepseek-v4flash` | `baseten-deepseek-v4-flash` |
| `grok-4.6` | `soursop-shortcake` | `glm-5.2` | `baseten-glm-5.2` |
| `grok-4.3` | `xigua-mochi-medium` | `grok-4.5` | `strawberry-whoopiepie` |
| `grok-build0.1` | `xinomavro-cake` | | |

- **默认模型**：`claude-sonnet4.6`（`NOTION_DEFAULT_MODEL`）。别名表里查不到的模型名会**静默落到这个默认值**，
  所以"我要 gpt-6 却答得不像"时，先确认别名表里有没有那一行。
- ⚠️ **这张表可能已过期**（详见 `docs/protocols.md` §「附：模型代号表可能过期」）。有用户抓包见过 `albuquerque-quinn`（不在表里）。
  拿新账号后第一件事：`POST /api/v3/getAvailableModels`（body `{spaceId}`）对一遍 value 集合——**只读、不消耗额度**。
- `vertex-` 前缀的模型走 `markdown-chat` 线程类型，其余走 `workflow`。

---

## 4. 出站传输：软墙与通道链（**最容易踩的一层**）

Notion 反爬会对某些**客户端指纹**回一道"软墙"：

```json
HTTP 200
{"type":"error","message":"Something went wrong. Please try again later.","isRetryable":false,"subType":"temporarily-unavailable"}
```

它不告诉你真实原因。**软墙有两个独立维度，必须分开看**：

| 维度 | 是什么 | 换传输有用吗 |
| --- | --- | --- |
| **A · 账号状态**（主导） | 账号本身在墙里 / 不在墙里，**与客户端无关**，且**随时间变** | ❌ 没用，只能等窗口或换账号 |
| **B · 客户端指纹** | 账号可过时，不同客户端命运不同（同一秒交替打：curl 3/3 真答、fetch 0/3 软墙） | ✅ 有用，把最容易过的排前面 |

所以出站是**通道链**（`notionFetch`），软墙会在函数内自动换下一条：

| 顺序 | 通道 | 说明 |
| --- | --- | --- |
| 0 | 非 `https:` → 全局 `fetch` | 测试假上游是 http，行为与旧版逐字一致 |
| 1 | `notionCurlFetch`（**curl 子进程**） | **主通道**，两个部署环境都实测通过 |
| 2 | `notionH2Request`（`node:http2`） | 兜底；Node ≥24 实测可过，Node 20 的 h2 照样被墙 |
| 3 | 全局 `fetch` | 最后手段 |

**五条纪律**（违反任何一条都会让某条路留在被墙的通道上）：

1. 通道选择**只许收口在 `notionFetch` 一处**。三处推理调用点（主推理 / 流断取回 / 管理面手动测试）都只调它。
2. **别把结论钉在"HTTP/2"上**——它是条件成立的，主通道必须是 curl。
3. **传输层结论必须在目标运行环境复验**：同一发 h2 请求在宿主机通过、在 `node:20-alpine` 容器里被墙。
4. **别把通道链说成"notion 一定能用"**——它只治维度 B。维度 A 在墙里时网关**如实失败**
   （`ok:false` / `notion: temporarily-unavailable`），换下一家渠道，绝不伪装成"200 空回复"。
5. 比较两个变量时**在同一时间窗内交错打**（C F C F …），不要"今天打 A、明天打 B"——那是本项目三次误判的共同动作。

---

## 5. 凭据发现与缓存

`token_v2` 只是个 Cookie，**推理还需要 `spaceId` / `userId`**。所以每次要先把凭据"换开"：

```
POST /api/v3/getSpaces   (body: {})
→ { "<userId>": { space: {...}, space_view: {...}, notion_user: {...} } }
```

`notionDiscoverAccount` 从中取：`userId`、`spaceId`（第一个 space）、`spaceViewId`、用户名/邮箱，以及 space 列表。

缓存规则（`ensureNotionAccount`）：

- 缓存在**渠道运行态** `ch.notion`，**1 小时**有效；
- 探测成功时也会顺手存一份，并**顺带查一次额度**（`notionUsage`，控制台可显示 6 小时窗口用量）；
- 推理拿到 **401** → `ch.notion = null` 强制下次重刷，并返回 `fatal_client`。

> 这也解释了控制台里 notion 渠道的「获取模型」为什么能出 33 个模型：它先 `getSpaces` 验凭据，
> 成功就返回 `notionListModels()`（即 §3.6 那张表的键）。**不是**从上游拉的目录。

---

## 6. 上下文压缩（`compactMessagesForNotion`）

Notion 对输入长度有硬限制，超过约 **16 万字符**才压缩（`LIMIT = 160_000`）。压缩策略：

1. 所有 `system` 消息**全保留**（优先扣预算）；
2. **最近 6 条**对话完整保留（`keepTail = 6`，工具场景最近轮次最重要）；
3. **第一条 user** 也强制保留——它通常带着任务目标，裁掉会导致模型丢任务方向、重复执行已完成的写入；
4. 剩余预算从**旧消息**里由近到远补，补不下的丢弃，并插一条
   `[较早的 N 条对话历史已省略以适应上游长度限制]` 占位。

压缩会打一行日志：`[notion] 输入压缩: <原> → ~<新> 字符（丢弃 N 条旧消息）`。

---

## 7. 响应解析（NDJSON → 你要的文本）

`createNotionStreamParser(onEvent)` 把 NDJSON 逐行喂进去，吐出三类事件：

| 事件 | 含义 | 网关怎么用 |
| --- | --- | --- |
| `{type:'content'}` | 正文增量 | 非流式 append；流式进 SSE 分片 |
| `{type:'thinking'}` | 思考段落 | 非流式进 `reasoning_content`；**流式也直通**（`reasoning_content` 分片） |
| `{type:'final'}` | **权威全文**（record-map / markdown-chat 到手） | 正文空时用来兜底补齐 |

解析器维护的跨行状态：段落索引→角色映射、value 块索引→角色映射、`<lang>` 开闭状态、`sawFinal`。

**两个实战坑**：

- 流式路径里，**工具模式的内容也要累计进 `fullText`**，否则"权威全文兜底"会误判流里没内容、
  把 record-map 全文再发一遍 → **客户端收到双份文本**。
- 段落角色必须**继承**：`agent-inference` 段落里的 `{type:'text'}` 子项是**思考**，
  不能按 item 的 type 误判成正文（`classifySeg` 在这里分了两条路）。

---

## 8. 输出：伪流式，不是真流式

Notion 的 NDJSON 虽然是流，但网关**必须先把整段缓冲完再写出**，原因有三个，都会被"边收边写"破坏：

1. 要判**空输出**（200 但零内容 = 额度耗尽/降级的典型表现）→ 判失败可以让调度器**切下一家**，
   而不是给客户端一个 200 + 空轮次把会话污染掉；
2. 要判**流断**并触发 §10 的取回；
3. 工具仿真要**扫完整段**才能确定有没有 `[TOOL_CALL]` 围栏。

所以流式面的顺序是：`specialStreamHead` → 先发思考分片 → 再重放缓冲的正文增量 → 工具调用分片 → 收尾 chunk → `[DONE]`。
首块延迟不受影响（NDJSON 本来就已整体到手），但对客户端而言**看起来是流式的**。

**空输出判定**（两处：流式 / 非流式）——正文、思考、`final` **全空**才判失败：

```
'recordFailure: notion stream: 200 但无内容（可能是 AI 额度窗口耗尽或上游降级）'
```

**内容分裂兜底**：模型有时把答案主体吐进思考段（`gpt-6-astra` 工具场景常见）。
判据是 `正文非空白字符数 × 5 < 思考段字符数` 时，把思考并入回复（`mergedReasoning`）。

---

## 9. 成功后的记账

- `markTrafficOk(ch)`：**真实流量的成功是唯一的清零入口**（连带探测侧欠账一起还清）。
  这条纪律是为了防止"探测失败把好渠道冤枉成 down"。
- 异步刷一次额度（不阻塞响应、失败静默）。
- `recordUsage` 落账：`inputTokens` 用估算（`estimateTokens`），`outputTokens` 按实际正文估算。
  **走兜底取回救回来的那一发会带 `note: "notion-refetch"`**，日志里一眼分得清。

---

## 10. 流断取回兜底（v1.18.39）

三种现场会让客户端拿到残次品：

1. 流里带 soft-block 错误（200 + `temporarily-unavailable`）
2. 200 但零内容
3. 流被截断（只剩半截 `patch`，`record-map` 从没到）

而这条线程在 Notion 侧**已经落库**（`saveAllThreadOperations: true`），所以答案能取回来。

**兜底 = 用同一个 `threadId` 把同一份 `transcript` 再发一次**：

```jsonc
{ "threadId": "<首发那个>", "createThread": false, "isPartialTranscript": true }
```

活体验证（真实 token，云端容器内）：同 threadId 重发回 **HTTP 200 + record-map 全文（4.7s）**，与首发正文一致。

四条纪律：

- **触发判据只有一个**：权威全文（`record-map`/`markdown-chat`）**没到**。到了就一个字节都不动
  → 正常请求**零额外延迟、零额外额度**。
- **它不是廉价读回**：会让上游**重新走一次推理**（消耗额度），所以有**次数上限 2 次 + 总预算 ≤30s**，
  报文级错误（`isNotionError:true`）立刻放弃。
- **取回发生在写出任何字节之前**。
- **取不回就如实失败**：记失败、切下一家，**不伪装成成功**。

> 为什么不用 `getInferenceTranscriptsForUser`：试了 18 种形状全败；后来抓到了它的形状，
> 但它返回的是**线程清单**（id/title/usage_summary），**不是成品正文**，替代不了同 threadId 重发。

---

## 11. 工具调用：怎么让它真的调起来（文本仿真全流程）

**一句话**：Notion 上游**没有** function calling 这个字段，`transcript` 报文里无处安放 `tools`（塞了也被静默忽略）。
所以网关用**提示词级仿真** —— 把工具目录与调用格式"写进对话"，再从回复文本里把调用"读回来"。
实现全在 **`tool-emu.js`（442 行）**，与 genspark / codex / workbuddy / hark / notion-agent **共用同一套**；
notion 侧只做接线，不重复实现。

### 11.1 notion 侧的接线：就三行

`tryNotionChannel` 第 2 步：

```js
const toolEmuReq = toolEmu.emulateRequest(body);                       // ①
const effMessages = toolEmuReq ? compactMessagesForNotion(toolEmuReq.messages)
                               : compactMessagesForNotion(body.messages);
const built = notion.buildNotionTranscript(effMessages, candidate.upstream, acct, {
  useWebSearch: !toolEmuReq,                                          // ②
  attachments: ch.def.notionAttachments === true,
});
```

顺序是刻意的，三个后果：

1. **`emulateRequest` 就是总开关**。它返回 `null` 的三种情况——`body` 没有 `tools`、`tools` 里没有一个能归一出名字、
   或 `tool_choice === 'none'`——整条路**完全原样**（零影响，老行为逐字不变）。
2. **有工具时 messages 被换掉**：开头多一条 `system`（协议正文），历史里的 `assistant.tool_calls` 与 `role:'tool'`
   被改写成纯文本。这一步**必须在压缩之前**——否则超长历史会先把工具目录截掉。`compactMessagesForNotion`
   之所以"所有 system 全保留、优先扣预算"，就是为这条协议留的位置。
3. **`useWebSearch: !toolEmuReq` 是 notion 独有的一步**：有工具时**关掉 Notion 内置搜索**
   （`notion.js` 的 `useWebSearch = !(opts && opts.useWebSearch === false)` → 写进 `config` step）。
   不关的话模型可能改用 Notion 服务端的搜索工具、回它自己的内部格式，我们的标记就永远不出现。
   关掉之后，搜索也必须走客户端提供的工具，调用形态才统一。

### 11.2 注入的协议长什么样（`buildToolSystemPrompt`）

真实生成的文本（节选；`### 名字` 一节一个工具）：

```text
# 工具调用（外部工具，由调用方系统提供并执行）

请生成供外部程序校验、执行的操作请求文本；你无需在当前聊天环境中实际执行，也不要提前声称执行成功。
外部程序会解析你的请求文本并执行对应操作，执行结果会作为下一条用户消息回传给你。

可用工具：

### get_weather
查询某城市当前天气
参数 JSON Schema（arguments 必须是满足该 schema 的合法 JSON 对象）:
{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}

## 调用格式（严格遵守）
需要使用工具时，输出如下标记（每个调用一组，arguments 为参数对象）：

[TOOL_CALL]
{"name": "工具名", "arguments": {"参数名": "值"}}
[/TOOL_CALL]

标记会由调用方系统解析并执行，你不需要（也无法）自己执行任何操作。

## 判定规则
<按 tool_choice 变的力度文案，见 §11.8>
输出工具调用标记后立即停止输出，等待工具结果回传后再继续。
不要讨论、质疑或解释自己"是否真的能"使用工具——本环境的既定工作方式就是：需要时直接输出标记。
不要输出其他任何方括号标记；不要编造不存在的工具；不要把工具调用写成 JSON 代码块，必须用上述标记。
任务需要工具而你不输出标记（比如声称"没有工具"、要求用户自己粘贴文件内容），视为任务失败。
```

每一句都是踩出来的，不是客套（源码注释里有理由）：

- **"你无需执行 / 不要提前声称成功"** —— 模型没有执行能力，不写这句它会编造"我已经帮你查到了"。
- **"不要把工具调用写成 JSON 代码块，必须用标记"** —— 否则它会用 ` ```json ` 围栏，和普通代码块混在一起。
- **"不要讨论你是否能使用工具"** —— 这是最高频的失败形态：模型回"我无法执行工具调用"。那句判定规则就是冲着它写的。
- **"不输出标记视为任务失败"** —— 明说后果比委婉请求有效。

### 11.3 尾部提醒（`buildTailReminder`）—— 对抗超长上下文稀释

协议注入在**顶部**，但真实 agent 请求（系统提示 + 工具目录）动辄十几万字符，顶部那段会被淹没。
所以再往**最后一条 user 消息末尾**追加一段**自包含**提醒：

```text
[提醒：工具由调用方执行，你没有执行能力，也不需要执行。
本次可用工具：get_weather、read_file、…（另有 N 个，完整目录见前面的工具说明）
需要工具时，唯一正确的输出是 [TOOL_CALL] {"name":"工具名","arguments":{...}} [/TOOL_CALL] 标记
——不要回答"我无法执行工具/我执行不了这些工具调用"，那等于任务失败。
不需要工具时正常回答。]
```

**自包含是关键**：尾部只写"见上文协议"，在稀释场景下等于没写。工具名最多列 24 个，超出的给计数（不把尾部塞爆）。

### 11.4 工具定义支持四种形状（`normTool`）

客户端/中间层发来的形状不统一，网关**一处归一**后再用：

| 形状 | 长什么样 | 来源 |
| --- | --- | --- |
| 嵌套 | `{type:'function', function:{name,description,parameters}}` | OpenAI 原生 |
| 扁平 | `{type:'function', name, description, parameters}` | OpenAI Responses / 部分客户端 |
| Anthropic | `{name, description, input_schema}` | Anthropic 原生 |
| 驼峰 | `{name, description, inputSchema}` | 多个 JS SDK / 中间层 |

**schema 字段名也有三种拼法**，且可能出现在顶层或 `function` 里：`parameters` ‖ `input_schema` ‖ `inputSchema`。

两个坑都真踩过，症状相同、原因不同：

- 只认嵌套 → 扁平/Anthropic 形状被整批丢掉 → **连协议都不注入** → 模型只能回散文（"我执行不了这些工具调用"）。
- 只认 snake → 工具名读到了、**参数 schema 却是空 `{}`** → 模型知道有这个工具、不知道传什么参数 → 回散文或调错参数。

### 11.5 多轮工具回合：历史怎么伪装（`renderEmulatedMessages`）

Notion 的 transcript 只有 user / agent-inference 两类，**没有 `tool` 角色**。所以：

| 客户端历史 | 注入上游的形态 |
| --- | --- |
| `role:'tool'` 消息 | `user` 消息：`[工具 <名字> 的执行结果如下]\n<结果>\n[请根据以上工具结果继续]` |
| `assistant.tool_calls` | `assistant` 消息：原正文 + 每个调用一组 `[TOOL_CALL]\n{"name":…,"arguments":{…}}\n[/TOOL_CALL]` |
| 多模态 content 数组 | 只取文本部分（图片不走这条路，见 §12 附件） |

于是模型看到的是一段"**它自己以前就是用标记调工具的**"历史，契约自洽 —— 这是多轮工具能跑通的前提。

### 11.6 响应侧：三种捕获 + 两层去重（`parseEmulatedToolCalls`）

按优先级依次试：

1. **`[TOOL_CALL]…[/TOOL_CALL]` 标记**（主路径，协议里要求的就是它）
2. **` ```json ` 围栏**（模型不守格式时兜底；普通代码块也会被当候选，解析不出调用就**原样转发**，不误伤）
3. **裸 JSON**：整个回复就是一个 `{name, arguments}` 或 `{tool_calls:[…]}` 对象

裸 JSON 那条**必须防误判**：要求同时有 `name` 和参数键（`arguments`/`args`/`parameters` 之一），
否则 `{"name":"config","port":8080}` 这种普通 JSON 会被当成工具调用。

**两层去重**（`dedupeConsecutiveCalls`）：只去掉**紧邻的相同调用**（同 name + 同参数）。
理由是模型常在 thinking 段和正文段把同一调用吐两遍 → 执行器会**执行两次**（重复写入循环的成因之一）。
"隔次重复"是合法用法（真要调两次），不砍。

> ★ **v1.18.88 修掉的一处"第三个去重层都没拦住"的重复**（属性测试抓到的，危险点正是**重复执行写操作**）：
> `[TOOL_CALL]` 里再包一层 ` ```json ` 围栏、且围栏里写了 **2+ 个调用**时，`findCaptureSpans` 会把
> "标签区段"和"围栏区段"**都**收进候选、只 `sort` 不合并重叠 —— 两者的 `inner` 是**同一段 JSON**，
> `parseEmulatedToolCalls` 于是各解析一次 ⇒ 调用数量**翻倍**（`write` 被执行两次），正文还残留 `[/TOOL_CALL]`
> （正文拼接按 `pos = sp.end` 单调前进，先外后内的重叠 span 会让内层尾巴漏进正文）。
> **单调用形态不重复**，是因为 `dedupeConsecutiveCalls` 只去"紧邻重复"、恰好把它吞掉了 —— 也就是说
> 那个 bug 在 2+ 调用时才暴露，而这正是最需要正确的时候。**流式扫描器不走这条函数，同一个输入它是对的**，
> 所以这是"两条路行为分歧"，非流式渠道（hark / genspark / notion-agent / workbuddy）走的正是出错这条路。
> 修法：排序后**丢弃被完全包住的 span，只留最外层**（外层 `inner` 天然包含内层内容）。
> 回归：`test/tool-emu-fuzz.test.js` §10（嵌套围栏恰好 2 个 + 顺序不变 + 正文不残留 + 与流式逐字一致 +
> 两个互不重叠的标签块仍都保留）。
> 同版另修：`parseEmulatedToolCalls(42)` / `({})` 以前抛 `TypeError: text.indexOf is not a function`（`!text` 只挡 falsy），
> 现已先 `String()`，一律返回 `null` 而不是崩。
>
> 再修一处（属性测试连跑才闪出来的）：`toolCallId()` 的随机段**不恒定 8 位**——`Math.random().toString(36)` 位数不定，
> 随机数偏小时切出来可能只有 1 个字符（`0.5` → `"0.i"`），于是 id 长度在 14~21 浮动、同毫秒内容易**撞号**；
> `tool_call_id` 要被客户端原样回传用于把结果对回调用，撞号就是两轮调用被认成同一轮。现已右补到足够长再切 8 位。

解析出的工具区段会**从正文里剥掉**，剩余文本作为 `content` 一起返回 —— 所以"边说话边调工具"不会被吃掉。

### 11.7 流式：怎么不吐出半截标记（`createToolStreamScanner`）

流式不能等全文，但又不能把"还在长的标记"当正文先吐出去。所以：

- 区段**之前**的内容立即转发（客户端能边收边显示）；
- 遇到 `[TOOL_CALL]` / ` ``` ` 开头 → **进入捕获模式**，内容扣住不发；
- 闭合且解析出调用 → **一次性**产出 `tool_calls`；解析不出（普通代码块）→ **原样转发**；
- 结尾可能是标记开头的碎片（`[`、`[TOOL`、1–2 个反引号）→ **hold 住**，等下一片数据再判；
- `MAX_HOLD = 64KB`：扣太久强制放行，防止模型吐一堆 `[` 把流卡死；
- 跨批次去重（`lastCallKey`）：thinking 段与正文段各吐一次同一调用时只发一次。

### 11.8 `tool_choice` 怎么映射

| 客户端传 | 注入的力度 |
| --- | --- |
| 不传 / `'auto'` | 「由你判断：需要外部信息或动作时必须调用工具；能直接回答时正常回答」 |
| `'required'` / `'any'` | 「**本次回复你必须调用一个工具（不允许直接回答）**」 |
| `{type:'tool', name:'x'}`（Anthropic 指定工具） | 「本次回复你必须调用工具 `x`（不允许直接回答）」 |
| `'none'` | **不注入协议**（`emulateRequest` 返回 `null`，走原始路径） |

### 11.9 怎么验证它真的调了工具

**先证链路，别用真实业务工具**：

```jsonc
// 请求（OpenAI 面）
{
  "model": "<你 notion 渠道别名表里的那个名字>",
  "messages": [{"role":"user","content":"北京现在天气怎么样？"}],
  "tools": [{"type":"function","function":{
    "name":"get_weather",
    "description":"查询某城市当前天气",
    "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
  }}],
  "tool_choice": "required"
}
```

**通过的样子**：`finish_reason: "tool_calls"`，且 `message.tool_calls[0].function.name === "get_weather"`，
`arguments` 是 `{"city":"北京"}` 这样的**合法 JSON 字符串**（不是 `{}`）。

**真机实测参照**（v1.14 部署后，同一套仿真路径，跑在 genspark 渠道上）：
`tool_choice:"required"` 非流式 → 客户端收到 `get_weather` + `{"city":"北京"}`、`finish_reason:"tool_calls"`；
`tool_choice:"auto"` 流式 → SSE 里同样是 `tool_calls` 分片 + `finish_reason:"tool_calls"`。

### 11.10 失败模式与处置（照这张表查）

| 现象 | 真因 | 处置 |
| --- | --- | --- |
| 模型回散文「我无法执行工具调用」/「我没有工具」 | 协议被稀释，或模型不听话 | **notion 上不会自动重试**（见本节末）。换更强模型（`gpt-6-astra` / `claude` 系较稳）、缩短上下文、或确保 `tool_choice:"required"` |
| 模型说「我已经帮你查到了…」并编造结果 | 它把仿真当成真执行 | 协议已写"不要提前声称执行成功"；仍出现就换模型 |
| 工具名对、`arguments` 是 `{}` | 你的 schema 字段名不在 `parameters`/`input_schema`/`inputSchema` 之列 | 按 §11.4 改形状；网关不做 schema 校验，注入时只透传 |
| 一个调用被执行两次 | 模型在 thinking 与正文各吐一遍 | 网关已按"紧邻去重"处理；若仍重复，说明两次参数不同（合法，不砍） |
| 回的是 ` ```json ` 代码块而不是标记 | 模型没守格式 | 解析器兜底认围栏，功能不受影响；想更稳用 `tool_choice:"required"` |
| 真实业务不调工具，纯聊天正常 | 上下文太长，顶部协议被淹没 | 尾部提醒已对抗，但**十几万字符级别仍可能失效**——仿真路线的固有上限 |

⚠️ **一条 notion 与 hark 的关键差异**：`tool-emu.js` 里有个 `looksLikeHarkCannedFailure()`，
把「我无法执行工具 / hark 固定道歉」判成**可重试的上游失败**（同渠道重试 → 切下家）。
它**只在 `tryHarkChannel` 里调用**（`server.js` 两处），**notion / notion-agent 不走**。
所以 notion 上模型回那句散文时，你会**原样拿到一段散文**（200 成功），不会触发重试。
这个判据的边界是刻意的：长正文（>800 字符）一律放过，宁可漏也不把真回答当道歉。

### 11.11 有损点（诚实说明）

1. **靠模型自觉**：不按格式输出时不产生工具调用 —— 不报错、文字照常返回，客户端看到的是"模型没调工具"而非"渠道坏了"。
2. **上游看不到原生 `tools` 字段**：Notion 侧看到的只是一段普通对话，工具语义完全由提示词承载。
3. **没有 schema 校验**：网关不验证 `arguments` 是否符合你的 schema —— 该由客户端/执行器挡。
4. **`tool_choice:'none'` 不注入协议**：那时模型连"有工具"都不知道。
5. **超长上下文会失效**：十几万字符的 agent 请求里顶部协议可能被淹没（尾部提醒只能缓解）。
6. **thinking 段也会被扫**：模型把调用写进思考段时同样会被识别 —— 这是有意的，否则 gpt 系会把调用丢在思考里。

---

## 12. 内联附件（`notionAttachments`，默认关）

**这不是"上传到 S3 再插 attachment step"那条路**——那条路机制是打通的，但 CSV 这条用途不需要它。
真机抓包（把 notion2api 的 `upstream.base_url` 指向记录代理）看到的是：**CSV 根本不上 S3**，
而是把文件**内联进最后一条 user step 正文**。

| 客户端发来 | 网关出站 |
| --- | --- |
| OpenAI `{type:"file", file:{filename, file_data:"data:<mime>;base64,…"}}` | ① `config` step 加 `enableCsvAttachmentSupport: true`（**只在真有文件时加**）<br>② 文件按 `{"file":{"file_data":"data:…","filename":"…"},"type":"file"}` 追加到**最后一条 user step** 正文末尾（一个换行分隔） |
| Anthropic `{type:"document", source:{type:"base64", media_type, data}}` | 同上 |

- **只对 `notion` 协议有意义**；非布尔值 **400**；配在非 notion 协议上 **400**。
- **上限**：单文件 ≤1MB、最多 3 个（内联进 prompt，不能无限大）。只认 **base64 的 `data:` URL**，不做任何网络取回。
- 文件名会被净化（剥路径、删引号/换行/控制字符——脏字符会破坏整条 step 的 JSON）。
- **默认关**，且"默认关"是源码事实（`=== true` 判定）：不打开时报文与从前**逐字相同**。
- ✅ 活体验证（v1.18.42）：判决实验在 `notionls` 上给出「已打通」——对照答「没找到 CSV」，带附件那发答出只存在于 CSV 里的 `K7Q2M9`。

---

## 13. 配置：从零到能跑

### 13.1 拿凭据（`token_v2`）

1. 浏览器登录 `https://app.notion.com`；
2. F12 → **Application**（Chrome）/ 存储 → **Cookies** → `app.notion.com`；
3. 找 **`token_v2`**，复制**完整值**（`v03%3A...` 这种长串，500+ 字符）；**不要** decode、不要截断；
4. 确认这个账号的 **Notion AI 可用**（网页里能正常跟 AI 对话）。

### 13.2 建渠道（控制台 → 渠道 → 新建）

| 字段 | 填什么 |
| --- | --- |
| 协议 | `notion`（下拉里叫「Notion 逆向」） |
| Base URL | `https://app.notion.com`（`https://www.notion.so` 也行） |
| API Key | 上面复制的 `token_v2` **原样** |
| 模型别名表 | 一行一个：**对外模型名 → 上游真实模型**，见下 |
| `notionAttachments` | 要用 CSV/文件就打开，否则留关 |

**别名表怎么配**（这一步决定客户端的模型名能不能命中这个渠道）：

```
claude-sonnet4-6   → claude-sonnet4.6     # 左边是客户端会发的名字（随你定）
gpt-6-astra        → gpt-6-astra          # 右边必须严格等于 §3.6 表里的「对外名」
```

- 左边的名字**可以自定**，右边必须是 §3.6 表里的键（`claude-sonnet4.6`、`gpt-6-astra`…）；
- 右边写错不会报错，会**静默落到默认模型** `claude-sonnet4.6` —— 这是最常见的"配了但答得不对"；
- 你机器上现有 8 条 notion 渠道都是 `enabled: false`，别名表普遍只有 2~3 条。

### 13.3 验证（三级，从便宜到贵）

```powershell
# ① 只验凭据（不消耗额度）：控制台点「获取模型」→ 应返回 33 个模型名
# ② 验一发最小推理（消耗一次额度）：控制台点「测试」，或指定渠道测
POST /admin/api/test   { "model": "claude-sonnet4-6", "channelId": "notionls" }
# ③ 验真链路：从 /v1/chat/completions 打一发
```

管理面手动测试**走的是同一条 `notionFetch` 通道链**，所以它也能用来判断"通道通不通"（对应 §4 纪律 1）。

### 13.4 调度位置

notion 渠道在候选链**靠后**，而且 `priority` **改变不了跨层的先后**——`openAICandidateChain` 是
**先把整个 openai 池拼完、再拼 notion / notion-agent / workbuddy / …**（`priority` 只在该层**内部**排序）。
所以只要还有可用的 openai 渠道，notion 就**一次都不会被派发**（这正是控制台「分流」一列 notion 恒 0 的正常原因）。
要让 notion 真被用到，实际只有一条路：**停用（或让它失败）全部 openai 渠道**。

---

## 14. 故障排查表

| 现象 / 错误文案 | 真实原因 | 处置 |
| --- | --- | --- |
| `notion: temporarily-unavailable` | **软墙**。先看是维度 A 还是 B | 先跑 `node notion-wall-probe.js <渠道id>`（同一时间窗交错打）；A 类只能等窗口/换账号 |
| 同样报软墙，但换了账号立刻好 | **维度 A**：账号在墙里 | 等 6 小时窗口/换账号，**别改报文** |
| 某些客户端通、某些不通 | **维度 B**：客户端指纹 | 通道链已处理（curl 优先）；别自己加 fetch |
| `getSpaces HTTP 401/403` | `token_v2` 失效或被 URL 编码破坏 | 重新从浏览器复制**原样**值 |
| `getSpaces: no user or space found (token_v2 invalid?)` | token 有效但拿不到 space | 账号没有可用工作区，或 token 是别的域的 |
| `notion: 200 但无内容（可能是 AI 额度窗口耗尽或上游降级）` | 额度窗口耗尽 / 账号降级 | 查控制台 `notionUsage`；等窗口或换账号 |
| 答得不像你要的模型 | 别名表右边写错 → **静默落默认** `claude-sonnet4.6` | 按 §3.6 核对右边 |
| 模型说"没有工具/无法执行" | 工具仿真协议没到模型，或模型不听话 | 看 `useWebSearch` 是否被错误打开；换模型试 |
| 客户端收到**双份文本** | record-map 兜底与正文重复（历史 bug） | v1.18.39 已修（工具模式也累计 `fullText`）；确认版本 |
| `session_failed` + 零 credits（notion-agent） | 用了**个人 PAT**，能力不足 | 换开发者门户「创建连接」生成的 `ntn_` 令牌 |
| Cloudflare 403/503 HTML（notion-agent） | 短时间密集建会话触发风控 | 网关已自动退避重试一次；仍失败就降低测试频率 |

**探针工具**（都只读、低额度、报告绝不回显凭据）：

```powershell
node notion-wall-probe.js [渠道id] [传输序列] [轮数]     # 分维度 A/B 判决软墙
node notion-attachment-verdict.js [预算] [渠道id]        # 成对打，判"模型真读到文件了吗"
```

---

## 15. 守卫测试

改 notion 出站/报文/附件跑这些（零依赖，全部会真起假上游或真跑解析器）：

| 命令 | 断言数 | 守什么 |
| --- | --- | --- |
| `node test/notion-transport.test.js` | 16 | 通道链（本地 h2c 真跑 h2 + 本地 HTTP/1.1 真跑 curl）+ 三处调用点装配 |
| `node test/notion-refetch-fallback-e2e.test.js` | 47 | 流断取回：触发判据、同 threadId、次数/预算上限、取不回仍如实失败 |
| `node test/notion-attachment-inline-e2e.test.js` | 45 | 内联附件：与抓包逐字比对、默认关零改动、字段落库、非布尔 400 |
| `node test/special-channel-output-seam-e2e.test.js` | 53 | 专用报文渠道的输出收口（notion 不许自己写响应） |

---

## 16. 已知边界（照实写，别指望它做不到的事）

1. **不是真流式**：NDJSON 整体缓冲后才分片写出。首字延迟 = 上游完成时间。
2. **模型代号表是硬编码快照**（2026-09-06，33 个），Notion 侧改名就会发过期值；有 `albuquerque-quinn` 这种未映射代号的现场。
3. **软墙维度 A 治不了**：账号在墙里时，换任何传输都没用，只能等或换号。
4. **工具是仿真**：模型不按格式输出时就没有工具调用（不报错）。
5. **附件内联**：≤1MB × 3 个，只认 base64 data URL；大文件/图片走不了这条路。
6. **`getInferenceTranscriptsForUser` 不实现**：它给的是线程清单，不是正文。
7. **不支持 `proxy` 字段**：notion 系走通道链，代理层会破坏指纹判据（`README` 协议表已注明）。
8. **`notion-agent` 门槛高**：需要 Business/Enterprise 工作区 + 带「查看会话并与代理交互」能力的集成令牌，且消耗 credits。
