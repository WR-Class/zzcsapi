# AGENTS.md · 项目协作约定

> 本文件是**强约束**。任何 Agent（或人）在本仓库动手之前必须先读，动手之后必须执行 §1。

---

## 1. 【强制】改动必须同步文档

**无论改动来自谁——你、其他 Agent、还是人工——只要动了代码，就必须在同一次改动里更新对应文档。**
不允许"先改代码，文档下次补"。文档与代码不一致，视为改动未完成。

### 1.1 改什么 → 更新哪里

> **前置认知：`console.html` 是构建产物，不是手写文件。**
> 它 = `console-redesign.html` 的 `<style>` 原文 + `build/` 下的 head/shell/extra.css/app.js。
> 改完任何源文件**必须重新 `node build/build.js`**，否则改动不生效、且下次构建会覆盖手改。

| 你改动了 | 必须同步更新 |
| --- | --- |
| `console-redesign.html` 的 `<style>`（视觉：字号 / 留白 / 圆角 / 配色 / 卡片 / 弹窗） | 重新 `node build/build.js`；`docs/frontend-code-map.md`（**行号锚点、索引、修改路由表**）+ `docs/frontend-console-detailed.md`（§2 设计系统、§8 变更日志） |
| `console-redesign.html` 的 JS / markup（原型演示逻辑） | 重新构建（CSS 会带过去）；`docs/frontend-code-map.md` 的行号锚点 + `docs/frontend-console-detailed.md` §8 |
| `build/app.js`（生产数据层 / 交互 / 渲染） | 重新 `node build/build.js`；`docs/frontend-console-detailed.md` §8 变更日志 + 涉及页面/流程的章节；新增函数登记到 `docs/frontend-code-map.md` §0.2 |
| `build/shell.html`（生产 body 骨架） | 重新构建；`docs/frontend-code-map.md` §0.2 结构表 |
| `build/extra.css`（生产独有组件样式） | 重新构建；`docs/frontend-console-detailed.md` §4 组件规范 |
| `build/head.html`（head / 字体 CDN） | 重新构建；`docs/frontend-console-detailed.md` §2.2 |
| `build/build.js`（组装逻辑 / 自检） | `README.md`「前端代码文档」+ `docs/frontend-code-map.md` §0.2 |
| `server.js` 新增/修改端点 | `README.md` 端点总表 + `docs/frontend-console-detailed.md` §7 原型→生产映射表 |
| `server.js` 调度 / 排序 / 优先级算法 | `README.md` §调度顺序（含「有效优先级」公式、生效条件与数据来源字段） |
| 新增/修改渠道协议 | `README.md` 协议说明表 + `console-redesign.html` 的 `PROTO_META`/`PROTO_ORDER` + `build/app.js` 同名字典 + 两份前端文档 |
| 新增文档 | 登记到 `README.md` 的「前端代码文档」章节和本文件 §3 文档索引 |
| 新增配置项 / 环境变量 | `README.md` + `config.example.json` |

### 1.2 ⚠️ 行号锚点会漂移（最容易腐烂的一环）

`docs/frontend-code-map.md` 的核心是**两张行号锚点表**：§1/§3 对应 `console-redesign.html`，§0.2 对应 `build/*`。
你在任一文件里增删任何一行，**它后面所有行号全部失效**。

所以改完源文件后，**必须重新核对代码地图里的行号**，方法：

```powershell
# 重新导出 console-redesign.html 的函数/常量真实行号，与文档逐一比对
Select-String -Path d:\DSHXM\ZZCSAPI\console-redesign.html `
  -Pattern 'function\s+[A-Za-z_$][\w$]*\s*\(|^const (DATA|IC|NAV|PROTO_META|PROTO_ORDER|MODEL_POOL|PROBE_POOL|IMPORT_META|REPLIES)\s*=' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

```powershell
# 重新导出 build/app.js 的函数/常量真实行号（生产侧）
Select-String -Path d:\DSHXM\ZZCSAPI\build\app.js `
  -Pattern '^\s*(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(|^const (IC|NAV|PROTO_META|PROTO_ORDER|OV_RANGE|IMPORT_META|CFG)\s*=' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

```powershell
# 重新导出 CSS 区块行号（console-redesign.html）
Select-String -Path d:\DSHXM\ZZCSAPI\console-redesign.html -Pattern '/\*\s*═+' |
  ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
```

> **换算捷径**（构建是纯拼接，偏移恒定，改完源文件后可用它自查文档里的 `console.html` 行号）：
> - `console.html` 的 CSS 行号 = `console-redesign.html` 行号 **+13**
> - `console.html` 的 JS 行号 = `build/app.js` 行号 **+686**
>
> 偏移只受 `build/head.html`（21 行）/ `build/shell.html`（52 行）/ `build/extra.css`（77 行）/ 设计稿 `<style>` 行数增删影响
> （head/shell 已由 build.js 构建期行数守卫把住；**extra.css 与设计稿 CSS 一旦增删行，JS 偏移必须人工重算**，并同步此处、`build/build.js` 注释与 `docs/frontend-code-map.md` §行号换算）。
> `extra.css` 在拼接序里位于 `app.js` 之前，所以它每增删 1 行，JS 偏移整体 ±1（CSS 偏移不动）——改它的注释前先想清楚要不要多这一行。

若偏移量是整体平移，可以按差值批量修正；若只是局部插入，务必逐个核对，不要凭估算改数字。

### 1.3 改完自检

- [ ] 改了 `console-redesign.html` / `build/*` 后**已重新 `node build/build.js`**，且 `git diff console.html` 里能看到预期变化
- [ ] 受影响的文档已更新，且**不是**只写"已优化"这类空话，而是写明**问题 → 根因 → 处置**
- [ ] 代码地图里的行号已用 §1.2 的命令重新核对
- [ ] 新增的文件/端点/协议已登记到 §1.1 表格涉及的所有位置
- [ ] `docs/frontend-code-map.md` §8「快速自测清单」里相关的项已手工验证

---

## 2. 工程约定

- **字体**：全站统一小米开源 MiSans（可商用），官方 CDN `font.sec.miui.com`，按 `unicode-range` 分片加载。
  MiSans **无等宽变体**，代码块与数值列无法严格等宽对齐，层级一律靠**字重**区分，不要靠字体族切换。
- **配色**：全站暖色系，**明确排除冷色**（青、蓝绿、紫青）。暗色=暖琥珀陶土，亮色=暖锈橙。
- **涨跌配色**：遵循中国股票惯例**红涨绿跌**（`.delta.up` 用 `--err`）。这是刻意反直觉的，不要"顺手修回"欧美惯例。
- **图表**：全部手写内联 SVG，不引入图表库；曲线用独立图表带 + `preserveAspectRatio="none"` 铺满，避免与文字重叠。
- **弹窗**：遮罩**不响应点击关闭**（拖选复制易误关），关闭路径只有 × / 取消 / Esc。
- **布局**：整页不滚动，`.viewport` 是唯一滚动容器。不要用 `min-height: calc(100vh - Npx)` 这类写死横幅高度的写法。
- **密钥与隐私（血泪条款）**：`config.json` / `.env` / `usage.json` / `keys.local.txt` 都是**本机私有文件**（均已 gitignore）。
  它们的**值**（网关 `GATEWAY_KEY` / `ADMIN_KEY`、各渠道上游 `apiKey`、WorkBuddy 的 JWT 与其里的账号邮箱）
  **绝不允许**打印进对话、提交进仓库、写进任何文档或截图。需要把密钥交给用户时，**写进 `keys.local.txt`**
  （已 gitignore）并只回报长度与来源。读这类文件必须显式指定 `-Encoding UTF8`：
  不带编码的 `Get-Content <file> -Raw` 会按本地代码页解码，一旦后续解析报错，PowerShell 会把**整份原文回显**出来
  —— 本仓库真的发生过一次（32 个上游 key + 一个含邮箱的 JWT 进了对话记录）。
- **渲染层转义（v1.18.3 起为硬约束）**：`build/app.js` 里**任何**进入 HTML 的外部可控值都必须过 `esc()`
  ——包括 HTML 文本、属性值（`class`/`data-`/`title`）、以及内联 `onclick` 的参数。
  外部可控的来源至少包括：调用方请求的**模型名**（落进 `/admin/api/usage` 的 `recent[].model`）、上游把模型名回显进错误文案后的
  `recent[].note`、渠道的 `lastError`，以及导入渠道时的 ID/名称。
  `toast()` **自己负责转义**，调用点不要再 `esc()` 一次（会双重转义成 `&amp;`）。
  新增渲染代码后跑 `node test/security-headers-e2e.test.js`：它会拦住任何"裸插值"回潮。
  将来把内联 `onclick` 改成 `data-*` + 事件委托时，同步更新本约束与该用例。

---

## 3. 文档索引

| 文档 | 内容 |
| --- | --- |
| `README.md` | 后端协议、渠道配置、端点总表、部署方式 |
| `docs/frontend-code-map.md` | 前端代码地图：行号锚点、CSS/z-index 全景、JS 索引、数据契约、修改路由表、坑位清单 |
| `docs/frontend-console-detailed.md` | 控制台前端详细设计：设计系统、布局、组件、页面、交互流程、原型→生产映射、变更日志 |
| `docs/arena-protocol.md` | Arena 协议（已撤渠道，留档） |
| `docs/prism-reverse-proxy-research.md` | Prism 反代可行性研究（已撤渠道，留档） |
| `docs/genspark-claw-reverse-proxy-research.md` | Genspark Claw 反代研究 |
| `docs/PONYTAIL_REVIEW.md` | Ponytail 全项目审查：整改项 PT 清单（file:line 证据 + 最小修复 + 最小回归）、已验证非问题、前端独立审查 |
| `docs/gateway-comparison.md` | 同类网关内部机制对比（本项目 vs new-api / one-api / sub2api / CLIProxyAPI）：只比内部机制/性能/全面性，**不比多用户与账户管理**；含本机实测数字（v1.15 → v1.16 的出站与流式写路径）、各家源码级证据与"未找到证据"清单、复现方法 |
| `docs/thinking-replay-design.md` | thinking 回放缓存**设计稿**（v1.18 候选，**已前置验证并判定"现有实现下无收益，暂不实现"**）：一次"先验证再动手"的完整记录——跨协议 thinking/签名保真度地图（逐函数出处）、为什么"客户端回传无签名块触发 400"不可达、唯一会 400 的场景为何回放缓存也治不了、将来重启必须先满足什么。事实的可执行版本是 `test/thinking-fidelity.test.js` |
| `docs/console-settings-spec.md` | 控制台「运行期设置」页（会话粘性 / 客户端限流 / 指标端点开关）**交给前端执行者的实现规格**：`GET/POST /admin/api/settings` 的字段契约（`config` 用户原值 vs `effective` 钳制后生效值——两个都必须显示）、三张卡的结构与文案要点、必须守住的交互细节（只提交有改动的组、跨轮询保留输入、400 原文要显示、**新页必须同时注册进 `go()` 与 `render()` 两张表**）、要改哪些文件与 AGENTS 强制同步清单、可逐条执行的验收清单 |
| `docs/AI工具调用桥接-群友分享版.md` | AI 工具调用桥接说明 |
| `sec-audit.js`（仓库根，非 test/） | **安全体检（只读）**：`node sec-audit.js` 体检本机，`ZZ_BASE=http://host:port` 体检远端，`ZZ_TRY_DEFAULTS=1` 额外试仓库里公开的示例默认密钥。查匿名可达面、默认密钥、控制台版本指纹、安全响应头/CORS、无/错/对三态鉴权覆盖面、密钥泄露面（网关密钥 + 上游 apiKey 会不会从 `/metrics`／管理面／错误体漏出）、路径穿越与私有文件暴露。**报告一律脱敏，绝不回显密钥**；加了密钥才做后三项。改动鉴权、静态文件、响应头或控制台时必跑 |
| `test/console-state.test.js` | 前端自动化回归（`node test/console-state.test.js`，零依赖）：**视口内输入控件的值必须跨轮询重绘保留**；从 `build/app.js` 现抠真实渲染函数在最小 DOM 桩里跑。另含渠道表单**权重**一节（`adapt()` 接 `weight`/`weightedHits`/`weightedShare` → 表格显示「权重 / 分流」→ `saveChannel` 报文带 `weight`、负数与非数字在前端就挡下）与**自动权重观测**一节（`adapt()` 接 `autoH`/`autoFailRate`/`autoSamples`/`autoLatMs`/`autoSpeedRatio` 与 `DATA.auto` → `autoWeightCard()` 画出预测份额与"当前 x%"对照、卡头明示"当前分流一字未动"、单候选/空集给空状态；另有抽屉文案与 `vChannels` 挂载的结构守卫）与**停用渠道的手动测试**一节（在最小 DOM 桩里真跑 `openTestModels`：指定停用渠道必须列得出它自己的模型、只列这一条、带「已停用」标记与"不参与自动探测"说明、运行按钮不灰；全局模式含停用渠道但启用排前；`runTests` 每条带 `channelId` 的结构守卫；对照组证明旧写法下是 0 个模型）与**测试结果可读性**一节（`testRowVerdict` 真值表：有回复=通过、2xx 但空=**空回复**、其余=失败，含"缺 `ok` 字段不当作成功"；在 DOM 桩里**真跑 `runTests`**（桩 HTTP + 桩 `document` + 现抠的真实 `fMs`）断言每行带模型名、渠道显示名、中文结论、三种样式、空回复的原因文案、失败行带 HTTP 码与上游原文、成功行带回复与 token、汇总分三档；并含"旧写法只写渠道名已消失"的对照与 `esc` 结构守卫）与**调用日志渠道名**一节（表头「渠道」紧跟「请求 ID」、渠道格显示渠道显示名而不是 id、按名字/按 id 都能搜、`adapt()` 把显示名解析进 `n` 且保留 `c`；对照组证明"渠道格写 id、排在模型后面"的旧写法抓得住）与**运行期设置**一节（v1.18：在最小 DOM 桩里真跑 `vSettings`/`setPayload`/`saveSettings` —— `config` 回填表单而 `effective` 只作「生效：」角标、有改动后草稿跨 8 秒轮询重绘不被覆盖（含"旧写法无条件覆盖草稿"的对照组）、POST 只发有改动的组/字段且留空数字不下发、400 的 `error` 原文直显进错误条且失败不清脏）与**零数据（全新部署）**一节（v1.18.1，用户报「渠道管理点详情无反应」：在最小 DOM 桩里**真跑 `openChannel`**，零数据与满数据两组都必须不抛、抽屉要真画出来、有数据仍画得出曲线；`areaChart`/`sparkline` 对空数组返回占位图、单点输入不出 `NaN`；含"渲染函数的桩数据必须再跑一遍空的"这条教训与两条结构守卫）。新增带输入框的页面时补用例 |
| `test/gemini-multimodal.test.js` | 后端自动化回归（`node test/gemini-multimodal.test.js`，零依赖）：**图片不得在协议翻译层被静默丢掉**；从 `server.js` 现抠 `geminiToOpenAI` / `anthropicToOpenAI` / `bodyHasImages` / `filterCandidatesForImages` / `checkAuth` 跑断言（含图只留可转图渠道、纯文本零改动、原生 SDK 鉴权头）。新增可转图协议时同步 `IMAGE_CAPABLE_PROTOCOLS` 与本用例 |
| `test/gemini-multimodal-e2e.test.js` | 后端端到端回归（`node test/gemini-multimodal-e2e.test.js`，零依赖）：真起「假上游 + 临时网关实例」走完整 HTTP 链路（**动态空闲端口；配置/用量在系统临时目录，绝不动仓库 `config.json`/`usage.json`**）。改 `tryChannel` / 出站构造 / 鉴权 / 路由候选链时必跑——PT23（非流式 shim 缺 `json()`）就是它抓到的 |
| `test/anthropic-tools.test.js` | 后端自动化回归（`node test/anthropic-tools.test.js`，零依赖）：**工具调用不得在协议翻译层丢件**；从 `server.js` 现抠 `anthropicToOpenAI` / `openAIToAnthropicResponse` / `createAnthropicStreamConverter` / `openAIStreamToAnthropicSSE` / `sanitizeToolId` / `mapFinishReason` 跑断言（tools/tool_choice/none/并行开关、`is_error` 标记、**工具结果里的图片改挂 user 消息**、`tool_use.id` 往返配对、有状态流式的分片累积与幂等收尾）。改工具/多模态转换时必跑 |
| `test/anthropic-tools-e2e.test.js` | 后端端到端回归（`node test/anthropic-tools-e2e.test.js`，零依赖）：**两轮工具回合**真 HTTP 链路——第一轮要工具（上游收到 `function.parameters`/`parallel_tool_calls`，客户端收到 `tool_use`），第二轮把结果送回（上游看到配对的 `tool_call_id`、`[tool_error]`、工具结果图片附带的 user 消息），含流式工具回合与"侧门受图片能力门约束"。改工具转换/路由候选链时必跑 |
| `test/weighted-rr.test.js` | 后端自动化回归（`node test/weighted-rr.test.js`，零依赖）：**权重必须真的决定分流比例**；从 `server.js` 现抠 `pickWeighted` / `applyWeightedPick` / `weightedStats` 与 `SWRR_*` 状态跑断言（3:1→75/25、2:1:1→50/25/25、平滑性不扎堆、冷却/down/weight=0 不进池、**老配置零影响对照**、装配守卫）。改 `channelsServing` 排序 / 权重语义时必跑 |
| `test/weighted-rr-e2e.test.js` | 后端端到端回归（`node test/weighted-rr-e2e.test.js`，零依赖）：真起「两个假上游 + 临时网关」，用 `X-ZZCSAPI-Channel` 数 **40 次请求的真实落点**验证分流比例；含"都不填 weight → 100% 走原来的第一个"的对照、上游持续失败后份额归健康成员、兜底链仍生效。改调度/候选链时必跑 |
| `test/streaming-e2e.test.js` | 后端端到端回归（`node test/streaming-e2e.test.js`，零依赖）：**流式不得丢字节、事件序列必须完整**；快上游（一次送达）与慢上游（分片）两种节奏 × 三条客户端协议，含 OpenAI 路由字节级透传、Anthropic `message_start` 恰好一次 / 文本块只开一次、上游不发 `[DONE]` 时收尾兜底、Gemini 流式动作出站带 `stream:true`。改 `tryChannel` 流式读循环 / `streamPrelude` / `streamEpilogue` / 各协议流式转换时必跑——PT26/PT27/PT28 就是它守住的 |
| `test/native-channels.test.js` | 后端自动化回归（`node test/native-channels.test.js`，零依赖）：**原生 anthropic / gemini 协议渠道的出站必须真的是原生报文**；从 `server.js` 现抠 `oaiRequestToAnthropic` / `anthropicToOaiResponse` / `createAnthropicToOaiStream` / `oaiRequestToGemini` / `geminiToOaiResponse` / `createGeminiToOaiStream` / `nativeOutgoing*` 跑断言（system 提顶层、tool_calls⇄tool_use/functionCall、工具结果图片并回 `tool_result`、`tool_choice` none 的有损处理、图片→image 块/inlineData、角色交替合并、流式分片累积与幂等收尾、URL/鉴权头、**错误体不翻译**）。改原生出站转换时必跑 |
| `test/native-channels-e2e.test.js` | 后端端到端回归（`node test/native-channels-e2e.test.js`，零依赖）：真起「原生 Anthropic 假上游 + 原生 Gemini 假上游 + 临时网关」，**断言上游收到的是原生 URL/鉴权头/报文字段**（不是 OpenAI 格式硬塞），三条客户端路由 × 两种原生渠道（含流式；v1.15 起"同协议"一格改走直通，双转换只在跨协议时发生）、图片与工具调用跨协议、上游 400 原样透传、openai 渠道行为不变的对照。改 `nativeChannelOpts` 注入 / 候选链协议分层 / 图片能力门时必跑 |
| `test/console-weight-e2e.test.js` | 前端+后端端到端回归（`node test/console-weight-e2e.test.js`，零依赖）：把控制台**权重**那条链路串起来——`saveChannel` 真实报文 → 真网关 `POST /admin/api/channels` 落库 → `/admin/api/status` → 控制台 `adapt()`+`drawChTable()` 渲染出的那一格 → 真发 24 次请求让占比动起来（含"权重改 0 后立刻退出池、hits 不再增长"与"负数前端挡下、绕过前端后端也 400"）。改权重语义 / 控制台渠道表格或表单字段时必跑 |
| `test/auto-weight.test.js` | 后端自动化回归（`node test/auto-weight.test.js`，零依赖）：**自动权重（观测版）**；从 `server.js` 现抠 `normAutoWeight` / `capShares` / `pureCandidatesFor` / `autoRawFor` / `autoWeightObserve` 跑断言（旋钮归一化与钳制、样本不足不动、失败率是主力、速度温和惩罚 + 地板、低频/指数平滑/死区抗振荡、份额归一化与单渠道封顶、**手填权重不被上限压制**）。含**静默不变式**：观测跑 100 遍 `SWRR_*` 状态逐字节不变、`pickWeighted` 落点序列一致、不改 `ch.def.weight`；并有装配守卫（`persistConfig` 白名单必须含 `autoWeight`、观测函数体里不许出现 `SWRR_`、**后台节拍只在 `enabled` 时建、周期 = `updateMs`、运行时再兜一次 `enabled` + 异常不外抛、`AUTO_TICKS` 只由节拍累加**）。改观测算法 / 健康系数语义 / 节拍接线时必跑 |
| `test/auto-weight-e2e.test.js` | 后端端到端回归（`node test/auto-weight-e2e.test.js`，零依赖）：真起「假上游 + 临时网关」验证自动权重观测**静默不生效**——预测给出 50/50 时真发 40 次请求仍全部落在候选链第一位、`weightedHits` 恒为 0；真实失败/真实延迟只改预测不改分流（含"失败率没推过死区 → h 按设计冻着"这条抗振荡契约，以及 `share = h_a/(h_a+h_b)` 的自洽比对）；配置往返后 `autoWeight` 旋钮不被 `persistConfig` 抹掉；§5 另起两个实例验证**后台节拍不依赖控制台**（`enabled:false` 跑 3 拍窗口 → `ticks === 0`；`enabled:true` 全程不拉 status → `ticks ≥ 2`，且 `effective` 仍为 false）。改观测接线或调度路径时必跑 |
| `test/upstream-4xx-fallback-e2e.test.js` | 后端端到端回归（`node test/upstream-4xx-fallback-e2e.test.js`，零依赖）：**上游 4xx 不许短路兜底**；从 `server.js` 现抠 `shouldPassThrough4xx` 跑真值表（含装配守卫：5 处判据共用同一函数、渠道侧名单只出现一次、"还有候选"必须排除冷却中的候选），再真起「三个假上游 + 临时网关」验证：404/400 都继续切、连吃两个 400 仍切到第三家、全链 400 时原样透传 400（**不是 502**）、单候选 400 语义不变、401/429 必切。改候选链 / 兜底判据 / `hasMoreCandidates` 语义时必跑 |
| `test/per-channel-retry-e2e.test.js` | 后端端到端回归（`node test/per-channel-retry-e2e.test.js`，零依赖）：**同渠道重试（`retries.perChannel`）**；从 `server.js` 现抠 `isRetryableFailure` 与钳制公式跑真值表（4xx 标记 `channel_error` 不重试、5xx/网络/超时可重试、0/缺省=0、99 钳到 5），再按 `perChannel` 0/1/99 各起一个「两假上游 + 临时网关」验证：抖一下（第 1 次 500、第 2 次成功）被**原地救回且不换下家**、一直 500 时试满才切、每次尝试各记一次失败（`consecutiveFail` 按真实尝试次数长）、4xx 只打一次、键缺失时退回不重试、单候选 502 的 `attempts` 里带 `attempt`。改调度循环 / 失败分类 / `retries` 语义时必跑 |
| `test/gemini-tools.test.js` | 后端自动化回归（`node test/gemini-tools.test.js`，零依赖）：**Gemini 客户端路由的工具调用透传**（PT33）；从 `server.js` 现抠 `geminiToOpenAI` / `openAIToGeminiResponse` / `openAIStreamToGeminiSSE`（配套 `oaiContentBlocks` / `oaiTextOf`）跑断言：`functionDeclarations`→`tools`、`toolConfig.functionCallingConfig` 三态（AUTO/ANY/NONE，ANY+单一白名单强制该函数并收窄工具集，多白名单退化 required 属有损）、`functionCall`→真 `assistant.tool_calls`、`functionResponse`→`role:'tool'` 且 **tool_call_id 与 tool_calls[].id 严格配对**（同名多次调用按 FIFO；**无状态客户端配不上时退回文本而不是硬造 id**）、响应侧 `tool_calls`→`functionCall`（args 解析回对象、半截 JSON 进 `_raw_arguments`）、流式按 index 拆片攒成完整对象且 `functionCall` 帧在 `finishReason` 帧之前、并行 index 各自独立；含**装配守卫**（不再降级文本、三处都真的读了 tool_calls、路由传了跨 chunk 状态）与**仿真兼容性**（直接调 `tool-emu.emulateRequest` 证明 notion/genspark 的工具仿真链"函数名/参数/结果都在且是纯文本"）。改客户端入站转换 / 工具语义 / 流式转换器时必跑 |
| `test/gemini-tools-e2e.test.js` | 后端端到端回归（`node test/gemini-tools-e2e.test.js`，零依赖）：真起「**OpenAI 协议**假上游 + 临时网关」（**动态空闲端口；配置/用量在系统临时目录，绝不动仓库 `config.json`/`usage.json`**），走 `/gemini/v1beta/models/{m}:generateContent` 与 `:streamGenerateContent` 验证完整链路：Gemini 客户端声明 tools → 上游**真的收到** OpenAI `tools`/`tool_choice` → 上游回 `tool_calls` → 客户端拿到 `functionCall`（args 是对象）；第二轮 `functionResponse` → 上游收到 `assistant.tool_calls` + **配对**的 `role:'tool'`；三种 `toolConfig` 一路传到上游；无状态客户端不被硬造孤儿 tool 消息（HTTP 200 + 退化成文本）；流式分片 `tool_calls` 攒成完整 `functionCall` 且在结束帧之前；并含"不带 tools 的普通请求一个字没变"的对照。改 Gemini 路由 / 工具转换 / 流式路径时必跑 |
| `test/same-protocol-passthrough.test.js` | 后端端到端回归（`node test/same-protocol-passthrough.test.js`，零依赖）：**同协议直通**（v1.15，用户要求「Anthropic 客户端 → Anthropic 渠道不做转换，省一层且有损点更少」）；含装配守卫（`passthroughChannelOpts` **不**提供 `translateResponse`/`makeStreamTranslator`、anthropic 只改 `model`、只有 `opts.clientProto === chProto` 才直通、`passthroughChannelOpts` 只在选路处出现两次=探测路径没被牵连、流式不建转换器且不发 prelude/epilogue、非流式原样写回且**跳过** `onSuccessNonStream`、两条路由都传 `clientProto`+`rawClientBody`）；`nativeUsageToOpenAI`（anthropic/gemini 归一、无 usage 返回 null 不编数字）与 `nativeStreamUsageScan`（message_start 的输入 + message_delta 的输出、gemini usageMetadata、`[DONE]`/半截 JSON 不动累积值）真值表；真链路：一个假上游同时扮演三种原生上游 + 临时网关（`ant-native`/`gem-native`/对照 `ant-openai`），断言 Anthropic 客户端发来的 `thinking`/`top_k`/`metadata`/`stop_sequences`/**多段 system**/`cache_control` 原样到达上游、`model` 换成上游名、响应与上游**逐字节一致**（`thinking` 块活着回来、`message_start` 只出现一次、没有网关臆造的 `[DONE]`）、Content-Type 照抄、**真实 token 仍被记录**（11/7、5/3、9/4、2/6）；Gemini 同理（`seed`/`thinkingConfig`/`safetySettings` 原样、URL 用上游模型名、`:streamGenerateContent?alt=sse`）；对照组：OpenAI 渠道仍收到转换后的报文（`system` 提到 `messages[0]`、`top_k` 被丢）且客户端仍拿到 Anthropic 形态响应，证明老路没被弄丢。改协议选路 / 原生出站 / 流式分发时必跑 |
| `test/workbuddy-quota.test.js` | 后端自动化回归（`node test/workbuddy-quota.test.js`，零依赖）：**WorkBuddy 的额度用尽必须看得懂、冷却对齐重置点**（v1.14.1，用户报「复制 auth 文件的 token 后拿不到模型，提示 ✗ workbuddy: non-SSE response」）；含装配守卫（探测侧先 `replace(/^\uFEFF/,'').trim()` 再判 JSON、识别额度文案、`retryAfterMs` 不丢、探测失败交记录层走 `rate_limit`、聊天侧同判据、**密文 token 两处都提前拦**）；`wbQuotaLimited` / `wbQuotaResetMs`（**UTC+8 → UTC 的换算逐毫秒核对**：04:27 → 10:00:39 恰为 5h33m39s；UTC 无偏移、过去时刻返回 0、抠不到返回 0）/ `wbOpaqueBodyMsg`（HTTP 码 + 响应开头，空响应体也有说明）/ `wbEncryptedKeyHint`（真实 envelope 结构认得、裸 envelope 串认得、JWT 与空值不误报）真值表；§2 起是**真链路**（假 WorkBuddy 上游 + 临时网关，curl 直连本地）：真实 429 `code:6004` 文案（**故意以换行开头**，旧代码就是栽在这）→ 探测报出上游原文而非 non-SSE、`cooldownUntil` 与上游重置时刻误差 < 90s、`lastError` 保留原文、冷却期间客户端拿到 503 且**带原因与恢复时长**；HTML 挑战页 → 错误里看得见 HTTP 码与响应开头；密文 token → 探测前就拒绝；§5 混合场景（另起一个 openai 假上游：探测正常、聊天 500）验证**被冷却跳过的候选在 502 的 `attempts[]` 里也带"为什么 + 还有多久"**且没被真发请求；对照组：token 正常时探测通过、冷却清零、真聊天拿到 `pong`、上游收到强制流式的 OpenAI 报文（39 项断言）。改 WorkBuddy 探测/出站/失败分类/冷却语义时必跑 |
| `test/genspark-tools.test.js` | 后端自动化回归（`node test/genspark-tools.test.js`，零依赖）：**Genspark 网页会话反代的工具调用**（v1.14，用户报「反代无法调用工具」）；该上游静默忽略原生 `tools`，故走文本仿真。含装配守卫（`tryGensparkChannel` 请求侧 `toolEmu.emulateRequest`、送上游前经 `gensparkMessagesFor` 折掉 system、响应侧 `parseEmulatedToolCalls`、非流式 `openaiToolCallsPayload` + usage、流式 `tool_calls` 分片 + `finish_reason:'tool_calls'`、无工具时行为不变、头部注释已改正）；`gensparkMessagesFor` 真值表（system 折进**首条 user**、多 system 合并、仅 system 时补 user、数组 content 取文本、无 system 原样返回）；仿真往返（注入含工具名 → 解析标记 → 载荷形状 → 工具结果回灌）。§3 起是**真链路**：临时网关把 `baseUrl` 指向不存在的主机 `http://genspark.invalid`、`proxy` 指向本地假「上游兼 HTTP 代理」，于是真 curl 必须走代理 → 断言客户端**真拿到 `tool_calls`**（名字/参数/finish_reason/正文剥离/真实 usage）、上游收到仿真协议且**无 system 角色**、模型名按 aliasMap 翻译、第二轮工具结果被渲染进上下文；另有流式分片与「不带 tools」「`tool_choice:'none'`」两组对照。改 genspark 请求组装 / 工具仿真 / 出站角色约束时必跑 |
| `test/disabled-channel-manual-test-e2e.test.js` | 后端端到端回归（`node test/disabled-channel-manual-test-e2e.test.js`，零依赖）：**停用渠道「能手动测、不被自动测」**（v1.13）；含装配守卫（`probeAll` 默认按 `enabled` 过滤、启动与定时器两处调用不带参数、手动「全部重探测」显式 `includeDisabled:true`、重探测结果带 `enabled`、`/admin/api/test` 带 `channelId` 时不看 enabled、控制台 `openTestModels` 不再无条件跳过停用渠道）与真链路：真起「两个假上游 + 临时网关」（`health.intervalSec:1`）验证**自动探测只打启用渠道、停用渠道 0 次**；`/admin/api/test` 带停用渠道 id **真打通**（上游收到一发 chat、模型名按 aliasMap 翻译、测通不启用它、其别名不进 `/v1/models`）；`/admin/api/recheck` 不带 id 与带 id 都把停用渠道探一遍；对照：停用渠道独有模型发真实请求一次都不落到它。改探测目标集合 / 启停语义 / 测试端点 / 控制台测试弹窗时必跑 |
| `test/cooldown-grading-e2e.test.js` | 后端端到端回归（`node test/cooldown-grading-e2e.test.js`，零依赖）：**熔断冷却分级 + 探测半愈合**；从 `server.js` 现抠 `cooldownMsFor` / `failureKindFromStatus` / `retryAfterMsFromHeaders` / `healAfterProbe` 与 `healthy()` 分层跑真值表（瞬时 `base*2^(n-1)` 与封顶、凭证类分钟级起步、限流、Retry-After 覆盖且受硬上限约束、半愈合"减半不清零 + 进观察期 + 保留 lastError"、真实对话成功才满血），含**装配守卫**（旧公式 0 残留、冷却只此一处、探测成功路径不许自己清零、分层用 `probation` 而不是 `status='degraded'`、观察期不进加权池）；再真起「两假上游 + 临时网关」验证：5xx 冷却 = 配置起步值、连败涨到上限并转 `down`、401 走分钟级、429 听 `Retry-After`、`/admin/recheck` 后**观察期让出首发**、真实成功后恢复首发、**空模型列表 ≠ 观察期**。改冷却/排序/探测回血逻辑时必跑 |
| `test/outbound-http-client.test.js` | 后端端到端回归（`node test/outbound-http-client.test.js`，零依赖）：**出站长连接客户端 + 流式写路径**（v1.16）；含装配守卫（`server.js` 里不再出现裸 `fetch(`、6 个出站调用点全走 `zzFetch`、notion/notion-agent 的 11 处实参与后台 `fetchFn` 也换成它、Agent 必须 `keepAlive`、直通流式是 `res.write(u8)` 而不是按行拼串、`handleLine` 里已无直通分支、旁路 usage 扫描仍在、非直通只 push 且只有一处 `res.write(outChunks.join(''))`）；再对**真 HTTP 服务**跑 `zzFetch` 的 fetch 形状真值表（`status`/`ok`、`headers.get` 大小写不敏感与多头 `", "` 连接、缺头返回 `null`、`text()` 可重复调用、`json()`、gzip 自动解压、307 保留 POST 与体 / 302 退化成 GET 且**撤掉上一跳的 Content-Length**、POST 无体补 `Content-Length: 0`、`Accept-Encoding: identity`、`body.getReader()` 逐片且读完 `done`、`signal` 中止抛 `AbortError`、**20 次请求 0 条新 TCP 连接**并含 `agent:false` 建 20 条的对照组）；最后真链路验证**直通流式逐字节一致**（上游用 CRLF 分隔、且把一帧劈到两个 TCP 片上 → 客户端收到的字节与上游 `Buffer.equals` 相等、CRLF 未被归一、写入次数不超过上游分片数），以及字节直传的同时真实 usage 仍记录（11/7）。改出站客户端 / `tryChannel` 流式分发 / 直通字节路径时必跑 |
| `test/session-affinity-e2e.test.js` | 后端端到端回归（`node test/session-affinity-e2e.test.js`，零依赖）：**会话粘性**（v1.17，默认关闭）；含装配守卫（粘性只在 `dispatchRequest` 里改顺序、**只改"谁是第一位"**、成功路径才 `affinityLearn`、三处聊天路由都传键而图片路由不传、粘性代码里不许出现 `SWRR_`、不许写 `cooldownUntil`/`probation`/`consecutiveFail`、不许调 `recordFailure`/`persistConfig`、`persistConfig` 白名单含 `sessionAffinity`）；键推导真值表（现抠真实源码：关闭恒为空、四个显式头都认且头优先于正文、长度下限 8 与截断 160、`prompt_cache_key`/`session_id`/`conversation_id`、**刻意不认 `metadata.user_id`**（账号级 id 会把整个账号钉死在一家）、`deriveFromBody` 的稳定哈希与内容区分、短内容不哈希、ttlSec/maxEntries 钳制）；学习/命中/过期/淘汰语义（命中计数、过期懒清理、超限淘汰最旧）；排序语义（命中且可上场→提到链首且其余相对顺序不变、冷却/down/不在候选里→一动不动、已在链首不计数）；真链路：**同一会话 8 次请求落同一家**、粘性命中时 `weightedShare` 仍报 ≈50/50（证明没有污染加权份额统计）、上游 500 后切到另一家并**重新粘住**、不同会话各占一条；对照：关闭时表恒为 0 条（零状态）且老观测不受影响。改协议选路顺序 / 调度核心 / `persistConfig` 白名单时必跑 |
| `test/rate-limit-e2e.test.js` | 后端端到端回归（`node test/rate-limit-e2e.test.js`，零依赖）：**客户端限流**（v1.17，默认关闭）；含装配守卫（闸门在客户端路由分支**之前**、在管理面分支之后、只覆盖 `/v1/`+`/anthropic/`+`/gemini/`、429 必带 `Retry-After`、并发额度在 `finish` 与 `close` 两条路都归还且 `settled` 幂等、计数在鉴权之前、按整机分桶（不做 per-IP）、`persistConfig` 白名单含 `rateLimit`）；令牌桶真值表（现抠真实源码：关闭恒放行且零计数、桶容量=burst、超限给 ≥1 秒 `Retry-After`、按时间补充令牌且不超桶容量、`rpm:0` 只限并发、并发上限拒绝带 `concurrent:true`、释放后可再进、多释放不会变负数、负数/非数字旋钮钳到 0（不会变 NaN 拒绝一切）、未填 `burst` 时桶容量=rpm）；真链路（`rpm:60/burst:1`：第 1 发 200、第 2 发 429 且错误体写着上限、等回填后又能过；`maxConcurrent:1` + 慢上游：并行两发恰好一发 200 一发 429 且原因写着**并发上限**、结束后在飞数归零、峰值被记下；`/healthz` 与管理面**不受**客户端限流影响）；对照：周期与并发都填极小值但关闭 → 8 发全过且零拒绝计数。改网关入口 / 鉴权顺序 / `persistConfig` 白名单时必跑 |
| `test/metrics-e2e.test.js` | 后端端到端回归（`node test/metrics-e2e.test.js`，零依赖）：**`/metrics` 指标端点**（v1.17，Prometheus 文本格式、零依赖）；含装配守卫（`/metrics` 在客户端面分支之前、在管理面之后、默认要 admin key 只有 `metrics.public:true` 才匿名、`enabled:false` → 404、`Content-Type: text/plain; version=0.0.4`、渠道记账**只在 `recordUsage` 一处收口**（不与用量统计分叉）、请求计数在 finish/close 各记一次、渠道分档 gauge 五档齐全、`persistConfig` 白名单含 `metrics`、`renderMetrics` 是纯读函数）；标签转义真值表（现抠 `metricLabel`：引号/反斜杠/换行必须转义——一行脏标签就能让整个抓取失败、中文原样透传）；真链路（不带/错密钥 401、带 admin key 200、**正文里绝不出现 GATEWAY_KEY/ADMIN_KEY**、所有数据行都符合 `name{labels} value` 且每个指标都有 HELP+TYPE、发真流量后 requests_total / channel_requests_total（含 ok="false"）/ channel_tokens_total（真实 usage 7/3×2）/ latency sum+count 都在动、401 也进 requests_total（被挡流量不隐形）、渠道分档之和 = 渠道总数、停用渠道单独计 disabled、粘性 gauge 随请求增长、限流事件三态齐全）；`public:true` 匿名可抓且仍无密钥；`enabled:false` → 404。改端点鉴权 / 指标口径 / 记账收口时必跑 |
| `test/thinking-fidelity.test.js` | 后端自动化回归（`node test/thinking-fidelity.test.js`，零依赖）：**thinking / 签名 的保真度地图**（v1.18 前置验证，结论：不做回放缓存）。含 9 条**源码级装配守卫**（`server.js` 里 `signature` 出现 0 次；入站"刻意丢弃 thinking"的注释还在、且没有把 thinking 文本塞进 content 的代码；→ Anthropic 客户端两个转换器与 → 原生 Anthropic 出站转换器里都没有 thinking/reasoning；原生 Anthropic 上游响应侧与流式侧确实把 thinking 文本搬进 `reasoning_content`；签名的唯一活路是 v1.15 同协议直通）与 6 组纯函数真值表（现抠真实函数跑：跨协议入站 thinking/redacted_thinking/签名三者全部静默丢弃且不影响 tool_use 与 tool_result 配对；上游响应侧文本留、签名丢、usage 不动；流式 `thinking_delta`→`reasoning_content`；出站**不产出** thinking 块、内部字段名不外泄；→ 客户端非流式与流式都**不产出** thinking 块、**绝不伪造签名**）。**如果哪天真的实现了 thinking 回放，本用例会失败——请连同 `docs/thinking-replay-design.md` 一起更新，而不是删断言。** |
| `test/settings-api-e2e.test.js` | 后端端到端回归（`node test/settings-api-e2e.test.js`，零依赖）：**运行期设置端点 `GET/POST /admin/api/settings`**（v1.18，给控制台开关面板用的窄口）。含装配守卫（端点在 `handleAdminApi` 里、管理面统一 `checkAuth(admin)`、只认三组白名单、未知字段/类型不符/空报文一律 400、PATCH 合并语义、**启动路径与保存路径共用同一份 `norm*`**、保存后 `applyRuntimeSettings()` → `persistConfig()`、三组仍在 `persistConfig` 白名单里）；`normAffinityCfg`/`normRateCfg`/`normMetricsCfg` 钳制真值表（现抠真实源码：`ttlSec` 下限 30 / 上限 7 天、`maxEntries` [16,100000]、`burst` 缺省=rpm、负数与非法值钳到 0、布尔只认严格 `true`、`/metrics` 默认开）；真链路（假上游 + 临时网关）：不带密钥 401、GET 三段结构、7 种非法报文各 400 且不落库、**打开限流不重启即第 2 发 429 且带 `Retry-After`**、PATCH 只改一个字段别的不归零、打开粘性后同会话三次落同一家且 status 里 `hits` 在涨、`ttlSec=5` 时 config 保留 5 / effective 显示 30、关掉 `/metrics` 立即 404 再开立即 200、落库后**重启仍是这个值**、重启后普通请求照常 200。改这三组开关的字段语义 / 钳制规则 / `persistConfig` 白名单时必跑 |
| `test/security-headers-e2e.test.js` | 后端端到端回归（`node test/security-headers-e2e.test.js`，零依赖）：**第一批安全加固**（v1.18.3，外部黑盒渗透测试报告 F-03 / F-05 的整改护栏）。含源码级装配守卫（`build/app.js` 里 11 个"裸插值"必须一个不剩——`toast(...)` 调用点除外因为它内部转义、`toast` 必须 `esc(msg)`、`data-t` 必须 `JSON.stringify`+`esc`、`esc()` 必须覆盖 `& < > " '`、`SEC_HEADERS` 必须定义在 `createServer` 之前**且 `setHeader` 在所有分支之前**、CSP 不得被偷偷加上）；真链路（临时网关）逐条核头：`/console`、`/healthz`、`/admin/api/status`（200 与 401 两态）、`/metrics`、`/v1/models`、404 全部带齐 `nosniff`/`DENY`/`no-referrer`/`Permissions-Policy`，`/healthz` 与 `/admin/api/*` 带 `no-store`，`/console` 壳里零密钥明文且缓存策略不被新头破坏，产物里能看到 `esc(l.m)`/`esc(c.name)`。**新增任何渲染代码或再加响应头时必跑**；把内联 `onclick` 改成事件委托后，本用例的"裸插值"清单要同步更新 |
