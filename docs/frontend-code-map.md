# 前端代码地图

> 面向「接手改前端」的 Agent / 开发者的快速定位文档。
> 配套的深入说明见 [frontend-console-detailed.md](./frontend-console-detailed.md)。
>
> **一句话定位**：`console-redesign.html` 是**视觉唯一真源**（高保真静态原型，单文件零依赖，数据来自文件内 `DATA` 快照，不请求任何后端）；
> 生产控制台 `console.html` 是**构建产物**，由它的 `<style>` 原文 + `build/` 下的适配层拼成，真实请求 `/admin/api/*`。

---

## ⚠️ 维护约定（强制）

**本文档与前端源文件必须同进同出。** 任何人（含其他 Agent）改动前端后，必须在同一次改动里：

1. **重新 `node build/build.js`** —— 改了 `console-redesign.html` 或 `build/*` 而不构建，等于没改（`console.html` 是覆盖式的）。
2. **重新核对 §1 / §0.2 的行号锚点表** —— 增删任何一行都会让后面所有行号失效。核对命令见仓库根目录 [`AGENTS.md`](../AGENTS.md) §1.2。
3. **更新 §2 / §3 / §0.2 的索引** —— 新增或删除函数、CSS 区块、协议、导入类型时，对应表格必须同步。
4. **更新 §5 修改路由表** —— 新增了可配置项就补一行，否则后来者找不到入口。
5. **补 §7 坑位** —— 踩到新的层叠上下文 / 布局 / 交互陷阱，写进来，别让它再被踩第二次。

完整规则见 [`AGENTS.md`](../AGENTS.md)。**文档与代码不一致，视为改动未完成。**

---

## 0. 文件清单与职责

| 文件 | 行数 | 职责 | 本文件涉及 |
| --- | --- | --- | --- |
| `console-redesign.html` | ~2272 | **视觉唯一真源**：新版控制台原型（单文件 = HTML + CSS + JS + 内联 SVG），含演示用 `DATA` 快照 | ✅ §1 / §2 / §3 |
| `build/head.html` | 21 | 生产 `<head>`：主题初值、MiSans CDN、到 `<style>` 为止 | ✅ §0.2 |
| `build/shell.html` | 52 | 生产 body 骨架：背景层 / rail / topbar / viewport / drawer / mask / toasts | ✅ §0.2 |
| `build/extra.css` | 8 | 设计稿快照里没有的生产独有组件（codex chip、抽屉密钥行等宽字） | ✅ §0.2 |
| `build/app.js` | ~1917 | **生产逻辑主体**：数据层 + 动作层 + 6 个页面渲染 + 首启密钥登录门，真实请求 `/admin/api/*` | ✅ §0.2 |
| `build/build.js` | 52 | 组装脚本 + 构建期自检（`</style>` 唯一性 + head/shell 行数守卫） | ✅ §0.2 |
| `console.html` | ~2538 | **构建产物**（提交进仓库，`server.js` 直接读）。**不要手改** | 参考 |
| `server.js` | ~3762 | 后端网关，提供 `/admin/api/status`、`/admin/api/channel`、`/admin/api/probe`、`/admin/api/test`、`/admin/api/codex-import`、`/admin/api/genspark-import` 等；含首启密钥生成与双层鉴权 | 参考 |
| `README.md` | — | 后端协议、渠道配置、端点总表、调度顺序 | 参考 |

**关键结论**：改 `console-redesign.html` 的 JS 部分时**不要**去找它的接口调用——它没有。所有"数据"都是文件内常量。
生产侧的真实逻辑全部在 `build/app.js`。

---

## 0.1 构建管线：`console.html` 是怎么来的

```
node build/build.js
```

```
console-redesign.html ──(切出 <style>…</style> 之间的原文，逐字节复制)──┐
                                                                       │
build/head.html  ─────────────────────────────────────────────────────┤──→ console.html
build/extra.css  ─────────────────────────────────────────────────────┤      (拼接后写入仓库根)
build/shell.html ─────────────────────────────────────────────────────┤
build/app.js     ─────────────────────────────────────────────────────┘
```

构建脚本做的事（`build/build.js`，52 行）：

1. 从 `console-redesign.html` 切出 `<style>` 内容 —— **不重写、不改写**，视觉因此与设计稿逐字节一致
2. 按 `head → banner → 设计CSS → extra.css → </style></head><body> → shell → <script> → app.js → </script></body></html>` 拼接
3. **自检**：产物里 `</style>` 必须恰好出现 1 次，否则抛错
4. **行数守卫**：head.html=21 行 / shell.html=52 行，变了就在构建期爆错（行号换算偏移的恒定前提）

### ⚠️ 为什么必须有这条自检

HTML 解析 `<style>` 是**裸文本模式**：只要遇到 `</style>` 字面量就立刻闭合元素，**即使在 CSS 注释里也一样**。
所以任何写进 CSS 的注释都不能出现这个字面量，否则它后面的整段 CSS 会变成页面正文文本。
（本轮踩过：构建脚本的 banner 注释里写了结束标签，导致生产页 CSS 大面积失效。）

### 行号换算（构建是纯拼接，偏移恒定）

| 目标 | 公式 | 校验点 |
| --- | --- | --- |
| `console.html` 的 CSS 行号 | `console-redesign.html` 行号 **+13** | tokens 区块：原型 11 → 产物 24 |
| `console.html` 的 JS 行号 | `build/app.js` 行号 **+617** | `const IC`：app.js 3 → 产物 620；`tick()`：app.js 1887 → 产物 2504 |

> 偏移受 `build/head.html`（21 行）/ `build/shell.html`（52 行）/ `build/extra.css`（8 行）增删行影响（head/shell 已有构建期行数守卫，extra.css 改动需人工重算并同步本文档与 AGENTS.md §1.2）。

### 三条硬规则

1. **视觉只在设计稿改**。`console.html` 里的 CSS 是复制品，手改必被下次构建覆盖。
2. **生产独有能力不要往回删**：genspark 双导入、渠道级自定义请求头、密钥掩码↔明文切换、`有效优先级` 角标、真实测试/导入/Playground 请求——原型里没有，**原型不必追平**。
3. **变量名两边完全一致**（生产直接复用设计稿 CSS），不存在映射表。旧文档里 `--indigo` / `--red` 那套映射已作废。

---

## 0.2 生产侧（`build/`）索引

### 结构分段（`build/shell.html` 52 行 · `build/head.html` 21 行）

| 文件 | 行号 | 内容 |
| --- | --- | --- |
| `build/head.html` | 1–11 | `data-theme="light"` 初值、MiSans CDN（`font.sec.miui.com`） |
| `build/head.html` | 12–20 | 构建管线说明注释 |
| `build/shell.html` | 1–4 | `.bg-layer` ×3 背景氛围 |
| `build/shell.html` | 6–24 | `.app > .rail`（brand / railNav / rail-foot） |
| `build/shell.html` | 27–41 | `.main > .topbar` + `.viewport#viewport` |
| `build/shell.html` | 44–52 | `#scrim` + `#drawer` + `#mask` + `#toasts` |

> 生产只有 **1 个 `.mask`**（`#mask`，内容由 `modal()` 注入）+ 1 个抽屉（`#drawer`）。
> 早期版本的 `#codex-mask` / `#gs-mask` / `#test-mask` / `#dmask` 已随重构删除。

### `build/app.js` 函数索引

数据层：

| 行号 | 名称 | 说明 |
| --- | --- | --- |
| 3 | `IC` | 内联 SVG path 字典 |
| 57 | `adapt()` | **适配层**：把 `/admin/api/status` 的真实响应转成渲染层期望的 `DATA` 结构 |
| 118 | `loadAll()` | 并发拉取 status / usage / config，写 `RAW` → `adapt()` |
| 135 / 155 | `render()` / `reload()` | 重绘当前页（**保留滚动位置 + 焦点/光标**；筛选状态由各页 JS 变量回填，见下方「状态回填」约定）/ 重新拉数并重绘 |
| 158 | `recheckAll(btn)` | 全量重探测（带按钮 loading） |
| 188 | `api(path,opts)` | **统一请求封装**：自动带 `Authorization: Bearer <ADMIN_KEY>`、错误 toast；**401 → 清掉已存密钥并弹回登录门**（密钥被轮换时自动重新要 key） |
| 200–232 | `downloadCsv` `toast` `copyText` | 导出 / 提示 / **复制（含 `execCommand` 兜底）** |
| 298 | `NAV` | 侧栏导航定义 |
| 310 / 318 | `renderRail()` / `go(p)` | 侧栏重绘 / **唯一路由**（切页后 `viewport.scrollTop=0`） |
| 331 | `kpiCard(o)` | KPI 卡（值 / 脚注 / 独立曲线带） |
| 351–385 | `winStats` `avgLatency` `avgLatencyDelta` `OV_RANGE` | 窗口统计 / 平均延迟 / **延迟环比**（样本 <40 返回 null）/ **时间范围配置** |
| 388–396 | `ovSeries()` / `chSpark(id)` | 按当前范围取序列 / 单渠道曲线 |
| 407–433 | `exportUsage` `exportLogs` `exportModels` `copyModels` | 导出与复制 |
| 442 | `vOverview(v)` | 总览页（含 `24h/7d/30d` 真实切换） |
| 560–644 | `vChannels` `drawChTable` `toggleCh` `openChannel` | 渠道页 / 排序渲染 / 启停 / 详情抽屉 |
| 701–722 | `toggleDrawerKey` `reprobe` `delChannel` | 抽屉密钥切换 / 重探测 / 删除 |
| 737–851 | `mTab` `mQ` `vModels` `drawMTable` `openModel` | 模型页（启用优先排序）/ 调度顺序抽屉。**筛选状态存 JS**（`mTab`/`mQ`，见 v1.0.1） |
| 852–971 | `vLogs` `logRows` `drawLogTable` `clearUsage` `openLog` `copyCurl` | 日志页 / 用量清零 / 详情 / 复制 curl（筛选状态 `lgRange`/`lgCh`/`lgOk`/`lgQ`，重绘后命令式回填） |
| 972–1195 | `pgDraft` 等 `vPlayground` `drawPG` `drawRoute` `fmtUsage` `pgClear` `pgCopyCurl` `pgSend` | Playground：**真实 `POST /v1/chat/completions`**（流式 + 路由信息）。**草稿与参数存 JS**（`pgDraft`/`pgSysText`/`pgModelSel`/`pgTempV`/`pgMaxV`/`pgStreamOn`） |
| 1196–1323 | `vAccess` `showKeyHelp` | 接入信息（真实 gatewayKey / 端口 / 模型名）；端点地址与密钥均可复制；`showKeyHelp` 是**只读**步骤清单，每条命令各自可复制 |
| 1324–1336 | `modal` `closeModal` `setStatus` `toggleMenu` | 弹窗容器 / 关闭 / 行内状态 / 下拉菜单 |
| 1337–1356 | `PROTO_META` `PROTO_ORDER` `chKey(id)` | 协议元数据 / 顺序 / **真实密钥取值**（原型是 `fakeKey`） |
| 1357–1596 | `openChannelForm` … `saveChannel` | 渠道表单：模型别名行、上游探测列表（搜索/全选/批量）、密钥掩码切换、保存 |
| 1597–1734 | `IMPORT_META` `parseCodexUnits` `parseGsSessionId` `openImport` `importCodexRt` `importGsSession` `doImport` `importFiles` | 导入：**真实对接** `codex-import` / `genspark-import` |
| 1735–1817 | `openTestModels` `runTests` | 测试模型：**真实调用 `/admin/api/test`** |
| 1818–1844 | `drawer` `closeDrawer` `setTheme` | 抽屉 / 主题持久化 / 明暗互切 |
| 1845–1885 | `showKeyGate()` `keyFlow()` | **首启密钥登录门**：密钥三源合流（`?key=` → localStorage → sessionStorage，URL 参数用完即从地址栏抹掉）；无密钥时全屏输入门，校验 `/admin/api/status` 通过后写 localStorage+sessionStorage 并 `boot()` |
| 1887 | `tick()` | 时钟 |
| 1897–1917 | `boot()` | 首屏骨架 → `go('overview')` → 8 秒静默刷新（原 `init()`，改名为 `boot` 以配合登录门：有密钥直接启动，无密钥先弹门再启动）。**轮询护栏**：流式中（`pgBusy`）或用户正在视口内输入框编辑时跳过这一拍 |

> **状态回填约定（v1.0.1 起，全页统一）**：8 秒轮询会重绘当前页的整个 DOM，**任何输入控件的值都必须存在 JS 变量里并在模板中回填**，
> 且 `oninput` 要把值写回变量。否则重绘后输入框被重建为空 —— 表现就是「搜索/草稿一会儿自己没了」。
> 已有的正确样例：`chQ`/`chTab`（渠道页）、`lgQ` 等（日志页，命令式 `R.value=lgQ` 回填）、`ovRange`（总览页）、`probeQ`（弹窗）。
> 弹窗与抽屉（`#drawer`/`#mask`/`modal()` 挂 body）在 `#viewport` 之外，不受重绘影响，无需回填。

> ⚠️ 原型里的 `simTest` / `REPLIES` / `hash()` / `fakeKey()` **在生产侧已全部删除**，替换为真实请求。
> 如果你在生产代码里看到它们，说明构建源搞混了。

### `build/extra.css` 区块（8 行）

| 行号 | 区块 |
| --- | --- |
| 1–2 | 说明（复用设计令牌，不引入新颜色） |
| 5 | `.chip.codex` 协议 chip（设计稿快照无 codex 渠道） |
| 8 | `.kv dd.mono` 抽屉密钥行等宽字 |

> PT03 整改：`.sortable` / `.mini-kv` / `.img-out` / `.art` / `.loading` 五组原型遗留死样式已删（全源零引用）。 |


## 1. 单文件三段结构（行号锚点 · `console-redesign.html`）

> 本节及 §2 / §3 的锚点**只对应 `console-redesign.html`**（~2272 行）。生产侧锚点见 §0.2。

文件固定由三段组成，改任何东西先按这张表定位：

| 段 | 行号范围 | 内容 |
| --- | --- | --- |
| `<head>` | 1–9 | `lang="zh-CN"`、`data-theme="dark"` 初始主题、**MiSans 字体 CDN**（`font.sec.miui.com`，按 unicode-range 分片） |
| `<style>` | 10–537 | 全部 CSS（无外链样式表）。**这段原文会被逐字节复制进 `console.html`** |
| `<body>` | 539–858 | 静态占位 markup（背景层 / 原型横幅 / rail / topbar / 占位页 / 抽屉 / 弹窗容器 / toast 容器） |
| `<script>` | 859–2270 | 全部 JS（图标 → 数据 → 工具 → 图表 → 导航 → 6 个页面 → 弹窗 → 抽屉/主题/init）。**原型专用，不参与构建** |

> ⚠️ `<body>` 里 583–783 行是**渠道页的静态占位 markup**（`<div class="viewport" id="viewport">` 到 `</tbody></table>`）。`init()` 末尾会 `go('overview')`，
> 首屏立刻用 JS 重绘整个 `#viewport`，所以那段占位只在 JS 失效时可见。
> **改动 UI 时不要只改占位 markup**，否则会出现"静态和实际渲染不一致"的问题（本轮已踩过，见 §7）。
>
> 另：静态占位表与 `DATA` 里的渠道是**演示数据**（`demo-openai-a` 这类中性 id），
> 用来演示各协议的渲染效果，与任何真实部署的渠道无关；公开仓库版本已把真实渠道身份全部替换掉（见 `frontend-console-detailed.md` §8.12）。

---

## 2. CSS 索引（行号 → 区块）

| 行号 | 区块 | 说明 |
| --- | --- | --- |
| 11–21 | `tokens` `:root` | 侧栏宽度、圆角、三套字体栈、缓动 `--ease` |
| 22–41 | `html[data-theme="dark"]` | **暖色暗色主题变量**（改配色只动这里） |
| 42–61 | `html[data-theme="light"]` | **暖色亮色主题变量** |
| 62–83 | `base` | `body` flex 外壳、`::selection`、`.mono` `.serif` `.micro` `.num` 工具类 |
| 85–102 | `atmosphere` | `.bg-layer` `.bg-grid` `.bg-glow` `.bg-noise` 背景氛围层 |
| 104–114 | `shell` | `.proto` 原型横幅、`.app` 应用外壳 |
| 116–144 | `rail` | 左侧导航：`.brand` `.rail-nav` `.rail-sec` `.rail-item`（`.on` 高亮 + 左侧竖条）`.rail-foot` |
| 146–171 | `main` | `.main` `.topbar`（sticky）`.crumb` `.search` `.kbd` `.icon-btn` `.viewport`（滚动容器） |
| 173–178 | `page head` | `.page-hd`（**含 z-index:5 的关键修复**）`.page-title` `.page-sub` `.page-actions` |
| 180–195 | `controls` | `.btn` 及 `.primary/.ghost/.danger/.sm` |
| 197–202 | | `.tabs` `.tab`（`.on` 态） |
| 204–214 | | `.field` `.input` `.select` `textarea.input` |
| 216–219 | | `.switch` 开关（纯 CSS，`::after` 是滑块） |
| 221–249 | `chips/pills` | `.chip` 及**协议着色** `.chip.openai/.anthropic/.gemini/.notion/.notion-agent/.workbuddy/.genspark`；`.pill` + `.dot`；`.tag`；`.delta`（**红涨绿跌**） |
| 251–271 | `cards` | `.card` `.card-hd` `.card-bd`、`.grid` + `.g4/.g3/.g12` + `.c4..c12` 栅格与两个断点 |
| 273–284 | | `.kpi` 系列（**曲线独占底部图表带** `.kpi-spark`） |
| 286–310 | `tables` | `table.tbl`（表头 sticky）、`.t-r/.t-c`、`.cell-main/.cell-name/.cell-sub`、`.avatar`、`.proto-bar` |
| 312–318 | | `.bars` 横向条形榜 |
| 320–323 | | `.legend` 环形图图例 |
| 325–331 | | `.code` 代码块（`.k/.s/.c` 语法着色） |
| 333–337 | | `.ep` 接入信息端点卡 |
| 339–370 | | `.pg` Playground 两栏布局、`.chat` `.msg` `.composer` `.send` `.toolcall` |
| 372–377 | | `.param` `.range` 参数滑块 |
| 379–393 | `drawer` | `.scrim`（z-index 60）`.drawer`（61）`.drawer-hd/-bd/-ft`、`.kv` 键值表 |
| 395–420 | `modal` | `.mask`（80）`.modal`（`.wide`）`.m-hd/-bd/-ft`、`.field-row`、`.help`、`.toggle` |
| 422–432 | | 模型编辑器 `.models-box` `.model-row`（4 列网格：alias / upstream / 测试 / 删除） |
| 433–461 | | **上游探测列表** `.probe-panel`（`.pp-hd/.pp-search/.pp-list/.pp-row/.pp-ft`）`.status-line` |
| 463–476 | | 测试模型 `.test-list` `.test-out` |
| 478–486 | | 导入拖放区 `.drop` |
| 488–499 | `menu` | `.menu-wrap` `.menu`（**z-index 70**）`.menu .hd/.sep` |
| 501–508 | `toast` | `.toasts`（90）`.toast` |
| 510–523 | `misc` | `.empty` `.divider` `.row/.wrap/.ml-auto/.muted` `.sec-title` `.hide` 滚动条 `:focus-visible` |
| 525–536 | 动画 | `@keyframes fade/rise/sweep`、`.page` `.stagger`、`prefers-reduced-motion` 降级 |

### z-index 全景（改层级必看）

| 值 | 元素 |
| --- | --- |
| 0 | `.bg-layer` 背景层 |
| 1 | `.app` 应用外壳 |
| 2 | `.proto` 原型横幅 |
| 5 | **`.page-hd`（头部，让下拉菜单能盖住卡片）** |
| 1（局部） | `table.tbl thead th`（表头 sticky）、`.test-list .g`（分组 sticky） |
| 20 | `.topbar` |
| 60 / 61 | `.scrim` / `.drawer` |
| 70 | `.menu` 下拉菜单 |
| 80 | `.mask` 弹窗遮罩 |
| 90 | `.toasts` |

---

## 3. JS 索引（函数 / 常量 → 行号 → 职责）

> 行号均指 `console-redesign.html`（**原型**，含演示用假数据与假动作）。
> 生产侧的真实实现在 `build/app.js`，索引见 §0.2。

### 3.1 常量与数据层

| 行号 | 名称 | 说明 |
| --- | --- | --- |
| 861–892 | `IC` | 内联 SVG path 字典；`svg(name,size)` 包成 `<svg>`（893） |
| 896–933 | **`DATA`** | **唯一数据源**：`meta` / `trend` / `channels[9]` / `models[8]` / `logs[8]` / `donut`。**会被就地修改**（启停、删除、探测）。里面的渠道是**演示数据**，非真实部署渠道 |
| 1022–1032 | `NAV` | 侧栏导航定义（`sec` 分组 / `id` / `label` / `icon` / `cnt()`） |
| 1532 | `PG` | Playground 预置对话 |
| 1775–1784 | `PROTO_META` | 协议元数据：`label` / 默认 `base` / `key` 填写提示（添加渠道表单据此渲染） |
| 1785 | `PROTO_ORDER` | 协议下拉顺序（**新增协议要同时改 `PROTO_META` 和这里**） |
| 1786 | `MODEL_POOL` | 别名补齐池（保证表格/抽屉/编辑器三处模型数一致） |
| 1788–1796 | `PROBE_POOL` | 模拟"上游返回的一大批模型"，用于演示探测列表 + 搜索 |
| 2035–2052 | `IMPORT_META` | 四类导入的配置：`codex-rt` / `codex-json` / `gs-session` / `gs-json`（`mode: paste\|file`、`hint`、`steps`、`warn`、`bad` 校验） |
| 2155 | `REPLIES` | 测试模型的模拟回复池 |

### 3.2 全局可变状态

```js
page                    // 1033 当前页面 id
chTab, chQ              // 1178 渠道页签 / 搜索词
modalChId, modalModels  // 1819 渠道表单：编辑对象 id / 模型别名数组
probeFound, probeSel, probeQ  // 1910 探测结果 / 已勾选集合 / 搜索词
DATA.*                  // 就地修改：toggleCh / delChannel / reprobe
```

### 3.3 工具层（935–956）

| 行号 | 函数 | 说明 |
| --- | --- | --- |
| 936–942 | `$` `$$` `esc` `nf` `pct` `fTok` `fMs` | 选择器 / **HTML 转义** / 千分位 / 百分比 / Token 中文单位 / 毫秒格式化 |
| 943–944 | `stTxt` `protoLabel` | 状态、协议的中文映射表 |
| 946 | `toast(msg,kind)` | 右下浮动提示（`kind:'ok'` 加绿边） |
| 953 | `copyText(t,btn)` | 复制 + 按钮图标短暂变勾 |

> ⚠️ 所有插入 innerHTML 的动态文本都必须走 `esc()`，`DATA` 里有上游返回的模型名/渠道名。

### 3.4 图表层（958–1020，手写 SVG，无图表库）

| 行号 | 函数 | 说明 |
| --- | --- | --- |
| 959 | `areaChart(data,w,h,opts)` | 面积折线图：贝塞尔平滑 + 渐变填充 + 虚线网格 + 末点放大；`preserveAspectRatio="none"` 拉伸铺满 |
| 990 | `sparkline(vals,w,h,c,stretch)` | 迷你曲线；`stretch=true` 时带渐变面积，用于 KPI 卡底部独立图表带 |
| 1003 | `donut(parts,size,thick)` | 环形图（渠道健康分布） |

### 3.5 导航与路由（1021–1052）

| 行号 | 函数 | 说明 |
| --- | --- | --- |
| 1034 | `renderRail()` | 重绘侧栏（含高亮与计数） |
| 1042 | `go(p)` | **唯一路由**：改 `page` → 重绘 rail → 清空 `#viewport` → 调对应 `vXxx(v)` → `scrollTop=0` |

> 页面分发是一张对象表（1048）：`{overview:vOverview, channels:vChannels, models:vModels, logs:vLogs, playground:vPlayground, access:vAccess}`。
> **新增页面 = 加 `NAV` 项 + 写 `vXxx(v)` + 在 1048 注册**。

### 3.6 页面渲染层

| 页面 | 渲染函数 | 关键子函数 / 行号 |
| --- | --- | --- |
| 总览 | `vOverview` 1069 | `kpiCard` 1055、`areaChart`、`donut`；页签 `#rangeTabs` 仅切样式不切数据 |
| 渠道 | `vChannels` 1179 | **`drawChTable` 1219**（筛选/排序/渲染）、`toggleCh` 1254、**`openChannel` 1260**（详情抽屉）、`toggleDrawerKey` 1316、`reprobe` 1324、`delChannel` 1331 |
| 模型 | `vModels` 1340 | **`drawMTable` 1385**（含**启用优先排序** 1393）、`openModel` 1414（模型来源抽屉，按 config 渠道序非调度序） |
| 日志 | `vLogs` 1450 | `openLog` 1494（请求详情抽屉） |
| Playground | `vPlayground` 1539 | `drawPG` 1607、`pgSend` 1623（模拟流式输出） |
| 接入 | `vAccess` 1680 | 三协议端点卡 + 代码片段页签（1750） |

### 3.7 弹窗层

| 行号 | 函数 | 说明 |
| --- | --- | --- |
| 1761 | `modal(html,wide)` | 通用容器：写入 `#modalBox` 并给 `#mask` 加 `.on` |
| 1768 | `closeModal()` | 移除 `.on`（**只有 ×、取消、Esc 三条关闭路径**） |
| 1769 | `setStatus(el,text,cls)` | 行内状态文字（`ok`/`bad`/`wait`） |
| 1771 | `toggleMenu(id)` | 下拉菜单开关；1772 全局点击外部关闭 |
| 1799–1817 | `fakeKey` `maskKey` `chBaseUrl` `chAliases` | 原型派生数据（假密钥、默认 BaseURL、别名补齐） |
| **1820** | **`openChannelForm(id)`** | 添加/编辑渠道弹窗（无 id = 新增）。内含表单骨架 1826–1875 |
| 1886 | `renderModelRows()` | 渲染模型别名编辑器行 |
| 1903 / 1909 | `addModelRow()` / `delModelRow(i)` | 增删别名行 |
| 1912 | `probeUpstream()` | 模拟探测上游 `/v1/models` → 填充 `probeFound` |
| 1928 | `renderProbeList()` | 渲染**列表式 + 可搜索 + 多选**的探测结果面板 |
| 1952 / 1958 / 1964 | 行内绑定 / `filterProbeRows()` / `updateProbeSel()` | 搜索过滤、勾选计数 |
| 1970 / 1979 / 1984 | `probeSelectAll()` / `probeClearSel()` / `probeAddSelected()` | 全选 / 清空 / 批量加入别名表 |
| 1993 | `testRowModel(i)` | 单行模型测试（编辑器内） |
| 2000 | `toggleKeyField()` | 密钥掩码/明文切换 |
| 2006 | `saveChannel()` | 收集表单 → 校验 → 写回 `DATA.channels` |
| 2053 / 2061 | `parseCodexUnits(j)` / `parseGsSessionId(raw)` | **兼容多结构的 JSON 解析**（codex 三种结构；genspark 正则提 sessionId） |
| 2068 | `openImport(kind)` | 导入弹窗（粘贴 / 拖放两种形态） |
| 2101 | `doImport(kind)` | 粘贴式导入：分步状态动画 → 成功提示 |
| 2118 | `importFiles(kind,input)` | 文件式导入：多选、逐个解析、逐行结果 |
| 2156 | `simTest(chanId)` | 模拟一次模型测试（按渠道状态/失败率造成功或失败） |
| 2169 | `openTestModels(opts)` | 测试模型弹窗（可按 `channelId` 预筛） |
| 2215 | `runTests()` | 逐条执行 + 进度行 + 汇总 |

### 3.8 抽屉 / 主题 / 全局（2242–2270）

| 行号 | 函数 | 说明 |
| --- | --- | --- |
| 2242 / 2246 | `drawer(html)` / `closeDrawer()` | 右侧抽屉（渠道详情、模型详情、日志详情共用） |
| 2247 | keydown 监听 | `Esc` 关弹窗（优先）或抽屉；`Cmd/Ctrl+K` 聚焦全局搜索 |
| 2254 | `setTheme(t)` | 切 `data-theme` + 写 `localStorage['zzcs-theme']` + 换图标 |
| 2260 | `#themeBtn.onclick` | 明暗互切 |
| 2261 | `#globalSearch` Enter | 回车把关键词塞进 `chQ` 并跳渠道页 |
| 2264 | `init()` | 读主题 → `setTheme` → `go('overview')` |

---

## 4. 数据契约

```js
// DATA.channels[i]
{ id, name, proto, on, status, ms, models, pri, req, err }
//   proto : 'openai'|'anthropic'|'gemini'|'notion'|'notion-agent'|'workbuddy'|'genspark'|'codex'
//   on    : bool 启用
//   status: 'ok'|'degraded'|'down'|'unknown'
//   ms    : -1 表示未探到延迟（fMs 显示 '—'）
//   models: 别名**个数**（不是数组）

// DATA.models[i]
{ name, chans:[channelId...], req, err }

// DATA.logs[i]
{ t, m, c, p, ok, ms, i, o, id }   // 时间/模型/渠道/协议/成功/耗时/入token/出token/请求ID

// DATA.trend[i] = ['MM-DD', 请求数]
// DATA.donut[i] = { k:'正常'|'降级'|'不可用', v, c:'var(--ok)'|... }
// DATA.meta = { total, errors, inTok, outTok, channels, enabled, models }
```

渠道详情/表单用到的**派生字段**（都不是 `DATA` 里的原始字段）：

- `chBaseUrl(c)` 1976 —— `PROTO_META[c.proto].base`，空则造 `https://<id>.example.com/v1`
- `chAliases(c)` 1978 —— 先用 `DATA.models` 里真实归属该渠道的模型，不足 `c.models` 个用 `MODEL_POOL` 补齐
- `fakeKey(c.id)` 1970 —— 由 id 派生的稳定假密钥（原型专用，**真实环境必须换成后端返回**）

---

## 5. 修改路由表（"想改 X → 去 Y"）

> 前四行是**视觉**，只改设计稿的 `<style>`，改完 `node build/build.js` 即对生产生效。

| 想改什么 | 去哪里 |
| --- | --- |
| 明暗两套配色 / 强调色 | CSS 22–41（暗）、42–61（亮）的变量 |
| 涨跌颜色规则 | 246–249 `.delta.up/.down` |
| 全站字体 | 6–9 字体 CDN；15–18 字体栈变量 |
| 侧栏宽度 / 圆角 | 13–14 `:root` |
| 头部下拉被遮挡 | 174–175 `.page-hd` 的 `position/z-index` |
| 页面底部空白 / 侧栏高度 | 65–73 `body`、114 `.app`、147 `.main`、171 `.viewport` |
| 弹窗宽度 | 402–408 `.modal` / `.modal.wide` |
| 弹窗遮罩点击行为 | 997–1000 `#mask` markup（**当前刻意不绑 onclick**）；生产同规则，见 `build/shell.html` 48 |
| 新增协议（原型） | `PROTO_META` 1946 + `PROTO_ORDER` 1956 + `.chip.<proto>` 配色 226–233 |
| 新增协议（生产） | `build/app.js` 的 `PROTO_META` 1329 / `PROTO_ORDER` 1339 + `build/extra.css` 补 chip 色 + `server.js` 协议分支，然后重新构建 |
| 新增页面（原型） | `NAV` 1193 + `vXxx()` + 分发表 1219 |
| 新增页面（生产） | `build/app.js` 的 `NAV` 298 + `vXxx()` + `go()` 318 的分发表，然后重新构建 |
| 新增导入类型 | `IMPORT_META` 2206（原型）/ 1589（生产）+ 工具栏菜单 1358–1366（和占位 markup 590–598 同步） |
| 渠道列表排序 | 1396（渠道页）/ 1564（模型页）；生产 606 / 791 |
| 探测列表交互 | `renderProbeList` 2099 起整段（原型）/ 1467（生产） |
| 图标 | `IC` 1005–1036（原型）/ 3（生产），用 `svg('name',size)` 引用 |
| 主题持久化 key | 2427 / 2436（`zzcs-theme`）；生产 `setTheme` 1822 |
| 生产独有组件样式 | `build/extra.css`（**不要写进设计稿**，设计稿没有这些组件） |
| 构建逻辑 / 产物结构 | `build/build.js` |
| 总览时间范围（24h/7d/30d） | 生产 `OV_RANGE` 385 + `ovSeries` 388 + `vOverview` 442 |

---

## 6. 与真实后端的对接映射（原型 → 生产）

原型里所有"假动作"将来要替换成 `console.html` 同款请求。映射如下（接口名以 `server.js` 为准）：

| 原型函数 | 应替换为 |
| --- | --- |
| `DATA` 常量 | `GET /admin/api/status` |
| `toggleCh` / `saveChannel` / `delChannel` | `POST /admin/api/channel`（局部改）/ `POST /admin/api/channels`（upsert）/ `DELETE /admin/api/channels` |
| `reprobe` / 全量重探测 | `POST /admin/api/recheck`（body 可带 `{id}`） |
| `probeUpstream` | `POST /admin/api/probe`（注意协议白名单） |
| `simTest` / `runTests` | `POST /admin/api/test` |
| `doImport` / `importFiles`（codex） | `POST /admin/api/codex-import` |
| `doImport` / `importFiles`（genspark） | `POST /admin/api/genspark-import`（`mode:'add'` 一会话一渠道） |
| 用量明细 / 清零 | `GET /admin/api/usage` · `POST /admin/api/usage/clear` |
| Playground `pgSend` | `POST /v1/chat/completions`（stream） |
| Playground 生图 | `POST /v1/images/generations` |

> 鉴权：`ADMIN_KEY` 走 `Authorization: Bearer`；旧版用 `?key=` 存 sessionStorage。真实接入时**不要**沿用 `fakeKey()`。
> **回填状态（v0.4）**：上表在 `build/app.js` 中**已全部落地**（Playground / 测试模型 / 四类导入 / 接入信息都发真实请求），
> 原型里的假动作（`fakeKey` / `simTest` / `REPLIES` / `hash` / 假流式）**只剩演示用途**，不再有对应生产代码。

---

## 7. 坑位清单（改代码前必读）

1. **层叠上下文陷阱**：`.page` / `.stagger` 的 `fade` 动画会生成层叠上下文。任何"下拉菜单被卡片盖住"的问题，先看容器有没有 `position` + `z-index`。当前靠 `.page-hd{z-index:5}` 解决。
2. **字体只有 MiSans**：MiSans **没有等宽变体**，数字是比例宽度。`--f-mono` 只是同一字体，代码块/数值列**无法严格对齐**（已加 `font-variant-numeric:tabular-nums` 缓解）。层级靠**字重**区分（700/600/500），不要靠字体族。
3. **红涨绿跌**：`.delta.up` 用 `var(--err)`、`.delta.down` 用 `var(--ok)`——这是**故意反直觉**的，改配色时别"顺手修回来"。
4. **涨跌不要再加箭头**：方向已由 `+/-` 和颜色表达，箭头是三重冗余（KPI 卡 1233 行有注释）。
5. **弹窗遮罩不响应点击**：拖选复制时鼠标滑出弹窗会误关，所以 `#mask` 不绑 `onclick`，只留 × / 取消 / Esc。
6. **占位 markup 与实时渲染双份**：渠道页头部工具栏（590–598）和渠道表格在 body 里有一份静态版本。改 UI 必须**两处同步**，否则首屏闪烁或 JS 失效时看到旧 UI。
7. **`.viewport` 是滚动容器**：`body` 不滚动。用 `scrollIntoView` 无效，切页要 `viewport.scrollTop=0`（1218–1222 有注释）。
8. **`DATA` 会被就地修改**：`toggleCh` / `delChannel` / `reprobe` 直接改常量。刷新页面即复位；不要写依赖"数据不可变"的逻辑。
9. **排序必须用副本**：`drawChTable` / `drawMTable` 都是 `[...rows].sort(...)`，直接 `rows.sort` 会污染 `DATA` 顺序。
10. **导入解析要容错**：`parseCodexUnits` 兼容扁平 / `credentials` / `accounts[]` 三种结构；`parseGsSessionId` 用正则从任意文本里捞 `uuid:hex`。改这里务必保留容错。
11. **`</style>` 是 CSS 里的禁忌字面量**：HTML 解析 `<style>` 是裸文本模式，注释里出现结束标签也会**立刻闭合元素**，后面整段 CSS 会变成页面正文。写构建 banner / CSS 注释时绝不能出现它（`build/build.js` 有自检兜底，但别指望它替你找语义错误）。
12. **`console.html` 是产物，不是源文件**：直接手改会在下次 `node build/build.js` 时被静默覆盖。改视觉去 `console-redesign.html` 的 `<style>`，改生产逻辑去 `build/app.js`，改完必须重新构建。
13. **改完 `console-redesign.html` 的行号会漂移**：`console.html` 的行号 = 原型行号 +13（CSS）/ `build/app.js` 行号 +617（JS）。增删 `build/head.html` / `build/shell.html` / `build/extra.css` 的行会让 JS 偏移改变（head/shell 已有构建期行数守卫）。
14. **表格表头右对齐要压权重**：`table.tbl thead th{text-align:left}` 权重是 (0,1,3)，高于 `.t-r` 的 (0,1,0)，所以 `th` 上的 `.t-r` **默认不生效**，会出现"表头左对齐、数值右对齐"的错位。必须用 `table.tbl thead th.t-r` 这种更高权重的选择器（原型 300 行与 `.t-r` 并排写在同一行，就是为了不增行数、避免锚点整体漂移）。新增右对齐列时务必肉眼确认表头也对齐了。
15. **剪贴板只在安全上下文可用**：`navigator.clipboard` 在 `http://` + 局域网 IP 下是 `undefined`，而可选链 `?.` 会把整条链**静默短路**——既不复制也不报错，看起来就是"按钮点了没反应"。`copyText` 因此用 `document.execCommand('copy')` 兜底，别删。
16. **往 HTML 属性里塞字符串一律走 `data-t`**：`onclick="copyText(${JSON.stringify(x)},this)"` 会把双引号塞进双引号属性里，属性被截断、按钮彻底失效（接入信息页曾因此复制不了密钥）。统一写 `data-t="${esc(x)}" onclick="copyText(this.dataset.t,this)"`。

---

## 8. 快速自测清单（改完跑一遍）

**构建与产物**

- [ ] `node test/console-state.test.js` 全绿（视口内输入控件状态回填的自动化回归，27 项断言；改了任何带输入框的页面都要跑）
- [ ] `node build/build.js` 成功，无「`</style>` 出现 N 次」报错
- [ ] `git diff console.html` 只包含本次预期改动（若为空说明忘了构建）
- [ ] 产物里 `</style>` 恰好 1 次：`(Select-String -Path console.html -Pattern '</style>' -SimpleMatch).Count`
- [ ] `git status` 里 `console.html` 与源文件**在同一次提交**中

**原型 + 生产都要看**

- [ ] 明暗切换正常，两套主题都是暖色系（无冷色绿）
- [ ] 总览 KPI 涨跌为**红涨绿跌**，且无箭头
- [ ] 总览时间范围 `24 小时 / 7 天 / 30 天` 切换后**图表与 KPI 环比真的变**（不是只切样式）
- [ ] 渠道页"导入"下拉能完整展开、不被下方卡片遮挡
- [ ] 渠道表格行：测试 / 编辑 / 详情三个按钮可用；点行打开详情抽屉
- [ ] 抽屉内密钥可掩码↔明文切换、可复制（生产显示的是**真实密钥**，不是假串）
- [ ] 添加/编辑渠道弹窗：协议切换后 Base URL 提示随之变化；探测结果可搜索、可全选、可批量加入
- [ ] 导入四类（Codex RT / Codex JSON / Genspark 会话 / Genspark JSON）都能打开，JSON 类支持多选
- [ ] 测试模型弹窗：勾选后逐条出结果与汇总（结果来自 `/admin/api/test` 真实请求）
- [ ] Playground 发一条消息，能收到真实流式回复 + 路由信息（渠道 / 首块延迟 / 总耗时）
- [ ] 接入信息页展示的网关地址、密钥、模型名来自 `/admin/api/config`，非硬编码
- [ ] 弹窗点遮罩**不关闭**；× / 取消 / Esc 可关闭
- [ ] **输入状态跨重绘**（v1.0.1 起必查）：在模型页搜索框输入文字、在 Playground 敲草稿，**静等 10 秒以上**——
      文字必须还在、页签/参数不跳回默认；旁边的数据仍在刷新（说明不是靠停掉轮询糊过去的）
- [ ] 轮询重绘后滚动位置与输入光标位置不跳（`render()` 的保位逻辑）
- [ ] 页面底部无异常空白，侧栏高度贴合视口
- [ ] 窗口缩到 <1320px / <900px 布局不破
