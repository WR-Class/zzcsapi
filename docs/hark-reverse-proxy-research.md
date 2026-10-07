# hark.com 网页会话反代研究（v1.18.47 已接入）

> 结论先说：**可行，已作为专用报文渠道接入**（`protocol: "hark"`）。但它有三条硬限制，决定了它
> **只能当"能调客户端工具的纯文本兜底渠道"**，不是 OpenAI 兼容面的替代品：
> ① 上游**没有** OpenAI 兼容面；② 回复**整段一次**下发（伪流式）；③ 工具**全在服务端执行**，
> 客户端工具只能走文本仿真；④ 免费日额度**约 69 轮**。
> 本文记录逐条证据与复现命令，供后来者复核而不是重新踩一遍。

---

## 1. 上游栈与鉴权

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 官网 | Next.js + Turbopack（Vercel） | 首页 HTML 里的 `_next/static/chunks/*` |
| 应用 | Vite SPA，静态资源在 **assets.hark.com** | `/chat` 返回的壳里 11 个 chunk 引用 |
| 产品后端 | **Go** | `GET /api/version` → `{"service":"go-api","version":"release-2026.10.07.1"}` |
| 鉴权 | **Better Auth**，单枚 cookie | `__Secure-hark.session_token`（值 URL-encoded，含 `%2F`/`%3D`，长度 81） |
| 客户端怎么带凭据 | `fetch(..., {credentials:'include'})`，**不发 Authorization 头** | 应用 chunk 里的请求封装 |

复现：

```bash
curl -s https://hark.com/api/version
curl -s -H "Cookie: __Secure-hark.session_token=<值>" https://hark.com/api/auth/get-session
```

**cookie 用编码原样即可**（不需要 urldecode）——实测两种都通，但原样最省事。

## 2. 出网：本机必须走代理，而这不是 IP 声誉问题

现场现象很误导人：**同一台机器**上

| 客户端 | 结果 |
| --- | --- |
| Node `fetch` / `curl`（不读系统代理） | **403**（Cloudflare） |
| PowerShell `Invoke-WebRequest`（读 WinINET 系统代理） | **200** |
| 云端机器（无代理直连） | **200** |

第一反应是"本机 IP 被 CF 拉黑、云端 IP 干净"。**错的**。真相是：

```
HKCU\...\Internet Settings → ProxyEnable=1, ProxyServer=127.0.0.1:7897   （本机 Clash 类系统代理）
```

PowerShell 读系统代理 → 走代理出去 → 200；Node/curl **不读系统代理** → 直连 → 403。
给 curl 加上 `-x http://127.0.0.1:7897` 立刻 200。

⇒ 渠道的 `proxy` 字段就是这件事的开关：**本机填 `http://127.0.0.1:7897`（或容器内
`http://host.docker.internal:7897`），云端留空**。失败形态也要认准：没配代理时是 **403 或一段 HTML**，
不是"凭据失效"（那是 401）。`hark-probe.js` 会把这两层分开报。

## 3. 为什么不能给 openai 渠道填 base_url

```
POST https://hark.com/v1/chat/completions     （有效 cookie + 标准 OpenAI 报文）
→ 200  Content-Type: text/html                （Vite SPA 的壳，不是 JSON）
```

`/v1/*` 只是前端路由兜底。真正的会话协议是网页客户端那套 REST + SSE：

| 动作 | 报文 |
| --- | --- |
| 建会话 | `POST /api/conversations` body `{"title":"…","autoTitle":false}` → `{conversationId, success}` |
| 取主会话 | `GET /api/conversations/main` → `{conversationId}` |
| 发消息 | `POST /api/messages/send?cid=<id>` body `{conversationId, message:"<纯字符串>", idempotencyKey?, responseMessageId?}` → `{agentId, conversationId, messageId, redirected, success}` |
| 收回复 | `GET /api/sync/conversation?conversationId=<id>&v=2&manager=<任意值>&mode=in_tab` → **SSE** |
| 删会话 | `DELETE /api/conversations/<id>` → `{success}` |
| 额度 | `GET /api/billing/summary` → `meters.harkTokens{dailyUsed,dailyLimit,poolUsed,poolLimit,…}` |

两条实测细节：

- **`POST /api/conversations` 传 `{}` 返回的是用户的「主会话」**（不是新建）。传 `title` + `autoTitle:false`
  才真的新建；`{"title":…}` 缺 `autoTitle` 会被拒（`autoTitle is required for projects`）。
  ⇒ 网关**绝不能用主会话**（那是用户自己的助手线程），每轮新建、成功即删。
- `manager` 参数**不校验**（任意值都通）；SSE 每 ~15 秒一个 `ping` 注释帧。

## 4. 回复是「整段」的，不是逐 token

实测一帧序（真机，两轮）：

```
+571ms  snapshot（42~45 条消息）
+646ms  entry_add  助手消息 {isStreaming:true, jobStatus:'running', content:''}   ← 占位气泡
+1738ms narration_update  {narration:{line:"Checking the time", lineKey:"narration.time.current_time"}}
+5323ms entry_add / message_update  助手消息 content=45 字（**整段**）+ {isStreaming:false}
```

⇒ 没有 token 级增量。渠道的"流式"只能是**伪流式**（首帧 role、次帧整段正文、末帧 finish + `[DONE]`），
与 genspark / workbuddy 同款收口。**不要**为了好看去伪造逐字增量——客户端一旦依赖它就再也接不住真流。

另一条实测纪律（踩过）：**新会话的 snapshot 里本来就有一条 assistant（问候语）**。
收流逻辑若图省事"取最后一条助手消息"，问候语会被当成回复返回给客户端。
判据必须是：`triggeredByMessageId` 精确命中，**或**连上流之后新出现的 id（快照里已有的 id 一律不算）。

## 5. 工具：服务端可用、客户端不可用 → 走文本仿真

**上游工具全在服务端执行**。证据：

- 整个 SSE 流里 **`tool_add`/`tool_update` 事件为 0**（两轮实测汇总为空）；
- 没有 OpenAI 式的 `tool_calls` 帧，也没有可回调客户端执行的通道；
- 但它**真的联网**：让它"读 hark.com 首页标题"，它答
  `A new kind of system for getting things done. Whatever you need, let Hark handle it.` ——
  与本机抓下来的首页 HTML **逐字一致**（`app-module__RWs2aW__introduction` 那段，含 `<br/>` 断点位置），
  排除幻觉。
- 客户端能参与的只有 Hark 自己的输入请求（`asks` / `jobStatus:'waiting_for_input'` /
  `POST /api/messages/tool-response`，要 `{conversationId, requestId}`）——那是它的原生回调协议，
  不是 OpenAI 的 function calling。

⇒ **客户端工具走 `tool-emu.js` 文本仿真**（与 notion / genspark 同套路），并已实测通过：

```
注入：tools 协议写进拍平后的消息（+ 尾部提醒）
上游回复：[TOOL_CALL]
          {"name": "read_local_file", "arguments": {"path": "D:\\…\\README.md"}}
          [/TOOL_CALL]
解析：parseEmulatedToolCalls → 标准 OpenAI tool_calls（finish_reason: "tool_calls"）
```

复现率实测 **3/3**（读本机文件、查天气这类与文件无关的工具、更强措辞各一发，全部回标记）。

⚠ **一个上游护栏，别误判成渠道故障**：把目标写成 `C:\Windows\win.ini` 这类**系统路径**时，
上游回一句固定话术 `I wasn't able to answer this message.`（2/2 复现），**不出标记**；
换成普通路径（`D:\…\hark.js`）立刻恢复（1/1）。这是它自己的护栏，网关只会把这句当普通正文如实回传。
`hark-probe.js` 的工具探测因此**刻意用普通文件路径**，否则会把护栏误报成"工具不可用"。

## 6. 额度：每轮约 11.5 万 harkTokens

```
GET /api/billing/summary → meters.harkTokens
  {dailyLimit: 8000000, dailyUsed: …, poolLimit: 40000000, poolUsed: …,
   dailyResetsAt: "2026-10-08T17:34:29Z", poolResetsAt: "2026-11-01T00:00:00Z"}
```

同一账号连续两次读取的差值（一轮"只回两个字：收到"的极短对话）：

```
1902579 → 2017694   消耗 115115
```

⇒ **免费日额度 8,000,000 约合 69 轮**，而且消耗与提示长短几乎无关（大头是上游自己 agent 的系统
开销与工具链）。所以本渠道在候选链里**放链尾**，只当"别的家都挂了"的兜底；`hark-probe.js` 每次都会
打印当前日用量百分比。

> 记账口径：上游**不给** token 计量（只有账号级 harkTokens），所以网关按估算记 `in/out`，
> 不假装有上游真值（与 genspark/workbuddy 同口径）。

## 7. 本渠道的已知边界（照实写，别让下一个人重新发现）

1. **没有原生 function calling**：客户端工具靠文本仿真，模型偶尔不遵守协议（那时网关照旧返回纯文本，
   不会因为"有 tools"就把回复吃掉）。
2. **系统路径护栏**（见 §5）：某些提示会让上游回固定失败话术，网关如实回传。
3. **伪流式**：正文整段到达。
4. **单 agent**：上游只有一个 agent，模型名不透传（渠道的 `models` 别名只是路由与展示用）。
5. **额度有限**：约 69 轮/日（§6），放链尾。
6. **每轮一条上游会话**：成功即删；失败**不删**（留证给用户去 hark 里查那一轮）。
   失败时用户会在自己的 hark 账号里看到一条标题为「ZZCSAPI 网关通道」的会话——这是**刻意**的。
7. **多模态不支持**：图片不能转给上游（渠道不在 `IMAGE_CAPABLE_PROTOCOLS` 里，含图请求会被候选裁剪挡掉）。

## 8. 复现与验收

```powershell
# 只读体检（不消耗额度）：凭据 / 会话 / 额度三层
node hark-probe.js <渠道id>
# 加真对话与工具仿真（消耗额度）
node hark-probe.js <渠道id> --turn
# 离线回归（真网关 + 真 curl + 假上游兼 HTTP 代理，零外网零额度）
node test/hark-channel.test.js
```

真链路端到端（本机 + 系统代理，2026-10-08 实测）：

```
① 纯文本  200 · 3712ms · "渠道正常" · usage 记账 ✓
② 工具轮  200 · 6100ms · finish_reason=tool_calls · read_local_file{"path":"D:\\…\\AGENTS.md"} ✓
③ 结果回传 200 · 4537ms · "第一行是：# AGENTS.md · 项目协作约定" ✓
④ 流式    200 · 3449ms · 4 帧（role → 正文 → finish）→ [DONE] ✓
```
