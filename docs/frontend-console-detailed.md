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
  `#mask` **不绑 `onclick`**，与原型策略一致；`Esc` 由 `build/app.js` 2350 的全局 `keydown` 监听兜底
  （优先关弹窗，其次关抽屉）。
  > 早期版本曾有 `#codex-mask` / `#gs-mask` / `#test-mask` / `#dmask` 四个独立弹窗，重构时已统一收敛掉。
  > **新增弹窗不要再建新 `.mask`**，直接用 `modal()` 注入。
  > **`.mask` 是"弹窗遮罩"专用类名，别拿它当"掩码"用**：它带 `position:fixed;inset:0;opacity:0`，
  > 任何非弹窗元素套上它都会**脱离文档流且透明**（密钥值曾因此整行看不见，v1.18.6 改用 `.ep-key .kval`）。
  > 见 [frontend-code-map.md](./frontend-code-map.md) §7 坑位 19。

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

### 4.10 自动权重页 `.aw-*`（生产独有，设计稿不含）

「资源 → 自动权重」独立页上的份额预测卡（v1.9 起从渠道页迁出）。**它只算不生效**，所以整卡刻意压低视觉权重：
不抢强调色、不用大字、不做动效强调——避免被误读成"已经在分流"，靠 `.aw-note` 一句自证，不靠用户猜。
样式全部在 `build/extra.css`（第 10–57 行），色值一律走设计令牌（`--ok` / `--warn` / `--err` / `--tx-*` / `--line`），
**不引入新颜色**；健康度沿用全站三档（`≥0.9` / `≥0.6` / 其余），与成功率条同源。

| 类 | 职责 |
| --- | --- |
| `.aw-card` | 卡容器（复用 `.card`，仅补下边距） |
| `.aw-meta` | 说明 + 旋钮带（`--panel-2` 底 + 下分隔线） |
| `.aw-note` | 加粗自证句「当前分流一字未动」（`--tx-2`，v1.8.1 起从 `--tx-3` 提亮，原对比度仅 3.6:1） |
| `.aw-knobs` | 旋钮胶囊行（`.lbl` + 复用 `.tag`） |
| `.aw-model` | 模型块（块间淡分隔线，块内靠留白分组） |
| `.aw-m-hd` / `.aw-m-name` / `.aw-m-meta` | 块头（模型名等宽 600 / 候选数与请求数 / 右侧状态 `.tag` 靠 `margin-left:auto`） |
| `.aw-split` | **份额列容器**：`display:flex;align-items:flex-start;gap:8px`（一候选一列） |
| `.aw-col` | **一列 = 一个候选**：`flex-grow:var(--w)`（`--w` = 该候选份额）、`flex-basis:0`、`min-width:0`；列宽因此严格等于份额 |
| `.aw-seg` | 该候选的色带段：`height:11px`、圆角 3px、`background:var(--c)`（`--c` = 健康色） |
| `.aw-cap` | 名字 + 百分比行：`flex` 基线对齐；名字可截断，百分比 `flex:0 0 auto` 任何列宽下都不截断 |
| `.aw-nm` / `.aw-nm .k` | 渠道**显示名**（v1.9.1 起只留名字，不再跟 id 小片）/ `盲试`·`自动匹配` chip |
| `.aw-sh` | 份额数字（600 + `tabular-nums`，本列的主数值） |
| `.aw-sub` | 可选副行（健康系数 <1 / 手工权重对照；没有就不占位） |
| `.aw-zero` | 份额为 0 的候选不进列，在这里统一交代「未参与分流：<渠道>（<原因>）」 |

**两条硬约束（改了会立刻看出问题）**：
1. **标签必须留在自己那一列里**（`.aw-cap` 是 `.aw-col` 的子元素）——一旦把标签抽出来做成独立图例，
   就会重蹈 v1.8 的覆辙：色带单向排列、图例换行重排，多候选时两者对不上（用户报的"错位"就是这么来的）。
2. **`--w` 必须是份额本身**：`flex-grow:var(--w)` 配 `flex-basis:0`，间隙（`gap`）由布局先让出、余量再按份额分，
   各列宽度才严格成比例。份额为 0 的候选**不进 `.aw-split`**（列宽 0 画出来看不见），理由放 `.aw-zero`。

### 4.11 运行期设置页 `.set-*`（生产独有，设计稿不含）

「工具 → 运行期设置」页上的四张开关卡（v1.18 三张；v1.18.8 增第四张「thinking 回放」）。一页四卡：**卡头开关 + 卡体旋钮 + 生效角标 + 实时计数**；
关闭时整卡降权（`.set-card.muted`，旋钮一并 `disabled`）。样式全部在 `build/extra.css`（第 59–80 行），
复用全站令牌，**不引入新颜色**；四卡容器 `.grid.set-cards`——**两排各两张**（用户拍板，≤900px 折一列；
不是通用 `.g4` 的四连排，那条是原型别处也在用的工具类，改它会殃及无辜）。

| 类 | 职责 |
| --- | --- |
| `.set-err` / `.set-err.on` | 保存失败错误条（隐藏态 `display:none`，`.on` 才显示）。**里面放后端 400 的 `error` 原文**（如 `unknown field rateLimit.rpmm`），不是"保存失败"这种空话 |
| `.set-desc` | 卡内说明文字（`--tx-2`） |
| `.set-row` | 一条旋钮行（`border-top` 淡分隔）；`.set-row>label` 占满剩余宽度，`.set-row .input` 固定 104px，`.set-row .switch` 靠右 |
| `.set-unit` | 单位（`秒` / `次` / `rpm`，等宽小字） |
| `.set-eff` | **生效值角标**（`--tx-3` 中性色 —— 它只说明"生效值与你填的不同"，不是错误）。`setHint()` 只在"已保存的值被钳制"时给出 |
| `.set-warn` | 警示文案（`--warn`；如 `/metrics` 公开可读、`deriveFromBody` 会互相抢占） |
| `.set-stat` | 实时计数区（卡底，`border-top` 分隔）；`b` 是数值；`.btn` 是「复制抓取地址」 |
| `.set-card.muted` | 关闭态整卡降权（卡头开关关闭时旋钮禁用） |

**两条硬约束**：
1. **`config` 与 `effective` 两个值都必须显示**：前者回填输入框（你填的原值），后者是钳制后真正生效的值
   （`ttlSec` 填 5 → 生效 30）。只显示一个必然变成"我明明填了 5，怎么没生效"的悬案。
2. **`setDirty` 时 8 秒轮询绝不覆盖草稿**（`syncSettingsDraft` 的唯一判据），否则用户填一半就被轮询清掉——
   与 §4 顶部的「状态回填约定」同源。

### 4.12 数据统计页 `.st-*`（生产独有，设计稿不含，v1.18.12）

「监控 → 数据统计」页的版式组件（v1.18.11 建页时散用内联样式；v1.18.12 用户看了原型 `_st_preview.html` 拍板整改后收编成类）。
样式全部在 `build/extra.css`（第 82–105 行），复用全站令牌。

| 类 | 职责 |
| --- | --- |
| `.st-kpi-row` / `.st-kpi` / `.st-kpi-num` / `.st-kpi-unit` | 四张全局 KPI 卡：**内容整体居中**（替掉 v1.18.11 的内联 `font-size:22px`——数字是视觉锚点，居中+统一字号才不散）；四卡 `flex:1` 等宽等高 |
| `table.tbl.st-fixed` + `colgroup` 9 列 | 来源明细表**定量列宽**（11%/7%/15%/6%/8%/14%/16%/13%/10%）——auto 布局下"IP 长/会话空"会把客户端标签列挤变形，定量列宽才稳 |
| `.st-sec` | 分区标题（来源明细 / 按模型）`padding:0 16px`，与卡片内边距对齐，不再贴卡片边框 |
| `table.tbl.st-models th:first-child` | 按模型表首列（模型名）不居中，其余列居中——与来源明细表同款分区样式 |
| `.t-c-ph` | 占位符「—」专用居中（`display:block;text-align:center`）；**真实模型名/客户端标签不套**——真名左对齐、只有占位符居中，一眼分得清"没数据"和"有数据" |

配套纪律：表头 `.t-c` 与数值列 `.t-c` 居中**必须补权重**（`table.tbl thead th.t-c{text-align:center}`，照抄 `.t-r` 的写法并排写进设计稿同一行，不增行——否则输给 `th{left}` 基样式，表头左对齐数值居中就错位了）。守卫在 `test/console-state.test.js` §13（KPI 类名计数 / colgroup 9 列 / 表头 t-c / 占位符 t-c-ph / 产物 CSS 存在性 + 旧写法对照组）。

---

## 5. 页面详解

### 5.1 总览 `vOverview`（1064）

- 4 张 KPI 卡：累计请求 / 成功率 / 平均延迟 / Token 消耗，各带独立曲线带
- 请求趋势大图（`areaChart`，20 天）+ 峰值/日均 chip（日界 = **北京时间 00:00**，v1.18.36 起）
- 渠道健康环形图 `donut` + 图例（正常 23 / 降级 1 / 不可用 6）
- Top 渠道表、Top 模型条形榜
- 时间范围页签 `24h / 7d / 30d`
  - **原型**：仅切换选中样式，不切换数据（快照里只有日粒度）
  - **生产**：**真实切换**。`OV_RANGE`（`build/app.js` 429）定义三档 → `ovSeries()`（453）按档取序列：
    24 小时走后端 `usage.hourly`（24 桶），7/30 天走 `DATA.trend.slice(-N)`；KPI 环比窗口同步跟着天数走
- **延迟环比 `avgLatencyDelta()`（`build/app.js` 438）**：取最近 200 条成功日志，前一半当「本期」、后一半当「上期」算变化率；
  **样本 < 40 返回 `null`**——宁可不显示，也不编一个假百分比

### 5.2 涨跌颜色（中国股票惯例）

```css
.delta.up  { color:var(--err); background:var(--err-soft) }  /* 涨 = 红 */
.delta.down{ color:var(--ok);  background:var(--ok-soft)  }  /* 跌 = 绿 */
```

> 与欧美惯例相反，**这是需求方明确要求的**。同时移除了原本的 ↑/↓ 箭头——
> 方向已由 `+/-` 符号和颜色双重表达，再加箭头是三重冗余（`kpiCard`（原型 1050）有注释留档）。

**生产侧零差异**：`build/app.js` 不重定义任何涨跌样式，直接吃设计稿这条规则。
它只负责算数值与方向：`dChip(v, unit, suffix)`（`build/app.js` 447）产出带符号的文本，`kpiCard({dir:'up'|'down'})`（`build/app.js` 396）产出 `.delta.up` / `.delta.down` 类名。
（旧版的 `deltaBadge(delta, invert)` 已随重构删除——`invert` 会把"好/坏"折算成颜色，与"方向即颜色"的规则冲突。）

**改这里时别顺手改回欧美惯例**，见 `AGENTS.md` §2。

### 5.3 渠道管理 `vChannels`（1174）

- 工具栏：导入（四项下拉）/ 测试模型 / 添加渠道
- 筛选：全部 / 已启用 / 已停用 页签 + 名称·ID·协议搜索框
- 表格列：启用开关 / 渠道 / 协议 / 状态 / 延迟 / 模型数 / 优先级（自动降权时附「→ 有效 X」角标，悬停见失败率与回升说明）/ **权重 · 分流** / 请求·错误 / 成功率 / 操作
- **「权重 · 分流」列（v1.5）**：显示 `配置权重 · 加权轮询占比`（如 `3 · 24%`），悬停见命中次数与"重启后重新计数"提示；
  权重 0（未配）显示 `—` 并提示"未参与加权轮询"，**不显示 `0%`**——`0%` 会被误读成"配了但一次都没分到"。
  数据来自 `/admin/api/status` 的 `weight` / `weightedHits` / `weightedShare`，经 `adapt()` 映射为 `w` / `wHits` / `wShare`。
- 操作列：**测试 / 编辑 / 详情**（三个都要 `stopPropagation`）
- 排序（`drawChTable` 1214）：「全部」页签下**已启用优先**，同组内按优先级、请求量降序

> **v1.9 起观测卡不在这一页了**：它已迁到「资源 → 自动权重」独立页（见 §5.4）。渠道页现在只剩
> 页签 / 搜索 / 表格，避免"一个只读预测卡压在可操作的表格上方"造成层级混乱。

**渠道详情抽屉 `openChannel`（1255）**：
顶部标签行（状态 / 延迟 / 优先级〔自动降权时显示「→ 有效 X（失败率 Y%）」角标〕/ 启停 / **权重角标**）→
**自动权重（观测 · 只算不生效）一节** → 接入配置（Base URL / 密钥掩码+明文切换+复制 / 协议 / 模型数）→
近 7 天表现三宫格 + 曲线 → 模型别名 chips → 底部动作：测试模型 / 重探测 / 编辑 / 启停 / 删除

> **权重角标（v1.5）**：配了权重的渠道显示 `权重 3 · 分流 24% (12 次)`；没配的显示灰色的
> `未参与加权轮询 · 点「编辑」可设权重`——抽屉是唯一能同时看到"配置值"和"实际分流结果"的地方。
>
> **自动权重一节（v1.6）**：四个标签摊开判断依据——`健康系数 0.62` / `样本 20` /
> `失败率 30%`（样本不足时写「样本不足，暂不动」）/ `延迟 240ms（2.4× 最快）`（无数据时写「没有数据」），
> 下面一行说明"这一版只计算并展示，上面的系数不会被执行"。对应字段 `autoH` / `autoSamples` /
> `autoFailRate` / `autoLatMs` / `autoSpeedRatio` → `adapt()` 映射为 `ah` / `aN` / `aFail` / `aLat` / `aSpd`。

**启停 `toggleCh`（1249）**：就地改 `DATA`，toast 明确提示"原型演示，不会写入 config.json"。

### 5.4 自动权重 `vAutoWeight`（生产独有，原型无此页）

- 位置：「资源」组的第三个页签（渠道管理 / 聚合模型 / **自动权重**）。`NAV` 加一项、`go()` 的分发表加一条
  `autoweight:vAutoWeight` —— 新增页面照这两步走（见 code-map §5「新增页面（生产）」）。
- 结构：页头（`page-title` 自动权重 + 一句副标题）→ 一张 `.aw-card`（复用 §4.10 的 `.aw-*`）。
  `vAutoWeight()` 只出页头 + 挂卡，真正的卡在 `autoWeightCard()`（`build/app.js` 678）。
- 目的：回答"如果开了自动权重，同一个模型的多个候选会怎么分"——**只算不生效**，卡头必须写明这点。
- 卡头 `.card-hd`：`分流预测` + `只算不生效` chip（生效时才换成 `已生效` accent chip）+ 右侧 `N 个多候选模型` 计数。
- `.aw-meta` 说明带：一句加粗自证的 **"当前分流一字未动"**（不说清楚，用户会以为份额已经变了）
  + 旋钮胶囊（速度权重 / 地板 / 单渠道上限 / 样本门槛 / 重算周期）。
- 每个模型块 `.aw-model`：块头 `.aw-m-hd` = 模型名（等宽 600）+ `N 个候选 · X 次请求`
  + 右侧状态标签（`当前未开加权轮询` / `已排除 <渠道>`）。
- **份额列 `.aw-split`**（v1.9 重做，替代旧的 `.aw-bar` + `.aw-legend`）：**一候选一列**，
  列宽用 `flex-grow:var(--w)`（`--w` = 该候选份额、`flex-basis:0`）严格按份额分配；
  列内上方 `.aw-seg` 是这段的色带，下方 `.aw-cap` 直接挂渠道名 + 百分比 ——
  标签就在自己那一段的正下方，"这段是谁的"不用去别处找（旧版图例换行后与色带对不上，正是用户报的"错位"）。
  标签**只留渠道显示名**（v1.9.1 起不再跟 id 小片：只显示渠道名，不再显示"渠道名 + id"；百分比照旧保留）。
- **份额为 0 的候选不进列**（列宽 0 画出来看不见），统一收进 `.aw-zero` 一行：
  `未参与分流：<渠道>（失败率 60% · 延迟 …）`。
- 配色：`h ≥ 0.9` 绿、`≥ 0.6` 黄、其余红（与成功率条同一套语义，色即是因）；
  `title` 给出**判断依据**（失败率 / 样本数 / 延迟与相对倍数），不给理由的自动降权没法排障。
- 空状态：没有多候选模型时显示「当前没有『同一个模型被多个渠道提供』的情况，暂无可观测的分流」。
  **单候选模型刻意不进卡**——一个提供方谈不上分流，显示了只会是满屏"100%"噪音。
- 样式**全在 `build/extra.css` 的 `.aw-*`**（生产独有组件，设计稿不含）。`autoWeightCard()` 只产结构
  与两个数据驱动的行内值（份额 `--w`、健康色 `--c`），其余一律走类名——**不要再往标记里写行内样式**
  （v1.6 那版行内样式让排版无法统一维护，是 v1.8 重做的直接原因）。
- **原型 `console-redesign.html` 未同步此页**（同 v1.5/v1.6 约定：生产独有能力，原型不追平）。

### 5.5 聚合模型 `vModels`（1335）

- 协议筛选页签 + 搜索
- 排序（`drawMTable` 1380）：**仍有启用渠道的模型排前面**，仅剩停用渠道的模型整体降透明度（`opacity:.62`）并标"来源已停用"
- 状态列：稳定 / 有失败 / 来源已停用
- 点击行打开模型详情抽屉：按实际选中顺序展示调度优先级

### 5.6 调用日志 `vLogs`（1445）

请求列表（时间 / **请求 ID → 渠道名 → 模型名** / 协议 / 状态 / 耗时 / token）+ 详情抽屉 `openLog`（1489）。

- **渠道列显示显示名，不显示 id**：表格与详情抽屉都渲染渠道显示名（"主渠道 / 备用渠道 / AgentRouter"，而不是 `ch-a / ch-b`）。
  原型在模板里就地查名（`(DATA.channels.find(c=>c.id===l.c)||{}).name||l.c`）；
  生产在 `adapt()` 里把显示名解析进每条日志的 `n` 字段（`n:(chans.find(c=>c.id===r.channelId)||{}).name||r.channelId||'—'`），
  渲染层直接用 `esc(l.n)`。**渠道 id 仍保留在 `l.c`**，供筛选、导出与排障。
- **列序**：渠道列紧跟请求 ID 之后（用户要求"在请求 ID 后面"），模型列顺延其后（生产 `drawLogTable` 生产锚点 1260）。
- **客户端列（v1.18.11；v1.18.13 跳转升级）**：模型之后新增「客户端」列——UA 自报家门的标签（codex CLI / Claude Code / curl 等；无 UA 或未识别显示 `—`）。
  格子是 chip（自带 `data-cl="${esc(l.cl)}"`），点击 → 跳「数据统计」页**按该客户端标签过滤**并**直接弹开最活跃来源的详情抽屉**（多个来源共用同一标签时弹敲门最多的那个，其余来源都在过滤后的表里；统计里没有该标签时不弹，只落过滤页）。行内 `stopPropagation` 不触发行点击。空值 `—` 不可点。
  标签取 chip 自带的 `data-cl`（`esc()` 过的属性），**绝不按 NodeList 索引对 `rows[i]` 取值**——无标签的行不渲染 chip，按索引取会错位（v1.18.13 修掉的潜伏 bug）。
  客户端标签是**外部可控值**（服务端只截断不消毒）→ 渲染必须 `esc(l.cl)`。标签只做显示，**绝不进任何控制逻辑的判定**（详见 §5.11）。
- **搜索**：搜索框同时匹配模型名 / 渠道名 / 渠道 ID / 请求 ID（`logRows()` 判据 `l.m + l.n + l.c + l.id`，生产锚点 1198）——
  按名字搜比按 id 自然，老习惯按 id 也仍然命中。
- **CSV 导出** `exportLogs`（生产锚点 484）：渠道列同样写显示名（`l.n`），与页面所见一致。
- 详情抽屉 `openLog`（生产锚点 1296）补「客户端」键值（有标签才显示）。

### 5.7 Playground `vPlayground`（1534）

左对话区 + 右参数栏（模型、temperature、top_p 等）。

- **原型**：`pgSend`（1618）模拟流式输出——逐字/逐块插入 → 结束补 usage，**无真实请求**，仅演示交互
- **生产**：`pgSend`（`build/app.js` 1579）**真发 `POST /v1/chat/completions`**，与外部客户端走完全同一条链路：
  - 支持 `stream`：读 `response.body.getReader()` 解析 SSE，逐块追加；记录**首块延迟 TTFB**
  - 从响应头 `X-ZZCSAPI-Channel` 取实际命中渠道 → `drawRoute()` 渲染路由信息（候选渠道 / 命中 / 首块 / 总耗时）
  - 失败时把上游错误原文显示在气泡里，不吞错

### 5.8 接入信息 `vAccess`（1675）

三套协议（OpenAI / Anthropic / Gemini）的 baseURL、密钥、示例代码，代码片段用 `.code` + 页签切换（`vAccess` 1675 内）。

- **原型**：地址与密钥是文件内写死的演示值
- **生产**：`vAccess`（`build/app.js` 1861）从 `GET /admin/api/config` 取**真实**网关地址、`gatewayKey` 掩码、模型名，
  按当前 `location.origin` 拼端点 URL；页头「密钥管理」按钮 `go('keys')` 直接跳**在线轮换页**（v1.18.5，见 §5.10）；
  `showKeyHelp()`（`build/app.js` 1957）降级为**命令行备用路径**步骤清单（每条命令可单独复制，且会提醒"控制台轮换过之后 .env 说了不算"）；
  端点地址行与客户端配置表 Base URL 列均带复制按钮

### 5.9 运行期设置 `vSettings`（生产独有，原型无此页）

- 位置：「工具」组第二个页签（工具组顺序：Playground / **运行期设置** / **密钥管理** / 接入信息）。
  `NAV`（`build/app.js` 359）加一项、`go()`（383）与 `render()`（180）**两张分发表都要加** `settings:vSettings`
  —— 只加一张会出现"能进页但 8 秒轮询不刷新"（v1.18 之前自动权重页就栽在 `render()` 表漏页上，见 §8.22）。
- 结构：页头（标题 + 副标题「改完立即生效、立即落库，无需重启容器」+ 右侧「还原 / 保存设置」）→ 错误条 `.set-err`
  → `.grid.set-cards` 里四张 `.set-card`（会话粘性 / 客户端限流 / 指标端点 / thinking 回放，两排各两张）。
- 数据源**唯一**：`GET/POST /admin/api/settings`。`loadAll()`（143）把 `settings` 一起拉回来写进 `RAW.settings`，
  **单独 `.catch(()=>null)` 兜底**（端点挂了不能拖垮整页）。`RAW.settings` 缺失时页面显示「设置接口不可用」，不白屏。
- 四张卡的**唯一真源**是 `SET_GROUPS`（750）/ `SET_META`（751）/ `SET_FIELDS`（761）：加字段只改这三处，
  `setCard()`（818）按声明生成行，`setPayload()`（795）按同一份声明收集改动。字段契约见 [`console-settings-spec.md`](console-settings-spec.md)。
  第四张卡（v1.18.8）走同一条声明路：`SET_META` 的「thinking 回放」条目 + `SET_FIELDS` 的
  `ttlSec`/`maxEntries` 两旋钮 + `setStat()`（810）读 `status.thinkingReplay`（缓存条数 / 学习 / 修复命中 / 未命中 / 作废）。
- **只提交有改动的组 / 字段**（PATCH 语义，`setPayload`）：没带的不动、不归零；留空的数字不下发（留空 ≠ 0）。
  没改动时「保存设置」按钮 `disabled`。
- **400 原文直显**：`api()`（235）把 `status`/`body` 挂到抛出的 Error 上，`saveSettings()`（884）取 `e.body.error`
  写进 `.set-err` —— 后端已点名到字段，照抄给用户就能直接改。
- 提交期间按钮 `disabled` + 文案变「保存中…」（`setSaving` 幂等，避免连点造成两次写入）。
- **实时计数**来自 `status` 段：粘性命中/未命中/学习条数、在飞/峰值/限速拒绝/并发拒绝、`/metrics` 是否匿名可抓、
  thinking 回放缓存条数/学习/修复命中/未命中/作废（v1.18.8）——停在页面等轮询就会跟着刷新。
- 样式见 §4.11 的 `.set-*`（`build/extra.css` 59–80）。
- **原型 `console-redesign.html` 未同步此页**（生产独有能力，原型不追平）。

### 5.10 密钥管理 `vKeys`（生产独有，原型无此页，v1.18.5）

- 位置：「工具」组第三个页签，**夹在运行期设置与接入信息之间**（工具组顺序：Playground / 运行期设置 / **密钥管理** / 接入信息）。
  `NAV`（`build/app.js` 359）加一项、`go()`（383）与 `render()`（180）**两张分发表都要加** `keys:vKeys`——只加一张会出现"能进页但 8 秒轮询不刷新"（同 §5.9 的教训）。
- 数据源唯一：`GET /admin/api/keys`，随 `loadAll()`（143）一起拉，**单独 `.catch(()=>null)` 兜底**（端点挂了显示「密钥接口不可用」，不白屏、不拖垮整页）。
  响应里**只有掩码与来源**（`gatewayKey`/`adminKey` 各带 `masked`/`set`/`source`，外加 `rotatedAt`/`keysInsecure`/`minLen`/`noAuth`）。
- 两张密钥卡（`keyCard` 1713）：当前值掩码 + 来源角标（控制台轮换 / 环境变量 / 首启生成）+ 「显示」「复制」按钮 + 手填输入框 + 「随机生成」「轮换」。
  **「随机生成」只在本地把 48 位随机串（大小写字母+数字+特殊字符四样齐全，与服务端 `genKey` 同规格）填进输入框（`fillGeneratedKey`，用 `crypto.getRandomValues`，不发任何请求）——用户先看到/复制新值，再点「轮换」才提交生效**（服务端 `/admin/api/keys/generate` 端点保留给 API 调用方，控制台不走它）。
- **明文绝不进页面快照**：点「显示」才经 `GET /admin/api/admin-key` / `GET /admin/api/gateway-key` 现取一次（`toggleKeyReveal` 1792），只存内存 `keyReveal`，再点「隐藏」即清。
- **换管理密钥后的自我保命（v1.18.6 会话语义）**（`rotateKey` 1825）：成功后**前端什么都不用做也不再写任何浏览器存储**——
  服务端在轮换响应里**补发一枚新会话 cookie**（`Set-Cookie`，换管理密钥会清空全部旧会话，但发起轮换的这个浏览器当场拿到新会话），
  发起页无感继续用；其它标签页/设备拿旧 key（或旧会话）立即 401 弹回登录门，页面文案明示。
- **「轮换」单击直接生效**（用户明确要求，最初的"点两下确认"被否掉；页面上方警示条与按钮旁文案都写明"旧密钥立即失效"）。「随机生成」只是本地填框，不算危险动作。
  「回到环境变量值」保留两步确认（`armConfirm` 1783，第一次点击变成「确认…」，6 秒不复位自动还原）——它会把控制台轮换的成果整段交还给 .env（也会清空全部会话）。
  无论手填还是随机生成后点「轮换」，生效的那一刻所有拿旧 key 的调用方就开始 401。
- 手填草稿存 `keyDraft`（1705）并在模板回填（8 秒轮询重绘约定，见代码地图 §0.2「状态回填约定」）；成功/失败后清空。
- 「回到环境变量值」（`resetKeysAction` 1845 → `POST /admin/api/keys/reset`）：删掉 `config.json` 的 `auth` 段，把密钥控制权交还给环境变量（同时清空全部会话）。
- 后端语义：优先级链 `config.auth`（控制台轮换）**>** 环境变量 **>** 首启生成；准入规则 8–128 位可见 ASCII、禁 `change-me`、两把不得相同，**管理密钥另需大小写字母+数字+特殊字符四样齐全**（v1.18.5 从"16 位"放宽并加了管理密钥复杂度门槛）；
  轮换即清管理面失败计数。细节与真链路验证见 `test/key-rotation-e2e.test.js`（75 项断言）与 docs/behavior.md「密钥轮换」。
- 接入信息页的「轮换密钥」按钮从"只读步骤弹窗"改为 `go('keys')` 直达本页；`showKeyHelp` 降级为命令行备用路径（见 §5.8）。
- **原型 `console-redesign.html` 未同步此页**（生产独有能力，原型不追平）。

### 5.11 数据统计 `vStats`（生产独有，原型无此页，v1.18.11）

来源 IP 态势页——回答"密钥是不是被人放进了中转站在转卖"这个问题（监控 → 数据统计，紧随调用日志之后；`NAV` 生产锚点 359，`zap` 图标复用 `IC` 现有的）。

- **位置与注册**：`NAV`（359）「监控」组、调用日志之后；`go()`（383）与 `render()`（180）**两张分发表都注册了** `stats:vStats`（生产锚点 `vStats` 1347）。
- **数据源唯一**：`GET /admin/api/stats`，随 `loadAll()`（143）一起拉、**单独 `.catch(()=>null)` 兜底**（端点挂了或旧版网关显示「统计端点不可达」，不白屏、不拖垮整页）；`adapt()` 把它放进 `DATA.stats`。手动刷新按钮走 `refreshStats()`（1454，只拉 stats 一条并重绘）。
- **页面结构**（自上而下）：
  - **四张全局卡**（敲门总数 / token 输入+输出 / 全局峰值并发 vs 单来源峰值 / 封禁命中）——**全局峰值远高于任何单来源峰值 = 中转站在轮换出口**的指纹，四张卡的文案把这层对比写明了。
  - **封禁名单行**：每枚封禁 IP 一个 chip（已封禁标记 + 解封 × 按钮，`data-act="unban-ip" data-t="<ip>"`，`confirm()` 两步确认）。
  - **per-IP 表**：IP / 敲门数（含被 401/429 拒掉的——刷鉴权也是指纹）/ token / 模型数 / 并发峰值 / 会话估计（**上限 512 饱和后显示 `≥512`**，不下发裸数字）/ 客户端标签（多个 chip）/ 24 小时 sparkline。**行点击开 `openIpStats`（1421）详情抽屉**（行 `.clickable`，`tr.onclick` 直挂，`vLogs` 的先例）。**v1.18.12 版式**：表走 `.st-fixed` + 9 列 `colgroup` 定量列宽；表头与数值列 `.t-c` 居中（KPI 四卡 `.st-kpi` 内容居中、占位符「—」走 `.t-c-ph`，真名左对齐——见 §4.12）。
  - **按模型聚合卡**：全局视角哪几个模型在被谁打。
  - trustedProxy 模式显示「反代采信：x.x.x.x」条（直连模式不显示）。
- **`openIpStats(ip)` 详情抽屉**：per-IP 键值（敲门 / 封禁命中 / token / 会话 / 首末见）+ 客户端标签 chips 带计数 + 模型 chips 带计数 + **24 小时分布面积图**（`areaChart` 复用，本地时区整点桶）+ 底部**封禁/解封按钮**（未封禁 IP 显示「封禁该来源」，已封禁显示「解封该来源」；`confirm()` 两步确认——`clearUsage` 的先例，不用 armed 状态）。
- **客户端过滤 `stFilter`（1345，模块级、跨页保留）**：调用日志客户端列跳进来（或统计页内点 chip）时只留匹配来源；**v1.18.13 起从调用日志跳进来还会直接弹开最活跃匹配来源的抽屉**（`ips` 按敲门数降序 → `hit[0]`，抽屉里的客户端标签 chips 带计数——"这个客户端属于哪个 IP、用了多少次"当场就有答案）；页头显示「客户端：X ✕」chip，✕ 清除（`data-act="clear-st-filter"`）。无匹配时空态文案点明是"该客户端"的空态（区别于全网关刚清零），**且不误弹任何抽屉**。
- **封禁/解封动作**：`banIp`（1457）/`unbanIp`（1461）走 `POST /admin/api/bans` / `DELETE /admin/api/bans/{ip}`，成功后 `refreshStats()`；按钮一律 `data-act` + `data-t`（IP 经服务端字面量校验，渲染仍 `esc()`）。
- **转义与安全**：客户端标签是外部可控值（UA 截断，不消毒）→ 一律 `esc()`；IP 是服务端校验过的字面量，仍照 `esc()` 纪律过一遍。
- **后端语义**：统计**内存态**（重启清零、留存有界：IP 512 / 会话 512 / 标签 8 / 模型 64）；封禁**只拦客户端面**（管理面/控制台/健康检查永远可达——解封按钮永远不会把自己锁在门外）；`X-Forwarded-For` 只在 `config.security.trustedProxy` 登记的来源上采信第一跳。详见 docs/behavior.md「来源 IP 态势统计与封禁」与 `test/ip-stats-ban-e2e.test.js`（62 项）。
- **原型 `console-redesign.html` 未同步此页**（生产独有能力，原型不追平）。

---

## 6. 交互流程

### 6.1 添加 / 编辑渠道 `openChannelForm(id)`（1815）

```
openChannelForm()        新增：清空表单，协议默认 openai，权重默认 0
openChannelForm(id)      编辑：回填，id 字段 disabled
  ├─ 基础信息   渠道ID / 显示名 / 协议 / 优先级 / 权重 / 启用
  ├─ 连接信息   Base URL（随协议切换默认值）/ 代理 / 密钥（掩码↔明文）
  ├─ 模型别名   renderModelRows 渲染 alias→upstream 双列，可增删、可单行测试
  └─ 上游探测   probeUpstream → renderProbeList
```

**「权重」输入框（`f-weight`，v1.5）**：

- 与「优先级」并排，`type=number min=0 step=1`，label 旁小字 `0 = 不参与`，`title` 里写明分工：
  **优先级管"谁先试"，权重管"按比例分"**（3:1 ⇒ ≈75%/25%）——两个概念最容易混，所以说明直接挂在控件上。
- 保存时 `weight` 显式进 body（留空 = `0`）。这条很关键：upsert 对**缺省字段保留旧值**（PT29），
  若表单不提交该字段，用户"把权重清空"会被旧值悄悄还原。前端还先挡非数字/负数
  （`Number.isFinite` + `<0`），不让它去撞后端 400。
- 抗重绘：渠道表单是**弹窗**（`#mask` 挂 body，在 `#viewport` 之外），不受 8 秒轮询重绘影响，
  因此不需要像 `chQ`/`pgDraft` 那样存 JS 变量回填（见代码地图 §0.2「状态回填约定」）。

**「不发这些参数」输入框（`f-drop`，v1.18.33）**：

- 逗号或空格分隔的参数名，**出站前从这家渠道的请求报文里删掉**（渠道级，不是全局）；抽屉里同步显示该渠道已配的清单。
- 输入框下方跟一排 **chips = 服务端下发的合法参数名**，点一下把名字填进框（`data-act="fill-drop-param"` + `data-k`，走 v1.18.7 的事件委托；`ACTS` 表 48 → 49）。清单**只从 `GET /admin/api/config` 的 `dropParamWhitelist` 取**，前端**不抄第二份**（抄了会漂移：后端加了名字、前端还按老清单渲染，用户点不到也看不出为什么）。
- **框空 = 显式提交 `[]` = 清空**——与上面 `weight` 的"留空 = 不动"**刻意不同**：这个框没有"我没意见"的中间态，空就是"什么都不剔除"。
- 白名单外的名字后端 **400 并回带合法清单**（不静默忽略）；`workbuddy`/`codex`/`genspark`/`notion-agent` 自带专用报文构造，配了**不生效**。
- 动机与现场见 §8.40（`agentrouter` 对「`tools` + `reasoning_effort`」直接 400，而客户端每次请求都同时带这两样）。

**上游探测列表**（本轮重做，替代原来的 chip 逐个点击）：

- 面板 `.probe-panel`：搜索框 + 可滚动列表（`max-height:212px`）+ 底部计数与批量按钮
- 已存在的别名行标 `.have`（半透明 + 不可勾选），避免重复添加
- 支持**搜索过滤** `filterProbeRows`、**全选** `probeSelectAll`、**清空** `probeClearSel`、**批量加入** `probeAddSelected`
- **原型**：`probeUpstream`（1910）从 `PROBE_POOL`（1783，约 46 个模型）取数，贴近真实中转站规模
- **生产**：`probeUpstream`（`build/app.js` 2131）真发 `POST /admin/api/probe`，
  返回的是**该渠道上游真实的 `/v1/models` 清单**；搜索/全选/批量逻辑与原型同构。
  ⚠️ 注意 `server.js` 的探测协议白名单——曾漏 `workbuddy` 导致误报失败

### 6.2 导入（四类）

`IMPORT_META`（2033）驱动同一套弹窗骨架，`mode` 决定形态：

| kind | 名称 | 形态 | 要点 |
| --- | --- | --- | --- |
| `codex-rt` | 导入 Codex RT | 粘贴 | 校验必须以 `rt.1.` 开头；提示 RT 一次性轮转 |
| `codex-json` | 导入 Codex JSON | 文件（多选） | 兼容扁平 / `credentials` / `accounts[]` 三种结构 |
| `gs-session` | 导入 Genspark 会话 | 粘贴 | 正则提取 `uuid:hex`；提示 session 约 20 天过期 |
| `gs-json` | 导入 Genspark JSON | 文件（多选） | 同 key 视为刷新，不重复建渠道 |

- 粘贴式 `doImport`：分步状态动画（换令牌 → 拿账号 → 拉模型 → 建渠道）
- 文件式 `importFiles`：逐个文件解析，逐行输出成功/失败结果与原因
- 解析容错集中在 `parseCodexUnits`（2051）与 `parseGsSessionId`（2059），**改动务必保留多结构兼容**

**生产侧（`build/app.js`）**：`IMPORT_META` 在 2302，弹窗骨架与原型同构，但**去掉了假步骤动画**，改为真实请求：

| kind | 生产函数 | 真实端点 |
| --- | --- | --- |
| `codex-rt` / `codex-json` | `importCodexRt(rt)` 2370 | `POST /admin/api/codex-import` |
| `gs-session` / `gs-json` | `importGsSession(raw)` 2375 | `POST /admin/api/genspark-import` |

- `doImport` 2381 / `importFiles` 2401 都直接转发给上面两个函数，逐条回填真实结果
- 原型的 `hash(s)`（2115，造假渠道 ID）**生产侧已删除**
- 解析容错逻辑与原型一致（同样的 `parseCodexUnits` / `parseGsSessionId`），改一处要两处同步

### 6.3 测试模型 `openTestModels(opts)`（2167）

- 支持 `{channelId}` 预筛（从渠道行/抽屉进入时只显示该渠道的模型）
- 分组多选列表 `.test-list`（分组头 sticky）+ 提示词输入
- `runTests`（2213）逐条执行：先插"等待"行 → 出结果 → 替换为成功/失败行 → 汇总"x/y 通过"
- **停用渠道同样可测（v1.13）**：停用只是"不参与调度、不参与自动探测"，不代表不能手动打一发验证模型还活着。
  弹窗按 `DATA.channels` 里**全部**渠道构造（不再 `if(!c.on)continue`），停用渠道的分组头带「已停用」标签，
  且当列表里含停用渠道时补一行说明："手动测试照打，测通也不会因此启用它，且停用渠道不参与自动探测"。
  全局入口（不带 `channelId`）也包含停用渠道，但**启用渠道排在前面**（先看能用的，停用的垫底）。
  每条测试报文照旧带 `channelId`（不走调度），所以测停用渠道不会把请求交给别人、也不会改真实分流。
- **结果行必须自己说明白（v1.13 二修）**：用户原话"我不知道哪个是成功的哪个是失败的。完全不知道测试的是哪个模型。"
  一个渠道挂多个模型时，旧渲染每行只写渠道名 ⇒ 四行长得一模一样，根本认不出测的是谁；而成功/失败只靠**颜色**
  区分，其中"HTTP 200 但回复为空"还被当成**成功**渲染成一对空引号。现在每行是：

  ```
  ✓  [free]kimi-k3 @ 虎哥 · 通过 · 11.3 s · 687+49 tok        "Hi there! How can I help you today?"
  ○  [free]kimi-k3 @ 虎哥 · 空回复 · 9.66 s · 636+16 tok      （HTTP 200 但回复为空 —— 模型没说任何话）
  !  [free]kimi-k3 @ 虎哥 · 失败 · 15.5 s · HTTP 400          The provider rejected the request…
  ```

  三档由纯函数 `testRowVerdict(row)` 判定（有回复=`ok` / 2xx 但空=`empty` / 其余=`fail`）：
  **空回复既不算通过**（会让人以为模型正常）**也不算失败**（会让人去查网络）——单列一档，用中性色 `.r.wait` 显示
  （复用设计稿已有样式，不新增 CSS、不动行号偏移）。图标用已有的 `check` / `clock` / `warn`。
  汇总行同步改成"通过 a · 空回复 b · 失败 c（共 n 个 · 提示词「…」）"，不再只报一个 `x/y 通过`。

- **原型**：`simTest`（2154）按渠道状态与历史失败率**伪造**成功或失败（停用/不可用 → 502；失败率≥50% → 429），
  回复文案取自 `REPLIES`（2153）
- **生产**：`runTests`（`build/app.js` 2504）改为真实 `POST /admin/api/test`（body `{model, channelId, prompt}`），
  逐条渲染真实 `latencyMs` / `promptTokens` / `completionTokens` / 上游回复或错误原文。
  原型的 `simTest` 与 `REPLIES` **生产侧已删除**；跑完会 `loadAll()` 刷新一次数据
- ⚠️ **原型未同步（有意）**：`console-redesign.html:2175` 的演示版 `openTestModels` 仍是旧的 `if(!c.on)continue;`，
  设计稿里点 3 个 demo 停用渠道仍会看到空列表。生产侧才是真实控制台；要动原型请连带重核 §1/§3 的行号锚点

### 6.4 全局交互

| 交互 | 实现 |
| --- | --- |
| `Esc` | 有弹窗先关弹窗，否则关抽屉（原型 2247–2252） |
| `Cmd/Ctrl + K` | 聚焦全局搜索框 |
| 全局搜索回车 | 关键词写入 `chQ` 并跳转渠道页（原型 2261） |
| 主题切换 | `#themeBtn`，写入 `localStorage['zzcs-theme']`，刷新保持 |
| 点击菜单外部 | 关闭所有下拉菜单（原型 1772） |
| 复制按钮 | 统一走 `copyText(t,btn)`（`build/app.js` 264）：安全上下文用 `navigator.clipboard`，否则回落到 `execCommand('copy')`；待复制文本一律经 `data-t="${esc(x)}"` 注入，不要用 `JSON.stringify` 直接拼进属性 |

---

## 7. 与后端对接（原型 → 生产）

原型中每个"假动作"对应的真实接口（详见 `server.js` 与 `console.html`）：

| 原型 | 生产接口 | 备注 |
| --- | --- | --- |
| `DATA` 常量 | `GET /admin/api/status` | 渠道状态、用量、探测时间。**v1.6 起同一响应还带自动权重观测**：顶层 `autoWeight`（`enabled` / `effective` 恒 `false` / `knobs` / `at` / `models[]`，模型下挂 `candidates[].share·h·nowShare` 与 `excluded[]`）与每渠道 `autoH` / `autoFailRate` / `autoSamples` / `autoLatMs` / `autoSpeedRatio` —— 控制台**只读展示**，不写回、不影响调度 |
| `toggleCh` / `saveChannel` / `delChannel` | `POST /admin/api/channel`（局部改）/ `POST /admin/api/channels`（upsert）/ `DELETE /admin/api/channels` | 启停·优先级·**权重 `weight`** 走前者（立即生效并持久化），增改走 upsert，删除带 `{id}`。**v1.5 起渠道表单有「权重」输入框**（`f-weight`，留空 = 0 = 不参与），`weight` 随 upsert body 一起提交；负数/非数字前端先挡下，后端同样拒（400）。⚠ upsert 在 body 未带 `weight` 时保留旧值（见 PT29）——表单始终显式提交该字段，所以"清空权重"是**真的置 0**，不会被旧值悄悄还原 |
| `reprobe` / 全量重探测 | `POST /admin/api/recheck` | body 可带 `{id}` |
| `probeUpstream` | `POST /admin/api/probe` | 注意协议白名单（曾漏 `workbuddy` 导致误报） |
| `simTest` / `runTests` | `POST /admin/api/test` | 需覆盖各协议分支 |
| `doImport` / `importFiles`(codex) | `POST /admin/api/codex-import` | RT 全自动建渠道 |
| `doImport` / `importFiles`(genspark) | `POST /admin/api/genspark-import` | 提取 `sessionId` 换 key；`mode:'add'` 一会话一渠道 |
| 用量明细 / 清零 | `GET /admin/api/usage` · `POST /admin/api/usage/clear` | 总用量 / 按模型 / 按渠道 / 按天（**北京时间日**，v1.18.36 起）/ 24h 分布（**北京时间小时**） |
| `pgSend` | `POST /v1/chat/completions` | 支持 `stream` |
| Playground 生图 | `POST /v1/images/generations` | 需上游支持图像接口 |
| （控制台未消费） | `GET /metrics` | **v1.17 新增**：Prometheus 文本格式（零依赖）。供 Prometheus/uptime-kuma 一类外部抓取，控制台**不读它**（渠道/令牌/耗时这门数据控制台走 `/admin/api/status` 与 `/admin/api/usage`）。默认要 `ADMIN_KEY`；`metrics.public:true` 才匿名。渠道标签用**渠道 id**，所以即使接进 Grafana 也不会把渠道名带出去 |
| 「运行期设置」页（**v1.18 已实现**，见 §5.9；v1.18.8 增第四组） | `GET/POST /admin/api/settings` | **v1.18 新增**：读写 `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay`（v1.18.8 增）四组开关（窄口，字段白名单 + 严格类型）。GET 的 `config` 段回填表单、`effective` 段显示钳制后生效值、`status` 段给实时计数；POST 是 PATCH 语义，**立即生效 + 立即落库**。前端按 [`console-settings-spec.md`](console-settings-spec.md) 的规格实现：四张卡 + 只提交有改动的组 + 400 原文直显 + 跨轮询保留输入 |
| 「密钥管理」页（**v1.18.5 已实现**，见 §5.10） | `GET /admin/api/keys` · `POST /admin/api/keys` · `POST /admin/api/keys/generate` · `POST /admin/api/keys/reset` · `GET /admin/api/admin-key` | **v1.18.5 新增**：控制台在线轮换 GATEWAY_KEY / ADMIN_KEY。GET 只回**掩码 + 来源**（console / env / generated / none）；POST 立即生效并写入 `config.json` 的 `auth` 段（控制台「随机生成」是本地填框，不走 generate 端点）（**优先级高于环境变量**），**旧密钥立即失效**；新明文只在响应的 `newKeys` 里回这一次；reset 删掉 `auth` 段把控制权交还给环境变量 |
| 登录门 / 「退出登录」（**v1.18.6 已实现**，见 §8.29） | `POST /admin/api/session` · `DELETE /admin/api/session` | **v1.18.6 新增**：管理密钥登录门换会话——POST body `{key}` 交一次 `ADMIN_KEY` 换回 `HttpOnly + SameSite=Strict` 会话 cookie（`zz_session`，12 小时，**刻意无 `Secure`**：http 本地/局域网部署，加了反而种不下去）；端点在管理面鉴权闸门**之前**（登录时手里还没有会话），登录失败计入 admin 失败限流（NOAUTH 放行）；DELETE 只杀自己那枚 token 并过期 cookie，其余方法 405。轮换/重置管理密钥会清空全部会话，轮换响应**补发新会话**给发起轮换的浏览器 |
| 「数据统计」页（**v1.18.11 已实现**，见 §5.11） | `GET /admin/api/stats` | **v1.18.11 新增**：来源 IP 态势快照——`global`（敲门 / token / 峰值并发 / 封禁命中 / 活跃来源数）+ `ips[]`（per-IP 敲门 / token / 模型 / 并发峰值 / 会话估计 / 客户端标签 / 24 小时桶，按敲门降序）+ `banned` + `models[]` + `trustedProxy`。**内存态，网关重启清零**（检测数据丢得起）；敲门计数在鉴权之前（401/429 也算敲门）；per-IP token/模型记账只在 `recordUsage` 单漏斗（成功用量才记账）。随 `loadAll()` 拉取、单独兜底 |
| 封禁 / 解封（**v1.18.11 已实现**，见 §5.11） | `POST /admin/api/bans` · `DELETE /admin/api/bans/{ip}` | **v1.18.11 新增**：IP 字面量校验（非法 400 点名）、幂等、立即生效 + 落库（`config.security.bannedIPs`，重启不丢）；解封不存在 404。**只拦客户端面**（`/v1` `/anthropic` `/gemini` 一律 403，闸门在 Host/Origin 门之后、限流之前）——被封请求不占并发额度但**照常计入封禁命中数**（封了之后对方还在敲，看得见）；管理面/控制台/健康检查**永远可达**（解封按钮不会把自己锁在门外） |

**回填时的注意事项**：

1. `fakeKey()` / `maskKey()` 是原型专用，真实密钥来自后端，**必须删除假密钥逻辑**
2. 密钥明文显示是敏感操作，回填时保持"默认掩码 + 手动切换 + 可复制"的交互，不要默认明文
3. 鉴权（**v1.18.6 会话化**）：浏览器把 `ADMIN_KEY` 交给 `POST /admin/api/session` **一次**换回 `HttpOnly + SameSite=Strict` 会话 cookie，之后同源自动随行，密钥不进任何浏览器存储；脚本/curl 走 `Authorization: Bearer <ADMIN_KEY>`。~~`?key=` 收进浏览器本地~~（v1.0–v1.18.5 的做法，渗透报告点名"密钥进浏览器历史"，v1.18.6 起拆除）
4. `DATA` 就地修改的模式不能沿用——真实环境应改为"请求 → 更新本地 state → 重绘"

> **回填状态（v0.4，v0.5 续修）**：以上四项均已满足。
> 生产侧用 `chKey(id)`（`build/app.js` 1960）从真实渠道对象取密钥，**没有任何假密钥逻辑**；
> `DATA` 改由 `adapt()`（59）从 `/admin/api/status` 响应派生，`loadAll()`（141）统一拉取后重绘（v1.18.11 起同一响应集还拉 `stats`，单独兜底）。
> 生产独有能力（genspark 双导入、渠道级自定义请求头、密钥明文切换、有效优先级角标、
> 渠道权重输入框与分流占比、自动权重观测卡、真实 Playground / 测试 / 导入请求、端点地址与密钥一键复制、
> 只读的密钥轮换步骤弹窗）原型里没有，**原型不必追平**。
> v0.5 补了复制链路的两个坑（属性注入被截断、非安全上下文下 `navigator.clipboard` 静默失效），见 §8.5。

---

## 8. 变更日志

> **日期纪律（v1.18.33 起为强制）**：本节每条的日期必须等于**引入该版本的提交日期**（取法见代码地图 §1.2 同源的 git log --date=short --pretty='%h|%ad|%s'，按版本号匹配提交标题），**不要手填**。此前有 19 条日期比提交日期早 3–5 天，其中 v1.18.20 / v1.18.23 / v1.18.24 三条甚至写成了**未来日期**（10-05 / 10-07，而当天是 10-04），已于 v1.18.33 按提交日期统一校准——uthor date 与 committer date 逐条一致，所以这不是 rebase 造成的，是手填漂移。教训：**能由仓库自身事实推导的字段，就不要手写第二份。**

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
| 3 | 前端#1（信任边界）：`openModel`/`copyCurl` 3 处把模型名内联进 `onclick` JS 字符串——恶意中转站 `/models` 返回毒模型名、用户从「探测加入别名」后，点击即在控制台源执行（可偷 `sessionStorage.adminKey`，v1.0 起该密钥同时存于 localStorage，威胁同理；**v1.18.6 追记**：该存储面已随会话化拆除——管理密钥不再进浏览器，XSS 只偷得到 JS 读不到的 HttpOnly cookie，且 `connect-src 'self'` 兜底防外发）；`esc()` 挡不住：HTML 属性先解码实体再进 JS | 内联 JS 字符串插值 | 3 处统一改 v0.5 已有的 `data-* + dataset` 模式：`data-m="${esc(名字)}" onclick="openModel(this.dataset.m)"`（模型表格行原本连 esc 都没有，一并补上） |
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
活体标本：`deepseek-v4.1-flash-free` 有两个候选渠道（按延迟排序，第一个更快），排第一的渠道别名表写了该模型但探测清单早已没有 → 上游 404 →
改前实测客户端直接收到 `Unknown model. See <该渠道上游域名>/models`，第二个候选根本没被试。

根因：`tryChannel` 的 4xx 分类白名单 `[401,402,403,408,429]` 漏了 404。该名单语义 = "渠道侧问题（跨渠道各不相同）→ 切下一候选"，
名单外 4xx（400 参数错等）= "换渠道也一样错 → 原样透传"。404（该渠道没有此模型）属于前者却被归进后者。
同款判据共**五处**（generic tryChannel 2494 / workbuddy 2726 / genspark 2940 / codex 3270 / notion 3391——第五处 notion 是跨 agent 诊断也没数到的）。

处置：五处白名单统一改为 `[401, 402, 403, 404, 408, 429]`；generic 与 genspark 两处分类注释同步改写；
README §4xx 重试规则行改写（顺带修正了原文档把 401/403 写成"不再切渠道"的陈旧描述——代码里它们一直是在切的）。
**没有**采用"仅当还有候选才透传 4xx"的更激进方案：那会让真正的 400 参数错在所有渠道上重打一遍、并把每个渠道都记一次失败降权——
为一个客户端错误惩罚全部渠道。404 进名单是零附带损伤的最小修：400/422 的透传语义原样保留。

行为变化（已知且接受）：全部候选都 404 时，客户端从"收到某个渠道的裸上游 404"变为"网关自己的 502 all channels failed + attempts 明细"——与网关错误契约一致。

验证（前后对比实测）：改前基线 `deepseek-v4.1-flash-free` → 404 `Unknown model`（排第一的候选透传，第二个候选未试）；
改后同请求 → **200，X-ZZCSAPI-Channel: <第二个候选>**（第一个候选 404 → 兜底命中真有该模型的渠道）✓。
真客户端错误回归：`messages: []` + 已配模型 → 上游 400 **立即透传**，未逐渠道扫描 ✓。常规聊天 / healthz 30 渠道回归 ✓。

> 顺带观察（上游侧问题，非本修复范围）：某个候选渠道的免费池当晚对 `deepseek-v4.1-flash-free` / `glm-5.3-free` 均返回
> HTTP 200 + `content:null`（finish_reason=length/refusal）——"活着但不干活"。周期探测只测 `/v1/models` 探不不出这种退化。
> 已向用户标记：属探测盲区（"空回复不算失败"），若频繁出现可考虑给网关加空回复判失败的规则，先不动。

---

### 8.10 v1.0 分享场景加固：首启密钥生成 + 控制台登录门（2026-09-27，对象 `server.js` + `build/app.js` + `docker-compose.yml` + `.env`/`.gitignore` + 产物 `console.html`）

问题（用户提出"项目分享出去，这个 key 应该是什么样子"）：密钥全靠环境变量，而 `docker-compose.yml` 里写的是**公共默认值**
`${ZZCSAPI_ADMIN_KEY:-<写死的公共字符串>}` / `${ZZCSAPI_GATEWAY_KEY:-<写死的公共字符串>}`——收到项目的人不配置就直接跑，
于是**每个部署都用同一把写在公开仓库里的管理密钥**（v1.0 起 compose 默认留空，手上那份具体字符串不再写进文档）；更糟的是 `checkAuth` 里"key 为空则放行"，空密钥比公开密钥还危险。
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

### 8.12 v1.0.2 公开发布前的脱敏：原型演示数据里的真实渠道身份（2026-09-26，对象 `console-redesign.html` + `docs/*.md` + `test/console-state.test.js` + `.gitignore` + 产物 `console.html`）

**问题**（用户提出"项目推到 GitHub 给别人用，但不能把我已添加的渠道也传上去"）：
仓库里除了运行时的 `config.json`（本来就被忽略）之外，还有**三处把真实渠道身份带进了版本控制**：

| 载体 | 内容 |
| --- | --- |
| `console-redesign.html` 的 `DATA` 演示快照 + **静态占位渠道表**（583–783 行） | **全部 30 条真实渠道**的 id 与名称（含用户自起的中文名）被当成"演示数据"写死在这里 |
| `console-redesign.html` 的 CSS + 上面两处的密钥演示 | 每条渠道的专属 chip 配色选择器（`.chip.<channelId>`）；`copyText('…')` 里直接放的是**现网 GATEWAY_KEY 字面量**，安全提示里还写着现网 ADMIN_KEY/GATEWAY_KEY |
| `docs/PONYTAIL_REVIEW.md` / `docs/frontend-console-detailed.md` + `test/console-state.test.js` | 整改记录与测试桩里出现现网密钥字面量与真实渠道 id |
| `config.json.bak`（**曾被 git 跟踪**） | `server.js` 每次持久化前会把 config.json 复制一份，里面是**全部渠道的明文 apiKey**；`.gitignore` 只写了 `*.bak-*`（带横杠）没写 `*.bak`，于是被误提交 |

**根因**：把"看起来真实的演示数据"当成了原型的一部分——它确实让原型更像真的，但它同时是**用户真实配置的副本**；
而 `.bak` 的忽略规则写窄了一个字符，让运行时会自动生成的密钥备份文件混进了版本控制。

**处置**

| # | 触点 | 处置 |
| --- | --- | --- |
| 1 | `console-redesign.html` 的 `DATA.channels/models/logs` | 整块换成 9 条中性演示渠道（`demo-openai-a/b/c`、`demo-anthropic`、`demo-gemini`、`demo-notion`、`demo-notion-agent`、`demo-workbuddy`、`demo-genspark`），覆盖全部协议；`meta` 计数同步 |
| 2 | 静态占位渠道表 19 行 | 按"每个演示渠道一行"去重为 10 行，页签计数改 9/6/3 |
| 3 | 真实 id / 名称 / 头像 | 按**同协议一对一**映射替换（保证 chip 协议自洽）；头像只在 `<span class="avatar…">` 容器内替换；`.chip.<channelId>` 选择器一并改名 |
| 4 | 与协议同名的 id（`workbuddy` / `genspark`） | **不替换**——它们是协议本身的标识，`PROTO_META` / `PROTO_ORDER` / chip 类名 / README 里本来就有；替换反而会破坏协议语义 |
| 5 | 现网密钥字面量 | 原型里的复制按钮改 `zz-gw-your-key-here`；"安全提示"文案改为"尚未配置密钥 → 启动时自动生成"（与 v1.0 的真实行为对齐，原文案已过时）；两份文档里的字面量换成占位/变量名 |
| 6 | `test/console-state.test.js` 桩数据 | 真实渠道 id / 模型名 → `stub-alpha`/`stub-beta`、`demo-model-a/b`（断言字符串同步改名） |
| 7 | `config.json.bak` | 移出仓库留档（`D:\DSHXM\_zzcsapi-private\`），`.gitignore` 补 `*.bak` |
| 8 | 文档锚点 | 按 §1.1 重算：`<body>` 段因静态表去重 −144 行、`DATA` 块因演示数据收缩再 −27 行；code-map §1/§3 全部锚点已逐条核对（脚本比对 100+ 个锚点） |

**验证**：脱敏脚本自校验「真实 id / 名称 / 头像 / 中文名前两字 / 密钥字面量」全部归零；
`node build/build.js` 重建产物一致；`node test/console-state.test.js` 27/27 通过；code-map 锚点脚本逐条比对通过。
`server.js` 只动了两行**注释**（把举例里的真实渠道 id 泛化），运行时行为零影响；`build/app.js` 未动。
活体 `healthz` 仍 30 渠道、admin 接口 200、网关 `/v1/models` 200（密钥照旧可用，无需轮换），即为证。

> 发布形态：本地 `master`（含真实配置历史）**不外推**，只把脱敏后的单提交快照推到公开仓库；
> `.env` / `config.json` 从来不在版本控制内，用户的密钥无需轮换。

#### 8.12.1 追补：脱敏脚本的过度替换（自查发现并修复，2026-09-27 同日）

**问题**：第一版脱敏脚本对"渠道 id / 名称"做**全局子串替换**，而用户有若干渠道的名字与代码里的合法标识符**重名或互为前缀**，于是脚本把不该改的地方也改了：

| 事故 | 撞车原因 | 后果 |
| --- | --- | --- |
| `.chip.workbuddy{…}` → `.chip.演示 WorkBuddy 逆向{…}` | 渠道名 `workbuddy` 与协议名/chip 类名同名 | **生产 CSS 选择器失效**，WorkBuddy 渠道的 chip 配色退回默认（唯一会影响运行的损伤） |
| 字体 CDN 地址被写坏（`cdn-file.<主机名>.mi.com` 里插进了演示名） | 渠道名恰好是字体 CDN 主机名的前缀 | 原型 `<head>` 的字体地址失效 |
| 互为前缀的兄弟渠道被串位（形如短 id 把长 id 一起吃掉） | 兄弟渠道的 id / 名称互为前缀，替换顺序未按长度降序 | 演示数据出现串位（3 组） |
| 24 处 `toggleCh('…')` / `channelId:'…'`、6 处 `.cell-sub`、1 处头像 span、2 处日志 `p:` 字段、图例数组、协议清单文案 | 把"显示名"填进了需要"渠道 id / 协议名"的位置 | 原型点击交互传参错、文案变成演示名 |

**根因**：全局子串替换 + 标识符重名。"看起来像演示数据"的替换在跑之前无法判断某个词是**数据**还是**代码标识符**。

**处置**（两轮，每处都断言命中数，全部为同行替换）：
1. 第一轮 3 处：复原 `.chip.workbuddy`、`class="chip workbuddy"`、`cdn-file.hyperos.mi.com`；
2. 第二轮 38 处：协议语境还原 `workbuddy`（4）、日志 `p:'workbuddy'`（2）、chip 图例数组改为 4 个互不相同的演示 id（1）、需要渠道 id 的上下文换成演示 id（30）、头像 span 收回两字缩写（1）。
3. 行数保持不变（2444 行的脱敏前版本 → 2273 行），因此 §3 的行号锚点**无需重算**，已抽样复核与记录值逐条一致。

**验证**：新增"枚举审计"脚本（把每个演示名在全文的出现位置按上下文分类，正常位置只有 `cell-name` / `h3` / `DATA.name` / `option` 文本）——事故桶**归零**；
`.chip.<X>` 选择器仅剩协议名 + `accent`；`node build/build.js` 重建产物（140893 字符）；`node test/console-state.test.js` 27/27；
全树泄漏扫描仍**零命中**。

**教训**：脱敏必须"按上下文替换 + 每处断言命中数 + 事后枚举审计"三段式；全局子串替换在 id/名称与标识符重名的项目里必然出事，而**自校验脚本用同一套正则去检查**时会把事故一起遮蔽（本次自校验就因为"先 mask 掉 `class="chip …"` 再检查"而漏掉了 chip 类名被改坏）。

---

### 8.13 v1.5 控制台权重：能填、能存、能看见分流结果（2026-09-27，对象 `build/app.js` + 产物 `console.html` + `server.js` PT34）

v1.3 把加权轮询算法做进了后端（`weight` 真的按比例分流），但**控制台没有入口**：
README 只能教你"改 `config.json` 或 curl 打 `POST /admin/api/channel`"，而且配完**看不见效果**
（`weightedHits` / `weightedShare` 只在 `/admin/api/status` 的 JSON 里）。本轮把它补齐。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 渠道表单没有权重输入框，改权重必须手改配置文件 | v1.3 只做了后端；前端表单字段与 `saveChannel` 的 body 都没有 `weight` | 表单加 `f-weight`（与优先级并排，`0 = 不参与`，`title` 写明"优先级管谁先试、权重管按比例分"）；`saveChannel` 把 `weight` 显式放进 body（留空 = 0） |
| 2 | **清空权重会被旧值悄悄还原**（潜在） | upsert 的语义是"缺省字段保留旧值"（PT29 的修复），而表单若用 `|| undefined` 拼字段就等于"没提交" | 表单**始终**提交 `weight`（空串 → `0`），于是"清空"是真的置 0；已在 §7 映射表标注这条坑 |
| 3 | 负数/非数字权重会打到后端才被拒 | 前端无校验 | `Number.isFinite(w) && w >= 0`，不合法直接 toast（`留空 = 0 = 不参与加权轮询`），**一条请求都不发** |
| 4 | 配了权重看不到分流效果 | `adapt()` 没接 `weight`/`weightedHits`/`weightedShare`，表格没列 | `adapt()` 映射为 `w`/`wHits`/`wShare`；渠道表加「权重 / 分流」列（`3 · 24%`，悬停看命中次数）；详情抽屉加角标（`权重 3 · 分流 24% (12 次)`） |
| 5 | 未配权重的渠道若显示 `0%` 会被误读 | 直出 `wShare`（0） | 权重 0 显示 `—` + "未参与加权轮询"提示，**不显示百分比** |
| 6 | 控制台删光渠道后，网关重启起不来（PT34） | `loadConfig` 要求 `channels.length > 0`，而 `persistConfig` 删掉最后一个渠道后写回的就是 `"channels": []`，报错信息还误导成"缺少 channels 数组" | 只校验 `Array.isArray(cfg.channels)`；空数组是合法配置 |

**抗重绘**：渠道表单在**弹窗**里（`#mask` 挂 body，位于 `#viewport` 之外），8 秒轮询只重绘
`#viewport`，因此不需要把 `f-weight` 存进 JS 变量回填；已在 §6.1 与代码地图 §0.2「状态回填约定」处写明这条边界。

**验证**：
- `node test/console-state.test.js` 27 → **38 项**（新增第 3 节：`adapt()` 接三个字段、表格显示 `3 · 24%` 与 `—`、
  `saveChannel` 报文带 `weight`、空值 = 0、负数与非数字**不发请求**）；
- `node test/console-weight-e2e.test.js` **18 项**（新增，真链路）：控制台报文 → 真网关落库（**含断言权重真的写进
  `config.json`，未配权重的渠道不会多出一个 `"weight": 0`**）→ `/admin/api/status` →
  `adapt()`+`drawChTable()` 那一格 → 真发 24 次请求让占比动起来；含"权重改 0 后立刻退出池、hits 不再增长"与
  "负数绕过前端也被后端 400"；顺带断言零渠道配置能启动（PT34）；
- 全量回归 **11 文件 / 382 项**全绿（`anthropic-tools` 60 · `anthropic-tools-e2e` 30 · `console-state` 38 ·
  `console-weight-e2e` 18 · `gemini-multimodal` 41 · `gemini-multimodal-e2e` 22 · `native-channels` 78 ·
  `native-channels-e2e` 33 · `streaming-e2e` 19 · `weighted-rr` 31 · `weighted-rr-e2e` 12）；
  `git diff console.html` 与 `build/app.js` 的改动行数一致（构建是纯拼接）。

**顺手修掉的测试基建缺陷（不修会掩盖真回归）**：6 个 e2e 脚本在 `cleanup()` 刚 `kill()` 子进程就
`process.exit()`，Windows 上会撞到还没关干净的 libuv 句柄，以 `0xC0000409` 崩溃——
**断言全绿却返回失败退出码**（实测 3 次里崩 2 次，且随机）。改为 `await stopChild(gw)`（等 `exit` 事件，
1.5 秒兜底）+ 结尾只设 `process.exitCode`，让事件循环自然排空。修补后 6 个脚本 × 3 轮 = 18 次全部退出码 0。

**没做的事（如实记）**：原型 `console-redesign.html` **未同步**这个输入框——按既有约定
"生产独有能力原型不必追平"（原型是视觉真源，不参与接口对接）。所以原型里仍看不到权重列/输入框，
想对照视觉请直接看生产控制台。

**顺手修掉的文档腐烂（本轮核对锚点时发现的既有问题，不是本轮引入的）**：本文档 §5 / §6 里的**原型行号锚点**
整体漂移了 100 行以上——原型在 v0.7 / v0.8 / v1.0.2 删过行，锚点没跟着重算。例如 §5.3 写 `vChannels`（1351），
实测 1179；§6.1 写 `openChannelForm`（1993），实测 1820；§5.1 写 `vOverview`（1241），实测 1069。
已用 AGENTS.md §1.2 的导出命令逐条实测并修正 **29 处**（每条都断言"命中恰好 1 次"才写入），
生产侧的 `dChip` 386 / `kpiCard` 335 / `probeUpstream` 1459 也一并校准；
`docs/frontend-code-map.md` §5 修改路由表里同一批漂移锚点已修正，并新增「渠道权重」一行。

---

### 8.14 v1.6 自动权重（观测版）：只算不生效，先把"若启用会怎么分"摆在明面上（2026-09-27，对象 `server.js` + `build/app.js` + 产物 `console.html` + 两份测试）

v1.5 让"填权重"变得容易，但**权重仍然要人填**：同一个模型有五家渠道都提供，哪家该多分、哪家在拖后腿，
得自己盯 `/admin/api/status` 的 `rollFailRate` 和延迟列。本轮把这件事自动化——但**故意只做观测**。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 份额只能手填，不会随实测表现自动调整 | `weight` 是死配置；已有的自动信号（失败率 → `effPriority`）只影响**兜底顺序**，不影响份额 | 新增健康系数 `h`（成功率为主力 + 延迟温和惩罚）与预测份额计算，写进 `/admin/api/status` |
| 2 | **自动调权天然带反馈回路**（份额改流量 → 流量改统计 → 统计改份额），一上来就生效有跑飞风险 | —— | v1.6 只算不生效：观测函数**读**统计、算份额、写进 status；真实调度路径一行未改（`effective` 恒 `false`），配置里的 `enabled: true` 也**只影响标注** |
| 3 | 自动份额会"赢家通吃"（最快的被打爆后反而更慢），差渠道被饿死后永远起不来 | —— | 四条护栏：`floor` 0.2（"慢"常常是长上下文在思考）、`maxShare` 70%、`minSamples` 10（样本不足就不动）、冷却/`down` 直接排除 |
| 4 | 手填权重与自动份额并存时，谁说了算？ | 用户手填 = 硬意图 | `maxShare` **只封顶自动算出来的份额**，`manual: true` 的候选永不封顶。这条是设计决策，单测里卡死 |
| 5 | 自动份额照着"抖动的失败率"改，会把流量抖出花 | —— | 低频重算（`updateMs` 30s）+ 指数平滑（`ewma`）+ 死区（`deadband`，相对变化小于它就不动） |
| 6 | **观测本身如果改到调度状态就不是观测了**（`channelsServing` 里的 `pickWeighted` 有 SWRR 副作用） | 直接复用 `channelsServing` 最省事，但会推进轮询计数器、还可能移动候选顺序 | 观测走独立的纯枚举 `pureCandidatesFor`（只读 alias 规则、不碰 `SWRR_*`）。单测断言：观测跑 100 遍 `SWRR_*` 逐字节不变、`pickWeighted` 落点序列一致、`ch.def.weight` 不变；e2e 断言真流量下落点仍是老规矩、`weightedHits` 恒 0 |
| 7 | 新增配置项会被"保存渠道"顺手抹掉（PT29 类陷阱） | `persistConfig` 只写白名单字段 | `persistConfig` 白名单加 `autoWeight`，并加**装配守卫**（白名单里没有它就直接测试失败） |
| 8 | 前端若把观测做成"看起来已经生效"，比不做更糟 | —— | 观测卡卡头写死**"当前分流一字未动"**，抽屉里写明"上面的系数不会被执行"；`effective` 字段如实透出。三条都有断言 |

**数据来源复用已有信号**（不引入新统计口径，避免"两套失败率"互相打架）：
成功率取 `ch.roll`（与「有效优先级」同一个滚动窗口，样本 ≥ `minSamples` 才用）；延迟取本轮新增的
`ch.latEwma`（`recordUsage()` 里成功请求才更新，0.7/0.3 指数平均）。

**界面**（详见 §5.3）：
- 渠道页顶部新增**自动权重观测卡**（`autoWeightCard()`）：每个"候选 ≥ 2"的模型一行，候选画成
  `渠道名 · 预测份额% · 健康 h · 当前 x%` + 份额条，悬停给出**判断依据**（失败率 / 样本数 / 延迟与倍数）；
- 渠道详情抽屉新增「自动权重（观测 · 只算不生效）」一节：健康系数 / 样本 / 失败率 / 延迟四个标签；
- 样式**全走行内**，不动 `build/extra.css`（不改 CSS 就不改构建偏移，代码地图的行号锚点少漂一层）。
  > ⚠️ **此取舍已在 v1.8 推翻**：行内样式让这张卡的排版无法统一维护，v1.8 把它整体收进 `build/extra.css` 的 `.aw-*`，
  > 代价是 JS 偏移 +673 → +677。详见 §8.15。

**验证**（实测，不是估算）：
- `node test/auto-weight.test.js` **61 项**（新增）：旋钮归一化与钳制、`capShares` 归一化与封顶
  （含"手填权重永不被封顶"与"上限×渠道数 < 100 时优雅退化成均分"）、样本门槛、失败率是主力、
  速度惩罚 + 地板、`updateMs` 缓存、EWMA 渐进与死区冻结、预测预览（`manualOff` / 排除冷却 / `nowShare` 对照）；
- `node test/auto-weight-e2e.test.js` **29 项**（新增，真链路）：真起「假上游 + 临时网关」，预测给 50/50 时
  真发 40 次请求**仍全部落在候选链第一位**、`weightedHits` 恒 0；真实失败与真实延迟**只改预测**；
  配置往返后旋钮不被 `persistConfig` 抹掉；
- `node test/console-state.test.js` 38 → **57 项**（新增第 4 节：`adapt()` 接五个观测字段与 `DATA.auto`、
  观测卡画出预测份额与"当前 x%"、空集与单候选给空状态、卡头"当前分流一字未动"、抽屉与挂载的结构守卫）；
- 全量回归 **13 文件 / 491 项**全绿（`anthropic-tools` 60 · `anthropic-tools-e2e` 30 · **`auto-weight` 61** ·
  **`auto-weight-e2e` 29** · `console-state` 57 · `console-weight-e2e` 18 · `gemini-multimodal` 41 ·
  `gemini-multimodal-e2e` 22 · `native-channels` 78 · `native-channels-e2e` 33 · `streaming-e2e` 19 ·
  `weighted-rr` 31 · `weighted-rr-e2e` 12）。

**联调踩到的一个节拍问题（记下来免得下次再查）**：健康系数与样本是**低频重算**的（`updateMs`，夹具设 1 秒），
所以断言"算出来的值"之前必须先跨过一个重算间隔——本轮 e2e 一开始漏了这一步，出现过
"真发了 20 次请求，`autoSamples` 却还是 0"的假失败（真机上看状态时同样会滞后最多一拍）。
**这是抗振荡设计，不是延迟 bug**：测试要让节拍，不要让产品改节拍（已在 `test/auto-weight-e2e.test.js` 里
用 `settle()` 统一处理，并连跑 3 轮确认不飘）。

**本轮同步的行号锚点**：`build/app.js` 因新增 `autoWeightCard()` 等增长 65 行 → 代码地图 §0.2 的
生产侧索引与 §5 修改路由表整体平移（**35 处**，每条都断言"命中恰好 1 次"才写入）；
本文档 §11.3 的产物结构数字由 2477/2480 校正为 2614/2617。原型 `console-redesign.html` 依旧**未同步**
自动权重界面（同 v1.5 的约定：生产独有能力，原型不追平）。

**没做的事（如实记）**：自动权重**尚未生效**——真实分流仍只看手填 `weight` 与优先级兜底。
真要做"生效版"，需要在 `channelsServing` 的候选构造里把 `h` 折进份额（并处理"自动份额与手工权重并存"、
"护栏被反复触碰时如何告警"），届时本节的 `effective` 与该表述必须同时改写。

---

### 8.15 v1.8 / v1.8.1 自动权重观测卡视觉重做：从行内样式改成一个正经组件（2026-09-27，对象 `build/app.js` + `build/extra.css` + 产物 `console.html` + 两份前端文档 + `AGENTS.md`）

**问题**：渠道页顶部那张观测卡"设计语言和排版难看"——文字拥挤、层级不清、颜色含义不明，
份额条分段靠 `2px` 内阴影模拟，健康候选全绿时整条读起来就是一根横贯全卡的绿发丝，要放大才数得清段数。

**根因**：v1.6 的卡**全部走行内样式**（当时的理由是不新增 CSS 就不动 `build/extra.css`、不让行号偏移失效）。
行内样式没有类名可复用，间距 / 字号 / 配色各写各的，视觉无法统一维护；内阴影当"缝"是因为
当时用 `width%` 布局，段间没有真实间隙可用。

**处置**（问题 → 根因 → 处置一一对应）：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 份额条读不出"分了几段" | 7px 高、单色、缝是 2px 内阴影（颜色=卡底色，对比不足） | 加高到 **11px**，改用 `flex-grow:var(--w)`（`flex-basis:0`）分配段宽、`gap:2px` 给**真实间隙**，段内独立圆角 |
| 2 | 0% 候选画成一根红刺，像渲染瑕疵 | 只靠 `min-width:2px` 兜底，0% 也进色带 | 渲染端**过滤 `share>0`**；0% 的份额与扣分理由留在图例里 |
| 3 | 渠道名与 ID 重复（"notion2 notion2"） | 无条件渲染 ID | 仅在 `name !== id` 时补 ID |
| 4 | 每个模型块都挂"当前未开加权轮询"，噪音 | 逐块判断，没看全局 | 仅当**部分**模型未开时才挂（全部未开时卡头已说清） |
| 5 | 行内样式散落，改不动 | v1.6 的取舍（见根因） | 全部收进 `build/extra.css` 的 **`.aw-*`**（10–68 行），`autoWeightCard()` 只产结构 + 两个数据驱动值（`--w`、健康色） |
| 6 | 同一图例行里份额数字错半行 | `.aw-item` 是"主行 + **可选**副行"网格，默认 `stretch` 把没有副行的项垂直居中 | `.aw-item{align-content:start}`（实测 `nmY` 由差 ~8px 变为完全一致） |
| 7 | 2 个候选时图例右半边整片留白、行尾参差 | `auto-fill` 保留空轨道 | 改 `auto-fit`，空轨道塌缩（实测末项 `shRight` = 图例 `right`） |
| 8 | 深色主题下说明句偏暗（对比度 ~3.6:1，低于 AA 4.5:1） | `.aw-note` 用了 `--tx-3` | 提亮到 `--tx-2`，加粗句提到 `--tx`；`.aw-nm .k` 类型 chip 由 9.5px/`--tx-3` 提到 10px/`--tx-2` |

**行号锚点影响**：`build/extra.css` 由 **8 → 68 行**（新增 `.aw-*` 组件），它在拼接序里位于 `app.js` **之前**，
所以 `console.html` 的 **JS 偏移 +673 → +677**（CSS 偏移仍 +13）。
已同步 `AGENTS.md` §1.2、`build/build.js` 注释、代码地图 §0.1 行号换算 / §0.2 extra.css 区块表 / §7 坑位 13·17·18。
`build/app.js` 未增删行，其内部行号与 §0.2 函数索引不受影响。

**验证**：`node test/console-state.test.js` **57 项全绿**（未改断言，回归确认观测卡的文案/结构契约没被破坏）；
另起隔离预览页把真实 `autoWeightCard()` + 真实 CSS 在暗/亮两主题下渲染，用 DOM 几何断言验收了 #6/#7/#8 三条。

**没做的事（如实记）**：原型 `console-redesign.html` 依旧**未同步**这张卡（同 v1.5/v1.6 约定：生产独有能力，原型不追平）。

---

### 8.16 v1.9 自动权重独立成页 + 份额改成"一候选一列"（2026-09-27，对象 `build/app.js` + `build/extra.css` + 产物 `console.html` + 两份前端文档 + `AGENTS.md` + `test/console-state.test.js`）

**问题**（用户原话）：
1. "自动权重要不然单独设置一个页签吧也放在资源这个里面。"——那张只读预测卡压在渠道管理页顶部，与可操作的表格抢层级。
2. "这个条和下面的渠道百分比都对应起来，现在好像有点错位。"——色带分段与图例项对不上。

**根因**：
1. 位置问题：v1.6 起把观测卡塞进渠道页是"顺手找个地方放"，不是信息架构上的归属——它和渠道管理没有操作关系，却占着首屏。
2. 错位问题：v1.8 的份额带是**单向堆叠**（段按候选顺序左→右），图例却是 `auto-fit` **网格**（左→右、换行再左→右）。
   候选一多、图例一换行，两者顺序就错开了；且真机上绝大多数候选健康系数 =1（色块全是同一个绿），连颜色都区分不出谁是谁
   —— v1.8.1 只修了图例**行内**基线（`nmY` 差 8px），没修"对不上"这个根本问题。

**处置**（问题 → 根因 → 处置一一对应）：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 观测卡挤在渠道页顶部 | 只找地方放，没定归属 | 独立成页：`NAV`「资源」组加 `{id:'autoweight',label:'自动权重',icon:'scale'}`，`go()` 路由表加 `autoweight:vAutoWeight`；`vChannels` 删掉卡片调用，只留页签 / 搜索 / 表格 |
| 2 | 色带与百分比对不上 | 色带单向排列、图例网格换行重排 | **一候选一列**：`.aw-split` 用 `flex-grow:var(--w)` 按份额分列宽，列内 `.aw-seg` 色带段 + `.aw-cap`（名字 + 百分比）—— 标签就贴在自己那一段正下方 |
| 3 | 0% 候选占着一格却看不见 | 旧版靠 `min-width:2px` 兜底，把它画成一根红刺 | 渲染端只让 `share>0` 进列；0% 的候选统一收进 `.aw-zero`：`未参与分流：<渠道>（<原因>）` |
| 4 | 旧图例相关样式成了死代码 | 路线整体替换 | 删 `.aw-bar` / `.aw-legend` / `.aw-item` / `.aw-sw` / `.aw-more`，`extra.css` 68 → 58 行 |

**行号锚点影响（本轮是双向变化，务必看仔细）**：`build/extra.css` 68 → **58 行**（偏移 −10），
`build/app.js` 在 `vAutoWeight()` 处净增行（app.js 行号 +）—— 两者方向相反，所以**产物行号在插入点前后表现不同**：
`autoWeightCard()` 之前的函数产物行号整体 **−10**（如 `const IC` 680 → 670），之后的函数因两方向抵消而基本不动
（`autoWeightCard()` 恰好 1301 → 1301）。最终 JS 偏移 **+677 → +667**（CSS 偏移仍 +13）。
已同步 `AGENTS.md` §1.2、`build/build.js` 注释、代码地图 §0.1 行号换算 / §0.2 app.js 函数索引 + extra.css 区块表 /
§5 修改路由表 / §7 坑位 13·17·18 / §8 断言数。

**验证**：`node test/console-state.test.js` **61 项全绿**（v1.8.1 的 57 项 → 61 项，新增：份额带与标签同列、
0% 候选不进列且单行交代理由、观测页真的挂上卡、观测卡不再挤在渠道页、`NAV`+`go()` 有独立页入口）；
另在 8899 脚手架的生产页上真点进「自动权重」，用真实数据在暗/亮两主题各截图确认：
各段宽度与百分比成比例、标签在自己段的正下方、无溢出 / 截断 / 重叠。

**没做的事（如实记）**：原型 `console-redesign.html` 依旧**未同步**这一页（同 v1.5/v1.6/v1.8 约定：生产独有能力，原型不追平）。
另：旧版"只显示前 6 个模型（其余一行带过）"的截断随 `.aw-more` 一起删了 —— 现在有多少多候选模型就画多少。

---

### 8.17 v1.9.1 份额列只留渠道显示名（2026-09-27，对象 `build/app.js` + `build/extra.css` + 产物 `console.html` + 两份前端文档 + `AGENTS.md` + `test/console-state.test.js`）

**问题**（用户原话，渠道名与 id 已脱敏）："`渠道名甲` `id-a` 50% …名字只留一个 只留显示的名称，比如`渠道名甲`这个就只显示`渠道名甲`这个名字；`渠道名乙``id-b` 33.3% 就只留`渠道名乙`这个名字，百分比还要保留。"

**根因**：v1.9 的份额列标签把渠道**显示名**和 **id** 一起拼出来（`<span class="aw-nm">名字<span class="id">id</span></span>`）——
本意是"名字认人、id 对配置"，但在**按份额分列宽**的窄列里，多出来的 id 小片会挤占宽度、把真正要认的名字推向截断；
而真机上用户本来就是按显示名认渠道的（id 只在配置里出现）。

**处置**：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 列里出现"名字 + id"两段 | 标签模板拼了 `.aw-nm .id` | 标签只渲染 `nm(id)`（显示名，取不到名字时回退 id）；`x.kind`（`盲试`·`自动匹配` chip）保留，百分比 `.aw-sh` 照旧 |
| 2 | `.aw-nm .id` 样式失去唯一引用 | 唯一引用被删 | 一并删掉 `.aw-nm .id`，`extra.css` 58 → 57 行 |

**行号锚点影响**：`build/extra.css` 58 → **57 行** → JS 偏移 **+667 → +666**（CSS 偏移仍 +13）。
已同步 `AGENTS.md` §1.2、`build/build.js` 注释、代码地图 §0.1 / §0.2 extra.css 区块表 / §5 修改路由表 / §7 坑位 13。
产物 `console.html` 落到 **2705 行**（`</style>` 610 / `<script>` 666 / `</script>` 2703 / `</body>` 2704）。

**验证**：`node test/console-state.test.js` **62 项全绿**（新增：份额列只留显示名、不再出现 `class="id"`）。

---

### 8.18 v1.13 停用渠道也能手动测模型（2026-09-29，对象 `build/app.js` + `server.js` + 产物 `console.html` + 两份前端文档 + `AGENTS.md` + `README.md` + 两份测试）

**问题**（用户原话）："我停用的渠道没办法手动测试模型是否可用，我想要停用的渠道点击测试也可以测试我添加的模型。当然停用的程序不用自动测试。"

**根因**（两处，方向正好相反）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 从停用渠道点「测试」，弹窗里一个模型都没有、「运行测试」是灰的 | 控制台 `openTestModels` 里一句 `if(!c.on)continue;` 把停用渠道整个跳过（后端 `/admin/api/test` 带 `channelId` 时本来就只打那一条渠道、根本不看 `enabled` —— 这锅不在后端） |
| 2 | 停用渠道**仍**被自动探测（消耗配额、失败还会把状态越推越烂） | `probeAll()` 对 `channels.values()` 全量探测，没有按 `enabled` 过滤；启动探一次、之后每个 `health.intervalSec` 再探一次 |

**处置**：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 停用渠道弹窗为空 | `openTestModels` 无条件跳过停用渠道 | 改为按 `DATA.channels` 全部构造；停用渠道分组头加「已停用」标签，列表含停用渠道时补一行说明（"测通也不会因此启用它，且不参与自动探测"）；全局入口也包含停用渠道但**启用排前**；每条测试报文照旧带 `channelId`（不走调度，不动真实分流） |
| 2 | 停用渠道被自动探测 | `probeAll()` 不过滤 `enabled` | `probeAll(opts)` 默认按 `ch.def.enabled !== false` 过滤：**启动 + 定时器**（自动）跳过停用渠道；`/admin/api/recheck` 不带 id（手动「全部重探测」）显式传 `{includeDisabled:true}`。重探测结果新增 `enabled` 字段便于区分 |
| 3 | 「手动 vs 自动」的边界没写清 | 文档只写了"能重探测" | README 增一节「自动 vs 手动的边界」，并诚实写明代价：停用渠道的模型清单 / 状态 / 延迟会**停在上次手动探测那一刻**，不再自动刷新 |

**行号锚点影响**：`build/app.js` 2035 → **2039 行**（JS 偏移仍 **+666**，`extra.css` 未动）；
产物 `console.html` 落到 **2709 行**（`</style>` 610 / `<script>` 666 / `</script>` 2707 / `</body>` 2708）。
已同步代码地图 §0.2 区块表（`1853–1940` / `1940–1967`）与 §5 修改路由表。

**原型未同步（有意）**：`console-redesign.html:2175` 的演示版 `openTestModels` 仍是旧的 `if(!c.on)continue;`。
设计稿是演示逻辑、不随生产走；动它会让 §1/§3 的行号锚点集体漂移，收益只有"demo 里那 3 个停用渠道点得动"，
不值。已在此处与代码地图 §5 明确登记，避免下次被当成"漏改"。

**验证**：`test/console-state.test.js` **74 项全绿**（新增 §5：在最小 DOM 桩里真跑 `openTestModels`，
断言停用渠道列得出模型、只列自己、带「已停用」与说明、运行按钮不灰；全局含停用但启用排前；
`runTests` 带 `channelId` 的结构守卫；对照组证明旧写法下是 0 个模型）；
新增 `test/disabled-channel-manual-test-e2e.test.js` **26 项全绿**（真起两个假上游 + 临时网关：
自动探测只打启用渠道、停用渠道 0 次；手动测试停用渠道真打通；手动重探测照探；停用渠道仍不参与调度）。

---

### 8.19 v1.13.1 测试结果看得懂：每行写明模型，且不再把"空回复"当成功（2026-09-28，对象 `build/app.js` + 产物 `console.html` + 两份前端文档 + `AGENTS.md` + `README.md` + `test/console-state.test.js`）

**问题**（用户原话，渠道名已脱敏）："点击测试 [free]kimi-k3 @ `渠道名` … 我不知道哪个是成功的哪个是失败的。完全不知道测试的是哪个模型。"

**根因**（两条，都在结果渲染里）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 认不出测的是哪个模型 | 结果行只渲染渠道名（`<b>${esc(p.chan)}</b>`）。一个渠道挂 N 个模型时，N 行长得一模一样 —— 模型名只出现在"测试中…"的临时行里，结果行一替换就没了 |
| 2 | 认不出成功还是失败 | 成功/失败**只靠颜色**（`.r.ok` 绿 / `.r.fail` 红）；且判据是 `row.ok` 一刀切，于是"HTTP 200 但回复为空"被当成**成功**，渲染成绿油油的一对空引号 `""` —— 三行结果里两行是 `""`、一行是 400，颜色差别在深色主题下并不醒目 |

**处置**：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 行里没有模型名 | 结果行模板只写 `p.chan` | 每行改成 `模型名 @ 渠道显示名`（新增 `chName(id)` 取显示名，取不到才回退 id）；两处都过 `esc` |
| 2 | 结论只靠颜色 | 模板没写中文标签 | 每行加中文结论「通过 / 空回复 / 失败」+ 图标（`check` / `clock` / `warn`），颜色只作辅助 |
| 3 | 空回复被当成功 | 判据 `row.ok` 一刀切 | 新增纯函数 `testRowVerdict(row)`：有回复=`ok`、2xx 但空=`empty`、其余=`fail`；空回复那行写明"（HTTP 200 但回复为空 —— 模型没说任何话）"，不再显示空引号 |
| 4 | 汇总只会报 `x/y 通过` | `okN/picks.length` | 改成"通过 a · 空回复 b · 失败 c（共 n 个 · 提示词「…」）"，状态色按"有没有失败/空回复"给 |

**为什么把"空回复"单列一档**：这类免费渠道经常 200 但吐空。算"通过"会让人以为模型可用（真去调度才发现是空话），
算"失败"又会让人去排查网络与 key —— 两种误判都真实发生过，所以单列一档、用中性色，让人自己判断。

**样式零新增**：复用设计稿已有的 `.r.ok` / `.r.wait` / `.r.fail` 与 `.muted`，**没有改 `extra.css` 与设计稿 CSS**
⇒ 行号偏移仍是 CSS **+13** / JS **+666**，不必重算偏移。

**行号锚点影响**：`build/app.js` 2039 → **2066 行**（新增 `chName` 1904 / `testRowVerdict` 1910，`runTests` 1906 → **1917**，
`drawer` 1940 → **1967**，其后 `showKeyGate` **1994** / `tick` **2036** / `boot` **2046**）；
产物 `console.html` 落到 **2736 行**。已同步代码地图 §0.2 区块表（`1853–1967` / `1967–1994` / `1994–2036` / `2036` / `2046–2066`）与 §5 修改路由表、
本节 §11.3 的产物结构。

**验证**：`test/console-state.test.js` **96 项全绿**（新增 §6：`testRowVerdict` 真值表 9 条，
含"缺 `ok` 字段不当作成功"；在 DOM 桩里**真跑 `runTests`**（桩 HTTP + 桩 `document`）断言 3 行结果各自带模型名、
渠道显示名、中文结论、三种样式、空回复的原因文案、失败行带 HTTP 码与上游原文、成功行带回复与 token、
汇总分三档；并含"旧写法 `<b>huchan</b>` 已消失"的对照与 `esc` 结构守卫）。

### 8.20 v1.13.2 调用日志：渠道列改显示渠道名，并挪到请求 ID 之后（2026-09-29，对象 `build/app.js` + `console-redesign.html` + 产物 `console.html` + 两份前端文档 + `AGENTS.md` + `README.md` + `test/console-state.test.js`）

**问题**（用户原话）："调用日志 里面在请求 ID 后面增加渠道名称，显示主渠道、备用渠道、AgentRouter 这些名字不要显示 ch-a、ch-b 这些名字。"

**根因**（两条，都在日志表的渲染与数据层）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 渠道列显示 `ch-a` / `ch-b` 这类 id，认不出是哪家 | `adapt()` 只把 `r.channelId` 原样塞进 `l.c`，模板直接渲染 `l.c`（`<td class="mono">${l.c}</td>`）；渠道**显示名**从未进入日志条目 |
| 2 | 渠道列排在模型列之后，不在请求 ID 旁边 | 表头写死 `<th>请求 ID</th><th>模型</th><th>渠道</th>`，行渲染顺序同此 |

**处置**：

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | 只认得出 id | 日志条目没有显示名 | `adapt()` 新增 `n` 字段：`n:(chans.find(c=>c.id===r.channelId)||{}).name||r.channelId||'—'`；表格与详情抽屉改渲染 `esc(l.n)`，**保留 `l.c`** 供筛选/导出/排障 |
| 2 | 渠道不在请求 ID 后面 | 表头与行写死顺序 | 表头改 `<th>请求 ID</th><th>渠道</th><th>模型</th>`，行渲染改为 请求 ID → 渠道名 → 模型名（一行 `cell-name` 换一行，行数不变） |
| 3 | 搜索按名字搜不到 | 判据只含 `l.m + l.c + l.id` | `logRows()` 判据补 `l.n`：`(l.m+' '+l.n+' '+l.c+' '+l.id)`，名字/ id 都能命中；搜索框 placeholder 改「模型名 / 渠道名 / 渠道 ID / 请求 ID…」 |
| 4 | 导出 CSV 还是 id，与页面不一致 | `exportLogs` 写 `l.c` | 改写 `l.n`（渠道列 = 显示名，与页面所见一致） |
| 5 | 设计稿与生产会各说各话 | 原型 `vLogs` 同款旧写法 | `console-redesign.html` 的 `vLogs` 表格/抽屉同步改：列序与显示名（就地查 `DATA.channels`），保证设计源与产物一致 |

**样式零新增**：只改模板文本与一个数据字段，**没有改 `extra.css` 与设计稿 CSS**；`build/app.js`、`console-redesign.html` 行数均**未变**
⇒ 行号偏移仍是 CSS **+13** / JS **+666**，不必重算偏移（`app.js` 2066 行 / `console-redesign.html` 2272 行 / 产物 `console.html` 2736 行，均与 §8.19 一致）。

**验证**：`test/console-state.test.js` **103 项全绿**（新增 §7：断言表头「渠道」紧跟「请求 ID」、渠道格显示"主渠道 / 备用渠道"且不出现 `>ch-a<`/`>ch-b<`、
一格顺序为 请求 ID → 渠道名 → 模型名、按名字搜索命中、按 id 搜索仍命中、`adapt()` 把显示名解析进 `n` 且 `c` 保留；
并含"旧写法（渠道格写 id、排在模型后面）下看不到渠道名"的对照组，证明用例抓得住）。

### 8.21 v1.14.1 添加渠道表单：WorkBuddy 的 key 提示补上"已被加密"（2026-09-28，对象 `build/app.js` + `console-redesign.html` + 产物 `console.html` + `README.md` + `AGENTS.md`）

**问题**：用户照表单提示去 `CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` 复制 `auth.accessToken`，填进渠道后拿不到模型。

**根因**（两条，一条在前端提示、一条在后端判据）：

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | 复制出来的"token"根本不是 JWT | 新版 CodeBuddy 把该字段加密了：`{"$wbEncrypted":1,"envelope":{"suite":1,"keyId":…,"ciphertext":…}}`（AES-GCM 密文）；而表单提示仍写「auth 文件里 auth.accessToken 的 JWT」，等于指了一条死路 |
| 2 | 真实失败原因是额度用尽，界面却说 `non-SSE response` | 后端探测侧用 `text.startsWith('{')`（**没 trim**）判 JSON，响应体以换行/BOM 开头就被当成"未知响应"，上游明说的重置时刻被整段吞掉（后端修复见 docs/protocols.md「workbuddy」一节与 `test/workbuddy-quota.test.js`） |

**处置**：`PROTO_META.workbuddy.key` 提示改写（原型 1781 / 生产 1454），明说"该字段已是 envelope、不是 JWT，填了会被当场拒；需从客户端实际请求里取明文 token"。

**样式与行数零变化**：只改一行字符串内容，`build/app.js` **2066 行**、`console-redesign.html` **2272 行**、
产物 `console.html` **2736 行**均未变 ⇒ 行号偏移仍是 CSS **+13** / JS **+666**，`docs/frontend-code-map.md`
§1「1775–1784 `PROTO_META`」/ §0.2「1448–1461 `PROTO_META`」两个锚点区间**继续有效，无需重算**。

**验证**：`node build/build.js` 通过（产物含新文案）；`test/console-state.test.js` 103 项、全量 21 个测试文件全绿。

---

### 8.22 v1.18 运行期设置：后端窄口就绪（`/admin/api/settings`）、前端规格交付；顺手修掉轮询重绘表漏页（2026-10-02，对象 `server.js` + `build/app.js` + 产物 `console.html` + 两份前端文档 + `README.md` + `AGENTS.md` + `test/settings-api-e2e.test.js`）

**问题**：两个，一个是需求缺口，一个是自查发现的真 bug。

| # | 现象 | 根因 |
| --- | --- | --- |
| 1 | v1.17 的会话粘性 / 客户端限流 / `/metrics` 三个开关在控制台**看得见、改不了** | 渠道级 `POST /admin/api/channel` 只管渠道字段，`GET /admin/api/config` 是只读的——**全仓没有任何路径能写这三组开关**（状态倒是早在 `/admin/api/status` 里列了三段） |
| 2 | 停在「自动权重」页时，8 秒轮询**不会刷新这一页**（数据停在进入那一刻） | `render()` 里的重绘分发表（`build/app.js` 157 行）**漏了 `autoweight:vAutoWeight`**，只有 `go()` 那张表（345 行）是全的。`render()` 拿不到函数就 `return`，于是既不重绘、也不做滚动/焦点保留——不报错、不白屏，只是数据悄悄不更新 |

**处置**：

1. **后端补窄口**（`server.js`）：新增 `GET/POST /admin/api/settings`，**只认这三组**、组内只认白名单字段且类型严格（写错字段名/类型一律 400 并点名字段，不静默忽略）；每组走**与启动路径同一个** `normAffinityCfg`/`normRateCfg`/`normMetricsCfg`（启动期常量由这三个函数初始化，保存后 `applyRuntimeSettings()` 重算同一批常量）——**立即生效 + `persistConfig()` 立即落库**。GET 同时返回 `config`（用户原值，回填表单用）、`effective`（钳制后生效值，如 `ttlSec:5 → 30`）、`status`（实时计数），两个值都给是为了避免"我填的 5 没生效"这类悬案。
2. **修轮询漏页**：`render()` 那张表补上 `autoweight:vAutoWeight`，与 `go()` 对齐。**只改一行内容、行数不变**。
3. **前端页面按规格实现**（本轮不动页面）：规格落在 [`console-settings-spec.md`](console-settings-spec.md)——字段契约、三张卡结构与文案、交互红线（只提交有改动的组、跨轮询保留输入、400 原文要显示）、要改的文件与 AGENTS 同步清单、逐条验收。

**样式与行数零变化**：`build/app.js` 仍是 **2066 行**、`console-redesign.html` **2272 行**、产物 `console.html` **2736 行**
⇒ 行号偏移仍是 CSS **+13** / JS **+666**，`docs/frontend-code-map.md` 的两张锚点表**继续有效，无需重算**（本页新增端点在后端，不影响前端锚点）。

**验证**：`node --check server.js` 通过；`node test/settings-api-e2e.test.js` 58 项断言全绿（含"打开限流不重启即第 2 发 429""关掉 `/metrics` 立即 404""落库后重启仍是这个值"）；`node build/build.js` 通过；`node test/console-state.test.js` 103 项全绿；全量 28 个测试文件全绿。

---

### 8.23 v1.18.1 空数据炸渲染：全新部署上「渠道管理 → 详情」点了没反应（2026-09-28，对象 `build/app.js` + 产物 `console.html` + `test/console-state.test.js` + 两份前端文档 + `AGENTS.md`）

**问题**：别人把网关部署起来后，控制台**渠道管理点「详情」毫无反应**——不弹抽屉、不报错、不白屏，只有浏览器控制台里一行红字（用户不一定会去看）。有数据的机器上完全正常，所以本机一直没暴露。

**根因**（逐层剥出来的，不是猜的）：

| # | 事实 | 证据 |
| --- | --- | --- |
| 1 | 详情抽屉由 `openChannel(id)` 一次 `drawer(...)` 画出，而**图表是在 `drawer()` 之前求值的**（模板字符串里调 `areaChart(DATA.trend.slice(-12),…)`） | `build/app.js` `openChannel` 内 `areaChart` 早于 `drawer(` |
| 2 | `areaChart` 里 `let d='M'+pts[0][0]+','+pts[0][1]` **没有空数据分支**，`data=[]` ⇒ `pts[0]` 是 `undefined` ⇒ `TypeError: Cannot read properties of undefined (reading '0')` | 把整个 `build/app.js` 跑进最小 DOM 桩、喂真实 `/admin/api/status` 形状数据后**稳定复现**，栈顶就落在 `areaChart` |
| 3 | 全新部署的实例 `/admin/api/usage` 的 `byDay` 是空数组 ⇒ `adapt()` 算出 `trend=[]` ⇒ 必然走到上面那条 | 临时网关实测：0 请求时 `byDay=[]`；有请求后 `byDay` 才有值（本机线上是 24 天，所以本机不复现） |
| 4 | 同一个坑还有兄弟：`sparkline` 对空数组会取 `pts[pts.length-1][0]`；单点输入 `w/(length-1)` 还是 `w/0` → `NaN` | KPI 卡/总览的迷你曲线用的是它 |

**处置**（最小改动，不动布局与配色）：

1. `areaChart`：函数开头判空（`!Array.isArray(data) || data.length===0`）→ 直接返回**占位图**（保留 `viewBox`/宽高、画一条虚线基线、居中写「暂无数据（还没有调用记录）」），**绝不抛**。有数据时输出与改动前**逐字节同构**（同一套 `M/C` 路径与网格）。
2. `sparkline`：同样开头判空 → 返回一条基线占位；并把单点输入的分母改成 `vals.length>1 ? w/(vals.length-1) : w/2`，消掉 `NaN`。
3. 新增一节回归：`test/console-state.test.js` **§9「零数据（全新部署）不许把页面/抽屉打挂」**——在最小 DOM 桩里**真跑 `openChannel`**（零数据 + 满数据两组），断言不抛、抽屉真的画出来、柜里有渠道名与占位文案、满数据仍画得出曲线；另加两条结构守卫，防止后续重构把空数据分支"简化"掉。

**为什么以前没抓到**：`console-state.test.js` 的桩数据**一直是满的**（有 `trend`、有渠道），而这类"空数据炸渲染"的 bug 的特征恰恰是**有数据时全绿**。教训写进用例注释：凡是渲染函数，桩数据必须**再跑一遍空的**。

**验证**：`node test/console-state.test.js` **115 项断言全绿**（原 103，本节 +12）；`node build/build.js` 通过、产物已含占位文案；全量 **28 个测试文件 / 1197 断言 / 0 失败**；对照实验：用改动前的源码跑同一组断言，`areaChart([])` 必抛、`openChannel` 必中断（测试抓得住）。

**对「部署方」的结论**：这不是环境问题、不是浏览器缓存问题（`/console` 响应头是 `Cache-Control: no-store`，刷新即最新），而是**基于 `git` 的那份构建里就有的代码缺陷**——唯一解法是更新代码后重新构建并重启容器（`node build/build.js` + 重建镜像）。

### 8.24 v1.18.2 运行期设置页归到「工具」组：Playground 与接入信息之间（2026-09-28，对象 `build/app.js` + 产物 `console.html` + 两份前端文档 + `README.md`）

**问题**：v1.18 把「运行期设置」放进「资源」组（排在 渠道管理 / 聚合模型 / 自动权重 之后），但它是**网关运行态开关**、不是资源条目——归到「资源」语义不搭，用户在资源里找不到"设置"。

**处置**：`NAV`（`build/app.js` 337）把 `{id:'settings',label:'运行期设置',icon:'sliders'}` 从「资源」组移到「工具」组，**夹在 Playground 与接入信息之间**（工具组顺序：Playground / 运行期设置 / 接入信息）。一进一出、`NAV` 行数不变 ⇒ 其后所有行号锚点（含 JS 偏移 **+686**）不漂移；`go()` / `render()` 两张分发表与 `vSettings` 本身一行未动。

**验证**：`node build/build.js` 通过、产物已含新顺序；`test/console-state.test.js` **146 项断言全绿**（§10 不受影响，其断言按 `id` 取元素、不依赖分组；另加一条位置守卫锁住"工具组 / Playground 与接入信息之间"）；全量 **28 文件 / 0 失败**。

### 8.25 v1.18.3 第一批安全加固：渲染层统一转义 + 安全响应头（2026-09-28，对象 `build/app.js` + `server.js` + 产物 `console.html` + 新增 `test/security-headers-e2e.test.js`）

**问题（外部黑盒渗透测试报告 F-03 / F-05，本机逐条复核确认为真）**：控制台的转义是**不一致**的——同一张调用日志表里渠道名走了 `esc(l.n)`，模型名却是裸的 `${l.m}`；`toast()` 更直接把上游/服务端错误串拼进 `innerHTML`。而任何持有 `GATEWAY_KEY` 的调用方都能让字符串进入这些字段：实测传 `model=<任意串>`，该串会出现在 `/admin/api/usage` 的 `recent[].note`（上游把模型名回显进错误文案）与 `channels[].lastError`；**成功**请求则会以调用方请求的模型名落进 `recent[].model`（`server.js:5056` 等 20 余处记的都是 `displayModel`）。管理员打开「调用日志」页那段文本就被当 HTML 解析 ⇒ 一条「网关密钥 → 管理端脚本执行」的存储型 XSS 链。同时全站**一个安全响应头都没有**（无 `nosniff`、可被 iframe 嵌套、`Referrer-Policy` 缺失，而 `?key=` 登录方式会把管理密钥写进 Referer），`/admin/api/*` 与 `/healthz` 也没有 `Cache-Control: no-store`。

**根因**：控制台全部是手写模板字符串拼接，`esc()` 靠"记得加"，没有任何机制阻止漏加；`toast()` 为了省事把文案当 HTML。

**处置**：`build/app.js` **就地**给 52 处外部可控插值补 `esc()`（渠道名/ID/协议 chip、模型名、日志 ID/协议、`class` 属性值、`data-t` 属性等），`toast()` 改成 `svg(...)+'<span>'+esc(msg)+'</span>'`。**刻意只做就地插入、不增删一行**——遵守 §1.2 的行号锚点纪律（也延续 `build/app.js:892` 既有注释的同一约定），代码地图与 JS 偏移 **+686** 全部零漂移。内联 `onclick` 的参数同样过 `esc()`：在属性上下文里这已杜绝 `"` 闭合逃逸；**彻底消灭内联处理器（改事件委托）留到下一批**，避免一次改动过大。`server.js` 新增 `SEC_HEADERS`（`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Permissions-Policy`），在 `http.createServer` 回调的**任何分支之前**统一 `setHeader`，于是 401/404/所有 API/静态壳全都带上；`/admin/api/*` 与 `/healthz` 追加 `Cache-Control: no-store`。**CSP 刻意不加**：控制台是内联脚本 + MiSans CDN，须单独设计并做浏览器验证（见 `README.md`「计划中」）。

**残留（明确记下，别当成已解决）**：① 管理面仍明文下发上游 `apiKey`（第二批）；② 内联 `onclick` 未改事件委托，参数虽有 `esc()` 兜底，但依赖"渠道 ID 里不出现引号"这一现状（导入渠道理论上可构造，低危）；③ 无 CSP；④ 管理面仍无失败限流（第二批）。

**验证**：新增 `test/security-headers-e2e.test.js`（**23 项断言**，真起临时网关）——源码级装配守卫（`build/app.js` 的 11 个"裸插值"必须一个不剩、`toast` 必须 `esc(msg)`、`data-t` 必须 `JSON.stringify`+`esc`、`SEC_HEADERS` 必须在 `createServer` 之前且 `setHeader` 在所有分支之前、CSP 不得偷偷加上）+ 真链路逐条核头（`/console`、`/healthz`、`/admin/api/status` 的 200 与 401、`/metrics`、`/v1/models`、404 全部带齐三个头；`/healthz` 与 `/admin/api/*` 带 `no-store`；页面壳零密钥明文；产物里能看到 `esc(l.m)`）。`node build/build.js` 通过（**163,938 字符 / 184,983 字节**，比改前 +324 字节）；全量回归 **29 文件 / 1251 项断言 / 0 失败**。

### 8.26 v1.18.4 第二批安全加固：密钥默认不下发 + 按需揭示 + 管理面失败限流（2026-09-29，对象 `server.js` + `build/app.js` + 产物 `console.html` + `test/security-headers-e2e.test.js`）

**问题（外部黑盒渗透测试报告，本机复核确认为真）**：`/admin/api/status`、`/admin/api/channels`、`/admin/api/config` 直接把全部渠道的上游 `apiKey` 明文交给浏览器（本机实测 **32 条**），其中 `/admin/api/config` 还同时给出 `ADMIN_KEY` 与 `GATEWAY_KEY` 原文。报告原文照录：「**ADMIN_KEY 一旦泄漏，全部上游密钥一起泄漏**」。控制台自己是有掩码的（`chKey()`），但那是**前端自愿**——接口已经把原文发出去了，任何拿到 `ADMIN_KEY` 的人（或任何一次脚本注入 / 浏览器扩展 / 中间代理日志）都能直接读走全部上游额度凭证，控制台显示成什么样都不影响。

**根因**：这几个端点是给控制台**显示**用的（"这是哪把密钥、配没配"），响应体里给的却是**取用**才需要的东西（完整密钥）。显示与取用挤在同一条信任链、同一次下发上：控制台需要的信息量（掩码 + 是否已配置）和密钥原文的信息量差一个数量级，却没有分层。

**处置**：
① **默认只下发掩码**：`channelStatusAll()` 与 `GET /admin/api/channels` 的 `apiKey` 改为 `maskSecret()` 掩码 + 新增布尔 `apiKeySet`。**写 `config.json` 的内部构造刻意不动**（仍取 `ch.def.apiKey` 原文），否则一次 `persistConfig()` 就会把用户渠道密钥覆盖成掩码——这是"改错了会丢数据"的一步。
② `GET /admin/api/config` 不再返回两个密钥原文，改返回 `gatewayKey` 掩码 + `adminKeyRequired` + 新增 `keysInsecure` 布尔（原来前端自己拿密钥做 `/change-me/i` 判断，现在由后端给结论）。
③ 新增两个**按需揭示**端点：`GET /admin/api/channels/{id}/key`、`GET /admin/api/gateway-key`——仍走 admin 鉴权、逐条取名，并同样带 `Cache-Control: no-store`。
④ `POST /admin/api/channels` 的 `apiKey` 改为「**留空 = 保持原密钥**」：`validateChannelDef` 增加 `allowMissingApiKey` 选项，**只对已存在的渠道放宽**。否则控制台带着掩码或空串回写一次，就能把用户配好的密钥抹掉。
⑤ `checkAuth` 改 `sha256` + `crypto.timingSafeEqual` 恒定时间比较（原来 `===` 是短路比较，可被逐字节计时爆破）；并新增失败计数：9 处鉴权点全部改走 `authGate()`，每类（admin / gateway）**每分钟最多 30 次失败尝试**，超了返回 429 + `Retry-After`，**成功一次即清零**——窗口式而非永久锁定，正密钥永远不受影响，因此不存在"把自己锁在门外"。

**控制台相应变化（`build/app.js`）**：渠道抽屉的「明文显示」与「复制密钥」、渠道表单的 API Key 回填、模型页的「复制真实 `/v1/models`」、Playground 直连 `/v1`、接入信息卡的「复制」与「复制全部」，全部改成**点一下才现取一次原文**（新增 `chKeyLive` / `gwKeyLive` / `copyChKey` / `copyGwKey` / `copyAllEndpoints`；`gwKeyLive` 按页缓存，避免同页重复取）。渠道表单的 API Key 框不再回填原文，占位符显示「已配置 sk-a…1234 · 留空保持不变」；编辑已有渠道时**留空即保持原密钥**；点「明文」时 `toggleKeyField` 会现取一次原文填进输入框（取到的是当前密钥本身，直接保存等于原样写回，不产生改动）；「探测上游」按钮同样自动现取一次原文。

**残留（明确记下，别当成已解决）**：① 渠道密钥一旦被揭示，仍会出现在浏览器内存与剪贴板里——这是"用户主动点击"必然的代价，不是漏洞；② 揭示端点没有单独的频率限制（管理面整体的失败限流挡的是**爆破**，不是"管理员自己反复刷"）；③ CSP 仍未加（需按真实资源单独设计 + 浏览器验证）。

**验证**：`node test/security-headers-e2e.test.js` 新增「第二批」一节——两处渠道列表只下发掩码而写盘构造保留原文、`POST` 留空即保持原密钥（含真链路往返）、`/admin/api/config` 不再交出 `adminKey` 且新增 `keysInsecure`、两个揭示端点仍需 admin、鉴权改 `timingSafeEqual`、9 处鉴权点全走 `authGate`、连续失败到阈值转 429 + `Retry-After` 且客户端面不受牵连；全量回归；8788 灰度实例实测。`node build/build.js` 通过（产物 **165,769 字符 / 187,743 字节**）。

### 8.27 v1.18.5 密钥管理页：控制台在线轮换 GATEWAY_KEY / ADMIN_KEY（2026-09-29，对象 `server.js` + `build/app.js` + 产物 `console.html` + 新增 `test/key-rotation-e2e.test.js`）

**问题（用户原话："就这个轮换密钥不能做成可编辑的？不能只是让你修改吧？"）**：`GATEWAY_KEY` / `ADMIN_KEY` 只来自环境变量（`.env` → compose → 进程），容器里改不了 `.env`，"轮换"只能手改文件 + 重开容器；控制台的「轮换密钥」按钮点开的只是一张**只读**步骤清单。

**设计决策（用户拍板）**：① 优先级链 `config.auth`（控制台轮换）**> 环境变量 >** 首启生成——不这样做，重启就把轮换结果顶回去（看起来改了、其实没生效）；代价是 `.env` 从"唯一真源"降级为"初始值"，所以页面必须显示每把密钥的**来源**、并提供「回到环境变量值」。② **旧密钥立即失效，不设宽限期**。③ 新页放「工具」组，夹在运行期设置与接入信息之间。

**后端（`server.js`）**：启动时 `applyManagedKeys()`（在 `resolveGeneratedKeys()` 之前）让 `config.auth` 压过环境变量；`persistConfig` 白名单加 `auth`（否则保存任意渠道就把轮换结果抹掉）。新增 5 个端点：`GET /admin/api/keys`（掩码 + 来源 + `keysInsecure` + `rotatedAt`）、`GET /admin/api/admin-key`（与 v1.18.4 的 gateway-key 揭示端点对称）、`POST /admin/api/keys`（手填轮换，`normNewKey` 准入：8–128 位可见 ASCII、禁 `change-me`、两把不得相同，管理密钥另需大小写字母+数字+特殊字符四样齐全（`genKey` 也改为产出四样齐全的 48 位串，否则随机生成的管理密钥过不了自己的门槛），**被拒的值不生效也不落库**）、`POST /admin/api/keys/generate`（随机生成 48 位 hex，`target: gateway|admin|both`）、`POST /admin/api/keys/reset`（删 `auth` 段，NOAUTH 下不凭空造密钥）。轮换即清 `AUTH_FAIL` 失败计数（旧密钥的失败不该让新密钥继续吃 429）。`keysInsecure` 收敛成 `keysInsecureNow()` 一个判据（`/admin/api/config` 与 `/admin/api/keys` 共用）。新明文只在轮换响应的 `newKeys` 里回给调用方这一次。

**前端（`build/app.js` 1495–1644）**：新页 `vKeys`（1539）——见 §5.10。三个硬约束：**换管理密钥后同步更新 sessionStorage + localStorage 的 `adminKey`**（否则下一次轮询 401 把自己踢出控制台）；「轮换」单击直接生效（用户明确要求，最初的"点两下确认"被否掉）；「回到环境变量值」保留两步确认（`armConfirm`）；**「随机生成」本地填框（`fillGeneratedKey` + `crypto.getRandomValues`），用户先看到/复制再点「轮换」生效**（最初是"点随机生成即轮换"，用户反馈"框里什么都没生成"后改）；手填草稿跨 8 秒轮询重绘保留（`keyDraft` 回填）。接入信息页「轮换密钥」按钮改 `go('keys')` 直达；`showKeyHelp` 改口径为命令行备用路径。

**验证**：`test/key-rotation-e2e.test.js`（**75 项断言**，真起临时网关）——装配守卫（优先级链方向、`auth` 白名单、4 个端点都在 `handleAdminApi` 内、`keysInsecureNow` 唯一判据、轮换清计数、NOAUTH 安全）+ `normNewKey` 真值表 + 真链路（6 种非法值 400 且不生效不落库、旧密钥立即 401 / 新密钥立即 200、`keysInsecure` 由真变假、重启后 `config.auth` 仍压过 env、随机生成三态（48 位四样字符齐全）、reset 回环境变量且盘上 `auth` 段消失）。`test/console-state.test.js` 新增 §11（**161 项断言**总）：含"随机生成只填草稿不发请求 + 轮换提交框内值"的回归：双路由表注册、NAV 位置、掩码与来源渲染、草稿跨轮询、**换管理密钥后浏览器存值同步更新**、按需揭示端点、两步确认守卫。`node build/build.js` 通过（产物 **173,165 字符 / 197,075 字节**）；全量回归 **30 文件 / 0 失败**。

**残留（明确记下）**：① 轮换动作只落一行 `[keys]` 日志，无专门审计流水（单用户自托管定位，够用）；② 其它标签页/设备上的旧管理密钥在轮换后立即 401，需要重新输入一次——页面上已写明，这是"立即失效"的必然代价。

---

### 8.28 v1.18.6 密钥值整行看不见：`.mask` 类名冲突（2026-09-29，对象 `console-redesign.html` + `build/app.js` + 产物 `console.html` + `test/console-state.test.js` + 两份前端文档 + `README.md`）

**问题（用户原话："页面新增了一个密钥管理，但是界面元素貌似不是很对……这行字所在的框感觉怪怪的，位置不对还是什么问题？"）**：密钥管理页两张卡里的「当前值」行**掩码值根本看不见**——行内只剩「当前值」与「显示 / 复制」两个按钮，中间空一块。同一个毛病也一直在**接入信息页的 `GATEWAY_KEY` 行**上（从设计稿就带着，长期没人报）。同一句反馈里还有更直观的另一半：状态横幅的 `div` 漏了 `card-bd`（`.card` 只有 `overflow:hidden`、没有 `padding`），内容直接塞 `.row` 会**贴着边框**。

**根因（类名冲突，不是布局问题）**：设计稿把"被遮罩的密钥值"写成 `<span class="mask mono">`，而 `.mask` 是**弹窗遮罩**（`position:fixed;inset:0;z-index:80;display:grid;place-items:center;opacity:0;pointer-events:none`）。`.ep-key .mask{letter-spacing:.08em}` 只补了字距，其余属性全部继承自遮罩那条规则 —— 于是这个值变成一个**铺满视口、透明、脱离文档流**的元素：文本在 DOM 里（`textContent` 有值）却永远不显示，`.ep-key` 行里自然空一块。浏览器实测：`position:"fixed"`、`opacity:"0"`、`zIndex:"80"`、`getBoundingClientRect()` 约等于整个视口（1703×1198）。

**处置**：① 把"被遮罩的值"改用独立类 `.ep-key .kval`——原型 `<style>` 337、原型演示 markup 1700、`build/app.js` 的 `keyCard`（1522）与 `vAccess`（1693），共 4 处；`.mask` 回归"只做弹窗遮罩"。**只改选择器名、不增删行**，因此 `console.html` 的行号偏移不变（CSS +13 / JS +686）。② 状态横幅补 `class="card-bd row"`。

**验证**：`test/console-state.test.js` §11 新增 5 条断言（**168 项**总）：源码里 `class="mask mono"` 必须为 0、密钥值与接入信息页的 `GATEWAY_KEY` 都走 `class="kval mono"`、产物里 `.ep-key .kval{` 在而 `.ep-key .mask{` 不在、**且 `.mask` 仍必须是那条弹窗遮罩**（防止用"给遮罩改名"蒙混过关），外加一条"旧写法不满足守卫"的对照组。浏览器实测（本地静态托管 + 打桩后端，见 §11 构建管线）：修复前该元素 `opacity:0 / position:fixed / rect≈视口`、值不可见；修复后两张卡的掩码值均正常可见。`node build/build.js` 通过（产物 **173,929 字符**；设计 CSS 33,647 · 补充 CSS 4,587 · JS 132,315）。

---

### 8.29 v1.18.6 第三批安全整改：CSP 响应头 + 管理面会话化（2026-09-29，对象 `server.js` + `build/app.js` + 产物 `console.html` + 新增 `test/admin-session-e2e.test.js` + `test/security-headers-e2e.test.js` / `test/console-state.test.js` / `test/key-rotation-e2e.test.js` 增章）

**问题（渗透测试报告第三批，两项同报）**：① 全站没有 CSP（Content-Security-Policy）——v1.18.3 的转义整改把"注入"堵住了，但纵深防御缺第二道墙；② `/console?key=…` 登录方式把管理密钥**写进浏览器历史**（渗透报告点名）；更结构性的问题是 v1.0–v1.18.5 的"密钥记忆"方案是 localStorage/sessionStorage **常驻**——任何 XSS 只要得手一次，读走的就不是一次性凭据而是**长效主密钥**（§8.7 第 3 行当年点名的正是这条链）。

**设计决策（用户拍板）**：① 两项**一起做**；② 浏览器侧走**会话 cookie**（`HttpOnly`（JS 读不到）+ `SameSite=Strict`（顺带治 CSRF），业界惯例：浏览器会话、脚本 Bearer），**不用**"仍存 localStorage 但加密"之类的折中——浏览器里根本没有能对抗 XSS 的可逆加密；③ **刻意不加 `Secure`**——本网关设计上跑 http 本地/局域网，加了 cookie 反而种不下去，兜底在 CSP `connect-src 'self'`（即使 XSS 偷到 cookie 也发不出去）；④ 会话表放**内存**（重启全部掉线是刻意接受的代价，页面文案明示）；⑤ Gemini SDK 客户端面的 `?key=` **保留**（它是另一默认鉴权模式，不在整改面内）。

**后端（`server.js`）**：内存会话表 `SESSIONS`（token→过期时刻，`SESSION_TTL` 12 小时、上限 256、先清过期再逐最旧一枚）+ `readSessionToken`（cookie 手工解析）/`sessionValid`（懒过期）/`sessionCookieValue`（四旗标拼装）/`newSessionToken`（32 字节随机）/`clearSessions` + 10 分钟周期清扫（`unref` 不吊住进程）。新端点 `POST /admin/api/session`（body `{key}` 交一次 `ADMIN_KEY` → `Set-Cookie: zz_session=…; HttpOnly; SameSite=Strict; Max-Age=43200` + `expiresInSec`）与 `DELETE`（只杀自己 + `Max-Age=0` 回写，其余方法 405），**放在 authGate 分支之前**（登录时手里还没有会话）；登录失败计入 admin 失败限流（`authThrottle('admin')` + `authFail`/`authOk`，NOAUTH 放行）且响应 `no-store`。`checkAuth('admin')` 改为**会话 cookie 或 Bearer**（脚本/CI 零影响）；`?key=` 移进 `kind !== 'admin'` 块（管理面拆、客户端面留）。`rotateKeys()` 换管理密钥时 `clearSessions()`，且 keys 路由在轮换响应里**补发新会话 cookie**（发起页不被踢回登录门）；`resetManagedKeys()` 同样清空会话。CSP 进 `SEC_HEADERS`：`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://font.sec.miui.com; font-src 'self' https://font.sec.miui.com https://cdn-file.hyperos.mi.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`——`'unsafe-inline'` 是单文件内联控制台的必要妥协（真实兜底在 `connect-src 'self'`），MiSans CDN 字体按 `build/head.html` 的 preconnect 进白名单，`img-src` 只放 `data:`（实测 app.js 无图片/`createObjectURL` 用途，只有 CSV 下载 blob）。

**前端（`build/app.js`）**：`api()` 不再注入任何 `Authorization`（会话 cookie 同源自动随行）；**401 → `showKeyGate()`**（会话过期/被轮换清掉时自动闭环）。登录门改 POST `/admin/api/session` 一次换 cookie——输入框粘贴后即清空，**不落任何浏览器存储、不进地址栏**；门内文案明示"验证通过后会换成会话（12 小时有效），密钥本身不会被浏览器存下来"。新增**启动探针**（`fetch /admin/api/status`：200 = 活会话直接 `boot()`，401/网络错 = 弹门——不再问本地存储）。新增 `logout()`（密钥管理页挂「退出登录」按钮：DELETE 自己那枚会话 + 整页重载）；`keyFlow`/`__ZZ_HAS_KEY__` 整块拆除；`rotateKey` 的"轮换后同步写 localStorage/sessionStorage"块删除（服务端补发新会话，前端无事可做）；`showKeyHelp` 步骤改为粘贴密钥登录（不再有 `?key=` 带参链接）；密钥管理页页脚明示"轮换管理密钥后所有已登录会话都会失效（重启也会掉线），重开控制台重新粘一次密钥即可"。

**验证**：新增 `test/admin-session-e2e.test.js`（**63 项断言**：装配守卫 11（常量、`?key=` 只在客户端面块内、会话端点在 authGate 之前、登录进限流、DELETE/405、轮换清会话+补发、清扫 `unref`、CSP 存在）+ 纯函数真值表（`readSessionToken` 7 态、`sessionValid` 懒过期、`sessionCookieValue` 四旗标**刻意无 Secure**、`newSessionToken` 逐出两场景（先清过期不过度逐人 / 全活的逐最旧））+ 真链路（无凭据 401、错密钥 401 不发 cookie、登录 200 旗标齐全、只带 cookie 200、Bearer 保留、管理面 `?key=` 401 / 客户端面 200、两枚会话独立、退出只杀自己、CSP 真实下发、cookie 轮换管理密钥成功且补发新会话（旧 token 立即死、网关密钥不受牵连）、重启后会话全掉线而新 Bearer 仍活（config.auth 落库）））。`test/security-headers-e2e.test.js` 增第三批（CSP 守卫从"不得偷偷加上"翻向**逐字等于设计值**、每条真链路核 `content-security-policy`、管理面 `?key=` 401 / 客户端面 200 对照）→ **51 通过 0 失败**；`test/console-state.test.js` §11 重写为**会话语义**（api() 无 Authorization、登录门 POST session、无 `__ZZ_HAS_KEY__`、轮换后无任何浏览器存储写入）→ **172 项**；`test/key-rotation-e2e.test.js` 增轮换清会话/补发新会话语义 → **85 项**。`node build/build.js` 通过（产物 **173,707 字符**；设计 CSS 33,647 · 补充 CSS 4,587 · JS 132,093）；全量回归 **31 文件 / 0 失败**。

**残留（明确记下）**：① 会话表在内存——网关重启全部掉线（重开控制台粘一次密钥即可，脚本走 Bearer 不受影响）；② 公网 TLS 部署需在反向代理层终止 TLS 并保持 `HttpOnly`/`SameSite` 语义（cookie 刻意无 `Secure`）；③ `'unsafe-inline'` 是单文件控制台的必要妥协，真正的兜底是 `connect-src 'self'`（外发被掐死）；将来若把控制台拆成外链资源，应同步收紧 CSP 并更新 `test/security-headers-e2e.test.js` 的逐字守卫。

### 8.30 v1.18.7 第四批安全整改：彻底消灭内联事件处理器（2026-09-29，对象 `build/app.js` + `build/shell.html` + 产物 `console.html` + `test/security-headers-e2e.test.js` / `test/console-state.test.js` 增章）

**问题**：v1.18.3 给所有内联 `onclick` 参数补了 `esc()`，堵死属性层逃逸；但仍有 16 处把渠道 ID/请求 ID 拼进 `onclick="fn('${id}')"` 的写法，依赖"ID 里不出现引号"这一现状（导入渠道理论上可构造），剩 JS 字符串层的理论风险。其余 50+ 处是零参数/静态参数内联属性——注入风险为零，但"内联事件属性"这个形态本身就该消灭：AGENTS §2 渲染层转义约束当年就预告了这次改造。

**处置**：72 处内联事件属性全部清零（`build/app.js` 71 处 + `build/shell.html` 抽屉遮罩 1 处）——动作进 `data-act`（change 走 `data-change`）、参数走 `data-*`（外部可控 ID 一律 `esc()`，**绝不拼进事件代码字符串**），`document` 上两个委托监听统一分发；`ACTS` 表 44 个动作与模板**双向一一对应**。行为保持：点击从目标向上找最近的 `[data-act]`，嵌套按钮天然只触发自己（行/卡片的动作不再被按钮冒泡触发，原 8 处 `stopPropagation` 全部拆除）；`#impMenu` 的按钮本就在 `.menu-wrap` 内，1802 行的"点外部关菜单"监听不受影响；8 秒轮询整页重绘**不用重挂监听**。登录门的 Enter 改为 `showKeyGate` 内程序化挂接；导入文件框带 `data-change="import-files"` 走同一条委托路。事件委托块登记在 app.js **2367–2431**（`ACTS` 2374 + click 2420 / change 2426 委托监听），`showKeyGate`/`logout`/启动探针/`tick`/`boot` 尾段锚点整体 **+65**（2436 / 2465 / 2469–2473 / 2475 / 2485）；JS 偏移 **+686 不变**（head/shell/extra.css/设计稿行数未动）。app.js 2439→2505 行，产物 173,707→**176,449 字符**。

**验证**：`test/security-headers-e2e.test.js` 增第四批守卫（app.js / shell.html / 产物三处内联属性必须为 0、产物 `data-act` 按钮真实存在、委托接线进产物、`ACTS` 与模板双向一一对应、外部可控 ID 只走 `data-*` 属性、抽屉遮罩也走 `data-act`）→ **57 通过 0 失败**；`test/console-state.test.js` 增**事件委托**一节（把产品真实委托块原样抠出来在桩函数上真跑：click 把 `dataset.id` 送进动作函数、嵌套只触发最近那枚、未知动作与空白点击静默不炸、`openTestModels`/`openChannelForm` 参数形状保留、数值走 `+dataset.idx`、change 送 `importFiles`、双向覆盖；41 个动作函数名刻意硬编码，`ACTS` 引用未登记函数名会当场报错）→ **183 项断言**。全量回归 **31 文件 / 1470 断言 / 0 失败**。

**纪律（AGENTS §2 已同步为硬约束）**：新增交互一律 `data-act` + `ACTS` 注册，禁止再写内联 `onclick=`/`onchange=`/`onkeydown=` 属性——两份守卫会拦回潮。

---

### 8.31 v1.18.8 thinking 回放缓存落地 + 「运行期设置」第四张卡（2026-09-29，对象 `server.js` 回放块 + `build/app.js` 设置卡 + 产物 `console.html` + `test/thinking-replay-e2e.test.js` 新增 + 五份既有测试同步 + 全套文档）

**背景（三次决策）**：v1.17 只落设计稿（"往用户请求里回注历史内容"风险先行）；v1.18 前置验证（`test/thinking-fidelity.test.js`）发现跨协议路径**产不出** thinking 块、400 不可达，判定"现有实现下无收益"不实现；v1.18.8 用户拍板——项目已开源，**会弄丢 `signature` 的客户端是真实受益人群**（同协议直通上，部分框架重序列化时丢掉不认识的字段，上游按规矩 400）。设计稿随实现改写为 as-built 记录（[`thinking-replay-design.md`](thinking-replay-design.md) §9 第三次决策）。

**处置（后端，`server.js`）**：`METRICS_CFG` 之后新增 thinking 回放块——`normReplayCfg` / `REPLAY` 表 / `replaySessionKeyFor`（复用粘性键推导但**不受粘性开关牵连**）/ `replayBlockKey`（`会话键|渠道|模型|sha1(thinking)前24位` 四元键）/ `replayLearn`（只学带签名的对）/ `replaySignature` / `replayStale` / `repairThinkingBody`（**只修丢字段的、没坏返回 null 一个字节不动**）/ `thinkingPairsFromAnthropic` / `thinkingStreamScan`（流式分片攒整）/ `replayStatus`。三处接线：直通选路唯一注入（anthropic 才修）、非流式直通 + 流式侧扫**旁路学习**（不改转发字节）、4xx 透传点名 `signature|thinking` 即作废整组。设置系统升为**四组**（`persistConfig` 白名单、`applyRuntimeSettings`、`runtimeSettingsView`、settings 端点 groups、`/admin/api/status`、`/metrics` gauge+六事件）。

**处置（前端，`build/app.js` + `build/extra.css`）**：第四张卡完全走既有声明路——`SET_GROUPS` 增 `thinkingReplay`（729，行内追加）、`SET_META` 增「thinking 回放」条目（730）、`SET_FIELDS` 增 `ttlSec`/`maxEntries` 两旋钮（740）、`setStat()` 增回放计数行（789）、`vSettings` 副标题与卡序更新（821）、卡容器 `.grid.g3`→`.grid.set-cards`（用户过目时拍板：**四张卡不要一排四连，要两排各两张**——初版借用通用 `.g4` 四连排被否；`.g4` 是原型别处也在用的工具类不能改它的定义，故在 `.set-*` 自家地盘 `build/extra.css` 78–80 行新加 `.set-cards` 两列规则 + ≤900px 折一列）。**零新交互**：开关走既有 `setToggle`、保存走既有 `setSave`/`saveSettings`，无新 `ACTS`、无内联属性。锚点漂移：`SET_META` 内 +2、`SET_FIELDS` 内 +2、`setStat` +2 ⇒ app.js 其后整体 **+7**（`setPayload` 774 / `setStat` 789 / `setCard` 797 / `vSettings` 821 / `saveSettings` 863 / `keyCard` 1520 / `toggleKeyReveal` 1599 / `fillGeneratedKey` 1625；事件委托块 `ACTS` 等 2367–2431 → 2374–2438）；`extra.css` 77→**80 行** ⇒ **JS 偏移 +686 → +689**（CSS 偏移仍 +13；三点实测复核：`const IC` 3→产物 692、`autoWeightCard` 657→1346、`tick` 2482→3171）。app.js 2505→**2512 行**，产物 176,449→**177,314 字符 / 3205 行**。

**验证**：`node --check server.js` 通过；新增 `test/thinking-replay-e2e.test.js`（**64 项**：§0 装配守卫 12 + §1 纯函数真值表 + §2 真链路——对照轮关=400 复现、开启后逐字段补回、跨会话/渠道/模型三组反向、流式学习照修、完好客户端一字不动、4xx 作废、跨渠道不借）；既有测试同步：`thinking-fidelity`（36，`signature` 守卫改写为区域守卫）、`same-protocol-passthrough`（44，选路/非流式守卫重锚 + 修复注入守卫）、`settings-api-e2e`（68，四组 + 第四组真链路）、`metrics-e2e`（45，回放 gauge+六事件）、`console-state`（185，四张卡 + 第四组 PATCH）、`weighted-rr`（31，persistConfig 窗口放宽 1400→1900）。全量 **32 文件 / 1548 断言 / 0 失败**（v1.18.7 基线 31/1470）。

**纪律（AGENTS §2 已同步为硬约束）**：thinking 回放六条配套纪律（只回放真签过的、四元键不跨、没坏不碰、4xx 作废、默认关、学习走旁路）；改回放路径后必跑 `test/thinking-replay-e2e.test.js` 与 `test/thinking-fidelity.test.js`。

### 8.32 v1.18.11 数据统计页 + 调用日志客户端列 + 来源 IP 封禁（2026-09-29，对象 `server.js` 统计块 + `build/app.js` 统计页 + 产物 `console.html` + 新增 `test/ip-stats-ban-e2e.test.js` + `test/console-state.test.js` §13 增章 + 全套文档）

**问题**：密钥被人放进"中转站"转卖时**看不见**——调用日志只有请求级记录，看不出"哪个来源 IP 在以多大频率、多大并发、多少个会话在打"；就算看出来了，也没有任何外科手术手段（全局改密钥伤所有正常客户端，限流是全局的连坐）。

**根因**：网关此前**刻意不记来源 IP**（渗透整改后不留可关联数据的姿势，这个方向本身没错），但没有给所有者留"看一眼来源态势"的口子；封禁能力则完全缺失。

**处置（后端，`server.js` 统计块，置于 Host/Origin 门之后、限流之前）**：
- **封禁闸门只拦客户端面**：`/v1` `/anthropic` `/gemini` 撞 `SECURITY_BANNED` → 403（**管理面/控制台/健康检查永远可达**——解封按钮永远不会把自己锁在门外）；被封请求不进 `calls`、不占并发额度，但**单独计入 `bannedHits`**（封了之后对方还在敲，看得见）。
- **敲门计数在鉴权之前**（`noteClientAttempt`：401/429 也算敲门——刷鉴权也是指纹）；per-IP token/模型/会话记账**只在 `recordUsage` 一处**（`statsCtx` 由 4 条客户端路由注入 `dispatchRequest` → `tryChannel` 字面量透传；管理面手动测试不带 statsCtx，不算进任何来源的态势）；per-IP 在飞数归还挂在与限流**同一条 finish/close settle 路径**。
- **会话估计**复用会话粘性的键推导（`affinityKeyFor(req, body, true)` 跳过粘性门槛——粘性开关关着也推）；**客户端标签** `clientLabelOf(ua)` 只做显示；**`X-Forwarded-For` 只在 `trustedProxy` 登记的来源上采信第一跳**（全仓只有 `clientIpOf` 一处读它）。
- **内存态 + 有界**：IP 512 / 会话 512（饱和标 `sessSat`）/ 标签 8 / 模型 64，超限丢最旧；重启清零（检测数据丢得起）。封禁落 `config.security.bannedIPs`（`persistConfig` 白名单加 `security`，否则一次渠道保存就抹掉）。
- 三个管理端点：`GET /admin/api/stats` / `POST /admin/api/bans {ip}`（字面量校验 400 点名、幂等、立即生效）/ `DELETE /admin/api/bans/{ip}`（404 语义）。

**处置（前端，`build/app.js`）**：
- **调用日志「客户端」列**（模型之后）：`adapt()` 解析 `cl`（`r.client`）；格子是 chip，点击 → `stFilter.client` + `go('stats')`（行内 `stopPropagation` 不触发行点击）；空值 `—` 不可点；抽屉补客户端键值。**保住了 v1.13.2 的历史语义**（渠道仍紧跟请求 ID——客户端列放在模型之后，历史守卫不用改语义）。
- **`vStats` 新页**（监控 → 数据统计，紧随调用日志）：四张全局卡（**全局峰值 vs 单来源峰值对比**写明中转站指纹）+ 封禁名单 chip 行（解封 ×）+ per-IP 表（行点击开抽屉，24h sparkline，会话饱和显示 `≥512`）+ 按模型聚合卡 + `openIpStats` 详情抽屉（24 小时面积图 + 封禁/解封按钮）；`stFilter` 模块级跨页保留（过滤 chip ✕ 清除）；封禁/解封 `confirm()` 两步确认（`clearUsage` 先例）。`NAV`/`go()`/`render()` 三表注册；`ACTS` 增 `stats-refresh`/`clear-st-filter`/`ban-ip`/`unban-ip`（44 → **48** 个动作）。
- 表格行内**不放按钮**（封禁/解封只在抽屉与封禁名单行）——行点击与按钮冒泡不打架。
- 锚点漂移：`app.js` 2512 → **2650 行**（净增 138），`extra.css` 与设计稿零改动 → JS 偏移仍 **+689**，产物 3205 → **3343 行**。§0.2 已整表重核（本轮顺带修掉 vChannels/密钥块两组**历史烂账锚点**——v1.18 设置块插入期的旧号从未回填）。

**验证**：`node --check server.js` 通过；新增 `test/ip-stats-ban-e2e.test.js`（**62 项**：§0 装配守卫 11 + §1 纯函数真值表 + §2 真链路——预置封禁 403、XFF 三来源、401 算敲门、token/模型/标签/会话记账、并行峰值 ≥2 且归零、封禁端点全语义、封禁落库且渠道不丢、重启统计清零封禁仍在 + §3 无 trustedProxy 对照）；`console-state` 增 **§13 数据统计页**一节（198 项总量）；`security-headers-e2e` 内联清零 + ACTS 双向覆盖守卫放行（69 项）。全量 **33 文件 / 1635 断言 / 0 失败**（v1.18.8 基线 32/1548）。

**纪律（AGENTS §2 已同步为硬约束）**：来源 IP 态势与封禁六条配套纪律（只拦客户端面、单漏斗、persistConfig 白名单含 security、内存态有界 + trustedProxy 采信门槛、settle 同路径、UA 标签不进控制逻辑）；改统计/封禁/trustedProxy 采信路径后必跑 `test/ip-stats-ban-e2e.test.js`，改统计页渲染后加跑 `test/console-state.test.js`（§13 一节）。

### 8.33 v1.18.12 数据统计页布局整改：KPI 居中 / 列宽定量 / 占位符「—」居中（2026-09-29，对象 `build/app.js` + `build/extra.css` + `console-redesign.html` + 产物 `console.html` + `test/console-state.test.js`；**本条为补记——原始提交 38c80b8 漏同步本文档，v1.18.13 轮补上**）

**问题**：v1.18.11 的统计页是照渠道表格的老套路写的——KPI 数字走内联 `font-size:22px`、来源明细表用 auto 列宽、占位符「—」和真实值混在一起左对齐。用户过目后拍板整改（基于确认过的原型 `_st_preview.html`）：**数字是视觉锚点要居中、列宽要定量、占位符要和真名一眼分得开**。

**根因**：建页时复用了渠道表格的通用样式，但统计页的数据形状不同——IP 长短悬殊、会话列大量空值（`≥512` 饱和前常空）、客户端标签是可变长 chip，auto 布局下列宽互相挤；占位符「—」与真实模型名/标签共用左对齐，"没数据"和"有数据"视觉上分不开。

**处置**：`extra.css` 80 → **105 行**（`.st-kpi*` 居中 KPI 卡、`table.tbl.st-fixed` + 9 列 colgroup 定量列宽、`.st-sec` 分区标题、`table.tbl.st-models` 按模型表、`.t-c-ph` 占位符专用居中）；设计稿只在既有 `.t-c` 行**就地追加**表头补权重 `table.tbl thead th.t-c{text-align:center}`（不增行，照抄 `.t-r` 写法——否则表头输给 `th{left}` 基样式，表头左对齐数值居中又错位）；`vStats()` 就地改类名与 `<table>` 同行内联 colgroup，**app.js 净零行**（锚点不动，JS 偏移 +689 → **+714**，产物 3343 → **3368 行**）。

**验证**：`test/console-state.test.js` §13 增**布局守卫**（198 → **208 项**：KPI 类名计数、colgroup 9 列、表头 `t-c` 七列、数值 `t-r` 清零、`.t-c-ph` 只套占位符、产物 CSS 存在性 + 旧写法对照组）→ 全绿；全量 33 文件 / 1645 断言 / 0 失败。

### 8.34 v1.18.13 客户端 chip 跳转直开抽屉 + 索引错位修复（2026-09-29，对象 `build/app.js` + 产物 `console.html` + `test/console-state.test.js` §13 + 两份前端文档 + tests/AGENTS/README 计数）

**问题**：用户报「调用日志我点击客户端跳转到了数据统计，但是我如何知道这个客户端是属于哪个 IP 的？能不能点击后跳转过去后直接打开那个抽屉框？」——跳过去只看到过滤后的列表，还要自己再点一次行才知道详情。

**根因**：跳转链路只做了"过滤"（`stFilter.client` + `go('stats')`）没做"定位"——客户端标签 → 来源 IP 的映射其实就在 `DATA.stats.ips[]` 里（每个 IP 的 `clients[]`），跳过去顺手弹开匹配来源的抽屉就是答案。顺带发现一颗**潜伏雷**：绑定按 NodeList 索引对 `rows[i]` 取标签——**无标签的行不渲染 chip**，第一行无标签时点第二行的 chip 会套用第一行的**空标签**（过滤悄悄失效，跳到全量列表）。

**处置（`build/app.js`）**：chip 模板带 `data-cl="${esc(l.cl)}"`（标签走 `dataset` 取，**绝不按 NodeList 索引对 `rows[i]` 取**）；点击后 `stFilter.client` + `go('stats')` + **直接弹开最活跃匹配来源的抽屉**（`ips` 按敲门数降序 → `hit[0]`；多个来源共用同一标签时弹敲门最多的，其余都在过滤后的表里；统计里没有该标签时不弹，不误开别的 IP）。绑定块 2 → 10 行（净增 8），`drawLogTable`(1210) 之后锚点整体 +8，app.js 2650 → **2658 行**、产物 3368 → **3376 行**（extra.css/设计稿零改动，偏移仍 +714）。

**验证**：`test/console-state.test.js` §13 增**跳转链路**一节（在 DOM 桩里**真跑 `drawLogTable` 的 chip 绑定**：chip 自带 `data-cl`、渲染数 = 有标签行数、点击后过滤词来自 dataset（**索引错位回归对照**：第 1 行无标签时过滤词是 `codex CLI` 不是空）、`go` 到统计页 + 弹最活跃来源抽屉、`stopPropagation` 不连坐行点击、无匹配时不误弹 + 源码守卫防错位回潮；208 → **215 项**）→ 全绿；`security-headers-e2e` 69/0。全量 **33 文件 / 1652 断言 / 0 失败**。

**纪律（随本轮补记 8.33 的教训）**：`$$(…)` 的 NodeList 索引**不等于** `rows` 索引——有条件渲染（无标签行不出 chip）时按 `rows[i]` 取值必错位，点击参数一律走元素自带 `data-*` 属性（已写进 `docs/frontend-code-map.md` §0.1 历史教训）。

### 8.35 v1.18.17 错误显示统一口 errMsgOf + 登录门 trim（2026-09-30，对象 `build/app.js` + 产物 `console.html` + `test/console-state.test.js` 新增 §17 + README 方式四钥匙名修正 + 三份计数文档）

**问题**（公网部署 wurong.us.ci 实测抓到）：用户报「拿到了密钥还是提示 [object Object]，没有进去控制台」——登录门失败提示只显示 `[object Object]`，真实失败原因被吞。

**根因**：前端两处 + 服务器一处叠加。① 网关错误体是 `{error:{message,type}}` 对象，`api()` 的错误 toast（全控制台共用）与登录门的 `errEl.textContent` 都直接拼 `j.error`——对象进字符串变 `[object Object]`（设置页 `saveSettings` 早已是 `j.error.message||j.error` 的正确姿势，本轮把其余两处拉齐）；② 登录门提交前只判非空不 `trim()`，从终端 `cat` 复制的密钥带尾随换行/空格也会被打成 401；③ **服务器侧真根因**：公网 `.env` 钥匙名写成了裸 `ADMIN_KEY`/`GATEWAY_KEY`（compose 映射读的是带 `ZZCSAPI_` 前缀的名字）——env 落空、容器回落首启生成，`.env` 里那把钥匙两头都不生效；已修服务器（改名不动值、剥 config.json 的 auth 段、重建容器，登录 200 实测）并改 README 方式四 + reverse-proxy 守卫（README 钥匙名必须带前缀）。

**处置（`build/app.js`）**：新增 `errMsgOf(j,fb)` 统一口（219 行，错误体对象取 `message`、字符串透传、`j.message` 兜底、空体走回退文案），`api()` 错误 toast 与登录门失败显示都改走它；登录门提交前 `input.value.trim()`。app.js 净增 1 行，`api()`(220) 之后锚点整体 +1。

**验证**：`test/console-state.test.js` 新增 §17（errMsgOf 真值表 + api()/登录门两处装配守卫 + 旧裸拼模式全仓清零 + trim 守卫；215 → **221 项**）；全量 **34 文件 · 1693 断言 · 0 失败**。

### 8.36 v1.18.19 「从上游探测」钥匙 trim（2026-10-02，对象 `build/app.js` + 产物 `console.html` + `test/console-state.test.js` 新增 §18）

**问题**（用户报「所有渠道我编辑点击从上游获取是错误的……key 你是省略了什么吗？和我保存进去的不一致？」——上游 new-api 回 `HTTP 401 {"error":{"message":"Invalid token…","type":"new_api_error"}}`）。

**根因**：钥匙存储与掩码显示链路全部清白（掩码只进 placeholder、写库用原文、编辑留空 = 保持原钥匙、`chKeyLive` 按需取原文），真凶是 `probeUpstream` 读钥匙框时**没 `.trim()`**——保存路径（2198 行）有 trim，粘贴尾巴的尾随换行在「从上游探测」路径原样发给上游，new-api 比对失败回 Invalid token。用户「保存进去的和发出去的不一致」的直觉完全正确：**库里存的是干净的，发出去的是带尾巴的**。服务器侧用库内原文直发 `/admin/api/probe` 实测 `ok:true · 302 个模型`，确认钥匙本身完好。

**处置（`build/app.js`）**：2081 行 `$('#f-key').value` → `.value.trim()`，与保存路径对齐；行内注释记下现场教训。

**验证**：`test/console-state.test.js` 新增 §18（trim 装配守卫 + 旧写法清零 + 保存路径不回退 + `probeUpstream` 结构守卫；221 → **225 项**）；全量 **34 文件 · 1700 断言 · 0 失败**。

### 8.37 v1.18.20 渠道钥匙框的浏览器自动填充闸门（2026-10-02，对象 `build/app.js` + `server.js` POST /admin/api/channels + 产物 `console.html`）

**问题**（用户报「我把 key 复制进去后，点击保存渠道，然后关闭，再点编辑-明文显示，显示的为什么是登录控制台的 key？」）。

**排查**（三层全清白后才定位到浏览器一侧）：① 揭示端点只返回本渠道存值（`server.js` `GET /admin/api/channels/{id}/key` → `ch.def.apiKey`）；② `toggleKeyField` 只在钥匙框**为空**时现取原文，框里有值就直接显示框里的；③ 本地 34 渠道 sha256 布尔扫描——**没有任何一把存值等于管理/网关密钥**。结论：那个「登录用的 key」不在库里，是**浏览器自己填进密码框的**——登录门输入框是 `type="password"`，浏览器会把登录密码自动填进页面上其它密码框（渠道表单钥匙框恰是 password 型）；剪贴板残值（复制管理密钥登录 → 转头粘贴渠道钥匙）同效。

**危险**：在钥匙框被自动填入管理密钥的状态下点「保存渠道」，渠道真密钥就被覆盖成网关自己的钥匙，上游立刻 401 Invalid token——服务器此前对这种错填是静默接受的。

**处置（双保险）**：
- 前端（`build/app.js`）：`#f-key` 与 `#zz-gate-input` 两个密码框都加 `autocomplete="new-password"`——浏览器不再自动填入已存登录密钥；登录门也不再把管理密钥收进浏览器密码库（延续「管理密钥不落任何浏览器存储」纪律）。
- 服务端（`server.js` POST /admin/api/channels）：`apiKey` 等于本网关生效的管理/网关密钥一律 **400 拒收**（错误文案点名「浏览器可能把登录密钥自动填进了钥匙框，请清空后重新粘贴上游的 key」），渠道原密钥不动——真填错了也只是一次明确的拒绝，不是一次静默的数据损失。

**验证**：`test/console-state.test.js` 新增 §19（两框 autocomplete 装配守卫 + 全仓 password 框无一裸奔；225 → **228 项**）；`test/security-headers-e2e.test.js` 增 2 项真链路（apiKey=管理密钥 → 400 且揭示端点证明原密钥未被覆盖；apiKey=网关密钥 → 400；70 → **72 项**）；全量 **34 文件 · 1705 断言 · 0 失败**。

---

### 8.38 v1.18.23 两处搜索框清空对称（2026-10-03，对象 `build/app.js` + 产物 `console.html` + `test/console-state.test.js`）

**问题**（用户报 + 截图：「这两个地方，在任一个位置输入了，单独删右上角搜索框的内容无法退出搜索。但是单独删除左面的筛选可以退出搜索」——右上角全局搜索（`#globalSearch`）与渠道页左侧筛选框（`#chQ`）都显示着 `11`，删掉右上角那段文字后渠道列表**仍被过滤**）。

**根因**：两处**共用一份状态** `chQ`，但**清空路径不对称**。左侧筛选框 `oninput` 实时写回（`chQ=e.target.value;drawChTable()`），删空即退出；右上角搜索框**只在按回车时写一次** `chQ`（`if(e.key==='Enter'){chQ=q;go('channels')}`），此前**没有 `input` 监听**——把文字删掉时 `chQ` 仍是旧值，列表自然还在过滤，而且没有任何入口能“退出搜索”。

**处置**（`build/app.js`，两处对称）：
- 新增 `syncGlobalSearch(val)`：把值写回右上角搜索框（元素不存在时静默跳过）。
- `#globalSearch` 增 `input` 监听：**删空**时清 `chQ`、清左侧筛选框、`render()` 重绘当前页（退出搜索）；**有内容时仍然回车才生效**（原语义不动，正在输入不打扰列表）；本来就没在搜索时不触发无谓重绘。
- 渠道页左侧 `oninput` 接上 `syncGlobalSearch(chQ)`：左侧删空时右上角同步清空，避免“状态已退出、右上角还留着一串字”的显示与状态不一致。

**验证**：`test/console-state.test.js` 新增 §20（把真实的 `syncGlobalSearch` + 两个 `#globalSearch` 监听块抠出来在桩 DOM 上真跑：回车仍写 `chQ` 并跳渠道页、输入中未回车不动列表、**右上角删空 → 清 `chQ` + 清左框 + 重绘**、未在搜索时删空不重绘、左侧删空 → 右上角同步清空、左侧接线结构守卫；228 → **236 项**）；全量 **35 文件 · 1732 断言 · 0 失败**。产物 `console.html` 重建（JS 偏移仍 **+714**；`app.js` 2660 → **2674 行**、其后的代码地图锚点整体 +14，已按 AGENTS §1.2 整表重核）。

**教训**：共享同一份过滤状态的多个入口，**每个入口都必须有“清空”路径**，否则会出现“能从 A 退出、不能从 B 退出”的不对称——写交互时先问一句“这个入口怎么退出”。

---

### 8.39 v1.18.24 移除右上角全局搜索框（2026-10-03，对象 `build/shell.html` + `build/app.js` + `console-redesign.html` + `build/build.js` + 产物 `console.html` + `test/console-state.test.js`）

**问题**（用户问「右上角的那个搜索只搜索渠道的吧？其他页右上角也是一样的，回车会跳转到渠道管理。但是这样的搜索有必要存在吗？渠道搜索本身就有一个搜索了。」）。

**核对后确认属实**：那个框（`#globalSearch`）的全站唯一行为就是——回车把关键词塞进渠道页状态 `chQ`，再 `go('channels')` 跳过去。而渠道页**自己就有筛选框**（`#chQ`，实时过滤）；调用日志、聚合模型等页也各有各的搜索。放在 topbar 却总跳渠道管理，是纯粹的**重复入口**，还容易被误解成"搜索当前页"。`Cmd/Ctrl+K` 还专门为它抢焦点。

**处置（用户拍板：直接删掉）**：
- `build/shell.html`：删掉 topbar 里的 `.search` 容器（图标 + 输入框 + `⌘K` 提示），**52 → 47 行**。
- `build/app.js`：删掉 `syncGlobalSearch` 与 `#globalSearch` 的 keydown/input 两个监听、以及 `keydown` 里 `Cmd/Ctrl+K` 聚焦那句；渠道页左框恢复为 `oninput=e=>{chQ=e.target.value;drawChTable()}`（v1.18.23 为它做过的"清空对称"随之作废）。
- `console-redesign.html`（设计稿）：同步移除顶栏搜索框与那两段 JS（原型与产品一致，净 −9 行）。
- **`build/build.js` 行数守卫：21/52 → 21/47** —— shell 少 5 行意味着 **JS 行号偏移 +714 → +709**，这是构建期硬守卫，不改就构建失败（本轮真实触发过）。`docs/frontend-code-map.md` 的偏移表、§0.2 锚点、§3 原型锚点与 AGENTS.md §1.2 已同步重核。

**验证**：`test/console-state.test.js` §20 改写为**"它真的没了、也没被换名字加回来"**的结构守卫（`shell.html` / `app.js` / 产物 `console.html` / 设计稿四处都不含 `globalSearch`、不再有 `Cmd/Ctrl+K` 抢焦点；且渠道页左框仍在——它是唯一的渠道搜索入口）：236 → **234 项**（原 8 项对称断言 → 6 项移除守卫）；`security-headers-e2e` 72/0；全量 **35 文件 · 1730 断言 · 0 失败**。产物重建：`app.js` **2660 行**、产物 **3373 行**、JS 偏移 **+709**。

**教训**：**重复入口比没有入口更糟**——它在各页都可见，却只对其中一页有效，用户会先被误导再被辜负。加"全局"控件前先问：它跟页面自带的那个是什么关系？如果答案只是"跳过去用那个"，那就该删。

---

### 8.40 v1.18.33 渠道级「不发这些参数」`dropParams`：把开关放到最靠近问题的那一层（2026-10-04，对象 `server.js` 出站剔除 + `build/app.js` 表单/抽屉 + `console-redesign.html` 演示表单 + 产物 `console.html` + 新增 `test/channel-drop-params-e2e.test.js` + `test/console-state.test.js` 增章 + 两份前端文档 + `AGENTS.md`）

**问题**：某上游渠道（`agentrouter`，每天固定开放额度）对「`tools` + `reasoning_effort`」这个组合**直接 400**，上游原文 `Function tools with reasoning_effort are not supported for gpt-6-astra`。而用户的客户端（DSH）**每次请求都同时带这两样** → 该渠道 **100% 失败**（调用日志里 19 行 0 成功），用户看到的是"这个渠道配了却完全不能用"。

**根因**：参数是**客户端**发的，网关只做原样转发——`reasoning_effort` 这个字段在 `server.js` 里**一次都没出现过**，我们既没加也没删。客户端不由我们控制（DSH 不会为我们关掉 `reasoning_effort`），所以"让客户端别发"这条路走不通；也**不能全局删**——别的渠道正需要这个参数。

**处置**：把开关放在**渠道**上（全局或客户端都不是正确的那一层）：

- 渠道表单新增「**不发这些参数**」输入框（`#f-drop`，逗号/空格分隔），抽屉里显示该渠道已配的清单；新增 4 个辅助函数 `dropWhitelist()` / `dropParamsOf()` / `dropChipsHtml()` / `addDropParam(k)`（夹在 `toggleCh` 与 `openChannel` 之间）。
- 输入框下方跟一排**服务端下发的合法参数名 chips**，点一下填进框（`data-act="fill-drop-param"` + `data-k`，走 v1.18.7 的事件委托；`ACTS` 表 **48 → 49**）。
- **合法参数名清单只从 `GET /admin/api/config` 的 `dropParamWhitelist` 取**——前端**不抄第二份**（抄了就会与后端漂移：后端加了名字、前端还按老清单渲染，用户点不到、也看不出为什么点不到）。
- **框空 = 显式提交 `[]` = 清空**，与 `weight` 的"留空 = 不动"**刻意不同**：这个框没有"我没意见"的中间态，空就是"什么都不剔除"。
- 剔除只作用于**出站副本**，绝不原地改客户端报文对象（那个对象在候选链里被多家渠道共用）——第一家失败切到第二家后，第二家**仍收到**该参数。
- 白名单外的名字后端 **400 并回带合法清单**，**不静默忽略**——静默忽略正是"配了却没生效、然后对着一个 100% 失败的渠道排查半天"的成因。
- 边界：`workbuddy`/`codex`/`genspark`/`notion-agent` 自带专用报文构造，配了**不生效**（不是 bug，是这些协议本来就不走通用出站报文）。

**验证**：新增 `test/channel-drop-params-e2e.test.js`（85 项）——真起「假上游 + 临时网关」断言上游**真收不到** `reasoning_effort` 而 `tools` 仍在、对照组（没配的渠道）照样收到、**不串味**、同协议直通也生效、白名单外 400、落库往返 + 保存别的渠道后仍在（`persistConfig` 是显式字段清单，漏一行就被下次保存抹掉）、显式空数组 = 清空、`/admin/api/config` 下发 `dropParamWhitelist`；前端 §3b 在 `test/console-state.test.js`。产物重建：`build/app.js` **2660 → 2719 行**、产物 `console.html` **3373 → 3432 行**；设计稿 `<style>` **一行未动** → **CSS 偏移 +13 与 JS 偏移 +709 均不变**（实测复核：`dropChipsHtml` app.js 972 → 产物 1681）。

**教训**：**"客户端发错参数"的正确修法是把开关放到最靠近问题的那一层**——全局删会砸到别的渠道，改客户端不由我们做主，只有"渠道级剔除"既精确又不影响别人。另一条：**服务端下发的清单不要在客户端抄第二份**，任何"两边各存一份枚举"的设计迟早会漂移。

---

### 8.41 v1.18.34 失败归因：502 的每条 `attempts` 都要能自证原因（2026-10-04，对象 `server.js` 失败归因 + `test/upstream-4xx-fallback-e2e.test.js` 增两节 + `docs/behavior.md` + `docs/tests.md` + `AGENTS.md`）

**问题**：用户报「`gpt-6-astra` 我在聚合中转测试成功，为什么调用失败」，贴来的 502 载荷里有 8 条 `attempts`，其中两条长这样：
`{"ch":"mjiutang5920","err":"channel_error"}` / `{"ch":"mjiutang1","err":"channel_error"}` —— **只有一个词**。
翻渠道运行态才知道它们当时真实的失败是 **`HTTP 429`（空响应体）** 与 **`HTTP 403`（`<!DOCTYPE html>…zh-CN` 挑战页）**，
即"被限流"与"被 WAF 拦"，跟"参数写错"完全是两回事、处置也完全不同。用户拿到报文看不出任何东西，只能反过来问我们。

**根因**：`'channel_error'` 是个**不透明标签**——`tryChannel` 用它在 4xx 时告诉调度核心"切下家、同渠道不重试"，
真正的原因（HTTP 码 + 上游原文）写在了渠道运行态的 `lastError` 里。调度循环攒 `attempts` 时只 push 了那个标签字符串：
`errors.push({ ch: c.channelId, err: result })`。逐字读完 `server.js` 后确认：**这是唯一一处会把上游 HTTP 码丢掉的返回值**
（其余分支返回的 `stream error frame: …` / `network: …` / `in cooldown（…）` 本身都带原因）。

**处置**：新增 `attemptErr(err, channelId)`，只给"不带原因"的两类补上渠道**刚刚**记下的 `lastError`：

- `channel_error`（4xx：无码无文）与 `/^upstream \d/`（5xx：只有码没有上游原文）→ 格式 `channel_error：HTTP 429: <上游原文前 160 字>`，
  换行/制表符压成空格（那条 403 的正文是 HTML，不压缩就会把裸 HTML 塞进 JSON 报文）。
- **只补这两类**：`stream error frame: …` / `network: …` 已经带原因，再拼一遍就是噪音。
- 补进去的是**本次**原因而非陈年旧账：4xx 路径返回 `'channel_error'` 之前**必定**先 `recordFailure`（通用路径 5295、
  workbuddy 5980、codex 6596、notion 6720、genspark 6229 都已核对）。
- 与冷却分支那句「in cooldown（…：上游原文）」（v1.14.1）是同一招——**凡是进入 `attempts` 的失败，都要能自证原因**。

**验证**：`test/upstream-4xx-fallback-e2e.test.js` 新增 §9/§10 与两条装配守卫（**32 → 43 项**）：
全链 429 → 502 时**每条** `attempts` 都带 `HTTP 429` 与上游原文、原因被压成单行；对照组（单候选 500）证明原文只出现一次、不拼两遍；
守卫钉住 `errors.push` 必须过 `attemptErr`（不许退回裸 `err: result`）、`attemptErr` 只认那两类。全量回归 **41 文件 · 1928 项全过**。

**教训**：**给客户端看的失败信息，不许是一个内部标签**。网关内部为了路由方便给失败起了个名字（`channel_error`），
就必须在出门前把它翻译回人看得懂的东西——否则每一次排查都得回到服务器上翻运行态，而这些信息本来就在手上。
排查这次问题的顺序也是教训：先看**账本的真实数字**（`in=9823~10274`，不是我们以为的 13 万）再下结论，
差点把"上下文超限"错记成"上游抖动"。

---

### 8.42 v1.18.35 记账口径：工具轮不许被记成"零产出的成功"（2026-10-04，对象 `server.js` 流式记账 + 新增 `test/tool-turn-accounting-e2e.test.js` + `docs/behavior.md` + `docs/tests.md` + `AGENTS.md`）

**问题**：盘账本时发现 `deepseek-v4.1-flash` 有 **196 行 `ok:true` 且 `out=0`**，耗时只有 8~38 秒（有正文的行是 45~147 秒），且与"有正文的行"在**同一渠道、同一分钟**里交错出现。我据此判定"约 35% 的调用返回空回复"，当成 P0 排查。

**定性（这一步推翻了我自己的结论）**：开 `ZZCSAPI_DUMP_BODIES` 抓到 DSH 的真实报文（`stream:true`、`max_completion_tokens:32768`、**`tools:40`**、消息 119~231 条、体 450~560KB），再把留证里的报文**逐字节回放**给本地网关 —— **3/3 复现**：HTTP 200、52 个 SSE 帧里 **49 个是 `tool_calls`**、可见正文 0 字符、`finish_reason=tool_calls`；而上游 usage 帧明明自报 `prompt_tokens: 176351 / completion_tokens: 114`，账本却记 `in=56324 out=0`。**客户端拿到的是完整的工具调用，这条链路完全正常**——`out=0` 只是记账口径。

**根因**：常规链路（openai 渠道 → openai 客户端）既不建 `nativeStream`、也不走同协议直通（`passthrough` 只给 anthropic/gemini），于是：
① 上游自报的 usage 帧被**整帧丢掉**——`nativeStreamUsageScan` 只认 anthropic/gemini、`passthroughUsage` 只在直通路径填，`realUsage` 在这条路上恒为 undefined → `in` 永远是自己的估算、`out` 只数可见正文；
② `streamOutText` 只累计 `sseDeltaText()` 取到的可见正文，纯工具轮没有正文 → `out = estimateTokens('') = 0`。

**处置**（全在记账侧，失败判据路径一字未动）：新增 `openaiUsageFromFrame()` 与 `sseToolCallText()`；成功记账改为 `in/out` **上游自报优先**、缺帧或报 0 时回落估算（**把工具调用的 name+arguments 算进估算**），`reason` 优先用上游自报的 `reasoning_tokens` 并**钳到 ≤ out**，纯工具轮留 `note: 'tool_calls'`；直通路径补上思考占比累计（此前只有常规链路记）。两个必须钉住的细节：usage 帧要在 `noteStreamLine` 的 `if (sawStreamContent) return` **早退之前**抓（上游常把 usage 放在最后一个 chunk），以及**只作用于出站副本**那一类纪律照旧（本改动不碰报文）。

**验证**：新增 `test/tool-turn-accounting-e2e.test.js`（**40 项**：两函数真值表；★纯工具轮 + usage 帧 → `in/out` 取上游真值并留 `tool_calls` 标记；★纯工具轮**没有** usage 帧 → `out > 0`（旧写法 = 0）；文本轮两组对照；思考轮 `reason` 用上游真数字且 ≤ out；含"usage 帧必须在早退之前抓"的顺序守卫与"旧写法已清零"的结构守卫）。全量回归 **42 文件 · 1968 项全过**。

**教训**：**账本里的 `out` 不是"客户端看到了什么"，而是"这条路径当时怎么算的"**——拿一个记账数字去推客户端体验，我得出了完全相反的结论；把它纠正过来的是"留证 + 逐字节回放"，不是继续读代码。另一条老毛病又出现了一次：**同一件事两处实现、其中一处忘了对齐**（"上游 usage 优先"直通路径早就有，常规链路一直没有），这个仓库的多数真 bug 都是这一类。

---

### 8.43 v1.18.36 账本的「天 / 小时」一律按北京时间切（2026-10-05，对象 `server.js` 账本时钟 + 新增 `test/usage-day-key.test.js` + `docs/behavior.md` / `docs/tests.md` / `AGENTS.md`）

**问题**：查「yu1 渠道最近 24 小时用了多少 token」时，账本**答不了**——`recent` 明细只留 800 行（当前流量下仅覆盖 **1.7 小时**）、`byChannel` 是累计值没有时间维度、`byDay` 有日期维度却不带渠道维度。顺着这条线核对时间维度时，撞上更要紧的一处：**日桶与小时桶对不上**。

**根因**：`recordUsage` 里 `const day = new Date(ts).toISOString().slice(0,10)` 取的是 **UTC 日**，而 `/admin/api/usage` 的 24 小时分布用 `new Date(r.ts).getHours()`（**本地小时**）——同一个账本里两套钟，日界落在**北京时间早上 8 点**：凌晨 0~8 点的流量被算进前一天（本次现场正好是北京时间 00:0x，请求的 `ts` 在北京 10-05，`byDay` 却记进 `2026-10-04`）。`ipStatsBumpHour` 更自相矛盾：注释写「本地时区，跨天清零」，代码是 UTC 日 + 本地小时。

**处置**：新增账本时钟 `cnDayKey(ts)` / `cnHour(ts)`（**固定 +8**），账本四处口径统一走它们——`byDay` 桶键、per-IP 24 小时桶的日界与小时、`/admin/api/usage` 的 `hourly`。**为什么固定 +8 而不是图省事用 `getDate()/getHours()`**：后者取决于**进程时区**（compose 里设了 `TZ=Asia/Shanghai`，但裸跑 `node server.js` 的机器可能是 UTC），账本口径不该随部署环境漂；中国无夏令时，+8 恒定。

**影响（前端要知道的两件事）**：① 趋势大图的「按天」柱子与 KPI 环比的日界从"北京 08:00"变成"北京 00:00"——**这是修正，不是回归**；② `byDay` 是累计值、不重算，所以**改动之前的桶仍是 UTC 日**：`2026-10-04` 那个桶装的是北京时间 10-04 08:00 之后的量（看着偏短），北京 10-05 从零起。前端**无需改代码**（`adapt()` 只把 `day` 字符串切 `MM-DD`，不做任何时区换算）。

**教训**：**同一个账本里不许有两套钟**。这次是"日期取 UTC、小时取本地"混在同一个函数族里，注释还写着"本地时区"——**注释与代码各说一套时先信代码，再判断哪个才是本意**；本意（北京时间）是明确的，错的是实现。


- 密钥明文显示加"仅本次会话"提示或二次确认
- 探测结果支持"仅显示新增"过滤
## 9. 后续可做（未实现）

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
| `build/extra.css` | 加**生产独有组件** | 设计稿快照里没有的组件（codex chip、抽屉密钥行等宽字、自动权重观测卡 `.aw-*`）。**必须复用设计令牌** |
| `build/app.js` | 改**生产逻辑** | 数据层（`adapt` / `loadAll` / `api`）+ 动作层 + 6 个页面渲染 |
| `build/build.js` | 改**构建方式** | 组装顺序 + 自检 |
| `console.html` | **没人改** | 产物。手改会被下次构建静默覆盖 |

### 11.3 构建产物结构

（以下为 v1.13 实测值，`console.html` 共 2736 行）

```
<head>                      1–21      来自 build/head.html（第 21 行即 <style> 开标签）
<style> 内部：
  ├─ 构建说明 banner         23
  ├─ 设计稿 CSS 原文         24–550    来自 console-redesign.html 的 <style>（逐字节，527 行）
  └─ 生产补充 CSS            552–608   来自 build/extra.css（57 行）
</style>                    610
<body>                      612 起，shell 骨架 613–664（52 行，来自 build/shell.html）
<script>                    666 起，app.js 行号换算 +666，JS 内容至 2732
</script>                   2734
</body>                     2735
```

> 行号换算：CSS = 设计稿行号 **+13**；JS = `build/app.js` 行号 **+666**。
> 增删 `build/head.html` / `build/shell.html` / `build/extra.css` 的行会改变偏移，届时同步修正
> [frontend-code-map.md](./frontend-code-map.md) §0.1 与 [`AGENTS.md`](../AGENTS.md) §1.2。
> （上面这组数字随 `build/app.js` 增长而变，改完 app.js 记得重数——v1.6 从 2477/2480 挪到 2614/2617；
> v1.8.1 因 `build/extra.css` 由 8 行涨到 68 行、`app.js` 涨到 2023 行，落到 2700/2702/2703；
> **v1.9** 因 `.aw-*` 重写使 `extra.css` 回落到 58 行（JS 偏移 +677 → **+667**）、`app.js` 涨到 2035 行，
> 落到 2702/2704/2705，全文 2706 行；
> **v1.9.1** 删 `.aw-nm .id` 使 `extra.css` 58 → 57 行（JS 偏移 +667 → **+666**）、`app.js` 仍 2035 行，
> 落到 **2701/2703/2704，全文 2705 行**；
> **v1.13** `openTestModels` 支持停用渠道使 `app.js` 2035 → **2039** 行，
> 落到 **2705/2707/2708，全文 2709 行**；
> **v1.13.1** 测试结果行加模型名与三档结论（新增 `chName` / `testRowVerdict`）使 `app.js` 2039 → **2066** 行，
> 落到 **2732/2734/2735，全文 2736 行**。）
> ⚠️ 数行数别用 `Get-Content`：产物 `console.html` 是 LF/CRLF **混排**的，PowerShell 会数错
> （实测 console.html 数成 2663 而真实是 2709）。用 `node -e "…match(/\n/g)"` 数，与 `build/build.js` 的口径一致。

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
