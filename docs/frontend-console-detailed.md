# 控制台前端 · 详细设计文档

> 对象文件：
> - `console-redesign.html` —— 新版控制台的**高保真静态原型**（单文件、零依赖、零构建，双击即可打开）
> - `console.html` —— **现役生产控制台**（真实请求 `/admin/api/*`），v0.2 已按原型完成视觉/交互回填，见 §11
> 快速定位请用 [frontend-code-map.md](./frontend-code-map.md)；本文讲**为什么这么写**和**怎么继续扩展**。
> 定稿版本：v0.3（2026-09-25）

---

## ⚠️ 维护约定（强制）

**本文档与代码必须同进同出。** 任何人（含其他 Agent）改动代码后，必须在同一次改动里：

1. **在 §8 变更日志追加一行** —— 格式固定为「问题 → 根因 → 处置」，不接受"已优化"这类空话。
2. **同步受影响的章节** —— 改了配色/字体/布局就更新 §2 §3，改了组件样式就更新 §4，改了页面或弹窗流程就更新 §5 §6。
3. **改了接口就更新 §7** —— `server.js` 端点变动必须反映到「原型 → 生产」映射表，并同步 `README.md` 端点总表。
4. **代码地图同步** —— 若涉及 `console-redesign.html` 或 `console.html`，按 [frontend-code-map.md](./frontend-code-map.md) 顶部的约定核对行号锚点。
5. **两边都要改** —— 原型与生产是**两份独立文件**（变量名也不同，见 §11）。只改一边会导致下次回填时互相覆盖，改动必须同时落到 `console-redesign.html` 和 `console.html`。

完整规则见仓库根目录 [`AGENTS.md`](../AGENTS.md)。**文档与代码不一致，视为改动未完成。**

---

## 1. 定位与边界

| 项 | 说明 |
| --- | --- |
| 是什么 | 新版控制台的**高保真静态原型**，用于确定视觉与交互方案 |
| 不是什么 | **不连后端**。没有 `fetch`、没有 WebSocket、没有鉴权，数据来自文件内 `DATA` 常量 |
| 与 `console.html` 的关系 | 后者是现役生产控制台（真实请求 `/admin/api/*`）。v0.2 已把原型的视觉与交互回填到生产，**两份文件现在同源同貌，但变量名不同**（生产沿用旧命名，见 §11） |
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
| `.chip` | 协议标签 | 每个协议一种配色（`.chip.openai` 蓝 / `.anthropic` 黄 / `.gemini` 紫 / `.workbuddy` 琥珀 / `.notion` 中性 / `.notion-agent` 绿 / `.genspark` 紫 / `.arena` 红） |
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
- **生产侧对应实现（v0.2）**：`console.html` 有 4 个 `.mask` 弹窗 —— `#mask`（渠道编辑）、`#codex-mask`、`#gs-mask`、`#test-mask`。
  这四个在 v0.2 之前**都绑了遮罩点击关闭**，与原型策略不一致（用户反馈复制时误关）；已统一摘除，并新增一条**全局 `keydown` 监听**补上原本缺失的 `Esc` 关闭能力（生产原先没有任何 Esc 处理）。
  抽屉 `#dmask`（个性化）**保留**遮罩点击关闭 —— 它是"看设置"不是"填表单"，没有长文本复制风险，与 §4.7 的策略一致。

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
- 时间范围页签 `24h / 7d / 30d`：**当前仅切换选中样式，不切换数据**（原型范围限制）

### 5.2 涨跌颜色（中国股票惯例）

```css
.delta.up  { color:var(--err); background:var(--err-soft) }  /* 涨 = 红 */
.delta.down{ color:var(--ok);  background:var(--ok-soft)  }  /* 跌 = 绿 */
```

> 与欧美惯例相反，**这是需求方明确要求的**。同时移除了原本的 ↑/↓ 箭头——
> 方向已由 `+/-` 符号和颜色双重表达，再加箭头是三重冗余（`kpiCard` 1234 行有注释留档）。

生产侧同规则、不同变量名（`console.html` 沿用旧 token）：

```css
.delta.up  { color:var(--red);   background:var(--red-soft)   }  /* 涨 = 红 */
.delta.down{ color:var(--green); background:var(--green-soft) }  /* 跌 = 绿 */
```

`deltaBadge(delta)` 也已去掉箭头、去掉 `invert` 参数（旧版 `invert` 会把"好/坏"折算成颜色，
与"方向即颜色"的新规则冲突）。**改这里时别顺手改回欧美惯例**，见 `AGENTS.md` §2。

### 5.3 渠道管理 `vChannels`（1351）

- 工具栏：导入（四项下拉）/ 测试模型 / 添加渠道
- 筛选：全部 / 已启用 / 已停用 页签 + 名称·ID·协议搜索框
- 表格列：启用开关 / 渠道 / 协议 / 状态 / 延迟 / 模型数 / 优先级 / 请求·错误 / 成功率 / 操作
- 操作列：**测试 / 编辑 / 详情**（三个都要 `stopPropagation`）
- 排序（1397）：「全部」页签下**已启用优先**，同组内按优先级、请求量降序

**渠道详情抽屉 `openChannel`（1432）**：
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
`pgSend`（1795）模拟流式输出：逐字/逐块插入 → 结束补 usage。
无真实请求，仅演示交互。

### 5.7 接入信息 `vAccess`（1852）

三套协议（OpenAI / Anthropic / Gemini）的 baseURL、密钥、示例代码，代码片段用 `.code` + 页签切换（1922）。

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

- 模拟上游 `/v1/models` 返回 `PROBE_POOL`（约 46 个模型，贴近真实中转站规模）
- 面板 `.probe-panel`：搜索框 + 可滚动列表（`max-height:212px`）+ 底部计数与批量按钮
- 已存在的别名行标 `.have`（半透明 + 不可勾选），避免重复添加
- 支持**搜索过滤** `filterProbeRows`、**全选** `probeSelectAll`、**清空** `probeClearSel`、**批量加入** `probeAddSelected`

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

### 6.3 测试模型 `openTestModels(opts)`（2342）

- 支持 `{channelId}` 预筛（从渠道行/抽屉进入时只显示该渠道的模型）
- 分组多选列表 `.test-list`（分组头 sticky）+ 提示词输入
- `runTests`（2388）逐条执行：先插"等待"行 → `simTest` 出结果 → 替换为成功/失败行 → 汇总"x/y 通过"
- `simTest`（2329）按渠道状态与历史失败率决定成功或失败（停用/不可用 → 502；失败率≥50% → 429）

### 6.4 全局交互

| 交互 | 实现 |
| --- | --- |
| `Esc` | 有弹窗先关弹窗，否则关抽屉（2420） |
| `Cmd/Ctrl + K` | 聚焦全局搜索框 |
| 全局搜索回车 | 关键词写入 `chQ` 并跳转渠道页（2434） |
| 主题切换 | `#themeBtn`，写入 `localStorage['zzcs-theme']`，刷新保持 |
| 点击菜单外部 | 关闭所有下拉菜单（1944） |

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
3. 鉴权头：`Authorization: Bearer <ADMIN_KEY>`；旧的 `?key=` 方案只写 sessionStorage 并脱敏 URL
4. `DATA` 就地修改的模式不能沿用——真实环境应改为"请求 → 更新本地 state → 重绘"

> **回填状态（v0.2）**：以上四项注意事项目前均已满足，生产 `console.html` 真实请求后端、无假密钥逻辑。
> 生产侧多出来的能力（genspark 双导入、codex 配额、渠道级自定义请求头、密钥明文切换）原型里没有，**原型不必追平**。

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

原型没有、只存在于生产的两项能力。**原型不必追平**，但改生产时要知道它们的存在（清单同步登记在 [frontend-code-map.md](./frontend-code-map.md) §0.1）。

| # | 问题 | 根因 | 处置 |
| --- | --- | --- | --- |
| 1 | Genspark 网页会话无法接入：上游没有 `/models`、鉴权是 cookie 且**必须走代理**，通用 OpenAI 分支全链路不通 | 缺 `genspark` 协议分支，探测与调度都落到通用 `fetch` | `server.js` 新增 `genspark` 协议（`gensparkCookie/Headers/BuildPayload/ParseSSE` + `tryGensparkChannel`），探测走免费的 `GET /api/is_login`；控制台加协议选项、Base URL 默认值、**代理必填提示**，以及「导入 genspark 会话（粘贴）/ 导入 genspark JSON（多选批量，`mode:'add'` 一会话一渠道）」两个入口 + 导入弹窗 |
| 2 | 渠道"连续失败"只影响熔断，配置的 `priority` 无法反映近期真实健康度，坏渠道只要 priority 高就永远先被选中 | 排序直接用 `ch.def.priority`，失败只累加 `consecutiveFail` 触发冷却 | `server.js` 加滚动窗口健康分（`bumpRoll` / `rollFailRate` / `effPriority`，样本 ≥5 生效、120 次减半衰减），`channelsServing` 改用有效优先级；`/admin/api/status` 下发 `effectivePriority` / `rollFailRate`，控制台渠道卡在降权时显示 `→ 有效 X（失败率 Y%）` 角标 |

---

## 9. 后续可做（未实现）

- 时间范围页签（24h/7d/30d）真正切换数据
- 渠道列表分页 / 虚拟滚动（真实 30+ 渠道，模型探测可能上百）
- 密钥明文显示加"仅本次会话"提示或二次确认
- 探测结果支持"仅显示新增"过滤
- 表单校验错误定位（当前只给行内状态文字，不滚动定位到出错字段）
- 移动端适配（当前 ≤900px 直接隐藏侧栏，无抽屉式导航）

---

## 10. 验收清单

见 [frontend-code-map.md §8](./frontend-code-map.md#8-快速自测清单改完跑一遍)。

---

## 11. 生产控制台落地（`console.html`）· v0.2

### 11.1 为什么两边的变量名不一样

回填时**没有把原型的变量名搬过来**，而是沿用生产原有的旧命名（`--indigo` / `--cyan` / `--violet` / `--card` / `--tx2` …），只把**值**整体换成暖色系。原因：

- 生产的 markup 与 JS 里有大量内联 `var()` 引用（如 `style="color:var(--indigo)"`、`chColor()` 返回值、SVG 内联 `fill`），改名要连带动 JS，收益为零、风险不小
- 生产还有原型没有的协议色（`--violet` 给 genspark、`--pink` 等），映射关系不是一对一

**代价**：两份文件的 token 名不同，看文档时别混用。下表是权威映射。

### 11.2 变量映射表（生产 ←→ 原型）

| `console.html`（生产） | `console-redesign.html`（原型） | 含义 |
| --- | --- | --- |
| `--bg` / `--bg2` | `--bg` / `--bg-2` | 页底 / 凹陷面 |
| `--card` / `--card2` / `--card3` | `--panel` / `--panel-2` / `--panel-3` | 容器 / 次级面 / 悬停面（三层递进） |
| `--line` / `--line2` / `--line3` | `--line` / `--line-2` / `--line-3` | 描边三级 |
| `--tx` / `--tx2` / `--tx3` | `--tx` / `--tx-2` / `--tx-3` | 主 / 次 / 弱文字 |
| `--indigo`（+ `-soft` / `-line`） | `--accent`（+ `--accent-soft` / `--accent-line`） | **主强调色**（亮=暖锈橙 `#b1500f`，暗=暖琥珀 `#e39a4e`） |
| `--accent-ink` | `--accent-ink` | 强调色块上的前景字 |
| `--accent-grad` / `--accent-shadow` | 原型为硬编码渐变 | 渐变强调 + 光晕（新增，集中为变量） |
| `--cyan` | `--accent-2` | 次强调（暖陶土） |
| `--green` | `--ok` | 成功 —— **在涨跌里表示"跌"** |
| `--amber` | `--warn` | 警告 |
| `--red` | `--err` | 错误 —— **在涨跌里表示"涨"** |
| `--violet` / `--pink` | `--violet` / `--info` | 协议·分类色。**生产=暖梅 `#8b4a7d` / 暖玫瑰 `#b0466b`；原型的 `--violet` / `--info` 仍是冷紫 `#6b45c4` / 冷蓝 `#1f6fe0`**，见 §9 遗留问题 |
| `--mask-bg` | `--scrim` | 弹窗遮罩 |
| `--hair` | `--hair` | 顶部高光内阴影 |
| `--hdr-bg` | —（原型用 `.rail` 实底） | 顶栏/侧栏半透明底 |
| `--radius` / `--radius-sm` / `--r-xs…--r-lg` | `--r-xs…--r-lg` | 圆角 |
| `--ease` | `--ease` | 统一缓动 `cubic-bezier(.32,.72,0,1)` |
| `--mono` | `--f-mono` | 等宽（**实际落到 MiSans**，见 §2.2 已知限制） |
| `--shadow` / `-md` / `-lg` | `--sh-1` / `--sh-2` / `--sh-3` | 阴影三级（暖色阴影，带棕调） |

### 11.3 改配色时的硬约束

1. **两套主题都要给值**。`--radius` / `--ease` / `--mono` 只在 `:root, html[data-theme=light]` 定义一次（暗色继承），其余颜色变量**两个块里都有**，加新变量时别只加一边。
2. **排除冷色**。色相留在红/橙/琥珀/棕；`--green` 是唯一允许的绿，且只用于语义"成功/跌"。不要再引入青、蓝绿、紫青。
3. **面层级方向会反转**：亮色下 `--card3` 比 `--card` **暗**，暗色下比 `--card` **亮**（都是"更靠近用户"）。抄新组件时别把方向写死。
4. **改完必须同时改原型**，否则下次回填互相覆盖（见 §维护约定第 5 条）。
