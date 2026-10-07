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
- **失败归因：进入 502 的每一条都要能自证原因（v1.18.34）**：`all channels failed` 的 `attempts[]` 里，`channel_error` 曾是个**不透明标签**——4xx 路径把"为什么"留在了渠道运行态（`lastError`），报文里只剩一个词。现场（`gpt-6-astra` 那次 502）两条 `mjiutang5920` / `mjiutang1` 写着 `channel_error`，而它们真实的失败是 `HTTP 429`（空体）与 `HTTP 403`（`<!DOCTYPE html>` 挑战页）——用户拿到的 502 看不出是余额、限额还是被 WAF 拦，只能反过来问"为什么调用失败"。
  · 现在 `attemptErr()` 给"不带原因"的两类返回值补上渠道**刚刚**记下的 `lastError`：`channel_error`（4xx，无码无文）与 `upstream N`（5xx，只有码没文），格式 `channel_error：HTTP 429: <上游原文前 160 字>`（换行/制表符压成空格，避免报文里冒裸 HTML）。
  · **只补这两类**：`stream error frame: …` / `network: …` 本身已带原因，再拼一遍是噪音。4xx 路径在返回前必先 `recordFailure`，所以补进去的是**本次**原因、不是陈年旧账。与冷却分支那句「in cooldown（…：上游原文）」（v1.14.1）是同一招。回归：`test/upstream-4xx-fallback-e2e.test.js` §9/§10。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
  · **流内错误帧与"提交分界线"（v1.18.21）**：不少中转站（new-api 系）遇到自家后端失败时**不**回 4xx，而是回 HTTP 200 的 SSE 里塞一帧 `data:{"error":{…}}` ——超长上下文打到上限小的渠道是最常见的触发（现场 `req_mur6vapv`：66,991 进 / **0 出**，流里只有 role 帧 + `The input exceeds the supported context size` + `[DONE]`，客户端报 `The server had an error`，而网关旧逻辑只看"200 + 流结束"就记 `ok:true`，渠道健康还被清零）。
  · 判据是**响应有没有提交给客户端**：① 正文出现**之前**扫到错误帧（此时还没写出任何字节）→ 取消读取、返回 `stream_error: <上游原文>`，候选链**切下一家**（别家的上下文上限可能更大），用量如实记 `ok:false` 但**不**给这家记失败（"这家吃不下这个请求"≠渠道坏了）；② 正文已经流出去之后才扫到 → 流如实转发收尾（客户端拿到的部分是真的），但账本记 `ok:false` 并给渠道 `recordFailure`（连败进冷却）。
  · 为了让 ① 可行，流式的 `writeHead`/开场事件（`streamPrelude`）改成**懒提交**：推迟到确实要写出第一段字节时。提前提交会让下一候选的 `writeHead` 撞 `ERR_HTTP_HEADERS_SENT`，客户端也会先收到一个空的 200 壳。
  · 非流式同型（200 + `{"error":…}` 报文）走同一判据：还没提交响应 → 记 `ok:false` 并切下一候选。**字节保真不受影响**（直通路径仍逐字节转发；扫描只是旁路读一份文本副本）。回归：`test/stream-error-frame-e2e.test.js`。
  · **零正文流（v1.18.26）**：上游回 **200 但流里一个正文字节都没有**（只有 role/usage 帧 + `[DONE]`，既无 `error` 帧也无内容帧）——这是**额度耗尽/过载**最常回的形态。旧逻辑"200 + 流干净结束 = 成功"把它记成 `ok:true`，于是后台看着成功、客户端却只拿到空回复（DSH 报「当前请求的额度已用尽」），既不退避也不切候选，用户反复撞同一家。现在：**未提交响应**且零正文 → 判失败、`recordFailure`、切下一候选，用量记 `ok:false`（`note: stream empty: 200 no content`）。
    · 判据**只作用于 OpenAI 协议渠道的常规链路**（`!passthrough && !nativeStream`）：同协议直通是逐字节转发、原生渠道走翻译器，"空"的语义不同（工具调用帧可能不带文本），不在该判据范围内以免误伤；`sawStreamContent` 由正文/工具调用/思考任一帧置位，故只有**真·空流**才命中。
    · 与"首字超时"「流内错误帧」合起来，流式失败现在覆盖三类：上游不回（idle）、上游回错误（error 帧）、上游回空（zero content）。
  · **思考吃光预算（v1.18.28）**：第四类失败，也是现场"空回复 / 回答被截断 / 额度已用尽"的**真正主因**。原始报文实证（诊断开关 dump 出的真实请求体 + 上游 SSE）：`deepseek-v4.1-flash` 背后是 **`accounts/fireworks/models/deepseek-v4p1-flash`（Fireworks 托管的推理模型）**——它先连发 24 帧 `delta.reasoning_content`（思考），随后 `finish_reason=length`、**可见正文 0 字节**。客户端因此什么都看不到；而账本把思考也算进 `out`（实测 `out=30` 全是思考），于是"后台记成功、客户端失败"两头对不上。
    · 处置 ①：`flushOut` 的扣帧判据从"见过任何内容"收紧为"见过**可见正文/工具调用**"。思考帧不再一到达就提交响应（否则字节已经写出去、`finish=length` 判出来时**已经换不了家**）。但思考对客户端是有用的实时反馈、且不能无限期扣着（客户端首字延迟、CF 免费版 100 秒无字节超时会掐断 SSE），所以**只扣 `REASON_HOLD_MS=3000` 窗口**：窗口内流结束 → 客户端一个字节都没收到、切换零副作用；超窗或已提交 → 照常转发。
    · 处置 ②：命中「`finish_reason=length` + **可见正文为 0** + 无工具调用 + 响应未提交 + `max_tokens` 缺省或 ≥256」→ 判失败、`recordFailure`、**切下一候选**（这是我们渠道池相对 sub2api「分组↔渠道 1:1」的真实优势：同一次实测里 sharellm / bqgy 都能正常出正文）。判据刻意收窄：工具调用帧可以不带正文（不误判）、`max_tokens < 256` 的探测类请求不换家。
    · 处置 ③：账本诚实——用量行新增 `reason` 字段（这发里有多少 token 属于思考），失败行备注写清 `reasoning-only: length with zero visible content`；"响应已提交、换不了家"的那种也照样记 `ok:false`，不再伪装成一次正常回答。回归：`test/reasoning-only-fallback-e2e.test.js`。
- **渠道级「不发这些参数」（`dropParams`，v1.18.33）**：
  · **问题**：`agentrouter` 每天固定开放额度，但它对「`tools` + `reasoning_effort`」这个组合直接 400 —— `Function tools with reasoning_effort are not supported for gpt-6-astra`；而 DSH 每次请求都同时带这两样，于是这个渠道对我们 **19 行 0 成功**。
  · **根因**：参数是**客户端**发的，网关原样转发（`reasoning_effort` 在 `server.js` 里一次都没出现过），客户端不由我们控制 → 开关只能放在渠道上。同类网关通常只能让用户改客户端，而这里改不了。
  · **处置**：新增渠道字段 `dropParams`——出站前从这家渠道的请求报文里删掉指定的几个参数。三条纪律：① **白名单**（`DROP_PARAM_WHITELIST`，含 `reasoning_effort`/`thinking`/`temperature`/`max_tokens` 等），`messages`/`model`/`stream`/`tools` 这类结构性字段**一律不在内**，配错名字最多"没生效"、绝不会把请求打残；② 只在**出站副本**上删（浅拷贝再删），绝不原地改客户端报文对象——它在候选链里被多个渠道共用，原地删会把 A 家的怪癖串味给 B 家；没配的渠道零拷贝原样返回；③ 白名单外的名字 **400** 并回带合法清单，**不静默忽略**（静默忽略正是"配了却没生效、然后对着一个 100% 失败的渠道排查半天"的成因）。
  · **生效范围**：常规链路（`encodeOutgoing(dropParamsFrom(body, ch), candidate)`）与**同协议直通**（`passthroughChannelOpts(proto, rawBody, dropParams)` 内的 `strip()`）都生效；`workbuddy` / `codex` / `genspark` / `notion-agent` 自带专用报文构造，**不适用**（配了静默不生效，见 `docs/protocols.md`）。
  · 字段接线四处齐全（**PT29 那个坑**：`persistConfig` 是显式字段清单，漏一行就会被下一次任意渠道保存静默抹掉）：`persistConfig` / `GET /admin/api/channels` / `POST /admin/api/channels` 的 def 构造（显式空数组 = 清空、不传 = 沿用旧值，与 `weight` 同款语义）/ `GET /admin/api/config` 下发 `dropParamWhitelist`（控制台照用，不自己抄一份）。
  · 回归：`test/channel-drop-params-e2e.test.js`（85 项：主用例上游真收不到 `reasoning_effort` 但 `tools` 仍在、对照组没配的照样收到、**不串味**（第一家失败后第二家仍收到该参数）、同协议直通也生效、白名单校验 400、落库往返 + 保存别的渠道后仍在、清空语义、`dropParamWhitelist` 下发）+ `test/console-state.test.js` §3b（表单回填 / **总是提交**（框空 = `[]` = 清空）/ chips 来自服务端下发 / 降级 / 前端不硬编码白名单）。
- **「200 但空」的记账在直通与非流式两条路上补齐（v1.18.32）**：
  · **问题**：用户报「`gpt-6-astra` 这个模型的渠道好像现在全是失败」。账本 `usage.json` 里该模型 349 行（123 成功 / 226 失败），其中 **91 行是"幽灵成功"**——`ok:true` 但 `out=0`，client 全是 `deepseek-harness`（用户的 DSH 真实会话），输入 128k~132k token、耗时 7~18 秒：**客户端拿到的是空回复，账本却一片绿**，这家既不退避也不换家，用户反复撞同一家。
  · **根因**（两处，都不是"上游 500"）：① 流式的零正文判据（v1.18.26）要求**响应尚未提交**（`!headCommitted`）才判失败——它要的是"零副作用换家"，而边收边写那条路（同协议直通）的 `headCommitted` 恒真，于是"200 + 一个内容帧都没有"在这条路上**被记成成功**；② **非流式路径压根没有空正文判据**——`choices[0].message.content === ''` 的 200 报文一路记 `ok:true`。
  · **那批幽灵成功为什么判定来自非流式路径**（两条独立证据，可复算）：① 流式的空流早已被 v1.18.26 抓死，账本里**有带 `stream empty` 备注的行**可证；② 更直接的是**时间轴上交错**——10-03 12:34:29~34 有 8 行被如实记成失败，而 12:34:48 幽灵成功仍在继续，同一版代码下只能是**另一条路**。注："91 行"是当时的账本滚动窗口口径（`usage.json` 的 `recent[]` 有界，旧行会被滚出），同一批数据随后量到过 84 / 62 行，不影响结论。
  · **处置 ①（流式收尾）**：`streamError === null && !nativeStream && !sawStreamContent` → 流已收尾、无错误帧、却一个内容帧（正文/工具调用/思考）都没见过时，用量记 `ok:false`（`note: stream empty: 200 no content（已提交；客户端拿到的是空回复）`）并 `recordFailure`（进冷却，下一发自然换家）。字节已经写出去了、**换不了家**，但"账本不说谎 + 让这家退避"两件都成立——这正是用户感知的堵点。
  · **处置 ②（非流式，收益更大）**：`resp.ok` 且报文确有 `choices[0].message` 时，`content === ''` 且无 `tool_calls`、无思考 → 记 `ok:false` 并 `return 'stream_error: empty completion (200, no content)'` → **切下一家**（非流式响应尚未提交）。判据只在"上游报文确实是一份 OpenAI 补全"时才下结论，避免误伤被 `translateResponse` 转成 anthropic/gemini 形态的报文；`tool_calls` 与思考都算内容（工具调用帧可以不带正文）。
  · **判据为什么必须排除原生流（`!nativeStream`）**：原生渠道走翻译器，`handleLine` 在 `nativeStream` 分支**直接 return**，`noteStreamLine` 压根不跑，`sawStreamContent` 在原生流上恒为 `false`——只按它会把**每一条正常原生流**都判成空（实测误伤：`mock-anthropic` 翻译后已有 **23 字符正文**仍被记失败 → 渠道进冷却 → `native-channels-e2e` **6 条级联 503**；加上 `!nativeStream` 后该文件 **34 项全过**）。
  · **也不要再加 `streamOutText.length === 0` 之类的"保险"**：直通路径的 `streamOutText` 在 `sseDeltaText` 取不到文本时会**回落累计原始行**（`passthroughWrite` 里 `|| line`），所以空流的它照样非空——加了这条等于把直通场景整条判死（写的时候真踩过，靠 `!nativeStream` 已足够排掉误伤源）。
  · 回归：`test/stream-error-frame-e2e.test.js`（**场景 F**：非流式 200 + 空回复 → 判失败、切下一候选、失败行带模型名；含"正常非流式仍 `ok:true` 且 `out > 0`"对照）+ `test/same-protocol-passthrough.test.js`（**§3b**：直通路径只发 `message_start` + `message_stop` → 客户端仍拿 200 + 上游原始 SSE、用量 `ok:false`、渠道 `lastError` 写明 `stream empty`；另含判据条件的结构守卫）。
- **hark 的"固定道歉"也是 200 ≠ 成功（v1.18.55）**：
  · **现场**：v1.18.52 把工具定义形状归一之后，用户仍报「真实调用了两次还是有问题」——agent 客户端拿到的还是散文，账本三行分别是 `in=212,453 out=106 / out=98 / out=121`。
  · **根因（用同尺寸载荷做对照实验才看清）**：把同一发 211k token 请求**连打 8 次**，**6 次正常回 `[TOOL_CALL]`、2 次回同一句**
    `I wasn't able to answer this message.`（out=10）/ `I couldn't complete your request. Please try again.`（out=13）。
    这是 **hark 基础设施层的固定道歉，约 25% 偶发**——**不是**模型在拒绝、**也不是**协议没注进去（同尺寸同报文的 A/B/C 三臂都能出工具调用）。
    旧行为把它记成 `ok:true` 并原样回给客户端，于是"25% 的偶发"在用户眼里就是"这个渠道坏了"。
  · **处置**：`tool-emu.js` 的 `looksLikeHarkCannedFailure()` 一处识别（hark 固定道歉原文 / 模型自称没有工具能力（英/中）），
    命中就在 `tryHarkChannel` **就地同渠道重试最多两发**（**不依赖 `PER_CHANNEL_RETRIES`**，那个配置键默认 0 = 等于没有）；
    两发都还是道歉才如实报失败并交调度层切下家。**判据刻意窄**：长正文（>800 字符）放过、普通短答不命中。
  · **活体验证**：同一发载荷连打 8 发（**只统计真落在 hark 的**，按响应头 `X-ZZCSAPI-Channel` 判别——
    `gpt-6-astra` 是十几个渠道共用的别名，不判别会把 notion 等的回复当成 hark 的结论，这一轮真的误判过一次），
    改前基线 **6/8 = 75%** → 改后 **8/8 = 100%**。
  · 回归：`test/hark-channel.test.js` **§9**（16 条真值表 + ★ 真网关"第一发 canned、第二发正常 → 客户端必须拿到 `tool_calls`" + ★ 上游真收到两发 + 对照"一直回道歉则如实失败"）。
- **账本的「天 / 小时」一律按北京时间切（v1.18.36）**：
  · **现场**：查「yu1 渠道最近 24 小时用了多少 token」时，账本答不了——`recent` 明细只留 800 行（当前流量下仅覆盖 **1.7 小时**）、`byChannel` 是累计值没有时间维度、`byDay` 有日期维度却不带渠道维度（两者交集"某渠道某天"根本没记）。追这条线时又撞上更硬的一处：**日桶与小时桶对不上**。
  · **根因**：`recordUsage` 里 `const day = new Date(ts).toISOString().slice(0,10)` 取的是 **UTC 日**，而 `/admin/api/usage` 的 24 小时分布用 `new Date(r.ts).getHours()`（**本地小时**）——同一个账本里两套钟，日界落在**北京时间早上 8 点**：凌晨 0~8 点的流量被算进前一天。`ipStatsBumpHour` 更自相矛盾：注释写着「本地时区，跨天清零」，代码却是 UTC 日 + 本地小时（桶在北京时间 8 点清零，与桶内索引的"本地小时"错位）。
  · **处置**：新增账本时钟 `cnDayKey(ts)` / `cnHour(ts)`（**固定 +8**），账本四处口径统一走它们——`byDay` 桶键、per-IP 24 小时桶的日界与小时、`/admin/api/usage` 的 `hourly`。**为什么固定 +8 而不是图省事用 `getDate()/getHours()`**：后者取决于**进程时区**（compose 里设了 `TZ=Asia/Shanghai`，但裸跑 `node server.js` 的机器可能是 UTC），账本口径不该随部署环境漂；中国无夏令时，+8 恒定。
  · **历史桶的注记（不是 bug，别去"修"）**：`byDay` 是累计值、不重算，所以**改动之前的桶按 UTC 日、改动之后按北京日**——`2026-10-04` 那个桶装的是北京时间 10-04 08:00 之后的量（图表上看着偏短），北京 10-05 从零起。想重算也重算不了：逐行明细只有 800 行，历史行已经滚掉了。
  · 回归：`test/usage-day-key.test.js`（27 项：真值表含北京 00:00 边界、跨月跨年与**老写法对照**；★ 真链路**用 `TZ=UTC` 起网关**证明口径不依赖进程时区——`byDay` 桶键 = 该行 `ts` 的北京日、`hourly` 落在北京小时而 **UTC 小时那格必须是 0**、per-IP 24 桶同理；含"全仓 Date → 日字符串的转换只有 `cnDayKey` 一处"的结构守卫）。
- **常规链路的记账口径：工具轮不许被记成"零产出的成功"（v1.18.35）**：
  · **现场**：账本里 `deepseek-v4.1-flash` 有 **196 行 `ok:true` 且 `out=0`**，耗时只有 8~38 秒（有正文的行是 45~147 秒），且与"有正文的行"在同一渠道、同一分钟里交错出现。我据此误判成"35% 的调用返回空回复"。
  · **定性（留证开关 + 逐字节回放，可复算）**：开 `ZZCSAPI_DUMP_BODIES` 抓 DSH 的真实报文（`stream:true`、`max_completion_tokens:32768`、**`tools:40`**、消息 119~231 条），再把留证里的报文**原样回放**给本地网关 —— **3/3 复现**：HTTP 200、52 个 SSE 帧里 **49 个是 `tool_calls`**、可见正文 0 字符、`finish_reason=tool_calls`；而上游 usage 帧明明自报 `prompt_tokens: 176351 / completion_tokens: 114`，账本却记 `in=56324 out=0`。**结论：客户端拿到的是完整的工具调用，这条链路是正常的**——`out=0` 只是记账口径（纯工具轮没有"正文"）。
  · **根因**：常规链路（openai 渠道 → openai 客户端）走转换器，既不建 `nativeStream` 也不走直通，于是 ① 上游自报的 usage 帧被**整帧丢掉**（`nativeStreamUsageScan` 只认 anthropic/gemini、`passthroughUsage` 只在直通路径填）→ `in` 永远是我们自己的估算、`out` 只数可见正文；② 纯工具轮没有可见正文 → `out = estimateTokens(streamOutText) = 0`。
  · **处置**：新增 `openaiUsageFromFrame()`（在 `noteStreamLine` 里抓 usage 帧，**必须在那条 `if (sawStreamContent) return` 早退之前**——上游常把 usage 放在最后一个 chunk，早退就整帧丢了）与 `sseToolCallText()`（工具调用的 name+arguments 也算输出）。成功记账改为：`in/out` **上游自报优先**，缺帧或报 0 时回落到估算（**估算把工具调用算进去**，故工具轮不再为 0）；`reason` 优先用上游自报的 `reasoning_tokens` 并**钳到 ≤ out**；纯工具轮在 `note` 上留 `tool_calls` 标记（一眼分得清"客户端拿到工具调用"与"客户端什么都没拿到"）。直通路径另补思考占比累计（此前只有常规链路记）。
  · **口径与直通路径对齐**：直通路径本来就是 `realUsage: passthroughUsage`（上游真实值优先），本次把常规链路拉到同一口径——此后 `out=0` 只可能是"上游真的没有输出"，而那种情况已被 v1.18.26 / v1.18.32 的零正文判据接住。
  · 回归：`test/tool-turn-accounting-e2e.test.js`（40 项：纯工具轮 + usage 帧 → `in/out` 取上游真值；纯工具轮**没有** usage 帧 → `out > 0`；文本轮两组对照；思考轮的 `reason` 用真数字且 ≤ out；含"usage 帧必须在早退之前抓"的顺序守卫）。
- **输出预算必须活着穿过每一层（v1.18.31）**：查「200 + 空流 / 截断」时用留证开关抓到 DSH 的真实报文，发现它发的是 **`max_completion_tokens: 32768`**（OpenAI 把 `max_tokens` 改名后的新字段）而**不发** `max_tokens`；而我们的跨协议转换器只读老字段 —— → anthropic 读不到就套缺省 **8192**（Anthropic 的 `max_tokens` 必填，不给会 400，所以有缺省），→ gemini 读不到就**整个不设** `maxOutputTokens`。推理型上游把「思考 token」算进同一份预算，8192 被思考吃光就是「可见正文 0 字符 + `finish_reason=length`」。**结论：有一类"截断/空回复"的根因是预算在我们这一层被改小或丢掉，不是客户端给得少。**处置：`clientBudgetOf(body)` 一处读两个字段名（老字段优先、非法值/0 视为"没给"），anthropic 转换、gemini 转换、思考吃光判据三处共用它；全仓不再出现 `Number(oai.max_tokens)` 这种只认老字段的预算读法。回归：`test/budget-passthrough-e2e.test.js`（真链路断言 anthropic 上游收到 32768、gemini 收到 `maxOutputTokens: 32768`，含两组对照）。
- **渠道超时与失败归因（v1.18.30）**：现场「glm-5.3 用不了，等两分钟才失败」的根因是**超时给得太宽 + 死线挂错了位置**——① 首字计时器原本只在**拿到响应头之后**才启动，所以"连响应头都不回"的挂死渠道只能等每渠道总超时（旧 120s），客户端（DSH 120s）先超时；② 默认值本身也过大（有候选 90s / 末位 300s）。处置：把 **fetch 本身纳入首字死线**（`FIRST_BYTE_MS` = 渠道 `firstChunkTimeoutMs` || 有候选 30s / 末位 60s，超时先用自己的原因拒绝再 abort，否则 `The operation was aborted` 会把真原因盖掉），并把每渠道总超时 120s → **90s**；流内空闲判据（`stream idle`）与它共用同一个值。另一处：`recordFailure` 现在带上 `statsCtx`——**失败行也有 client 标签**，此前失败行永远没有该字段，导致"测试脚本的失败"与"用户客户端的失败"无法区分（据此误判过一次）。回归：`test/channel-timeout-attribution-e2e.test.js`。
- **两个超时旋钮此前"配了会被静默抹掉"（v1.18.46）**：v1.18.30 把首字死线设计成**渠道可覆盖**（`firstChunkTimeoutMs`，另有 `timeoutMs` = 每渠道总超时），
  但这两个字段**只在运行期被读**、**三处登记一处都没有**——`persistConfig()` 是显式字段清单（PT29 那一族），漏行即抹除，`GET /admin/api/channels` 也不下发。
  实测现场：给"上游挂死/很慢"的家配 `firstChunkTimeoutMs: 7777`，**保存任意一个渠道**之后 `config.json` 里这两个键**消失**（重启悄悄回默认 30s/60s 与 90s），
  而 GET 里连键都没有 → 控制台看不见它的存在。**根因不是逻辑错，是"加渠道字段必须三处一起加"这条纪律漏执行了三次中的全部三处。**
  处置：① 值域收到**一处** `CH_MS_FIELDS` + `normChMsField`（`firstChunkTimeoutMs` 1000~300000、`timeoutMs` 1000~600000，整数），
  `validateChannelDef` 与 POST 共用——**越界/非整数一律 400**，且 `0` 刻意不收（运行期是 `ch.def.timeoutMs || 默认`，收下 `0` 就等于收下"配了不生效"，正是 v1.18.33 的现场教训）；
  `400` 的文案把「0 不是不超时、留空才是回默认」写进去，让语义随报错一起回显。② 落库清单与 `GET` 各补一行；③ POST 走**三态语义**
  （显式给值/空串 → 以本次为准；字段缺省 → 沿用 `prevDef`），与 `weight`/`dropParams`/`headers` 同款。④ 顺带堵一个被这次值域放大的地雷：
  notion-agent 路径的 `timeoutMs - 20000` 在 `timeoutMs < 20000` 时会把**负数**当超时传进 `runAgentTurn`，现改为 `Math.max(5000, …)`。
  回归：`test/channel-timeout-attribution-e2e.test.js` §E（落库往返 + 保存别的渠道后仍在 + 三态 + 非法值 400 且不落库 + 四处结构守卫）。
- **手动测试的预算与判据（v1.18.29）**：`/admin/api/test`（控制台「测试模型」）原本只发 `max_tokens: 16`——推理型模型 16 个 token **全被思考吃光**，上游回 200 + `finish_reason=length` + 可见正文 0，控制台按「2xx 但空 = 空回复」判**不过**，而渠道其实完全健康（现场：用户报「我在咱们站点点击测试都不过」，但该渠道自己的 new-api 游乐场与我们的直连都正常）。处置：① 预算 16 → `TEST_MAX_TOKENS=512`（cap 不是消费，健康模型会提前停）；② 无可见正文但**有思考**时，回一个带 `[输出仅含思考，渠道可用]` 标记的预览并标 `reasoningOnly`，好渠道不再被判死；③ 真·空回复（无正文也无思考）仍如实显示「空回复」，5xx 仍带上游原文。回归：`test/channel-test-reasoning-e2e.test.js`。
- **失败行也带模型名（v1.18.26）**：`recordFailure()` 记账时带上**请求的模型名**（`tryChannel` 的 `failModel` = 客户端请求体里的 `model`）。此前写死 `model:'—'`，实测近 200 行用量里 **88% 的失败行看不出在调哪个模型**（用户报「有的显示失败但没显示调用的哪个模型」）。后台探测/无请求上下文的路径仍落 `—`——那是"本就没有模型"，不是"我们没记"。
- **请求体落盘诊断（v1.18.27，默认关闭）**：`ZZCSAPI_DUMP_BODIES=<目录>` 时把客户端会话类请求（`/v1/chat/completions`、`/v1/completions`、`/v1/responses`〔v1.18.38 起〕、`/anthropic/v1/messages`、Gemini `:generateContent`；只落 POST，取回/删除没有会话体）的请求体原文落盘（`ZZCSAPI_DUMP_MAX` 控制保留数量，默认 30）。动机：上游「200 + `finish_reason=length` + 输出 1 个 token」「200 + 空流」这两种失败**伪装成成功**，客户端侧只有 token 计数、无法复现请求形态；留证是唯一能定位它们的办法。边界：`/admin/*` 一律不落（有密钥）、`?key=` 打码、单文件超 12MB 截断并标记、任何异常都吞掉（诊断绝不影响请求）、不设变量即零落盘。⚠ 文件含完整对话内容，仅本机排查时开。回归：`test/body-dump-diagnostic-e2e.test.js`。
- **协议转换**：OpenAI ↔ Anthropic ↔ Gemini 三边都走内部 OpenAI 协议中转；**出站方向也按渠道的 `protocol` 走原生格式**（见 [docs/protocols.md](protocols.md)「原生出站」），所以任一客户端协议都能打到任一协议的渠道上。
- **专用报文渠道的「输出收口」（v1.18.38 修正，公网实测发现）**：notion / notion-agent / workbuddy / genspark / codex
  这五条路径**自己构造上游报文**（不走常规出站），也因此历史上**自己写响应**——非流式 `res.end(JSON.stringify(chat 报文))`、
  流式 `res.write(chat SSE 行)`。对 OpenAI 客户端面（`/v1/chat/completions`）这本来就是要的形态，但**对其它客户端面等于把翻译层绕过去了**。
  · **现场**：v1.18.38 把 `/v1/responses` 推上公网后实测——Responses 客户端打到 **notion 渠道**，收到的是
  `{"object":"chat.completion","id":"chatcmpl-notion-…"}`（不是 `response` 对象）；同理 Anthropic 面流式打到这些渠道时事件序列里**没有 `message_start`**。
  · **根因两层**：① `tryChannel` 分派这五条路径时只透传了 `res`/`body`/`candidate`/…，把
  `onSuccessNonStream` / `onStreamChunk` / `streamPrelude` / `streamEpilogue` **四个输出钩子全丢了**
  （注释写着"anthropic 入口经 onStreamChunk 转换"——意图是对的，转发是漏的）；② 于是它们只能自己写响应，连"开场/收尾"都没有。
  · **处置**：钩子转发 + 四个收口 helper（`specialNonStreamOut` / `specialStreamHead` / `specialStreamLine` / `specialStreamEnd`），五条路径统一走它们。
  逐行钩子的语义要点：**有钩子时只写钩子的返回**——空串表示"这一帧不产出"，**绝不回退成原始 OpenAI 报文**（回退会把 chat 形态的 `data:` 行漏进 Responses/Anthropic 的事件流）。
  · **对 OpenAI 面字节等价**：`handleOpenAIRequest` 只设 `onSuccessNonStream`、不设另外三个钩子，所以 chat 面的报文形态与字节一个都没变（回归里有对照组）。
  · **两条边界（诚实说明）**：① **上游错误体仍原样透传**（`shouldPassThrough4xx` 分支照旧不翻译，刻意纪律）；② **候选链没动**——
  `workbuddy` / `genspark` 不在 Anthropic / Gemini 两条候选链里（那两条只兜底到 `notion` / `notion-agent` / `codex`），
  所以"某个面能不能打到某条专用渠道"是**调度语义**，不是收口能决定的。
  · 回归：`test/special-channel-output-seam-e2e.test.js`（装配守卫 + 假 workbuddy/notion 上游 × 四套客户端面）。
- **notion 渠道的「流断取回」兜底（v1.18.39）**：`notion` 渠道的上游 NDJSON 流里，`record-map` 才是**权威全文**，
  `patch` 只是增量。三种现场会让客户端拿到残次品：① 流里带 soft-block 错误（200 + `temporarily-unavailable`）
  ② 200 但零内容 ③ 流被截断（只剩半截 `patch`、`record-map` 从没到）。而这条线程在 Notion 侧**已经落库**
  （报文里 `saveAllThreadOperations: true`）——答案是能取回来的。
  · **处置**：用**同一 `threadId`** 把同一份 `transcript` 再发一次（`createThread:false` + `isPartialTranscript:true`）。
  活体验证（真实 token、云端容器内）：首发 6.3s 拿到 `record-map`；同一 `threadId` 再发 → HTTP 200 + 同一条线程的 `record-map` 全文（4.7s）；
  而**空 `transcript` 的"只取回"形状被上游 400 `ValidationError` 拒**——所以取回必须带 transcript，不能只读回。
  · **触发判据只有一个**：权威全文（`record-map` / `markdown-chat`）**没到**。到了就一个字节都不动，
  正常请求**零额外延迟、零额外额度**（回归里有"首发完整 → 上游只被打一次"的对照组）。
  · **它不是廉价读回**：会让上游**重新走一次推理**（消耗额度），所以有次数上限（2 次）与总预算（≤30s），
  且报文级错误（`isNotionError`）立刻放弃、不空耗。
  · **取回发生在写出任何字节之前**：流式面也是先把 NDJSON 整体缓冲、解析、必要时取回，再开始写——
  不会出现"先给客户端写了半截、再回填一段"。
  · **取不回就如实失败**：渠道照旧记失败、调度器照旧切下一家（兜底不许伪装成成功）。
- **上游明说不可重试时，跳过同渠道重试（v1.18.45，目前只有 notion）**：notion 软墙的报文里带
  `"isRetryable":false`（现场原文见 [docs/scheduling.md](scheduling.md)「上游否决」）——上游已经说了"这不是抖动"，
  可网关的 `perChannel` 重试照旧会在**同一家**再敲一次门。那一次白等几百毫秒到几秒，更要紧的是：
  **对一家正在拒绝我们的账号多敲一次门，只会把它往墙里推得更深**（软墙成因里"高频敲门推进账号维度"这条
  尚未验证的怀疑，见 [docs/notion-attachment-upload-research.md](notion-attachment-upload-research.md) §7）。
  · **处置**：判据只认**报文里这句话**、不看渠道是谁（`isUpstreamNonRetryable`），命中就跳过原地重试、直接换下家；
  标记（`[no-retry]`）只由 notion 路径挂上，所以其他渠道**天然不生效**——这是"只接 notion"的落法，
  而万一哪天别家也学会说这句话，判据不用再改一次。
  · **边界**：`notion-agent`（官方 Agent API）不挂这个标记（另一条路径、自带 HTTP 码与 credits 语义）；
  **「流断取回」兜底不受影响**——它是另一套机制，且真的救回过答复，没有证据表明 `isRetryable:false` 会让它必然落空。
  · 标记是调度内部的，`attemptErr` 在拼 502 的 `attempts` 前剥掉它：客户端报文里不出现内部记号，
  而失败原因照旧是那个可诊断的 `subType`（`temporarily-unavailable`）。
  · 回归：`test/per-channel-retry-e2e.test.js` §8（跳过）/ §9（**对照组**：同一句软墙但没那句话 → 照旧重试）/ §10（单候选 502 不带记号）。
  · **没实现的部分（诚实说明）**：notion2api 的对应能力点名叫 `getInferenceTranscriptsForUser`（Go 侧 `loadFinalAnswerWithPolling`），
  我们用真实 token 试了 **18 种请求形状**（12 种 POST body 变体 + 6 种 GET 查询串），**全部**被
  `ValidationError: Invalid input.` 拒或返回非 JSON → **请求形状无法确认，因此不实现**：发一个自己验不了的调用，
  等于把"兜底"变成"再多一次失败"。取回走的是上面那条已验证的路径。
  · 回归：`test/notion-refetch-fallback-e2e.test.js`（装配守卫 + 假上游三现场 + 完整首发对照组 + "两次都失败仍如实判失败"）。
- **notion 渠道的内联附件（v1.18.41，渠道级 `notionAttachments`，默认关）**：机制**抄参照实现 notion2api 的实发报文**，
  不是"上传到 S3 再插 attachment step"——CSV 这条用途**不上 S3、不建任务**：
  config step 加 `enableCsvAttachmentSupport: true`（**只在真有文件时加**）+ 把
  `{"file":{"file_data":"data:<mime>;base64,…","filename":"…"},"type":"file"}` 追加到**最后一条 user step** 正文末尾。
  · **默认关，且"默认关"是源码事实**：`notionCollectInlineFiles` 只在 `opts.attachments` 为真时调用，开关也只在真有文件时加 →
    没打开的渠道报文与从前**逐字相同**（回归里有对照组守着）。
  · **只认 base64 的 `data:` URL**（不做任何网络取回）、单文件 ≤1MB、最多 3 个；文件名会被净化（剥路径、删引号/换行/控制字符
    ——脏字符会破坏整条 step 的 JSON）。
  · ✅ **诚实边界已解除（v1.18.42）**：「模型真的读到了文件」**已活体验证** —— 判决实验在 `notionls` 上给出
    **对照答"没找到你上传的 CSV"、带附件答出 `K7Q2M9`**（只存在于 CSV 里的串），并经**本地容器网关** `/v1/chat/completions`
    复验（纯文本「收到」、带内联 CSV 问 secret 列 → 「K7Q2M9」）。**但仍默认关**：这是"稳妥的默认"，不是"没验证过"。
    活体验证的前提是先修好传输层（下一条）。完整证据见 `docs/notion-attachment-upload-research.md` §8。
  · 回归：`test/notion-attachment-inline-e2e.test.js`（含"产物与抓包那一行逐字相同"这条断言）。
- **notion 渠道的出站通道链（v1.18.42，v1.18.43 修正根因，**改 notion 出站前必读**）**：Notion 推理接口会回一道**软墙**——
  HTTP 200 + `{"type":"error","subType":"temporarily-unavailable"}`（通用文案、`isRetryable:false`），反爬式**静默拒绝**。
  **它有两个独立维度**（两个维度给客户端的表象一模一样，只看见一个就会得出"只对一半"的结论）：
  · **维度 ① · 账号状态（主导）**：账号自身在墙里/不在墙里，**与传输无关**，且**随时间变**——
    `notion7` 在**本地与云端、五种传输**下一起软墙（⇒ 墙跟着账号走，不跟 IP 也不跟客户端走），
    而它在云端曾有**短暂开口**（网关连拿两发真答案），几分钟后同渠道 curl 连打 6 发全墙。
    **账号在墙里时换任何传输都没用**，网关如实报 `ok:false / notion: temporarily-unavailable`（多候选则换下一家），
    **不伪装成"200 空回复"**。
  · **维度 ② · 客户端指纹**：只在**账号可过**时才看得见。本地 `notionls` **同一秒内交替**打（C F C F）：
    **curl 3/3 真答、`fetch`/undici 0/3 软墙**——同账号、同 IP、同报文，唯一变量是客户端。
    四个环境对打的原始表格（curl 任何协议都过 / `node:http2` 只在 Node 24 上过 / `fetch` 全被墙）描述的是**这一维**，
    前提是账号当时不在墙里。
  · 因此出站是**通道链**（`notion.js` 的 `notionFetch`）：非 `https:` → 全局 `fetch`（测试假上游，旧行为逐字不变）；
    `https:` → **curl 主** → 判为软墙则 **h2 兜底** → 再不成才 `fetch`。**软墙在通道内自动换**，墙内那一发不消耗真实推理。
    **通道链治维度 ②，治不了维度 ①。**
  · **五条纪律**：① 通道选择只许收口在 `notionFetch` 一处（三处推理调用点都只调它——散开就会出现"某条路留在被墙的通道上"，
    这正是 v1.18.42 之前的形态）；② **别把结论钉在"HTTP/2"上**（它条件成立，主通道必须是 curl）；③ **传输层结论必须在目标
    运行环境复验**（本仓库测试跑 Node 24、镜像跑 `node:20-alpine`，而这道墙恰恰对 Node 版本敏感）；
    ④ **别把通道链说成"notion 一定能用"**（治不了维度 ①）；⑤ **比较两个变量时在同一时间窗内交错打**，
    不要"今天打 A、明天打 B"，并且先确认账号是否可过——那正是三次误判的共同动作。
  · 留档：三次误判（"账号权益被限只能等" / "undici 指纹被 block 故只用 curl" / "Notion 拒绝 HTTP/1.1 故改 h2"）与研究文档 §5–§7.7。
  · **失败行取的是 `subType`，不是 `message`（v1.18.43）**：软墙是**一条**记录、两个字段同时存在——
    `{"type":"error","message":"Something went wrong. Please try again later.","traceId":"…","id":"…","isRetryable":false,"subType":"temporarily-unavailable"}`
    （本地实测原文）。`streamError` 原来优先取 `message`，于是失败行只剩 Notion 那句通用文案、真正可诊断的
    `subType` 反而没进日志；现在**先取 `subType`**（`message` 退化为兜底），失败行写
    `notion stream: temporarily-unavailable`——一眼看出"账号在墙里，等窗口或换账号"。
    这与本仓库的归因纪律一致（v1.18.30 / v1.18.34：失败行必须看得出原因）。
  · 复现仪器：`notion-wall-probe.js`（仓库根，只读，低额度）。
  · 回归：`test/notion-transport.test.js`（本地 h2c 真跑 h2 + 本地 HTTP/1.1 真跑 curl + 通道链与三处调用点装配守卫）；
    维度 ① 下的"如实失败"与"失败行可归因"由 `test/notion-refetch-fallback-e2e.test.js` §6/§8 守着。
- **OpenAI Responses 客户端面（v1.18.38）**：`/v1/responses` 是**第四套客户端报文**，走"入站转 chat → 复用同一条候选链 → 出站转回 `response`"。
  · 为什么不能透传：Responses 报文的对话在 `body.input`、chat 处理器找的是 `body.messages` —— 以前它在 `handleOpenAIRequest` 的 POST 白名单里，等于把 `input` 报文原样塞给 chat 上游（不是 400 就是"200 但空"）。因此这段**绝不设 `clientProto`**（设了就触发同协议直通），且 chat 面与 Responses 面共用 `openAICandidateChain()`。
  · 出站两态：非流式回 `response` 对象（`output[]` / `output_text` / `usage.input_tokens` 口径）；流式回 Responses 的 `event:` + `data:` 事件序列（`response.created` → … → `response.completed`），`finish_reason:"length"` 记 `status:"incomplete"`（**不假装完成**）。
  · 状态边界：`/v1/responses/{id}` 的取回/删除读的是**本进程内存表**（200 条 / 1 小时 / 重启清零），`store:false` 的请求**不落表**、GET 回 404 并说明留存策略（不假装成功）。多实例部署下取回不保证命中。
  · 有损点：`previous_response_id` 不续接（多轮由客户端把历史放进 `input`）、内置工具（`web_search` 等）丢弃、`reasoning` 只给摘要、`allowed_tools` 退成 `auto`。详见 [docs/protocols.md](protocols.md)「OpenAI Responses API」。回归：`test/responses-api-e2e.test.js`。
- **手动测试的流式模式 + 真实流量单独一条欠账（v1.18.40）**：用户点出来的两个真问题——「测试过、真实挂还会再骗你一次」
  与「GET /models 的成功会清掉对话失败计数，熔断永远跳不开死家」。
  · **① `/admin/api/test` 现在能按真实姿势打流式**：真实客户端（DSH 等）走的**就是流式**，而 `/admin/api/test` 历史上
  一律发非流式请求（`max_tokens:512`、不带 `stream`）。上游完全可以"非流式答得好好的、流式那条路是坏的"——
  三种现场：**200 + 流内 `data:{"error":…}`**、**200 + 零正文流**、**干脆无视 `stream:true` 回一整个 JSON**
  （真实流式客户端会拿到"零正文流"）。`body.stream === true` 时按各协议发真正的流式请求
  （openai/anthropic 带 `stream:true`；gemini 走 `:streamGenerateContent?alt=sse`），并**逐块读**（首块到达时刻才是真的 `ttfbMs`）。
  · **判据与真实链路共用同一份帧分类 `classifyStreamFrame`**（v1.18.40 从 `noteStreamLine` 里提出来）——
  所以"测试说好的"与"真实流量判好的"是**同一把尺子**，不会各写一套又漂移。`judgeStreamTest()` 是它的纯函数判定层。
  · **刻意的不一致（要能解释）**：非流式模式下"只有思考、没有可见正文"按 v1.18.29 判**可用**（小预算会这样，判死好渠道是误伤）；
  流式模式下 `finish=length` + 可见正文 0 按 v1.18.28 判**失败**——因为**真实流式流量就是这么判的**。两者的差异是刻意的。
  · **② 两条 streak 分开**：`consecutiveFail` 只数真实客户端流量；`probeFail` 数探测与手动测试。冷却读两者较大者（`effFailStreak`）。
  探测成功与手动测试成功**只**放开冷却、清 `probeFail`、进观察期（`degraded` + `probation`），
  **`consecutiveFail` 一字不动**（v1.18.40 起不再"减半"，也不再"清零"）。真实流量成功的清零入口收敛成**唯一一处** `markTrafficOk()`。
  · **为什么必须这样**：熔断跳开死家**只**靠 `cooldownUntil`，冷却时长按欠账指数增长。旧行为下"探测成功减半 / 测试成功清零"
  意味着**点一次测试**就把死家拉回 1× 退避起步 —— 表现就是"熔断永远跳不开"。测试是可选、手动、且可能只覆盖一条路径的，
  它不是"这家对话能用"的证据。同时**不引入死锁**：半愈合放开了冷却，真实流量照旧会去试它（修好的渠道下一个请求就能满血复活）。
  · 回归：`test/channel-test-stream-and-streak-e2e.test.js`（★ 同一个渠道"非流式测试过、流式测试挂"必须被抓出来 + ★ 真实欠账不被测试/探测成功抹掉）。
- **原生出站（`protocol: anthropic` / `gemini`）**：请求侧 `system`→顶层 `system`/`systemInstruction`、`tool_calls`→`tool_use`/`functionCall`、工具结果→`tool_result`/`functionResponse`（Gemini 按函数名配对）、图片→`image` 块/`inlineData`・`fileData`、`max_tokens`→`max_output_tokens`/`maxOutputTokens`、`stop`→`stop_sequences`/`stopSequences`；响应侧反向映射（`stop_reason`→`finish_reason`、`usageMetadata`→`usage`、`thinking`→`reasoning_content`）。
  · 流式：Anthropic 原生 SSE 事件与 Gemini `alt=sse` 分片都会**逐行翻译成 OpenAI 分片**，再交给该路由既有的流式转换器；上游异常断流时由收尾逻辑补 `finish_reason` + `[DONE]`（客户端不会一直等）。
  · 上游错误体不翻译（原样透传状态码与消息），避免 400 被伪装成"成功但空"。
  · **`max_tokens` 缺省（v1.18.25 由 4096 上调为 8192）**：Anthropic `/v1/messages` 强制要求 `max_tokens`（OpenAI 侧可省略），所以**客户端没给时**网关补一个缺省值，否则上游直接 400。原值 4096 太小：推理型上游把思考 token 算进**同一份预算**，实测 `max_tokens=4096` 时 `reasoning_tokens=4096`、可见正文 **0 字符**、`finish_reason=length`（客户端表现就是"已达到输出 token 上限回答被截断"）。同类网关 sub2api 在 Responses→Anthropic 的缺省也是 8192（其 `apicompat/responses_to_anthropic_request.go`）。**客户端显式带了 `max_tokens` 就一字不改**——这是缺省，不是封顶。
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
