# 运行期设置（四组开关）

> 本文从 README 拆出（v1.18.8）：README 特性列表里各有一行摘要，本文收全量语义——
> 会话粘性、客户端限流、`/metrics` 指标端点、thinking 回放，以及 `GET/POST /admin/api/settings` 怎么改它们。
> 这三项 v1.17 开关都是**默认关闭**的增量（`/metrics` 默认开、但要 key），不开就与老版本逐字节一致。
> 它们补齐的是此前对比里唯一还站得住的差距：上游缓存复用、客户端面保护、可观测性。
> 调度语义见 [docs/scheduling.md](scheduling.md)；控制台设置页的施工规格见 [docs/console-settings-spec.md](console-settings-spec.md)。

## ① 会话粘性（`sessionAffinity`）

——同一条会话尽量落在同一个上游渠道，让上游侧能复用提示缓存 / KV cache，订阅类渠道也不会因为来回换家反复触发风控。

```json
"sessionAffinity": { "enabled": true, "ttlSec": 3600, "maxEntries": 2000, "deriveFromBody": false }
```

- 会话键按优先级取：**显式头** `X-Session-Id` / `X-Claude-Code-Session-Id` / `X-Conversation-Id` / `X-ZZCSAPI-Session`（≥8 字符）→ **正文标识** `prompt_cache_key` / `session_id` / `conversation_id` → 可选（`deriveFromBody`）"系统提示 + 首条用户消息"的稳定哈希。全都取不到就是**无粘性**，退回原来的调度。
- 刻意**不认** Anthropic 的 `metadata.user_id`：Claude Code 带的是**账号级** id，拿它做粘性等于把整个账号钉死在一家（那是把加权轮询关掉，不是会话粘性）。
- 刻意把 `deriveFromBody` 默认设为 `false`：正文哈希会让**相同提示的不同请求**互相抢占同一家。
- 边界（这是它没有变成"偷偷绕过加权轮询"的原因）：只改**谁是第一位**；粘住的那家不在候选里、在冷却里、或已 `down` 时**一动不动**（不硬塞、也不清冷却）；粘性命中**不消耗** SWRR 状态、不记 `weightedHits`——所以"落点 100% 集中在一家、份额统计仍报 50/50"是正常现象（`session-affinity-e2e` 专门断言了这一点）。
- 上游挂掉时照常切换，并在**成功的那家**上重新粘住（不会在两家之间反复横跳）。

## ② 客户端限流（`rateLimit`）

——给客户端面整机速率与并发上限，超限回 `429` + `Retry-After`，别让上游额度先被烧完。

```json
"rateLimit": { "enabled": true, "rpm": 120, "burst": 0, "maxConcurrent": 8 }
```

- 令牌桶按**整机**算（单点自用定位；按客户端分桶要有稳定标识才有意义）；`burst` 不填时桶容量 = `rpm`（允许"一分钟的量一次性打完"）；`rpm:0` / `maxConcurrent:0` 各自表示不限。
- 计数在**鉴权之前**：连"刷鉴权"的流量也被挡在门外（代价：不带密钥的请求也占额度——宁可挡在门口，也不让无效流量穿到候选链上）。
- 只装在客户端面（`/v1/*`、`/anthropic/*`、`/gemini/*`）：`/healthz`、管理面、`/metrics` 不受影响。
- 并发额度在响应 `finish` **与** `close` 两条路归还（客户端中途断开也不会漏名额），归还幂等。

## ③ `/metrics`（Prometheus 文本格式，零依赖）

- 默认要 admin key（`Authorization: Bearer <ADMIN_KEY>`）；放进 Prometheus 抓取就配 `"metrics": { "public": true }`（此时匿名可抓，正文里依然**没有任何密钥**——有专门断言守着）。
- 指标：`zzcsapi_requests_total{route,status}`、`zzcsapi_channel_requests_total{channel,ok}`、`zzcsapi_channel_tokens_total{channel,direction}`、`zzcsapi_channel_latency_ms_{sum,count}`、`zzcsapi_channels{state}`（ok/down/cooldown/probation/disabled 五档）、`zzcsapi_affinity_entries` 与 `zzcsapi_affinity_events_total`、`zzcsapi_rate_limit_events_total`、`zzcsapi_thinking_replay_entries` 与 `zzcsapi_thinking_replay_events_total{event}`（learned/hits/misses/evicted/expired/stale 六事件，v1.18.8）、`zzcsapi_inflight_requests`、`zzcsapi_uptime_seconds`、`zzcsapi_process_resident_memory_bytes`、`zzcsapi_swrr_hits_total`。
- 渠道标签用**渠道 id**（控制台里显示的是 name）；token/耗时来自 `recordUsage`，与用量统计**同一处收口**，不会出现"指标好看、用量难看"的分叉。
- 诚实边界：这是**进程内**计数（重启清零，不是持久化时间序列）；单机自用够用，要长期趋势请让 Prometheus 去拉。

## ④ thinking 回放（`thinkingReplay`，v1.18.8）

同协议直通（Anthropic 客户端 → Anthropic 渠道）上，客户端把上一轮 `thinking` 块的 `signature` **弄丢**再送回来时
（部分开源 agent 框架重新序列化消息时会丢掉不认识的字段），网关按缓存把**上游自己签的那枚**签名补回去再转上游。

```json
"thinkingReplay": { "enabled": true, "ttlSec": 3600, "maxEntries": 2048 }
```

- 边界刻到最窄：**只回放缓存里真有的签名**（从不生成、从不猜测）；键是 `会话键|渠道|模型|块哈希` 四元组，**绝不跨会话/跨渠道/跨模型**（签名与上游账号绑定，渠道 A 的签名过不了渠道 B 的校验）；取不到会话键就不回放；**客户端改写过 thinking 文本的块不配旧签名**（块哈希不认）；请求里没有缺签名的块就**一个字段都不动**；上游因签名问题 4xx 时这组记录**立即作废**（`stale` 计数）。
- 完整设计与三次决策记录：[docs/thinking-replay-design.md](thinking-replay-design.md)。

## 这四组开关怎么改（v1.18 起，v1.18.8 增第四组）

容器里直接改 `config.json` 仍然可以（`/admin/api/status` 里能看到生效后的实时状态：
`affinity` / `rateLimit` / `metrics` / `thinkingReplay` 四段）；也可以**运行期改、立即生效、立即落库**——`GET/POST /admin/api/settings`
（窄口：只认这四组，字段白名单 + 严格类型，写错字段名/类型一律 400 并点名字段）。
控制台页面按 [docs/console-settings-spec.md](console-settings-spec.md) 的规格实现（该规格已交付前端侧，后端契约已冻结并有测试守着）。
会话粘性、客户端限流的**设计边界与验收标准**写在测试里（`test/session-affinity-e2e.test.js` / `test/rate-limit-e2e.test.js`），改调度或网关入口时请先跑它们。
