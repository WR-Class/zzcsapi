# Codebuff/Freebuff 反代可行性研究

> **结论（v1.18.58）：已接入为 `protocol:"codebuff"`**——两步 run 协议（agent-runs 拿 runId → chat/completions 顶层带 `codebuff_metadata.run_id`），curl+代理传输，与 hark/codex/genspark 同款 "无 /v1/models 端点 + 别名表不许空" 硬约束。
>
> **已知限制**：账号无 API credits 时 chat/completions 直返 **402 Out of credits**——Freebuff 客户端里 "15h/天 freebucks" 是 app 内部免费额度，**裸调 API 不会自动用**；去 `https://www.codebuff.com/usage` 充 API credits 才能用。
>
> 探针：`node codebuff-probe.js [渠道id] [--no-chat] [--chat-only] [--proxy <url>]`（按层打：凭据 → chat 协议 → 模型建议）。
> 复现本文的所有 cURL 都对真实上游打——已确认过两次形态（先 200 真答，后 402）。

---

## 1. 渠道判据与背景

### 1.1 为什么会有这条渠道

Freebuff / Codebuff（`codebuff.com`）是一个**桌面端 AI 编程客户端**。用户安装后，本机起一个 Electron 应用做"AI 编程 IDE"。

**网上能搜到的"codebuff 反代"路子都是给这个客户端当后端**——即"别人也用同一个后端、用别人的号、用别人的 credits"。

但用户给的真实需求更简单：**codebuff 服务端有 OpenAI 兼容接口（`/v1/chat/completions`），只是接口要走一个"先建 run 再发 chat"的两步协议**。如果把这两步包成一个 channel 接到本项目的 gateway 上，**那 Freebuff 客户端就是这套反代的天然客户端**。

### 1.2 抓法（怎么拿到真实报文）

**最佳路径**：装一份 Freebuff 桌面客户端、登录、随便发一条聊天、看它往哪打。
**次优**：从安装包里解出 asar（`@codebuff/sdk` 走 `npx asar extract` 拆开），看它调的 HTTP endpoint 与报文字段。

实操：v1.18.58 那一版从 `C:\Users\RongWu\AppData\Local\Temp\freebuff-asar-175054\node_modules\@codebuff\sdk\src\impl\llm.ts` 抠到 `getProviderOptions`（决定 `codebuff_metadata` 长什么样）与 `providerOrder`（决定 model 名）。

---

## 2. 协议形态（两步 run）

### 2.1 第一步：`POST /agent-runs`

```http
POST /api/v1/agent-runs
Authorization: Bearer <36-char UUID session token>
Content-Type: application/json

{
  "action": "START",
  "agentId": "base",
  "ancestorRunIds": []
}
```

响应：

```json
{ "runId": "run-<timestamp base36>" }
```

**关键事实**：
- `agentId` 在 SDK 里是 `publisher/name@version` 形式（如 `codebuff/base@latest`、`codebuff/base2@latest`）
- SDK 在 `llm.ts:286-292` 内部把 `@version` 后缀剥掉、再取最后一段 `/`-segment 当匹配 key
- **实测**：`base` 这种简写也 200（被服务端兼容）——v1.18.58 默认用 `base`
- `ancestorRunIds` 是多 agent 协作时的父 run 链，单 agent 场景永远 `[]`

### 2.2 第二步：`POST /chat/completions`

```http
POST /api/v1/chat/completions
Authorization: Bearer <token>
Content-Type: application/json

{
  "model": "codebuff/base@latest",
  "messages": [{"role":"user","content":"ping"}],
  "max_tokens": 8,
  "stream": false,
  "codebuff_metadata": {
    "run_id": "<runId from step 1>",
    "client_id": "<UUID>"
  }
}
```

**关键事实**（从 SDK 源码 `llm.ts:81-140`）：
- `codebuff_metadata` 是**顶层**字段，不是嵌套在 `messages` 里的——llm.ts:124 注释："All values here get appended to the request body"
- `client_id` 是一次会话的 `clientSessionId`（SDK 每次重启生成一个，**本项目按"每请求一 UUID"分配**——v1.18.58 不缓存）
- 缺 `codebuff_metadata` 或缺 `run_id` → **400 No runId found in request body**（实测）
- 上游接 `stream:true`（流式 SSE）与 `stream:false`（一次性 JSON）两种

### 2.3 `codebuff_metadata` 字段表

来自 `@codebuff/sdk` 源码 `llm.ts:119-139` 的 `getProviderOptions()` 真实返回值（e2e 抓的形态）：

| 字段 | 必填 | 来源 / 含义 |
| --- | --- | --- |
| `run_id` | ✓ | 来自第一步 `/agent-runs` 的响应；缺它就是 **400** |
| `client_id` | ✓ | SDK 的 `clientSessionId`（每次重启一个 UUID；本项目按"每请求一 UUID"分配） |
| `cost_mode` | 可选 | SDK 里 `localCostMode` 的值（缺省 `normal`）——本项目未透传，未发现影响 |
| `cache_debug_correlation` | 可选 | 调试用 `userMessageId` + `agentName` 对——本项目未透传 |
| `provider` | 可选 | `{order:['Google','Anthropic','Amazon Bedrock'], allow_fallbacks:bool}` 路由——SDK 走 `providerOrder` 唯一键 `models.openrouter_claude_sonnet_4_5` 的值；本项目未透传，由 codebuff 服务端按 model 决定路由 |

### 2.4 鉴权

`Authorization: Bearer <apiKey>`。`apiKey` 的真实来源是 Freebuff 客户端本地 `state.json` 的 `authSessions["https://www.codebuff.com"].token`——**36 位 UUID 形式**（不是 JWT），示例：`a397e09b-aa51-4b74-8be7-1956958b187c`。

**不要复制** CodeBuddy 那种 envelope（`$wbEncrypted / ciphertext`）——codebuff 这条永远是明文 UUID。

### 2.5 出网（直连 / 代理）

- 本机直连：本项目 `wbCurlRequest` 走 `curl.exe`（与 workbuddy/codex/genspark 同套）。中国大陆出网可能受 CF / 地区限速影响。
- 走代理：渠道 `proxy` 字段填 `http://127.0.0.1:7897`（宿主代理）或容器内 `http://host.docker.internal:7897`——curl 子进程**不读系统代理**，必须显式 `-x`。
- 容器：与 hark 一样，`def.proxy` 一项里写容器能访问到的代理地址（v1.18.47 现场：`host.docker.internal:7897` 在宿主机上常常不可达，会得 `HTTP 0` 易被误读成"CF 拦截"）。

---

## 3. 实测的真答形态（v1.18.58 那一轮探针拿的）

| 步骤 | HTTP 状态 | 关键证据 | 解读 |
| --- | --- | --- | --- |
| 1. agent-runs | **200** | `{"runId":"run-..."}` | 协议层通了 |
| 2. chat/completions | **200** | SSE 三帧（role → delta.content → finish="stop"）+ `usage` 帧 | 协议 + 额度都通 |
| 2. chat/completions | **402** | `{"message":"Out of credits"}` | 账号没 API 额度（**不是凭据错**、**不是模型名错**） |
| 2. chat/completions | **401** | `{"error":"..."}` | token 失效 / 过期 |
| 2. chat/completions | **400** | `{"message":"No runId found in request body"}` | 报文中缺 `codebuff_metadata.run_id`（一般是自己出站时漏写） |
| 2. chat/completions | **400** | `{"message":"..."}`（其它） | model 名 / 报文形状错（看错误文案定位） |

**402 与 401 必须区分**（v1.18.58 专门给两种 401/402/403 都打 `credential` 分类——不要走 rate_limit 冷却曲线）：
- **401/403 = credential**（凭据问题：换 token / 重登）
- **402 = credential**（额度问题：去 codebuff.com/usage 充 API credits——**Freebuff 客户端里的 15h/天 freebucks 是另一条路径，裸调 API 不会自动用**）

---

## 4. SDK 源码级证据（`@codebuff/sdk`）

> 这一段**与运行无关**，只是给"协议为什么长这样"留个锚点。改协议前看这里。

### 4.1 `llm.ts:67-73` —— `providerOrder`

```ts
const providerOrder = {
  models_openrouter_claude_sonnet_4_5: ['Google', 'Anthropic', 'Amazon Bedrock'],
};
```

**含义**：`codebuff_metadata.provider.order` 用这个值，告诉 codebuff 上游"按这个顺序试 Google → Anthropic → Amazon Bedrock"。

**实测未透传**：本项目 v1.18.58 不透传 `provider` 字段，codebuff 服务端按 `model` 字段决定路由——如果服务端在某天**要求**透传 `provider`，需要把 `codebuff_metadata.provider = {order: [...], allow_fallbacks: true}` 加上。

### 4.2 `llm.ts:81-140` —— `getProviderOptions`

```ts
function getProviderOptions(clientSessionId, ...) {
  return {
    run_id,
    client_id: clientSessionId,
    cost_mode: localCostMode,
    cache_debug_correlation: { userMessageId, agentName },
    provider: { order: providerOrder[...], allow_fallbacks: isExplicitlyDefinedModel(model) },
  };
}
```

**`isExplicitlyDefinedModel(model)` 的真值**（决定 `allow_fallbacks`）：
- 是的，本项目 `model` 字段填 `codebuff/base@latest` 这种"已注册的" → `allow_fallbacks: false`（精确路由）
- 填用户自己写的不在表里的字符串 → `allow_fallbacks: true`（按 `order` 试）

### 4.3 `database.ts:409-474` —— `runAgent`

`runAgent` 是 SDK 里调用 `agent-runs` 的地方。**字段名一一对齐**：
```ts
body: JSON.stringify({ action: 'START', agentId, ancestorRunIds: [] })
```

**没有** `cost_mode` / `cache_debug_correlation` ——这些是 chat 那一步的 metadata，与第一步的 run 无关。

### 4.4 `constants.ts:1-24` —— `getWebsiteUrl`

```ts
function getWebsiteUrl() {
  return (process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || 'https://www.codebuff.com').replace(/\/$/, '');
}
```

**含义**：base URL 来自环境变量，去尾斜杠。本项目硬编 `https://www.codebuff.com/api/v1`——若想跟 SDK 完全一致应改成 `${getWebsiteUrl()}/api/v1`，但那要客户端传环境变量过来，v1.18.58 不做。

---

## 5. 本项目 v1.18.58 的实现

### 5.1 三件硬约束（与 hark/codex/genspark 同款）

按 AGENTS.md §1.1，**上游无 /v1/models 端点的协议**必须满足：

1. **探测分支必须在别名表为空时给默认别名建议 + `account.note` 说明**
   - 现状：`codebuffChatProbe` 跑通后返回 `models: [CODEBUFF_DEFAULT_MODEL]`，`account.note: "codebuff 无 /v1/models 端点..."`（`server.js` L1625-1635）

2. **`validateChannelDef` 必须把零别名拦在保存前 + 给出可照抄的例子**
   - 现状：`def.protocol === 'codebuff'` 且 `aliases.length === 0` → 400 + 例 `{"codebuff-base":"codebuff/base@latest"}`（`server.js` L4141-4150）

3. **跑 `test/channel-default-alias-e2e.test.js`**
   - 现状：✅ 通过（30 项断言，含 5 个无目录协议的"取配置别名"下一行都有默认建议的相邻守卫）

### 5.2 7+ 登记点（与 v1.18.5x 接入 workbuddy/codex/genspark/hark 同款清单）

| # | 文件:行 | 改动 |
| --- | --- | --- |
| 1 | `server.js:1371` | `aliasedProto` 数组加 `'codebuff'` |
| 2 | `server.js:1419` | 健康探针分支加 `codebuff` 走 `codebuffChatProbe` |
| 3 | `server.js:1605-1638` | `probeUpstream` 加 `codebuff` 分支（默认 `models: [CODEBUFF_DEFAULT_MODEL]` + account.note） |
| 4 | `server.js:4094-4109` | `validateChannelDef` 白名单 + 零别名 400 拒绝（带可照抄例子） |
| 5 | `server.js:4672-4715` | 渠道 POST 协议白名单 + 候选链兜底（hark 之后） |
| 6 | `server.js:4837-4905` | `/admin/api/test` 加 codebuff 真两步调用（2-step + 流式 4 形态 + 凭据失败回原文） |
| 7 | `server.js:5987-6095` | `tryChannel` dispatch 加 codebuff → `tryCodebuffChannel` |
| 8 | `server.js:5293-5300` | `openAICandidateChain` 候选链兜底加 codebuff（hark 之后） |
| 9 | `server.js:7021-7205` | **`tryCodebuffChannel` + `codebuffChatProbe` 函数体**（curl 子进程 + 4 hook 收口 + SSE/非流 JSON 分支） |
| 10 | `server.js:1446-1462` | 探针错误前缀按协议分支（workbuddy/genspark/codebuff 各自的字符串字面量） |
| 11 | `build/app.js:240, 2031-2034` | `protoLabel` + `PROTO_META` + `PROTO_ORDER` 加 codebuff |
| 12 | `console-redesign.html:939, 1781, 1790, 232-233` | 同上 + chip CSS 类 |
| 13 | `node build/build.js` | 重建 `console.html` |
| 14 | `README.md` | 协议表 + 特性 + 文档索引 + 测试数 54→55 / 2581→2627 |
| 15 | `docs/protocols.md` | codebuff 详解（待补） |
| 16 | `docs/codebuff-reverse-proxy-research.md` | **本文档** |
| 17 | `docs/tests.md` | codebuff-e2e 登记 |
| 18 | `docs/frontend-code-map.md` | L240 / L2031 / L1781 / L939 行号锚点 |
| 19 | `docs/frontend-console-detailed.md` | §8 变更日志 |
| 20 | `codebuff-probe.js` | 根目录活体探针（按层打） |
| 21 | `test/codebuff-e2e.test.js` | 假上游 + 临时网关真链路回归（34 项断言） |

### 5.3 失败形态的可读性

- 凭据失败：`401/403 → 401 HTTP 状态透传，文案里"凭据失效"或去 Freebuff 重登`
- 额度失败：`402 → 直传 402 HTTP 状态，文案里"Out of credits"——本项目 `tryCodebuffChannel` 给 402 也走 `credential` 分类（不走 rate_limit 冷却曲线）`
- 报文形状错：`400 → 透传 HTTP 状态 + 上游错误文案`
- 网络失败：`curl exit N → "codebuff: <curl stderr 前 200 字符>"`

### 5.4 已知限制（写进 README 的"已知限制"那条）

- **每请求一个 runId**（不缓存）—— 第一次设计就这样写，多轮对话场景每发一条 chat 都开新 run；服务端按 run 计费 → 同一个会话每多一轮都开新账单，**目前没找到省钱的路**
- **暂不支持多轮 run 缓存**——客户端需要把历史 messages 整条带进 body（OpenAI 风格），gateway 不在 run 层做续接
- **暂不处理 codebuff_metadata.provider 字段**——SDK 透传它用来强制路由；本项目用 model 字段决定路由，**若服务端哪天强制要求 provider 字段，需小改 `tryCodebuffChannel`**

### 5.5 v1.18.59 修订：探测失败也照样给默认别名

**症状**（v1.18.58 上线后立刻冒出来的现场）：账号无 API credits 是**合法常见**状态——加 channel → 立即点「获取模型」→ 上游回 402 → `ok:false` → 控制台「获取模型」整条是死路：拿不到建议 → 加不了别名 → 充了值渠道也永远不会被命中。这正是 AGENTS §1.1 那条硬约束要防的形态（v1.18.49 hark 接入时定的："**上游没有模型目录的协议**，探测必须给默认建议 + 拦空别名"）。

**根因**：v1.18.58 的 codebuff 探测分支要求 `codebuffChatProbe` 必须 `r.ok` 才往下走返回建议——这意味着**探测失败时建议就丢了**。但 codebuff 的"无目录"是**静态事实**（上游根本没这个端点），与这次探测成不成无关。

**处置**（v1.18.59，commit 见 §5.6）：
1. 服务端 `probeUpstream` 的 codebuff 分支改写为：先无条件算出默认建议 + `cbNote`，再用 `tryCodebuffChannel` 风格的判据：失败时返回 `ok:false` **但仍带上 models 与 account.note**。
2. 前端 `build/app.js` L2176 `probeUpstream` 的 `!r.ok` 分支就地**单行**改：仍然渲染建议列表（仅当 `r.models` 非空），status 行同时显示错误与 `account.note`。
3. 测试 `test/codebuff-e2e.test.js` 加 §4（5 项断言）：探测失败响应里 models 含默认建议、account.note 说明无目录 + 探测失败、ok 仍是 false；对照探测成功时也照样给建议。

**为什么单行改前端**（gene 策略明示："**确需动前端：就地改单行保持行数不变**"）：保持 `console.html` 的 JS 偏移与 `docs/frontend-code-map.md` 的行号锚点不动，避免连带重算。

### 5.6 v1.18.59 提交锚点

- 服务端：`server.js` 的 codebuff 探测分支（`probeUpstream` 中 `if ((def.protocol || 'openai') === 'codebuff')` 那块）
- 前端：`build/app.js` L2176（`probeUpstream` 的 `!r.ok` 分支，单行展开）
- 重建产物：`node build/build.js` → `console.html`（JS 偏移 +709 不变）
- 守卫：`test/codebuff-e2e.test.js` §4（5 项）+ `test/channel-default-alias-e2e.test.js` 的"5 无目录协议相邻守卫"

---

## 6. 复现命令

```bash
# 1) 拿 token：装 Freebuff 客户端 → 登录 → 找 state.json
#    Windows:  %APPDATA%\freebuff-desktop\state.json
#    字段:  authSessions["https://www.codebuff.com"].token
#
# 2) 探测（直连）
node codebuff-probe.js
#
# 3) 探测（走代理）
node codebuff-probe.js --proxy http://127.0.0.1:7897
#
# 4) 手动跑两步 cURL
RUN=$(curl -sS -X POST https://www.codebuff.com/api/v1/agent-runs \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"action":"START","agentId":"base","ancestorRunIds":[]}' | jq -r .runId)

curl -sS -N -X POST https://www.codebuff.com/api/v1/chat/completions \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d "$(jq -n --arg run "$RUN" '{
    model:"codebuff/base@latest",
    messages:[{role:"user",content:"ping"}],
    max_tokens:8, stream:false,
    codebuff_metadata:{run_id:$run, client_id:"zz-probe-test"}
  }')"
#
# 5) 在本项目里加渠道（控制台 "添加渠道" → 协议选 codebuff）
#    填：baseUrl=https://www.codebuff.com/api/v1
#        apiKey=<上面那个 36 字符 UUID>
#    自动获得默认别名: { "codebuff-base": "codebuff/base@latest" }
```

---

## 7. 与其他专用报文渠道对比

| 维度 | workbuddy | codex | genspark | hark | **codebuff** |
| --- | --- | --- | --- | --- | --- |
| 上游类型 | 逆向 | 官方订阅反代 | 网页会话 | 网页会话 | **逆向（同 codebuff 客户端）** |
| 模型目录 | 无 | 无 | 无 | 无 | **无** |
| 协议 | OpenAI 兼容 + stream | Responses API | 自定义 REST/SSE | 自定义 REST/SSE | **两步 run（agent-runs + chat）** |
| 鉴权 | JWT | AT (RT 轮转) | session_id cookie | session cookie | **Bearer 36-char UUID** |
| 工具 | 客户端原样 | 客户端原样 | 文本仿真 | 文本仿真 | **客户端原样（按 model）** |
| 流式 | 必 stream（伪流式） | 原生流式 | 原生流式 | 伪流式 | **原生（看 stream 字段）** |
| 已知失败 | token 加密成 envelope | AT 失效 | CF 403 需代理 | 403 需代理 | **402 额度 / 400 报文形状** |
| 配额 | 不详 | 订阅 quota | 免费号 1 credit/次、100/天 | 免费约 69 轮/天 | **API credits 单独（与客户端 freebucks 分开）** |

---

## 8. 未找到的证据（避免"凭印象下结论"）

- ❌ **没找到** codebuff 服务端的官方 API 文档（公开站只有 marketing page + 客户端下载）
- ❌ **没找到** `codebuff/common/old-constants` 的 `models` 对象字面量（`@codebuff/sdk` 的 asar 拆出来了，但 `@codebuff/common` 拆不出来——所以 `models.openrouter_claude_sonnet_4_5` 是从 `providerOrder` 的 key 倒推的）
- ❌ **没找到** `model` 字段合法值列表（只知"形如 `provider/model` 或 `codebuff/<agent>@<version>`"——SDK 里填的也是 OpenRouter 风格字符串）
- ❌ **没找到** `client_id` 续接机制（v1.18.58 默认每请求一 UUID，未发现服务端真用了它做会话续接）
- ❌ **没找到** 多 agent 协作场景下 `ancestorRunIds` 的具体语义（v1.18.58 单 agent 场景永远 `[]`）

**这些"未找到"是留档**：下次有需要时再补实验——不要凭"可能是这样"去改协议。
