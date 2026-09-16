# prism.openai.com 反代研究报告 —— ✅ 已完全打通（纯 HTTP，无需浏览器）

日期：2026-09-17
状态：**可用**。`prism-test.js` 实测端到端返回正确答案（579 = 123+456）。

> ⚠️ 早期版本的本文档结论为「不可反代」，那是**错误**的——当时漏掉了
> sandbox 的 `resources-token` 与 Y-Sweet `/token` 两次推送。正确流程见下。

---

## 一、结论

Prism = **通用大模型 `gpt-5.6-sol`** ＋ **强制套在外面的 agent harness**
（云端 sandbox ＋ `AGENTS.md` 系统提示 ＋ 文件/代码工具）。

> **先纠正一个我犯过的错**：我一开始把 `response_with_tools` 这个端点名字
> 和 `apply_patch` 这类工具的存在，理解成「这是个编码 agent，不是聊天模型」。
> **这是错的。** `gpt-5.6-sol` 是通用 LLM，实测它：
>
> | 实测提问 | 回答 |
> |---|---|
> | 写一首关于秋天的五言绝句 | 秋风摇落叶／明月照寒溪／雁去云天远／霜花满竹篱 |
> | 用一句话解释量子纠缠，给小学生听 | 量子纠缠就像两个有神奇默契的小球…… |
> | What is 123 plus 456? | 579 |
> | Write a Python one-liner that reverses a string | `s[::-1]` |
> | Write a haiku about the ocean | Moonlit waves whisper / Salt winds cradle the shoreline / Dawn swims from the deep |
>
> 用户自己在网页端用自然语言让它画出「骑自行车的鹈鹕」SVG，也是同一个模型
> 在干活——只不过走的是「写文件」这条工具路径而已。
>
> 准确的说法是：**它是个通用 LLM，只是 Prism 产品层每次都把它当 agent 跑。**

代价：每次会话需要 **8 步握手 + 一个 sandbox**，比 codex 重得多。
适合「低频高价值」调用；做高频聊天渠道不划算，但**做聊天在能力上完全成立**。

---

## 一·补、真实身份：模型 + 系统提示 + 工具

### 系统提示词 = `AGENTS.md`（已抓到全文）

每次 bootstrap，agent 会往工作区写一份 `AGENTS.md`，内容就是它的系统提示：

```
You are working inside prism app that helps researchers write and edit files using latex.

Here are some strong recommendations:
1. Limit file edits to your workspace directory
2. If you need to view the compiled pdf, render page images into /tmp/prism-pdf-previews
   (or another /tmp subdirectory) and use view_image there. Never write generated PDF
   preview images such as main-page-1.png into the project workspace unless the user
   explicitly asks to add that image to the paper.
3. DO NOT CREATE NEW PYTHON virtual environments.
4. YOU must only use paths relative to current workspace directory.
   1. do not use absolute paths that start with "/" in any latex you write.
5. If asked to proofread a section, always edit the relevant .tex file directly
   instead of only suggesting text.
6. Preinstalled Python packages include numpy, scipy, pandas, matplotlib, Pillow, pypdf,
   seaborn, plotly, kaleido, plotnine, networkx, and sympy.
7. Use these built-in packages directly for analysis, plotting, PDF parsing, and symbolic
   math. Do not install new dependencies; you do not have ability to do so.
```

**注意**：这份提示把模型定位成「LaTeX 科研写作助手」。所以它对 LaTeX 类任务
是最优的；通用问答也能答，但会被这段人设轻微带偏。

### 工作区与工具

- 工作区目录：`/code/crixet/workspace`
- 工具：文件读写、`apply_patch`、shell、Python（上面那批包已预装）、PDF 渲染
- 纯问答也会产生**一次**文件改动：`AGENTS.md`（bootstrap 产物）。
  实测连续 4 个不同类型的提问，`codexDeltaFiles` 每次都只有 `AGENTS.md`，
  **不会污染你的项目文件**。

---

## 二、完整可用链路（8 步，缺一不可）

```
① POST /api/backend/1/new
   → { url: "https://prism.openai.com/s/sandboxes/proxy", token: "gAAAAAB..." }
   每次调用创建新 sandbox；刚创建时可能 5xx，需预热重试

② POST /api/projects/{projectId}/sandbox/resources-token
   body: { sandbox_session_id: null, sandbox_token: <①的token> }
   → { access_token, expires_at, max_age_seconds, resources_base_url,
       scopes: ["project_files:read"] }
   ※ 必须带 sandbox_token，否则 sandbox 拿不到工作区文件（fileCredentialSource=none）

③ POST {①的url}/resources-token
   headers: X-Crixet-Sandbox-Token: <①的token>
   body: { token: <②的access_token>, resourceBaseUrl: <②的resources_base_url>,
           projectId: <projectId> }
   → { status: "success" }

④ POST /api/y
   body: { docId: <projectId>, requestContext: { source:"initial-bootstrap",
           previouslyConnected:false, sandboxUrl, maxAttempts:5, requestSeriesId:<uuid> } }
   → { url: "wss://prism.openai.com/y/d/{projectId}/ws",
       baseUrl, docId, token, authorization: "full" }

⑤ POST {①的url}/token
   headers: X-Crixet-Sandbox-Token: <①的token>
   body: <④的完整响应体>
   → { success: true, message: "Token received" }

⑥ GET {①的url}/wait-for-sync?wait_ms=10000
   headers: X-Crixet-Sandbox-Token: <①的token>
   → 轮询直到 { status:"synced",
               tokens:{ hasResourceToken:true, hasResourceBaseUrl:true,
                        hasResourceProjectId:true, hasCurrentYSweetToken:true,
                        hasSyncedYSweetProvider:true } }

⑦ POST /api/llm/response_with_tools_start
   body: {
     input: [{ type:"message", role:"user",
               content:[{ type:"input_text", text:"<提问>" }] }],
     previousResponseId: null,
     conversationId: null,
     metadata: {
       projectId, userId,
       model: "gpt-5.6-sol",
       reasoning_effort: "low",          // ← 注意 snake_case，不是 reasoningEffort
       frontend_origin: "https://prism.openai.com",
       sandbox_url:   <①的url>,
       sandbox_token: <①的token>          // ← 关键！不传就 sandbox_reconnecting
     }
   }
   → { status:"started", request_id, conversation_id, turn_state, codex_listen_snapshot }
     turn_state 必须原样回传，内含 sandbox_url/token/session_file_path 等

⑧ POST /api/llm/response_with_tools_status      （前端每 3~5 秒轮询）
   body: { request_id: <⑦的>, turn_state: <上一次返回的> }
   → status:"pending" | "completed"
     completed 时读 response.payload.output[].content[].text

   中断：POST /api/llm/response_with_tools_stop
   body: { request_id, conversation_id, turn_state }
```

### 实测输出

```
$ node prism-test.js "What is 123 plus 456? Reply with just the number."
…
=== 模型输出 ===
579
```

---

## 三、之前的错误结论错在哪

首轮尝试返回 `sandbox_reconnecting`，我据此判断「必须复现 Y-Sweet CRDT 同步」。
**错了**。真相：

- sandbox 同步**不需要客户端参与**，客户端只要**把两类令牌推进 sandbox**：
  1. 资源令牌（步骤 ②③）——让 sandbox 能读项目文件
  2. Y-Sweet 令牌（步骤 ④⑤）——让 sandbox 能同步 Yjs 文档
- 推完令牌后，`wait-for-sync` 会从 `syncing` 自动走到 `synced`
- 我漏掉的是**步骤 ②（带 sandbox_token 的 resources-token）和 ⑤**

而且 `metadata` 的字段名我一开始就写错了：是 **`reasoning_effort`（snake_case）**，
以及必须携带 `sandbox_url` / `sandbox_token` / `projectId` / `userId` / `frontend_origin`。
早期我只传了 `{model, reasoningEffort}`，服务器自然解不出 sandbox。

**教训**：`sandbox_reconnecting` 是「令牌没推」的信号，不是「协议太复杂」的信号。

---

## 四、鉴权与网络

- **纯 cookie 鉴权**，全程无 `Authorization` 头（前端一律 `credentials:'same-origin'`）
- 必需 cookie：`prism_session_token` + `prism_oai_access_token`（后者必要，
  session JWT 里 `policy.requires_openai_access_token_cookie = true`）
- `prism_session_token` 是 HS256 JWT，含 `policy.user.id`（= metadata 的 userId）、
  `selected_workspace.account_id`；有效期约 12 小时（iat→exp = 43200s）
- `prism_oai_access_token` 是 RS256 JWT，OAuth 客户端
  `app_jqKb52JverFFcl5GP4axT8QY`（Prism 专属），有效期 **10 天**，
  `chatgpt_plan_type` 在 payload 内
- **必须走代理**（`-x http://127.0.0.1:7897`），且 Cloudflare `__cf_bm` 要与之匹配：
  同一台机器 + 同一出口 IP + 同一 UA 即可复用；换 IP 需重新导出 cookie
- Node/undici 直连会被 CF 挡（TLS 指纹），**必须走 curl 子进程**（与 workbuddy 同理）

### 身份信息

| 字段 | 来源 |
|---|---|
| `userId` | `prism_session_token` → `policy.user.id` |
| `projectId` | `GET /api/projects` → `projects[].uuid`，或 URL 里的 `?u=` |
| `account_id` | session JWT → `policy.user.selected_workspace.account_id` |

---

## 五、模型与推理档位

- 默认 **`gpt-5.6-sol`**（UI 标签 "5.6 Sol"）
- `reasoning_effort`: `low` | `medium` | `high` | `xhigh`
- 可用模型由前端 `useAvailableCodexModels` 拉取（本次未单独探测该端点）

---

## 六、能力边界（更正版）

**它是通用 LLM**，能聊天、写诗、讲概念、写代码、做题。不是「只会编码」。

但 Prism 产品层给了它三层包装，这是**使用上的实际约束**：

| 包装 | 后果 |
|---|---|
| 每次调用都要起 sandbox（8 步握手，约 10~30s） | 延迟远高于普通 chat API |
| 系统提示是 `AGENTS.md`（LaTeX 科研写作助手人设） | 通用问答会被轻微带偏 |
| 自带文件读写/代码执行工具 | 每轮会有 `codexDeltaFiles`，纯问答只动 `AGENTS.md` |

### 关于「每次都会写文件」——已实测澄清

- 纯问答（写诗/解释概念/算术）：`codexDeltaFiles` **只有 `AGENTS.md`**（bootstrap 产物）
- 用户的 SVG 任务：额外产出了 `pelican-bicycle.svg`（那是**任务本身要的结果**）
- 所以「每次调用都乱写文件」这个担心不成立

---

## 六·补、多轮对话记忆（踩坑记录）

这是整件事里最容易踩的坑，实测结论如下：

### ❌ 行不通：只传 `conversationId` / `previousResponseId`

实测把 `conversationId` + `previousResponseId` + **完整 `input` 历史数组**
都传进去，第 2 轮依然答 "Unknown"。诊断发现：

```
第1轮: codex_session_id=01a0aa1b-...  prompt="User request:\nMy favourite colour is teal."
第2轮: codex_session_id=01a0aa1c-...  prompt="User request:\nWhat is my favourite colour?"
                                      ↑ 只取了最后一条，历史被丢弃
```

服务端**每轮新建一个 `codex_session_id`**，只从 `input` 里抽最后一条 user 文本
当 prompt，`input` 里的历史数组被忽略。

### 为什么：会话记忆走的是 Next.js Server Actions

前端创建会话用的是 **Server Action**（不是 REST）：

| Server Action | Action ID |
|---|---|
| `getOrCreateMainConversation` | `605872595140c82a9dfb3963592e62dad668ccc88f` |
| `createNewMainConversation` | `60da882267cc0bc7eb416a223823671858b83d4b0d` |
| `getMainConversation` | `60651751482deaf768058e3e3a839f27dbd68f6329` |
| `createConversation` | `00a2765fb87a5b6be6b3d949c962288d514daf73c9` |
| `createProjectConversation` | `60f6ef46a6584bd2320328016a144c15d9401a47e1` |
| `getCodexConversationLookupDebug` | `40e76711b58a40565f675f66cde985092c095a81d6` |

尝试用 `POST /` + `Next-Action: <id>` 从外部直调，**全部返回 500**
（digest 只随 body 形状变化，说明挂在 Next.js 框架层反序列化，没进到 action 内部）。
Server Action 是框架内部协议，外部复现成本高、易随版本失效，**不建议走这条路**。

### ✅ 行得通：压平历史进 prompt

把历史拼成一段文本塞进单条 user 消息，实测有效：

```
对话历史：
用户：My favourite colour is teal.
助手：Got it—your favourite colour is teal.

现在回答：What is my favourite colour? One word only.
```

→ 模型正确回答 **"Teal"**。

`prism-test.js` 已默认用这个方案（`_prism_state.json` 里存历史，自动拼接）。

### 另外：sandbox 寿命很短

- 复用一个 8 分钟内创建的 sandbox 有时仍然失败
  （`codex/healthz failed (500)` / `Project conversation lookup failed (503)`）
- 脚本已加自动降级：检测到 sandbox 失效就清缓存重新 bootstrap
- **结论**：不要把「保持长连接复用」当默认策略，按需新建更稳

---

## 七、全部端点（从前端 JS 提取，已实测标 ✅）

| 端点 | 说明 | 实测 |
|---|---|---|
| `/auth/entitlements` | 权益/计划 | ✅ 200 `planType:"free"` |
| `/api/projects` | 项目列表 | ✅ 200 |
| `/api/user-preferences` | 用户偏好 | ✅ 200 |
| `/api/backend/1/new` | 创建 sandbox | ✅ 200 |
| `/api/projects/{uuid}/sandbox/resources-token` | 资源令牌 | ✅ 200 |
| `/api/y` | Y-Sweet 文档令牌 | ✅ 200 |
| `/api/llm/response_with_tools_start` | 发起回合 | ✅ 200 started |
| `/api/llm/response_with_tools_status` | 轮询 | ✅ 200 completed |
| `/api/llm/response_with_tools_stop` | 中断 | 未测 |
| `{sandbox}/resources-token` | 推资源令牌 | ✅ 200 |
| `{sandbox}/token` | 推 Yjs 令牌 | ✅ 200 |
| `{sandbox}/wait-for-sync` | 等同步 | ✅ 200 synced |
| `{sandbox}/{synctex,entry-files,word-count,zip,logs}` | sandbox 能力 | 未测 |
| `/api/project-files/upload` | 上传文件 | 未测 |
| `/api/codex/conversation-history` | 会话历史 | 405（需 POST） |
| `/api/auth/anonymous-session` | 匿名会话（不登录可用） | 未测 |
| `/api/spellcheck` `/api/feedback` `/api/maintenance` `/api/metrics` `/api/v2/rum` | 杂项 | — |

内部代号 **crixet**；后端 `crixet-backend.oai-science.svc.cluster.local:8081`；
网关 `crixet-frontend.gateway.unified-4.api.openai.com`。

---

## 八、文件

- `prism-test.js` —— 可直接运行的完整客户端（`node prism-test.js "问题"`）
  - 支持 `--model` / `--effort` / `--project`
  - 内置 sandbox 预热重试（首次 `/token` 可能 500）
- `_prism_cookies.json` —— 凭据（**已 gitignore，含活令牌，勿外发**）

## 九、注意事项

1. `prism_session_token` 约 12 小时过期 → 过期需重新导出 cookie
2. 每次会话创建一个新 sandbox，属**有状态资源**；大量调用可能触发
   限流（前端有 "Rate limited while creating a new sandbox" 文案）
3. **sandbox 寿命短且服务偶发 5xx**：实测 `backend/1/new` 会返回
   TLS 握手失败，`resources-token`/`/token` 会返回 500，
   `start` 会返回 `Project conversation lookup failed (503)`。
   **必须带重试**（脚本已内置 4 次退避重试 + sandbox 失效自动重建）
4. 不要与浏览器同时操作同一个项目，sandbox 会话可能互相干扰
5. 系统人设是「LaTeX 科研写作助手」，通用问答会被轻微带偏
6. 多轮对话**不要指望服务端记忆**，用脚本里「压平历史」的方案

---

## 十、网关接入实况（prism 渠道）

已作为 `prism` 协议接进 ZZCSAPI，渠道 id `prism1`，模型名 `gpt-5.6-sol`。

### 配置要点（踩过的坑）

1. **必须去掉代理**。`docker exec` 实测：走 `host.docker.internal:7897` 时
   `backend/1/new` **120s 超时挂死**；不走代理 **6s 返回 200**。
   容器自身出网路径与宿主机不同，Clash 代理在这里是**拖慢**而非必需。
   （宿主机 Windows curl 才需要代理。）
2. **API Key 填整串 cookie**：`prism_session_token=…; prism_oai_access_token=…`。
3. 超时要给足：单次 `backend/1/new` 实测 4.6s / 18s / 63s 都出现过；
   整体 bootstrap 实测 20s ~ 150s 不等。

### 实测耗时分解（一次冷启动）

| 步骤 | 耗时 |
|---|---|
| ①② 建 sandbox | 1~20s |
| ③ 推资源令牌 | 2~17s |
| ④ 取+推 Y-Sweet 令牌 | 5~97s |
| ⑤ 等同步 | 4~39s |
| ⑥ 发起回合 | 1~126s |
| agent 回合本身 | 5~100s+ |

**冷启动首轮 30s ~ 230s**（上游波动极大）；
**复用 sandbox 时 start 仅 ~1s**，总耗时降到 ~23s。

### 已验证

```
POST /v1/chat/completions  {model:"gpt-5.6-sol", messages:[…]}
→ 200，23s，"秋风摇落叶／寒月照空林／雁去云天远／霜花满客襟"
```

### 已做的容错

- 每步 2~5 次退避重试（该上游 5xx 很常见）
- sandbox 会话缓存 25 分钟；失败时自动清缓存重建
- start 失败若判定为 sandbox 相关 → 自动重建后重试一轮

### 已知限制

- **慢**：首轮 30s 起，上游忙时可达数分钟
- **抖**：会连续遇到 500/503/超时；网关可能短暂把渠道打进冷却
- cookie **约 12 小时过期**，过期后需重新导出并更新渠道配置