# ZZCSAPI — 本地多渠道 AI 聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，**零依赖，仅 Node 18+**。
把所有中转 API key 集中在一处，对外同时暴露 **OpenAI / Anthropic / Gemini** 三种兼容端点。

## 特性

- 🚦 **多协议、多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：只要还有能上场的候选，5xx / 超时 / 网络错误，以及上游 4xx（含"渠道声明了早已下架的模型"这类 404）都立刻试下一个渠道；客户端的 400 只在没有候选可切时原样透传
- 🛡 **熔断冷却（分级退避）**：连续失败的渠道按**错误类型**分别退避——瞬时故障（超时/5xx/网络）5s 起、封顶 10 分钟；
  凭证/额度问题（401/402/403、key 失效、余额耗尽）5 分钟起、封顶 6 小时；限流（429）1 分钟起，上游给了 `Retry-After` 就听它的。
  冷却/降级的渠道排到候选链末尾，连续失败 3 次标记 `down`；**健康探测只做"半愈合"**，要一次真实对话成功才彻底恢复（见「熔断冷却」）
- 🔍 **后台健康探测**：定时 GET 渠道的 models 端点，聚合 latency / 状态 / 真实模型清单
- 🌊 **流式透传**：SSE 全程转发；上游响应是 OpenAI 协议时自动转成 Anthropic/Gemini 流；**同协议直通则原始字节直转**（CRLF/分帧都不动，v1.16）
- ⚡ **自带出站客户端（零依赖）**：不依赖全局 `fetch`，用 Node 内置 `http/https` + keep-alive 连接池——实测把网关净增延迟从 +13.9ms 压到 **+0.93ms**（详见「出站与流式写路径（v1.16）」）
- 🧷 **会话粘性（v1.17，默认关）**：同一条会话固定走同一个上游渠道，让上游提示缓存 / KV cache 能复用；只改"谁是第一位"，不硬塞冷却中的渠道，也不污染加权份额统计
- 🚧 **客户端限流（v1.17，默认关）**：整机 rpm + 并发上限，超限回 `429` + `Retry-After`，在鉴权之前就挡住
- 📈 **`/metrics` 指标端点（v1.17）**：Prometheus 文本格式、零依赖，渠道/令牌/耗时/熔断分档/粘性/限流一屏看完
- 🔐 **双层鉴权**：`GATEWAY_KEY`（客户端）+ `ADMIN_KEY`（控制台与管理 API）；未设置则**首启自动生成**随机密钥（日志可查、写入 config.json）
- 🖥 **Web 控制台**：浏览器打开 `http://127.0.0.1:8787/console` 看渠道状态、改优先级、启停渠道
- 📊 **统一模型清单**：`/v1/models`、`/anthropic/v1/models` 自动合并各协议所有可用模型

## 快速开始

### 方式一：Docker（推荐）

```powershell
# usage.json 是运行时持久化文件，不入仓库，首次部署先由模板生成
Copy-Item usage.example.json usage.json
docker compose up -d --build
# 控制台 http://127.0.0.1:8787/console
# 首次启动的 ADMIN_KEY / GATEWAY_KEY 打印在容器日志里：docker logs zzcsapi | grep ADMIN_KEY
# 想固定自己的密钥：根目录建 .env 写 ZZCSAPI_ADMIN_KEY=... / ZZCSAPI_GATEWAY_KEY=...
```

> ⚠️ **改完代码要确认容器真的换了镜像**（v1.18.1 现场踩到过）：`docker compose up -d --build` 有时只**构建**出新镜像、
> 却没重建容器——输出是 `Container zzcsapi Running`（而不是 `Recreate` / `Started`），于是你刷新控制台看到的**还是旧代码**，
> 很容易误判成"改动没生效 / 修了还是坏的"。判断方法是对比两个 ID：
>
> ```powershell
> docker inspect zzcsapi --format '{{.Image}}'        # 容器正在用的镜像
> docker images zzcsapi:local --format '{{.ID}}'      # 刚构建出来的镜像
> # 两者不一致 → 补一发强制重建
> docker compose up -d --force-recreate
> ```
>
> `/console` 响应头是 `Cache-Control: no-store`，所以**不需要**强刷浏览器；看到旧页面几乎总是镜像这一层的问题。

`docker-compose.yml` 挂载 `./config.json` 和 `./usage.json`。
⚠️ 这两个文件都**必须先在宿主机上存在**：`config.json` 由 `server.js` 首次运行自动从 `config.example.json` 生成；
`usage.json` 需要手动从 `usage.example.json` 复制。**若缺失，Docker 会把挂载点建成目录**，
服务不会崩（`ensureUsage` 有兜底），但用量统计将**无法落盘、每次重启归零**，且不易察觉。
`usage.json` 已列入 `.gitignore`（每次请求都会改写，提交它只会产生噪声 diff）。

**端口暴露与 `ZZCSAPI_BIND`（一个容易踩的坑）**：容器里 `server.js` 的绑定地址取自 `ZZCSAPI_BIND`，**缺省是 `127.0.0.1`**——
即只监听**容器内部回环**。此时即使 compose 把端口映射成 `8787:8787`，宿主机的转发也打不到容器网卡，
表现是**容器 `Up (healthy)`、容器内 `/healthz` 正常，但宿主机/局域网连 `127.0.0.1:8787` 被拒**，很像"服务停了"。
`docker-compose.yml` 已显式写死 `ZZCSAPI_BIND: "0.0.0.0"`，所以**用 compose 起不会踩到**；
只有手工 `docker run` 时容易漏掉这个变量（顺带别忘 `TZ=Asia/Shanghai`、`ZZCSAPI_CONFIG=/app/config.json`）。
`docker-compose.yml` 的端口映射是 `8787:8787`（局域网可访问）；只想本机自用就改成 `127.0.0.1:8787:8787`，
并保持 `ZZCSAPI_NOAUTH=0`，一切访问走 `checkAuth`：脚本用 Bearer 头（管理面另认会话 cookie），`?key=` 仅客户端面保留（Gemini SDK 的另一鉴权模式）。

### 方式二：裸 Node（18+）

```bash
# 1) 首次运行自动从 config.example.json 生成 config.json
node server.js

# 2) 编辑 config.json 填入真实渠道，再重启
node server.js
```

可选环境变量：

```bash
GATEWAY_KEY=xxx  node server.js    # 客户端必须带 Bearer xxx
ADMIN_KEY=yyy    node server.js    # 控制台 + /admin/* 必须带 Bearer yyy
ZZCSAPI_NOAUTH=1 node server.js    # 本地开发：完全关闭鉴权（仅限本机自用）
ZZCSAPI_BIND=0.0.0.0 node server.js  # 绑定地址，缺省 127.0.0.1（裸跑时对外提供服务的必填项）
```

**密钥从哪来（分享/分发友好）**：

1. **显式设置** `ADMIN_KEY` / `GATEWAY_KEY` 环境变量 → 以你设置的为准（compose 场景写进 `.env` 的 `ZZCSAPI_ADMIN_KEY` / `ZZCSAPI_GATEWAY_KEY`）；
2. **没设置** → 首次启动自动生成 48 位随机密钥，**打印到容器日志**（`docker logs zzcsapi | grep ADMIN_KEY`）并写回 `config.json`（重启不变）；
3. **想换** → 环境变量优先级最高；或删掉 `config.json` 里的 `adminKey`/`gatewayKey` 后重启（会重新生成）。

只有显式开启 `ZZCSAPI_NOAUTH=1` 才完全不鉴权——否则密钥恒存在，不再有"空密钥 = 谁都能进"的洞。

## 在 DSH / Cursor / Cline 等客户端里配置

### OpenAI 协议
```
baseURL = http://127.0.0.1:8787/v1
apiKey  = <GATEWAY_KEY 的值；未显式设置时看容器日志里首启生成的那一串>
model   = <channels[*].models 里 alias，左边的键>
```

### Anthropic 协议（DSH 的 Anthropic 兼容地址）
```
baseURL = http://127.0.0.1:8787/anthropic
apiKey  = <GATEWAY_KEY>
model   = <alias>
```

> 鉴权三种写法都认：`Authorization: Bearer <GATEWAY_KEY>`、`x-api-key: <GATEWAY_KEY>`（**Anthropic SDK 的默认头**）、`?key=<GATEWAY_KEY>`。

### Gemini 协议
```
baseURL = http://127.0.0.1:8787/gemini/v1beta
apiKey  = <GATEWAY_KEY>
```

> **鉴权**：`x-goog-api-key: <GATEWAY_KEY>`（**Gemini SDK 的默认头**）、`?key=<GATEWAY_KEY>`、`Authorization: Bearer` 都行。
> **支持图片**：`parts` 里的 `inlineData`（base64）与 `fileData`（`fileUri` 直链）都会转成上游的图片块转发，
> 部件顺序保留。带图请求只走 `openai` 协议渠道（其余协议链会静默丢图，故被「图片能力门」裁掉）——
> 详见 [含图请求的候选裁剪](#含图请求的候选裁剪图片能力门)。

## Web 控制台

```
http://127.0.0.1:8787/console
```

首次打开会出一个「输入管理密钥」的小门，把 `ADMIN_KEY` 粘贴进去即可——验证通过后换回**会话 cookie**
（`HttpOnly` + `SameSite=Strict`，12 小时有效），密钥本身**不落浏览器**（JS 也读不到）；之后裸开 `/console` 乘着活会话直接进。
`v1.18.6` 起不再支持 `?key=` 带参访问（渗透报告点名"密钥进浏览器历史"）；侧栏「工具 → 密钥管理」页有「退出登录」按钮可随时清掉会话。

> 控制台 HTML 壳本身不含任何密钥（零机密），放行；**管理 API 每次调用仍强制鉴权**（活会话 cookie 或 Bearer）——"页面能开 ≠ 有权限"。
> 会话失效（过期 / 服务端换了管理密钥 / 重启）时，页面收到 401 自动重新弹门，重新粘一次即可。

可做：

- 实时看每个渠道的健康 / 延迟 / 错误 / 探测时间
- 改 priority、启停某个渠道
- 触发单渠道或全量重新探测
- 看每个协议聚合后的模型清单
- **测试停用渠道里的模型**：停用只是"不参与调度、不参与自动探测"，不代表不能手动打一发验证模型还活着。
  渠道页每行的「测试」与抽屉里的「测试模型」对停用渠道同样可用（弹窗里会标「已停用」并说明测通也不会启用它）；
  全量「测试模型」会把停用渠道排在后面一并列出。
- **测试结果每一行都写明**：**测的是哪个模型**（`模型名 @ 渠道显示名`）、结论（**通过 / 空回复 / 失败**，不只是靠颜色）、
  延迟与 token 数、以及回复原文或上游错误原文；汇总按三档分别计数。
  「HTTP 200 但回复为空」单列成**空回复**——它既不能算通过（会让人以为模型可用），也不能算失败（会让人去查网络）。

> **自动 vs 手动的边界**（v1.13 明确）：
> - **自动**（启动时 + `health.intervalSec` 定时器）：**只探启用渠道**。停用的渠道一次都不碰——不消耗它的配额，
>   也不会让探测失败把它的状态越推越烂。
> - **手动**（控制台点「测试」/「重探测」，以及 `/admin/api/test`、`/admin/api/recheck`）：不受此限。
>   带 `channelId` 的测试只打那一条渠道；不带 id 的「全部重探测」是手动动作，连停用渠道一起探（结果里带 `enabled:false` 便于区分）。
> - 代价（诚实说明）：停用渠道的模型清单 / 状态 / 延迟会**停在上次手动探测时的那一刻**，不再自动刷新。

## 前端代码文档

> ⚠️ **强制约定：改代码必须同步改文档**（无论改动来自谁）。完整规则见 [`AGENTS.md`](AGENTS.md)。

### 前端文件与构建管线

生产控制台 `console.html` **不是手写的，是构建产物**：

```
node build/build.js
```

```
console-redesign.html ──(取 <style> 原文，逐字节复制)──┐
                                                      ├─→ console.html  (提交进仓库，server.js 直接读)
build/head.html   (到 <style> 为止的 head)            │
build/shell.html  (body 骨架：rail / topbar / viewport / drawer / mask)
build/app.js      (数据层 + 动作层 + 渲染，真实请求 /admin/api/*)
build/extra.css   (设计稿没覆盖的生产独有组件，全部复用设计令牌)
```

| 文件 | 角色 |
| --- | --- |
| `console-redesign.html` | **视觉唯一真源**（高保真静态原型，单文件零依赖，不请求后端，数据来自文件内 `DATA` 快照） |
| `build/head.html` · `build/shell.html` · `build/extra.css` · `build/app.js` | 生产适配层：骨架、生产独有样式、真实数据与交互 |
| `build/build.js` | 组装脚本（构建期自检：产物中 `</style>` 唯一 + head/shell 行数守卫，锚点漂移构建期爆错） |
| `console.html` | **构建产物**，已提交进仓库。**不要手改**——下次构建会被覆盖 |

**因此：改视觉/字号/留白/圆角 → 改 `console-redesign.html` 的 `<style>` → 重新 `node build/build.js`。**
改完请确认 `console.html` 同步更新（构建是覆盖式的，忘了构建就等于没改）。

> 生产与原型**变量名完全相同**（生产直接复用设计稿 CSS），不存在映射表。
> 生产独有能力（genspark 双导入、渠道级自定义请求头、密钥掩码↔明文切换、有效优先级角标、
> 真实测试/导入/Playground 请求）原型里没有，**原型不必追平**。

改前端前请先读这两份文档：

| 文档 | 用途 |
| --- | --- |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计文档](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | **动代码前过目**：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查）、前端独立审查 |
| [同类网关内部机制对比](docs/gateway-comparison.md) | **定位与取舍参考**：本项目 vs new-api / one-api / sub2api / CLIProxyAPI 的内部机制、性能、全面性对照（只比机制，不比多用户/账户管理），含本机实测数字与各家的源码级证据 |
| [thinking 回放缓存设计稿](docs/thinking-replay-design.md) | **已验证无收益，暂不实现**：一次"先验证再动手"的完整记录——跨协议下 thinking 与签名的**保真度地图**（逐函数出处）、为什么"客户端回传无签名块触发 400"不可达、唯一会 400 的场景为何回放缓存也治不了、以及将来要重启必须先满足什么 |
| [控制台「运行期设置」页实现规格](docs/console-settings-spec.md) | **交给前端执行者的施工图**：`/admin/api/settings` 的字段契约（`config` vs `effective` 为什么都要显示）、三张卡的结构与文案要点、必须守住的交互细节（只提交有改动的组、跨轮询保留输入、400 原文要显示）、要改哪些文件与 AGENTS 强制同步清单、可逐条执行的验收清单 |

改完前端跑一遍自动化回归（零依赖，一条命令）：

```bash
node test/console-state.test.js           # 172 项断言，退出码非 0 = 有回归（含渠道表单权重：能填 → 能存 → 能显示；自动权重观测页渲染；停用渠道的手动测试弹窗；测试结果行：模型名 + 通过/空回复/失败三档；调用日志渠道列：显示渠道名不显示 id、紧跟请求 ID、按名字/按 id 都能搜；运行期设置页：草稿跨轮询保留、POST 只发改动组、400 原文直显；密钥管理页：掩码可见、草稿跨轮询、轮换、**会话语义（密钥不落任何浏览器存储）**）
node test/gemini-multimodal.test.js       # 41 项断言：图片转换 / 候选裁剪 / 原生 SDK 鉴权头（单元级）
node test/gemini-multimodal-e2e.test.js   # 22 项断言：真起「假上游 + 临时网关」，走完整 HTTP 链路（约 5 秒）
node test/anthropic-tools.test.js         # 60 项断言：Anthropic tool_use ↔ OpenAI tool_calls（含工具结果带图、id 往返、有状态流式）
node test/anthropic-tools-e2e.test.js     # 30 项断言：两轮工具回合（要工具 → 回传结果）真 HTTP 链路
node test/streaming-e2e.test.js           # 19 项断言：三协议流式（首块不丢字节 / 事件序列 / 收尾兜底）
node test/weighted-rr.test.js             # 31 项断言：加权轮询算法（3:1→75/25、平滑性、老配置零影响对照）
node test/weighted-rr-e2e.test.js         # 12 项断言：真 HTTP 数落点，验证实际分流比例与降级行为
node test/native-channels.test.js         # 78 项断言：原生出站双向转换（请求/响应/流式状态机/URL 鉴权头/错误体不翻译）
node test/native-channels-e2e.test.js     # 33 项断言：原生假上游 × 三条客户端路由，验证上游真的收到原生报文
node test/console-weight-e2e.test.js      # 18 项断言：控制台表单报文 → 真网关落库 → 真流量分流 → 表格那一格显示出来
node test/auto-weight.test.js             # 66 项断言：自动权重算法（健康系数/地板/死区平滑/份额封顶）＋**静默不变式**（观测不许改分流）＋后台节拍装配守卫
node test/auto-weight-e2e.test.js         # 37 项断言：真流量下预测与健康系数自洽、分流一字未动、配置往返旋钮不丢、后台节拍不依赖控制台
node test/upstream-4xx-fallback-e2e.test.js  # 32 项断言：上游 4xx 不许短路兜底（404/400 都继续切、最后一家才透传、冷却位不算后手）
node test/per-channel-retry-e2e.test.js   # 34 项断言：同渠道重试（抖动被原地救回、4xx 绝不重试、0/缺省=不重试、上限钳到 5）
node test/cooldown-grading-e2e.test.js    # 53 项断言：熔断分级（瞬时/凭证/限流三条曲线 + Retry-After + 探测半愈合 + 观察期排序）
node test/gemini-tools.test.js            # 44 项断言：Gemini 客户端路由的工具转换（functionCall⇄tool_calls、id 配对与无状态退路、toolConfig 三态、流式分片攒整、仿真链兼容）
node test/gemini-tools-e2e.test.js        # 29 项断言：真起「假上游 + 临时网关」走 /gemini/... 两轮工具回合（含流式与三种 toolConfig）
node test/same-protocol-passthrough.test.js # 43 项断言：同协议直通（Anthropic/Gemini 客户端 → 同协议渠道不翻译；thinking/cache_control/seed 原样到达、响应逐字节一致、真实 token 仍记录、跨协议仍走转换）
node test/workbuddy-quota.test.js      # 39 项断言：WorkBuddy 额度用尽要看得懂（trim 后再判 JSON、重置时刻→精确冷却、错误带 HTTP 码与响应开头、密文 token 提前拦、冷却跳过也带原因）
node test/genspark-tools.test.js          # 47 项断言：Genspark 网页会话反代的工具调用（system 折叠 + [TOOL_CALL] 仿真往返 + 真网关经假代理跑完整链路）
node test/disabled-channel-manual-test-e2e.test.js  # 26 项断言：停用渠道「能手动测、不被自动测」（自动探测 0 次 / 手动测试真打通 / 手动重探测照探）
node test/outbound-http-client.test.js    # 32 项断言：出站长连接客户端（fetch 形状真值表 + 20 次请求 0 条新连接、对照 agent:false 建 20 条）+ 直通流式逐字节一致（含 CRLF 与跨片帧）
node test/session-affinity-e2e.test.js    # 67 项断言：会话粘性（键推导真值表 + 过期/淘汰 + 冷却/down 不硬塞 + 同会话 8 次落同一家 + 上游挂了重新粘 + 关闭时零状态）
node test/rate-limit-e2e.test.js          # 50 项断言：客户端限流（令牌桶真值表 + 429 带 Retry-After + 按时间回填 + 并发闸门 + 管理面不受影响 + 关闭时零影响）
node test/metrics-e2e.test.js             # 44 项断言：/metrics（Prometheus 格式合法性 + 标签转义 + 计数随真流量动 + 密钥绝不出现在正文 + public/关闭两态）
node test/thinking-fidelity.test.js        # 36 项断言：thinking/签名 保真度地图（网关从不向客户端产出 thinking 块 → "无签名块触发 400"不可达；直通是签名唯一活路）
node test/settings-api-e2e.test.js        # 58 项断言：运行期设置端点（窄口白名单 + 钳制与启动路径共用同一份规则 + 改完不重启立即生效（真发请求看到 429/404）+ 落库并重启后仍在 + 400 点名字段）
node test/security-headers-e2e.test.js    # 51 项断言：安全加固（渲染层"裸插值"必须一个不剩 + toast/data-t 必须转义 + 安全响应头覆盖 401/404/静态壳/所有 API + 管理面与 /healthz 带 no-store + 页面壳零密钥明文 + **CSP 逐字等于设计稿（v1.18.6）** + 管理面 ?key= 已停用 / 客户端面保留）
node test/key-rotation-e2e.test.js         # 85 项断言：控制台轮换密钥（优先级链 config.auth>env>首启生成 + 旧密钥立即失效 + 非法值不落库 + 重启后仍生效 + 回到环境变量值）
node test/admin-session-e2e.test.js        # 63 项断言：管理面会话 cookie（v1.18.6）——登录门换 HttpOnly+SameSite=Strict 会话、会话单独鉴权管理面、Bearer 通道保留、管理面 ?key= 拆除 / 客户端面保留、退出只杀自己、轮换清全会话并补发新会话、重启全部掉线、逐出先清过期
```

它守住的是**「视口内输入控件的值必须跨重绘保留」**这条约定：控制台每 8 秒轮询一次，
`render()` 会重建当前页整个 DOM，输入控件的值只存在 DOM 里就会被重建为空
（表现：搜索词/草稿"一会儿自己没了"，PT22 / detailed §8.11）。
做法是从 `build/app.js` 现抠真实的渲染函数源码，在最小 DOM 桩里跑「输入 → 再渲染」并断言值仍在；
**新增带输入框的页面时请顺手补一条用例**（改名 `vModels` 等函数会让它报错，这是刻意的提醒）。

`test/gemini-multimodal.test.js` 守的是**「图片不能在翻译层被静默丢掉」**：它从 `server.js` 现抠
`geminiToOpenAI` / `bodyHasImages` / `filterCandidatesForImages` / `checkAuth` 的真实源码跑断言（也是零依赖，
两个协议命名变体、部件顺序、纯文本回退形态、能力门裁剪、原生 SDK 鉴权头与"管理面无提权"都在内）。

`test/gemini-multimodal-e2e.test.js` 是它的**端到端姊妹**：真起一个假上游 + 临时网关实例（**动态空闲端口**，
配置与用量写在系统临时目录，**绝不碰仓库里的 `config.json` / `usage.json`**，不出网、不烧额度），
验证客户端协议 → 网关 → 上游的实际字节与响应形态。单元级测试覆盖不到「函数都在、就是接头不对」的缺陷——
PT23（非流式 shim 缺 `json()`）就是被这个脚本一次性抓到的。


## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },   // perChannel = 同一家失败后原地再试几次
                                                             //   （只对 5xx/超时/网络错误；0/缺省 = 不重试，上限 5）
  "channels": [
    {
      "id": "vendor-a-openai",
      "name": "中转A (OpenAI)",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "protocol": "openai",                  // openai | anthropic | gemini
      "priority": 10,                        // 顺序：谁先试、谁兜底
      "weight": 3,                           // 分流：同模型候选里按比例轮询（不填/0 = 不参与，见「加权轮询」）
      "enabled": true,
      "proxy": "http://host.docker.internal:7897",  // 可选：HTTP 代理（见下方说明），留空/删掉 = 直连
      "models": {                            // alias -> upstream
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini"
      }
    },
    {
      "id": "vendor-anthropic",
      "name": "Anthropic 中转",
      "baseUrl": "https://api.example-c.com",
      "apiKey": "sk-ant-xxx",
      "protocol": "anthropic",
      "priority": 10,
      "models": {
        "claude-3-5-sonnet": "claude-3-5-sonnet-20241022"
      }
    },
    {
      "id": "vendor-gemini",
      "name": "Gemini 中转",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza-xxx",
      "protocol": "gemini",
      "priority": 10,
      "models": {
        "gemini-1.5-pro": "gemini-1.5-pro-latest"
      }
    }
  ]
}
```

> **渠道字段 `proxy`（可选）**：HTTP 代理地址（如 `http://host.docker.internal:7897`，容器经宿主机代理出网）。
> 对 `openai / anthropic / gemini / workbuddy / codex / genspark` 协议生效——**探测、测试、聊天全部经代理转发**（curl `-x` 子进程，undici fetch 不走代理）。
> 注意两点：流式响应经代理会**整体缓冲后一次性回放**（首字节延迟 ≈ 上游总耗时，与 CF 回退同款语义）；代理挂了渠道探测即失败、进冷却（诚实失败，不静默直连）。
> `notion` / `notion-agent` 不支持代理（官方 API 直连）。

### 协议说明

| protocol       | 探活 URL                  | 鉴权头              | 出站报文（网关发给上游）              | 网关对外路径                          |
| -------------- | ------------------------- | ------------------- | ------------------------------------- | ------------------------------------- |
| `openai`       | `GET /models`             | `Authorization: Bearer ...` | OpenAI 格式，原样转发          | `/v1/chat/completions` 之类     |
| `anthropic`    | `GET /v1/models`          | `x-api-key: ...` + `anthropic-version` | **原生 Anthropic 格式**：`POST /v1/messages` | `/anthropic/v1/messages`              |
| `gemini`       | `GET /v1beta/models`      | `x-goog-api-key: ...` | **原生 Gemini 格式**：`POST /v1beta/models/{model}:generateContent` | `/gemini/v1beta/models/{m}:{action}` |
| `notion`       | `POST getSpaces`          | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query`  | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） | Notion 官方 Agent API（公开 beta） |
| `arena`        | —                        | —                    | **已撤**：Arena.ai 逆向已整体移除（见 docs/arena-protocol.md 留档）  | **已撤**：Arena.ai 逆向已整体移除（见 docs/arena-protocol.md 留档）  |
| `workbuddy`    | 自检 `chat/completions`   | `Authorization: Bearer ...` | WorkBuddy 逆向（**必须走 curl 子进程**：上游对 Node/undici 的 TLS 指纹直接 ECONNRESET；token 是 JWT，新版 CodeBuddy 已把它加密，见下） | WorkBuddy 逆向（同上） |
| `codex`        | 一次令牌刷新             | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） |
| `genspark`     | `GET /api/is_login`      | `Cookie: session_id=...` | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期；**工具调用靠文本仿真**，上游会忽略原生 `tools`） | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期） |

#### 原生出站：`anthropic` / `gemini` 协议渠道可以直接聊天了

`protocol` 现在**同时决定出站报文格式**。以前它只管探活方式和对外路由，出站一律 OpenAI 格式 —— 于是「声明成 anthropic 协议的渠道」拿去敲 `/v1/messages` 必然 400，等于配了也用不了（Gemini 同理）。

现在两条方向都通了，**客户端说哪套协议、渠道讲哪套协议，互不绑定**：

| 客户端来的协议 | 渠道是 `openai` | 渠道是 `anthropic` | 渠道是 `gemini` |
| --- | --- | --- | --- |
| OpenAI（`/v1/chat/completions`） | 直通 | 转原生 `/v1/messages` | 转原生 `:generateContent` |
| Anthropic（`/anthropic/v1/messages`） | 转 OpenAI 出站 | **同协议直通（v1.15，不翻译）** | 转原生 Gemini 出站 |
| Gemini（`/gemini/v1beta/...`） | 转 OpenAI 出站 | 转原生 Anthropic 出站 | **同协议直通（v1.15，不翻译）**；流式 `:streamGenerateContent?alt=sse` |

**同协议直通（v1.15）**：客户端协议与渠道协议相同的两个格子**一次翻译都不做**——出站用客户端原始报文
（Anthropic 只把 `model` 换成渠道的上游名；Gemini 的模型名本来就在 URL 路径里），响应（含流式 SSE 字节）
原样回传。省掉"客户端 → 内部 OpenAI → 原生"来回两趟，也就省掉了两处**有损点**：

- 内部 OpenAI 格式承载不了的字段，以前会在进、出两个方向上被静默丢掉：`thinking`（含 `budget_tokens`、
  `signature`）、`cache_control`、`top_k`、`metadata`、**多段 system**、`stop_sequences` 细节、
  `generationConfig.seed` / `thinkingConfig`、`safetySettings` …… 直通后原样到达上游、原样回到客户端。
- 回程不再被重排：`message_start` 不再是网关"补"出来的（上游那一个原样过去），也不会多出原生协议里
  根本没有的 `[DONE]`；`event: …` 行与分隔空行逐字节一致。

代价（诚实说）：入站那层"顺手的清洗"也不再执行——内部格式才需要的工具 id 清洗、参数方言修正都不做，
上游报什么错就透什么错；**图片能力门仍在选路阶段生效**（候选过滤用的是同一份转换结果，没有被绕过）。
只有"客户端协议 === 渠道协议"时才直通，跨协议照旧走转换（见下表与 §协议翻译）。

### 出站与流式写路径（v1.16：两处实测出来的开销）

这一版没有加功能，只把两处「自找的开销」修掉，数字都是本机实测（回环、同机、客户端用 keep-alive）：

| | 改前 | 改后 |
| --- | --- | --- |
| 出站客户端 | Node 全局 `fetch`（undici）：容器内每跳 1.28ms vs `http.request` 0.54ms；并发 32 吞吐只有直连的 44%；**Windows 开发机上每请求 +13ms** | 自带 `http/https` + keep-alive Agent 的 `zzFetch`（`maxSockets: 128`） |
| 网关净增延迟（非流式，Windows） | +13.9 ms | **+0.93 ms** |
| 网关净增延迟（非流式，容器内 Linux） | 1.28 ms/跳（出站那一跳） | **+1.06 ms**（含网关自身 JSON/调度/记账的开销） |
| 非流式吞吐（并发 32，Windows） | 950 req/s（直连 2983，32%） | **1814 req/s（直连 3135，58%）** |
| 流式首字节净增（10 片 × 25ms，Windows） | +13.6 ms | **+1.44 ms** |
| 块间隔抖动净增 | +10.95 ms | **+0.03 ms** |
| 客户端收到的 TCP 写次数（上游 10 片） | 24 次（每帧被拆成"数据行 + 空行"两次写） | **11 次（与上游分帧对齐）** |
| 直通流式字节一致 | 逐行重组：`CRLF` 被归一成 `LF` | **原始字节直转：CRLF / 分帧边界 / 空行全部逐字节一致** |

- **出站**：`zzFetch(url, {method, headers, body, signal})` 接口与 `fetch` 一致（`status`/`ok`/`headers.get`/
  `text()`可重复调用/`json()`/`body.getReader()`/`AbortError`），redirect 跟随、`Content-Encoding` 解压
  语义都按 `fetch` 对齐，所以**调用点零改动**；`notion` / `notion-agent` 模块拿到的也是它。
  安全网：没有 `signal` 时留 300s 兜底，避免连接阶段永久挂住。
- **直通**：流式改为把上游字节直接写回客户端，另起一条旁路只做 usage 扫描与 token 估算——
  所以"字节一个不改"和"真实 token 照记"同时成立（见 `test/outbound-http-client.test.js`）。
- **非直通**：一次 drain 里的所有输出合并成一次 `write`（旧的逐行写让 SSE 每帧变成两次写）。
- 代价（诚实说）：`identity` 编码意味着上游若无视它硬塞压缩体，解压由我们做（已覆盖 gzip/deflate/br）；
  连接池上限 128（旧 `fetch` 没有这个上限，但它也不复用连接）。
- 同类项目的机制对照与取舍，见 [`docs/gateway-comparison.md`](docs/gateway-comparison.md)。

### 健康度参与调度之后的四件事（v1.17：会话粘性 / 客户端限流 / `/metrics`）

这三项都是**默认关闭**的增量开关（`/metrics` 默认开、但要 key），不开就与老版本逐字节一致。
它们补齐的是此前对比里唯一还站得住的差距：上游缓存复用、客户端面保护、可观测性。

**① 会话粘性（`sessionAffinity`）**——同一条会话尽量落在同一个上游渠道，让上游侧能复用提示缓存 /
KV cache，订阅类渠道也不会因为来回换家反复触发风控。

```json
"sessionAffinity": { "enabled": true, "ttlSec": 3600, "maxEntries": 2000, "deriveFromBody": false }
```

- 会话键按优先级取：**显式头** `X-Session-Id` / `X-Claude-Code-Session-Id` / `X-Conversation-Id` / `X-ZZCSAPI-Session`（≥8 字符）→ **正文标识** `prompt_cache_key` / `session_id` / `conversation_id` → 可选（`deriveFromBody`）"系统提示 + 首条用户消息"的稳定哈希。全都取不到就是**无粘性**，退回原来的调度。
- 刻意**不认** Anthropic 的 `metadata.user_id`：Claude Code 带的是**账号级** id，拿它做粘性等于把整个账号钉死在一家（那是把加权轮询关掉，不是会话粘性）。
- 刻意把 `deriveFromBody` 默认设为 `false`：正文哈希会让**相同提示的不同请求**互相抢占同一家。
- 边界（这是它没有变成"偷偷绕过加权轮询"的原因）：只改**谁是第一位**；粘住的那家不在候选里、在冷却里、或已 `down` 时**一动不动**（不硬塞、也不清冷却）；粘性命中**不消耗** SWRR 状态、不记 `weightedHits`——所以"落点 100% 集中在一家、份额统计仍报 50/50"是正常现象（`session-affinity-e2e` 专门断言了这一点）。
- 上游挂掉时照常切换，并在**成功的那家**上重新粘住（不会在两家之间反复横跳）。

**② 客户端限流（`rateLimit`）**——给客户端面整机速率与并发上限，超限回 `429` + `Retry-After`，别让上游额度先被烧完。

```json
"rateLimit": { "enabled": true, "rpm": 120, "burst": 0, "maxConcurrent": 8 }
```

- 令牌桶按**整机**算（单点自用定位；按客户端分桶要有稳定标识才有意义）；`burst` 不填时桶容量 = `rpm`（允许"一分钟的量一次性打完"）；`rpm:0` / `maxConcurrent:0` 各自表示不限。
- 计数在**鉴权之前**：连"刷鉴权"的流量也被挡在门外（代价：不带密钥的请求也占额度——宁可挡在门口，也不让无效流量穿到候选链上）。
- 只装在客户端面（`/v1/*`、`/anthropic/*`、`/gemini/*`）：`/healthz`、管理面、`/metrics` 不受影响。
- 并发额度在响应 `finish` **与** `close` 两条路归还（客户端中途断开也不会漏名额），归还幂等。

**③ `/metrics`（Prometheus 文本格式，零依赖）**

- 默认要 admin key（`Authorization: Bearer <ADMIN_KEY>`）；放进 Prometheus 抓取就配 `"metrics": { "public": true }`（此时匿名可抓，正文里依然**没有任何密钥**——有专门断言守着）。
- 指标：`zzcsapi_requests_total{route,status}`、`zzcsapi_channel_requests_total{channel,ok}`、`zzcsapi_channel_tokens_total{channel,direction}`、`zzcsapi_channel_latency_ms_{sum,count}`、`zzcsapi_channels{state}`（ok/down/cooldown/probation/disabled 五档）、`zzcsapi_affinity_entries` 与 `zzcsapi_affinity_events_total`、`zzcsapi_rate_limit_events_total`、`zzcsapi_inflight_requests`、`zzcsapi_uptime_seconds`、`zzcsapi_process_resident_memory_bytes`、`zzcsapi_swrr_hits_total`。
- 渠道标签用**渠道 id**（控制台里显示的是 name）；token/耗时来自 `recordUsage`，与用量统计**同一处收口**，不会出现"指标好看、用量难看"的分叉。
- 诚实边界：这是**进程内**计数（重启清零，不是持久化时间序列）；单机自用够用，要长期趋势请让 Prometheus 去拉。

> **这三个开关怎么改（v1.18）**：容器里直接改 `config.json` 仍然可以（`/admin/api/status` 里能看到生效后的实时状态：
> `affinity` / `rateLimit` / `metrics` 三段）；v1.18 起还可以**运行期改、立即生效、立即落库**——`GET/POST /admin/api/settings`
> （窄口：只认这三组，字段白名单 + 严格类型，写错字段名/类型一律 400 并点名字段）。
> 控制台页面按 [`docs/console-settings-spec.md`](docs/console-settings-spec.md) 的规格实现（该规格已交付前端侧，后端契约已冻结并有测试守着）。
> 会话粘性、客户端限流的**设计边界与验收标准**写在测试里（`test/session-affinity-e2e.test.js` / `test/rate-limit-e2e.test.js`），改调度或网关入口时请先跑它们。


- **怎么配**：`"protocol": "anthropic"` + `baseUrl`（如 `https://api.anthropic.com`，写不写 `/v1` 都认）+ `apiKey`；Gemini 填 `https://generativelanguage.googleapis.com`（`/v1`、`/v1beta` 都认）。模型行照旧：alias 是**客户端请求的名字**，上游是**真实模型名**（Gemini 会拼进 URL 路径）。
- **客户端路由的四个往返方向都完整支持工具调用**（v1.12 补齐 Gemini 这条入站方向，见 PT33）：
  | 客户端路由 | 工具调用（出站/入站） | `tool_choice` 三态 | 工具结果的配对方式 |
  | --- | --- | --- | --- |
  | `/v1/chat/completions` | OpenAI `tool_calls` ⇄ 原样 | 完整 | `tool_call_id` |
  | `/anthropic/v1/messages` | `tool_use` ⇄ `tool_calls` | `none` 表达不了（去掉 tools） | `tool_use_id` |
  | `/gemini/v1beta/...` | `functionCall` ⇄ `tool_calls` | `AUTO`/`ANY`/`NONE` 全支持 | **按函数名配对**（id 由网关合成，见下） |

  Gemini 这条路的两个细节（都与"Gemini 认函数名不认 id"有关）：
  - `functionCall` / `functionResponse` 进站后转成真的 `assistant.tool_calls` / `role:"tool"` 报文，网关替它合成
    `call_g<n>_<name>` 形状的 id，并用**同名 FIFO 队列**把 `functionResponse` 配回正确的调用（同一轮里同一函数调两次也对得上）；
  - 客户端若**只回结果、不带上文的 functionCall**（无状态用法），网关**不会**硬造 `tool_call_id` —— 那会让上游因
    "有 tool 消息却没有配对的 `assistant.tool_calls`"直接 400。这种情况退回为一段可读文本，结果照样进上下文。
  - 有损点：`ANY` + 多个 `allowedFunctionNames` 在 OpenAI 侧只有"强制某一个"，因此会**同时把工具集收窄到白名单**、
    `tool_choice` 退化为 `required`（方向一致，但不是逐字等价）。
- **转发什么**：`system/developer` → 顶层 `system`（Anthropic）/ `systemInstruction`（Gemini）；`tool_calls` ⇄ `tool_use`（Anthropic）/ `functionCall`（Gemini）；工具结果 → `tool_result` / `functionResponse`（Gemini 按**函数名**配对，自动从上一轮工具调用里查）；图片 → `image` 块（base64/url）/ `inlineData`、`fileData`；`max_tokens`→`max_output_tokens`/`maxOutputTokens`；`stop`→`stop_sequences`/`stopSequences`；流式 → Anthropic 事件 / `alt=sse`。
- **上游报错照样原样返回**：错误体（如 `{"type":"error",...}`）不做翻译 —— 否则 400 会被伪装成"成功但空"的 200，最难查。
- **有损的地方（诚实说明）**：`tool_choice: "none"` 在 Anthropic 侧表达不了（保留 tools 就等于 auto，因此**直接去掉 tools**）；Anthropic 的 `cache_control`、`top_k`、thinking 签名在跨到内部 OpenAI 格式时会丢；`tool_use.id` 会被清洗成合法字符。原生渠道与客户端同为 Anthropic 时也走这一遍转换（不做同协议直通）。
- **调度顺序**：三种协议**同协议优先、跨协议在后**（`openai` 渠道仍然先被选中），原生协议渠道作为候选链尾部一层兜底，不影响你现有 `openai` 渠道的先后顺序。

> 中转渠道如果用 OpenAI 兼容但 `protocol` 想挂到 Anthropic 端点用，把 `protocol` 设成 `anthropic` 即可——网关会把请求体自动转成 OpenAI 格式丢给它，再把响应转回 Anthropic 格式。同理 Gemini。

#### notion-agent（Notion 官方 Agent API）

调用 Notion 工作区的 Custom Agent（需要 Business/Enterprise 版工作区，在 Notion 网页聊天侧栏创建代理）。

- **Base URL**：`https://api.notion.com`
- **API Key**：**集成令牌**（开发者门户 → 我的集成 → 复制内部令牌 `ntn_...`），且集成的能力必须勾选「**查看会话并与代理交互**」（测试版）
- ⚠️ **个人访问令牌（PAT）不行**：PAT 能列代理、能建会话，但执行时会被服务端直接拒绝（`session_failed`，零 credits 消耗）——这是令牌能力限制，不是配置错误
- **模型行**：alias 填对外模型名（如 `gpt-6-astra`），上游填**智能体名称**（如 `Magnificent Pioneer`）；一个智能体锁定一个模型，多个模型就建多个代理
- 会话中智能体的确认门（requires_action）自动批准（最多 5 次）
- 每次对话消耗工作区 AI credits，因此 notion-agent 渠道排在调度兜底链**最后**，仅当 openai/notion 渠道都失败时才启用

#### workbuddy（WorkBuddy 逆向，CodeBuddy 桌面端）

把 CodeBuddy/WorkBuddy 桌面端登录后的 Bearer JWT 当渠道用（`deepseek-v4.1-flash` 这类免费模型）。

- **Base URL**：`https://www.workbuddy.ai/v2`；**API Key**：`auth.accessToken` 的 **JWT**（`ey` 开头、三段点分；**别填 refreshToken**）
- **必须走 curl 子进程**：该上游对 Node/undici 的 TLS 指纹直接 `ECONNRESET`（Win Schannel / Linux OpenSSL 可过）
- **探活**：`/v2` 没有 `/models`（404），探测 = 一次真实轻量聊天（`max_tokens:1`，读到第一个 SSE 分片即判活）——所以成功探测本身就是"真凭实据"，可满血
- ⚠️ **auth 文件里的 token 已被加密（v1.14.1 起明确提示）**：新版 CodeBuddy 存的是
  `{"$wbEncrypted":1,"envelope":{"suite":1,"keyId":…,"nonce":…,"authTag":…,"ciphertext":…}}` —— **AES-GCM 密文，不是 JWT**，
  复制粘贴一定失败。网关会**在发请求前**就拦下并说明原因（不浪费一次往返、也不误记一次失败）。
  需要明文 JWT 时只能从客户端**实际请求**里取一份（`Authorization: Bearer eyJ…`）。
- ⚠️ **额度/频率用尽（HTTP 429 `code:6004`）不是渠道故障**：上游文案里直接写了重置时刻
  （`… your usage will reset at 2026-09-28 10:00:39 UTC+8 …`）。网关会：
  1. 按 `rate_limit` 记账（不把渠道冤枉成 `down`），并把 **冷却期精确对齐到那个重置时刻**
     （而不是按曲线猜个 1 小时——那会在额度早已回血后继续空等，或提早去撞墙）；
  2. 探测/测试的错误信息**原样带出上游文案**——早期版本会把它吞成一句
     `✗ workbuddy: non-SSE response`（JSON 判定漏了 `trim`，响应体以换行开头就误判），这正是"看不出为什么"的元凶；
  3. 上游说"可以换别的模型"：多配几个别名（`models` 里多写几条）就能在某个模型被限时切到另一个。
- 上游返回 HTML（CF 挑战页/代理错误页）时，错误信息会带上 **HTTP 码 + 响应开头**，不再是不可解释的 `non-SSE response`

#### genspark（Genspark 网页会话反代）

把 Genspark 网页版的登录态当渠道用，走 `llm_proxy` 免费额度（详细逆向过程见 [`docs/genspark-claw-reverse-proxy-research.md`](docs/genspark-claw-reverse-proxy-research.md)）。

- **Base URL**：`https://www.genspark.ai`
- **API Key**：网页会话的 `session_id`（不是 JSON 里的 `gsk-` apiKey）。服务端会补全成 `session_id=…; agree_terms=1; gslogin=1`
- **代理必填**：容器经宿主机代理出网（如 `http://host.docker.internal:7897`），否则过不了地区门
- **探活**：`GET /api/is_login`，**免费、不消耗 credit**；网页端没有 models 接口，模型清单来自渠道别名配置
- **导入**：控制台「导入 genspark」（粘贴 session.enc JSON / 整段 cookie / 裸 session_id）或「导入 genspark JSON」（多选文件批量）→ `POST /admin/api/genspark-import`
  - `mode:'replace'`（默认）：覆盖首个 genspark 渠道的 key
  - `mode:'add'`：**一个会话建一个渠道**（多号 = 多份每日积分）；key 已存在则视为刷新
- ⚠️ **session 约 20 天过期**，过期后网页端重新登录、再导一份即可
- 请求头伪装：`User-Agent` / `Origin` / `Referer` / `request-id` / `traceparent`，SSE 聚合后再分发
- **工具调用（v1.14 起可用，走文本仿真）**：该上游**静默忽略**原生 `tools` 参数（genspark2api 实测），
  所以网关自己把工具协议"写进对话"：
  1. 请求侧把 `tools` 定义 + 调用格式注入消息（`toolEmu`），历史里的 `tool_calls` / 工具结果渲染成文本；
     网页会话只认 `user` / `assistant` 两种角色，因此 `system`（包括仿真协议本身）会**折进第一条 user** ——
     否则协议根本到不了模型；
  2. 响应侧把回复里的 `[TOOL_CALL]{…}[/TOOL_CALL]` 解析回**真的** `tool_calls`（`finish_reason: "tool_calls"`），
     流式与非流式都发；解析不出来就照旧当纯文本，不会把普通回复吃掉。
  - 有损点（诚实说明）：这是**提示词级仿真**，靠模型自觉按格式输出 —— 模型不听话时不产生工具调用（但也不会报错，
    文字照常返回）；`tool_choice: "none"` 不会注入协议；上游侧看不到原生 `tools` 字段（塞了也是噪音，不塞）。
  - 同套路还用在 `notion` / `notion-agent` 两条链上（它们的上游同样不认原生 `tools`）。
  - **真机实测（v1.14 部署后）**：真实 Genspark 会话（渠道别名指向 Genspark 网页版模型），
    `tool_choice:"required"` 非流式 → 客户端收到 `tool_calls`（`get_weather` + `{"city":"北京"}`，`finish_reason:"tool_calls"`）；
    `tool_choice:"auto"` 流式 → SSE 里也是 `tool_calls` 分片 + `finish_reason:"tool_calls"`。
    也有过"模型先反问城市、没吐标记"的样本（`auto` 下偶发）——这正是上面那条有损点，多试一次或改用 `required` 即可。

## 调度顺序

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias
   · **协议匹配 = 同协议优先，跨协议兜底**：三条客户端路由都能用 `openai` / `anthropic` / `gemini` 三种协议的渠道
     （出站自动转原生格式，见「原生出站」），但**先在同协议的渠道里选**，同协议没有/都失败才用另外两种协议，
     最后才是 notion → notion-agent → workbuddy → genspark → codex 这些文本链兜底。
     你现有的 `openai` 渠道先后顺序因此**完全不受影响**（原生协议渠道只是候选链尾部多出来的一层）。
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数第二；`probation`（探测半愈合过、欠账还在）→ 排在健康渠道之后；同状态按**有效优先级**降序，再看 latency
4. **加权轮询**：填了 `weight` 的渠道按权重比例决定"谁排第一"（见下）
5. **会话粘性**（`sessionAffinity.enabled`，v1.17，默认关）：带会话标识的请求，若这条会话上次成功落在候选链里的某家、
   且那家还能上场（不在冷却、不是 `down`），就把**它**提到第一位——覆盖上面第 4 步的结果。
   它只改"谁是第一位"，其余候选顺序、冷却判断、兜底链一律不动；命中的请求**不消耗** SWRR 状态
   （所以"落点集中在一家、份额统计仍是 50/50"是设计如此，不是 bug）
6. **含图请求**先按「图片能力门」裁剪候选（见下）；纯文本请求不受影响
7. 依次尝试直到成功；全部失败返回 502 + 错误详情
8. **同渠道重试**（`retries.perChannel`，v1.9.3 起真正接线）：对**同一家**失败后原地再试几次，
   试满才换下一家。只重试"可重试的失败"（5xx / 网络错误 / 超时），4xx 一律不重试——重发同一个
   请求只会再收一次同样的拒绝，其中不少还是客户端自己的参数错。每次尝试**各记一次失败**
   （`consecutiveFail` 与指数退避按真实尝试次数增长），重试成功则照常清零。
   配置里没写这个键时是 `0`（不重试 = 与接线前行为一致）；上限钳到 5，怕写错数字把上游调用量放大十倍。

### 同渠道重试（`retries.perChannel`）

| 值 | 含义 |
| --- | --- |
| 缺省 / `0` | 不重试：第一次失败就换下一候选（v1.9.3 以前的唯一行为） |
| `1` | 同一家失败后原地再试 1 次，仍失败才换下家 |
| `n` | 最多再试 n 次（`n` 被钳到 0..5） |

- 只对 5xx / 网络错误 / 超时生效；`401/402/403/404/408/429` 与其它 4xx **直接换下家**（属于渠道侧或
  客户端侧问题，原地重发没有意义）。
- 冷却（`cooldownUntil`）只影响"下一次请求选不选它"，不挡这次原地重试——重试要吃的就是瞬时抖动。
- 每次尝试都记账：`perChannel: 1` 且上游一直 502 时，该渠道一次请求里会累加 2 次失败、更快进入
  `down` 与更长的退避。502 的 `attempts` 里带 `attempt` 字段，事后能看出重试痕迹。
- 已经在向客户端写 chunk 之后的失败**不重试**（半截回复不换渠道，见「流式失败」）。

### 熔断冷却（`cooldown`，按错误类型分级）

连续失败的渠道会被挪出候选链前段（`cooldownUntil`），时长按**同一渠道连续失败次数**指数增长。
关键是**按错误类型分开**——"网络抖一下"和"key 余额耗尽"需要完全不同的耐心，混用一条曲线是旧版的根本问题：

| 类型 | 什么算 | 起步 | 封顶 |
| --- | --- | --- | --- |
| `transient` 瞬时 | 超时、5xx、网络错误 | 5 秒 | 10 分钟 |
| `credential` 凭证/额度 | 401 / 402 / 403、key 失效、余额或额度耗尽、会话失效 | 5 分钟 | 6 小时 |
| `rate_limit` 限流 | 429（或上游报文里的限流信号） | 1 分钟 | 10 分钟；上游给了 `Retry-After` 就照它等 |

- 曲线是 `起步 × 2^(n-1)`（第一次失败就是"起步"值），各自封顶。
- **连续失败 3 次** → 状态标记 `down`，排到候选链倒数第二（只在健康渠道都失败时才被撞）；
  冷却中的排最后。**健康探测成功只做"半愈合"**：失败计数**减半**、冷却放开（有资格被再试）、状态变 `degraded`
  （排在健康渠道之后，且不进加权轮询的池子）——因为探测打的是 `/models`，它证明不了"对话能成"。
  要一次**真实对话**成功才会彻底清零、恢复 `ok`。唯一的例外是 workbuddy：它的探测本身就是一次真实对话，
  成功即真凭实据，直接满血。
- `Retry-After` 目前只在**主路径**（OpenAI 兼容出站）会读到并采纳；curl 回退路径拿不到响应头，按曲线退避。
- **上游自己说了什么时候恢复就照它说**（v1.14.1）：WorkBuddy 额度用尽时文案里带
  `… reset at 2026-09-28 10:00:39 UTC+8`，网关把这个时刻解析成 `retryAfterMs`，冷却就精确停在那一刻
  （`rate_limit` 类，仍受上表封顶约束）。猜一个 1 小时会在额度早已回血后继续空等，反向的误差则是一直去撞墙。
- **全部候选都在冷却时的 503 会说明原因**（v1.14.1）：不再只回一句 `all channels in cooldown`，
  而是附上每个候选的 `channelId`、`recoverIn`（还有多久恢复）与 `reason`（最后一条失败原文），
  例如「最近一家 workbuddy 约 2 小时 0 分后恢复：usage exceeds frequency limit …」。查"为什么今天用不了"时不用再翻日志。
- **被冷却跳过的候选也带原因**（v1.14.1）：混合场景（另一家真被试过、这家在冷却）走的是 502 那一支，
  其 `attempts[]` 里冷却项同样给出「还有多久 + 最后一条失败原文」与 `recoverInMs`，而不是一句光秃秃的
  `in cooldown`——因为"几小时额度恢复"和"刚抖了一下几秒后就好"是完全不同的处置。
- **观察期（`probation`）**：探测半愈合过的渠道会带这个标记——它排在健康渠道之后、
  不进加权轮询的池子、`/admin/api/status` 每个渠道都返回该字段（控制台/脚本可判读）。一次**真实对话**成功即清除。
- 调参（写在 `config.json`，缺省即上表）：

```jsonc
"cooldown": {
  "transientBaseMs": 5000,      // 瞬时故障起步（1s..300s）
  "transientMaxMs": 600000,     // 瞬时故障封顶（5s..24h），10 分钟
  "hardBaseMs": 300000,         // 凭证/额度类起步（10s..24h），5 分钟
  "hardMaxMs": 21600000,        // 凭证/额度类封顶（1min..7d），6 小时
  "rateLimitBaseMs": 60000      // 限流起步（1s..24h），1 分钟
}
```

> 改这些值前先想清楚：**起步调太短**等于拿真流量反复撞墙（每次请求都要先等它失败）；
> **封顶调太长**则"上游已经修好了"到"网关愿意再用它"之间的窗口会很大——凭证类封顶 6 小时就是为此留的折中。
> 探测的"半愈合"是这里的活路：改完 key 的渠道不用等满 6 小时，下一个探测周期就会回到兜底位。

### 加权轮询（`weight`，真正的按比例分流）

`priority` 与 `weight` 分工不同，别混：

| 字段 | 管什么 | 语义 |
| --- | --- | --- |
| `priority` / `effPriority` | **顺序** | 谁先试、谁兜底（排序语义） |
| `weight` | **分流** | 同一模型候选里按权重比例决定谁排第一（分流语义） |

- **只有明确填了正数 `weight` 的渠道参与轮询**；不填（缺省 `0`）时行为与从前**完全一致**，老配置零影响。
  `weight: 0` 与不填等价（只做兜底，不参与分流）。
- 参与轮询的渠道来自**同一 (模型, 协议) 的候选集**，按权重比例分流：两个渠道 `3:1` ⇒ 长期 ≈ 75% / 25%。
- 算法是**平滑加权轮询**（nginx upstream 同款 smooth WRR，无随机数）：长期比例精确等于权重比，
  且**不会突发扎堆**（纯加权随机会连着命中同一个渠道）。
- 轮询只决定**谁是第一位**；其余候选保持原有「健康度 → 有效优先级 → 延迟」顺序作**兜底链**
  （如果轮到的那家正好挂了，下一个还是按老规矩顶上来）。图片生成候选（`/v1/images/generations`）同一套规则。
- 冷却中 / `status=down` / `probation`（探测半愈合过的观察期）/ `weight=0` 的渠道**不进池**，其份额自动分给健康成员；
  它恢复后也不会"补发欠账"（不出现报复性突发）。
- **与会话粘性的关系（v1.17）**：粘性命中时，轮询选出的"第一位"会被粘住的那家顶掉，但**轮询状态照旧推进**——
  所以份额统计（`weightedShare`）反映的是"轮询怎么分的"，不是"流量实际落哪"，两个数字**故意不同**
  （落点 100% 在一家、份额仍 50/50 是正常现象；`test/session-affinity-e2e.test.js` 有专门断言）。
- 状态是内存态（重启清零，无副作用）。改权重三种方式，效果一样：
  · **控制台**：渠道页 → 该渠道「编辑」→ 表单里的「权重」框（留空 = 0 = 不参与），保存即生效并持久化；
  · 直接改 `config.json` 的 `"weight": 3` 后重启；
  · `POST /admin/api/channel` 带 `{id, weight}` ⇒ **立即生效并持久化，无需重启**。
- 可观测：`/admin/api/status` 每个渠道返回 `weight`（配置值）、`weightedHits`（被选中次数）、
  `weightedShare`（占全部加权轮询命中的百分比）；控制台**渠道表格有「权重 / 分流」列**（`3 · 24%`，
  悬停看命中次数），**渠道详情抽屉**顶部另有角标。没配权重的渠道显示 `—` 而不是 `0%`
  ——`0%` 会被误读成"配了但一次都没分到"。
- 权重接受任意非负数字（整数最好懂：`3:1` 就是 75/25；小数同样按比例算）。负数、非数字在控制台表单里
  就被挡下（不会发请求），绕过前端直接调接口也会被后端拒（400）——两边校验规则一致。

### 自动权重（观测版：只算不生效）

想让"同一个模型有很多渠道都提供、有的能用有的不能用、有的快有的慢"这件事**自动**按实测表现分流，
不用手填 `weight`。v1.6 先上**观测版**：后端按真实数据算出"若启用会怎么分"，控制台看得见，
但**一行都不碰真实路由**——手工 `weight` 仍是唯一生效的份额依据，不填就是零影响。

> **为什么不直接生效**：自动权重天然有反馈回路（份额改流量 → 流量改统计 → 统计改份额），
> 先让人对着真机数据确认它算得对，再打开开关，是成本最低的顺序。
> 所以配置里的 `"enabled": true` 目前**也只是把观测数据标成"已启用"**，不会改变分流；
> 真正的生效版本会在 README 与 `effective` 字段上同时声明。

**怎么打开（观测）**：`config.json` 顶层加 `"autoWeight": { "enabled": true }` 后重启（`AUTO_W` 只在启动时读一次，
和它其它旋钮一样，改了要重启 / 重建容器）。打开后后端会**按 `updateMs` 自己走节拍**（见下），不需要你开着控制台。

> **观测数据的时间尺度（重要，别按字面理解成"一个月统计"）**：
> 健康系数只有两个来源，都是**近期窗口**、都**只存在内存里**：
> - 成功率来自 `ch.roll` —— 与「有效优先级」同一个滚动窗口，累计到 120 次后**整体减半**（旧样本指数衰减）。
>   所以它回答的是"**这家最近几十到一百次请求稳不稳**"，不是长期累计；**容器重启清零**。
> - 速度来自成功请求延迟的 EWMA（α=0.3），同样是内存态，重启清零。
>
> 换句话说：跑几天之后你看到的，仍然是"**最近**的表现"。这恰恰是它要用的信号（预告的是"如果现在生效会怎么分"），
> 但它**不会**替你记住一周前的长期稳定性；那需要 `usage.json` 的 `byChannel` 那类落盘统计，未来才可能接。

**打开观测后，判断"能不能让它生效"要看什么**：

1. `candidates[].h` 是否会**稳定下来**（不是每小时换一个样）——OLAP 抖得厉害说明死区还不够；
2. 预测份额和你**心里的预期**是否一致（哪家该多、哪家该少），特别是"慢但质量好"的那几家有没有被过度压制；
3. `samples` 够不够：低于 `minSamples`（默认 10）的渠道**只有速度项在起作用**，失败率还没资格发言——
   长尾模型上多数渠道都可能一直没样本，那些模型就别指望自动分流。
4. **从没被用过的渠道在预测里天然占便宜**：没有延迟数据 = 不因速度扣分，样本为 0 = 失败率按满分算，
   于是它的 `h` 就是 1，看起来"完美"。这不是 bug（观测无法区分"没试过"和"从没出错"），但它意味着
   **一旦生效，这些从未承载过流量的渠道会立刻开始分到份额**——它们真正的成色要等生效后头几笔请求才看得出来
   （表现差会被失败率与冷却接手）。反过来说，这也是"自动发现更好的渠道"的那一半价值。

**健康系数 `h`（0.2 ~ 1）** 由两个**已有**信号合成，不引入新统计：

| 信号 | 来源 | 作用 |
| --- | --- | --- |
| 成功率 | 滚动窗口 `ch.roll`（与「有效优先级」同一个窗口） | **主力**：`h = 1 − 失败率` |
| 速度 | 该渠道最近成功请求的延迟指数平均（EWMA） | **温和**惩罚：慢 2 倍只打到 `0.75`（默认 `latencyPenalty: 0.5`） |

**抗振荡三件套**（自动调权最怕的就是抖）：低频重算（`updateMs` 默认 30 秒）+ 指数平滑（`ewma` 0.5）+
死区（变化小于 `deadband` 10% 就不动）。另有四条护栏：

- **失败率样本不足不动**（`minSamples` 默认 10 条）：新渠道不被几次随机失败打死；
  注意**只管失败率这一项**——样本不足时该项按"满分 1"算，但**速度项仍独立生效**
  （所以一个刚上线、样本为 0 但延迟很慢的渠道，`h` 仍可能 < 1；这是刻意的，实测延迟不需要攒样本就够可信）；
- **地板**（`floor` 默认 0.2）：慢/差也不给 0——"慢"常常是长上下文模型在思考，饿死它反而丢质量；
- **单渠道上限**（`maxShare` 默认 70%）：防赢家通吃（最快的被打爆后反而更慢）。
  上限**只兜自动算出来的份额**；用户手填的 `weight` 永不封顶（手填是硬意图，护栏不该反过来压制它）；
- **冷却 / `down` 的渠道直接排除**（本来就进不了池），其份额分给健康成员。

配置项（`config.json` 顶层，全部可选，`config.example.json` 里有全量示例）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 观测开关：置 `true` 打开观测（含后台节拍，见下），**仍不改变分流** |
| `minSamples` | `10` | 滚动窗口样本少于它就**不按失败率扣分**（速度项不受此门槛约束） |
| `floor` | `0.2` | 健康系数地板 |
| `latencyPenalty` | `0.5` | 速度惩罚强度；`0` = 完全不看速度 |
| `maxShare` | `70` | 自动份额的单渠道上限（%）；手填权重不受限 |
| `updateMs` | `30000` | 健康系数重算间隔（毫秒，最小 1000）；**同时是后台节拍的周期** |
| `ewma` | `0.5` | 新值权重（指数平滑） |
| `deadband` | `0.1` | 死区（相对变化小于它就不动） |

**后台节拍**：健康系数是"一拍一算"的（指数平滑 + 死区），而它最初的触发点只有 `/admin/api/status`
——等于**没人开着控制台就没有观测数据**，`h` 会永远停在上次打开控制台那一刻的值。
`enabled: true` 时后端自己起一个 `setInterval` 按 `updateMs` 跑观测（关闭时**不建定时器**：不观测、不算、不占 CPU）。
它跑的是同一个只读观测函数，仍然一行不碰分流；`/admin/api/status` 的 `autoWeight.ticks` 是**只数后台定时器那一路**的拍数，
用来从外部证明节拍真的在跑（控制台拉 status 那一路不计入，否则这个数字就说明不了问题）。

可观测与界面：

- `/admin/api/status` 新增顶层 `autoWeight`：`enabled` / **`effective`（恒 `false`，一眼看出没生效）** /
  `knobs` / `at` / **`ticks`（后台节拍拍数）** / `models[]`。每个 `models` 条目 = 一个"被多个渠道提供的模型"：
  `candidates[]` 里给出预测份额 `share`、健康系数 `h`、基础权重 `base`、是否手填 `manual`、
  当前手工份额对照 `nowShare`、以及**判断依据**（`failRate` / `samples` / `latMs` / `speedRatio`）；
  `excluded[]` 是冷却或 down 而没参与分份额的候选；`manualOff` 表示当前压根没开加权轮询。
- 每个渠道新增 `autoH` / `autoFailRate` / `autoSamples` / `autoLatMs` / `autoSpeedRatio`。
- **控制台**：**「资源 → 自动权重」独立页**（v1.9 起从渠道页迁出）有份额预测卡，按模型列出预测份额
  （每个候选一列，列宽即份额，色带段下方直接挂渠道名与百分比；含"当前 x%"对照与被打折的原因）；
  渠道详情抽屉里有「自动权重（观测 · 只算不生效）」一节，把健康系数、样本数、失败率、延迟摊开。
  单候选模型不进卡（一个提供方谈不上分流，显示了只会是"100%"噪音）。

### 有效优先级（失败率自动降权）

同状态渠道不是死板按配置的 `priority` 排，而是按**有效优先级** `effPriority`：

```
effPriority = priority − 失败率 × 3
```

- 失败率取自**滚动窗口**（`ch.roll = {w,f}`，成功/失败各累加一次，样本 ≥ 5 才开始生效，累计 120 次后减半衰减）
- 也就是说：一个配置 `priority=10` 但近期失败率 40% 的渠道，有效优先级降为 `8.8`，会被配置 `priority=9` 的健康渠道反超
- 失败率回升时被新成功样本稀释，优先级**自动恢复**，不需要人工干预；配置值本身不被改写
- 失败计入点：主调度失败、探测失败都走 `recordUsage` → `bumpRoll`
- 控制台「渠道管理」在渠道被降权时显示 `→ 有效 X（失败率 Y%）` 角标（数据来自 `/admin/api/status` 的 `effectivePriority` / `rollFailRate` 字段）

### 含图请求的候选裁剪（图片能力门）

请求体里带图片时（内部统一格式 = OpenAI，即 `messages[].content` 数组里的 `image_url` block），候选链**只保留能原样/等价转发图片的渠道**：

```
IMAGE_CAPABLE_PROTOCOLS = ['openai', 'anthropic', 'gemini']      # server.js
```

- 三种协议各自的带图出站方式：`openai` 原样转发 `image_url`；`anthropic` 转成 `image` 块（`source.type = base64 | url`）；`gemini` 转成 `inlineData`（data URL）或 `fileData`（http 链接）。
- **为什么必须裁剪**：`notion` / `notion-agent` / `workbuddy` / `genspark` / `codex` 这几条链只把 `content` 当字符串用。把带图请求丢过去，图会被**静默丢掉、模型照样自信作答**——用户以为它看过图。这比直接失败更糟，所以宁可明确报错。
- **裁干净了怎么办**：返回 400 + `this request contains images, but no channel can forward them: only openai / anthropic / gemini protocol channels can carry images`（不是 404、不是降级重试、不是静默丢图）。
- **纯文本零影响**：`bodyHasImages()` 为假时函数原样返回同一个候选数组，排序与老行为逐字节一致。
- 三条客户端协议共用这道门：`/v1/chat/completions`、`/anthropic/v1/messages`、`/gemini/v1beta/...`（Anthropic 的 `image` block 与 Gemini 的 `inlineData`/`fileData` 都先转成内部 `image_url`，因此判定点统一）。
- 回归：`node test/gemini-multimodal.test.js`（含"含图 → 只留可转图渠道 / 纯文本 → 候选链原样"两组断言）+ `node test/native-channels-e2e.test.js`（原生化后仍带图）。

## 端点

| 路径                                | 方法 | 鉴权        | 说明                                  |
| ----------------------------------- | ---- | ----------- | ------------------------------------- |
| `/healthz`                          | GET  | 无          | 网关自身存活探针                      |
| `/console`                          | GET  | admin       | Web 控制台 HTML                       |
| `/admin/api/status`                 | GET  | admin       | 渠道详细状态（控制台用；含 `weight`/`weightedHits`/`weightedShare` 与自动权重观测 `autoWeight`、`autoH` 等字段） |
| `/admin/api/usage`                  | GET  | admin       | 用量统计（总量 / 按模型 / 按渠道 / 按天 / 近 200 条 / 24h 分布） |
| `/admin/api/usage/clear`            | POST | admin       | 清零用量统计                          |
| `/admin/api/recheck`                | POST | admin       | 立即重探测（body 可传 `{id}`）；**不带 id = 全部重探测，含停用渠道**（手动动作） |
| `/admin/api/channel`                | POST | admin       | 改渠道（`{id, priority?, enabled?, weight?}`，立即生效并持久化） |
| `/admin/api/channels`               | GET  | admin       | 渠道集合完整列表（**v1.18.4 起 `apiKey` 只下发掩码**，另给 `apiKeySet` 布尔） |
| `/admin/api/channels`               | POST | admin       | 新增 / 覆盖渠道（upsert，落库并立即探测一次）；**`apiKey` 留空 = 保持原密钥（v1.18.4）** |
| `/admin/api/channels`               | DELETE | admin     | 删除渠道（body `{id}`）               |
| `/admin/api/probe`                  | POST | admin       | 临时探测上游模型清单（不落库，控制台「获取模型」用） |
| `/admin/api/test`                   | POST | admin       | 真发一次最小 chat 请求，返回首字延迟 / 总耗时 / 错误；带 `channelId` 时**只打该渠道且不看 `enabled`**（停用渠道也能手动验证模型） |
| `/admin/api/codex-import`           | POST | admin       | 导入 codex 凭据（完整 JSON 或裸 `rt.1.` 开头 RT） |
| `/admin/api/codex-quota`            | GET  | admin       | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import`        | POST | admin       | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config`                 | GET  | admin       | 接入信息（URL / 端口 + **只给密钥掩码**与 `keysInsecure`；v1.18.4 起不再交出任何密钥原文） |
| `/admin/api/channels/{id}/key`      | GET  | admin       | **按需揭示（v1.18.4）**：取单个渠道的上游密钥原文（控制台「显示 / 复制密钥」用） |
| `/admin/api/gateway-key`            | GET  | admin       | **按需揭示（v1.18.4）**：取网关 `GATEWAY_KEY` 原文（Playground 直连 `/v1` 与接入信息卡复制用） |
| `/admin/api/admin-key`              | GET  | admin       | **按需揭示（v1.18.5）**：取管理 `ADMIN_KEY` 原文（控制台「密钥管理」页显示 / 复制用） |
| `/admin/api/keys`                   | GET  | admin       | **密钥管理（v1.18.5）**：两把密钥的**掩码 + 来源**（console/env/generated/none）+ `keysInsecure` + `rotatedAt`，绝不含明文 |
| `/admin/api/keys`                   | POST | admin       | **控制台轮换密钥（v1.18.5）**：body `{gatewayKey?, adminKey?}`，立即生效并写入 `config.json` 的 `auth` 段（**优先级高于环境变量**），**旧密钥立即失效**；新明文只在响应 `newKeys` 里回这一次 |
| `/admin/api/keys/generate`          | POST | admin       | 随机生成新密钥（48 位，大小写字母+数字+特殊字符四样齐全）：body `{target: "gateway"\|"admin"\|"both"}`（缺省 both） |
| `/admin/api/keys/reset`             | POST | admin       | 删掉 `config.json` 的 `auth` 段，回到「环境变量 → 首启生成」的取值链 |
| `/admin/api/session`                | POST | 匿名（登录门） | **控制台会话登录（v1.18.6）**：body `{key}` 交一次 `ADMIN_KEY`，换回 `HttpOnly + SameSite=Strict` 会话 cookie（12 小时）；**在 admin 鉴权闸门之前**（登录时手里还没有会话），登录失败计入 admin 失败限流（30 次/分钟） |
| `/admin/api/session`                | DELETE | 会话 cookie | **控制台退出登录（v1.18.6）**：只杀自己那枚 token + 过期 cookie（`Max-Age=0`）；其余方法 405 |
| `/admin/api/settings`               | GET/POST | admin   | **运行期设置（v1.18）**：读写 `sessionAffinity` / `rateLimit` / `metrics` 三组开关。GET 返回 `config`（用户填的原值）/ `effective`（钳制后生效值）/ `status`（实时计数）；POST 是 PATCH 语义（只带要改的组与字段），**立即生效 + 立即落库**，未知字段/类型不符一律 400 并点名字段 |
| `/metrics`                          | GET  | admin（`metrics.public:true` 时匿名） | **Prometheus 文本格式（v1.17）**：请求/渠道/令牌/耗时/熔断分档/粘性/限流/进程指标；`metrics.enabled:false` 时返回 404 |
| `/admin/status` / `/admin/recheck`  | */POST | admin    | 旧版兼容路径                          |
| `/v1/models`                        | GET  | gateway     | OpenAI 聚合模型                       |
| `/v1/chat/completions`              | POST | gateway     | OpenAI chat（支持 stream）            |
| `/v1/embeddings`                    | POST | gateway     | 透传                                  |
| `/v1/images/generations`            | POST | gateway     | OpenAI 生图（需上游渠道支持图像接口）  |
| `/v1/responses` / `/v1/completions` | POST | gateway     | 透传                                  |
| `/anthropic/v1/models`              | GET  | gateway     | Anthropic 聚合模型                    |
| `/anthropic/v1/messages`            | POST | gateway     | Anthropic Messages（支持 stream）     |
| `/gemini/v1beta/models/{m}:generateContent`        | POST | gateway | Gemini 非流式（支持 `inlineData`/`fileData` 图片） |
| `/gemini/v1beta/models/{m}:streamGenerateContent`  | POST | gateway | Gemini 流式          |

## 安全体检（只读脚本）

`node sec-audit.js` 对任意部署跑一遍只读体检，**报告里绝不回显密钥**：

```powershell
node sec-audit.js                                  # 体检本机 127.0.0.1:8787
$env:ZZ_BASE='http://1.2.3.4:8787'; node sec-audit.js   # 体检远端（不带密钥时只查匿名面）
$env:ZZ_TRY_DEFAULTS='1'; node sec-audit.js             # 额外试一下仓库里公开的示例默认密钥（判断有没有沿用默认）
# 密钥从哪来（不打印值）：
$e = docker inspect zzcsapi --format '{{range .Config.Env}}{{println .}}{{end}}'
$env:ADMIN_KEY  = ($e | Select-String '^ADMIN_KEY='   | Select -First 1).Line -replace '^ADMIN_KEY=',''
$env:GATEWAY_KEY= ($e | Select-String '^GATEWAY_KEY=' | Select -First 1).Line -replace '^GATEWAY_KEY=',''
node sec-audit.js
```

查这些：① 哪些口匿名可达（应只有 `/healthz`、`/console`）② 示例默认密钥是否仍可用 ③ 控制台版本指纹（有没有含已知修复）
④ 安全响应头 / CORS ⑤ 无密钥 / 错密钥 / 正确密钥的鉴权覆盖面 ⑥ 密钥泄露面（`/metrics`、管理面、`/console`、错误体里会不会出现网关密钥或上游 apiKey）
⑦ 路径穿越与静态文件（`config.json`、`.env`、`usage.json`、`server.js` 必须都是 404）。

**2026-10-02 本机实测结论**（v1.18.2 部署）：鉴权覆盖面完整（管理面/客户端面无密钥与错密钥均 401）、示例默认密钥被拒、
私有文件全部 404、错误体不含密钥、无 CORS。
**同日外部渗透测试（黑盒、未读源码）复核**：10 项发现中 9 项属实，已按批次整改——
**第一批（v1.18.3）已修**：无密钥/错密钥下 `/console` 可打开且全站**无任何安全响应头**（现补 `nosniff` / `X-Frame-Options: DENY` /
`Referrer-Policy: no-referrer` / `Permissions-Policy`，管理面与 `/healthz` 加 `Cache-Control: no-store`）；
控制台**渲染层转义不一致**（模型名/渠道名等裸插值 + `toast()` 把上游错误串当 HTML，构成"持有网关密钥 → 管理端脚本执行"的存储型 XSS 链，
现已统一过 `esc()`，以 `test/security-headers-e2e.test.js` 的"裸插值必须为零"守卫锁住）。
**第二批（v1.18.4）已修**：管理面**默认不再下发任何密钥原文**——`/admin/api/status` 与 `/admin/api/channels` 的 `apiKey` 只给
`maskSecret()` 掩码（另给 `apiKeySet` 布尔；本机实测 32/32 条全是掩码、查询正文里不含任何一把真密钥）；`/admin/api/config` 不再
同时交出 `ADMIN_KEY` 与 `GATEWAY_KEY`（改给掩码 + `keysInsecure` 布尔）。原文只能**按需单取**：两个新端点
`GET /admin/api/channels/{id}/key`、`GET /admin/api/gateway-key` 仍走 admin 鉴权（把"一次泄漏 = 全部密钥"降成"一次泄漏 = 一把"）。
渠道 `POST` 的 `apiKey` 改为「**留空 = 保持原密钥**」，防止控制台带着掩码回写把密钥抹掉；`checkAuth` 改 `sha256` +
`crypto.timingSafeEqual` 恒定时间比较，9 处鉴权点统一走 `authGate()`（每类每分钟最多 30 次**失败**尝试 → 429 + `Retry-After`，
成功一次即清零，窗口式不永久锁定，正密钥不受影响）。控制台相应改成"点一下才现取一次原文"。
**第三批（v1.18.6）已修**：① 补上 **CSP 响应头**（`default-src 'self'`，脚本/样式因单文件控制台开放 `'unsafe-inline'`——真正的兜底在
`connect-src 'self'`：即使 XSS 偷到会话 cookie 也发不出去；字体走 MiSans CDN 已在 `font-src` 白名单）；② **`/console?key=…` 拆除**——渗透报告点名
"密钥进浏览器历史"，v1.18.6 起管理面不再认 `?key=`（正确密钥走查询串也 401），浏览器改走**会话 cookie**（见「行为细节 · 管理面会话」）；
客户端面 `?key=` **保留**（Gemini SDK 的另一默认鉴权模式，不在整改面内）。

其余建议的处置：**刻意不做**——强制密钥长度/熵（不符合就拒绝启动）与多用户/角色/审计：本项目定位是**单用户自托管**，首启随机生成密钥、示例默认值只服务本地开发，把这两条做进来会破坏开箱即用（外部渗透测试报告的建议据此驳回，理由记在此处以免重复提）。**给公网部署者**：本项目的隐藏前提是「知道密钥的人就是管理员」——请只在可信网络或反向代理后暴露，并务必给公网入口加 TLS（会话 cookie 刻意没加 `Secure` 旗标，就是为 http 本地/局域网；公网 TLS 部署时应在反代层终止并保留 `HttpOnly`/`SameSite` 语义）。

## 行为细节

- **4xx 重试规则（v1.9.2 起收敛为一个判据）**：`401/402/403/404/408/429` 属于渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 一律切下一候选兜底；其余 4xx（`400` 参数错、`422` 等）**只在后面已经没有能上场的候选时**才原样透传给客户端，前面还有候选就照样当"这家不行"继续切。
  · 动机：渠道「声明有此模型」但上游实际没有（别名表过期 → 上游 404），或中转参数方言不同（不认 `stream_options` 等）——这类 4xx 换一家往往就能成。而网关此前**已经**给这家记了失败并置冷却，却把上游 4xx 甩给客户端并就此停手：自己认定是渠道的错，却对客户端说是客户端的错，还不兜底，逻辑自相矛盾（现象：该模型明明另有能用的候选，客户端却拿到 404）。
  · 「还有候选」只看**这轮真能上场的**（冷却中的候选不算：它这一轮不会被尝试，把它算成后手会让兜底切进空池、最后兜出个 502，把客户端本该看到的 400 弄丢）。
  · 代价：真·客户端的错（参数写错）现在会把候选链走完才回 4xx，请求更慢、上游多挨几下；相比之下"明明有能用的渠道却给客户端报错"更糟。链长仍受 `retries.maxModelFallbacks` 约束，同一家的额外重试次数受 `retries.perChannel` 约束（但 4xx 从不重试，见「同渠道重试」）。
  · 透传时用的是**最后一家**上游的错误体与状态码，客户端看到的仍是上游真实答复（不是网关伪造的 502）。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
- **协议转换**：OpenAI ↔ Anthropic ↔ Gemini 三边都走内部 OpenAI 协议中转；**出站方向也按渠道的 `protocol` 走原生格式**（见「原生出站」），所以任一客户端协议都能打到任一协议的渠道上。
- **原生出站（`protocol: anthropic` / `gemini`）**：请求侧 `system`→顶层 `system`/`systemInstruction`、`tool_calls`→`tool_use`/`functionCall`、工具结果→`tool_result`/`functionResponse`（Gemini 按函数名配对）、图片→`image` 块/`inlineData`・`fileData`、`max_tokens`→`max_output_tokens`/`maxOutputTokens`、`stop`→`stop_sequences`/`stopSequences`；响应侧反向映射（`stop_reason`→`finish_reason`、`usageMetadata`→`usage`、`thinking`→`reasoning_content`）。
  · 流式：Anthropic 原生 SSE 事件与 Gemini `alt=sse` 分片都会**逐行翻译成 OpenAI 分片**，再交给该路由既有的流式转换器；上游异常断流时由收尾逻辑补 `finish_reason` + `[DONE]`（客户端不会一直等）。
  · 上游错误体不翻译（原样透传状态码与消息），避免 400 被伪装成"成功但空"。
  · 有损点（**仅跨协议时**）：`tool_choice:"none"` 在 Anthropic 侧无对应语义（改为去掉 tools）；`cache_control`/`top_k`/thinking 签名在跨格式时丢弃。同协议（Anthropic 客户端 → Anthropic 渠道、Gemini 客户端 → Gemini 渠道）自 v1.15 起走**同协议直通**，一趟转换都没有，上面这些丢件不再发生（见前文「同协议直通（v1.15）」）。
  · **思维链（thinking）的真实边界（v1.18 核对，有测试守着）**：跨协议时**双向**都不带思维链——入站 `thinking`/`redacted_thinking` 整块丢弃，
    回程也**不向客户端产出** `thinking` 块（`server.js` 里 `signature` 出现 **0 次**：既不保存、不校验，也**绝不伪造**）。
    所以 Anthropic 客户端配 OpenAI 协议的渠道时，**看不到思维链、也不会因此报错**；想要思维链就走同协议的 Anthropic 渠道（直通，签名原样活着）。
    完整地图与"为什么不做 thinking 回放缓存"：`test/thinking-fidelity.test.js` + [`docs/thinking-replay-design.md`](docs/thinking-replay-design.md)
- **工具调用（Anthropic tool_use ↔ OpenAI tool_calls）**：双向全字段映射，客户端可混用两套说法——
  · 请求侧：`tools[].input_schema` → `function.parameters`；`tool_choice` 的 `auto/any/tool/none` → `auto/required/{function}/none`；`disable_parallel_tool_use` → `parallel_tool_calls:false`；`stop_sequences` → `stop`；`system`（字符串或 block 数组）→ `system` 消息。
  · 会话侧：`tool_use` 块 → `assistant.tool_calls`（`input` 对象 ↔ `arguments` JSON 串）；`tool_result` → `role:"tool"`（`tool_call_id` 配对）。`is_error:true` 无对应字段，前缀 `[tool_error]` 显式告诉模型"这个工具失败了"（否则它会把失败信息当正常结果继续编）。
  · **工具结果里的图片**：OpenAI 的 `tool` 消息只允许文本部件，塞 `image_url` 会被上游 400 —— 网关把图**取出来补在紧随其后的 `user` 消息**里（带 `[tool_result image]` 锚点），视觉模型照样看得到；这种形态同样受「图片能力门」约束。
  · 响应侧：`tool_calls` → `tool_use` 块（id 走 `sanitizeToolId` 清洗，保证客户端回传 `tool_use_id` 时配对不裂）；`finish_reason` → `stop_reason`（`tool_calls`→`tool_use`、`length`→`max_tokens`、`stop`→`end_turn`、`content_filter`→`refusal`）；`usage.cached_tokens` → `cache_read_input_tokens`。
  · 刻意**丢弃**：`thinking` / `redacted_thinking`（OpenAI 格式上游无签名校验需求，把思维链塞回上下文反而有害）、`server_tool_use` / `web_search_tool_result` / `document`（无法在中转链复现）、`cache_control` / `metadata` / `top_k`。丢弃不影响结构完整性。
  · 上游限制会被原样透传：例如 thinking 类模型对"强制指定某个工具"会回 400（`Thinking mode does not support this tool_choice`），网关不吞不猜。
- **流式（SSE）**：三条客户端协议的流式都可用，且**首块字节与后续字节走同一条按行分发路径**（上游把整个流一次送到时不得丢字节，见 PT26）。
  · Anthropic 路由的流式转换是**有状态**的：`message_start` 每个请求只发一次，文本块只开一次，`tool_calls` 的 JSON 参数分片跨 chunk 累积后作为 `input_json_delta` 发出（否则流式工具调用必然碎）。
  · 上游不发 `[DONE]` 时，由收尾钩子补上关块 + `message_delta` + `message_stop`（客户端不会一直等）。
  · Gemini 的流式体现在 URL 动作（`:streamGenerateContent`），出站会显式带上 `stream:true`。
  · 流式失败细节见上文「流式失败」。
- **图片（多模态）**：三条客户端协议统一把图片转成内部 `image_url` block —— Gemini 的 `inlineData`（base64，`mimeType` 缺省 `image/png`）与 `fileData`（`fileUri` 直链）、Anthropic 的 `image`（`source.type='base64'` 与 `source.type='url'` 两种都认）都会被识别；**部件顺序保留**（先图后问 vs 先问后图对视觉模型有语义）。带图请求只走 `openai` / `anthropic` / `gemini` 三种协议的渠道，见「含图请求的候选裁剪」。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **密钥轮换（v1.18.5，控制台可在线轮换）**：`GATEWAY_KEY` / `ADMIN_KEY` 的生效值按 `config.json` 的 `auth` 段（控制台轮换）**> 环境变量 >** 首启自动生成取值——控制台说了算，重启不会被 `.env` 顶回去。控制台「工具 → 密钥管理」页可手填或随机生成新密钥，点一下「轮换」**立即生效、旧密钥立即失效**（无宽限期）；页面上每把密钥标注来源（控制台轮换 / 环境变量 / 首启生成），「回到环境变量值」删除 `auth` 段把控制权交还给 `.env`。新密钥准入：8–128 位可见 ASCII、禁 `change-me`、两把不得相同；**管理密钥另需大小写字母+数字+特殊字符四样齐全**（它是控制台的唯一门锁），被拒的值**不生效也不落库**。换管理密钥时**全部控制台会话同时作废**（换锁后旧会话不该继续开门），但发起轮换的那个响应会**补发一枚新会话 cookie**——发起页不会被踢回登录门，其它标签页 / 设备 / 脚本里的旧值立即 401，各自重新登录一次。
- **管理面会话（v1.18.6，渗透第三批）**：浏览器打开控制台不再是"密钥常驻 localStorage"，而是**登录门交一次密钥换会话 cookie**——
  `POST /admin/api/session`（body `{key}`）验证 `ADMIN_KEY` 后下发 `Set-Cookie: zz_session=<64 位十六进制>; HttpOnly; SameSite=Strict; Max-Age=43200`
  （`HttpOnly` 让 JS 读不到 token，`SameSite=Strict` 顺带治 CSRF；**刻意不加 `Secure`**——本网关设计上就跑 http 本地/局域网，加了 cookie 反而种不下去）。
  之后管理面调用只带 cookie（同源自动附上），密钥本身不进浏览器任何存储。会话表在**内存**：TTL 12 小时（懒过期 + 10 分钟清扫）、上限 256 条（先清过期、再逐最旧）、
  **重启全部掉线**（重开控制台重新粘一次密钥即可，脚本走 Bearer 不受影响）。登录失败计入 admin 失败限流（30 次/分钟，瞎试密钥与瞎试接口同等对待）。
  「工具 → 密钥管理」页有**退出登录**按钮（`DELETE /admin/api/session`，只杀自己那枚 token）；轮换 / 重置管理密钥会清空全部会话（见上条）。
  脚本 / CI **不受影响**：管理面始终保留 `Authorization: Bearer ADMIN_KEY` 通道，两种鉴权可并存。
- **鉴权写法**：网关密钥接受 `Authorization: Bearer <key>`、`?key=<key>`，以及**原生 SDK 的默认头**——Gemini 的 `x-goog-api-key`、Anthropic 的 `x-api-key`（仅对 `/v1/*` `/anthropic/*` `/gemini/*`；**管理面只认 `Bearer` 或会话 cookie——v1.18.6 起 `?key=` 已从管理面拆除**，客户端密钥语义不得混进管理面）。OpenAI SDK 走 Bearer，本来就通。
- **别名区分大小写不敏感**，upstream 透传原样。

## 计划中

- **安全加固剩余项**：**彻底消灭内联事件处理器**——把 `build/app.js` 的 `onclick="fn('${id}')"` 全面改成 `data-*` + 事件委托（v1.18.3 已给这些参数加了 `esc()`，属性层不可逃逸；仅当渠道 ID 含引号时还剩 JS 字符串层的理论风险）。渗透报告前三批（响应头/转义、密钥掩码/按需揭示/限流、CSP/管理面会话化）均已修完，见「安全体检」节——被驳回的建议与公网部署提醒也记在该节。
- **自动权重「生效版」**：v1.6 只做到观测（算得出来、看得见，但一行不碰真实分流）。下一步才是把健康系数折进候选份额真正生效——需要同时解决「自动份额与手填权重并存谁优先」「护栏（地板/上限）被反复触碰时如何告警」「份额变化要不要写日志」三个问题。
- **thinking 回放缓存**：已前置验证并判定**现有实现下无收益、暂不实现**（网关从不向客户端产出 thinking 块，唯一会 400 的场景回放缓存也治不了）；想重启先满足 [`docs/thinking-replay-design.md`](docs/thinking-replay-design.md) §1.4 的前提，事实的可执行版本是 `test/thinking-fidelity.test.js`。