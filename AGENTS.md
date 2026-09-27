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
> - `console.html` 的 JS 行号 = `build/app.js` 行号 **+617**
>
> 偏移只受 `build/head.html`（21 行）/ `build/shell.html`（52 行）/ `build/extra.css`（8 行）增删行影响
> （head/shell 已由 build.js 构建期行数守卫把住，extra.css 改动仍需人工重算偏移并同步此处）。

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
| `docs/AI工具调用桥接-群友分享版.md` | AI 工具调用桥接说明 |
| `test/console-state.test.js` | 前端自动化回归（`node test/console-state.test.js`，零依赖）：**视口内输入控件的值必须跨轮询重绘保留**；从 `build/app.js` 现抠真实渲染函数在最小 DOM 桩里跑。另含渠道表单**权重**一节（`adapt()` 接 `weight`/`weightedHits`/`weightedShare` → 表格显示「权重 / 分流」→ `saveChannel` 报文带 `weight`、负数与非数字在前端就挡下）。新增带输入框的页面时补用例 |
| `test/gemini-multimodal.test.js` | 后端自动化回归（`node test/gemini-multimodal.test.js`，零依赖）：**图片不得在协议翻译层被静默丢掉**；从 `server.js` 现抠 `geminiToOpenAI` / `anthropicToOpenAI` / `bodyHasImages` / `filterCandidatesForImages` / `checkAuth` 跑断言（含图只留可转图渠道、纯文本零改动、原生 SDK 鉴权头）。新增可转图协议时同步 `IMAGE_CAPABLE_PROTOCOLS` 与本用例 |
| `test/gemini-multimodal-e2e.test.js` | 后端端到端回归（`node test/gemini-multimodal-e2e.test.js`，零依赖）：真起「假上游 + 临时网关实例」走完整 HTTP 链路（**动态空闲端口；配置/用量在系统临时目录，绝不动仓库 `config.json`/`usage.json`**）。改 `tryChannel` / 出站构造 / 鉴权 / 路由候选链时必跑——PT23（非流式 shim 缺 `json()`）就是它抓到的 |
| `test/anthropic-tools.test.js` | 后端自动化回归（`node test/anthropic-tools.test.js`，零依赖）：**工具调用不得在协议翻译层丢件**；从 `server.js` 现抠 `anthropicToOpenAI` / `openAIToAnthropicResponse` / `createAnthropicStreamConverter` / `openAIStreamToAnthropicSSE` / `sanitizeToolId` / `mapFinishReason` 跑断言（tools/tool_choice/none/并行开关、`is_error` 标记、**工具结果里的图片改挂 user 消息**、`tool_use.id` 往返配对、有状态流式的分片累积与幂等收尾）。改工具/多模态转换时必跑 |
| `test/anthropic-tools-e2e.test.js` | 后端端到端回归（`node test/anthropic-tools-e2e.test.js`，零依赖）：**两轮工具回合**真 HTTP 链路——第一轮要工具（上游收到 `function.parameters`/`parallel_tool_calls`，客户端收到 `tool_use`），第二轮把结果送回（上游看到配对的 `tool_call_id`、`[tool_error]`、工具结果图片附带的 user 消息），含流式工具回合与"侧门受图片能力门约束"。改工具转换/路由候选链时必跑 |
| `test/weighted-rr.test.js` | 后端自动化回归（`node test/weighted-rr.test.js`，零依赖）：**权重必须真的决定分流比例**；从 `server.js` 现抠 `pickWeighted` / `applyWeightedPick` / `weightedStats` 与 `SWRR_*` 状态跑断言（3:1→75/25、2:1:1→50/25/25、平滑性不扎堆、冷却/down/weight=0 不进池、**老配置零影响对照**、装配守卫）。改 `channelsServing` 排序 / 权重语义时必跑 |
| `test/weighted-rr-e2e.test.js` | 后端端到端回归（`node test/weighted-rr-e2e.test.js`，零依赖）：真起「两个假上游 + 临时网关」，用 `X-ZZCSAPI-Channel` 数 **40 次请求的真实落点**验证分流比例；含"都不填 weight → 100% 走原来的第一个"的对照、上游持续失败后份额归健康成员、兜底链仍生效。改调度/候选链时必跑 |
| `test/streaming-e2e.test.js` | 后端端到端回归（`node test/streaming-e2e.test.js`，零依赖）：**流式不得丢字节、事件序列必须完整**；快上游（一次送达）与慢上游（分片）两种节奏 × 三条客户端协议，含 OpenAI 路由字节级透传、Anthropic `message_start` 恰好一次 / 文本块只开一次、上游不发 `[DONE]` 时收尾兜底、Gemini 流式动作出站带 `stream:true`。改 `tryChannel` 流式读循环 / `streamPrelude` / `streamEpilogue` / 各协议流式转换时必跑——PT26/PT27/PT28 就是它守住的 |
| `test/native-channels.test.js` | 后端自动化回归（`node test/native-channels.test.js`，零依赖）：**原生 anthropic / gemini 协议渠道的出站必须真的是原生报文**；从 `server.js` 现抠 `oaiRequestToAnthropic` / `anthropicToOaiResponse` / `createAnthropicToOaiStream` / `oaiRequestToGemini` / `geminiToOaiResponse` / `createGeminiToOaiStream` / `nativeOutgoing*` 跑断言（system 提顶层、tool_calls⇄tool_use/functionCall、工具结果图片并回 `tool_result`、`tool_choice` none 的有损处理、图片→image 块/inlineData、角色交替合并、流式分片累积与幂等收尾、URL/鉴权头、**错误体不翻译**）。改原生出站转换时必跑 |
| `test/native-channels-e2e.test.js` | 后端端到端回归（`node test/native-channels-e2e.test.js`，零依赖）：真起「原生 Anthropic 假上游 + 原生 Gemini 假上游 + 临时网关」，**断言上游收到的是原生 URL/鉴权头/报文字段**（不是 OpenAI 格式硬塞），三条客户端路由 × 两种原生渠道（含流式与双重转换）、图片与工具调用跨协议、上游 400 原样透传、openai 渠道行为不变的对照。改 `nativeChannelOpts` 注入 / 候选链协议分层 / 图片能力门时必跑 |
| `test/console-weight-e2e.test.js` | 前端+后端端到端回归（`node test/console-weight-e2e.test.js`，零依赖）：把控制台**权重**那条链路串起来——`saveChannel` 真实报文 → 真网关 `POST /admin/api/channels` 落库 → `/admin/api/status` → 控制台 `adapt()`+`drawChTable()` 渲染出的那一格 → 真发 24 次请求让占比动起来（含"权重改 0 后立刻退出池、hits 不再增长"与"负数前端挡下、绕过前端后端也 400"）。改权重语义 / 控制台渠道表格或表单字段时必跑 |
