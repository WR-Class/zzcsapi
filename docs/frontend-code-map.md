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
| `build/extra.css` | 77 | 设计稿快照里没有的生产独有组件（codex chip、抽屉密钥行等宽字、**自动权重观测卡 `.aw-*`**、**运行期设置页 `.set-*`**） | ✅ §0.2 |
| `build/app.js` | 2512 | **生产逻辑主体**：数据层 + 动作层 + 8 个页面渲染 + 事件委托块（`ACTS`，v1.18.7 内联事件属性清零）+ 管理密钥登录门（会话化，v1.18.6），真实请求 `/admin/api/*` | ✅ §0.2 |
| `build/build.js` | 52 | 组装脚本 + 构建期自检（`</style>` 唯一性 + head/shell 行数守卫） | ✅ §0.2 |
| `console.html` | ~3202 | **构建产物**（提交进仓库，`server.js` 直接读）。**不要手改** | 参考 |
| `server.js` | ~6346 | 后端网关，提供 `/admin/api/status`、`/admin/api/channel`、`/admin/api/probe`、`/admin/api/test`、`/admin/api/codex-import`、`/admin/api/genspark-import`、`/admin/api/session`（登录 / 退出，v1.18.6）、`/admin/api/settings`（四组，v1.18.8）等；含首启密钥生成、会话表与双层鉴权、thinking 回放块（v1.18.8） | 参考 |
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
| `console.html` 的 CSS 行号 | `console-redesign.html` 行号 **+13** | tokens 区块：原型 11 → 产物 24；`--tx:#1b1710`：原型 46 → 产物 59 |
| `console.html` 的 JS 行号 | `build/app.js` 行号 **+689** | `const IC`：app.js 3 → 产物 692；`autoWeightCard()`：app.js 657 → 产物 1346；`tick()`：app.js 2482 → 产物 3171（偏移仍为 **+689**，与下面 §0.2 的源行号一一对应） |

> 偏移受 `build/head.html`（21 行）/ `build/shell.html`（52 行）/ `build/extra.css`（80 行）/ 设计稿 `<style>` 的行数增删影响（head/shell 已有构建期行数守卫；extra.css 与设计稿 CSS 改行数需人工重算并同步本文档、AGENTS.md §1.2 与 `build/build.js` 注释）。
> **历史教训（v1.8 重核）**：这条公式曾长期停在 **+617**（`build/build.js` 注释里又写着 +648），而实测是 **+673** —— 三个地方对不上，且漂移量在各函数间不等（+1 ~ +26），说明是历次改动累积的局部插入。
> **v1.8.1（图例对齐修复）**：`build/extra.css` 的 `.aw-*` 注释块 +4 行 → 偏移 **+673 → +677**，CSS 偏移仍 +13。
> **v1.9（自动权重独立成页 + 份额列对齐）**：`.aw-*` 由「堆叠带 + `auto-fit` 图例」重写成「一候选一列（`.aw-split`/`.aw-col`/`.aw-seg`）」，`build/extra.css` 68 → **58 行** → 偏移 **+677 → +667**（CSS 偏移仍 +13）。注意本轮是**双向变化**：`extra.css` 减 10 行（偏移 −10）+ `app.js` 在 `vAutoWeight()` 处净增行（app.js 行号 +）——所以产物行号在插入点**前后表现不同**：`autoWeightCard()` 之前的函数产物行号整体 −10（如 `const IC` 680 → 670），之后的函数因两个方向抵消而基本不动（`autoWeightCard()` 恰好 1301 → 1301）。
> **v1.9.1（份额列只留显示名）**：列标签不再拼 id 小片，`.aw-nm .id` 这条样式随即失去唯一引用 → 删除，`build/extra.css` 58 → **57 行** → 偏移 **+667 → +666**（CSS 偏移仍 +13）。
> **v1.18（运行期设置页）**：`build/extra.css` 57 → **77 行**（新增 `.set-*` 20 行）→ JS 偏移 **+666 → +686**（CSS 偏移仍 +13）；同时 `build/app.js` 在 `autoWeightCard()` 与 `drawChTable()` 之间插入运行期设置整段（725–877）。**v1.18.1**（空数据保护 + `api()` 错误体）又在插入点**之前**加了 16 行，所以 §0.2 的 app.js 锚点漂移**分段不同**：插入点之前 **+20**（v1.13–v1.17 的局部插入 + v1.18.1 的 16 行，此前一直没回写文档），插入点之后 **+180**。本轮已按 AGENTS §1.2 的命令整表重核。
> **v1.18.8（thinking 回放第四张卡 + 两排布局）**：`build/extra.css` 77 → **80 行**（`.set-cards` 两列规则块 +3 行：注释 + 规则 + ≤900px 折一列）→ JS 偏移 **+686 → +689**（CSS 偏移仍 +13）。`app.js` 侧第四张卡净增 7 行（`SET_META`/`SET_FIELDS` 内各 +2、`setStat` +2、`vSettings` 副标题/卡容器就地改不增行）→ 其后锚点整体 +7，已整表重核。
> **教训**：extra.css 在拼接序里位于 app.js **之前**，所以它每增删 1 行，JS 偏移就整体 ±1，而 CSS 偏移不动 —— 改 extra.css 前先想清楚要不要多这一行。改完 `build/*` 一定要用 AGENTS.md §1.2 的命令重新导一遍，不要按估算改数字。

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
| 59 | `adapt()` | **适配层**：把 `/admin/api/status` 的真实响应转成渲染层期望的 `DATA` 结构（含渠道的 `weight`/`weightedHits`/`weightedShare` → `w`/`wHits`/`wShare`） |
| 139 | `loadAll()` | 并发拉取 status / usage / config / **settings** / **keys**，写 `RAW` → `adapt()`。**settings 与 keys（v1.18.5 密钥管理页数据）各自单独 `.catch(()=>null)` 兜底**：这两个端点挂了不能把整页拉取拖垮（其余照常刷新） |
| 161 / 181 | `render()` / `reload()` | 重绘当前页（**保留滚动位置 + 焦点/光标**；筛选状态由各页 JS 变量回填，见下方「状态回填」约定）/ 重新拉数并重绘 |
| 184 | `recheckAll(btn)` | 全量重探测（带按钮 loading） |
| 201–209 | `$` `$$` `esc` `nf` `pct` `fTok` `fMs` `stTxt` `protoLabel` | DOM/格式化小工具 |
| 215 | `api(path,opts)` | **统一请求封装**：错误 toast；**v1.18.6 起不注入任何 `Authorization` 头**——管理面鉴权交给登录门换来的会话 cookie（同源自动随行，`HttpOnly`，JS 读不到）；**401 → 弹登录门**（会话过期 / 被轮换清掉时自动闭环）。**v1.18.1 起把 `status`/`body` 挂到抛出的 Error 上**，供运行期设置页显示后端 400 原文 |
| 225–251 | `downloadCsv`(225) `toast`(234) `copyText`(244) | 导出 / 提示 / **复制（含 `execCommand` 兜底）** |
| 260 / 302 / 320 | `areaChart` / `sparkline` / `donut` | 内联 SVG 图表。**v1.18.1 起两个折线函数对空数据返回占位图而不是抛错**（全新部署 `usage` 为空时，详情抽屉曾在 `pts[0][0]` 处崩掉 → 表现是"点详情没反应"） |
| 339 | `NAV` | 侧栏导航定义（「资源」组含 **渠道管理 / 聚合模型 / 自动权重**；「工具」组含 Playground / **运行期设置** / **密钥管理** / 接入信息） |
| 354 / 362 | `renderRail()` / `go(p)` | 侧栏重绘 / **唯一路由**（切页后 `viewport.scrollTop=0`；路由表含 `autoweight:vAutoWeight`、`settings:vSettings` 与 `keys:vKeys`） |
| 375 | `kpiCard(o)` | KPI 卡（值 / 脚注 / 独立曲线带） |
| 395–429 | `winStats`(395) `avgLatency`(411) `avgLatencyDelta`(417) `OV_RANGE`(429) | 窗口统计 / 平均延迟 / **延迟环比**（样本 <40 返回 null）/ **时间范围配置** |
| 432 / 440 | `ovSeries()` / `chSpark(id)` | 按当前范围取序列 / 单渠道曲线 |
| 451–483 | `exportUsage`(451) `exportLogs`(463) `exportModels`(470) `copyModels`(477) | 导出与复制 |
| 486 | `vOverview(v)` | 总览页（含 `24h/7d/30d` 真实切换） |
| 604 / 881 / 918 / 927 | `vChannels` / `drawChTable` / `toggleCh` / `openChannel` | 渠道页（v1.9 起**只剩页签 + 搜索 + 表格**，观测卡已迁出）/ 排序渲染（含**权重 / 分流**列）/ 启停 / 详情抽屉（含权重与分流占比角标 + 自动权重观测一节） |
| 649 / 657 | **`vAutoWeight()`** / **`autoWeightCard()`** | **自动权重页**（v1.9，资源 → 自动权重）：`vAutoWeight` 只出页头 + 挂卡；`autoWeightCard` 把 `/admin/api/status` 的 `autoWeight.models[]` 画成"若启用会怎么分"（**只算不生效**）。份额改成**一候选一列**（`.aw-col`，列宽 = 份额，色带段与名字/百分比同列，见 `build/extra.css` 10–57），份额为 0 的候选不进列、单独一行 `未参与分流：`。列标签**只留渠道显示名**（v1.9.1 起不再拼 id 小片） |
| 728–887 | **运行期设置页（v1.18；v1.18.8 增第四组）**：`setDraft`(728) / `SET_GROUPS`(729) / `SET_META`(730) / `SET_FIELDS`(740) / `setGroupCfg`(761) / `metricsUrl`(762) / `syncSettingsDraft`(763) / `setHint`(768) / `setPayload`(774) / `setStat`(789) / `setCard`(797) / **`vSettings`(821)** / `setToggle`(854) / `updateSetSave`(855) / `resetSettings`(859) / **`saveSettings`(863)** | **运行期设置页**（工具组顺序：Playground → 运行期设置 → **密钥管理** → 接入信息）：读写 `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay`（v1.18.8 增，**四组**）网关运行态开关，唯一数据源 `GET/POST /admin/api/settings`。`SET_GROUPS`/`SET_META`/`SET_FIELDS` 是**四张卡的唯一真源**（加字段只改这三处；v1.18.8 加第四张卡就只动了它们 + `setStat` 一行，零新交互）；`setGroupCfg` 同时取 `config`（回填表单）与 `effective`（钳制后生效值）两段，`setHint` 把二者不一致时算成生效角标；`syncSettingsDraft` 决定"8 秒轮询要不要覆盖草稿"（**`setDirty` 时绝不覆盖**）；`setPayload` **只收有改动的组**（PATCH 语义，没带的不动、不归零）；`saveSettings` 提交期间按钮 disabled + 文案变「保存中…」，**400 的 `error` 原文直接显示**（后端已点名到字段，如 `unknown field rateLimit.rpmm`）。卡容器 `.grid.set-cards`（四卡两排各两张，用户拍板，≤900px 折一列）。样式见 `build/extra.css` 59–80 |
| 995–1031 | `toggleDrawerKey`(995) `reprobe`(1007) `delChannel`(1020) | 抽屉密钥切换（**v1.18.4 起点一次才现取原文**，走 `chKeyLive`）/ 重探测 / 删除 |
| 1032–1147 | `mTab`/`mQ`(1035) `vModels`(1036) `drawMTable`(1084) `openModel`(1113) | 模型页（启用优先排序）/ 调度顺序抽屉。**筛选状态存 JS**（`mTab`/`mQ`，见 v1.0.1） |
| 1148–1265 | `lgRange` 等(1149) `vLogs`(1150) `logRows`(1186) `drawLogTable`(1198) `clearUsage`(1219) `openLog`(1223) `copyCurl`(1260) | 日志页 / 用量清零 / 详情 / 复制 curl（筛选状态 `lgRange`/`lgCh`/`lgOk`/`lgQ`，重绘后命令式回填）。**v1.13.2 起渠道列显示渠道显示名（`adapt()` 解析进 `n`，id 留在 `c`），列序为 请求 ID → 渠道 → 模型，搜索判据含 `l.n`** |
| 1266–1453 | `pgDraft` 等(1273) `vPlayground`(1274) `drawPG`(1343) `drawRoute`(1357) `fmtUsage`(1369) `pgClear`(1372) `pgCopyCurl`(1373) `pgSend`(1379) | Playground：**真实 `POST /v1/chat/completions`**（流式 + 路由信息）。**草稿与参数存 JS**（`pgDraft`/`pgSysText`/`pgModelSel`/`pgTempV`/`pgMaxV`/`pgStreamOn`） |
| 1501–1666 | **密钥管理页（v1.18.5；v1.18.6 会话化）**：`KEY_SRC_TXT`(1511) `keyDraft`(1512) `keyOf`(1516) `keyCard`(1520) **`vKeys`(1545)** `armConfirm`(1590) `toggleKeyReveal`(1599) `copyKeyValue`(1607) `genLocalKey`(1616) `fillGeneratedKey`(1625) `rotateKey`(1632) `resetKeysAction`(1652) | **密钥管理页**（工具 → 密钥管理，夹在运行期设置与接入信息之间）：在线轮换 `GATEWAY_KEY` / `ADMIN_KEY`。快照只有**掩码 + 来源**（console/env/generated/none），明文点「显示」才现取一次（按需揭示端点）；**「轮换」单击直接生效**（用户明确要求，文案写明"旧密钥立即失效"）；「回到环境变量值」保留**两步确认**（`armConfirm`，6 秒不复位自动还原）——它把控制台轮换的成果整段交还给 .env；**v1.18.6 会话化**：页头页操作区挂「退出登录」按钮（`#keyLogout` → `logout()`，只杀自己那枚会话）；换管理密钥后前端**不再写任何浏览器存储**——服务端清空全部会话并在轮换响应里**补发新会话 cookie**，发起页无感继续用；页脚文案明示"所有已登录会话都会失效、重启也会掉线（内存表），重开控制台重新粘一次密钥即可"；手填草稿存 `keyDraft` 回填（状态回填约定）。唯一数据源 `GET /admin/api/keys`（随 `loadAll` 拉取，单独兜底）；**「随机生成」只在本地把 48 位随机串（四样字符齐全）填进输入框（`fillGeneratedKey`，不发请求）——用户先看到/复制新值，再点「轮换」提交 `POST /admin/api/keys` 生效**；「回到环境变量值」走 `POST /admin/api/keys/reset`。服务端 `POST /admin/api/keys/generate` 端点保留（API 可用，e2e 已测），控制台不再用它 |
| 1454–1493 / 1661–1790 | `SNIP`(1455) `vAccess`(1661) `showKeyHelp`(1757) | 接入信息（端口 / 模型名照旧；**v1.18.4 起服务端只下发掩码**，密钥原文要点一次才现取：`copyGwKey` / `copyAllEndpoints`）；端点地址可直接复制；页头「密钥管理」按钮 `go('keys')` 直接跳轮换页（v1.18.5）；`showKeyHelp` 降级为**命令行备用路径**步骤清单（会提醒：控制台轮换过之后 `.env` 说了不算）。**v1.18.5 插入密钥管理页后本块被拆成两段**：`SNIP`（curl 等接入示例）在密钥块之前、`vAccess`/`showKeyHelp` 在其后 |
| 1791–1803 | `modal`(1792) `closeModal`(1799) `setStatus`(1800) `toggleMenu`(1801) | 弹窗容器 / 关闭 / 行内状态 / 下拉菜单 |
| 1804–1831 | `PROTO_META`(1805) `PROTO_ORDER`(1815) `chKey`(1818) | 协议元数据 / 顺序 / 密钥取值（**v1.18.4**：`chKey` 给的是**掩码**；原文只在用户点击时经 `GET /admin/api/channels/{id}/key` / `GET /admin/api/gateway-key` 现取一次 —— `EP_COPY_TEXT`(1821) `_gwk`(1822) `chKeyLive`(1823) `gwKeyLive`(1824) `copyChKey`(1825) `copyGwKey`(1826) `copyAllEndpoints`(1827)，`gwKeyLive` 按页缓存）；（原型是 `fakeKey`） |
| 1832–2091 | `openChannelForm`(1834) `probeUpstream`(1928) `toggleKeyField`(2028) … `saveChannel`(2044) | 渠道表单：**权重输入框（`f-weight`，v1.5）**、模型别名行、上游探测列表（搜索/全选/批量）、密钥掩码切换（**v1.18.4 起不回填原文**，占位符为「已配置 sk-a…1234 · 留空保持不变」；点「明文」时 `toggleKeyField` 才经 `chKeyLive` 现取一次原文、只填进输入框不落库）、保存（`weight` 随 `POST /admin/api/channels` 一起提交；**`apiKey` 留空 = 保持原密钥**） |
| 2092–2229 | `IMPORT_META`(2093) `parseCodexUnits`(2111) `parseGsSessionId`(2119) `openImport`(2126) `importCodexRt`(2161) `importGsSession`(2166) `doImport`(2172) `importFiles`(2192) | 导入：**真实对接** `codex-import` / `genspark-import` |
| 2230–2343 | `openTestModels`(2231) `chName`(2282) `testRowVerdict`(2288) `runTests`(2295) | 测试模型：**真实调用 `/admin/api/test`**。**v1.13 起停用渠道也要能测**（不再 `!c.on` 跳过；指定渠道时只列该渠道、带「已停用」标记与"不参与自动探测"说明，全局模式包含停用渠道但启用排前）。**结果行必须能看懂**：每行带 `模型名` + 渠道显示名（`chName`）+ 中文结论（`testRowVerdict` 分 通过 / 空回复 / 失败 三档）+ 延迟 / token / 回复或错误原文 |
| 2344–2366 | `drawer`(2345) `closeDrawer`(2349) `setTheme`(2357) | 抽屉 / 主题持久化 / 明暗互切（`#themeBtn.onclick` 与 `#globalSearch` 的 Enter 监听是程序化挂接，非内联属性） |
| 2374–2438 | **事件委托块**：`ACTS`(2381) + click(2427) / change(2433) 两个 `document` 委托监听 | **全站唯一事件入口（v1.18.7）**：内联 `onclick=`/`onchange=`/`onkeydown=` 属性已全部清零（含 `build/shell.html` 的抽屉遮罩，改 `data-act`）——动作进 `data-act`（change 走 `data-change`）、参数走 `data-*`（外部可控 ID 一律 `esc()`），两个委托监听统一分发：`ACTS` 表 44 个动作与模板**双向一一对应**；8 秒轮询整页重绘**不用重挂监听**；点击从目标向上找最近的 `[data-act]`，嵌套按钮天然只触发自己（行/卡片的动作不再被按钮冒泡触发，`stopPropagation` 成为历史）。登录门的 Enter 改为 `showKeyGate` 内程序化挂接（非内联属性）。**新增交互：先在 `ACTS` 注册 + 模板写 `data-act`，禁止写内联属性**（`test/security-headers-e2e.test.js` 内联清零 + 双向覆盖守卫、`test/console-state.test.js` 真实委托块桩上真跑，都会拦回潮） |
| 2443 / 2472 / 2476–2480 | `showKeyGate()` `logout()` 启动探针 | **管理密钥登录门（v1.18.6 会话化）**：`?key=` 三源合流已整体拆除（渗透报告点名"密钥进浏览器历史"）——`showKeyGate` 把粘贴的密钥 POST 给 `/admin/api/session` **一次**，换回 `HttpOnly + SameSite=Strict` 会话 cookie（12 小时）后密钥即弃（输入框清空、不落任何存储、JS 读不到）；`logout()`（密钥管理页「退出登录」）DELETE 自己那枚会话并整页重载；**启动探针**不问本地存储直接敲一发 `/admin/api/status`——200 = 活会话直接 `boot()`，401/网络错 = 弹门 |
| 2475 | `tick()` | 时钟 |
| 2492 | `boot()` | 首屏骨架 → `go('overview')` → 8 秒静默刷新（原 `init()`，改名为 `boot` 以配合登录门：有活会话直接启动，无会话先弹门再启动——启动与否由启动探针决定，见上）。**轮询护栏**：流式中（`pgBusy`）或用户正在视口内输入框编辑时跳过这一拍 |

> **状态回填约定（v1.0.1 起，全页统一）**：8 秒轮询会重绘当前页的整个 DOM，**任何输入控件的值都必须存在 JS 变量里并在模板中回填**，
> 且 `oninput` 要把值写回变量。否则重绘后输入框被重建为空 —— 表现就是「搜索/草稿一会儿自己没了」。
> 已有的正确样例：`chQ`/`chTab`（渠道页）、`lgQ` 等（日志页，命令式 `R.value=lgQ` 回填）、`ovRange`（总览页）、`probeQ`（弹窗）、`setDraft`（运行期设置页 —— **有未保存改动（`setDirty`）时轮询绝不覆盖草稿**，否则用户填一半就被 8 秒轮询清掉）、`keyDraft`（密钥管理页，v1.18.5）。
> 弹窗与抽屉（`#drawer`/`#mask`/`modal()` 挂 body）在 `#viewport` 之外，不受重绘影响，无需回填。

> ⚠️ 原型里的 `simTest` / `REPLIES` / `hash()` / `fakeKey()` **在生产侧已全部删除**，替换为真实请求。
> 如果你在生产代码里看到它们，说明构建源搞混了。

### `build/extra.css` 区块（80 行）

| 行号 | 区块 |
| --- | --- |
| 1–2 | 说明（复用设计令牌，不引入新颜色） |
| 5 | `.chip.codex` 协议 chip（设计稿快照无 codex 渠道） |
| 8 | `.kv dd.mono` 抽屉密钥行等宽字 |
| 10–14 | `.aw-*` 组件说明（自动权重**页**，生产独有，设计稿不含） |
| 15 | `.aw-card` 卡容器 |
| 16–24 | `.aw-meta` / `.aw-note` / `.aw-knobs` 说明 + 旋钮带 |
| 25–34 | `.aw-model` 模型块 / `.aw-m-hd` 块头 / `.aw-m-name` / `.aw-m-meta` / 状态标签 |
| 35 | `.tag.warn`（`已排除` 候选的告警标签） |
| 36–42 | 份额列设计说明注释（为什么不再用「堆叠带 + 独立图例」） |
| 43–46 | `.aw-split` 份额列容器 / `.aw-col`（列宽 = `flex-grow:var(--w)`）/ `.aw-seg` 色带段 / `.aw-cap` 名字+百分比行 |
| 47–51 | `.aw-nm` 渠道名（**只留显示名**，v1.9.1 起不再跟 id 小片）/ `.aw-nm .k` `盲试`·`自动匹配` chip |
| 52–57 | `.aw-sh` 份额数字 / `.aw-sub` 副行 / `.aw-zero` 未参与分流说明 |
| 59–62 | `.set-*` 组件说明（运行期设置**页**，生产独有，设计稿不含） |
| 63–65 | `.set-err` / `.set-err.on` 保存失败错误条（**显示后端 400 原文**；隐藏态 `display:none`） |
| 66 | `.set-desc` 卡内说明文字 |
| 67–70 | `.set-row` 旋钮行 / `.set-row>label` / `.set-row .input`（固定 104px）/ `.set-row .switch`（靠右） |
| 71 | `.set-unit` 单位（`秒` / `次` 等，等宽小字） |
| 72 | `.set-eff` 生效值角标（**中性色** —— 它只说明"生效值与你填的不同"，不是错误） |
| 73 | `.set-warn` 警示文案（如 `/metrics` 公开可读的提醒） |
| 74–76 | `.set-stat` 实时计数区 / `.set-stat b` / `.set-stat .btn`（复制指标地址） |
| 77 | `.set-card.muted` 关闭态整卡降权（卡头开关关闭时旋钮一并禁用） |
| 78–80 | `.set-cards` 四卡两排各两张（v1.18.8 用户拍板，≤900px 折一列；通用 `.g4` 是四连排、原型别处在用，**不能**改它的定义） |

> **v1.9 起没有 `.aw-bar` / `.aw-legend` / `.aw-item` / `.aw-sw` / `.aw-more`** —— 那条「堆叠带 + `auto-fit` 图例」
> 路线已整体删除（图例换行后与色带对不上，用户报的"错位"）。现在是一候选一列，见坑位 17/18。
> **v1.9.1 起没有 `.aw-nm .id`** —— 列标签只留渠道显示名，id 小片（`.aw-nm .id`）失去唯一引用后一并删除。

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
| 日志 | `vLogs` 1450 | `openLog` 1494（请求详情抽屉）；表格列序 **请求 ID → 渠道（显示名）→ 模型**，渠道名就地查 `DATA.channels` |
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
//   —— 以下三个由 /admin/api/status 映射而来（v1.5，加权轮询展示用；完整字段清单以 adapt()（57）为准）
//   w     : 配置权重，0 = 不参与加权轮询
//   wHits : weightedHits，被选中次数
//   wShare: weightedShare，占全部加权轮询命中的百分比（0–100）
//   —— 以下五个是自动权重观测（v1.6 静默版，只算不生效；判断依据全摊开，便于排障）
//   ah    : autoH，健康系数 0.2–1（null = 还没算过）
//   aFail : autoFailRate，滚动窗口失败率（null = 样本不足 →"看不清就不动"）
//   aN    : autoSamples，滚动窗口样本数
//   aLat  : autoLatMs，最近成功请求的延迟 EWMA（null = 没数据，不按速度扣分）
//   aSpd  : autoSpeedRatio，相对最快渠道的倍数（2 = 慢一倍）

// DATA.auto = /admin/api/status 的 autoWeight 块（v1.6；null = 后端没返回）
{ enabled, effective, knobs:{ minSamples, floor, latencyPenalty, maxShare, updateMs, ewma, deadband }, at,
  models:[ { model, requests, manualOff, excluded:[channelId...],
             candidates:[ { id, kind, base, manual, h, share, nowShare, status, cooldown,
                            failRate, samples, latMs, speedRatio, weight } ] } ] }
//   effective : **恒 false**（本版观测不生效）——界面必须如实展示，别让人以为已经生效
//   share     : 预测份额（%）＝ 若启用自动权重，该候选在"同一模型的候选集"里的占比
//   nowShare  : 当前手工权重下的真实份额（%）；null = 当前未开加权轮询，没有份额可对照
//   models[]  : 只含**候选 ≥ 2** 的模型（一个提供方谈不上分流），按请求量降序、最多 12 条
//   manualOff : true = 当前压根没开加权轮询（候选都没填 weight）

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
| 新增协议（原型） | `PROTO_META` 1775 + `PROTO_ORDER` 1785 + `.chip.<proto>` 配色 226–233 |
| 新增协议（生产） | `build/app.js` 的 `PROTO_META` 1802 / `PROTO_ORDER` 1812 + `build/extra.css` 补 chip 色 + `server.js` 协议分支，然后重新构建 |
| 新增页面（原型） | `NAV` 1022 + `vXxx()` + `go()` 1042 的分发表 |
| 新增页面（生产） | `build/app.js` 的 `NAV` 339 + `vXxx()` + `go()` 362 **与 `render()` 161 两张**分发表，然后重新构建（**v1.9 的「自动权重」页**、**v1.18 的「运行期设置」页**（`vSettings` 821）、**v1.18.5 的「密钥管理」页**（`vKeys` 1545）都是照这条加的 —— 注意 **`go()` 与 `render()` 两张表都要注册**，只加一张会出现"能进页但 8 秒轮询不刷新"） |
| 新增导入类型 | `IMPORT_META` 2035（原型）/ 2090（生产）+ 工具栏菜单（原型 1186–1196、占位 markup 589 起 / 生产 587–598） |
| 渠道列表排序 | 1179（渠道页）/ 1385（模型页）；生产 878 / 1081 |
| 探测列表交互 | `renderProbeList` 1928 起整段（原型）/ 1953（生产） |
| 图标 | `IC` 861（原型）/ 3（生产），用 `svg('name',size)` 引用 |
| 主题持久化 key | `zzcs-theme`（原型 `setTheme` 2254 / 生产 `setTheme` 2357） |
| 生产独有组件样式 | `build/extra.css`（**不要写进设计稿**，设计稿没有这些组件） |
| 构建逻辑 / 产物结构 | `build/build.js` |
| 总览时间范围（24h/7d/30d） | 生产 `OV_RANGE` 429 + `ovSeries` 432 + `vOverview` 486 |
| 渠道权重（输入框 / 表格列 / 抽屉角标） | **v1.5**：生产 `openChannelForm` 1834（`f-weight`）+ `saveChannel` 2044（提交 `weight`；**v1.18.4 起 `apiKey` 留空 = 保持原密钥**）+ `drawChTable` 881（「权重 / 分流」列）+ `openChannel` 927（抽屉角标）+ `adapt()` 59（映射 `w`/`wHits`/`wShare`）；后端 `weight` 语义见 docs/scheduling.md「加权轮询」。**原型未同步**（生产独有能力，原型不必追平） |
| 自动权重观测页 | **v1.9**：生产 `NAV` 339（资源 → 自动权重）+ `vAutoWeight` 649 + `autoWeightCard` 657 + `build/extra.css` 的 `.aw-*`（10–57）；数据来自 `/admin/api/status` 的顶层 `autoWeight`。**原型未同步**（v1.9.1：份额列标签只留渠道显示名） |
| 运行期设置页（会话粘性 / 客户端限流 / 指标端点 / thinking 回放） | **v1.18**：生产 `NAV` 339（工具组顺序：Playground → 运行期设置 → **密钥管理** → 接入信息）+ `vSettings` 821 + 辅助段 728–887 + `build/extra.css` 的 `.set-*`（59–80）。唯一数据源 `GET/POST /admin/api/settings`：`config` 段回填表单、`effective` 段显示钳制后生效值、`status` 段给实时计数；`setPayload` **只提交有改动的组**（PATCH 语义）。**v1.18.8 增第四张卡**（thinking 回放）：`SET_META`/`SET_FIELDS`/`setStat` 各加一段（**零新交互**，开关/保存全走既有路径）、卡容器 `g3`→`set-cards`（两排各两张，用户拍板；通用 `.g4` 是四连排、原型别处在用，**不能**改它）。字段契约 / 文案要点 / 验收清单见 [`console-settings-spec.md`](console-settings-spec.md)。**原型未同步**（生产独有能力，设计稿不含该页） |
| 密钥管理页（在线轮换 GATEWAY_KEY / ADMIN_KEY） | **v1.18.5**：生产 `NAV` 339（工具 → 密钥管理，夹在运行期设置与接入信息之间）+ `vKeys` 1545 + 辅助段 1501–1666（`keyCard` / `armConfirm` / `toggleKeyReveal` / `genLocalKey` / `fillGeneratedKey` / `rotateKey` / `resetKeysAction`）。数据源 `GET /admin/api/keys`（只回掩码 + 来源）；「轮换」单击直接生效（用户要求）；「回到环境变量值」两步确认（`armConfirm`）。**v1.18.6 会话化**：换管理密钥后前端不写任何浏览器存储（服务端清空全部会话并在轮换响应里**补发新会话 cookie**，发起页无感继续）；页操作区挂「退出登录」按钮（`#keyLogout` → `logout()`）；`showKeyHelp` 步骤改为**粘贴密钥登录**（不再有 `?key=` 带参链接）。后端语义见 docs/behavior.md（密钥轮换 / 管理面会话）与 `test/key-rotation-e2e.test.js` / `test/admin-session-e2e.test.js`。**原型未同步**（生产独有能力，设计稿不含该页） |
| 调用日志列（渠道名 / 列序 / 搜索 / 导出） | **v1.13.2**：生产 `adapt()` 59（日志条目新增 `n` = 渠道显示名，`c` 仍保留 id）+ `logRows` 1186（搜索判据 `l.m+l.n+l.c+l.id`）+ `drawLogTable` 1198（表头 请求 ID → 渠道 → 模型，渠道格 `esc(l.n)`）+ `openLog` 1223（抽屉渠道显示名）+ `exportLogs` 463（CSV 渠道列写显示名）。**原型已同步**（`console-redesign.html` 的 `vLogs` 1478 表头 / 1482 渠道格 / 1507 抽屉，就地查 `DATA.channels`） |
| 测试模型弹窗（停用渠道可测 + 结果可读） | **v1.13**：生产 `openTestModels` 2231（不再按 `!c.on` 跳过停用渠道；停用渠道带「已停用」标记 + 说明文案，全局模式启用渠道排前）+ `testRowVerdict` 2288（结果三档：通过 / **空回复** / 失败；判定为纯函数，`test/console-state.test.js` §6 跑真值表）+ `chName` 2282（结果行写渠道显示名）+ `runTests` 2295（逐条带 `channelId`，不走调度；每行带模型名与中文结论，汇总分开数三档）。后端：`/admin/api/test` 带 `channelId` 时不看 `enabled`；自动探测 `probeAll` 默认跳过停用渠道、手动「全部重探测」显式 `includeDisabled:true`（见 README「Web 控制台」一节的「自动 vs 手动的边界」）。`test/console-state.test.js` §5/§6 真跑该弹窗与结果渲染做回归。**原型未同步**：`console-redesign.html:2175` 的演示版 `openTestModels` 仍是旧的 `if(!c.on)continue;`（设计稿演示逻辑，不随生产走；原型有 3 个 demo 停用渠道，点它们仍会看到空列表） |
| 新增交互 / 按钮（click / change 动作） | **v1.18.7**：动作进 `data-act`（change 走 `data-change`）+ 事件委托块（app.js `ACTS` 2381 + click 2427 / change 2433 两个 `document` 委托监听；模板与注册表**双向一一对应**，见 §0.2 事件委托块行）。**禁止内联 `onclick=`/`onchange=`/`onkeydown=` 属性**（v1.18.7 已全量清零；外部可控 ID 一律 `data-*` + `esc()`，绝不拼进事件代码字符串）——`test/security-headers-e2e.test.js`（内联清零 + 双向覆盖守卫）与 `test/console-state.test.js`（真实委托块桩上真跑）会拦回潮。**复用既有控件不算新增交互**（v1.18.8 第四张设置卡零 `ACTS` 改动就是范例） |

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

> 鉴权：浏览器走**会话 cookie**（v1.18.6：登录门把 `ADMIN_KEY` 交给 `/admin/api/session` 换回 HttpOnly cookie，密钥本身不进浏览器）；脚本 / curl 走 `Authorization: Bearer <ADMIN_KEY>`。真实接入时**不要**沿用 `fakeKey()`。
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
13. **改完 `console-redesign.html` 的行号会漂移**：`console.html` 的行号 = 原型行号 +13（CSS）/ `build/app.js` 行号 **+689**（JS，v1.18.8 起；v1.18–v1.18.7 曾是 +686，v1.9.1–v1.17 曾是 +666）。增删 `build/head.html` / `build/shell.html` / `build/extra.css` 的行会让 JS 偏移改变（head/shell 已有构建期行数守卫）；**`extra.css` 在拼接序里位于 `app.js` 之前，它每增删 1 行 JS 偏移就整体 ±1，而 CSS 偏移不受影响**。
14. **表格表头右对齐要压权重**：`table.tbl thead th{text-align:left}` 权重是 (0,1,3)，高于 `.t-r` 的 (0,1,0)，所以 `th` 上的 `.t-r` **默认不生效**，会出现"表头左对齐、数值右对齐"的错位。必须用 `table.tbl thead th.t-r` 这种更高权重的选择器（原型 300 行与 `.t-r` 并排写在同一行，就是为了不增行数、避免锚点整体漂移）。新增右对齐列时务必肉眼确认表头也对齐了。
15. **剪贴板只在安全上下文可用**：`navigator.clipboard` 在 `http://` + 局域网 IP 下是 `undefined`，而可选链 `?.` 会把整条链**静默短路**——既不复制也不报错，看起来就是"按钮点了没反应"。`copyText` 因此用 `document.execCommand('copy')` 兜底，别删。
16. **往 HTML 属性里塞字符串一律走 `data-t`**：`onclick="copyText(${JSON.stringify(x)},this)"` 会把双引号塞进双引号属性里，属性被截断、按钮彻底失效（接入信息页曾因此复制不了密钥）。统一写 `data-t="${esc(x)}" data-act="copy"`（v1.18.7 起事件全走委托，`onclick=` 内联属性已清零——往事件代码字符串里拼外部值的整类坑随之消失；`esc()` 仍守一切 `data-*` 属性值）。
17. **「条 + 独立图例」必然错位，标签必须贴在自己那一段下面**：份额带的段是**单向排列**（左→右按顺序），而图例若用 `auto-fit` 网格则是「左→右、换行再左→右」——候选一多、一换行，读者就没法把图例项对回它的段。更糟的是真机上绝大多数候选健康系数 =1（色块全是同一个绿），连颜色都认不出谁是谁（v1.8.1 只修了行内基线，没修"对不上"这个根本问题）。**v1.9 的处置**：改成一候选一列（`.aw-col`，列宽 = 份额），列内上方 `.aw-seg` 色带段、下方 `.aw-cap` 直接挂名字与百分比 ——"这段是谁的"不用去别处找。**新增任何"带 + 图例"组件前先问：换行后读者还能把图例对回它的段吗？**
18. **按比例分列宽用 `flex-grow`，别用 `width:calc(x%)`**：`.aw-split` 用 `gap:8px` 给列间真间隙，列上写 `flex-basis:0` + `flex-grow:var(--w)` —— 间隙由布局先让出、余量再按份额分，各列宽度仍**严格成比例**，也不会被 100% 撑破。手写 `width:calc(x% - Npx)` 一旦候选数变化就立刻失准。配套两条：列要 `min-width:0`、列内文字要 `overflow:hidden;text-overflow:ellipsis`，否则长渠道名会把列撑宽、把比例撑歪（全量信息放 `title`）。
19. **新起类名之前先 grep 它的定义——`.mask` 是弹窗遮罩，不是"掩码"**：设计稿把"被遮罩的密钥值"写成 `<span class="mask mono">`，于是它连同 `.mask{position:fixed;inset:0;z-index:80;opacity:0}` 一起吃下 —— 这个值变成**铺满视口、透明、脱离文档流**的元素：文本在 DOM 里（`textContent` 有值）却永远不显示，行里只剩「当前值 / 显示 / 复制」和一块空白。密钥管理页（v1.18.5 新增）与**接入信息页的 `GATEWAY_KEY` 行**一起中招，且从设计稿一路带过来，长期没人发现。**v1.18.6 处置**：该值改用独立类 `.ep-key .kval`（原型 `<style>` 337 + 原型 markup 1700 + `build/app.js` 的 `keyCard` / `vAccess`，共 4 处），`.mask` 回归"只做弹窗遮罩"。教训：**CSS 类名没有命名空间，复用前先 `Select-String -Pattern '^\.<名字>\{'` 确认它没被别处定义**；`test/console-state.test.js` §11 已加守卫（源码不得出现 `class="mask mono"`、产物不得有 `.ep-key .mask` 规则、**且 `.mask` 必须仍是那条弹窗遮罩**——防止用"给遮罩改名"蒙混过关）。

---

## 8. 快速自测清单（改完跑一遍）

**构建与产物**

- [ ] `node test/console-state.test.js` 全绿（视口内输入控件状态回填 + 表单权重 + 自动权重观测页 + 运行期设置（v1.18.8 四张卡）+ 密钥管理页（含会话语义装配守卫）+ **事件委托（真实委托块桩上真跑分发）**的自动化回归，**185 项断言**；改了任何带输入框的页面都要跑）
- [ ] `node test/security-headers-e2e.test.js` 全绿（渲染层裸插值 + 内联事件属性清零 + `ACTS` 双向覆盖守卫，**57 项断言**；改了任何渲染/交互代码都要跑）
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
- [ ] **自动权重观测（v1.6）**：渠道页顶部观测卡显示"若启用会怎么分"（多候选模型才出现；单候选/无多候选时给空状态），
      卡头写明**当前分流一字未动**；抽屉里能看到该渠道的健康系数 / 样本数 / 失败率 / 延迟；
      真发几次请求后观测的数字会跟着动，但 `weightedHits` 仍是 0、落点仍按老规矩
- [ ] 抽屉内密钥可掩码↔明文切换、可复制（生产显示的是**真实密钥**，不是假串）
- [ ] 添加/编辑渠道弹窗：协议切换后 Base URL 提示随之变化；探测结果可搜索、可全选、可批量加入
- [ ] 导入四类（Codex RT / Codex JSON / Genspark 会话 / Genspark JSON）都能打开，JSON 类支持多选
- [ ] 测试模型弹窗：勾选后逐条出结果与汇总（结果来自 `/admin/api/test` 真实请求）
- [ ] **运行期设置（v1.18；v1.18.8 四张卡）**：四张卡（会话粘性 / 客户端限流 / 指标端点 / thinking 回放）的开关 / 旋钮改完点「保存设置」——**只提交有改动的组**（其余不动、不归零）；
      保存后立即生效，且 `config`（你填的原值）与 `effective`（钳制后生效值）都对得上（填 `ttlSec:5` 时 `config` 保 5、`effective` 显示 30）；
      在输入框里填一半**静等 10 秒以上**，输入不能被 8 秒轮询清掉；故意把字段名写错，页面要显示后端 400 的**原文**（如 `unknown field rateLimit.rpmm`），不是"保存失败"这种空话；
      停在「运行期设置」页等轮询，页面上的实时计数（粘性命中 / 在飞数 / 被拒次数 / thinking 回放缓存条数与修复命中）要跟着刷新；
      窗口任意宽度下四张卡都保持**两排各两张**（`.grid.set-cards`），<900px 折一列
- [ ] **密钥管理（v1.18.5 / v1.18.6 会话化）**：两把密钥都显示掩码 + 来源角标；「随机生成」先把值填进输入框（不发请求、不生效），看清/复制后点「轮换」才生效；轮换管理密钥后**本页不弹登录门**（服务端清空全部会话并给本响应补发新会话 cookie）；换网关密钥后旧 key 调 `/v1/models` 立即 401；「回到环境变量值」后来源角标变回「环境变量」（此时也会清空全部会话）；手填非法值（太短/带空格/change-me）直接 toast 后端 400 原文；「轮换」单击即生效（旧值立即失效）；「回到环境变量值」要点两下；**「退出登录」按钮**点击后整页重载回登录门，且只杀自己那枚会话（别的标签页不受影响）；重启网关后所有会话掉线（内存表），重开控制台重新粘一次密钥即可
- [ ] Playground 发一条消息，能收到真实流式回复 + 路由信息（渠道 / 首块延迟 / 总耗时）
- [ ] 接入信息页展示的网关地址、密钥、模型名来自 `/admin/api/config`，非硬编码
- [ ] 弹窗点遮罩**不关闭**；× / 取消 / Esc 可关闭
- [ ] **输入状态跨重绘**（v1.0.1 起必查）：在模型页搜索框输入文字、在 Playground 敲草稿，**静等 10 秒以上**——
      文字必须还在、页签/参数不跳回默认；旁边的数据仍在刷新（说明不是靠停掉轮询糊过去的）
- [ ] 轮询重绘后滚动位置与输入光标位置不跳（`render()` 的保位逻辑）
- [ ] 页面底部无异常空白，侧栏高度贴合视口
- [ ] 窗口缩到 <1320px / <900px 布局不破
