# 同类网关内部机制对比（本项目 vs new-api / one-api / sub2api / CLIProxyAPI / notion2api）

> **这份文档回答什么**：本项目（zzcsapi）和同类开源网关在**内部机制、性能、全面性**上的差别与取舍。
> **不回答什么**：多用户 / 账户体系 / 额度计费 / 租户隔离——这几项按需求明确排除在对比之外
> （new-api 与 sub2api 的复杂度有很大一部分正是为它们付的，排除后对比才公平）。
> **取证方式**：外部项目全部用 `git clone --depth 1` 直读源码 + GitHub API 定位，结论带 file:line 或配置键；
> 本项目的数字是**本机实测**（见 §2 与 §5 复现方法）。
> **诚实声明**：**没有做同机、同负载的横向实测**。所以外部项目只列"机制上可考证的性能相关事实"，
> 不给倍数结论；任何"比谁快 N 倍"的说法在这份文档里都不存在。

> **版本锚点**：外部五家抓取于 **2026-09-28**，原样保留（不追更——把"我们自己的进度"混进横向对比会让这张表失效）；
> **本项目那一行已更新至 v1.18.86 / 2026-10-20**。凡给本项目打分的数字都重测过，口径与复现命令见 §5.1。


| 项目 | 语言 / 形态 | 版本锚点 | 存储依赖 |
| --- | --- | --- | --- |
| **本项目 zzcsapi** | Node 20/24，`server.js` **9,379 行** + 6 个本地模块（约 2.3k 行），**零 npm 依赖**（无 `package.json`、无 `node_modules`，`require` 只有内置模块 + 同目录 `./*.js`） | **v1.18.86** | 两个 JSON 文件（`config.json` / `usage.json`）+ 配置代际快照目录 `config-history/` |
| [new-api](https://github.com/QuantumNous/new-api) | Go 1.25 + gin + GORM，单二进制（前端打进二进制） | HEAD `c2b7a9a9`（2026-09-25）/ `v1.0.0-rc.40` | SQLite/MySQL/PG + 可选 Redis |
| [one-api](https://github.com/songquanpeng/one-api) | Go + gin + GORM，单二进制 | 主干 HEAD `8df4a26`，**2025-02-21 后停更** | SQLite/MySQL/PG |
| [sub2api](https://github.com/Wei-Shaw/sub2api) | Go 1.27 + gin + Ent + Vue3 | `VERSION 0.2.9`，HEAD `9a62841`（2026-09-28，日更） | **PostgreSQL 15（必选）+ Redis 7（必选）** |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Go 1.26 + gin，单二进制 + 插件（c-shared） | `v8.0.3`（2026-09-28） | 一份 `config.yaml`，无数据库 |
| **notion2api**（v1.18.41 新增，**只比 notion 反代这一条轴**） | Go + gin + GORM，单二进制（前端打进二进制） | Windows 包 `0.1.0`（source commit `189b0ecb…`，仓库未定位到，**只有二进制**） | SQLite |

> new-api 已从 `Calcium-Ion/new-api` 迁移到 `QuantumNous/new-api`（GitHub API 重定向确认）；one-api 主干停更，
> 它更多是"历史基线"，不建议按它做新部署。
> **notion2api 的取证方式与前四家不同**：没有源码，但它把 `upstream.base_url` 暴露成配置项 ——
> 指向一个记录代理就拿到了它**发给 Notion 的原始报文**（方法与三个坑见
> [notion 附件上传研究](notion-attachment-upload-research.md) §4.1）。下面 §1.5 的每条结论都标了是"实发报文实证"还是"二进制符号推断"。

---

## 1. 内部机制

### 1.1 协议与转换层

| | 客户端协议 | 转换策略 | 流式实现 |
| --- | --- | --- | --- |
| **zzcsapi** | **4 套客户端报文**：`/v1/chat/completions` / `/v1/messages` / `/v1beta/models` / `/v1/responses`（v1.18.38）；**10 种上游协议**：openai / anthropic / gemini / notion / notion-agent / workbuddy / codex / genspark / hark / opencode | 内部统一 OpenAI 格式；**同协议直通（v1.15）**、跨协议双向转换 | 按行转发；**直通时原始字节直转**（v1.16）；无整包缓冲 |
| new-api | openai / claude / gemini / openai_responses | `relaykit/relayconvert` 三套注册表按 (from,to) 查表，覆盖 4 格式互转，9 个方向有 golden 测试 | 逐行扫 SSE → 解析 dto → 按目标协议**重新序列化**；缓冲 64KB 起、上限可配到 128MB |
| one-api | **只有 OpenAI**（assistants/threads/files/fine-tunes 是 `RelayNotImplemented`） | 单向 N→OpenAI，各 adaptor 自写 handler | 逐行反解重构 SSE |
| sub2api | OpenAI / Anthropic / Gemini（另有 `/antigravity/*`、`/backend-api/codex/responses`） | `pkg/apicompat` 四方向矩阵（anthropic↔responses、chatcompletions↔anthropic、chatcompletions↔responses…），**同平台可原生透传** | 事件解析后重构，64KB scanner `sync.Pool` |
| CLIProxyAPI | OpenAI / Anthropic / Gemini / Codex / interactions | N×N 矩阵（antigravity/claude/codex/gemini/interactions/openai 两两组合），**同协议 passthrough 是纯转发函数** | 接口形态 `rawJSON → [][]byte`，**按 SSE 事件帧逐帧转换** |

要点："同协议不做无谓转换"此前是 CLIProxyAPI 与 sub2api（部分）在做，new-api 明确选择**全转换**（连流式也解析重编码）；
本项目是在 v1.15 补上的——直通省掉的是内部 OpenAI 格式**承载不了的字段**在两个方向上的静默丢失。

### 1.2 调度与路由

| | 选渠道算法 | 权重 | 会话粘性 | 健康度参与排序 |
| --- | --- | --- | --- | --- |
| **zzcsapi** | 健康分层（冷却→末位、`down`→倒数第二、`probation`→健康之后）+ **有效优先级** + 延迟 | **SWRR 平滑加权轮询**（真实分流）；自动权重 v1.18.63 起**可选生效**（默认关；关 = 只观测只展示，开 = 健康系数真进权重，四护栏 + 抗振荡，见 `docs/scheduling.md`） | 无 | 是（冷却 / 半愈合 / 延迟） |
| new-api | 物化 `abilities` 表：优先级 DESC，重试时按 distinct priority 阶梯下降；同级**加权随机 `Σ(weight+10)`**（权重 0 仍占 10 份基础份额） | 有效 | 可选渠道亲和（Redis） | 是（`AutoDisabled`） |
| one-api | 取最高优先级档，档内 `ORDER BY RANDOM()`；`Channel.Weight` **定义了但全仓无读取点（未实现）** | **未实现** | 无 | 仅禁用/恢复 |
| sub2api | 三层（分组→平台→账号）：先过滤（模型/配额/窗口费用/RPM/利润门/并发），命中粘性则锁定原账号，否则 Priority 升序 + last-used + 最小分层 + 负载因子，并批量预取 RPM/窗口费用 | 有（账号级） | **最强**：`session_hash`、`X-Claude-Code-Session-Id`、`previous_response_id`、`guardian_parent` 四层 | 是（Redis `temp_unsched` 临时封禁） |
| CLIProxyAPI | `round-robin`（默认）/ `weighted-round-robin` / `fill-first`；**只有上游 overload/429 才 failover** | 凭据级整数权重（上限 1e6，非正数=退池） | 有（默认关，TTL 1h；**子代理继承父凭据**以复用 KV cache） | 是（分级冷却，可持久化 `.cds`） |

### 1.3 失败与重试语义

| | 冷却 / 熔断 | 重试 | 失败可解释性 |
| --- | --- | --- | --- |
| **zzcsapi** | **分级曲线**：瞬时 5s→10min、凭证 5min→6h、限流 60s 起；**听上游 `Retry-After`**（受硬上限约束）；≥3 连败转 `down`；探测成功**半愈合**（冷却减半 + 观察期），只有真实对话成功才满血 | 同渠道重试可配（默认 0，上限 5）+ 跨候选兜底；**4xx 只要后面还有候选就不短路**（v1.9.2） | 502/503 响应里**带原因与恢复时长**：哪家在冷却、为什么、还剩多久 |
| new-api | **无冷却计时器**：`ShouldDisableChannel` 按错误类型/状态码/**响应体关键词 Aho-Corasick 匹配**置 `AutoDisabled`，恢复是被动的 | 全局 `RetryTimes`（默认 0）换渠道，**无退避** | 日志落库 |
| one-api | 无冷却，直接自动禁用 + 邮件；另有按响应时间阈值禁用 | `RetryTimes`，重试时**跳过最高优先级档**；429/5xx 重试，400 不重试 | 邮件 / 日志 |
| sub2api | Redis `temp_unsched`（带 `until_unix`、命中规则、计数窗口） | **同账号重试 3 次（500ms，退避上限 8s）→ 切账号循环最多 10 次（第 n 次退避 (n−1)s）**；状态码可配 | 错误分类集中 |
| CLIProxyAPI | 分级冷却（瞬时/`disable-cooling`），可落 `.cds` | 3 轮附加凭据，**只对 403/408/429/500/502/503/504**；`max-retry-interval` 轮间冷却 ≤30s | management API 可查请求日志 |

> one-api 与 new-api **都没有冷却计时器**（只有"禁用 + 被动恢复"），CLIProxyAPI 与 sub2api 有；
> 本项目的差异在于**冷却原因与剩余时间会回给客户端**，而不是只写在日志里。

### 1.4 "难搞的上游"怎么接（路线差异最大的一条轴）

- **zzcsapi**：`curl` 子进程绕 TLS 指纹（WorkBuddy/Genspark/Codex/Notion 实测 ECONNRESET）、Cloudflare 403 时
  回退 PowerShell/.NET Schannel、渠道级代理走 `curl -x`、**文本协议工具仿真**（notion/genspark 不认原生 `tools`，
  改注入解析标记）、Codex RT→AT 令牌管理与配额查询、WorkBuddy 额度文案→重置时刻解析、密文 token 提前拦截。
  **全部零依赖**（只用 Node 内置模块 + 系统 curl/PowerShell）。
- **sub2api**：`refraction-networking/utls` **TLS 指纹伪造**（面板管多套模板）、**每小时从 GitHub 拉最新
  claude-code 版本号当 UA**、codex 指纹/身份伪装、代理实体带到期/延迟/国家与 `fallback_mode` 兜底链、
  OAuth token 定时刷新池。README 显式免责：可能违反上游条款、账号会被限流/封禁。
- **CLIProxyAPI**：OAuth 凭据池 + **thinking/签名回放缓存**（bounded LRU，TTL 1h，10240 条上限）——跨轮思维链保真的关键。
- **new-api / one-api**：以 API key 为主，**未找到指纹伪装一类实现的证据**。

### 1.5 七项差异的强弱结论（本项目 vs notion2api，v1.18.41 定稿，v1.18.43 修订；标题原写"六项"，第 7 轴是 v1.18.42 追加的，v1.18.86 校正）

**为什么单列这一节**：notion2api 是目前唯一能对照的"notion 反代"实现，前四家都不碰这条上游。
七项逐条给**强弱**（谁强、强多少、证据强度），不给"谁更好"的整体结论——两边目标不同：
它是"给 notion 套一个 OpenAI 兼容壳"，我们是"多渠道路由 + 四套客户端报文"。

| # | 轴 | 结论（强弱） | 证据与强度 |
| --- | --- | --- | --- |
| 1 | **账号/渠道路由与兜底** | **本项目强** | 我们是多渠道路由 + 候选链 + 逐家切换 + 同渠道重试；它是**账号池 + 分组**，账号一旦 `status:error` 整组报 `unknown model`（**实发报文实证**：今天把一个账号打成 error 后，同一分组的所有请求都 400 `unknown model`，不是"换下一个账号"）。强度：**强**（现象可复现） |
| 2 | **熔断记账与冷却** | **本项目强** | 我们有两条 streak（真实流量 / 探测）、冷却分级 + 半愈合 + `Retry-After`；它只有 `active` / `error` 两态（`/admin/accounts` 与 `/admin/groups/{id}/accounts` 下发的字段只有 `status`）。强度：**中**（字段面窄是实证，但它内部是否另有退避逻辑只有二进制、无法排除） |
| 3 | **客户端报文面** | **本项目强** | 我们四套（chat / Anthropic / Gemini / Responses）+ 专用渠道输出收口；它以 OpenAI 兼容为主（`/v1/chat/completions`、`/v1/models` 实测）。强度：**强**（端点面可直接列举） |
| 4 | **附件 / CSV 让 AI 读** | **v1.18.42 起：本项目追平并反超** | 它**已经在用**：`enableCsvAttachmentSupport:true` + 把内联文件行追加进 user step 正文（**实发报文实证**，逐字抄录在研究文档 §4.2）；我们 v1.18.41 按同一形状实现（产物与它那一行**逐字相同**，有断言守着）。**v1.18.42 变了**：传输层修好之后，「模型真读到了」的活体判据**已取得**——对照那一发模型答"没找到你上传的 CSV"，带附件那一发答出**只存在于 CSV 里**的 `K7Q2M9`，并经本地容器网关复验（研究文档 §8）。⇒ 它领先的那"一个身位"**已经没有了**；我们多出来的反而是它没有的：**对照实验 + 可复现的判决工具**（`notion-attachment-verdict.js`）。强度：**强（我们的活体判据是成对打，能排除"模型在猜"）** |
| 5 | **流断取回兜底** | **各有所长，本项目更直接** | 我们有**同 threadId 重发**取回成品全文（v1.18.39 活体验证：首发 6.3s 拿 `record-map`、再发 4.7s 拿同一条线程全文）；它点名走 `getInferenceTranscriptsForUser`（形状今天我们抓到了：回的是**线程清单 + usage**，**不是成品正文**）→ 它要拿正文还得再取一次。强度：**中**（我们的路已验证；它那条路我们只验证了形状、没跑完它自己的取回链） |
| 6 | **报文保真与记账口径** | **本项目强** | 我们的 `runInferenceTranscript` 顶层字段与它**逐字同构**（traceId / spaceId / threadId / threadType / createThread / generateTitle / saveAllThreadOperations / setUnreadState / isPartialTranscript / asPatchResponse / isUserInAnySalesAssistedSpace / isSpaceAssisted / threadParentPointer / transcript / debugOverrides 全部对得上，**实发报文实证**）；差异只在两处：① 我们的 config step 只有 4 个字段、它是 61 个；② 它的 user 正文带 `user: ` 前缀（我们不带，且已跑过 20+ 版本）。记账口径（usage 帧采集、思考占比、工具轮 token、预算透传）是我们的实现细节，**无法与它对比**。强度：**中**（结构同构是实证；"口径谁准"没有共同基准） |
| 7 | **出站传输（v1.18.42 新增的一轴）** | **本项目强（它没解决这个问题）** | Notion 会对**某些客户端**回"软墙"（200 + `temporarily-unavailable`）。我们的出站是**通道链**（curl 主 → h2 兜底 → fetch 最后）+ 软墙自动换通道（协议详解 §notion 出站通道链）。**v1.18.43 修正了根因**：软墙有**两个独立维度**——① **账号状态**（主导，与传输无关、随时间变：`notion7` 在本地与云端、五种传输一起软墙）；② **客户端指纹**（只在账号可过时才看得见：同一秒交替打 curl 3/3 真答、fetch 0/3 软墙）。通道链治 ②、**治不了 ①**（那时网关如实报 `ok:false / notion: temporarily-unavailable`）。它的 Go 出站走标准 `net/http`——**指纹与 Node 不同、我们没测它会不会被墙**，且它**没有任何软墙判据或换通道机制**（**属于未验证**，故不写成"它弱"）。强度：**弱→中**（我们这一侧的机制是实证；它那一侧是"未验证"） |

**净结论（v1.18.43 修订）**：**七项里六项本项目占优或持平，第 4 项（附件/CSV）在 v1.18.42 已被追平**——
它上线更早，但"模型真的读到了"这个判据**我们现在也有**（而且是成对打、能排除模型瞎猜），并且我们多一套可复现的判决工具。
**其余各项里最值钱的两条仍是"多渠道路由"与"四套客户端报文"**，这也正是"给 notion 套壳"与"做网关"两类目标的必然分岔。
唯一需要留意的**反向**证据：它的 config step 有 61 个开关、我们只有 4 个（§4.2）——
今天看只影响附件，但**它提示我们可能还缺别的能力开关**（下一批候选：`enableScriptAgent*` 那一组）。
另有一条**教训型的差异**（不构成强弱）：这轮"软墙"我们连错三次（账号权益 → TLS 指纹 → HTTP/1.1），
**每一次都是单环境一次成功就下结论**；v1.18.43 又发现前三次的"最终判据"（跨四环境对打）**也只覆盖了两个维度里的一个**，
真正的判据是**在同一时间窗内交错打**（C F C F …）并先确认账号是否可过——为此专门入库了 `notion-wall-probe.js`。
这类**反爬式静默拒绝**，单环境、单次结论的可信度接近零。

---

## 2. 性能

### 2.1 本项目实测（同机、回环、客户端 keep-alive）

容器内 Linux（Node v20.20.2）/ Windows 开发机（Node v24）两种口径，改前 = v1.15，改后 = v1.16：

| 指标 | v1.15 | v1.16 |
| --- | --- | --- |
| 出站每跳延迟（容器内）：全局 `fetch` vs `http.request` | 1.28ms vs 0.54ms（2.4×） | 出站已换成 `http.request` + keep-alive Agent |
| 出站每跳延迟（Windows）：全局 `fetch` vs `http.request` | 13ms vs 0.6ms | 同上 |
| 网关净增延迟（非流式，Windows，N=300） | +13.9 ms | **+0.93 ms** |
| 网关净增延迟（非流式，容器内，N=300） | 1.28 ms（仅出站那一跳） | **+1.06 ms**（含网关自身解析/调度/记账） |
| 非流式吞吐（并发 32，Windows，600 请求） | 950 req/s（直连 2983 = 32%） | **1814 req/s（直连 3135 = 58%）** |
| 非流式吞吐（并发 32，容器内） | 881 req/s | 926 req/s（直连 2034 = 46%，瓶颈已变成网关自身单进程处理） |
| 流式首字节净增（10 片 × 25ms，Windows） | +13.6 ms | **+1.44 ms** |
| 块间隔抖动净增 | +10.95 ms | **+0.03 ms** |
| 客户端 TCP 写次数（上游 10 片） | 24 | **11（与上游分帧对齐）** |
| 连续 50 条流式的异常条数 | 0 | 0 |
| 冷启动到 `/healthz` 200 | — | **882 ms** |
| 常驻内存 RSS | — | **26 MiB（空载）/ 45 MiB（v1.16 线上 31 渠道）**；**2026-10-20 复测：刚启动 28.1 MiB，运行约 1 小时后 39–45 MiB（75 渠道 / 16 启用；cgroup `anon` 49 MB、`file` 仅 1 MB ⇒ 几乎全是堆）**——这是会随统计滑窗与 `usage` 累积上涨的量，**报单个数字没有意义** |
| 每请求磁盘 I/O | 0（用量 4s 防抖落盘、`recent` 上限 800 条） | 0 |
| 回归测试 | 22 文件 / 898 断言 | **23 文件 / 930 断言**（v1.16 当时）；**现为 64 文件 / 3091 断言**（v1.18.88 实测，`node _run_all_tests.js`） |

口径说明（避免误读）：
- 本机回环上"一跳"的成本约 0.3～0.6 ms；上面的**净增**= 经网关 − 直连，含网关自己的 JSON 解析、候选选择、记账。
- 并发吞吐那几行的**上限**在容器内只有 ~900 req/s，是网关单进程处理能力的上限，不再是网络往返；
  对 LLM 网关的实际负载（每秒个位数请求、上游动辄几百 ms～几秒）来说这不是瓶颈。
- 上表"改前"的出站数字来自独立微基准（同一个假上游、同一个客户端口径），不是靠推算。

### 2.2 外部项目的机制侧事实（**未同机实测**）

| | 性能相关机制 |
| --- | --- |
| new-api | 每请求 3 goroutine + writeMutex；流式**不可字节透传**（解析重编码，缓冲上限 128MB）；每请求写消费日志（可关）→ 日志表膨胀，需独立日志库/ClickHouse TTL/批量更新对冲；SQLite 单写者；可选 Redis 限流往返；按 CPU/内存/磁盘阈值**直接回 503 反压**；有 `perf_metrics` 与系统监控，但未找到 Prometheus `/metrics` 证据 |
| one-api | 日志同步写库；额度扣减用秒级内存聚合批量刷库（唯一明显的写放大缓解）；进程内滑动窗口限流；无指标/追踪 |
| sub2api | 首字节路径是五段式（选号→鉴权限量→协议转换→上游→事件重构→记账）；**PG + Redis 均必选**，每请求含 Redis 往返；用量记账走 pond 池（128→512 worker，溢出内联执行）；SSE 缓冲池化；README 自述**窗口限制在请求完成后记账，并发中的请求可能各自超窗** |
| CLIProxyAPI | Go 原生并发、每请求独立 goroutine；缓存只有思维链/签名回放，**未找到响应级缓存**；高并发靠 `safemode` 关掉高开销日志与中间件降内存；**未找到内置客户端限流与官方基准数字** |

---

## 3. 全面性

| 能力 | zzcsapi | new-api | one-api | sub2api | CLIProxyAPI |
| --- | --- | --- | --- | --- | --- |
| 客户端协议 | **4**（chat / anthropic / gemini / responses） | 4（含 responses） | **1** | 3+（antigravity / codex 端点） | 4+（含 interactions） |
| 上游协议族 / 渠道类型 | **10 种协议**（现网 **75 渠道**，16 启用） | **60 常量 / 40 适配器目录** | 38 适配器 | 10+ 平台 | 11–12 类 |
| chat / embeddings / images | ✅（多为透传） | ✅ | ✅ | ✅ | ✅ |
| audio / rerank / moderations | ❌ | ✅ | 部分 | 部分 | 部分（images/videos/alpha search） |
| realtime / WebSocket | ❌ | ✅ `/v1/realtime` | ❌ | ✅（OpenAI 上游 WS 通道 + 连接池） | ✅ |
| 工具调用 | ✅ 三协议全通 + 两种上游**文本仿真** | ✅ | ✅ | ✅（含 parallel tools、reasoning 别名） | ✅ |
| 多模态图片 | ✅（图片能力门裁剪候选） | ✅ | ✅ | ✅ | ✅ |
| 推理字段保真 | 同协议直通保留；跨协议丢弃 | 转换映射 | 无证据 | thinking budget/effort 映射 + Gemini 签名清洗 | **thinking 回放缓存** |
| thinking 签名回放 | **✅ v1.18.8**（仅同协议直通的人工丢失块：只回放上游真签过的，四元键不跨会话/渠道/模型，4xx 即作废，默认关） | 无证据 | 无证据 | 无证据 | ✅（bounded LRU，TTL 1h，10240 条） |
| 提示 / 响应缓存 | ❌ | 无证据 | ❌ | L1 ristretto + L2 Redis + singleflight | 仅 thinking 回放 |
| 会话粘性 | ✅ v1.17（默认关；只改链首、不污染份额统计） | 渠道亲和 | ❌ | **最强（四层）** | ✅（默认关） |
| 客户端限流 | ✅ v1.17（整机 rpm + 并发，429 + Retry-After） | ✅ Redis/内存 + 按模型 | 进程内 | ✅ RPM / 窗口费用 | 无证据 |
| 指标 / 运维面 | **25 条 `/admin/api/*` 路径 / 30 个 method+path 组合**（实测统计口径见 §5）+ 单页控制台 + **`/metrics`（Prometheus 文本，v1.17）** | `perf_metrics` + 系统监控 | 无 | 有 | management API v8/v0 + pprof + 内建面板（**v6.10 起不再内置统计**） |
| 配置热更新 | ✅（写 `config.json` 即时生效） | DB 轮询 | ❌ | ✅ | fsnotify + 管理 API |
| 配置变更保护 | **✅ v1.18.83–86**：代际快照（环形 20 代 + hash 去重，可一键回滚）；**原子写**（同目录 tmp → fsync → rename）；启动**三跳自愈**（正主 → `.bak` → 代际快照，全坏才退非 0），坏文件留档 | DB 事务（天然原子，**无"上一代可回滚"**） | DB 事务（同左） | DB 事务（同左） | 单文件 `config.yaml`，**未找到原子写/代际证据** |
| 插件 / MCP | ❌ | 无 MCP 证据 | ❌ | ❌ | **插件体系（c-shared）** |
| 集群 / 多实例 | ❌ 单机设计 | Redis 共享（配置秒级延迟） | ❌ | Redis 跨实例 | ✅（Home + JWT） |
| 回归测试 | **64 文件 / 3091 断言，零依赖真链路 e2e** | golden 测试（9 方向） | 少量 | benchmark + 测试 | 有测试 |

---

## 4. 本项目的取舍与已知短板

**优势（与上面表格互证）**

1. **失败语义最细**：分级冷却 + `Retry-After` 对齐 + 探测半愈合 + 4xx 不短路 + 冷却原因回传客户端。
2. **零依赖、可读可改**：`server.js` 9,379 行 + 6 个本地模块（共约 2.4k 行）；**3091 项断言**的零依赖真链路回归（假上游 + 临时网关，不出网、不烧额度）——规模比 v1.16 那份对比时涨了 2.5 倍，`server.js` 已不再是"单文件"这个形态的全部。
3. **特殊上游工程**：curl/PowerShell 指纹绕行、网页会话、文本协议工具仿真、订阅额度解析——与 sub2api 的
   uTLS 路线解决同一类问题，但**零依赖**。
4. **v1.17 补齐三项**：会话粘性（只改链首，不污染加权份额统计）、客户端限流（整机 rpm + 并发，429 + `Retry-After`）、
   `/metrics`（Prometheus 文本格式，零依赖，正文不含任何密钥）——对比表里此前唯一还站得住的差距就这三项。
5. **v1.18.63–86 又补两项**：自动权重**可选生效**（默认关，开就真进分流）；配置**原子写 + 三跳启动自愈 + 代际回滚**——
   这两条同类网关要么没有（自动权重），要么用数据库事务代替、但**没有"上一代可对照/可回滚"**（配置保护）。

**短板（诚实清单）**

1. **广度不如 new-api**：audio / rerank / moderations / realtime / WebSocket 都没有；渠道类型只有 10 种协议。
2. **thinking 回放：v1.18.8 改判并已实现（范围比 CLIProxyAPI 窄）**。v1.17 曾论证"不做"（网关从不产出 thinking 块 ⇒ 客户端回传无签名块的场景不可达），
   v1.18.8 重启后落地的是**同协议直通**那一条：只把上游真签过的签名补回客户端弄丢的块，四元键隔离、4xx 即作废、默认关
   —— 与 CLIProxyAPI 的"跨协议通用签名缓存"不是一回事，**不许读成"我们也有它那套"**。
   详见 [`docs/thinking-replay-design.md`](thinking-replay-design.md)。集群/多实例一致性仍属于"不做"（与单点自用定位不符），不是"没做"。
3. **流式写放大已在 v1.16 修掉，但非直通路径仍是"逐行解析"**：跨协议转换无法避免解析，与 new-api/one-api 同源。
4. **出站连接池上限 128、`identity` 编码**：v1.16 引入的取舍，见 docs/behavior.md「出站与流式写路径」。
5. **指标是进程内计数**（重启清零），不是持久化时间序列——要长期趋势得让 Prometheus 去拉。
6. **配置保护是"补救"而非"根治"**：代际快照能回滚，但 `persistConfig` 的显式字段白名单**本身没改**——
   下一个新增字段若忘了登记，保存任意渠道时照样会被静默抹掉（详见 `docs/config-history.md` 已知边界）。
   这是与"数据库事务 + 迁移脚本"那类做法真正的差距，不是能靠加一层快照补平的。

---

## 5. 复现方法与证据

**本项目的数字怎么复现**（脚本在系统临时目录，不进仓库）：

1. `node test/outbound-http-client.test.js` —— 出站客户端形状、keep-alive 复用（含 `agent:false` 对照组）、
   直通流式逐字节一致（CRLF + 跨片帧）、真实 usage 仍记录。
2. 全量回归：`node _run_all_tests.js`（**64 个文件 / 3091 断言**，输出即合计；`Get-ChildItem test -Filter *.test.js | % { node $_.FullName }` 是等价的手工跑法）。
3. 延迟与吞吐：起一个假上游 + 临时网关（动态端口、配置在临时目录），客户端用 Node `http` + keep-alive，
   分别对"直连假上游"和"经网关"各跑 N 次取 mean/p50/p95，并发吞吐用 32 并发 × 600 请求。
   注意：**客户端必须用 keep-alive 的 `http.request`**，否则客户端自己（undici）的每跳开销会盖住被测对象。

**外部项目证据**

| 项目 | 证据（抓取于 2026-09-28，均直读源码） |
| --- | --- |
| new-api | `relaykit/relayconvert/`、`relaykit/types/relay_format.go`、`relay/helper/stream_scanner.go`、`model/ability.go`、`service/{channel_select,relay_error,channel}.go`、`middleware/{rate-limit,performance}.go`、`router/relay-router.go`、`constant/channel.go`、`main.go`、`Dockerfile`；[release v1.0.0-rc.40](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.40) |
| one-api | `model/ability.go`、`model/cache.go`、`controller/relay.go`、`controller/channel-test.go`、`monitor/channel.go`、`model/utils.go`、`common/rate-limit.go`、`relay/adaptor/anthropic/main.go`、`router/relay.go` |
| sub2api | `backend/internal/service/{gateway_scheduling,openai_account_scheduler,session_id,usage_record_worker_pool,tls_fingerprint_profile_service,claude_code_version_sync_service,proxy,proxy_fallback}.go`、`backend/internal/handler/failover_loop.go`、`backend/internal/pkg/apicompat/`、`README_CN.md`、`VERSION` |
| CLIProxyAPI | `config.example.yaml`、`internal/api/server_routes.go`、`internal/translator/`、`internal/cache/`、`docs/management-api-v8.md`、[v8.0.3](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v8.0.3) |

**明确"未找到证据"的项**：new-api 的重试退避/定时冷却计时器/仓库内压测/MCP 实现；
CLIProxyAPI 的内置客户端限流/响应级缓存/官方基准；sub2api 与 one-api 的公开压测数字；
new-api 与 one-api 的 TLS 指纹伪装实现。

### 5.1 本轮校准口径（v1.18.86，2026-10-20）

上一版这些数字停在 v1.16 时期（5.7k 行 / 31 渠道 / 1185 断言 / 11 个管理端点 / 8 种协议），
其中 **"回归测试"那一行甚至写的是 v1.18 起点、而不是终点**。本轮全部重测，**每个数字都给可复现的命令**：

| 文中数字 | 实测值 | 怎么复现 |
| --- | --- | --- |
| `server.js` 行数 | **9,379** | `(Get-Content server.js).Count` |
| 本地模块规模 | notion 857 / notion-agent 313 / hark 347 / opencode 171 / tool-emu 490 / font-assets 92 | 同上逐文件 |
| 测试文件 / 断言 | **64 / 3091** | `node _run_all_tests.js`（合计行即答案；**逐文件行相加必须等于它**） |
| 渠道数 / 启用数 | **75 / 16** | `(Get-Content data/config.json -Raw \| ConvertFrom-Json).channels` 计数 |
| 上游协议数 | **10** | `server.js` 的 `aliasedProto` 数组（`validateChannelDef` 内，唯一权威清单） |
| 客户端报文数 | **4** | 路由分支：`/v1/chat/completions`、`/v1/messages`、`/v1beta/models`、`/v1/responses` |
| `/admin/api/*` | **25 条路径 / 30 个 method+path** | 见下 |
| 常驻 RSS | **28.1 MiB（刚启动）→ 39–45 MiB（运行 1 小时后，75 渠道）** | `docker stats zzcsapi --no-stream` 连采三次；堆占比看 `docker exec zzcsapi cat /sys/fs/cgroup/memory.stat` 的 `anon`（49 MB）vs `file`（1 MB） |

**管理端点怎么数**（口径写清，否则下一个人数出来还是不一样）：

```powershell
# method+path 组合：精确匹配的 + startsWith 的子路由 + session 内部分支
Select-String -Path server.js `
  -Pattern "req\.method === '(GET|POST|DELETE|PUT)' && url\.pathname (===|\.startsWith\() '/admin/api[^']*'" `
  | ForEach-Object { $_.Line.Trim() }
```

- **精确匹配 26 条**（`status` / `usage` / `usage/clear` / `stats` / `bans` / `config` / `config/history` /
  `config/rollback` / `recheck` / `channel` / `settings`×2 / `keys`×2 / `admin-key` / `keys/generate` /
  `keys/reset` / `gateway-key` / `channels`×2 / `codex-import` / `genspark-import` / `codex-quota` / `probe` / `test`）
- **子路由 2 条**：`DELETE /admin/api/bans/{ip}`、`GET /admin/api/channels/{id}/key`
- **`/admin/api/session` 2 条**（POST 登录 / DELETE 登出，在同一分支内按 method 分派，上面那条正则打不到）

⇒ 合计 **30 个 method+path、25 条路径**。旧版写的"11 个"是 v1.17 时的口径，**少算了会话/密钥/封禁/代际/导入那一批**。

**为什么给本项目单独更新、而不顺手把外部五家也刷一遍**：那五家的数字各自需要重新 clone + 逐文件核对，
本轮没做（也不想用"看起来更新"掩盖没求证）。所以本文档里**外部项目的每一条仍是 2026-09-28 的快照**，
比较时请把它当"当时的他们"而不是"今天的他们"。
