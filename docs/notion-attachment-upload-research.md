# notion 附件上传（CSV / 文件）反代研究

> **结论先行**：**上传链已打通**（活体验证，可复现）；**「让 AI 读到」尚未打通**，卡在
> 「附件 step 的正确形状」与「上游的附件处理任务队列」之间。本文只记三类东西：
> ① 已验证的事实（带复现命令）② 被证伪的猜测 ③ 下一步该找什么。
>
> 研究日期 2026-10-06 · 上游 `https://www.notion.so`（云端容器内、真实 `token_v2`）·
> 参照实现 notion2api（Go / Apache-2.0，Windows 包 0.1.0，source commit `189b0ecb…`，本机只有二进制，仓库未定位到）。

---

## 0. 一句话状态表

| 环节 | 状态 | 判据 |
| --- | --- | --- |
| 取上传目标（`getUploadFileUrl`） | ✅ **通** | `POST /api/v3/getUploadFileUrl {bucket:"public",name,contentType}` → **200** |
| 把字节传到 Notion S3 | ✅ **通** | `POST` 到**桶根** multipart（fields 全带 + file 最后）→ **204** |
| 拿文件的可下载直链 | ✅ **通** | 响应里的 `signedGetUrl`（6 小时签名直链）；公开 URL = 桶根 + `fields.key` |
| **让 AI 读到文件内容** | ❌ **未通** | 形状已按 **Notion 自己的前端代码**对齐（扁平 `{type:"attachment", fileUrl}`）后仍是 **200 空答**；缺的是「文件先登记进会话」（§2.0） |

> **本轮（第 3 轮）的关键增量**：**拿到了 Notion 自己的前端源码**（方法见 §2.0），
> 于是「附件 step 长什么样」「助手对话的上传走哪个事件」不再是猜测，而是抄官方代码；
> 照着抄完仍不生效，把缺口精确收敛到**一个字段**：`assistantChatTranscriptSessionPointer`（已排除 `spaceId`）。

**没有打通「让 AI 读到」之前不要实现这个功能**——一个"文件传上去了、模型却读不到"的附件能力，
是"看起来成功、实际没用"的**静默降级**，与本项目对静默失败的一贯态度相反。

---

## 1. 已打通：上传链

### 1.1 取上传目标

```
POST https://www.notion.so/api/v3/getUploadFileUrl
头：与 notion.js 的 notionHeaders(acct, token, baseUrl) 完全一致
    （cookie: token_v2=<渠道 apiKey>; notion_user_id=<userId>
      x-notion-space-id / x-notion-active-user-header / notion-client-version / origin / referer: /ai）
体：{"bucket":"public","name":"probe-attach.csv","contentType":"text/csv"}
```

**200** 响应（顶层字段，实测全量）：

| 字段 | 含义 |
| --- | --- |
| `type` | `"POST"`（S3 POST policy 表单上传） |
| `url` | 带 key 的对象地址（**不要拿它当 POST 目标**，见 1.2） |
| `signedGetUrl` | 6 小时有效的签名 GET 直链（`X-Amz-Expires=21600`） |
| `signedUploadPostUrl` | 桶地址（`https://s3.us-west-2.amazonaws.com/public.notion-static.com`） |
| `postHeaders` | 实测 `[]` |
| `fields` | S3 表单字段（见 1.2） |
| `signedToken` | 44 字符的签名令牌（用途未证实） |
| `customerKeyApplied` | 实测 `false` |

`fields` 的键（固定这 11 个）：
`Content-Type, x-amz-storage-class, tagging, bucket, X-Amz-Algorithm, X-Amz-Credential,
X-Amz-Date, X-Amz-Security-Token, key, Policy, X-Amz-Signature`
（`key` 形如 `<uuid>/<文件名>`；`tagging` 是 233 字节的 XML；`Policy` 2404 字节；
`X-Amz-Security-Token` 1076 字节——**都是临时凭据，绝不落文档、绝不回显**。）

**桶白名单**：`bucket:"public"` → 200；`secure` / `private` / `notion-static` → 400 `ValidationError`。

### 1.2 把字节传上去（三个坑，都踩过）

```
POST https://s3-us-west-2.amazonaws.com/<fields.bucket>/     ← ★ 桶根，不是 url 里那个带 key 的地址
multipart/form-data：fields 的 11 个键各一份 + file 放最后
成功码：204
```

1. **★ POST 目标是桶根**，对象名由 `fields.key` 决定。照 `url`（`…/public.notion-static.com/<uuid>/x.csv`）
   直接 POST 会被 S3 回 **405 `MethodNotAllowed`（`ResourceType: OBJECT`）**——这是最容易被误读成"权限不够"的一步。
2. **★ 必须用 `curl --form-string`（或等价地不要解释值）**：`fields.tagging` 的值是一段 XML，
   `curl -F "tagging=<Tagging>…"` 会把 `<` 解释成「从文件读内容」→ 整个上传**静默失败**
   （进程非 0 退出、响应体空，看起来像网络问题）。同理 `Policy`/`X-Amz-Security-Token` 极长，也别拼进 shell 的 `-F`。
3. 公开 URL = **桶根 + `fields.key`**，例如
   `https://s3-us-west-2.amazonaws.com/public.notion-static.com/<uuid>/probe-attach.csv`。
   该 URL 可用 `signedGetUrl` 直接下载校验（实测下回来的字节与上传的一致）。

### 1.3 端点是怎么"猜"出来的（方法可复用）

对候选路径发**空 body 的 POST**，看状态码：

- **404 + `text/html`**（`Cannot POST /api/v3/…`）→ 路径不存在
- **400 + `application/json`**（`{"isNotionError":true,"name":"ValidationError","debugMessage":"Invalid input."}`）→ **路径存在**，只是 body 不对

17 个候选路径里命中 3 个真端点：

| 路径 | 实测 |
| --- | --- |
| `/api/v3/getUploadFileUrl` | 200（`bucket:"public"` + `name` + `contentType`） |
| `/api/v3/getTasks` | `{taskIds:[…], spaceId}` → 200 `{results:[…]}`；`{}` / `{spaceId}` → 400；`{taskIds:[], spaceId}` → 200 `{results:[]}` |
| `/api/v3/getSignedFileUrls` | `{urls:[…]}` 过校验（不是 400），但对公开 URL / key / `signedGetUrl` 三种入参都回 `UnknownApiError`（500） |

**不存在**（404，别再试）：`createAssistantAttachmentUploadTarget`、`uploadAssistantAttachment`、
`enqueueAssistantAttachmentProcessing`、`getAssistantAttachmentSignedURL`、`saveUploadedFile`、
`getFileUploadUrl`、`uploadFile`、`createUploadTarget`、`getPublicUrl`、`uploadAssistantChatAttachment` 等。
—— 也就是说，上游二进制里那些 `createAssistantAttachmentUploadTarget` / `enqueueAssistantAttachmentProcessing`
**只是 Go 的方法名，不是 HTTP 路径**；对应的真实路径是上表那三个。

---

## 2. 未打通：附件怎么进模型

### 2.0 ★ 已经拿到 Notion 自己的前端源码（本轮新增，方法可复用）

**这是本轮最重要的进展**：不再靠猜。Notion 网页端本身就是这套 API 的客户端，把它的 JS 抓下来就有权威答案。

**怎么抓（可复用，踩了三个坑）**：

1. `https://www.notion.so/ai` 的壳 HTML 只挂 13 个 `/_assets/*.js`（19.9 KB，登录与否都一样）。
2. 壳里有 webpack 运行时，chunk 的 URL 规则是
   `.u = e => "" + (({id:"ChunkName",…})[e] || e) + "-" + ({id:"hash",…})[e] + ".js"`
   —— **分隔符是 `-` 不是 `.`**，且**有名字的 chunk 用名字当文件名**（如 `AgentChatView-ec4dbab308a3e1d5.js`）。
   按 `id.hash.js` 拼会全 404（回 `Not Found: _assets/13995.….js`），这是第一个坑。
3. 两张表都在 `app-*.js` 里、**十万字节级**：名字表 **1394** 项、哈希表 **2460** 项。
   用正则在这么大的对象上抽会**回溯卡死**（第二个坑），必须用字符扫描做括号配对 + `split(',')` 解析。
4. 表里能直接看出功能名：`AgentChatView` / `AgentPage` / `AIChatStore` / `agentWriter` / `SharedChatAppView` /
   `inferenceTranscriptActions` / `agent-messages` / `agent-chat-transcribe-audio-to-text` …

**从中读到的权威事实（全部来自 Notion 自己的代码）**：

| 事实 | 出处 |
| --- | --- |
| 助手对话的上传走**另一个事件**：`getUploadFileUrlForAssistantChatTranscriptUpload` | 壳包 |
| 它的 payload：`{name, contentType, assistantChatTranscriptSessionPointer, contentLength, createThread, threadType, workflowId, agentMemorySettings, allowUnsupportedTypes}` | 同上 |
| 上传完成后 `bucket:"temporary"`（不是我们用的 `public`） | 同上 |
| 上传完成回调给的是 **`{fileUrl, signedToken}`** | `ai-meetingNotesUploadActions.js`（`Zn({…, onBatchComplete: t => e({fileUrl:t.fileUrl, signedToken:t.signedToken})})`） |
| 暂存的 transcript step 是**扁平的**：`{type:"attachment", fileUrl, metadata?}`，兄弟类型 `"computer-file"` | `ai-AIChatStore.js` |
| 安全标记写在 `metadata.guardrail.attachmentRisk` 上 | 同上 |
| 暂存字段名：`stagedInferenceTranscriptSteps` / `stagedClientSteps` / `stagedEngineSteps`，取出函数 `getAndClearStagedAssistantAttachmentSteps()` | 同上 |

**据此实测（干净账号 notion5，对照真答，见探针 `probe-notion-attachment35.js`）**：

| 挂法 | 结果 |
| --- | --- |
| ① 对照（不带附件） | 200 **真答**「无法读取你上传的 CSV」→ 账号健康、整组有效 |
| ② 扁平 `{id:"attachment-0", type:"attachment", fileUrl}` | 200 **空答** |
| ③ ②+signedToken | 200 空答 |
| ④ ②+`metadata.guardrail.attachmentRisk` | 200 空答 |
| ⑤ ②+name/contentType/contentLength | 200 空答 |
| 助手事件 `getUploadFileUrlForAssistantChatTranscriptUpload`（把 spaceId 当 pointer 试） | **400 ValidationError** |
| 助手事件（把**新 uuid 当 pointer**、同时当 `threadId` 试，见 `probe-notion-attachment36.js`） | **400 ValidationError** |

**结论**：形状已按官方代码对齐（扁平 `fileUrl`），仍然 200 空答 —— 说明缺的**不是** step 形状，
而是「文件先被登记进某个会话」这一步：上传必须走助手事件、且要带**正确的**
`assistantChatTranscriptSessionPointer`。这也解释了为什么模型会明确说"请重新上传"：
它收到了一条**指向未登记文件**的 step。

**已排除的 pointer 取值**：`spaceId`（400）、新 `uuid`/`threadId`（400）。
剩下的可能是一个**指针对象**（Notion 里 `(295447).Z1({environment, table, spaceId})` 是生成指针的工厂，
`table` 可能是 `thread`/`assistantChatTranscript`），这一步**没有再猜下去**——
猜错一次就是一次 400，性价比已低于"直接在浏览器里抓一发真报文"（见 §2.5 第 1 条）。

**已排除的可能**：`content_sha` / `first_object` / `single_object` / `record_status` 这些常量
**不在** Notion 前端里（全包 0 命中），它们只是 notion2api 自己的 Go 结构体字段名，不是 Notion 的 API 字段。

### 2.1 试过的挂法与结果（干净账号 notion5 / notion1，同一次实验）

判据三态：`400 ValidationError` = 形状被拒 · `200 + 流内 temporarily-unavailable` = 软墙（无效） · `200 + 真答` = 有效。

| 挂法 | 结果 |
| --- | --- |
| 对照：不带附件 | 200，模型正常回答 |
| 独立 step `{id:"attachment-0", type:"attachment", value:{type:"file",url,name,contentType,contentLength}}` | notion5 **200 空答** / notion1 **400 ValidationError** |
| 把文件对象挂进 user step 的 `value`（`[[文本], 文件]` 或 `[[文本],[文件]]`） | 200，模型答「**无法读取 CSV / 请重新上传**」——文件被**忽略** |

### 2.2 严格校验：这些键名会被 400

`attachment` step 的 `value` 是**严格校验**的（多一个不认识的键就整发 400），实测：

| 键 | 结果 |
| --- | --- |
| `type:"file"`、`url`、`name`、`contentType`、`contentLength` | 200（被接受，但模型读不到） |
| `signedToken`、`record:{…}`、`content_sha`（base64）、`source`、`size`、`type:"csv"` | 200 |
| `fileName`、`mimeType`、`title`、`content_sha`（**hex**）、`record_status`、`first_object`、`single_object` | **400** |
| `type:"csv-attachment"` / `type:"file"`（当 step 类型用） | 400 / 200 空答 |

→ 被接受的键集合说明"形状对了但内容没接上"：上游认这个对象，但**没有把 S3 对象变成模型能读的附件**。

### 2.3 ★ 方法论警告：软墙 ≠ 形状错（这一条比结论更值钱）

Notion 对同一个账号的**软墙**表现为：

```
HTTP 200
{"type":"patch-start","data":{"s":[{"type":"error",
  "message":"Something went wrong. Please try again later.",
  "subType":"temporarily-unavailable","isRetryable":false, …}]}}
```

而**形状错**是：

```
HTTP 400
{"isNotionError":true,"name":"ValidationError","debugMessage":"Invalid input.", …}
```

两者是**完全不同的信号**，但我在中途把它们混在一起读了，于是得出过一个**错误结论**：
「附件要等上游处理约 50 秒才被接受（立刻发 400、等一会儿 200）」。
推翻它的证据是：在同一个账号上，**连不带附件的对照那一发**也吃到了软墙（`temporarily-unavailable`），
而 400/200 的分布随账号与时间漂移、并不随"等待时长"变化。

**纪律**：判定某个形状是否被接受，必须先看**同一时刻、同一账号、不带附件的那一发是不是真答**；
对照不真答，整组实验作废。7 个 notion 渠道要**轮着用**，别把一个账号打到限流再读结果。

### 2.4 还没解开的符号（下一步的抓手）

notion2api 二进制里的符号名（**不是** HTTP 路径，是方法名）：
`createAssistantAttachmentUploadTarget` · `enqueueAssistantAttachmentProcessing` ·
`waitForAssistantAttachmentTasks` · `extractTaskIDs` · `notionTasksTerminal` ·
`getAssistantAttachmentSignedURL` · `parseNotionUploadTarget` · `walkUploadTarget` ·
`looksLikeS3Fields` · `isS3UploadURL` · `preferredS3FieldOrder` · `injectUploadedAttachmentsIntoPayload` ·
`insertAttachmentStepsBeforeUser` · `sanitizeAttachmentFileName` · `attachmentURLFromS3Key`

对应的字符串常量：`attachment-%d`（step id 形态）· `Attachment - `（疑似标题前缀）·
`first_object` · `single_object` · `content_sha` · `record_status` · `task_ids` · `getTasks` · `download` ·
`fileName` · `mimeType` · `array:%d` · `includeCounts` · `clientVersion` · `contentLength`。

`first_object` / `single_object` / `content_sha` / `record_status` 这四个常量在二进制里**紧挨着**
`attachment-%d` 与 `Attachment - `，同属 `notion_attachment_upload.go` 那个源文件的常量区；
但本次实测 `getUploadFileUrl` 的响应里**没有**它们 —— 也就是说上游很可能**还有一个"登记文件记录"的端点**
（task id 大概也从那里出来）。同区域还能读到的其它常量（供下一步排查）：

- 记录形状类：`value_wrapper_keys` · `record_author_role` · `record_value_shape` · `record_content_shape` ·
  `step_content_shape` · `turn-full-record-map` · `stream_message_ids`
- 开关/特性类：`includeWriterChats` · `enableCustomAgents` · `disable_ai_feature` · `enableDatabaseAgents` ·
  `enableCrdtOperations` · `isCustomAgentBuilder` · `enableAgentAskSurvey` · `requireWorkTypeEmail`
- 附件流水线：`load_spaces_failed` · `storage_state.json`（notion2api 的登录助手用 Playwright，
  `login_helper.sessions_dir` / `data/notion_accounts`）

**缺口只有一个：task id 从哪来。** `getTasks` 的形状已经确认（`{taskIds:[…], spaceId}` → `{results:[…]}`），
只要拿到附件处理任务的 id，剩下的路（轮询 → 取签名 URL → 重发/注入）就都能照着 notion2api 的符号名走通。

### 2.5 下一步建议（按性价比排序）

1. **在浏览器里把一份 CSV 挂进 Notion AI 对话，抓 `runInferenceTranscript` 的真实报文**——
   一步到位（它同时给出 `assistantChatTranscriptSessionPointer` 的真值和附件 step 的最终形状）。
   **本轮已按 §2.0 把形状对齐到官方代码后仍不生效，所以这一步现在是唯一的低成本路径。**
2. 找 `assistantChatTranscriptSessionPointer` 的语义：已排除 `spaceId`（400）。它是"会话指针"，
   可能形如 `{table, id, spaceId}` 的复合指针（Notion 里 `(295447).Z1({environment, table, spaceId})`
   就是生成指针的工厂函数）——前端里 `assistantChatTranscript` 只在壳包出现 2 次，构造点在别的 chunk。
3. 找 task id 的来源：`getTasks` 的形状已确认（`{taskIds:[…], spaceId}` → `{results:[…]}`），
   拿到附件处理任务的 id 后即可轮询 → 取签名 URL → 重发。
4. 找 notion2api 的 `backend/internal/service/notion_attachment_upload.go` 源码
   （发布包只给了符号名；`GALAIIS/Notion2API` 等同名仓库都不是这一份）。注意：
   `content_sha` / `first_object` / `single_object` / `record_status` **不在** Notion 前端里（0 命中），
   是 notion2api 自己的字段名，别再当 Notion 字段去试。
5. 继续挖前端：本轮只抓了名字匹配 AI/附件的 **125** 个 chunk（哈希表共 2460 项）。
   构造附件 step 的调用点（`stageAttachmentInferenceTranscriptStep` 的**调用方**）尚未定位，
   它所在的 chunk 名字不含 AI/chat/attach 关键词；可按 `t(401558).`（上传模块的引用）全量扫一遍。

### 2.6 复现命令骨架

```bash
# 0) 账号发现：★ notionDiscoverAccount 返回 {userId,userName,userEmail,spaces}——**没有 spaceId**，
#    漏补 acct.spaceId = acct.spaces[0].spaceId 的话，payload 里 spaceId 是 undefined，
#    JSON 一序列化就消失，上游对**所有**报文一律 400「Invalid input.」（本次栽过一次）
# 1) 取目标
curl -s -X POST https://www.notion.so/api/v3/getUploadFileUrl \
  -H 'Content-Type: application/json' -H 'User-Agent: <NOTION_UA>' \
  -H 'cookie: token_v2=<渠道 apiKey>; notion_user_id=<userId>' \
  -H 'x-notion-space-id: <spaceId>' -H 'x-notion-active-user-header: <userId>' \
  -H 'notion-client-version: 23.13.20260228.0625' -H 'origin: https://www.notion.so' -H 'referer: https://www.notion.so/ai' \
  --data-binary '{"bucket":"public","name":"probe-attach.csv","contentType":"text/csv"}'
# 2) 上传（fields 全带 + file 最后；★ --form-string）
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'https://s3-us-west-2.amazonaws.com/public.notion-static.com/' \
  --form-string 'Content-Type=text/csv' … --form-string 'key=<fields.key>' … \
  -F 'file=@probe-attach.csv;type=text/csv'      # 期望 204
# 3) 附件实验：先发对照（不带附件），确认这一发是「真答」而不是软墙，再逐个试形状
```

---

## 3. 对本网关的意义

- **不实现**：能力不完整时不上线（理由见开头的静默降级）。
- 已确认可复用的部分：**上传链**（§1）、**端点清单**（§1.3）、**三态判据与软墙识别**（§2.3）。
- 一旦补上 §2.4 那个缺口，落地形态很清楚：客户端面的附件 → 取目标 → 上传 → 按正确形状注入
  `runInferenceTranscript` 的 transcript（在 user step **之前**插 step，id 用 `attachment-%d`），
  并把 `bucket:"public"` 写死（其余桶实测 400）。
