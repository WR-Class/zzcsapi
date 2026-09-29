# thinking 回放缓存 · 设计与实现记录（v1.18.8 已实现：同协议直通的签名修复）

> 状态：**已实现（v1.18.8）**。这份文档记录了三次决策的完整过程：
> v1.17 只落设计稿（"往用户请求里回注历史内容"的风险要先想清楚）→ v1.18 前置验证发现
> **最初的假设是错的**（跨协议路径根本产不出 thinking 块，400 不可达）→ 判定"现有实现下无收益"不实现 →
> v1.18.8 用户拍板为**开源后的其他客户端**（会把签名弄丢的那类）实现**同协议直通路径**的签名修复。
> 保真度地图的可执行版本在 [`../test/thinking-fidelity.test.js`](../test/thinking-fidelity.test.js)（36 项断言）；
> 回放行为的完整回归在 [`../test/thinking-replay-e2e.test.js`](../test/thinking-replay-e2e.test.js)（64 项断言）。
> 相关实现：`server.js` 的 thinking 回放块（`normReplayCfg` 之后）、v1.15 同协议直通、v1.17 会话粘性。

---

## 1. 问题到底是什么

### 1.1 背景

Anthropic 的思维链（`thinking` 块）带 **`signature` 签名**，官方要求：**多轮工具调用时，
上一轮的 `thinking` 块必须原样回传**（含签名）。本网关的内部统一格式是 **OpenAI**，
而 OpenAI 格式**没有**承载签名的地方 —— 看起来这里必然有损失。

### 1.2 ⚠️ 最初假设 vs 实测事实（v1.18 前置验证钉下、v1.18.8 只改了最后一行）

初稿断言：「Anthropic 客户端 → OpenAI 渠道时，上游的 `reasoning_content` 会被映射成 `thinking`
块回给客户端，**但没有签名** → 客户端再把这个无签名块带回来 → 上游校验失败 400」。

**这个假设是错的。** 逐行核对 `server.js` 后的事实（每一项都有断言守着）：

| 链路 | 实测行为 | 出处 |
| --- | --- | --- |
| Anthropic 客户端请求 → 内部 OpenAI 格式 | `thinking` / `redacted_thinking` **整块丢弃**（刻意；OpenAI 上游没有签名校验需求，回塞 content 反而污染上下文） | `anthropicToOpenAI`（1475） |
| 原生 Anthropic 上游响应 → 内部 | thinking 的**文本**进 `reasoning_content`，**签名丢掉** | `anthropicToOaiResponse`（2063–2078） |
| 原生 Anthropic 上游**流式** → 内部 | `thinking_delta` → `reasoning_content` 分片，**签名丢掉** | `createAnthropicToOaiStream`（2135） |
| 内部 → **Anthropic 客户端**（非流式） | **不产出** `thinking` 块（只有 text / tool_use） | `openAIToAnthropicResponse`（1587） |
| 内部 → **Anthropic 客户端**（流式） | **不产出** `thinking` 块 | `createAnthropicStreamConverter`（1637） |
| 内部 → **原生 Anthropic 渠道**（出站） | **不产出** `thinking` 块（即使消息上挂着 `reasoning_content`） | `oaiRequestToAnthropic`（1956） |
| Anthropic 客户端 → Anthropic 渠道（同协议） | **逐字节直通**：thinking 与**签名都原样活着** | v1.15 `passthroughChannelOpts` |
| 全仓 `signature` 出现处 | v1.18 验证时 **0 次**；v1.18.8 起**只活在回放块与 4xx 作废分支**（跨协议转换器一个都不碰，有区域守卫守着） | `thinking-fidelity.test.js` §0 |

### 1.3 结论：跨协议路径 400 不可达（这一条**仍然成立**）；会丢签名的只有直通客户端自己

1. 「**跨协议**：客户端回传**无签名的** thinking 块 → 上游 400」——**不可达**：客户端从我们这里
   **根本收不到** thinking 块（只有同协议直通会给，而那条路给的是**带**签名的原件）。
2. 真正会 400 的场景是：**客户端自带的、属于渠道 A 的签名，被发到了渠道 B**（切换/故障转移后）。
    但这条**恰恰是回放缓存解决不了的**——缓存里存的也是渠道 A 的签名，一样过不了渠道 B 的校验；
    而且网关在这里的行为是**正确的**（原样转发客户端的块，不篡改）。**v1.18.8 也不救这条**（键含渠道，见 §3）。
3. 真实存在的损失只有一种：**跨协议时思维链内容被丢弃**（Anthropic 客户端 ↔ OpenAI 渠道）。
    这是**刻意的设计**（`server.js` 有注释说明），且回放**签名**对它毫无帮助——
    OpenAI 协议侧上游（DeepSeek 一类）明确要求不要回传 `reasoning_content`。
4. **v1.18.8 新识别的场景（当初被"对本仓自用无收益"遮住）**：同协议直通上，**客户端自己把上一轮
    thinking 块的 signature 弄丢再送回来**（部分开源 agent 框架重新序列化消息时丢掉不认识的字段）。
    直通给出去的是带签名的原件，客户端手里有签名、却没能带回来——上游按规矩 400。
    这条**回放缓存能治**：网关记得上游自己签的那枚，补回去再转。

### 1.4 为什么 v1.18 判"无收益"是对的、v1.18.8 又为什么重启

v1.18 的判定「现有实现下无收益」针对的是**本仓自用的链路**：跨协议 400 不可达、
自用客户端（完好走直通）天然合法——对本仓，这张表解决不了任何**可达**的问题。

v1.18.8 的重启前提是**人群变了**：项目开源给任意客户端用，
"会把 thinking 块的 signature 弄丢"的客户端是真实存在的受益人群（上面 §1.3 第 4 条）。
用户原话（§9 第三次决策）："thinking 回放缓存既然是一种增强，我已经开源所有人都可以用，
那么就是说虽然对我无用，但是对于其他人来说是一种增强，那么我觉得是需要做的。"

两个早先的重启前提（改协议转换层让跨协议回程产出 thinking、或支持接受无签名 thinking 的上游）
**仍然不需要也不去做**——本次实现没有动任何转换器，一条都没碰。

---

## 2. 目标 / 非目标（as-built）

**目标**
- Anthropic 客户端走**同协议直通**（Anthropic 客户端 → Anthropic 渠道）多轮工具回合时，
  上一轮被客户端弄丢签名的 `thinking` 块，按缓存补回**上游自己签的那枚**签名再转上游。

**非目标**
- ❌ 不跨会话共享、不跨渠道共享、不跨模型共享（键是四元组，见 §3）；
- ❌ 不生成/伪造/猜测签名，**只回放缓存里真有的、上游自己签过的**；
- ❌ 不改变跨协议转换路径（跨协议照旧整块丢弃 thinking——那仍是刻意设计）；
- ❌ 不动直通的**响应**路径（上游 → 客户端逐字节直通不变，学习只做旁路扫描）；
- ❌ 不为了"能缓存"而向客户端产出无签名的 thinking 块（那是把风险从"丢内容"换成"制造 400"）；
- ❌ `redacted_thinking` 不存不修（它没有签名字段，丢了也不补——缓存最小化，只存 thinking+signature 对）。

---

## 3. 键设计（as-built）

复用 v1.17 已经落地的会话键（`affinityKeyFor`），叠加**渠道 / 模型 / 块哈希**三个维度：

```
REPLAY 键 = `${sessionKey}|${channelId}|${model(小写去空格)}|${sha1(thinking).slice(0, 24)}`
```

- `sessionKey`：与粘性**同一套推导**（显式头 → 正文标识 → 可选正文哈希），但**不受粘性开关牵连**——
  `affinityKeyFor(req, body, ignoreEnabled)` 的第三参跳过粘性门槛（回放开、粘性关是完全合法的组合）。
  **取不到会话键就不回放**：没有会话边界就没有安全边界。
- `channelId` 必须在键里：签名与上游账号绑定，渠道 A 的签名过不了渠道 B 的校验——
  这也是与同类项目最大的行为差异（它们默认"同一凭据池内可回放"，我们**只承认同一渠道**）。
- `model` 在键里：换模型后的思维链语义不同，不互相污染。
- 块哈希（sha1 前 24 位十六进制）在键里：客户端把 thinking 文本**改写**过的块不认——
  修的是"丢字段"，不是"改内容"；给改写过的内容配旧签名本身就是伪造。

## 4. 存什么（as-built）

每条记录（内存 `Map`，进程内，重启即失）：`{ signature, ts }`，键即上面的四元组。

- **只存带签名的**（`thinkingPairsFromAnthropic`：`content[]` 里 `type === 'thinking'` 且
  `thinking` 与 `signature` 都在的才收对；redacted/无签名的直接跳过——存了也没用）。
- 上限：`maxEntries`（钳制 [16, 100000]，默认 **2048**）+ `ttlSec`（钳制 [30, 604800]，默认 **1 小时**）。
  超限淘汰**最旧**（`Map` 插入序）；过期**懒删**（不额外起定时器）。
- 参考量级：CLIProxyAPI 用 LRU 10240 条 / TTL 1h。我们默认更小——单机自用，宁可少占内存。

## 5. 学习 / 修复 / 作废（as-built 的三处接线，全部只在直通 anthropic 路上）

**学习（两处，都是旁路，不改转发的字节）**
- 非流式：`tryChannel` 的直通非流式分支解析出上游响应后，
  `replayLearn(replayKey, channelId, requestedModel, thinkingPairsFromAnthropic(parsed))`；
- 流式：与 usage 扫描**同一个旁路位**（`passthroughWrite` 的行循环 + 收尾残行冲刷）跑
  `thinkingStreamScan`（`content_block_start(thinking)` → `thinking_delta` / `signature_delta` 累积 →
  `content_block_stop` 收口；没走到 stop 的半截块**不学**），收尾 `res.end()` 前 `replayLearn`。
- 三缺一就不学：不是直通 anthropic / 拿不到会话键 / 块上没有签名。

**修复（一处，直通选路的入口）**
- `dispatchRequest` 构造直通出站参数时：
  `passthroughChannelOpts(chProto, (chProto === 'anthropic' ? repairThinkingBody(replayKey, c.channelId, requestedModel, opts.rawClientBody) : null) || opts.rawClientBody)`。
- `repairThinkingBody` 只翻 `role === 'assistant'` 消息的 `content[]`，只认
  `type === 'thinking' && thinking && !signature` 的块（**只修丢字段的，不碰带签名的、不碰改写内容的**），
  命中缓存才补；**一条都没命中就返回 null** —— 直通继续用原始报文，**一个字段都不动**。
- gemini 直通与跨协议原生转换**都不碰报文**（修复只在 anthropic 同协议注入）。

**作废（一处，4xx 透传分支）**
- 上游 4xx 透传（单候选打回给客户端的 400）且报错文案点名 `signature|thinking` 时，
  `replayStale(replayKey, channelId, requestedModel)` 删除这组会话/渠道/模型下的**全部**记录——
  同一条坏记录不许反复引发 4xx。

## 6. 设置 / 观测（as-built）

- 控制台「运行期设置」第四组 `thinkingReplay`（`enabled` / `ttlSec` / `maxEntries`，
  与 v1.17 三组同一风格：`GET/POST /admin/api/settings`、PATCH 语义、启动与保存共用 `normReplayCfg`、
  `persistConfig` 白名单）；**默认关闭**（`enabled: false` = 零行为零状态零表项）。
- `/admin/api/status` 暴露 `thinkingReplay: replayStatus()`（enabled / ttlSec / maxEntries / entries /
  learned / hits / misses / evicted / expired / stale）。
- `/metrics` 暴露 `zzcsapi_thinking_replay_entries` gauge 与
  `zzcsapi_thinking_replay_events_total{event=...}`（learned / hits / misses / evicted / expired / stale 六事件）。
- 护栏：命中率长期为 0（只有 misses 没有 hits）说明适配场景不存在——应据此决定**退役**，
  而不是留着当摆设。

## 7. 验收（v1.18 写的清单 → v1.18.8 全部落进 [`../test/thinking-replay-e2e.test.js`](../test/thinking-replay-e2e.test.js)）

### 7.1 第 0 步（v1.18 **已执行：结论是"跨协议不做"**）

不靠印象，直接把 `server.js` 的转换层函数**按花括号配对抠出来**在沙箱里跑，
拿带 `signature` 的 thinking 块过一遍每一条链路，把结论固化成
[`../test/thinking-fidelity.test.js`](../test/thinking-fidelity.test.js)（36 项断言）。
结果见 §1.2 的事实表——「客户端回传**无签名** thinking → 上游 400」在**跨协议**路径不可达；
唯一当时可达的 400 场景（签名跨渠道）回放缓存也治不了（v1.18.8 也不治，键含渠道）。

### 7.2 重启时的验收清单（v1.18.8 逐条兑现）

1. **先复现真实失败** → 对照轮（回放关闭）：假上游做签名校验并记档，
   客户端把 signature 丢了送回 → 上游 400「signature required」，无签名块**原样到达上游**（问题真实存在）；
2. 同会话同渠道相邻轮次，上游**真的收到**带原签名的块（逐字段比对 thinking 与 signature）；
3. 不同会话 / 不同渠道 / 不同模型 → **绝不回放**（三组反向断言，跨渠道组用"A 家临时挂掉逼请求落到 B 家"钉死）；
4. 过期（懒删）/ 超限淘汰（丢最旧）后不回放，计数正确（纯函数真值表 + `evicted`/`expired`）；
5. 完好客户端（带签名块原样回传）**一个字段不动**（hits 计数不涨）；直通字节级断言复用
   [`../test/same-protocol-passthrough.test.js`](../test/same-protocol-passthrough.test.js)（44 项全绿）；
6. 上游 400 时这组记录作废（`stale` 计数、entries 立即掉），第二次不再回放同一条；
7. 本文件 §1.2 事实表与 `thinking-fidelity.test.js` **同步改写**（`signature` 的"0 次"守卫改成
   "只活在回放块与 4xx 作废分支"的区域守卫）——两份地图与实现不说两套话。

另有：流式学习（SSE 分片攒出的对照样修）、`redacted_thinking` 不存不修、会话键取不到不修、
设置第四组（钳制 / PATCH / 落库 / 重启）与 `/metrics`、`/admin/api/status` 暴露——全在 64 项断言里。

## 8. 风险（as-built 复核）

| 风险 | 影响 | 缓解（实现里真的做了） |
| --- | --- | --- |
| 误回放（会话键识别错、把别人的思维链塞进去） | 语义污染，且**很难发现** | 只在显式会话键命中时回放；取不到键不回放；渠道/模型/块哈希都在键里，四元不跨 |
| 客户端改写了 thinking 文本后仍被配旧签名 | 伪造上游没签过的内容 | 块哈希在键里：改写过的块查不到，宁可 miss 也不配 |
| 签名过期/失效 | 上游 400 | 4xx 报错点名 signature/thinking 即删整组（`stale` 可观测）；TTL 1h 懒删 |
| 内存占用 | 长跑进程膨胀 | 默认 2048 条 + 1h TTL；条目只存 `{signature, ts}`（键带 thinking 哈希，不存原文副本） |
| 直通保真被破坏 | 全仓最被信任的一条路变味 | 修复只在"客户端已弄丢字段"的前提下出手；没坏（或有签名）一个字节不动；`same-protocol-passthrough` 44 项守着 |
| 复杂度 | 多一张驻留表、三处接线 | 默认关（零状态）；学习在旁路不改字节；观测三段齐全便于判断去留 |

## 9. 决策记录（三次）

- **v1.17 时**：它是**唯一一项需要"往用户请求里回注历史内容"**的改动——注错了不会报错，只会让模型推理
  悄悄变味，失败模式与"限流/粘性/指标"完全不同量级，所以先只落设计稿。
- **v1.18 前置验证后**：按 §7.1 的要求真的去复现问题，结果**跨协议路径上问题不可达**（§1.2/§1.3），
  而可达的 400 场景（签名跨渠道）回放缓存也治不了。**结论：不实现**，
  并把现状固化成 [`../test/thinking-fidelity.test.js`](../test/thinking-fidelity.test.js)。
- **v1.18.8（第三次，用户拍板）**：「thinking 回放缓存既然是一种增强，我已经开源所有人都可以用，
  那么就是说虽然对我无用，但是对于其他人来说是一种增强，那么我觉得是需要做的。」
  ——为开源后的其他客户端（会把 signature 弄丢的那类）实现**同协议直通**路径的签名修复；
  边界刻到最窄（四元键、只回放真签过的、没坏不碰、4xx 作废、默认关零状态），
  完整回归 [`../test/thinking-replay-e2e.test.js`](../test/thinking-replay-e2e.test.js)（64 项断言）。
- **这条路径本身的价值**：一个被写进路线图、看起来"必须做"的特性，先用一天不到的核对证伪了它的**原始假设**，
  又在人群变化（开源）后按最小边界重启——两次转向都有测试与文档跟着走，而不是凭印象来回改。
