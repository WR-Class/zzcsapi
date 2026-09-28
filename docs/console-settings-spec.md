# 控制台「运行期设置」页 · 前端实现规格（交给前端执行者）

> 面向对象：拿到本文件就动手改前端的人（或 AI）。后端契约已实现并有测试守着（`test/settings-api-e2e.test.js`，58 项断言）。
> **你只改前端**：`build/app.js`（必要的话 `build/shell.html` / `build/extra.css`），改完**必须** `node build/build.js`。
> 本文件由后端侧维护，接口字段以本文件为准；若发现契约与实测不符，先停下来问，不要在前端"猜一个字段名"。

---

## 0. 一句话目标

让用户能在控制台里开关并调参三组运行期设置——**会话粘性 / 客户端限流 / 指标端点**——
以前只能改 `config.json` + 重启（v1.17 的遗留缺口）。改完**立即生效、立即落库**，无需重启容器。

## 1. 放在哪

- 侧栏「资源」分组下新增一项：`{ id: 'settings', label: '运行期设置', icon: 'sliders' }`（放在「自动权重」之后）。
- 新页面视图函数 `function vSettings(v)`，与 `vChannels` / `vAutoWeight` 同级。
- ⚠️ **两处都要注册**：`go()` 里的分发表（约 345 行）**和** `render()` 里的重绘表（约 157 行）。
  只注册一处会出现"点进去正常、8 秒后自动刷新就不更新/不保留输入"的怪现象——「自动权重」页刚修的就是这个坑。
- 需要新图标 `sliders`：往 `const IC = {...}` 里加一条 24×24 线性图标（`stroke` 由现有 CSS 管，只填 `<path>`），
  例如三条带把手的横线。**不要引入图标库**（仓规：全部手写内联 SVG）。

## 2. 后端契约（已实现）

### 2.1 `GET /admin/api/settings`（admin key）

```json
{
  "config":   { "sessionAffinity": { "enabled": false, "ttlSec": 3600, "maxEntries": 2000, "deriveFromBody": false },
                "rateLimit": { "enabled": false, "rpm": 0, "burst": 0, "maxConcurrent": 0 },
                "metrics": { "enabled": true, "public": false } },
  "effective":{ "sessionAffinity": { "enabled": false, "ttlSec": 3600, "maxEntries": 2000, "deriveFromBody": false },
                "rateLimit": { "enabled": false, "rpm": 0, "burst": 0, "maxConcurrent": 0 },
                "metrics": { "enabled": true, "public": false } },
  "status":   { "affinity": { "enabled": false, "entries": 0, "hits": 0, "misses": 0, "learned": 0, "evicted": 0, "expired": 0, "reordered": 0 },
                "rateLimit": { "enabled": false, "rpm": 0, "burst": 0, "maxConcurrent": 0, "tokens": 0, "inflight": 0, "peakInflight": 0, "limitedRate": 0, "limitedConcurrent": 0, "released": 0 } }
}
```

**`config` 与 `effective` 的区别必须都展示**（这是这一页最容易做错的地方）：

- `config` = **用户填的值**，用来**回填输入框**（原样保留，比如他填了 `ttlSec: 5` 就显示 5）。
- `effective` = **钳制后真正生效的值**（`ttlSec: 5` → **30**；`maxEntries: 200000` → **100000**；`burst: 0` → **等于 rpm**）。
- 两者不同时，在输入框旁给一句中性提示（不是红色报错）：`生效：30（下限 30 秒）`。
  只显示一个就会造成"我明明填了 5，怎么没生效"或"我填的值被系统改了"的误会。

### 2.2 `POST /admin/api/settings`（admin key，PATCH 语义）

请求体只需要带你**想改的那几组**，组内只需要带**想改的字段**：

```json
{ "rateLimit": { "enabled": true, "rpm": 60, "burst": 1 } }
```

- 成功：`200 { ok: true, updated: ["rateLimit"], config: {...}, effective: {...}, status: {...} }`（结构与 GET 相同）
- 未带到的组/字段**保持不变**（所以「只关开关」就发 `{ "rateLimit": { "enabled": false } }`）。
- 失败：`400 { error: "..." }`，原文直接展示给用户（错误信息已经写明是哪一组哪个字段，例如
  `unknown field rateLimit.rpmm`、`rateLimit.rpm must be a finite number >= 0`、`metrics.enabled must be a boolean`）。
- 字段类型是**严格的**：布尔字段必须真布尔（`"true"` 字符串会被 400），数字字段必须 `>= 0`。
- 空报文 `{}` → 400 `nothing to update...`：**前端不要发空报文**（没有任何改动时把保存按钮禁用即可）。

### 2.3 实时状态从哪来

- `/admin/api/settings` 里的 `status` 段已经带了粘性/限流的实时计数；
- `/admin/api/status` 里也有 `affinity` / `rateLimit` / `metrics` 三段（同一份数据的另一种投影），
  所以**现有 8 秒轮询**已经足够刷新"实时计数"，不必为它再加一个定时器。

## 3. 页面结构（建议）

三张卡片，一张一组；卡片头 = 标题 + 开关（`toggle`）；卡片体 = 旋钮 + 生效值角标 + 实时计数 + 一句"它到底在做什么"。

**① 会话粘性**（`sessionAffinity`）

- 开关：`enabled`。关闭时整张卡降权（`.muted`），旋钮 `disabled`。
- 旋钮：`ttlSec`（秒，30–604800，默认 3600）、`maxEntries`（16–100000，默认 2000）、`deriveFromBody`（开关，**默认关**）。
- 文案要点：粘性**只改"谁是第一位"**；粘住的渠道不在候选/冷却/已 down 时**一动不动**；命中**不影响权重份额统计**。
- `deriveFromBody` 旁必须有一句风险说明：开它会让**相同提示的不同请求**互相抢占同一家渠道，默认关是有意的。

**② 客户端限流**（`rateLimit`）

- 开关：`enabled`。
- 旋钮：`rpm`（每分钟请求数，0 = 不限）、`burst`（桶容量，0 = 等于 rpm）、`maxConcurrent`（并发上限，0 = 不限）。
- 文案要点：**整机**限流（不是按 IP）；超限回 `429` + `Retry-After`；闸门在**鉴权之前**，连刷鉴权的流量也挡；
  `/healthz`、管理面、`/metrics` **不受**客户端限流影响。

**③ 指标端点**（`metrics`）

- 开关：`enabled`（**默认开**）、`public`（默认关）。
- 当 `enabled=false` 时，`/metrics` 返回 **404**；本页可以顺手给一个"打开"按钮 + 一行抓取地址提示。
- `public=true` 时**匿名可抓**，旁边给一句提醒：此端点正文**不含任何密钥**，但会把渠道 **id** 暴露给能访问该端口的人。
- 建议放一个只读的"当前指标名一览"或"复制抓取地址"按钮（地址取 `location.origin + '/metrics'`）。

页面底部：`保存`（主按钮）+ `还原`（把表单恢复成最近一次 GET 的值）。保存成功 → 轻提示（沿用现有 toast）→
用响应体里的 `config/effective/status` 直接回填并重绘（不用等下一次轮询）。

## 4. 必须守住的交互细节

1. **只在有改动时提交**，且提交期间按钮 `disabled` + 文案变「保存中…」，避免连点造成两次写入。
2. **输入框的值必须跨轮询保留**：本页会被 8 秒轮询重绘，所以
   - 新页必须注册进 `render()` 的重绘表（见 §1 的 ⚠️），
   - 已聚焦且正在编辑的输入框不要被后台数据覆盖（保留焦点、光标位置与未提交的输入）。
3. **400 的 `error` 原文要显示**，不要吞掉换成"保存失败"。
4. **钳制提示**只用中性色（`--muted` 一类）；**错误**才用 `--err`（仓规：红涨绿跌，别用它表达"注意"）。
5. 开关切换要**立即反映在卡片的可用状态**上（关掉 → 旋钮禁用 + 实时计数区显示"未启用"而不是 0，避免"0 次拒绝"被误读成"没拦到"）。
6. 数字输入：允许留空（留空 = 不下发该字段）；不要用 `Number('') === 0` 把留空变成 0 下发。
7. 配色遵循仓规：全站暖色，**不引入冷色（青/蓝绿/紫青）**；暗色=暖琥珀陶土，亮色=暖锈橙。

## 5. 要改哪些文件（清单）

| 文件 | 改动 |
| --- | --- |
| `build/app.js` | `IC` 加 `sliders`；`NAV` 加 `settings` 项；新增 `vSettings(v)`；**`go()` 与 `render()` 两张表都注册**；`loadAll()` 增加 `api('/admin/api/settings')`（放进现有 `Promise.all`，失败用 `.catch(() => null)` 兜底，别让整页拉取被拖垮）；`RAW`/`adapt()` 按需带上 `settings` |
| `build/shell.html` | 一般**不用改**（页面内容是 JS 渲染的） |
| `build/extra.css` | 只有当你要新增"旋钮行/取值提示"这类样式时；改一行都要注意它会让 JS 偏移 ±1（见 AGENTS §1.2） |
| `console-redesign.html` | 原型**不必追平**（原型是设计演示，生产独有能力历来不在原型里补） |

改完**必须**：

```powershell
node build/build.js          # console.html 是构建产物，禁止手改
node test/console-state.test.js   # 103 项断言，退出码非 0 = 有回归
```

## 6. 文档同步（AGENTS §1 强制，漏了算改动未完成）

- `docs/frontend-code-map.md`：`build/app.js` 新增函数登记到 §0.2；按 §1.2 的脚本重新核对**行号锚点**
  （新增函数会让它后面的行号全部平移，必须逐个核对，不要凭估算改数字）。
- `docs/frontend-console-detailed.md`：§8 变更日志写清**问题 → 根因 → 处置**；页面/流程章节补这一页；
  §7「原型→生产映射表」已有 `/metrics` 与设置端点相关行，若你的实现改变了映射关系一并更新。
- 若行数发生变化，`console.html` 的换算偏移可能变（`extra.css` / 设计稿 CSS 增删行时），
  请同步 `AGENTS.md` §1.2 的偏移说明与 `build/build.js` 注释。

## 7. 验收（做完自己跑一遍，逐条贴结果）

1. `node build/build.js` 成功；`git diff --stat console.html` 里能看到预期变化（不是空 diff）。
2. `node test/console-state.test.js` 全绿。
3. 起真网关（或对线上 `<网关地址>/console`），打开「运行期设置」页：
   - 关着粘性/限流，`/metrics` 卡片显示"已启用（需 admin key）"；
   - 打开限流、`rpm=60, burst=1`，保存 → **不重启**，连发两次 chat：第 1 次 200、第 2 次 **429 且带 `Retry-After`**；
   - 关掉 `/metrics` → 立刻用浏览器访问 `/metrics` 得 **404**；再打开 → 200；
   - 打开粘性后，带同一个 `X-Session-Id` 连发几次 → `/admin/api/status` 里 `affinity.hits` 在涨；
   - **刷新整个浏览器页面**后，表单显示的是刚才保存的值（证明落库生效）。
4. 故意把 `ttlSec` 填 `5` 保存：输入框仍显示 5，旁边提示 `生效：30`。
5. 故意构造一个非法请求（例如用 devtools 直接 POST `{"rateLimit":{"rpmm":1}}`）：页面显示后端原文错误，而不是"保存失败"。
