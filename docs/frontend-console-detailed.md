# 控制台前端 · 详细设计文档

> 对象文件：
> - `console-redesign.html` —— **视觉唯一真源**，新版控制台的高保真静态原型（单文件、零依赖，双击即可打开）
> - `build/head.html` · `build/shell.html` · `build/extra.css` · `build/app.js` —— 生产适配层（骨架 / 生产独有样式 / 真实数据与交互）
> - `console.html` —— **构建产物**（`node build/build.js` 生成），现役生产控制台，真实请求 `/admin/api/*`
>
> 快速定位请用 [frontend-code-map.md](./frontend-code-map.md)；本文讲**为什么这么写**和**怎么继续扩展**。
> 定稿版本：v0.5（2026-09-25）

---

## ⚠️ 维护约定（强制）

**本文档与代码必须同进同出。** 任何人（含其他 Agent）改动代码后，必须在同一次改动里：

1. **重新构建** —— 改了 `console-redesign.html` 或 `build/*` 后必须 `node build/build.js`。忘了构建 = 改动没生效，而且下次构建会覆盖手改的 `console.html`。
2. **在 §8 变更日志追加一行** —— 格式固定为「问题 → 根因 → 处置」，不接受"已优化"这类空话。
3. **同步受影响的章节** —— 改了配色/字体/布局就更新 §2 §3，改了组件样式就更新 §4，改了页面或弹窗流程就更新 §5 §6。
4. **改了接口就更新 §7** —— `server.js` 端点变动必须反映到「原型 → 生产」映射表，并同步 `README.md` 端点总表。
5. **代码地图同步** —— 按 [frontend-code-map.md](./frontend-code-map.md) 顶部的约定核对行号锚点（原型锚点 + `build/app.js` 锚点）。

完整规则见仓库根目录 [`AGENTS.md`](../AGENTS.md)。**文档与代码不一致，视为改动未完成。**

---

## 1. 定位与边界

| 项 | 说明 |
| --- | --- |
| 是什么 | 新版控制台的**高保真静态原型**，用于确定视觉与交互方案 |
| 不是什么 | **不连后端**。没有 `fetch`、没有 WebSocket、没有鉴权，数据来自文件内 `DATA` 常量 |
| 与 `console.html` 的关系 | 后者是**构建产物**：取本文件的 `<style>` 原文 + `build/` 下的适配层拼成。**因此视觉逐字节一致，变量名也完全一致**（不存在映射表） |
| 原型 JS 的去向 | 原型的 JS（`DATA` / 假动作 / 渲染）**不参与构建**。生产逻辑是独立重写的 `build/app.js`，对接真实接口 |
| 技术栈 | 原生 HTML + CSS + JS，无框架、无打包、无外部 JS 库 |
| 图表 | **全部手写内联 SVG**（`areaChart` / `sparkline` / `donut`），不引入 ECharts 等 |
| 字体 | MiSans（小米开源、可商用），官方 CDN 按 `unicode-range` 分片加载 |

---

## 2. 设计系统

### 2.1 主题变量（CSS 自定义属性）

两套主题共用**同一套变量名**，只换值：`html[data-theme="dark"]`（22–41）、`html[data-theme="light"]`（42–61）。
切换由 `setTheme()` 改 `<html data-theme>` 完成，变量级联全站生效，**不需要给任何组件写主题特例**。

变量分组：

```
背景    --bg --bg-2
面板    --panel --panel-2 --panel-3        （三层递进：容器 / 次级 / 悬浮）
描边    --line --line-2 --line-3
文字    --tx --tx-2 --tx-3                 （主 / 次 / 弱）
强调    --accent --accent-ink --accent-soft --accent-line --accent-2
语义    --ok --warn --err --info --violet  + 各自 -soft 底色
氛围    --grid --hair --noise
阴影    --sh-1 --sh-2 --sh-3
遮罩    --scrim
```

**配色取向：全站暖色系，明确排除冷色。**

- 暗色：中性色偏暖炭/棕（`--bg:#0e0c0a`），强调色为**暖琥珀陶土** `--accent:#e39a4e`
- 亮色：中性色偏米/暖纸（`--bg:#f8f5f0`），强调色为**暖锈橙** `--accent:#b1500f`

> 历史背景：初版暗色主题用柠檬绿作强调色，被判定为冷色系不合要求，已整体替换为暖色。
> **后续新增颜色时，请保持色相在暖区（红/橙/琥珀/棕），不要再引入青、蓝绿、紫青。**

### 2.2 字体与排版层级

```css
--f-ui     MiSans, PingFang SC, Microsoft YaHei, Hiragino Sans GB, system-ui
--f-mono   MiSans, PingFang SC, Microsoft YaHei, ui-monospace, Cascadia Code, Consolas
--f-serif  MiSans, PingFang SC, Songti SC, Georgia
```

MiSans **没有等宽变体，也没有真正的衬线变体**，因此三个变量实际都落到 MiSans。
层级不再依赖字体族切换，改为：

| 层级 | 字重 | 用途 |
| --- | --- | --- |
| 展示 | `--fw-display:700` | 页面标题 `.page-title`(34px)、KPI 大数字 `.kpi-val`(40px) |
| 副标题 | 600 | 卡片标题 `.card-hd h3`、抽屉标题 |
| 标签 | 500 | `.rail-item`、`.btn`、`.cell-name` |
| 辅助 | 400 | 正文、`.help` |

其他排版约定：

- `.micro` / `.sec-title` / 表头：10px、`letter-spacing:.1em`、`text-transform:uppercase` —— 全站统一"小字大写 + 宽字距"的标签风格
- 数字：`font-variant-numeric:tabular-nums`（`body` 全局 + `.mono` + `.num`），缓解 MiSans 比例数字造成的列不对齐
- **已知限制**：代码块与数值列**无法做到严格等宽对齐**，这是字体本身的限制，不要试图用 `font-family:monospace` 绕开（会被 MiSans 覆盖且视觉不一致）

### 2.3 视觉语言

- **氛围层**：三层固定背景 `.bg-grid`（54px 网格 + 径向遮罩淡出）、`.bg-glow`（左上/右下两团强调色光晕）、`.bg-noise`（SVG 噪声，`opacity` 由 `--noise` 控制）
- **圆角**：`--r-xs:4 --r-sm:7 --r-md:10 --r-lg:14`
- **缓动**：`--ease:cubic-bezier(.32,.72,0,1)`，全站过渡统一用它
- **动效**：`fade`（页面/菜单入场）、`rise`（toast）、`sweep`（进度条）；`.stagger > *` 用 `nth-child` 做 0.02s 步进的入场错峰
- **无障碍**：`@media(prefers-reduced-motion:reduce)` 关闭全部动画与过渡；`:focus-visible` 统一 2px 强调色轮廓

---

## 3. 布局骨架

```
body (flex column, 不滚动)
├── .bg-layer ×3                背景氛围（fixed, z 0）
├── .proto                      原型横幅（z 2，可关闭）
└── .app (flex 1 1 auto, min-height 0)
    ├── .rail                   侧栏 248px（内部 .rail-nav 滚动）
    └── .main (flex column)
        ├── .topbar             sticky 顶栏（面包屑 / 全局搜索 / 重探测）
        └── .viewport (flex 1, overflow-y auto)   ← 唯一滚动容器
```

**高度链是这套布局的核心**，也是本轮修掉"底部空白"的关键：

```css
body      { display:flex; flex-direction:column }        /* 65–73 */
.app      { flex:1 1 auto; min-height:0 }                /* 114   */
.main     { flex:1; min-width:0; min-height:0; display:flex; flex-direction:column }  /* 147 */
.viewport { flex:1; min-width:0; min-height:0; overflow-y:auto }                        /* 171 */
```

> 旧写法是 `.app{min-height:calc(100vh - 30px)}`——**写死了横幅高度**，横幅一旦换行/关闭就会出现底部空白。
> 现改为弹性链：横幅多高都自动扣减，侧栏高度恒等于剩余视口高度。
> **改布局时不要退回 `100vh - Npx` 这类写法。**

**滚动策略**：整页不滚动，`.rail-nav` 与 `.viewport` 各自内部滚动。
因此 `element.scrollIntoView()` 在切页时无效，`go()` 里必须显式 `v.scrollTop=0`（1219–1223 有注释说明）。

**响应式断点**：

| 断点 | 行为 |
| --- | --- |
| ≤1320px | `.g4` 降为两列；`.c4/.c5/.c7/.c8` 全部占满 12 列 |
| ≤900px | `.g4` 单列；`.rail` 隐藏 |
| ≤1180px | Playground 双栏 `.pg` 降为单栏 |

---

## 4. 组件规范

### 4.1 按钮 `.btn`

`默认`（描边+面板底）→ `.primary`（强调色实底）→ `.ghost`（无边框，表格行内用）→ `.danger`（红描边，删除）→ `.sm`（紧凑，表格操作列）。
`[disabled]` 统一 `opacity:.45; pointer-events:none`。

### 4.2 页签 `.tabs / .tab`

分段控件。`.on` 态用 `--panel-3` + 顶部高光 `--hair`。数字徽标 `.n` 在选中态变强调色。

### 4.3 状态表达（三件套）

| 组件 | 用途 | 关键点 |
| --- | --- | --- |
| `.chip` | 协议标签 | 每个协议一种配色（`.chip.openai` 蓝 / `.anthropic` 黄 / `.gemini` 紫 / `.workbuddy` 琥珀 / `.notion` 中性 / `.notion-agent` 绿 / `.genspark` 紫 / `.codex` 绿） |
| `.pill` + `.dot` | 健康状态 | `ok` 绿 / `degraded` 黄 / `down` 红 / `unknown` 灰；`dot` 带 `box-shadow` 光环 |
| `.delta` | 涨跌 | **红涨绿跌**（见 §5.2） |
| `.tag` | 中性元信息 | 延迟、优先级等 |

### 4.4 表格 `table.tbl`

- 表头 `position:sticky; top:0`（在 `.viewport` 内吸顶），小字大写宽字距
- 行 `tr.clickable` 整行可点；行内按钮必须 `event.stopPropagation()`，否则会连带触发行点击（1407/1418–1420 均如此）
- 成功率用 `.proto-bar` 内嵌细进度条，颜色阈值：>90% 绿、>70% 黄、否则红
- `.cell-main` = 头像 + 名称 + 副标题的标准信息格

### 4.5 KPI 卡 `.kpi`

```
┌ 顶部 1px 渐变高光（::after）
│ 标签（micro）
│ 大数字 40px/700 + 单位
│ 涨跌 delta + 说明
└ .kpi-spark  ← 曲线独占底部一条 46px 图表带，与文字彻底分离
```

> **重要设计决策**：初版把 sparkline 绝对定位在卡片里，曲线会与文字重叠、影响阅读。
> 现改为**独立图表带**：`.kpi` 用 flex 纵向排列，`.kpi-spark` 靠 `margin:auto -18px 0` 顶到底部，
> 内部 SVG 用 `preserveAspectRatio="none"` 拉伸铺满整宽。**不要再改回绝对定位。**

### 4.6 弹窗 `.mask / .modal`

- 容器 `#mask`（z 80）+ `#modalBox`，由 `modal(html, wide)` 注入内容
- 结构约定：`.m-hd`（图标 + 标题 + 右上 ×）/ `.m-bd`（可滚动主体）/ `.m-ft`（按钮区）
- 宽度：默认 `min(620px,100%)`，`.wide` 为 `min(760px,100%)`；最大高度 `calc(100vh - 48px)`
- **遮罩不响应点击关闭**（`#mask` 刻意不绑 `onclick`）：拖选复制文本时鼠标容易滑出弹窗，误触会打断操作。
  关闭路径仅三条：右上角 ×、取消按钮、`Esc`
- 表单栅格用 `.field-row > .field`，窄屏自动换行
- **生产侧对应实现**：`build/shell.html` 里只有**一个** `#mask`（49 行），内容由 `modal(html, wide)` 动态注入——
  渠道表单、四类导入、测试模型、模型编辑器全部复用这一个容器。
  `#mask` **不绑 `onclick`**，与原型策略一致；`Esc` 由 `build/app.js` 1817 的全局 `keydown` 监听兜底
  （优先关弹窗，其次关抽屉）。
  > 早期版本曾有 `#codex-mask` / `#gs-mask` / `#test-mask` / `#dmask` 四个独立弹窗，重构时已统一收敛掉。
  > **新增弹窗不要再建新 `.mask`**，直接用 `modal()` 注入。

### 4.7 抽屉 `.scrim / .drawer`

右侧滑出，宽度 `min(560px,94vw)`，`.scrim` 点遮罩可关闭（与弹窗策略不同，因为抽屉是"看详情"不是"填表单"）。
渠道详情、模型详情、日志详情**共用同一个 `drawer(html)`**。

### 4.8 下拉菜单 `.menu-wrap / .menu`

- 打开：`toggleMenu(id)`；点击菜单外部关闭（全局 click 监听 1944）
- 触发按钮必须 `event.stopPropagation()`，否则会被全局监听立刻关掉
- **必须让祖先容器有定位与层级**：`.page-hd` 设了 `position:relative; z-index:5`。
  原因：`.page` 的 `fade` 动画生成了层叠上下文，若不定位，整块头部（含菜单）会被后面的 `.card` 盖住——这是本轮修掉的真实 bug。

### 4.9 Toast `.toasts / .toast`

底部居中浮动，`toast(msg,'ok')` 加绿色描边，2.2s 后淡出移除。

---

## 5. 页面详解

### 5.1 总览 `vOverview`（1241）

- 4 张 KPI 卡：累计请求 / 成功率 / 平均延迟 / Token 消耗，各带独立曲线带
- 请求趋势大图（`areaChart`，20 天）+ 峰值/日均 chip
- 渠道健康环形图 `donut` + 图例（正常 23 / 降级 1 / 不可用 6）
- Top 渠道表、Top 模型条形榜
- 时间范围页签 `24h / 7d / 30d`
  - **原型**：仅切换选中样式，不切换数据（快照里只有日粒度）
  - **生产**：**真实切换**。`OV_RANGE`（`build/app.js` 387）定义三档 → `ovSeries()`（390）按档取序列：
    24 小时走后端 `usage.hourly`（24 桶），7/30 天走 `DATA.trend.slice(-N)`；KPI 环比窗口同步跟着天数走
- **延迟环比 `avgLatencyDelta()`（375）**：取最近 200 条成功日志，前一半当「本期」、后一半当「上期」算变化率；
  **样本 < 40 返回 `null`**——宁可不显示，也不编一个假百分比

### 5.2 涨跌颜色（中国股票惯例）

```css
.delta.up  { color:var(--err); background:var(--err-soft) }  /* 涨 = 红 */
.delta.down{ color:var(--ok);  background:var(--ok-soft)  }  /* 跌 = 绿 */
```

> 与欧美惯例相反，**这是需求方明确要求的**。同时移除了原本的 ↑/↓ 箭头——
> 方向已由 `+/-` 符号和颜色双重表达，再加箭头是三重冗余（`kpiCard` 1234 行有注释留档）。

**生产侧零差异**：`build/app.js` 不重定义任何涨跌样式，直接吃设计稿这条规则。
它只负责算数值与方向：`dChip(v, unit, suffix)`（371）产出带符号的文本，`kpiCard({dir:'up'|'down'})`（320）产出 `.delta.up` / `.delta.down` 类名。
（旧版的 `deltaBadge(delta, invert)` 已随重构删除——`invert` 会把"好/坏"折算成颜色，与"方向即颜色"的规则冲突。）

**改这里时别顺手改回欧美惯例**，见 `AGENTS.md` §2。

### 5.3 渠道管理 `vChannels`（1351）

- 工具栏：导入（四项下拉）/ 测试模型 / 添加渠道
- 筛选：全部 / 已启用 / 已停用 页签 + 名称·ID·协议搜索框
- 表格列：启用开关 / 渠道 / 协议 / 状态 / 延迟 / 模型数 / 优先级（自动降权时附「→ 有效 X」角标，悬停见失败率与回升说明）/ 请求·错误 / 成功率 / 操作
- 操作列：**测试 / 编辑 / 详情**（三个都要 `stopPropagation`）
- 排序（1397）：「全部」页签下**已启用优先**，同组内按优先级、请求量降序

**渠道详情抽屉 `openChannel`（1432）**：
顶部标签行（状态 / 延迟 / 优先级〔自动降权时显示「→ 有效 X（失败率 Y%）」角标〕/ 启停）→
接入配置（Base URL / 密钥掩码+明文切换+复制 / 协议 / 模型数）→ 近 7 天表现三宫格 + 曲线 → 模型别名 chips
→ 底部动作：测试模型 / 重探测 / 编辑 / 启停 / 删除

**启停 `toggleCh`（1426）**：就地改 `DATA`，toast 明确提示"原型演示，不会写入 config.json"。

### 5.4 聚合模型 `vModels`（1512）

- 协议筛选页签 + 搜索
- 排序（1565）：**仍有启用渠道的模型排前面**，仅剩停用渠道的模型整体降透明度（`opacity:.62`）并标"来源已停用"
- 状态列：稳定 / 有失败 / 来源已停用
- 点击行打开模型详情抽屉：按实际选中顺序展示调度优先级

### 5.5 调用日志 `vLogs`（1622）

请求列表（时间 / 模型 / 渠道 / 协议 / 状态 / 耗时 / token）+ 详情抽屉 `openLog`（1666）。

### 5.6 Playground `vPlayground`（1711）

左对话区 + 右参数栏（模型、temperature、top_p 等）。

- **原型**：`pgSend`（1795）模拟流式输出——逐字/逐块插入 → 结束补 usage，**无真实请求**，仅演示交互
- **生产**：`pgSend`（`build/app.js` 1074）**真发 `POST /v1/chat/completions`**，与外部客户端走完全同一条链路：
  - 支持 `stream`：读 `response.body.getReader()` 解析 SSE，逐块追加；记录**首块延迟 TTFB**
  - 从响应头 `X-ZZCSAPI-Channel` 取实际命中渠道 → `drawRoute()` 渲染路由信息（候选渠道 / 命中 / 首块 / 总耗时）
  - 失败时把上游错误原文显示在气泡里，不吞错

### 5.7 接入信息 `vAccess`（1852）

三套协议（OpenAI / Anthropic / Gemini）的 baseURL、密钥、示例代码，代码片段用 `.code` + 页签切换（1922）。

- **原型**：地址与密钥是文件内写死的演示值
- **生产**：`vAccess`（`build/app.js` 1189）从 `GET /admin/api/config` 取**真实**网关地址、`gatewayKey`、模型名，
  按当前 `location.origin` 拼端点 URL；`showKeyHelp()`（`build/app.js` 1283）给**只读**的密钥轮换步骤（每条命令可单独复制）；
  端点地址行与客户端配置表 Base URL 列均带复制按钮

---

## 6. 交互流程

### 6.1 添加 / 编辑渠道 `openChannelForm(id)`（1993）

```
openChannelForm()        新增：清空表单，协议默认 openai
openChannelForm(id)      编辑：回填，id 字段 disabled
  ├─ 基础信息   渠道ID / 显示名 / 协议 / 优先级 / 启用
  ├─ 连接信息   Base URL（随协议切换默认值）/ 代理 / 密钥（掩码↔明文）
  ├─ 模型别名   renderModelRows 渲染 alias→upstream 双列，可增删、可单行测试
  └─ 上游探测   probeUpstream → renderProbeList
```

**上游探测列表**（本轮重做，替代原来的 chip 逐个点击）：

- 面板 `.probe-panel`：搜索框 + 可滚动列表（`max-height:212px`）+ 底部计数与批量按钮
- 已存在的别名行标 `.have`（半透明 + 不可勾选），避免重复添加
- 支持**搜索过滤** `filterProbeRows`、**全选** `probeSelectAll`、**清空** `probeClearSel`、**批量加入** `probeAddSelected`
- **原型**：`probeUpstream`（2085）从 `PROBE_POOL`（1961，约 46 个模型）取数，贴近真实中转站规模
- **生产**：`probeUpstream`（`build/app.js` 1443）真发 `POST /admin/api/probe`，
  返回的是**该渠道上游真实的 `/v1/models` 清单**；搜索/全选/批量逻辑与原型同构。
  ⚠️ 注意 `server.js` 的探测协议白名单——曾漏 `workbuddy` 导致误报失败

### 6.2 导入（四类）

`IMPORT_META`（2208）驱动同一套弹窗骨架，`mode` 决定形态：

| kind | 名称 | 形态 | 要点 |
| --- | --- | --- | --- |
| `codex-rt` | 导入 Codex RT | 粘贴 | 校验必须以 `rt.1.` 开头；提示 RT 一次性轮转 |
| `codex-json` | 导入 Codex JSON | 文件（多选） | 兼容扁平 / `credentials` / `accounts[]` 三种结构 |
| `gs-session` | 导入 Genspark 会话 | 粘贴 | 正则提取 `uuid:hex`；提示 session 约 20 天过期 |
| `gs-json` | 导入 Genspark JSON | 文件（多选） | 同 key 视为刷新，不重复建渠道 |

- 粘贴式 `doImport`：分步状态动画（换令牌 → 拿账号 → 拉模型 → 建渠道）
- 文件式 `importFiles`：逐个文件解析，逐行输出成功/失败结果与原因
- 解析容错集中在 `parseCodexUnits`（2226）与 `parseGsSessionId`（2234），**改动务必保留多结构兼容**

**生产侧（`build/app.js`）**：`IMPORT_META` 在 1569，弹窗骨架与原型同构，但**去掉了假步骤动画**，改为真实请求：

| kind | 生产函数 | 真实端点 |
| --- | --- | --- |
| `codex-rt` / `codex-json` | `importCodexRt(rt)` 1637 | `POST /admin/api/codex-import` |
| `gs-session` / `gs-json` | `importGsSession(raw)` 1642 | `POST /admin/api/genspark-import` |

- `doImport` 1648 / `importFiles` 1668 都直接转发给上面两个函数，逐条回填真实结果
- 原型的 `hash(s)`（2290，造假渠道 ID）**生产侧已删除**
- 解析容错逻辑与原型一致（同样的 `parseCodexUnits` / `parseGsSessionId`），改一处要两处同步

### 6.3 测试模型 `openTestModels(opts)`（2342）

- 支持 `{channelId}` 预筛（从渠道行/抽屉进入时只显示该渠道的模型）
- 分组多选列表 `.test-list`（分组头 sticky）+ 提示词输入
- `runTests`（2388）逐条执行：先插"等待"行 → 出结果 → 替换为成功/失败行 → 汇总"x/y 通过"

- **原型**：`simTest`（2329）按渠道状态与历史失败率**伪造**成功或失败（停用/不可用 → 502；失败率≥50% → 429），
  回复文案取自 `REPLIES`（2328）
- **生产**：`runTests`（`build/app.js` 1778）改为真实 `POST /admin/api/test`（body `{model, channelId, prompt}`），
  逐条渲染真实 `latencyMs` / `promptTokens` / `completionTokens` / 上游回复或错误原文。
  原型的 `simTest` 与 `REPLIES` **生产侧已删除**；跑完会 `loadAll()` 刷新一次数据

### 6.4 全局交互

| 交互 | 实现 |
| --- | --- |
| `Esc` | 有弹窗先关弹窗，否则关抽屉（2420） |
| `Cmd/Ctrl + K` | 聚焦全局搜索框 |
| 全局搜索回车 | 关键词写入 `chQ` 并跳转渠道页（2434） |
| 主题切换 | `#themeBtn`，写入 `localStorage['zzcs-theme']`，刷新保持 |
| 点击菜单外部 | 关闭所有下拉菜单（1944） |
| 复制按钮 | 统一走 `copyText(t,btn)`（`build/app.js` 221）：安全上下文用 `navigator.clipboard`，否则回落到 `execCommand('copy')`；待复制文本一律经 `data-t="${esc(x)}"` 注入，不要用 `JSON.stringify` 直接拼进属性 |

---

## 7. 与后端对接（原型 → 生产）

原型中每个"假动作"对应的真实接口（详见 `server.js` 与 `console.html`）：

| 原型 | 生产接口 | 备注 |
| --- | --- | --- |
| `DATA` 常量 | `GET /admin/api/status` | 渠道状态、用量、探测时间 |
| `toggleCh` / `saveChannel` / `delChannel` | `POST /admin/api/channel`（局部改）/ `POST /admin/api/channels`（upsert）/ `DELETE /admin/api/channels` | 启停·优先级走前者，增改走 upsert，删除带 `{id}` |
| `reprobe` / 全量重探测 | `POST /admin/api/recheck` | body 可带 `{id}` |
| `probeUpstream` | `POST /admin/api/probe` | 注意协议白名单（曾漏 `workbuddy` 导致误报） |
| `simTest` / `runTests` | `POST /admin/api/test` | 需覆盖各协议分支 |
| `doImport` / `importFiles`(codex) | `POST /admin/api/codex-import` | RT 全自动建渠道 |
| `doImport` / `importFiles`(genspark) | `POST /admin/api/genspark-import` | 提取 `sessionId` 换 key；`mode:'add'` 一会话一渠道 |
| 用量明细 / 清零 | `GET /admin/api/usage` · `POST /admin/api/usage/clear` | 总用量 / 按模型 / 按渠道 / 按天 / 24h 分布 |
| `pgSend` | `POST /v1/chat/completions` | 支持 `stream` |
| Playground 生图 | `POST /v1/images/generations` | 需上游支持图像接口 |

**回填时的注意事项**：

1. `fakeKey()` / `maskKey()` 是原型专用，真实密钥来自后端，**必须删除假密钥逻辑**
2. 密钥明文显示是敏感操作，回填时保持"默认掩码 + 手动切换 + 可复制"的交互，不要默认明文
3. 鉴权头：`Authorization: Bearer <ADMIN_KEY>`；`?key=` 收进浏览器本地后脱敏 URL（v1.0 起：记忆升为 localStorage + 无密钥时弹登录门，见 §8.10）
4. `DATA` 就地修改的模式不能沿用——真实环境应改为"请求 → 更新本地 state → 重绘"

> **回填状态（v0.4，v0.5 续修）**：以上四项均已满足。
> 生产侧用 `chKey(id)`（`build/app.js` 1344）从真实渠道对象取密钥，**没有任何假密钥逻辑**；
> `DATA` 改由 `adapt()`（58）从 `/admin/api/status` 响应派生，`loadAll()`（120）统一拉取后重绘。
> 生产独有能力（genspark 双导入、渠道级自定义请求头、密钥明文切换、有效优先级角标、
> 真实 Playground / 测试 / 导入请求、端点地址与密钥一键复制、只读的密钥轮换步骤弹窗）原型里没有，**原型不必追平**。
> v0.5 补了复制链路的两个坑（属性注入被截断、非安全上下文下 `navigator.clipboard` 静默失效），见 §8.5。

---

## 8. 变更日志

### 8.1 v0.1 原型定稿（2026-09-25，对象 `console-redesign.html`）

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 模型管理"导入"下拉被下方卡片遮挡 | `.page` 的 `fade` 动画生成层叠上下文，`.page-hd` 未定位导致层级低于 `.card` | `.page-hd` 加 `position:relative; z-index:5` |
| 2 | 模型列表未优先展示启用项 | 无排序逻辑 | `drawMTable` 加"启用渠道优先"排序，停用来源降透明度 |
| 3 | 暗色模式呈冷色（绿） | 强调色用柠檬绿 | 两套主题变量整体改暖色系（暗=暖琥珀，亮=暖锈橙） |
| 4 | 涨跌颜色不符合中国习惯 | 沿用欧美绿涨红跌 | `.delta.up/.down` 交换颜色变量，实现**红涨绿跌** |
| 5 | 涨跌同时显示箭头与 `+/-` | 三重冗余 | 移除箭头，仅保留符号 + 颜色 |
| 6 | 渠道健康处 "CHANNELS" 未汉化 | SVG 内硬编码英文 | 改为"渠道总数" |
| 7 | 上游模型逐个 chip 点击、模型多时难找 | 交互形态不适配大数据量 | 改为**列表式 + 搜索 + 全选/清空 + 批量加入**，面板限高可滚动 |
| 8 | 弹窗点击非弹窗区域即关闭，复制时易误关 | `#mask` 绑定了点击关闭 | 移除遮罩点击关闭，仅保留 × / 取消 / Esc |
| 9 | 页面底部异常空白 | `.app` 用 `min-height:calc(100vh - 30px)` 写死横幅高度 | 改弹性高度链（`body` flex → `.app flex:1` → `.viewport overflow`） |
| 10 | KPI 卡曲线与文字重叠 | sparkline 绝对定位 | 改为卡片底部**独立图表带**，`preserveAspectRatio="none"` 铺满 |
| 11 | 全站字体不统一 | 混用 IBM Plex Sans/Mono/Instrument Serif | 统一 MiSans，层级改由**字重**区分 |
| 12 | 静态占位 markup 与实时渲染不一致 | 改 UI 时漏改 body 里的占位 | 同步工具栏（四项导入下拉）、表格行（补"编辑"）、抽屉（补编辑/删除/密钥明文切换） |

### 8.2 v0.2 生产回填（2026-09-25，对象 `console.html`）

把 v0.1 的视觉与交互真正落到现役生产控制台（此前只改了原型，生产仍是旧冷色系）。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 生产控制台仍是旧 slate 冷色系，与定稿原型两张皮 | v0.1 只改了原型，生产 `console.html` 未回填 | 整体替换 `<style>`：暖色双主题 + MiSans + 渐变强调，**变量名沿用旧命名**（见 §11），markup/JS 的 `var()` 引用零改动 |
| 2 | 生产全站字体是 IBM Plex / 系统等宽，与原型不一致 | 同上 | head 引入 MiSans 官方 CDN（`unicode-range` 分片），`--mono` 也指向 MiSans |
| 3 | 生产弹窗点遮罩就关，复制密钥/粘贴 JSON 时频繁误关 | 4 个 `.mask` 弹窗都绑了 `onclick` 遮罩关闭；且生产**没有任何 Esc 处理** | 摘除 4 处遮罩关闭；新增全局 `keydown` 监听实现 Esc 关闭最上层弹窗 / 抽屉 |
| 4 | 生产涨跌是欧美惯例（涨绿跌红）且带 ↑↓ 箭头 | `deltaBadge(delta, invert)` 会把"好坏"折算成颜色，与"方向即颜色"冲突 | 改为 `deltaBadge(delta)`：去掉箭头与 `invert`，`.delta.up` 绑 `--red`、`.delta.down` 绑 `--green` |
| 5 | 生产 KPI 卡曲线与文字重叠、箭头与 `+/-` 冗余 | 同原型 v0.1 的第 10、5 条，生产未同步 | KPI 卡改为「值 / 脚注 / 独立曲线带」三段结构，曲线用 `preserveAspectRatio="none"` 铺满 |
| 6 | 生产导航点击后页面不滚到顶部 | 用了 `window.scrollTo`，但真实滚动容器是 `.content` | 改 `$('.content').scrollTop = 0` |
| 7 | genspark 导入弹窗的大文本框字体仍是硬编码等宽 | 回填时漏改一处内联 `font-family:ui-monospace,monospace` | 改为 `var(--mono)`，与全站字体一致 |

> 校验方式：静态检查（类名/ID 全覆盖、JS 语法）+ 重建镜像后浏览器实测（6 页渲染、主题切换、真实数据、弹窗三条关闭路径、console 零报错）。

### 8.3 v0.3 生产新增能力（2026-09-25，对象 `console.html` + `server.js`）

原型没有、只存在于生产的两项能力。**原型不必追平**，但改生产时要知道它们的存在（清单同步登记在 [frontend-code-map.md](./frontend-code-map.md) §0.2）。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | Genspark 网页会话无法接入：上游没有 `/models`、鉴权是 cookie 且**必须走代理**，通用 OpenAI 分支全链路不通 | 缺 `genspark` 协议分支，探测与调度都落到通用 `fetch` | `server.js` 新增 `genspark` 协议（`gensparkCookie/Headers/BuildPayload/ParseSSE` + `tryGensparkChannel`），探测走免费的 `GET /api/is_login`；控制台加协议选项、Base URL 默认值、**代理必填提示**，以及「导入 genspark 会话（粘贴）/ 导入 genspark JSON（多选批量，`mode:'add'` 一会话一渠道）」两个入口 + 导入弹窗 |
| 2 | 渠道"连续失败"只影响熔断，配置的 `priority` 无法反映近期真实健康度，坏渠道只要 priority 高就永远先被选中 | 排序直接用 `ch.def.priority`，失败只累加 `consecutiveFail` 触发冷却 | `server.js` 加滚动窗口健康分（`bumpRoll` / `rollFailRate` / `effPriority`，样本 ≥5 生效、120 次减半衰减），`channelsServing` 改用有效优先级；`/admin/api/status` 下发 `effectivePriority` / `rollFailRate`，控制台渠道卡在降权时显示 `→ 有效 X（失败率 Y%）` 角标 |

### 8.4 v0.4 与设计稿完全对齐 + 构建管线化（2026-09-25，对象 `console-redesign.html` + `build/*`）

用户反馈"真实项目和设计不一样，大小、留白、卡片样式很多都不同"，要求**完全对齐**。本轮放弃"两份文件手工同步"的做法，
改为**以设计稿为唯一视觉源、生产页由构建生成**，并顺手把生产侧剩下的假动作全部换成真实请求。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 生产页与设计稿尺寸/留白/卡片形态处处不同，手工"回填"永远追不平 | 生产是**另一份手写文件**，CSS 是原型的移植改写版，两边各自演化 | 建 `build/build.js`：生产 CSS 改为**逐字节复制设计稿 `<style>` 原文**，只把生产独有组件补在 `build/extra.css`。视觉从此不可能漂移 |
| 2 | 生产的页面骨架是旧的 `.side + .main > .content`，与设计稿的 `.app > .rail + .main > .viewport > .page` 不同源 | 同上 | 生产骨架重写为设计稿结构（`build/shell.html`），滚动容器由 `.content` 改为 `.viewport`，切页滚动重置跟着改 |
| 3 | 生产渠道页是**卡片墙**（`.ch-grid` / `.ch`），设计稿是**表格**（`table.tbl`） | 历史实现差异 | 渠道页改为表格形态，与设计稿一致（列：启用 / 渠道 / 协议 / 状态 / 延迟 / 模型数 / 优先级 / 请求·错误 / 成功率 / 操作） |
| 4 | 生产与原型**变量名不同**（`--indigo` / `--red` / `--card`…），改配色要改两处、看文档要查映射表 | 早期回填时为省事沿用旧 token | 生产直接复用设计稿 CSS ⇒ **变量名两边完全一致**，映射表作废（原 §11.2 已删除） |
| 5 | 生产页 CSS 大面积失效：样式规则变成页面正文文本 | 构建 banner 注释里写了 `</style>` 字面量；HTML 解析 `<style>` 是裸文本模式，**注释里出现结束标签也会立刻闭合元素** | banner 去掉该字面量，并加**构建期自检**：产物中 `</style>` 必须恰好 1 次，否则抛错 |
| 6 | Playground 只演示、不发真实请求 | `pgSend` 是假流式（`setTimeout` 逐块插入） | 重写为真实 `POST /v1/chat/completions`（支持 `stream`，读 `getReader()` 解析 SSE），从 `X-ZZCSAPI-Channel` 响应头取命中渠道并渲染路由信息 |
| 7 | 测试模型是随机结果 | `simTest` 按渠道状态伪造成功/失败，回复取自 `REPLIES` | 删除 `simTest` / `REPLIES`，改 `runTests` 真调 `POST /admin/api/test`，渲染真实延迟与 token 数 |
| 8 | 导入流程是假步骤动画 + `hash()` 造 ID | `doImport` 只跑动画不落库 | 删除假步骤与 `hash()`，改 `importCodexRt` / `importGsSession` 真调 `codex-import` / `genspark-import` |
| 9 | 接入信息页写死网关地址与假密钥 | 硬编码演示值 | 改从 `GET /admin/api/config` 取真实 `gatewayKey` / 端口 / 模型名，按 `location.origin` 拼端点；补 `showKeyHelp()` |
| 10 | 函数名误导：`fakeKey()` 在生产返回的其实是真实密钥 | 从原型抄名未改 | 重命名为 `chKey(id)`，同步所有引用 |
| 11 | 总览时间范围页签只切样式、不切数据 | 原型快照只有日粒度 | 生产实现 `OV_RANGE` + `ovSeries()`：24h 走后端 `usage.hourly`（24 桶），7/30 天走 `trend.slice(-N)`；KPI 环比窗口跟着走 |
| 12 | 总览 X 轴标签显示成 `09-04,635`（日期和数值粘连） | 直接插值 `${dt}`，而 `trend` 元素是 `['MM-DD', 请求数]` 数组 | 改为 `${Array.isArray(dt)?dt[0]:dt}`，只取日期部分 |
| 13 | 首屏 `Cannot read property 'v' of undefined` | `vOverview` 直接读 `DATA.donut[0].v`，初始 `donut` 为空数组 | 改为 `(DATA.donut[0]||{}).v||0` |
| 14 | 浏览器缓存导致部署后仍看到旧页面 | 未设缓存头 | 服务器侧 `Cache-Control: no-store`；调试时用随机查询参数绕过 |
| 15 | 生产弹窗收敛 | 曾有 4 个独立 `.mask` + 1 个 `#dmask`，与设计稿的单容器模式不一致 | 统一为**单个 `#mask` + `modal()` 注入**，与设计稿同构；`Esc` 仍由全局 `keydown` 兜底 |

> 校验方式：`build/build.js` 构建期自检 + 静态检查（类名/ID 全覆盖、JS 语法、引用完整性）+ 构建产物行号核对
> （CSS +13 / JS +648）+ 浏览器实测（6 页渲染、主题切换、时间范围切换、真实测试/导入/Playground、弹窗三条关闭路径）。
> 另用探针脚本 `_probe.js` / `_cmp_skel.js` 对设计稿与生产页做几何与计算样式的自动比对，
> 结果：骨架 6 页全部一致，无实质样式差异（剩余差异均为数据量/文案驱动的噪声）。

### 8.5 v0.5 表格对齐与复制链路修复（2026-09-25，对象 `console-redesign.html` + `build/app.js`）

用户实测反馈：日志表右对齐列错位、接入信息页复制按钮点了没反应、「去设置」点开却是不可编辑的内容。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 所有表格的「耗时 / 输入 / 输出」等右对齐列，**表头与下面的数值不在同一竖轴上**，看着像错位 | `table.tbl thead th{text-align:left}` 权重 (0,1,3) 压过 `.t-r` (0,1,0)，`th` 上的 `.t-r` 从来就没生效过 | 原型 300 行补 `table.tbl thead th.t-r{text-align:right}`；**与 `.t-r` 并排写在同一行**，避免增行导致后面所有原型锚点整体漂移。生产 CSS 逐字节复制，一次修好全部表格 |
| 2 | 接入信息页「复制全部」和 `GATEWAY_KEY` 的复制按钮**点了完全没反应** | `onclick="copyText(${JSON.stringify(key)},this)"` 把 `"` 塞进了双引号属性里，属性被截断，事件压根没绑上 | 全部改成 `data-t="${esc(x)}" onclick="copyText(this.dataset.t,this)"`（`esc` 会把 `"` 转成 `&quot;`） |
| 3 | 用**局域网 IP 走 http** 打开控制台时，页面上所有复制按钮都静默失效 | `navigator.clipboard` 只在安全上下文（https / localhost）存在；可选链 `?.` 会把整条链短路成 `undefined`——**既不复制也不报错** | `copyText` 增加 `document.execCommand('copy')` 兜底（临时 textarea + select），成功/失败都给 toast |
| 4 | 接入信息页只有密钥能复制，三套协议地址和客户端 Base URL 要手敲 | 缺复制入口 | 端点卡地址行、客户端配置表 Base URL 列各加复制按钮 |
| 5 | 安全提示的「去设置」点开是一段只读说明，容易被误解成"能在这里改密钥" | 按钮文案承诺了"设置"，弹窗却是一整块不可编辑文本，也没有"只读"的明示 | 按钮改「查看轮换步骤」；弹窗加「只读」角标 + 明确写"由服务端环境变量下发，**本页只能看，改不了**，需在宿主机执行"；三步拆成独立代码块、各自可复制（密钥确实只能由环境变量下发，控制台不写配置——这点没变，只是把话说清楚） |

> 校验方式：`node --check build/app.js` + `node build/build.js` 自检 + 构建产物行号核对（CSS +13 / JS +648 均保持）
> + 浏览器实测（日志表表头与数值对齐、接入信息四类复制按钮、安全提示弹窗）。

### 8.6 v0.6 有效优先级角标补齐（2026-09-25，对象 `build/app.js` + 产物 `console.html`）

复核 v0.2–v0.5 变更时发现：README「生产独有能力」清单与 §8.3#2 处置列都承诺了「有效优先级角标」，但生产渲染层从未落地——
`/admin/api/status` 下发的 `effectivePriority` / `rollFailRate` 在数据层映射为 `eff` / `fail` 后**没有任何消费方**，
渠道表格与详情抽屉只显示静态 `pri`。文档写了、代码没做，属于"文档与代码不一致"。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 渠道表格「优先级」列只显示静态配置值，自动降权（`server.js` `effPriority`）不可见 | v0.4 表格化重写时未把 §8.3#2 的角标移植进 `drawChTable` 行模板 | 优先级单元格内联追加角标：`fail>0 且 eff≠pri` 时显示 `→ 有效值`（失败率 ≥50% 用 `--err`、以下用 `--warn`），`title` 悬停说明失败率与"恢复后自动回升"机制 |
| 2 | 详情抽屉顶部「优先级」标签同样只显示静态值 | 同上（`openChannel` 标签行） | 同款角标追加进 `openChannel` 的优先级 tag，展示完整形态 `→ 有效 X（失败率 Y%）` |

> 两处均为**单行内联改写、不增行**（沿用 §8.5#1 的同行技巧），`frontend-code-map.md` §0.2 的 `app.js` 行号锚点不受影响。
> 校验方式：`node --check build/app.js` + `node build/build.js` 自检（产物含角标标记 ×2）+ 容器重建后
> `GET /console` 实测角标代码在位 + `healthz` 30 渠道正常。

---

### 8.7 v0.7 PT01/PT03 整改：arena 协议整体移除 + 信任边界修复 + 死代码清理（2026-09-27，对象 `server.js` + `build/*` + 产物 `console.html`）

依据 `docs/PONYTAIL_REVIEW.md`（PT01/PT03/PT05/PT06/PT07 + 前端独立审查的清理类发现），一次提交内完成「删」字当头的整改。
行号换算偏移随之变化：JS 偏移 **+648 → +617**（extra.css 38→8 行），CSS 偏移 +13 不变；`AGENTS.md` §1.2 与 code-map §0.1 已同步。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | **PT03**：arena 渠道从未反代成功，chromium/nss/freetype/harfbuzz/ttf-freefont 全家桶 + `--experimental-websocket` 却全部打进镜像（1.31GB） | arena.js 逆向方案保留在主干，但实际无 arena 渠道配置 | 全链路移除：`arena.js` 删除（`tool-emu.js` 保留——notion/notion-agent 工具仿真仍用）、`server.js` 去掉 arena 分支/兜底/`/admin/api/arena-cookie` 端点/协议白名单（4218→3675 行）、Dockerfile 撤 chromium 全家桶与 flag（镜像 **1.31GB→203MB**）、`console-redesign.html`/`build/app.js` 的 `PROTO_META`/`PROTO_ORDER`/`protoLabel`/`.chip.arena` 同步删除、README 协议表改「已撤，留档」、`docs/arena-protocol.md` 留档 |
| 2 | **PT01**：compose 端口绑 0.0.0.0 + `ZZCSAPI_NOAUTH` 默认 1，局域网任何人无 key 可读全部渠道明文 key、烧上游额度（实测复现） | 免鉴权模式默认开启 + 端口全网卡暴露 | `docker-compose.yml` 端口改 `127.0.0.1:8787:8787`、NOAUTH 默认翻成 0；实测无 key 请求 401（admin/gateway 双面）、带 key 全通、healthz 不受影响 |
| 3 | 前端#1（信任边界）：`openModel`/`copyCurl` 3 处把模型名内联进 `onclick` JS 字符串——恶意中转站 `/models` 返回毒模型名、用户从「探测加入别名」后，点击即在控制台源执行（可偷 `sessionStorage.adminKey`，v1.0 起该密钥同时存于 localStorage，威胁同理）；`esc()` 挡不住：HTML 属性先解码实体再进 JS | 内联 JS 字符串插值 | 3 处统一改 v0.5 已有的 `data-* + dataset` 模式：`data-m="${esc(名字)}" onclick="openModel(this.dataset.m)"`（模型表格行原本连 esc 都没有，一并补上） |
| 4 | 前端#2/#3：`codexQuota`/`notionUsage` 映射进 DATA 后零消费方，README/注释仍宣称「codex 配额条」是生产能力（v0.4 重设计丢失渲染）；`extra.css` 5 组选择器（sortable/mini-kv/img-out/art/loading）全源零引用 28 行死重；`IC.arrowDown` 唯一零引用图标 | 文档承诺了代码没做的事 + 原型遗留样式跟着产物走 | 删 `app.js:78` 映射 + 改 39 行注释；删 extra.css 5 组（38→8 行）；删 arrowDown；README:120 与 detailed §5.1 的「codex 配额条」宣称同步删除（要恢复配额展示时从 git 历史找回 v0.3 实现） |
| 5 | 前端#4/#5/#6：`protoLabel` 与 `PROTO_META.label` 两套协议显示名（codex chip 显示裸 'codex'）；抽屉「调度优先级（按实际选中顺序）」与 Playground「候选渠道」编号实为 **config 渠道序**而非调度序，误导排障；`reprobe` 写入无人读的 `errText`（真名 `lastError`）；`openLog` 找不到 id 静默回退第一条 | 同义重复 + 文案失实 + 死字段 | `protoLabel` 补 codex 短名（chip 与表单下拉统一由 PROTO_META 管长名）；两处文案改「来源渠道（按 config 渠道序，非实时调度序）」；`errText`→`lastError`（数据归位，抽屉渲染留给后续）；`openLog` 找不到改为 toast 提示后返回；shell 搜索框 placeholder 只承诺「搜索渠道…」；渠道页副标协议数改 `PROTO_ORDER.length` 动态生成 |
| 6 | **PT05**：`probeUrlFor`/`probeMethodFor`/`probeHeadersFor` 三个单行兼容包装，只服务 4 个调用点 | 旧签名兼容层早已无外部调用方 | 删除包装，4 个调用点直连 `probeUrlForDef(ch.def)`/`'GET'`/`probeHeadersForDef(ch.def)` |
| 7 | **PT06/PT07 + 前端#13/#14**：文档行数漂移（server.js ~4400 实际 4218→3675；code-map 旧偏移 +648）；bumpRoll 内存态与探测治愈无天花板标注；build.js 无 head/shell 行数守卫 | 行号锚点只靠人肉纪律 | code-map 147 处锚点全量重核修正；server.js 两处 `// ponytail:` 天花板注释 + app.js 角标内联重复处补注；build.js 增加行数守卫（head=21/shell=52，变了构建期爆错） |

> 校验：`node --check server.js` + `node build/build.js`（含新行数守卫）+ 全源 `arena` 残留 0 命中 + 容器重建实测
> （无 key 401 / 带 key 200 / healthz 30 渠道 / E2E chat 200 / 镜像 203MB / console 产物含 data-m 模式）。

---

### 8.8 v0.8 PT02 整改：渠道 proxy 字段对全部 openai 系协议生效（2026-09-27，对象 `server.js` + `build/app.js` 帮助文案 + 产物 `console.html`）

问题（PONYTAIL_REVIEW PT02）：渠道表单的「代理」字段所有协议都能填，但代码里只有 genspark/codex 走的 `wbCurlRequest` 真用它；
openai/anthropic/gemini/workbuddy 的探测、测试、聊天全部直连——填了代理被**静默忽略**，上游被墙时排查成本极高（表单帮助只写「codex / genspark 必填」）。

| # | 触点 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | `tryChannel`（聊天出站，openai/anthropic/gemini/images 共用） | undici fetch 无代理支持；CF 回退的 `psHttpRequest` 也没有 | `ch.def.proxy` 存在时整条请求改走 `wbCurlRequest`（curl `-x`，现成实现），包装成 fetch-like resp + `usedFallback=true`——**复用既有缓冲回放管道**：流式走 CF 回退同款整体重放，非流式走 `resp.text()`；CF 403 回退分支加 `!ch.def.proxy` 防护（避免无代理重试），错误消息区分 `(via proxy)` |
| 2 | `probeChannel` / `probeDef` 两个 generic 探测尾巴 | 同上 | 代理分支直接 `wbCurlRequest GET /v1/models`；探测失败写 `proxy:` 前缀错误，进冷却（代理挂了=诚实失败，不静默直连） |
| 3 | `/admin/api/test` 的 openai/anthropic/gemini 迷你聊天 | 同上 | 代理分支同款处理，测试按钮对代理渠道不再直连 |
| 4 | workbuddy 三处（探测/测试/聊天） | 用的就是 `wbCurlRequest`，只是三处都没传第 6 参 | 补传 `def.proxy`，workbuddy 免费获得代理能力 |
| 5 | 表单帮助文案（原型 2020 / 生产 1378，同行改写零锚点漂移） | 只写「codex / genspark 必填」，掩盖其他协议的静默忽略 | 改为「openai / anthropic / gemini / workbuddy 填了即生效（流式整体缓冲后一次性回放）；notion 系不支持」；README 配置示例补 `proxy` 字段 + 字段说明段 |

> **测试中抓到并修掉一个真 bug**：首版代理分支只包了 `resp.text()`、漏设 `respBody`，而 usedFallback 流式回放写的恰是
> `respBody` → 流式经代理返回空 body（7 块 SSE 全丢）。补 `respBody = out.body` 一行后修复。
> 实机验证六项：死端口代理探测被拒（`proxy: curl exit 7`）✓、Clash 7897 探测 ok + `via:"proxy"`（42 模型）✓、
> 代理渠道流式聊天 200 + SSE 7 块 + `[DONE]` 完整回放 ✓、非流式 200 正常 completion ✓、直连回归 200 ✓、
> genspark 原代理链路无回归 ✓。已知语义（帮助文案已注明）：流式经代理为整体缓冲回放，首字节延迟≈上游总耗时；
> 上游对 stream 请求回 JSON 时（个别中转站行为），网关按 SSE 头原样转发该 JSON——与既有 CF 回退行为一致。

---

### 8.9 v0.9 调度修复：404 进入 4xx 兜底白名单（2026-09-27，对象 `server.js`，纯后端不动前端）

问题（用户侧实测 + 跨 agent 诊断后由本侧收窄修法落地）：渠道「声明有此模型」但上游实际没有（别名表过期）时，
上游回的 404 被网关当成"客户端错误"原样透传、**不切下一候选**——明明有真正提供该模型的渠道在候选链上，客户端却拿到 404。
活体标本：`deepseek-v4.1-flash-free` 有 apmix、bqgy 两个候选（按延迟 apmix 排第一），apmix 别名表写了该模型但探测清单早已没有 → 上游 404 →
改前实测客户端直接收到 `Unknown model. See apmix.ai/models`，bqgy 根本没被试。

根因：`tryChannel` 的 4xx 分类白名单 `[401,402,403,408,429]` 漏了 404。该名单语义 = "渠道侧问题（跨渠道各不相同）→ 切下一候选"，
名单外 4xx（400 参数错等）= "换渠道也一样错 → 原样透传"。404（该渠道没有此模型）属于前者却被归进后者。
同款判据共**五处**（generic tryChannel 2494 / workbuddy 2726 / genspark 2940 / codex 3270 / notion 3391——第五处 notion 是跨 agent 诊断也没数到的）。

处置：五处白名单统一改为 `[401, 402, 403, 404, 408, 429]`；generic 与 genspark 两处分类注释同步改写；
README §4xx 重试规则行改写（顺带修正了原文档把 401/403 写成"不再切渠道"的陈旧描述——代码里它们一直是在切的）。
**没有**采用"仅当还有候选才透传 4xx"的更激进方案：那会让真正的 400 参数错在所有渠道上重打一遍、并把每个渠道都记一次失败降权——
为一个客户端错误惩罚全部渠道。404 进名单是零附带损伤的最小修：400/422 的透传语义原样保留。

行为变化（已知且接受）：全部候选都 404 时，客户端从"收到某个渠道的裸上游 404"变为"网关自己的 502 all channels failed + attempts 明细"——与网关错误契约一致。

验证（前后对比实测）：改前基线 `deepseek-v4.1-flash-free` → 404 `Unknown model`（apmix 透传，bqgy 未试）；
改后同请求 → **200，X-ZZCSAPI-Channel: bqgy**（apmix 404 → 兜底命中真有该模型的渠道）✓。
真客户端错误回归：`messages: []` + 已配模型 → 上游 400 **立即透传**，未逐渠道扫描 ✓。常规聊天 / healthz 30 渠道回归 ✓。

> 顺带观察（上游侧问题，非本修复范围）：bqgy 免费池当晚对 `deepseek-v4.1-flash-free` / `glm-5.3-free` 均返回
> HTTP 200 + `content:null`（finish_reason=length/refusal）——"活着但不干活"。周期探测只测 `/v1/models` 探不不出这种退化。
> 已向用户标记：属探测盲区（"空回复不算失败"），若频繁出现可考虑给网关加空回复判失败的规则，先不动。

---

### 8.10 v1.0 分享场景加固：首启密钥生成 + 控制台登录门（2026-09-27，对象 `server.js` + `build/app.js` + `docker-compose.yml` + `.env`/`.gitignore` + 产物 `console.html`）

问题（用户提出"项目分享出去，这个 key 应该是什么样子"）：密钥全靠环境变量，而 `docker-compose.yml` 里写的是**公共默认值**
`${ZZCSAPI_ADMIN_KEY:-zz-admin-change-me}` / `${ZZCSAPI_GATEWAY_KEY:-zz-gw-change-me}`——收到项目的人不配置就直接跑，
于是**每个部署都用同一把写在公开仓库里的管理密钥**；更糟的是 `checkAuth` 里"key 为空则放行"，空密钥比公开密钥还危险。
另一面是使用体感：控制台密钥原本只存 `sessionStorage`，**关掉标签页就丢**，每次开新标签都得重新贴一遍长 URL。

根因：默认凭据是公开知识（分发场景的头号问题）；鉴权只在"用户恰好设置了 env"时生效；密钥记忆用了会话级存储。

| # | 触点 | 处置 |
| --- | --- | --- |
| 1 | `server.js` 鉴权块 | 密钥解析改为三级优先：**显式 env > config.json 里首启生成值 > 首启生成**；`NOAUTH` 保持为显式开发开关；**删掉"空 key 就放行"两条**（NOAUTH 关闭时密钥恒存在） |
| 2 | `server.js` `resolveGeneratedKeys()` | 空则 `crypto.randomBytes(24)` 生成 48 位随机串，**打印横幅到容器日志**（能看到 `docker logs` 的人即主机主人）并写回 `config.json`；写回失败则降级为"仅本次启动有效"并明确告警 |
| 3 | `server.js` `persistConfig()` | 生成密钥纳入持久化字段（否则首次改渠道时被"重建式写入"丢掉）；**env 提供的密钥不落盘** |
| 4 | `server.js` 控制台路由 | 放行 HTML 壳（零机密，密钥不落页面）；`/admin/api/*` 每次调用仍强制 `Bearer`——"页面能开 ≠ 有权限" |
| 5 | `build/app.js` | `bootstrapKey` → `keyFlow`（`?key=` → localStorage → sessionStorage 三源合流）+ `showKeyGate()` 登录门（变相登录页：无账号体系，输一次 key 存 localStorage，之后裸开）；`init()` 改名 `boot()`，有 key 直接启动、无 key 先弹门；`api()` 401 → 清存储 + 重新弹门（密钥被轮换时自动闭环） |
| 6 | `docker-compose.yml` | 默认值改空（`:-}`）+ 注释讲清分享场景与 `.env` 覆盖法 |
| 7 | `.env` / `.gitignore` | 本机部署建 `.env` 固定现有密钥（env 优先，书签/DSH 不受影响）；`.env` 加入 `.gitignore` 绝不入仓库 |
| 8 | `build/app.js` 接入页「密钥状态」卡 | 原文案声称"仍是仓库默认值，且容器以 0.0.0.0 监听……密钥由服务端环境变量下发"——本轮改了密钥来源（可首启生成）与监听收敛方式，两处失准；改为提示"公开可猜的默认串 + 给两种轮换路径（改 `.env` / 删 config.json 字段重启）+ 指向 compose 看端口收敛"。`/change-me/i` 检测本身保留（首启随机密钥不会命中，不再误报） |

验证（实机双路径）：

- **本机路径**（`.env` 提供密钥，不触发生成）：裸开 `/console` → **200 HTML 壳含登录门** ✓；裸调 `/admin/api/status` → **401** ✓；
  老书签 `/console?key=…` → 200 ✓；无 key 网关 401 / 带 key 200（29 模型）✓；E2E chat 200 ✓；healthz 30 渠道 ✓；容器日志无生成横幅 ✓
- **分享路径**（一次性容器，`ADMIN_KEY=`/`GATEWAY_KEY=` 留空 + 临时 config）：日志打出首启横幅与两枚 48 位密钥 ✓；
  `config.json` 被写入且**渠道数据完好、中文不乱码**（30 渠道复核）✓；无 key 两面 **401**、生成 key 两面 **200**、控制台壳 200 ✓；
  临时容器与本机 `config.json` 均已清理，后者**未被写入生成密钥** ✓

> 设计取舍（记录在案）：曾考虑"首次打开网页向导设置密钥"，否掉——向导页本身要用某把 key 守门，而公开默认 key 意味着
> 窗口期内任何本机进程都能**抢注**成自己的密钥。首启生成 + 日志抄录同样只做一次，且不存在公开默认值。
> 已知语义：`ZZCSAPI_NOAUTH=1` 仍是完全无鉴权（显式选择，仅限本机自用）；直接 `node server.js`（无 env、无 NOAUTH）也会走首启生成并需要登录门。

---

### 8.11 v1.0.1 修复：聚合模型页搜索/页签被 8 秒轮询冲掉 + Playground 草稿同样丢失（2026-09-27，对象 `build/app.js` + 产物 `console.html`）

问题（用户报告：「聚合模型里搜索任意模型，一会就刷新了页面，然后搜索的【内容】没了」）：

先澄清刷新机制：**不是浏览器整页刷新（不是 F5）**，是 SPA 内部每 8 秒的静默数据刷新——
`setInterval(…, 8000)` → `loadAll()`（并发拉 `/admin/api/status` + `/usage` + `/config`）→ `adapt()` → `render()`，
而 `render()` 把**当前页的整个 `#viewport` innerHTML 重建**。`render()` 本身已经保了滚动位置和焦点/光标，
但**输入框里的文字属于 DOM，重建即丢**。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | **聚合模型页**：搜索词一输，约 8 秒后清空、表格跳回全量；协议页签也自行跳回「全部」 | 该页是唯一没做状态回填的页面：`<input id="mQ">` 模板里**没有 `value=`**、无状态变量；页签把 `class="tab on"` 写死在「全部」上。渠道页（`chQ`/`chTab`）、日志页（`lgRange`/`lgCh`/`lgOk`/`lgQ`）、总览页（`ovRange`）都做了，唯独模型页漏了 | 补 `let mTab='all', mQ='';`；模板回填 `value="${esc(mQ)}"` 与 `class="tab${mTab===…?' on':''}"`；`oninput`/`onclick` 写回状态；`drawMTable()` 改为读 `mQ`/`mTab` 而不是读 DOM |
| 2 | **Playground**：正在敲的消息草稿、System Prompt 会被 8 秒重绘吞掉（同类，症状更烦）；temperature / max_tokens / 流式开关也各自跳回默认值 | 同上：`#pgInput`/`#pgSys` 的初值只在模板里留空，`#pgModel`/`#pgTemp`/`#pgMax`/`#pgStream` 也没回填选中态 | 补 `pgDraft`/`pgSysText`/`pgModelSel`/`pgTempV`/`pgMaxV`/`pgStreamOn` 六个状态；模板全部回填；`oninput` 实时写回草稿与 System Prompt；`pgSend` 发送后清 `pgDraft` 并触发重绘 |
| 3 | 流式请求进行中若撞上轮询，「正在路由…」气泡被重绘抽掉（答案本身不丢，`pgSend` 结束时由 `PG` 统一重绘） | 重绘与流式 UI 竞争同一片 DOM | 轮询加护栏：`pgBusy`（流式中）跳过这一拍 |

轮询护栏（第 3 条同时解决了中文输入法的联想被打断）：

```js
setInterval(()=>{
  if(document.visibilityState!=='visible'||pgBusy)return;
  const a=document.activeElement, vp=$('#viewport');
  if(a&&vp&&vp.contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))return;  // 用户正在输入 → 这拍不重绘
  loadAll().catch(()=>{});
},8000);
```

> **沉淀成约定**（已写进 code-map §0.2 末尾「状态回填约定」）：8 秒轮询重绘本页 DOM，**视口内任何输入控件的值都必须存 JS 变量并在模板回填**，
> `oninput` 必须写回变量。判断方法：在任意页面输入文字，等 10 秒——如果文字还在，说明这页做对了。
> 弹窗与抽屉挂在 `#viewport` 之外（`#drawer`/`#mask`/`modal()`），不受重绘影响，无需回填。

校验：`node --check build/app.js` ✓、`node build/build.js` ✓（140893 字符 / 2538 行）、容器重建后活体断言 8 项 ✓
（壳 200 含登录门、含 `mTab`/`mQ` 状态、`id="mQ"` 带 `value="${esc(mQ)}"`、页签选中态回填、含 `pgDraft`、`pgInput` 回填 `>${esc(pgDraft)}</textarea>`、
轮询护栏两条件齐备）、管理面 200（30 渠道）、healthz 30、E2E chat 200 ✓。

**行为级验证（已固化为仓库回归测试 `test/console-state.test.js`，零依赖）**：按花括号配对从 `build/app.js` **现抠真实的
渲染函数源码**（不复制副本，永远与产品代码同步），在最小 DOM 桩里跑「首渲染 → 绑定的事件触发 → 再渲染（等价于 8 秒轮询）」。
`node test/console-state.test.js` → **27 项断言全绿**，覆盖两个页面：

- **模型页**：输入 `glm` → 状态变 `glm` → **重绘后 `value="glm"` 仍在**、表格只剩 `glm-5.3`（用户报告的回归点）；
  点 OpenAI 页签 → **重绘后仍选中**；改搜 `kimi` → 仍保留、表格切换；搜索词按 HTML 转义回填
- **Playground**：草稿 / System Prompt / Temperature / Max tokens / 流式开关 / 模型选择六项**重绘后全部保留**
- **对照组**：同样断言跑「模板不带 `value=`」的旧写法 → 重绘后取到空值（测试具备捕捉能力，不是恒真）

**变异测试（证明它真的守得住）**：把四处修复逐个撤掉再跑测试 → **4/4 全部变红**（撤搜索框回填 / 撤页签选中态 /
撤草稿写回 / 撤参数回填），恢复后文件字节一致且基线重新变绿。

> 新增带输入框的页面时**顺手补一条用例**。测试依赖 `vModels`/`vPlayground` 等函数名，改名会让它装配报错——
> 这是刻意的（会逼着同步本文件与 code-map 的行号锚点）。已登记：`README.md`「前端代码文档」、`AGENTS.md` §3、code-map §8 自测清单。

浏览器里的人工确认（打字 10 秒不丢）仍建议实际点一次——本机无浏览器自动化手段（镜像已撤 Chromium）。

---

## 9. 后续可做（未实现）

- 渠道列表分页 / 虚拟滚动（真实 30+ 渠道，模型探测可能上百）
- 密钥明文显示加"仅本次会话"提示或二次确认
- 探测结果支持"仅显示新增"过滤
- 表单校验错误定位（当前只给行内状态文字，不滚动定位到出错字段）
- 移动端适配（当前 ≤900px 直接隐藏侧栏，无抽屉式导航）
- 设计稿的 `PROBE_POOL` / `DATA` 快照已是演示用途，长期可考虑删掉、让原型也能切到 mock 接口
- 构建产物目前整体提交；若体积继续增长可考虑改为构建时生成、不提交（需同时改 `Dockerfile` / `docker-compose.yml`）
- 主题闪烁：head.html 默认 `data-theme="light"`、app.js init 默认 dark——深色用户每次加载闪一帧浅色（前端审查#12，需 head 内联一行读 localStorage，会改 JS 偏移需同步文档）
- URL 来源统一 `location.origin`（前端审查#2：server.js /admin/api/config 硬编码 127.0.0.1，五个前端消费点放大；PT01 后部署已锁本机回环，紧迫性降低，但若恢复局域网访问则必修）
- 模型页协议页签语义（前端审查#5：页签按渠道协议过滤但三入口别名表统一，openai 页签排除表与后端行为矛盾；抽屉 `lastError` 渲染展示也属此类）
- codex 配额 / notion 用量抽屉展示恢复（前端审查#3 的另一半路：数据在 status 里，v0.4 丢失了渲染；要恢复从 git 历史找回 quotaBox 实现）

---

## 10. 验收清单

见 [frontend-code-map.md §8](./frontend-code-map.md#8-快速自测清单改完跑一遍)。

---

## 11. 构建管线与生产落地

### 11.1 为什么改成构建式

v0.2/v0.3 的做法是「两份文件手工同步」：设计稿改了，再去生产文件里照着抄一遍。
实践下来必然漂移——用户的原话是"真实项目和设计不一样，多个不一样的地方，不管是大小、留白、卡片样式等等很多都不一样"。

v0.4 换成构建式：**生产 CSS 不再手写，而是逐字节复制设计稿的 `<style>` 原文**。
这样"对齐"不再是需要维护的状态，而是**结构性保证**——设计稿改了什么，构建出来就是什么。

### 11.2 文件职责

| 文件 | 谁改 | 改什么 |
| --- | --- | --- |
| `console-redesign.html` | 改**视觉** | 它的 `<style>` 是唯一视觉真源。字号 / 留白 / 圆角 / 配色 / 卡片 / 弹窗全在这里 |
| `build/head.html` | 极少改 | 生产 `<head>`：主题初值、MiSans CDN |
| `build/shell.html` | 改**生产骨架** | body 结构：背景层 / rail / topbar / viewport / drawer / mask / toasts |
| `build/extra.css` | 加**生产独有组件** | 设计稿快照里没有的组件（codex chip、抽屉密钥行等宽字）。**必须复用设计令牌** |
| `build/app.js` | 改**生产逻辑** | 数据层（`adapt` / `loadAll` / `api`）+ 动作层 + 6 个页面渲染 |
| `build/build.js` | 改**构建方式** | 组装顺序 + 自检 |
| `console.html` | **没人改** | 产物。手改会被下次构建静默覆盖 |

### 11.3 构建产物结构

```
<head>                      1–21      来自 build/head.html（第 21 行即 <style> 开标签）
<style> 内部：
  ├─ 构建说明 banner         23
  ├─ 设计稿 CSS 原文         24–549    来自 console-redesign.html 的 <style>（逐字节）
  └─ 生产补充 CSS            552–559   来自 build/extra.css（8 行）
</style>                    561
<body>                      563–616   来自 build/shell.html
<script>                    617 起，app.js 行号换算 +617，JS 内容至 2477
</body>                     2480
```

> 行号换算：CSS = 设计稿行号 **+13**；JS = `build/app.js` 行号 **+617**。
> 增删 `build/head.html` / `build/shell.html` / `build/extra.css` 的行会改变偏移，届时同步修正
> [frontend-code-map.md](./frontend-code-map.md) §0.1 与 [`AGENTS.md`](../AGENTS.md) §1.2。

### 11.4 构建期自检（别删）

```js
const nEnd = out.split('</style>').length - 1;
if (nEnd !== 1) throw new Error('产物中 </style> 出现 ' + nEnd + ' 次，应为 1 次…');
```

**为什么必须留**：HTML 解析 `<style>` 是**裸文本模式**——只要遇到 `</style>` 字面量就立刻闭合元素，
**即使在 CSS 注释里也一样**。一旦注释里混进这个字面量，后面整段 CSS 会变成页面正文文本，
现象是"样式大面积失效但页面不报错"，极难排查。这条自检让它在构建期就炸出来。

### 11.5 改配色时的硬约束

1. **只改设计稿**。两套主题（`html[data-theme="dark"]` / `[data-theme="light"]`）都在 `console-redesign.html` 的 22–61 行；
   生产是复制品，不要去 `console.html` 里改。
2. **两套主题都要给值**。只有 `--rail-w` / 圆角 / 字体栈 / `--fw-display` / `--ease` 在 `:root` 定义一次（暗亮共用），
   其余颜色变量**两个块里都有**，加新变量时别只加一边。
3. **排除冷色**。色相留在红/橙/琥珀/棕；`--ok` 是唯一允许的绿，且只用于语义"成功/跌"。不要再引入青、蓝绿、紫青。
4. **面层级方向会反转**：亮色下 `--panel-3` 比 `--panel` **暗**，暗色下比 `--panel` **亮**（都是"更靠近用户"）。抄新组件时别把方向写死。
5. **改完必须 `node build/build.js`**，并在同一次提交里带上 `console.html`。
