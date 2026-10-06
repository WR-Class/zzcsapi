# notion 附件上传（CSV / 文件）反代研究

> **结论先行（v1.18.41 更新）**：**机制已经拿到手了，而且比原先设想的简单得多**——
> §4 记了一个可复用的抓法：notion2api 的 `upstream.base_url` 是可配的，把它指向一个记录代理，
> 就抓到了它发给 Notion 的**原始报文**。抓到的两样东西直接改写了本研究的结论：
> ① `config` step 里有一个 **`enableCsvAttachmentSupport: true`**（我们此前只发 4 个字段，没有它）；
> ② **CSV 根本不上 S3**——它把文件**内联进 user step 正文**，追加一行
> `{"file":{"file_data":"data:text/csv;base64,…","filename":"…"},"type":"file"}`。
> 所以「上传链」（§1，虽然已打通）**对 CSV 这条用途其实用不上**。
>
> **已按此形状实现**（v1.18.41，渠道级 opt-in `notionAttachments`，**默认关**），
> 并有回归守着"产出的字节与抓包逐字相同"（`test/notion-attachment-inline-e2e.test.js`）。
> **但「模型真的读到了文件」仍未活体验证**——判决实验要的那一发落在 7 个账号**同时**在软墙上的窗口里（§4.4）。
> 故本能力默认关：不活体验证就不默认上线，这条纪律不变。
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
| **CSV 进模型的机制** | ✅ **已查明（§4）** | notion2api 实发报文：`enableCsvAttachmentSupport:true` + user step 正文里内联一行 file JSON。**不走 S3、不建任务、不插 attachment step** |
| **网关侧实现** | ✅ **已实现（opt-in，默认关）** | `notionAttachments` 渠道字段；产出字节与抓包**逐字相同**（`test/notion-attachment-inline-e2e.test.js` 45 项） |
| **「模型真读到了」的活体判据** | ❌ **未取得** | 判决实验那一刻 7 个账号**全在软墙**上（§4.4）；这一格只能等窗口 |
| attachment step / 任务队列那条路 | ⏸️ **搁置** | 对 CSV 用途已被证伪为"不必要的弯路"（§4.2）；只有非 CSV（图片/大文件）才可能还要它 |

> **本轮（第 4 轮）的关键增量**：**不用再猜，也不用再翻前端源码——直接把参照实现的出站报文抓下来看**（§4.1）。
> 这一步把「附件 step 的正确形状」这个问题整个绕过去了：CSV 走的是**内联**，不是附件 step。
> 前 3 轮攒下的 §1（上传链）与 §2.0/§2.0.1（附件 step 的三个障碍）**仍然是真事实**，只是**不属于 CSV 这条路**。

> 关于「不实现」这条纪律的更新：它原本的理由是"机制不清楚，实现出来就是静默降级"。
> 现在机制清楚了（有参照实现的实发报文 + 逐字节回归），**但活体判据还没拿到**，
> 所以落点是：**实现，但默认关**，并在渠道字段/文档/测试三处都写明"未活体验证"。
> 默认关这一条本身也有断言守着——不许有人"顺手"把它打开。

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

**已排除的 pointer 取值**：`spaceId`（400）、新 `uuid`/`threadId`（400）、不传（400）、`null`（400）、`"thread:"+uuid`（400）。

### 2.0.1 ★★ 三个真障碍（本轮逐个查明，全部是"静默失败"形态）

**(1) 会话指针必须是记录指针对象，不是字符串**

```jsonc
"assistantChatTranscriptSessionPointer": { "table": "thread", "id": "<新 uuid>", "spaceId": "<spaceId>" }
```

→ **200**，`fields.bucket = "prod-files-secure"`，响应还多一个 **`chatId`**（值就等于我们传的 `id`）。
`table:"thread"` + 客户端自己生成的 uuid，与前端 `Z1({environment, table, spaceId})` 生成指针的做法一致。

**(2) step 的 `id` 必须是 uuid —— 否则整发被静默吞掉**

同一份报文，只改 step 的 `id`：

| step id | 上游响应 |
| --- | --- |
| `"attachment-0"` | **HTTP 200 + `content-type: application/x-ndjson` + 响应体 0 字节**（重发 4 次也一样） |
| `<uuid>` | **HTTP 200 + 28 KB 正常 NDJSON 流**，模型正常作答 |

**"200 空答"的真相就是这条**：上游对 id 不合法的 step 不报 400、也不给流，直接回空 body。
（顺带排除：响应头里没有任何 task id，`x-notion-request-id`/cookie 里的 uuid 拿去问 `getTasks` 全是 `{"results":[]}`；
`content_sha`/`first_object`/`record_status` 也不在 Notion 前端里，只是 notion2api 自己的字段名。）

**(3) 文件要挂 Notion 自己的 `attachment:` URI**

助手取地址响应的 **`url` 字段不是 POST 目标**，而是一个附件 URI：

```
url = attachment:9404ae49-ef82-44ef-b0cf-fe8567b335cf:probe-attach.csv
```

其中 uuid **正是 S3 `fields.key` 的中间段**（`<spaceId>/<fileId>/<name>` 里的 `<fileId>`），
与 notion2api 二进制里的 `attachment-%d` / `attachmentURLFromS3Key` 常量完全对应。
响应另外给：`signedGetUrl`（`https://file.notion.com/f/f/<spaceId>/<fileId>/<name>?table=thread&id=<uuid>&spaceId=…&signature=…`）、
`signedUploadPostUrl`（桶根 `https://prod-files-secure.s3.us-west-2.amazonaws.com/`）、`chatId`。

**fileUrl 形态的接受度（step id 已用 uuid）**：

| fileUrl 形态 | 结果 |
| --- | --- |
| 路径式 `https://s3-us-west-2.amazonaws.com/<bucket>/<key>` | 200 真答，但模型答「无法读取上传的 CSV」 |
| 虚拟主机式 `https://<bucket>.s3.us-west-2.amazonaws.com/<key>` | **400**（形状被拒） |
| `signedGetUrl`（file.notion.com） | **400**（形状被拒） |
| `attachment:<fileId>` | 200 真答，模型仍答「无法读取」 |
| `attachment:<fileId>:<name>` | **每次都撞软墙，拿不到干净判据** ← 差的就是这一格 |

**关于软墙的新认识**：附件类请求撞软墙的概率**远高于**普通请求——同一账号上"不带附件的对照"能连答，
带附件的请求却可以连撞十几次（`temporarily-unavailable`, `isRetryable:false`）。
所以**每一发附件实验都必须配一发同时刻对照**，否则会把"被限流"误读成"形状不对"。

**⚠️ 本轮结束时的现场限制（下一个人必读）**：连续实验之后，我方**云端出口 IP 对 7 个 notion 账号
全部进入软墙状态**——最后一批实验里连"不带附件的对照"都连续 8 次软墙（探针 `#48`，
8 账号 × 8 对 × 25 秒间隔全部命中软墙）。也就是说：

- 这不是账号问题，是**出口被限流**；
- 本机（Windows）**直连 notion.so 不通**（`fetch failed`），所以换不了出口；
- 要拿"最后一格"的干净判据，必须**等冷却**（隔一段时间再打）或换一个出口 IP。

因此 `attachment:<fileId>:<name>` 这一格的判决状态是：**未决（不是失败）**——
按现有证据它是最可能的正解（形态与 `attachmentURLFromS3Key` 一致），只是没能在干净窗口里验完。

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
   它一步给出最后两格的**真值**：附件 step 的 `fileUrl` 到底写什么（是 `attachment:<fileId>:<name>`、
   还是别的形态）、以及 step 上还有没有别的必需字段。**这是唯一的低成本路径**（其余都已知）。
2. 若走不了浏览器：就盯住 §2.0.1 表格里唯一"没有干净判据"的那一格 ——
   同一账号上**对照 + `attachment:<fileId>:<name>` 成对打**，直到两发都不撞软墙为止（软墙是逐发间歇的）。
3. 继续挖前端：全量 2460 个 chunk 已抓到容器 `/tmp/all/`，但构造附件 step 的**调用方**尚未定位
   （`stageAttachmentInferenceTranscriptStep` 只出现在 store 自身的两个 chunk 里）。
   可按 `t(401558).`（上传模块引用）或 `stageAttachment` 全量扫 `/tmp/all/`。
4. 找 notion2api 的 `backend/internal/service/notion_attachment_upload.go` 源码
   （发布包只给了符号名；`GALAIIS/Notion2API` 等同名仓库都不是这一份）。

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

- **已实现（v1.18.41，opt-in 默认关）**：机制见 §4；落地形态是「把内联文件行追加到最后一条 user step
  正文 + 只在真带附件时加 `enableCsvAttachmentSupport:true`」，**与 §2.4/§2.5 设想的"取目标→上传→插 step"完全不是一条路**。
- 已确认可复用的部分：**上传链**（§1，对图片/大文件仍可能有用）、**端点清单**（§1.3）、
  **三态判据与软墙识别**（§2.3）、**抓参照实现出站报文的方法**（§4.1，本轮最有价值的产出）。
- **默认关**的理由与解除条件写在 §4.4：判决实验是**一发**（对照 + 附件成对），
  一旦有账号从软墙里出来就能立刻做，命令骨架见 §4.5。

---

## 4. ★★ 机制查明：抓参照实现的出站报文（v1.18.41）

### 4.1 抓法（可复用，成本极低）

notion2api 的 Windows 发布包**没有源码**，但它的配置里 `upstream.base_url` 是**可配的**。
于是：本机起一个记录代理 → 把 `upstream.base_url` 指向它 → 用它的 API 发一发带 CSV 的对话 →
代理把**它发给 Notion 的原始报文**逐条落盘。这比翻 2460 个前端 chunk 便宜一个数量级。

```yaml
# _tmp_n2a_run/config/config.yaml（脚手架，_tmp_* 已 gitignore）
upstream:
  base_url: http://127.0.0.1:19001        # ← 记录代理
  origin: https://www.notion.so
  poll_interval_seconds: 0.5
```

代理侧有三件事必须做（都是踩出来的）：

| 坑 | 现象 | 处置 |
| --- | --- | --- |
| `origin`/`referer` 是**由 base_url 推出来的** | 它忽略配置里的 `upstream.origin`，发 `origin: http://127.0.0.1:19001` → Notion 回 401 `Must be authenticated.` | 代理层改写 `origin`/`referer` 回 `https://www.notion.so`（这一步同时**证明**了它没用那个配置项） |
| 账号导入会走"自动发现" | `POST /admin/accounts/manual {token_v2}` → 400，且自动发现也 401 | 用**完整 probe JSON** 导入（`probe_json_text`：`email`/`user_id`/`space_id`/`client_version`/`cookies:[{name:"token_v2",value:…}]`），绕开登录校验流程 |
| 账号状态会被失败打成 `error` | 随后所有请求 400 `unknown model`（不是模型名错，是**没有可用账号**） | `POST /admin/accounts/{id}/activate` 设为活跃；真出错后要重导账号 |

> ⚠️ 这条抓法有个**副作用**必须记住：抓到的 `capture.ndjson` 里**含 `token_v2`**。
> 落盘前打码（`token_v2`/`cookie`/`signature`/`X-Amz-*`），用完删目录——与仓库"密钥绝不落盘进对话"同一条纪律。

### 4.2 抓到的两样关键事实

**① `config` step 有 61 个字段，我们只有 4 个。** 其中与附件直接相关的是 `enableCsvAttachmentSupport: true`：

```json
{"type":"config","id":"<uuid>","value":{
  "type":"workflow","model":"…","modelFromUser":false,"useWebSearch":true,
  "enableCsvAttachmentSupport": true, "enableScriptAgent": true, …共 61 项}}
```

**② CSV 不上 S3 —— 内联进 user step 正文。** 这是实发报文的 `user` step（逐字抄录）：

```json
{"type":"user","id":"<uuid>","userId":"<uuid>","createdAt":"…",
 "value":[["user: 我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。\n{\"file\":{\"file_data\":\"data:text/csv;base64,c2VjcmV0LG5vdGUKSzdRMk05LG9ubHktaW4tZmlsZQo=\",\"filename\":\"probe.csv\"},\"type\":\"file\"}"]]}
```

也就是说：**客户端的内联文件（`data:` URL）→ 原样内联进提示词 + 打开那个开关**，
没有 `getUploadFileUrl`、没有 S3 multipart、没有 `enqueueTask`、没有 attachment step。
（`user: ` 前缀是 notion2api 自己的约定，我们不带它——我们不带它已经跑了 20 多个版本。）

**顺带得到的第三个事实**：它确实实现了 S3 那条路（符号表里有 `uploadAssistantAttachmentToS3` /
`enqueueAssistantAttachmentProcessing` / `waitForAssistantAttachmentTasks`），
但**对 CSV 没走**。所以 §1 的上传链不是错，只是**不属于 CSV 这条用途**。

### 4.3 同时抓到 `getInferenceTranscriptsForUser` 的**正确形状**（v1.18.39 试了 18 种全败的那个）

同一个代理里白捡的。当时失败是因为形状不对，正确形状是（`table:"space"` + `threadParentPointer` + 两个 include 开关）：

```json
POST /api/v3/getInferenceTranscriptsForUser
{"includeWorkflowThreads":true,"includeWriterChats":false,"limit":50,
 "threadParentPointer":{"id":"<spaceId>","spaceId":"<spaceId>","table":"space"}}
→ 200 {"transcripts":[{"id":"<threadId>","title":"…","created_at":…,"updated_at":…,
                      "created_by_display_name":"…","type":"workflow","usage_summary":{…}}]}
```

注意它回的是**线程清单（含 usage）**，不是成品正文——所以 v1.18.39 的取回兜底仍走"同 threadId 重发"
（那条路已验证能拿全文）。这个端点的价值是**列线程 / 看 usage / 确认线程落库**，与兜底是两件事。

### 4.4 判决实验（已就绪，等窗口）

用**我们自己的报文构造**（`notion.js`），只加上 §4.2 的两样，打一发附件；同一个账号同一时刻再打一发**对照**。
判据只有一条：**模型能不能答出只存在于 CSV 里的随机串**（`K7Q2M9`）。

**本轮的实测结果：拿不到干净判据。** 那一刻 7 个账号（notion1…notion7）**全在软墙上**
（`POST /api/v3/runInferenceTranscript` → 200 + `temporarily-unavailable`，`isRetryable:false`），
唯一非软墙的 notion2 是 400 空体（token 已死）。**软墙是账号级、且很黏**——两个不同出口 IP
（本机 `103.62.49.162` / 云端 `45.153.131.40`）撞到的是同一堵墙，说明它不是按 IP 限的。

所以这一格诚实的写法是：**机制按参照实现的实发报文实现了，活体判据欠着**。
`_probe_inline_csv.js` 就是这个判决实验（阶段 A 找健康账号、阶段 B 打附件，自带预算上限），窗口一开直接跑。

### 4.5 复现命令骨架

```powershell
# 0) 起记录代理 + notion2api（都在 _tmp_* 里，跑完删）
node _tmp_n2a_run\_capture_proxy.js                     # 127.0.0.1:19001 → https://www.notion.so
#    notion2api 后端 127.0.0.1:19998（upstream.base_url 指向上面的代理）
# 1) 用完整 probe JSON 导入账号 + 发一发带 CSV 的对话（会把整条链记进 capture.ndjson）
node _n2a_probe.js notion5 openai-file
# 2) 导出它 config step 的字段集（对齐用）
node _n2a_extract_cfg.js
# 3) 判决实验：我们自己的报文 + 两样新东西，对照与附件成对打（自带预算上限）
node _probe_inline_csv.js 14
# 4) 回归：产出的字节必须与抓包逐字相同（离线，不花额度）
node test\notion-attachment-inline-e2e.test.js
```

### 4.6 与 notion2api 的六项差异强弱结论

六项逐条的强弱判定（谁强、强多少、证据强度）**定稿在 [同类网关内部机制对比](gateway-comparison.md) §1.5**，
不在这里重复——本节只保留与本条能力直接相关的两条：第 4 项（附件/CSV）是它实打实领先的一格；
反向证据是它的 config step 有 61 个开关、我们只有 4 个。

### 4.7 下一步（按性价比）

1. **等软墙窗口，跑 §4.4 的判决实验**——一发定生死。若答出随机串 → 打开 `notionAttachments` 并把本文改成"已活体验证"；
   若答不出 → 说明还差别的（下一个怀疑对象是 `enableScriptAgent` 那组开关，或 notion2api 那份 `user: ` 前缀）。
2. 若要支持**图片/大文件**（内联不现实），再回到 §1 的上传链 + §2.0 的 attachment step；那时 §2.0.1 的三个障碍重新变成待办。
3. 顺手可做：把 `getInferenceTranscriptsForUser`（§4.3）接成一个"列 notion 线程"的只读诊断端点——**成本低、无额度**。
