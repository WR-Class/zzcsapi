# 同类网关内部机制对比（本项目 vs new-api / one-api / sub2api / CLIProxyAPI）

> **这份文档回答什么**：本项目（zzcsapi）和同类开源网关在**内部机制、性能、全面性**上的差别与取舍。
> **不回答什么**：多用户 / 账户体系 / 额度计费 / 租户隔离——这几项按需求明确排除在对比之外
> （new-api 与 sub2api 的复杂度有很大一部分正是为它们付的，排除后对比才公平）。
> **取证方式**：外部项目全部用 `git clone --depth 1` 直读源码 + GitHub API 定位，结论带 file:line 或配置键；
> 本项目的数字是**本机实测**（见 §2 与 §5 复现方法）。
> **诚实声明**：**没有做同机、同负载的横向实测**。所以外部项目只列"机制上可考证的性能相关事实"，
> 不给倍数结论；任何"比谁快 N 倍"的说法在这份文档里都不存在。

版本锚点（抓取于 2026-09-28）

| 项目 | 语言 / 形态 | 版本锚点 | 存储依赖 |
| --- | --- | --- | --- |
| **本项目 zzcsapi** | Node 20/24，单文件 `server.js`（约 5.7k 行），**零 npm 依赖**（无 `package.json`） | v1.17 | 两个 JSON 文件（`config.json` / `usage.json`） |
| [new-api](https://github.com/QuantumNous/new-api) | Go 1.25 + gin + GORM，单二进制（前端打进二进制） | HEAD `c2b7a9a9`（2026-09-25）/ `v1.0.0-rc.40` | SQLite/MySQL/PG + 可选 Redis |
| [one-api](https://github.com/songquanpeng/one-api) | Go + gin + GORM，单二进制 | 主干 HEAD `8df4a26`，**2025-02-21 后停更** | SQLite/MySQL/PG |
| [sub2api](https://github.com/Wei-Shaw/sub2api) | Go 1.27 + gin + Ent + Vue3 | `VERSION 0.2.9`，HEAD `9a62841`（2026-09-28，日更） | **PostgreSQL 15（必选）+ Redis 7（必选）** |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Go 1.26 + gin，单二进制 + 插件（c-shared） | `v8.0.3`（2026-09-28） | 一份 `config.yaml`，无数据库 |

> new-api 已从 `Calcium-Ion/new-api` 迁移到 `QuantumNous/new-api`（GitHub API 重定向确认）；one-api 主干停更，
> 它更多是"历史基线"，不建议按它做新部署。

---

## 1. 内部机制

### 1.1 协议与转换层

| | 客户端协议 | 转换策略 | 流式实现 |
| --- | --- | --- | --- |
| **zzcsapi** | OpenAI / Anthropic / Gemini（另有 5 种特殊上游协议：notion、notion-agent、workbuddy、genspark、codex） | 内部统一 OpenAI 格式；**同协议直通（v1.15）**、跨协议双向转换 | 按行转发；**直通时原始字节直转**（v1.16）；无整包缓冲 |
| new-api | openai / claude / gemini / openai_responses | `relaykit/relayconvert` 三套注册表按 (from,to) 查表，覆盖 4 格式互转，9 个方向有 golden 测试 | 逐行扫 SSE → 解析 dto → 按目标协议**重新序列化**；缓冲 64KB 起、上限可配到 128MB |
| one-api | **只有 OpenAI**（assistants/threads/files/fine-tunes 是 `RelayNotImplemented`） | 单向 N→OpenAI，各 adaptor 自写 handler | 逐行反解重构 SSE |
| sub2api | OpenAI / Anthropic / Gemini（另有 `/antigravity/*`、`/backend-api/codex/responses`） | `pkg/apicompat` 四方向矩阵（anthropic↔responses、chatcompletions↔anthropic、chatcompletions↔responses…），**同平台可原生透传** | 事件解析后重构，64KB scanner `sync.Pool` |
| CLIProxyAPI | OpenAI / Anthropic / Gemini / Codex / interactions | N×N 矩阵（antigravity/claude/codex/gemini/interactions/openai 两两组合），**同协议 passthrough 是纯转发函数** | 接口形态 `rawJSON → [][]byte`，**按 SSE 事件帧逐帧转换** |

要点："同协议不做无谓转换"此前是 CLIProxyAPI 与 sub2api（部分）在做，new-api 明确选择**全转换**（连流式也解析重编码）；
本项目是在 v1.15 补上的——直通省掉的是内部 OpenAI 格式**承载不了的字段**在两个方向上的静默丢失。

### 1.2 调度与路由

| | 选渠道算法 | 权重 | 会话粘性 | 健康度参与排序 |
| --- | --- | --- | --- | --- |
| **zzcsapi** | 健康分层（冷却→末位、`down`→倒数第二、`probation`→健康之后）+ **有效优先级** + 延迟 | **SWRR 平滑加权轮询**（真实分流）；自动权重**只观测不生效** | 无 | 是（冷却 / 半愈合 / 延迟） |
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
| 常驻内存 RSS | — | **26 MiB（空载）/ 45 MiB（线上 31 渠道）** |
| 每请求磁盘 I/O | 0（用量 4s 防抖落盘、`recent` 上限 800 条） | 0 |
| 回归测试 | 22 文件 / 898 断言 | **23 文件 / 930 断言**（v1.18 起 28 文件 / 1185 断言） |

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
| 客户端协议 | 3 | 4（含 responses） | **1** | 3+（antigravity / codex 端点） | 4+（含 interactions） |
| 上游协议族 / 渠道类型 | 8 种协议（现网 31 渠道） | **60 常量 / 40 适配器目录** | 38 适配器 | 10+ 平台 | 11–12 类 |
| chat / embeddings / images | ✅（多为透传） | ✅ | ✅ | ✅ | ✅ |
| audio / rerank / moderations | ❌ | ✅ | 部分 | 部分 | 部分（images/videos/alpha search） |
| realtime / WebSocket | ❌ | ✅ `/v1/realtime` | ❌ | ✅（OpenAI 上游 WS 通道 + 连接池） | ✅ |
| 工具调用 | ✅ 三协议全通 + 两种上游**文本仿真** | ✅ | ✅ | ✅（含 parallel tools、reasoning 别名） | ✅ |
| 多模态图片 | ✅（图片能力门裁剪候选） | ✅ | ✅ | ✅ | ✅ |
| 推理字段保真 | 同协议直通保留；跨协议丢弃 | 转换映射 | 无证据 | thinking budget/effort 映射 + Gemini 签名清洗 | **thinking 回放缓存** |
| 提示 / 响应缓存 | ❌ | 无证据 | ❌ | L1 ristretto + L2 Redis + singleflight | 仅 thinking 回放 |
| 会话粘性 | ✅ v1.17（默认关；只改链首、不污染份额统计） | 渠道亲和 | ❌ | **最强（四层）** | ✅（默认关） |
| 客户端限流 | ✅ v1.17（整机 rpm + 并发，429 + Retry-After） | ✅ Redis/内存 + 按模型 | 进程内 | ✅ RPM / 窗口费用 | 无证据 |
| 指标 / 运维面 | 11 个 `/admin/api/*` + 单页控制台 + **`/metrics`（Prometheus 文本，v1.17）** | `perf_metrics` + 系统监控 | 无 | 有 | management API v8/v0 + pprof + 内建面板（**v6.10 起不再内置统计**） |
| 配置热更新 | ✅（写 `config.json` 即时生效） | DB 轮询 | ❌ | ✅ | fsnotify + 管理 API |
| 插件 / MCP | ❌ | 无 MCP 证据 | ❌ | ❌ | **插件体系（c-shared）** |
| 集群 / 多实例 | ❌ 单机设计 | Redis 共享（配置秒级延迟） | ❌ | Redis 跨实例 | ✅（Home + JWT） |
| 回归测试 | **28 文件 / 1185 断言，零依赖真链路 e2e** | golden 测试（9 方向） | 少量 | benchmark + 测试 | 有测试 |

---

## 4. 本项目的取舍与已知短板

**优势（与上面表格互证）**

1. **失败语义最细**：分级冷却 + `Retry-After` 对齐 + 探测半愈合 + 4xx 不短路 + 冷却原因回传客户端。
2. **零依赖单文件**：约 5.7k 行、可读可改；**1185 项断言**的零依赖真链路回归（假上游 + 临时网关，不出网、不烧额度）。
3. **特殊上游工程**：curl/PowerShell 指纹绕行、网页会话、文本协议工具仿真、订阅额度解析——与 sub2api 的
   uTLS 路线解决同一类问题，但**零依赖**。
4. **v1.17 补齐三项**：会话粘性（只改链首，不污染加权份额统计）、客户端限流（整机 rpm + 并发，429 + `Retry-After`）、
   `/metrics`（Prometheus 文本格式，零依赖，正文不含任何密钥）——对比表里此前唯一还站得住的差距就这三项。

**短板（诚实清单）**

1. **广度不如 new-api**：audio / rerank / moderations / realtime / WebSocket 都没有；渠道类型只有 8 种协议。
2. **还缺一项机制，且已论证"不做"**：thinking 回放缓存 —— 逐行核对 + 保真度测试
   （`test/thinking-fidelity.test.js`）证明：网关**从不向客户端产出 thinking 块**（除 v1.15 同协议直通，那条路给的是带签名的原件），
   所以"客户端回传无签名块 → 上游 400"**不可达**；唯一会 400 的场景（签名跨渠道）回放缓存也治不了。
   详见 [`docs/thinking-replay-design.md`](thinking-replay-design.md)。集群/多实例一致性同样属于"不做"（与单点自用定位不符），不是"没做"。
3. **v1.17 三个开关还没进控制台**：只能改 `config.json`（`/admin/api/status` 里能看到实时状态）。
4. **流式写放大已在 v1.16 修掉，但非直通路径仍是"逐行解析"**：跨协议转换无法避免解析，与 new-api/one-api 同源。
5. **出站连接池上限 128、`identity` 编码**：v1.16 引入的取舍，见 README §出站与流式写路径。
6. **指标是进程内计数**（重启清零），不是持久化时间序列——要长期趋势得让 Prometheus 去拉。

---

## 5. 复现方法与证据

**本项目的数字怎么复现**（脚本在系统临时目录，不进仓库）：

1. `node test/outbound-http-client.test.js` —— 出站客户端形状、keep-alive 复用（含 `agent:false` 对照组）、
   直通流式逐字节一致（CRLF + 跨片帧）、真实 usage 仍记录。
2. 全量回归：`Get-ChildItem test -Filter *.test.js | % { node $_.FullName }`（28 个文件 / 1185 断言）。
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
