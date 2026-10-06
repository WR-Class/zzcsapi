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
> ~~故本能力默认关：不活体验证就不默认上线，这条纪律不变。~~
> **已推翻（v1.18.42）**：传输层修好后判决实验在 `notionls` 上给出**已打通**（§8），
> 「默认关」现在只是**稳妥默认**（内联附件会改 user step 正文、吃 prompt 预算），不是"没验证过"。
> **第 6 轮追加**：两个排除性实验（§5）把原因钉死了——软墙**既不是报文形状、也不是客户端版本**，
> 而是**挂在"AI 推理"这一层**（同一批账号的 `getInferenceTranscriptsForUser` 全部 200 且读得出 50 条线程）。
> 结论：**别再为软墙调形状**，只能等账号的 AI 权益恢复。
> **第 7 轮（v1.18.43）再修正**：上一条只说对了一半——软墙有**两个独立维度**（§7.7）：
> **账号状态**（主导，与传输无关，随时间变）与**客户端指纹**（只在账号可过时才看得见）。
> 第 6 轮看见的是维度 ①（所以"只能等"在那一刻是对的），v1.18.42 修的是维度 ②。
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
| **「模型真读到了」的活体判据** | ✅ **已活体验证（§8）** | 2026-10-06 打通传输层后：对照（不带附件）模型说"没找到你上传的 CSV"；附件那一发**答出 `K7Q2M9`**。并经**本地容器网关** `/v1/chat/completions` 复验：纯文本「收到」、带内联 CSV 问 secret 列 → 「K7Q2M9」 |
| **软墙到底是什么** | ✅ **已定位并修复（§7、§7.7）** | **两个维度**：① **账号状态**（主导，与传输无关、随时间变——`notion7` 在本地与云端、五种传输一起软墙；且在云端曾有短暂开口）；② **客户端指纹**（只在账号可过时才看得见——同一秒交替打：curl 3/3 真答、fetch 0/3 软墙）。出站已改成 **curl 主 → h2 兜底 → fetch 最后**，软墙在通道内自动换；**这一修法治维度 ②，治不了维度 ①**（那时如实报 `ok:false / notion: temporarily-unavailable`） |
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

> **📌 本节标题是当时的状态（历史注记，刻意不改）。结局见 §4.2 与 §8**：CSV 这条用途最终**不走上传链**，
> 而是内联进 user step（v1.18.41 实现）；而"模型真读到了"的活体判据在 v1.18.42 取得（§8）。
> 本节保留的是**当时为什么卡住**——卡点被证明**不在报文形状**上，而在**出站传输**（§7）。

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

**v1.18.41 定稿时的复跑（同日稍晚，预算 14 发）**：7 个账号逐个打对照，**仍然一个健康账号都没有**——
`notion2 / notion5 / notion1 / notion4 / notion6` 软墙（200 + `temporarily-unavailable`）、
`notion3` 400 空体（token 已死）、`notion7` **200 但零内容且无软墙标记**。

> `notion7` 那个"200 + 零内容 + 无软墙标记"是个**新形态**，与已知三态（真答 / 软墙 / 形状错 400）都不同：
> 既没被软墙，也没回正文。可能是"账号活着但额度/权限受限"，也可能是另一种限流措辞。
> **处置纪律**：不许把它当"形状错"（那会冤枉自己的报文），也不许把它当"成功"（那是静默降级）——
> 只能记成"这一发拿不到判据"，等它稳定复现后再单独查。
> **（第 6 轮更正）**复跑时 notion7 明确回的是软墙（`patch-start` 里带 `temporarily-unavailable`），
> 所以那次"无软墙标记"是**同一次探测里的偶发形态**（多半是流被我截断在前几行、标记行还没到）。
> 结论按 §5 走：**别为它调形状**。

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
node notion-attachment-verdict.js 14      # ★ 已入库的一等工具（仓库根，非 test/）；旧的 _probe_inline_csv.js 是它的草稿
# 4) 回归：产出的字节必须与抓包逐字相同（离线，不花额度）
node test\notion-attachment-inline-e2e.test.js
```

> **工具已入库**：`notion-attachment-verdict.js`（仓库根，`README.md`「notion 附件判决实验」一节 + `AGENTS.md` §3 都有登记）。
> 它把上面这个实验做成了一等公民：三种结论（**已打通** / **没读到** / **未取得**）、成对打的纪律、
> 预算上限、以及**报告绝不回显凭据**。所以"等窗口"不再依赖任何 `_tmp_*` 草稿——草稿删了也不会丢。

### 4.6 与 notion2api 的六项差异强弱结论

六项逐条的强弱判定（谁强、强多少、证据强度）**定稿在 [同类网关内部机制对比](gateway-comparison.md) §1.5**，
不在这里重复——本节只保留与本条能力直接相关的两条：第 4 项（附件/CSV）是它实打实领先的一格；
反向证据是它的 config step 有 61 个开关、我们只有 4 个。

### 4.7 下一步（按性价比）

1. **等软墙窗口，跑 §4.4 的判决实验**——一发定生死。若答出随机串 → 打开 `notionAttachments` 并把本文改成"已活体验证"；
   若答不出 → 说明还差别的（下一个怀疑对象是 `enableScriptAgent` 那组开关，或 notion2api 那份 `user: ` 前缀）。
2. 若要支持**图片/大文件**（内联不现实），再回到 §1 的上传链 + §2.0 的 attachment step；那时 §2.0.1 的三个障碍重新变成待办。
3. 顺手可做：把 `getInferenceTranscriptsForUser`（§4.3）接成一个"列 notion 线程"的只读诊断端点——**成本低、无额度**。

---

## 5. ★ 软墙的层次定位（v1.18.41 追加，把"再猜形状"这条路彻底关掉）

> ⚠️ **本节结论已作废，留档备查**：§5.3 得出的"墙挂在账号的 AI 推理权益上、只能等窗口"**是错的**——
> 同日就被"同一账号浏览器能答"推翻（§6），最终定位为**客户端指纹评分**（§7）。
> 本节唯一仍然有效的产出是**实验方法**：用排除性实验一层层切，而不是继续猜报文形状。
> **但请连方法一起记住它的教训**：排除法只能在**同一个运行环境**内推进；跨环境（宿主机 ↔ 容器）的结论必须复验（§7.3）。

第 1~3 轮反复在**报文形状**上找原因（18 种取回形状、三种指针、uuid、`attachment:` URI）。
第 5~6 轮做了两个**排除性实验**，结论是：**软墙与报文形状、与客户端版本都无关，它挂在"AI 推理"这一层**。

### 5.1 实验一：客户端版本过旧？（**否**）

侦察发现 Notion 网页今天的客户端版本是 **`23.13.20261006.0243`**（`https://www.notion.so/ai` 页面里的版本串），
而我们硬编码的是 **`23.13.20260228.0625`**——**约 7 个月前**，且 Notion 恰好**就在今天**滚了新版本。
这个假设很有诱惑力（能解释"7 个账号同时软墙"），所以直接做了 A/B：**同一账号、同一发报文，只换 `notion-client-version` 头**。

| 账号 | 旧版本 `23.13.20260228.0625` | 新版本 `23.13.20261006.0243` |
| --- | --- | --- |
| notion1 | 软墙（200，1561ms） | 软墙（200，835ms） |
| notion7 | 软墙（200，927ms） | 软墙（200，1725ms） |
| notion5 | 软墙（200，1814ms） | 软墙（200，1347ms） |

→ **版本不是原因**（新版本一样被墙）。原始报文里那一段是：

```json
{"type":"patch-start","data":{"s":[{"type":"error","message":"Something went wrong. Please try again later.",
  "traceId":"…","id":"…","isRetryable":false,"subType":"temporarily-unavailable"}]}}
```

> 版本这件事仍然值得记下来（我们用的头比 Notion 自己的旧 7 个月），但**它是一个待观察项，不是已确认的问题**：
> 因为账号全被墙，没法验证"换新版本会不会让某个本来能用的账号变坏"（新版本可能改了响应形状）。
> **处置：不动代码**（不许在没法验证的情况下去改一个正在跑的头），记在这里，等有健康账号时做 A/B。

### 5.2 实验二：账号整体被封，还是只有推理被封？（**只有推理**）

拿今天抓到的 `getInferenceTranscriptsForUser` 正确形状（§4.3）打一发——**它不消耗 AI 额度、不触发推理**：

| 账号 | `getInferenceTranscriptsForUser` | 同一账号的 `runInferenceTranscript` |
| --- | --- | --- |
| notion2 | **200，50 条线程，306 KB** | 软墙 |
| notion5 | **200，50 条线程，634 KB** | 软墙 |
| notion1 | **200，50 条线程，652 KB** | 软墙 |

→ **token 是活的、空间是活的、线程历史读得到**（`getSpaces` 也能发现账号），**只有 `runInferenceTranscript` 被墙**。

### 5.3 这两条排除掉什么、剩下什么

- **排除**：报文形状错（§2.3 的判别纪律再次成立：形状错是 **400 ValidationError**，不是 200 + `temporarily-unavailable`）、
  客户端版本过旧、token 失效、账号被封、出口 IP 被限（本机与云端两个 IP 撞同一堵墙）。
- **剩下**（都属于 Notion 侧、我们改不了）：**工作区的 AI 额度/权益**，或账号级的**推理限流**。
  `message` 是通用文案、没有额度字样，所以两者区分不了——但**两者都只能等**。
- **由此得到一条纪律**：**不要再为软墙去调报文形状或请求头**。第 1~3 轮那种"再试一种形状"的做法，
  在软墙面前是纯浪费（而且是拿真额度去浪费）。软墙只认一件事：**等账号的 AI 权益恢复**。

### 5.4 软墙窗口的探测器（成本可接受）

因为非推理端点在被墙时**照样返回 200**，它**检测不出恢复**；唯一可靠的探测器就是真打一发推理：

| 状态 | 还在墙里 | 恢复 |
| --- | --- | --- |
| 一发推理的代价 | ~1~2 秒、**无真实推理**（不发额度） | 真答一次（这是我们要的结果） |

---

## 6. ★★★ §5 的结论被推翻：墙不在账号侧，在我们这一侧（同日追加）

**触发证据（用户提供）**：同一时刻、同一个账号（`notionls`，空间就是 `hixzlctain's Space`）、**同一个浏览器窗口**里，
我们发的那条 CSV 问题显示「出错了。请稍后再试。」，而用户**紧接着自己发的一条消息正常答完了**（带 6 个步骤的 agent 回答）。
同一账号、同一空间、同一出口 IP、同一分钟 —— **浏览器能答，我们不能**。

**⇒ §5.3 那句"属 Notion 侧权益/限流、只能等"是错的，撤回。** 下面是这一轮排掉的东西与剩下的。

### 6.1 排掉的（每条都是一发实测，同一账号同一时刻）

| 假设 | 怎么试的 | 结果 |
| --- | --- | --- |
| 账号没额度/没资格 | `getAIUsageEligibility` | **`isEligible:true`、`type:"unlimited"`**（notionls / notion1 / notion5 三个都是）→ 不是额度 |
| 挑错了空间 | `getSpaces` 看空间数；逐个空间打 | 只有 **1 个**空间（`cb718596…`），不是挑错 |
| 挑错了用户 | `getSpaces` 看用户数 | 只有 **1 个** notion_user，`x-notion-active-user-header` 与之一致 |
| 域名不对 | `app.notion.com` vs `www.notion.so` | 两个都墙（origin/referer 跟着域名一起换） |
| 客户端版本过旧 | 旧 `23.13.20260228.0625` vs 新 `23.13.20261006.0243` | 都墙（§5.1 已记） |
| config step 字段不对 | 5 个变体：基线 / 去掉 model / `modelFromUser:false` / **逐字对齐 Notion 回写的 7 字段** / 加 `user: ` 前缀 | 全墙 |
| 请求体多发了调试字段 | 4 个变体：基线 / 去 `debugOverrides` / 再两个 `isSalesAssisted` / **只留浏览器那 12 个键** | 全墙 |
| 请求头不对 | 5 个变体：基线 / `Accept:*/*` / 去 `notion-audit-log-platform` / 新版本+`Accept` / 新版本+浏览器式 referer | 全墙 |
| step 缺 `userId`/`createdAt` | 三个 step 全补上（参照实现有、我们没有） | 墙 |
| threadType 该用轻量聊天 | `markdown-chat` | **换了一种错**：400 `ValidationError / Invalid input.`（形状错，不是墙） |
| 模型别名无效 | `model:"auto"` / 用注册表第一个 id | 墙 |

### 6.2 这一轮新拿到的两条硬事实

1. **Notion 回写给我们记录里的 config step 被它整个改写了**：我们发的 `{type, model:'claude-opus5', modelFromUser:true, useWebSearch}`
   在它记录的线程里变成 `{type, modelFromUser:false, useWebSearch:true, isCustomAgent:false,
   enableLargeToolResultComputerOffload:false, useContextualCoreDocsAutoLoad:false, useDocPreviewsForCoreAutoLoad:true}`
   —— **`model` 没了、`modelFromUser` 被改成 false**。说明服务端**没接受我们的 config**、替成了它自己的默认。
2. **`getAvailableModels` 今天返回空**：`{"modelSelectionRestricted":true,"restrictedGeoPolicyApplied":false,
   "restrictedGeoHiddenWorkflowModels":[],"models":[]}`，而 `notion.js:15` 记着 **2026-09-06 这个端点还返回 33 个模型**。
   一个月内模型注册表被清空 —— 与"今天正好滚了新客户端版本"撞在一起。

### 6.3 剩下的唯一未知：**能用的浏览器到底发了什么**

上面 11 类假设全部排掉之后，唯一还没拿到的证据是**浏览器那发成功请求的原始报文**。
拿到它就能机械 diff 出差别（我们与它的差异只剩"还没试过的字段"），不需要再猜。
`_tmp_notion2api\browser-capture.txt` 就是这个用途（见 §6.4 的取法）。

> **结局（v1.18.42）**：报文拿到了、也逐字重放了，**仍然是墙**——请求体/请求头/Cookie 全部被豁免，
> 真根因在**传输层的客户端指纹**，见 §7。本节"唯一未知"的判断到此为止。

> ⚠️ **纪律**：抓到的 cURL **含 `token_v2`**。必须**存进 `_tmp_notion2api\browser-capture.txt`（已 gitignore）**，
> **绝不许贴进对话**；用完即删。这与 §4.1 的抓包纪律是同一条。

### 6.4 取法（60 秒）

1. 在**能正常回答**的那个 Notion AI 窗口按 `F12` → 切到 **Network**
2. 过滤框输入 `runInferenceTranscript`
3. 在窗口里**再发一条**（例如 `1+1=?`），等它答完
4. 列表里会多出一条 `runInferenceTranscript` → 右键 → **Copy → Copy as cURL (bash)**
5. 粘贴保存为 `D:\DSHXM\ZZCSAPI\_tmp_notion2api\browser-capture.txt`（**不要贴进对话**）

---

## 7. ★★★ 软墙的真根因：**客户端指纹评分**（v1.18.42 已修复）

### 7.1 用户抓到的那两发，把差异锁到了一个字段

用户按 §6.4 抓了**两发**（同一线程、同一分钟内，一发失败一发成功）。两发逐字对比，**唯一差别**：

| | config step | 结果 |
| --- | --- | --- |
| 第一发（失败） | 有 `"model":"albuquerque-quinn"` | 「出错了。请稍后再试。」 |
| 第二发（成功） | **没有 `model` 字段** | 正常答完 |

⇒ 该工作区**不能指定模型**（与 §6.2 的 `getAvailableModels → "models":[]` 完全对上）。
但这条只解释了"浏览器那两发为什么一发挂一发成"，**解释不了我们**——我们试过"不带 model"（§6.1 变体 2/4）同样被墙。

### 7.2 判决实验：把浏览器成功报文**逐字重放**，还是墙 → 请求体被豁免

拿第二发（成功）的完整报文，连 `threadId`、`subStepId`、`traceId` 都不改，直接重放：

| 变体 | 结果 |
| --- | --- |
| 1 只换 Cookie（用我们的头） | 软墙 |
| 2 + 浏览器那两枚 `x-notion-cell-hint` | 软墙 |
| 3 + 浏览器 UA(Chrome/154) + `sec-*` 全套 | 软墙 |
| 4 + 浏览器**整串 Cookie**（20 枚，含 `__Host-session_binding`、`csrf`、`__cf_bm`） | 软墙 |

**请求体、请求头、Cookie 全部被豁免。** 剩下的维度只有**传输层**。

### 7.3 ★ 判决：同一发报文在四个环境对打，答案是**客户端指纹评分**

先只比协议版本（宿主机 Node 24）：`node:http2` 真答、HTTP/1.1 软墙 —— 于是误判成"Notion 拒绝 HTTP/1.1"。
**把这个结论搬进容器就崩了**：网关跑在 `node:20-alpine` 里，同一发 h2 请求照样软墙。
于是用**同一发报文**在四个环境逐一对打（出口 IP 相同，都是 `103.62.49.162`）：

| 客户端 | node:20 容器 | node:24 容器 | 宿主机 Node 24 |
| --- | --- | --- | --- |
| **curl**（HTTP/1.1 或 `--http2`） | **★真答** | **★真答** | **★真答** |
| `node:http2` | 软墙 | **★真答** | **★真答** |
| `fetch` / undici（HTTP/1.1） | 软墙 | 软墙 | 软墙 |

⇒ 它既不是"HTTP/1.1 一律拒"，也不是"HTTP/2 一定行"，而是一道**客户端指纹评分**：
**curl 的 TLS/HTTP 指纹任何协议都过；Node 自己的 TLS 客户端看版本**——Node 24 的 h2 过，
Node 20 的 h2 与所有版本的 undici 不过。
这解释了此前所有反常：账号没问题、token 没问题、报文怎么写都没用、`isEligible:true` 却答不出来。

> ⚠️ **这张表后来被证明只描述了"两个维度里较小的那一个"**（v1.18.43，见 **§7.7**）：
> 它成立的前提是**账号当时不在墙里**。一旦账号自身在墙里，**五种传输一起软墙**，
> 上表整张作废。**"curl 任何协议都过"要读成"账号可过时，curl 是唯一实测能过的通道"。**

> **纪律（血的教训）**：在**宿主机**上测出来的传输层结论，**不能直接搬到容器**——两者 Node 版本不同
> （宿主 v24.19.0 / 镜像 `node:20-alpine`），而这道墙恰恰对 Node 版本敏感。
> 传输层结论必须在**目标运行环境里**复验（本仓库就是"测试跑在 Node 24、部署跑在 Node 20"）。

### 7.4 两版误判都要作废（留档，别重犯）

| 误判 | 曾经的处置 | 为什么错 |
| --- | --- | --- |
| 「账号 AI 权益被限、只能等恢复」（§5） | 写进文档、停手等窗口 | 被"同一账号浏览器能答"直接推翻（§6） |
| 「undici TLS 指纹被 soft-block，改用 curl 子进程」（`server.js` 旧注释） | `notionCurlRequest` 子进程优先 | **方向是对的**（确实是客户端指纹），错在把它当成"唯一结论"写死：只留 curl 一条路，且没做软墙判据/兜底，也没记下"Node 版本会让 h2 的成败翻面" |
| 「Notion 静默拒绝 HTTP/1.1，改走 h2 即可」（本轮中途的结论） | 把三处调用点全改成 h2、删掉 curl 通道 | 只在宿主机（Node 24）成立；**在容器（Node 20）里 h2 照样软墙**，等于把一条能用的通道删了 |

**教训**：`200 + 通用错误文案 + isRetryable:false` 这类"软墙"是**反爬式静默拒绝**的典型形态，
成因可能在**传输层**而不在报文里；而传输层的判决**必须跨环境复验**，单环境一次成功不足以定论。

**第四条教训（v1.18.43 追加）**：上面三次误判有一个共同的动作——**用"一次结果"去回答"一个概率问题"**。
正确的测法是**在同一个时间窗内把待比较的两个变量交错打**（C F C F …），而不是"今天打 A 过了、昨天打 B 不过"。
§7.7 的结论就是这样测出来的，它同时纠正了 §7.3 的适用范围。

### 7.5 修复（v1.18.42）：通道链，而不是"换一条通道"

| 位置 | 改动 |
| --- | --- |
| `notion.js` | 新增 `notionCurlFetch()`（curl 子进程，返回与 fetch 同构的响应壳，带 `-w` 状态码标记、超时、AbortSignal、临时正文文件清理）与 `notionH2Request()`（`node:http2`，零依赖） |
| `notion.js` | `notionFetch()` 变成**通道链**：非 https（测试假上游）→ 全局 `fetch`（旧行为逐字不变）；https → **curl 主** → 若判为软墙则 **h2 兜底** → 再不成才 `fetch`。**软墙在通道内自动换**（墙内那一发不消耗真实推理，代价只有 1~2 秒），`notionIsSoftWall()` 是唯一判据 |
| `server.js` | 三处 notion **推理**调用点全部收口到 `notion.notionFetch`：① 主推理 `tryNotionChannel` ② 流断兜底取回 `notionRefetchAnswer` ③ 管理面手动测试。删掉 `notionCurlRequest`（通道选择不该散在调用点） |
| `test/notion-transport.test.js` | 新增回归（16 项）：本地 **h2c 明文 HTTP/2** 服务器真跑 h2 路径（无需证书）、本地 HTTP/1.1 服务器真跑 curl 路径（环境无 curl 则如实跳过）、协议门、超时/取消、★ **通道链与三处调用点的装配守卫** |

**为什么主通道是 curl 而不是 h2**：curl 在**两个**部署环境（Node 20/24 容器）都实测通过，
h2 只在 Node 24 上通过；而网关镜像就是 `node:20-alpine`。
**为什么还留着 h2**：它是真能过的一条路（Node ≥24 的宿主/镜像），且在 curl 缺失（ENOENT）时是唯一活路；
比 fetch/undici 强，所以排在它前面。
⚠️ **这一格只在"账号可过"时才有意义**（§7.7 维度 A）：账号在墙里时 curl 与 h2 一起软墙，链子会一路走到底。
链子的价值是"账号可过时把最可能通过的那条排第一"，**不是**"一定能过"。

### 7.6 边界（诚实标注）

- 本修复解决的是**推理**请求。`getSpaces` / `getAIUsageEligibility` 等**非推理**端点一直是 200，未动（改动面越小越好）。
- 到底是 TLS 指纹（JA3/JA4）、h2 SETTINGS 帧序、还是别的客户端特征在打分，**本次没有进一步区分**——
  对修复无影响（**账号可过时** curl 通道在任何协议下都过），但**别把"HTTP/2"当成充分条件**（§7.3 的表格就是反例）。
- **通道链治不了账号被墙**（§7.7 维度 A）：那时五种传输一起软墙，网关会如实报
  `ok:false / notion: temporarily-unavailable`。别把"修好了通道链"误读成"notion 一定能用"。
- **镜像基础版本没动**（仍是 `node:20-alpine`）：curl 通道在 Node 20 已足够，升基础镜像是部署面改动、风险大于收益。
  若将来把镜像升到 `node:24-alpine`，h2 兜底会随之变成一条真能用的路（但主通道仍是 curl）。
- `notionls` 这个工作区的 `getAvailableModels` 今天返回 `"models":[]`，即**不能指定模型**（§7.1）。
  我们报文里仍会带 `model` 别名，实测在能过的通道上**照样真答**，故未改；但这是个**该记下的观测**。

### 7.7 ★★★ 两个维度（v1.18.43 修正）：**账号状态主导，指纹只在账号可过时才看得见**

§7.3 的表格是**真的**，但它只测了一个变量，却当成全部。修正它的触发点很偶然：把 v1.18.42 同步到云端后，
**云端网关打出了两发真答案**（`X-ZZCSAPI-Channel: notion7`，4.1 s / 16.1 s），
可几分钟后对**同一条渠道**跑四路探针，**五种传输一起软墙**——包括刚刚成功过的 curl。

于是把"一次结果"换成"同一窗口内交错打"，得到下面四条硬数据（仪器已入库为一等工具
`notion-wall-probe.js`：同一渠道、同一发报文、交替 curl / fetch，读结果里的"真答 / 软墙"）：

| 环境 | 账号 | 交错实验 | 结果 |
| --- | --- | --- | --- |
| 本地 `103.62.49.162` · `node:20` 容器 | `notionls` | curl / fetch × 3 轮 | **curl 3/3 真答，fetch 0/3 软墙** |
| 本地 `103.62.49.162` · `node:20` 容器 | `notion7` | curl / fetch × 3 轮 | **两者全墙 0/6** |
| 云端 `45.153.131.40` · `node:20` 容器 | `notion7` | curl / fetch × 4 轮 | **两者全墙 0/8** |
| 云端 `45.153.131.40` · `node:20` 容器 | `notion1/2/3/5` | 五路各一发 | **五路全墙**（h2 / curl-1.1 / curl-h2 / undici / 通道链） |

**两个独立维度**：

- **维度 A · 账号状态（主导，与传输无关，随时间变）**
  `notion7` 在**本地与云端、所有传输**下都软墙 ⇒ 墙**跟着账号走，不跟着 IP 走、也不跟着客户端走**。
  而它在云端曾有**短暂开口**（网关连拿两发真答案），几分钟后同一条渠道 curl 连打 6 发全墙（0/6）
  ⇒ 这个状态是**随时间变**的。**账号在墙里时，换任何传输都没用**。
- **维度 B · 客户端指纹（只在账号可过时才看得见）**
  本地 `notionls` 在**同一秒内交替**打 curl / fetch：curl 3/3 真答、fetch 0/3 软墙。
  同一账号、同一 IP、同一发报文，**唯一变量是客户端** ⇒ 这一维真实存在，curl 是实测唯一能过的通道。

**两个维度都会让客户端看到同一句话**（`200 + temporarily-unavailable`），这就是它难查的原因：
只看得见维度 B 时，结论是"指纹问题"；只看得见维度 A 时，结论是"账号问题"。**两次都只对一半。**

**对修复的定位（v1.18.42 的通道链仍然正确，但要说清它治哪一维）**：
通道链（curl 主 → h2 兜底 → fetch 最后）解决的是**维度 B**——账号可过时把最可能通过的客户端排在第一位，
被墙那一发只花 1~2 秒且不消耗真实推理。**它治不了维度 A。**
维度 A 在墙里时的用户可见行为已经实测（管理面手动测试钉死 `notion7`）：

```
notion7（账号在墙里） → {"ok": false, "status": 200, "latencyMs": 3606, "error": "notion: temporarily-unavailable"}
notionls（账号可过）  → {"ok": true,  "status": 200, "latencyMs": 3268, "reply": "收到"}
```

即**如实失败**，不伪装成"200 空回复"；多候选时由既有的兜底逻辑换下一家
（这条链路由 `test/notion-refetch-fallback-e2e.test.js` §6「两次都零内容 → 仍然如实判渠道失败」守着）。

**未做的实验（诚实标注，别当成已知）**：怀疑"高频用 Node 客户端敲门会把账号推入维度 A"
——历史上有 7 个账号在同一轮密集探测里一起变墙，时间上吻合。
**这条没有验证**：唯一已知可过的账号 `notionls` 正是 ③ 活体判据的来源，拿它做压力实验的代价大于收益。
在拿到新账号之前，请把"探测会把账号推入墙里"当作**待验证的怀疑**，并据此**克制地探测**（成对打、少打）。

> **一条当场发生的旁证（2026-10-06 同日，如实记下，不下因果结论）**：上面那轮云端交错探测（`notion1/2/3/5/7`
> 各 4~6 发）跑完之后不久，**云端 7 条 notion 渠道（`notion1`~`notion7`）全部失败**——
> 经云端网关发一发，`502 all channels failed`，14 条 `attempts`（每条渠道 2 次）的错误原文都是
> `notion stream: Something went wrong. Please try again later.`；而同一时刻**本地 IP 打 `notionls` 仍然正常**
> （14.6 s 拿到「收到」）。时间上吻合"探测把账号推入维度 A"，但**无法区分因果**：也可能只是云端出口 IP
> 恰好在这几分钟里被整体降级（十几分钟前 `notion7` 还能答）。**结论只有一条是硬的**：维度 A 会让**一批账号
> 同时**不可用。**据此的动作**：停止从云端做探测，等窗口；不要把"通道链修好了"当成"云端 notion 现在能用"。

**那句 `Something went wrong…` 不是第二种墙（已查实，v1.18.43）**：它和 `temporarily-unavailable` 是
**同一条报文的两个字段**。本地 notion7（在墙里，免费）抓到的原文就是一条记录：

```json
{"type":"error","message":"Something went wrong. Please try again later.",
 "traceId":"…","id":"…","isRetryable":false,"subType":"temporarily-unavailable"}
```

- `notionIsSoftWall` 判的是 `subType` → 认得出墙。
- 而网关的失败行原来优先取 `message` → **把 Notion 那句通用文案当成了原因**，`subType` 这个真正可诊断的字段
  反而没进日志。已修（v1.18.43）：`streamError` 改为**先取 `subType`**、`message` 退化为兜底，
  于是失败行现在写的是 `notion stream: temporarily-unavailable`（一眼看出"账号在墙里，等窗口或换账号"）。
  回归见 `test/notion-refetch-fallback-e2e.test.js` §8（按上面这条**真实原文**构造假上游：
  `message` 与 `subType` 故意不同，断言失败行取的是 `subType`、且**不含**那句通用文案）。
- **教训**：认墙别只按一个字符串去 `includes`——先看清那条 error 记录里**哪个字段才是原因**。

> **纪律（v1.18.43 追加）**：比较两个变量时，**在同一时间窗内交错打**（C F C F …），
> 不要"今天打 A、明天打 B"；并且先确认**账号是否可过**——账号在墙里时，任何传输对比都是无意义的。

---

## 8. ★★★ ③ 的活体判据：**已打通**（v1.18.42）

传输层修好之后，同一套判决实验（成对打：对照 + 附件）在 `notionls` 上跑通：

| 那一发 | 结果 |
| --- | --- |
| 对照（不带附件，问"我上传的 CSV 里 secret 列的值是什么"） | 真答：**「我在这段对话里没有找到你上传的 CSV 文件。…」** |
| 附件（同一问题 + 内联 CSV） | 真答：**「K7Q2M9」** —— 只存在于 CSV 里的那个串 |

再经**本地容器网关**（`http://127.0.0.1:8787/v1/chat/completions`，渠道 `notionls` 开 `notionAttachments`）复验：

| 那一发 | 结果 |
| --- | --- |
| 纯文本「只回答两个字：收到」 | HTTP 200 · 7.2 s · **「收到」** |
| 内联 CSV「我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。」 | HTTP 200 · 12.0 s · **「K7Q2M9」** |

**⇒ 「模型真的读到了文件」已由活体验证确立**（对照那一发排除了"模型在猜/在编"：它明确说没找到文件）。

复现命令（低额度，报告不回显凭据）：

```powershell
node notion-attachment-verdict.js 6 notionls     # 成对打：对照 + 附件
```

**判据只有一条**：模型能不能答出只存在于 CSV 里的随机串（`K7Q2M9`）。
**必须成对打**：软墙（200 + `temporarily-unavailable`）下发出来的"空"与"附件没生效"长得一模一样。

> 因此 `notionAttachments` 的**默认关**是"稳妥的默认"，不是"没验证过"——
> 想用就按渠道打开（控制台渠道表单 / `POST /admin/api/channels`，`apiKey` 留空即保持原密钥）。


