# prism.openai.com 反代研究报告 —— ✅ 已完全打通（纯 HTTP，无需浏览器）

日期：2026-09-17
状态：**可用**。`prism-test.js` 实测端到端返回正确答案（579 = 123+456）。

> ⚠️ 早期版本的本文档结论为「不可反代」，那是**错误**的——当时漏掉了
> sandbox 的 `resources-token` 与 Y-Sweet `/token` 两次推送。正确流程见下。

---

## 一、结论

Prism 是 **agentic IDE**（带云端 sandbox + 文件工作区），不是聊天 API，
但**可以用纯 HTTP 完整驱动**，无需浏览器、无需复现 Yjs CRDT 同步
——因为同步是 **sandbox 侧自己完成**的，客户端只要把令牌推给它。

代价：**每次会话需要 8 步握手 + 一个 sandbox**，比 codex 重得多。
适合做「低频高价值」调用，不适合做高频聊天渠道。

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

## 六、能力边界（重要）

这是 **agentic coding agent**，不是纯 chat：

- 会在 sandbox 工作区（`/code/crixet/workspace`）里**真实读写文件**
- 内置 `apply_patch` 工具，前端有「合并更改 auto-applied / 撤销 / 审查」流程
- 会话有 `codex_session_id` 与 rollout 记录
  （`/home/sandbox/.codex/sessions/.../rollout-*.jsonl`）
- 因此：**每次调用会产生真实的文件副作用**，且响应偏慢（sandbox 启动 + agent 回合）
- 实测简单问答约 3~10 秒（含 bootstrap）；复杂任务会更久

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
3. 不要与浏览器同时操作同一个项目，sandbox 会话可能互相干扰
4. 该端点是编码 agent，**用它做通用聊天会有多余的文件副作用**
