# prompt.ql.app（Hasura PromptQL）反代可行性研究（2026-10-05）

> **结论先行：不建议做，也做不成"白嫖型反代"。**
>
> prompt.ql.app **不是"某个 LLM 的网页壳"**，而是 Hasura 的 **多人协作 AI bot 工作台**（PromptQL）。
> 它没有"免费无限出话的网页会话"可蹭：免费只有 Playground 的**基础用量额度**，其余按 **OLU 计量付费**
> （Team $40/人/月起、Enterprise $1,000）；它的 API 也不是 chat-completions，而是**线程 / 程序执行 / 工件**语义
> （REST `/v1/projects/{pid}/threads/...` + 项目自己的 DDN GraphQL），鉴权是「控制台 PAT → 项目访问令牌」两步。
> 所以：要接它，正确姿势是**官方 API + PAT**（付费上游，且需要一个 DDN 项目），而**不是反代网页会话**——
> 后者的收益为零、ToS 风险为正、适配成本还不小（参考 genspark 文本仿真的工作量，但那边换来的是免费额度，
> 这边换来的只是"很有限的免费额度"）。
>
> 另有一条**本机实测**的硬障碍：控制面 `auth.pro.ql.app` 在本地**被 DNS 污染**
> （本地解析返回一串国内 IP、未带凭据的 POST 直接 `302 → https://m.baidu.com`），
> 而其余主机（`prompt.ql.app` / `chat-handler.pro.hasura.io` / `cloud.ql.app` / `data.pro.ql.app`）**都直连可达**。
> 也就是说：控制台能打开、聊天后端能到，**唯独发令牌的那一跳过不去**。

---

## 1. 身份认定：它是什么

| 项 | 事实 | 证据出处 |
| --- | --- | --- |
| 产品 | **Hasura PromptQL** 的控制台（"The world's first multiplayer bot experience"，多人协作 bot：threads / rooms / board / wiki / sheets / docs / decks） | `promptql.io` 首页 `<title>PromptQL \| Bot, meet humans.</title>` + meta description；`/en/docs` 章节为 `bots` / `rooms` / `connectors` / `models` / `plans` / `users` / `wiki` / `enterprise-deployment` |
| 前端形态 | Vite 单包 SPA（**8.3 MB 单 JS**）+ Capacitor 移动壳 + React/Mantine/Apollo/ProseMirror | `https://prompt.ql.app/assets/index-iplrF-qm.js`（HTTP 200，8,685,550 字节）；包内含 `capacitorjs.com`、`@capacitor/android` 注释 |
| 托管 | nginx（Docker），构建产物里的注释直接点名 `tools/docker/default.conf` | 首页 HTML 注释 + 405 页脚 `nginx/1.26.3` |
| 旁路组件 | GTM `GTM-PWWRVV9K`、PostHog（`us.i.posthog.com` + `analytics-posthog.hasura-app.io`）、OpenReplay、Sentry、LaunchDarkly、Stripe、**Cloudflare Turnstile**（登录防刷） | 首页内联脚本 + 包内 `turnstileSiteKey` / `https://challenges.cloudflare.com/turnstile/v0/api.js` |

## 2. 运行时主机（首页内联 `window.__env` 直接给出）

首页有一段 `window.__env = { … }`，生产主机名一目了然（这比翻包快得多）：

| 主机 | 用途 | 本机实测（2026-10-05） |
| --- | --- | --- |
| `https://prompt.ql.app` | 控制台本体 | ✅ 200（下载到完整前端包） |
| `https://chat-handler.pro.hasura.io` | **聊天/线程后端** | ✅ 存活（`/` → 404，服务在） |
| `https://chat-handler.pro.arusah.com` | 同上，**镜像域**（`arusah` = `hasura` 倒写） | ✅ 存活（`/` → 404） |
| `https://auth.pro.ql.app` | **控制面鉴权**（发项目令牌） | ❌ **被 DNS 污染**：本地解析 → `117.55.193.18 / 182.16.61.114-118 / 141.193.154.x / 180.178.40.218`（一堆国内 IP），DoH 真身是 `35.227.221.98`；未带凭据 POST → `302 Location: https://m.baidu.com` |
| `https://auth.pro.arusah.com` | 控制面镜像 | ⚠️ 403（存在，边缘拒绝） |
| `https://cloud.ql.app` | 仪表盘 | ✅ 200 |
| `https://data.pro.ql.app` | 数据面 | ✅ 302 → `console` |
| `https://api.promptql.pro.hasura.io` | env 里仍写着 | ❌ **已解析不到**（陈旧配置，见 §6） |
| `https://playground.promptql.pro.hasura.io` | Playground | （未单独探） |
| `https://promptql.ddn.hasura.app/evals` | 评测 | （未单独探） |

> 镜像域的意义：包内按**当前 hostname** 选路——
> `hostname.includes('hasura.io') || includes('.ql.app')` → 用 `*.pro.hasura.io` 并把 `hasura.io` 替换成 `ql.app`；
> `hostname.includes('arusah.com')` → 用 `*.pro.arusah.com` / `*.staging-ql.app`。
> 这是**给受限网络准备的第二套部署**，也解释了为什么控制面被污染时控制台仍然打得开。

## 3. API 形状（"反代"真正要适配的东西）

从 8.3 MB 包里现抠出的端点与链路：

- **REST（chat-handler）**：`/v1/projects/{projectId}/threads/{threadId}/…`
  —— 已确认存在 `sandbox/app-url`、`sandbox/apps/{name}`、`sandbox/app-session`、`sandbox/app-consent/{name}` 等；
  另有 `/v1/projects/all`、`/projects/{id}/…`、`/models`（项目设置里的 Models 页签）。
- **项目自己的 DDN GraphQL**：`/v1/graphql`。包里成串的查询名说明「对话」在服务端其实是**程序执行 + 工件 + 记账**：
  `PROMPTQL_EXECUTE_PROGRAM_REQUEST` / `PROMPTQL_GET_THREAD_ARTIFACT_REQUEST` /
  `olu_consumption_thread`（字段 `agent_message_id` / `execute_program_request_id` / `teaching_id` / `total_olus`）。
- **流式**：SSE（`Accept: text/event-stream`，fetch + `ReadableStream.getReader()` 解析，含 `EventSource` 兜底），
  包内另带 `graphql-ws` 订阅依赖。
- **鉴权链（两步）**：
  1. 控制台身份（OAuth 登录后的**会话 cookie**，或控制台 **PAT**：`VITE_CONSOLE_PAT`）
     → `POST {controlPlaneAuth}/ddn/promptql/token`，头 `x-hasura-project-id: <uuid>`、`credentials: 'include'`；
     另有 `/ddn/project/token` 走 `x-hasura-project-id` + `authorization`（包内常量 `ddnApiAccessToken`）。
  2. 拿到**项目访问令牌**后，调 chat-handler / GraphQL 时带 **`x-hasura-ddn-token`**
     （包内注释原话：*"As your project API access mode is set to private, an access token is generated and added to your request headers"*）。
- 失败路径有专门埋点：`reason: 'project-api-token-401'`。

> **这就是"反代"的症结**：要把它伪装成 OpenAI `/v1/chat/completions`，得自己维护
> 「线程 ↔ 会话」映射、把程序执行事件/工件翻译成 `choices[].delta`、把 OLU 换算成 token、
> 还要处理它特有的 `teaching`/artifact 语义。这不是"接一个渠道"，是写一个协议适配器。

## 4. 成本模型（决定"值不值得"）

`promptql.io/pricing` 原文要点（2026-10-05 抓取）：

| 档位 | 价格 | 原文要点 |
| --- | --- | --- |
| **Playground** | **Always free** | *"A free workspace to build multiplayer bots"*，但 **within basic usage limits**（未给数字） |
| **Team** | **$40 / 人 / 月**（$10 每周，按 $40 递增；每用户起步免费额度） | *"Every user starts free. Pay only for users who need more in $40 increments, billed weekly."*；introductory 期**按成本计费无加价**（$10 买 $10 的 token + VM 运行时） |
| **Enterprise** | **$1,000** | 含专属基础设施 |

- **计量单位 OLU**（Operational Language Unit）：把输入/输出/缓存 token 按**模型倍率**归一；
  锚点 *"Claude Opus 4.6 = 1.0×"*，倍率越低越便宜（每 $0.20 换更多 token 工作量）。
- **模型池**（定价页列出）：GPT-6 Astra / GPT-6.1 Sol / Claude Fable 5 / Claude Opus 4.6 / DeepSeek V4 Pro / Z.ai(GLM) 等；
  开源权重模型**经 Fireworks 托管**。
- **BYO 模型**：*"Connect your own OpenAI Codex subscription under bring-your-own-model and PromptQL charges $0 for usage on that connected model."*
  —— 接自己的订阅时 PromptQL **不收用量费**。**这句话反过来定性了它卖什么：卖工作台与编排，不卖模型额度。**

## 5. 结论：三条路，为什么都不该走"反代网页会话"

1. **反代网页会话（蹭 Playground 免费额度）——不推荐。**
   ① 登录是 **OAuth + Cloudflare Turnstile**，无头复用要整段会话/挑战流程；
   ② 免费档明确 "within basic usage limits"，能蹭到的额度本身很小；
   ③ 协议不匹配（§3）：适配工作量与 genspark 文本仿真同量级，但那边换来的是"可用的免费出话"，这边换来的是"受限额度"；
   ④ 计量挂在你自己的账号/额度上，**转卖等于账单欺诈**，不是灰产级别的"风险自负"。
2. **官方 API + PAT（若确实要用，这是唯一正经路径）。**
   需要一个 Hasura 账号 → 建 DDN 项目 → 开 PromptQL（PAYG 或试用额度）→ 取 PAT →
   `POST {auth}/ddn/promptql/token` 换项目令牌 → 走 chat-handler REST/SSE 或项目 GraphQL。
   **本机额外障碍**：`auth.pro.ql.app` 被污染，这一跳必须走代理，或改用 `*.arusah.com` 镜像域。
3. **不用它——对"多一个模型渠道"这个目标而言，这是最优解。**
   本仓库已有 30+ 渠道；PromptQL 池子里的模型本质也是转发（开源权重走 Fireworks、Claude/GPT 走各家），
   经它中转只会**更贵 + 多一跳 + 多一层协议损耗**。真想要那几个模型，直接接 Fireworks / Anthropic / OpenAI 更直接。

## 6. 未找到证据 / 存疑（不许当成已确认）

- **没有找到公开的 "PromptQL API" 文档页**：`/en/docs` 只有 `bots` / `rooms` / `connectors` / `models` / `plans` / `users` / `wiki` / `enterprise-deployment`，
  **没有 API / 鉴权 / PAT 章节**。所以「官方 API 可用」这一条是**从前端包反推**的，**未实测成功调用**（手里没有 PAT，也没有 DDN 项目）。
- `api.promptql.pro.hasura.io` 仍写在生产 env 里却解析不到 —— 无法判断是已下线、还是迁到别处（**不要据此认为 API 没了**：chat-handler 与 GraphQL 都在）。
- Playground 免费额度的**具体数字**（多少 OLU / 多少条消息）未验证。
- `auth.pro.ql.app` 的污染层级未定：本地 DNS 返回一串国内 IP（**倾向 DNS 污染**），但 `302 → m.baidu.com` 也可能是运营商 HTTP 劫持页；
  两者都指向"这一跳过不去"，但成因未分离。
- 未测试 Turnstile 在登录链路里的具体触发条件（是否每次登录、是否可用 API 绕过）。

## 7. 复现方法

```powershell
# 1) 身份与骨架：首页内联 window.__env 直接给出全部生产主机
curl.exe -sS -A "Mozilla/5.0" -o ql-home.html https://prompt.ql.app/
Select-String -Path ql-home.html -Pattern '__env' -Context 0,30

# 2) 前端包（8.3 MB）里抠端点/鉴权/流式
curl.exe -sS -o ql-index.js https://prompt.ql.app/assets/index-iplrF-qm.js
#    关键串：/v1/projects/、x-hasura-ddn-token、ddn/promptql/token、text/event-stream、
#            PROMPTQL_EXECUTE_PROGRAM_REQUEST、olu_consumption_thread、chat-handler.pro.

# 3) 控制面污染判定：本地解析 vs Cloudflare DoH
Resolve-DnsName auth.pro.ql.app -Type A
Invoke-RestMethod "https://1.1.1.1/dns-query?name=auth.pro.ql.app&type=A" -Headers @{accept='application/dns-json'}
curl.exe -ksS -D - -o NUL -X POST -H "content-type: application/json" -d '{}' https://auth.pro.ql.app/ddn/promptql/token
#    → 本地一串国内 IP + 302 Location: https://m.baidu.com（真身 35.227.221.98）

# 4) 成本与模型池
curl.exe -sS -A "Mozilla/5.0" -o ql-pricing.html https://promptql.io/pricing
curl.exe -sS -A "Mozilla/5.0" -o ql-docs.html    https://promptql.io/en/docs
```

## 8. 对"要不要接"的一句话建议

**不接。** 它是"多人协作 AI bot 工作台"（卖编排与协作，按 OLU 计量，$40/人/月起），
不是可蹭的模型额度；要正经用就走官方 API + PAT，而且本机还得先解决 `auth.pro.ql.app` 被污染这一跳。
如果目标只是"多几个强模型"，绕它一圈是最贵、最慢、最脆的那条路。
