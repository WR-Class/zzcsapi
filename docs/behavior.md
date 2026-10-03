# 行为细节

> 本文从 README 拆出（v1.18.8）：README 只留一份摘要清单，本文收全量——上游 4xx 兜底判据、流式失败、
> 协议转换的有损点、thinking 边界与回放、工具调用映射、密钥轮换、管理面会话、鉴权写法，
> 以及 v1.16 出站与流式写路径的实测数字。
> 调度语义见 [docs/scheduling.md](scheduling.md)；协议与渠道配置见 [docs/protocols.md](protocols.md)。

- **4xx 重试规则（v1.9.2 起收敛为一个判据）**：`401/402/403/404/408/429` 属于渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 一律切下一候选兜底；其余 4xx（`400` 参数错、`422` 等）**只在后面已经没有能上场的候选时**才原样透传给客户端，前面还有候选就照样当"这家不行"继续切。
  · 动机：渠道「声明有此模型」但上游实际没有（别名表过期 → 上游 404），或中转参数方言不同（不认 `stream_options` 等）——这类 4xx 换一家往往就能成。而网关此前**已经**给这家记了失败并置冷却，却把上游 4xx 甩给客户端并就此停手：自己认定是渠道的错，却对客户端说是客户端的错，还不兜底，逻辑自相矛盾（现象：该模型明明另有能用的候选，客户端却拿到 404）。
  · 「还有候选」只看**这轮真能上场的**（冷却中的候选不算：它这一轮不会被尝试，把它算成后手会让兜底切进空池、最后兜出个 502，把客户端本该看到的 400 弄丢）。
  · 代价：真·客户端的错（参数写错）现在会把候选链走完才回 4xx，请求更慢、上游多挨几下；相比之下"明明有能用的渠道却给客户端报错"更糟。链长仍受 `retries.maxModelFallbacks` 约束，同一家的额外重试次数受 `retries.perChannel` 约束（但 4xx 从不重试，见 [docs/scheduling.md](scheduling.md)「同渠道重试」）。
  · 透传时用的是**最后一家**上游的错误体与状态码，客户端看到的仍是上游真实答复（不是网关伪造的 502）。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
  · **流内错误帧与"提交分界线"（v1.18.21）**：不少中转站（new-api 系）遇到自家后端失败时**不**回 4xx，而是回 HTTP 200 的 SSE 里塞一帧 `data:{"error":{…}}` ——超长上下文打到上限小的渠道是最常见的触发（现场 `req_mur6vapv`：66,991 进 / **0 出**，流里只有 role 帧 + `The input exceeds the supported context size` + `[DONE]`，客户端报 `The server had an error`，而网关旧逻辑只看"200 + 流结束"就记 `ok:true`，渠道健康还被清零）。
  · 判据是**响应有没有提交给客户端**：① 正文出现**之前**扫到错误帧（此时还没写出任何字节）→ 取消读取、返回 `stream_error: <上游原文>`，候选链**切下一家**（别家的上下文上限可能更大），用量如实记 `ok:false` 但**不**给这家记失败（"这家吃不下这个请求"≠渠道坏了）；② 正文已经流出去之后才扫到 → 流如实转发收尾（客户端拿到的部分是真的），但账本记 `ok:false` 并给渠道 `recordFailure`（连败进冷却）。
  · 为了让 ① 可行，流式的 `writeHead`/开场事件（`streamPrelude`）改成**懒提交**：推迟到确实要写出第一段字节时。提前提交会让下一候选的 `writeHead` 撞 `ERR_HTTP_HEADERS_SENT`，客户端也会先收到一个空的 200 壳。
  · 非流式同型（200 + `{"error":…}` 报文）走同一判据：还没提交响应 → 记 `ok:false` 并切下一候选。**字节保真不受影响**（直通路径仍逐字节转发；扫描只是旁路读一份文本副本）。回归：`test/stream-error-frame-e2e.test.js`。
- **协议转换**：OpenAI ↔ Anthropic ↔ Gemini 三边都走内部 OpenAI 协议中转；**出站方向也按渠道的 `protocol` 走原生格式**（见 [docs/protocols.md](protocols.md)「原生出站」），所以任一客户端协议都能打到任一协议的渠道上。
- **原生出站（`protocol: anthropic` / `gemini`）**：请求侧 `system`→顶层 `system`/`systemInstruction`、`tool_calls`→`tool_use`/`functionCall`、工具结果→`tool_result`/`functionResponse`（Gemini 按函数名配对）、图片→`image` 块/`inlineData`・`fileData`、`max_tokens`→`max_output_tokens`/`maxOutputTokens`、`stop`→`stop_sequences`/`stopSequences`；响应侧反向映射（`stop_reason`→`finish_reason`、`usageMetadata`→`usage`、`thinking`→`reasoning_content`）。
  · 流式：Anthropic 原生 SSE 事件与 Gemini `alt=sse` 分片都会**逐行翻译成 OpenAI 分片**，再交给该路由既有的流式转换器；上游异常断流时由收尾逻辑补 `finish_reason` + `[DONE]`（客户端不会一直等）。
  · 上游错误体不翻译（原样透传状态码与消息），避免 400 被伪装成"成功但空"。
  · 有损点（**仅跨协议时**）：`tool_choice:"none"` 在 Anthropic 侧无对应语义（改为去掉 tools）；`cache_control`/`top_k`/thinking 签名在跨格式时丢弃。同协议（Anthropic 客户端 → Anthropic 渠道、Gemini 客户端 → Gemini 渠道）自 v1.15 起走**同协议直通**，一趟转换都没有，上面这些丢件不再发生（见 [docs/protocols.md](protocols.md)「同协议直通（v1.15）」）。
  · **思维链（thinking）的真实边界（v1.18 核对、v1.18.8 增补，有测试守着）**：**跨协议**时**双向**都不带思维链——入站 `thinking`/`redacted_thinking` 整块丢弃，
    回程也**不向客户端产出** `thinking` 块（`server.js` 里 `signature` 只活在 thinking 回放块与 4xx 作废分支两处，跨协议转换器一个都不碰：既不保存、不校验，也**绝不伪造**）。
    所以 Anthropic 客户端配 OpenAI 协议的渠道时，**看不到思维链、也不会因此报错**；想要思维链就走同协议的 Anthropic 渠道（直通，签名原样活着）。
    完整地图：`test/thinking-fidelity.test.js` + [docs/thinking-replay-design.md](thinking-replay-design.md)
- **thinking 回放缓存（v1.18.8，默认关）**：同协议直通（Anthropic 客户端 → Anthropic 渠道）上，客户端把上一轮 `thinking` 块的 `signature` **弄丢**再送回来时（部分开源 agent 框架重新序列化消息时会丢掉不认识的字段），网关按缓存把**上游自己签的那枚**签名补回去再转上游。
  · 边界刻到最窄：**只回放缓存里真有的签名**（从不生成、从不猜测）；键是 `会话键|渠道|模型|块哈希` 四元组，**绝不跨会话/跨渠道/跨模型**（签名与上游账号绑定，渠道 A 的签名过不了渠道 B 的校验，这条 400 连缓存也治不了）；取不到会话键就不回放；**客户端改写过 thinking 文本的块不配旧签名**（块哈希不认）；请求里没有缺签名的块就**一个字段都不动**（完好客户端的直通保真不变）；上游因签名问题 4xx 时这组记录**立即作废**（`stale` 计数）。
  · `redacted_thinking` 不存不修（它没有签名字段）。开关走「运行期设置」第四组 `thinkingReplay`（`enabled` / `ttlSec` 30–604800 默认 3600 / `maxEntries` 16–100000 默认 2048），状态与计数在 `/admin/api/status` 的 `thinkingReplay` 段，事件在 `/metrics`。
  · 设计与三次决策的完整记录：[docs/thinking-replay-design.md](thinking-replay-design.md)；回归是 `test/thinking-replay-e2e.test.js`（64 项，含"先复现真实失败"的对照轮）。
- **工具调用（Anthropic tool_use ↔ OpenAI tool_calls）**：双向全字段映射，客户端可混用两套说法——
  · 请求侧：`tools[].input_schema` → `function.parameters`；`tool_choice` 的 `auto/any/tool/none` → `auto/required/{function}/none`；`disable_parallel_tool_use` → `parallel_tool_calls:false`；`stop_sequences` → `stop`；`system`（字符串或 block 数组）→ `system` 消息。
  · 会话侧：`tool_use` 块 → `assistant.tool_calls`（`input` 对象 ↔ `arguments` JSON 串）；`tool_result` → `role:"tool"`（`tool_call_id` 配对）。`is_error:true` 无对应字段，前缀 `[tool_error]` 显式告诉模型"这个工具失败了"（否则它会把失败信息当正常结果继续编）。
  · **工具结果里的图片**：OpenAI 的 `tool` 消息只允许文本部件，塞 `image_url` 会被上游 400 —— 网关把图**取出来补在紧随其后的 `user` 消息**里（带 `[tool_result image]` 锚点），视觉模型照样看得到；这种形态同样受「图片能力门」约束。
  · 响应侧：`tool_calls` → `tool_use` 块（id 走 `sanitizeToolId` 清洗，保证客户端回传 `tool_use_id` 时配对不裂）；`finish_reason` → `stop_reason`（`tool_calls`→`tool_use`、`length`→`max_tokens`、`stop`→`end_turn`、`content_filter`→`refusal`）；`usage.cached_tokens` → `cache_read_input_tokens`。
  · 刻意**丢弃**：`thinking` / `redacted_thinking`（OpenAI 格式上游无签名校验需求，把思维链塞回上下文反而有害）、`server_tool_use` / `web_search_tool_result` / `document`（无法在中转链复现）、`cache_control` / `metadata` / `top_k`。丢弃不影响结构完整性。
  · 上游限制会被原样透传：例如 thinking 类模型对"强制指定某个工具"会回 400（`Thinking mode does not support this tool_choice`），网关不吞不猜。
  · Gemini 方向的配对细节（`functionCall` ⇄ `tool_calls`、按函数名 FIFO 配对、无状态客户端退文本）：见 [docs/protocols.md](protocols.md)「工具调用」。
- **流式（SSE）**：三条客户端协议的流式都可用，且**首块字节与后续字节走同一条按行分发路径**（上游把整个流一次送到时不得丢字节，见 PT26）。
  · Anthropic 路由的流式转换是**有状态**的：`message_start` 每个请求只发一次，文本块只开一次，`tool_calls` 的 JSON 参数分片跨 chunk 累积后作为 `input_json_delta` 发出（否则流式工具调用必然碎）。
  · 上游不发 `[DONE]` 时，由收尾钩子补上关块 + `message_delta` + `message_stop`（客户端不会一直等）。
  · Gemini 的流式体现在 URL 动作（`:streamGenerateContent`），出站会显式带上 `stream:true`。
  · 流式失败细节见上文「流式失败」。
- **图片（多模态）**：三条客户端协议统一把图片转成内部 `image_url` block（识别规则与部件顺序见 [docs/protocols.md](protocols.md)「图片（多模态）的统一转换」）。带图请求只走 `openai` / `anthropic` / `gemini` 三种协议的渠道（候选裁剪见 [docs/scheduling.md](scheduling.md)「含图请求的候选裁剪」）。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **密钥轮换（v1.18.5，控制台可在线轮换）**：`GATEWAY_KEY` / `ADMIN_KEY` 的生效值按 `config.json` 的 `auth` 段（控制台轮换）**> 环境变量 >** 首启自动生成取值——控制台说了算，重启不会被 `.env` 顶回去。控制台「工具 → 密钥管理」页可手填或随机生成新密钥，点一下「轮换」**立即生效、旧密钥立即失效**（无宽限期）；页面上每把密钥标注来源（控制台轮换 / 环境变量 / 首启生成），「回到环境变量值」删除 `auth` 段把控制权交还给 `.env`。新密钥准入：8–128 位可见 ASCII、禁 `change-me`、两把不得相同；**管理密钥另需大小写字母+数字+特殊字符四样齐全**（它是控制台的唯一门锁），被拒的值**不生效也不落库**。换管理密钥时**全部控制台会话同时作废**（换锁后旧会话不该继续开门），但发起轮换的那个响应会**补发一枚新会话 cookie**——发起页不会被踢回登录门，其它标签页 / 设备 / 脚本里的旧值立即 401，各自重新登录一次。
- **管理面会话（v1.18.6，渗透第三批）**：浏览器打开控制台不再是"密钥常驻 localStorage"，而是**登录门交一次密钥换会话 cookie**——
  `POST /admin/api/session`（body `{key}`）验证 `ADMIN_KEY` 后下发 `Set-Cookie: zz_session=<64 位十六进制>; HttpOnly; SameSite=Strict; Max-Age=43200`
  （`HttpOnly` 让 JS 读不到 token，`SameSite=Strict` 顺带治 CSRF；**刻意不加 `Secure`**——本网关设计上就跑 http 本地/局域网，加了 cookie 反而种不下去）。
  之后管理面调用只带 cookie（同源自动附上），密钥本身不进浏览器任何存储。会话表在**内存**：TTL 12 小时（懒过期 + 10 分钟清扫）、上限 256 条（先清过期、再逐最旧）、
  **重启全部掉线**（重开控制台重新粘一次密钥即可，脚本走 Bearer 不受影响）。登录失败计入 admin 失败限流（30 次/分钟，瞎试密钥与瞎试接口同等对待）。
  「工具 → 密钥管理」页有**退出登录**按钮（`DELETE /admin/api/session`，只杀自己那枚 token）；轮换 / 重置管理密钥会清空全部会话（见上条）。
  脚本 / CI **不受影响**：管理面始终保留 `Authorization: Bearer ADMIN_KEY` 通道，两种鉴权可并存。
- **鉴权写法**：网关密钥接受 `Authorization: Bearer <key>`、`?key=<key>`，以及**原生 SDK 的默认头**——Gemini 的 `x-goog-api-key`、Anthropic 的 `x-api-key`（仅对 `/v1/*` `/anthropic/*` `/gemini/*`；**管理面只认 `Bearer` 或会话 cookie——v1.18.6 起 `?key=` 已从管理面拆除**，客户端密钥语义不得混进管理面）。OpenAI SDK 走 Bearer，本来就通。
- **Host/Origin 门（v1.18.10，渗透整改 V-07 第六批）**：一切路由之前先过两道门——① `Host` 必须是 `localhost`、回环/私网/链路本地 IP 字面量（127.x / 10.x / 192.168.x / 172.16–31.x / 169.254.x / ::1 / fe80、fd00 段——**按裸 IP 访问控制台与 API 的常态天然通过**），或在 `ZZCSAPI_ALLOWED_HOSTS`（逗号分隔）显式登记；其余一律 **421**（DNS 重绑定页面必须带着攻击者的域名来，正好被拦死；**反代/公网域名部署必须登记，公网默认拒是刻意姿势**）。HTTP/1.0 无 `Host` 放行（重绑定必须带域名，空 Host 无从伪装）。② 带 `Origin` 且与 `Host` 不同源的请求一律 **403**（本网关不开 CORS、控制台是同源应用；**服务器间脚本不带 `Origin`，零影响**；与 `SameSite=Strict` 叠加，跨源写操作双保险）。守卫在 `test/security-headers-e2e.test.js`（421/403/放行三态 + 装配位置）。
- **来源 IP 态势统计与封禁（v1.18.11）**：动机是密钥被人放进"中转站"转卖时**看得见**——per-IP 敲门数（含 401/429——刷鉴权也是指纹）、token/模型（只在成功用量上记，`recordUsage` 单漏斗）、峰值并发（与限流闸同一条 finish/close 归还路径）、会话数估计（复用会话粘性的键推导，`ignoreEnabled`——粘性开关关着也推）、24 小时桶（本地时区，跨天清零）、客户端标签（UA 自报家门，只是显示列**不进任何控制逻辑**）。**统计是内存态：网关重启清零**（检测用数据丢得起，学管理面会话的先例）；留存有界（IP 上限 512、每 IP 会话 512 / 标签 8 / 模型 64，超限丢最旧）。封禁表落 `config.security.bannedIPs`（重启不丢，`persistConfig` 白名单含 `security`）。**封禁只拦客户端面**（`/v1` `/anthropic` `/gemini` 一律 403，在 Host/Origin 门之后、限流之前——被封的请求不占并发额度、不烧密钥失败计数，但**照常计入该 IP 的封禁命中数**：封了之后对方还在敲，看得见）；管理面/控制台/健康检查**永远可达**——解封按钮永远不会把自己锁在门外。`X-Forwarded-For` 只在 `config.security.trustedProxy` 登记的来源上采信第一跳（XFF 是客户端可伪造的头；不设就只认 socket 地址，`::ffff:` 前缀归一）。轮换出口的中转站封不住单 IP——**全局峰值并发远超任何单 IP 峰值 + 会话数畸高**就是它的指纹，兜底是换密钥 + 全局 `maxConcurrent`/`rpm`（已有旋钮）。守卫在 `test/ip-stats-ban-e2e.test.js`。
- **别名区分大小写不敏感**，upstream 透传原样。

## 出站与流式写路径（v1.16：两处实测出来的开销）

这一版没有加功能，只把两处「自找的开销」修掉，数字都是本机实测（回环、同机、客户端用 keep-alive）：

| | 改前 | 改后 |
| --- | --- | --- |
| 出站客户端 | Node 全局 `fetch`（undici）：容器内每跳 1.28ms vs `http.request` 0.54ms；并发 32 吞吐只有直连的 44%；**Windows 开发机上每请求 +13ms** | 自带 `http/https` + keep-alive Agent 的 `zzFetch`（`maxSockets: 128`） |
| 网关净增延迟（非流式，Windows） | +13.9 ms | **+0.93 ms** |
| 网关净增延迟（非流式，容器内 Linux） | 1.28 ms/跳（出站那一跳） | **+1.06 ms**（含网关自身 JSON/调度/记账的开销） |
| 非流式吞吐（并发 32，Windows） | 950 req/s（直连 2983，32%） | **1814 req/s（直连 3135，58%）** |
| 流式首字节净增（10 片 × 25ms，Windows） | +13.6 ms | **+1.44 ms** |
| 块间隔抖动净增 | +10.95 ms | **+0.03 ms** |
| 客户端收到的 TCP 写次数（上游 10 片） | 24 次（每帧被拆成"数据行 + 空行"两次写） | **11 次（与上游分帧对齐）** |
| 直通流式字节一致 | 逐行重组：`CRLF` 被归一成 `LF` | **原始字节直转：CRLF / 分帧边界 / 空行全部逐字节一致** |

- **出站**：`zzFetch(url, {method, headers, body, signal})` 接口与 `fetch` 一致（`status`/`ok`/`headers.get`/
  `text()`可重复调用/`json()`/`body.getReader()`/`AbortError`），redirect 跟随、`Content-Encoding` 解压
  语义都按 `fetch` 对齐，所以**调用点零改动**；`notion` / `notion-agent` 模块拿到的也是它。
  安全网：没有 `signal` 时留 300s 兜底，避免连接阶段永久挂住。
- **直通**：流式改为把上游字节直接写回客户端，另起一条旁路只做 usage 扫描与 token 估算——
  所以"字节一个不改"和"真实 token 照记"同时成立（见 `test/outbound-http-client.test.js`）。
- **非直通**：一次 drain 里的所有输出合并成一次 `write`（旧的逐行写让 SSE 每帧变成两次写）。
- 代价（诚实说）：`identity` 编码意味着上游若无视它硬塞压缩体，解压由我们做（已覆盖 gzip/deflate/br）；
  连接池上限 128（旧 `fetch` 没有这个上限，但它也不复用连接）。
- 同类项目的机制对照与取舍，见 [docs/gateway-comparison.md](gateway-comparison.md)。
