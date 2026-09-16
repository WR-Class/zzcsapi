# prism.openai.com 反代研究报告

日期：2026-09-17（会话内实测，凭据来自用户浏览器 cookie 导出）

## 结论（先给结论）

**可以做接口调用，但不能当作聊天渠道反代。** Prism 不是聊天 API，它是
**带云端 sandbox 的 agentic IDE**：每一次 LLM 请求都要求该对话已绑定一个
"就绪的 sandbox"，而 sandbox 的就绪依赖官方前端的一整套生命周期
（预置 → Y-Sweet CRDT 文档同步 → 会话绑定），无法用纯 HTTP 复现。

因此**不建议**把它接进 ZZCSAPI 做渠道；已有的 codex 链路是更好的选择。

---

## 一、已打通的部分（全部实测 HTTP 200）

采用 curl 子进程 + 本地 Clash 代理（`-x http://127.0.0.1:7897`）+ 完整 cookie
请求头。**Cloudflare 未拦截**——`__cf_bm` cookie 与代理出口 IP 匹配即可通过。
（裸 IP 直连会被 CF 403：`Sorry, you have been blocked`。）

| 接口 | 方法 | 结果 |
|---|---|---|
| `/auth/entitlements` | GET | ✅ 200 `{planType:"free", apiSubscriptionPlanTypes:["free"], validUntilMs:...}` |
| `/api/projects` | GET | ✅ 200 列出项目（含 1 个 `新建项目`） |
| `/api/user-preferences` | GET | ✅ 200 |
| `/api/projects/{uuid}/sandbox/resources-token` | POST | ✅ 200 返回 sandbox 资源令牌 + `resources_base_url` |
| `/api/backend/1/new` | POST | ✅ 200 返回 sandbox 代理 URL + token |
| `/api/llm/response_with_tools_start` | POST | ⚠️ 200 但 `sandbox_reconnecting` |

### 鉴权模型（关键）

`prism_session_token` 的 JWT 里明确写着：

```json
"policy": { "requires_openai_access_token_cookie": true,
            "account": { "auth_state": "siwc_linked" } }
```

即**两个 cookie 必须同时携带**：`prism_session_token`（Prism 会话）
+ `prism_oai_access_token`（OpenAI OAuth AT）。

- OAuth 客户端：`app_jqKb52JverFFcl5GP4axT8QY`（Prism 专属，≠ codex CLI 的 `app_EMoam…`）
- AT 有效期 10 天（iat→exp = 864000s），`scp: [openid, email, profile, offline_access]`
- 前端所有请求都是 `credentials: 'same-origin'`，**没有任何 Authorization 头**
  → 纯 cookie 鉴权

---

## 二、LLM 接口契约（从前端 JS 逆向，chunk 22.js）

```
POST /api/llm/response_with_tools_start
body: { input, previousResponseId, metadata, conversationId }
→ { status: "started"|"completed", request_id, conversation_id, turn_state, response,
    codex_live_progress, codex_listen_snapshot }

POST /api/llm/response_with_tools_status      轮询
body: { request_id, turn_state }
→ { status: "pending"|"completed", turn_state, response, ... }

POST /api/llm/response_with_tools_stop
body: { request_id, conversation_id, turn_state }
```

- 默认模型 **`gpt-5.6-sol`**（label "5.6 Sol"），推理档位 `low|medium|high|xhigh`
- 成功输出在 `response.payload.output.at(-1).content[0].text`（Responses API 形状）
- 前端轮询间隔 3~5 秒

### 实测返回

```json
{ "status": "completed",
  "request_id": "556f3d4d-...",
  "conversation_id": "cdx1_ee86d73d-...",
  "response": { "status": "error",
    "payload": { "reason": "sandbox_reconnecting",
      "message": "Reconnecting to sandbox. Your request will resume automatically once the sandbox is ready.",
      "codexRequestDebug": {
        "sandbox_url_input": null, "sandbox_url_resolved": null,
        "sandbox_token_present": false, "listen_snapshot_present": false,
        "server_proxy_origin": "https://crixet-frontend.gateway.unified-4.api.openai.com",
        "backend_auth_token_present": true, "vercel_env": "production" } } } }
```

**鉴权完全通过**（`backend_auth_token_present: true`），请求已被正确派发；
唯一卡点是 sandbox 没就绪。

尝试过的绕过手段，**全部失败**（均返回 `sandbox_reconnecting`）：
- 复用同一 conversationId 反复重试（5 次，间隔 8s）
- 先调 `POST /api/backend/1/new` 预置 sandbox 后再请求
- `metadata` 里塞 `projectId` / `projectUuid`
- 把 `conversationId` 设成项目 UUID

---

## 三、为什么 sandbox 无法就绪（根本阻塞）

前端 sandbox 生命周期（chunk 19.js）：

1. `POST /api/backend/1/new` → 拿 sandbox 代理 URL + token
2. **`sandbox.workspace_sync`** —— 要求 `hasCurrentYSweetToken` 且
   `hasSyncedYSweetProvider`，即必须完成 **Y-Sweet 的 Yjs CRDT 文档同步**
3. 同步成功后状态才从 `provisioning → syncing → ready`
4. 此后该会话的 LLM 轮次才能拿到 `sandbox_url_resolved`

sandbox 代理请求需要 `X-Crixet-Sandbox-Token`，且：

```
/s/sandboxes/proxy          sandbox 代理
x-crixet-sandbox-expired    session 过期要重新预置
x-crixet-sandbox-502-reprovision-fallback
```

**第 2 步是实时协作协议（WebSocket + CRDT），headless 复现等于重写前端。**
这是不可逾越的工程量，且官方一改协议就失效。

补充：该 LLM 端点是**编码 agent**（有 `apply_patch` 工具、
`Codex did not produce an answer`、`sandbox-wait-*` 消息），
即便打通，每次调用也是"带工具的 agent 回合"，而非干净的 chat completion。

---

## 四、技术情报（存档，将来可能有用）

- Prism = OpenAI 的 AI 原生 LaTeX 科研写作工作台（随 GPT-5.2 发布，免费档可用）
- 前端：Next.js（`/_next/static/chunks/*.js`，turbopack），默认暗色主题
- 内部代号 **crixet**（cookie `crixet_light_mode_preference_v1`、JWT `iss: crixet.prism.session`）
- 全部端点（从前端 JS 提取）：
  ```
  /api/auth/anonymous-session      匿名会话（可不登录使用）
  /api/auth/redirect
  /api/auth/claim-anonymous-projects
  /api/auth/prism-chatgpt-consent
  /api/auth/reconcile-openai-link-state
  /api/auth/unlink-identities
  /api/backend/1/new               sandbox 预置
  /api/codex/conversation-history
  /api/llm/response_with_tools_{start,status,stop}
  /api/projects                    (+ /{uuid}/sandbox/resources-token)
  /api/project-files/upload
  /api/file-management/groups
  /api/user-preferences
  /api/paper-review/runtime-prompt
  /api/spellcheck  /api/feedback  /api/maintenance  /api/metrics
  /api/zotero/{token,items,request-token}
  /api/v2/rum
  /auth/entitlements
  /s/sandboxes/proxy  /s/sandbox-resources
  ```

## 五、凭据安全提醒

- `_prism_cookies.json`（工作区）内含**活的** `prism_session_token` 与
  `prism_oai_access_token`，勿提交、勿外发；AT 10 天后自然失效
- Prism 的 `_cf_bm` 绑 IP + UA + TLS 指纹，换机器/IP 大概率需重新导出
- 不要与其它工具同时共用同一账号
