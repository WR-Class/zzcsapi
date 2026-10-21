# OpenCode Zen 免费模型反代研究（v1.18.72，**结论：两条路都通 —— 正路走本机 `opencode serve` 边车，已接入；直连那条要伪造客户端身份，不建议**）

> ## 结论先说
>
> **① 直连面通，但要伪造三样东西。** 把 `https://opencode.ai/zen/v1` 当普通 OpenAI 渠道去调免费模型，
> 默认永远 `403 FreeTierError`；**但门禁判的是报文里三个可自造的属性**：`User-Agent` 形状、
> `x-session-id` 的形状、system 是否以官方**标题生成器提示词的前 ≥965 字符**开头（外加必须 `stream:true`、
> 不带 `tools`）。三样齐了就是 **200 + 真 SSE 正文**。⚠️ **v1.18.71 写的「判据在报文之外，没有收敛点」
> 是错的**（§3 已改写，§9 补了第五/六条误判复盘）。
>
> **② 正路是边车，而且不伪造任何东西。** 本机跑着的 `opencode serve` **就是**被上游认可的那个客户端，
> 通过它自己的 HTTP API（HTTP Basic 鉴权）建会话并生成，免费模型**正常作答**：实测 `17*23` → **`391`**
> （2.7s）、随机口令回显一致、**4 路并发全中**、**8 连发 0 个 429**、边车冷启动 **0.64s**。
> 网关侧**已接入**为 `protocol:"opencode"`（v1.18.72），端到端实测见 §13。
>
> **③ 所以这道门的正解是"客户端身份"，而边车**就是**那个身份。** 我们**不需要伪造任何东西**
> ——跑真客户端即可，这不越过任何线。**直连那条路虽然可行，但它是明确伪造客户端身份**（假 UA + 自铸会话 ID
> + 借用官方提示词），而且能力被限成单轮纯文本，**网关接入刻意不走它**。
>
> ### ★ 本文件 v1.18.70 那一版是错的（第二次更正）
> v1.18.70 那版的标题是「结论：免费模型不可反代」，核心依据是
> 「**连官方客户端本体也 403**」——**那条实验是无凭据跑的**（隔离 XDG = 没有登录态），
> 它只证明了"未登录的真客户端被拒"，却被我当成了"真客户端被拒"。带上真实凭据重跑，**真客户端是通的**。
> v1.18.71 修好了一半（边车通），却把另一半写反了：**直连面同样是通的**，
> 我还把"没解开 `chunked`+`br` 两层导致的读不出正文"当成了"这些头不是必需的"。§9 误判 #4/#5/#6 是完整复盘。
>
> ### ⚠️ 用之前必须知道的两件事
> 1. **合规**：免费层条款写的是「can only be used from within OpenCode」。边车这条路跑的是**真客户端**，
>    **确实**是 "within OpenCode"（我们没有伪造会话/签名/设备证明）；**直连那条路则是伪造客户端身份**。
>    但**两条路都在把任意第三方流量中继进去，而这并不是这条免费层被设计出来的用途**，
>    且官方明说免费是「for a limited time」。**拿它当生产底座有风险，有账号被封的可能**——这是你的决定，不是技术障碍。
> 2. **它不是"直连上游"**：正路的链路里必须有一台**登录过 opencode 的机器**在跑边车。网关（容器）与
>    边车之间是本地 HTTP，见 §5.4 的部署姿势。直连那条路不需要边车，但见 ①。

本文按"逐条证据 + 复现命令"写，供后来者复核而不是重新踩一遍。

---

## 1. 上游事实与端点

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 官方文档 | 「OpenCode Zen」是**可选按量付费**模型服务；免费模型「free on OpenCode **for a limited time**」 | `/docs/zen/` |
| 公共目录（活） | `GET https://opencode.ai/zen/v1/models` → 87 个，其中 **11 个**带 `-free` | 本机实测 200 |
| 客户端目录（边车） | 与公共目录**不是同一份**：带凭据 **42 个**、无凭据 **11 个**；两边**免费**清单也不同 | §5.2 实测 |
| 客户端 base URL | `https://opencode.ai/zen/v1`（`@ai-sdk/openai-compatible`，env `OPENCODE_API_KEY`） | 二进制内 `api:"https://opencode.ai/zen/v1"` |
| 文档给的免费路径 | `https://opencode.ai/inference/openai/v1/chat/completions` | `/v2/docs/console/api/inference/` |
| 文档 vs 现实 | 文档暗示免费模型可免密钥调用；**实测无密钥 403** | §3 |

**边车报出来的 10 个免费模型**（本机实测，带凭据）：

```
nemotron-3.5-super-vl-free   cat-jam-free              longcat-2.5-preview-free
space-bunny-free             mimo-v2.6-flash-free      step-5-preview-free
deepseek-v4.1-flash-free     muse-spark-1.3-contributor-free
nemotron-3.5-lightning-free  nemotron-3-ultra-free
```

复现：

```bash
curl -s https://opencode.ai/zen/v1/models | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.data.length);console.log(j.data.map(m=>m.id).filter(i=>i.includes('free')).join('\n'))})"
```

## 2. 两道**互相独立**的门（理解一切的前提）

现场最容易误判的一点：失败体有两种，含义完全不同。

| 失败体 | HTTP | 含义 | 谁决定 |
| --- | --- | --- | --- |
| `RegionError: This model is not available in your country` | 403 | **出口 IP 地区**不开放该模型 | 按 IP 判 |
| `FreeTierError: OpenCode's free tier can only be used from within OpenCode` | 403 | **客户端身份**不是 OpenCode | 与 IP 无关 |

**决定性实验（同一模型、同一时刻、只改出口）**：

| 出口 | `cat-jam-free` |
| --- | --- |
| 直连（CN，`loc=CN`） | `403 RegionError`（地区门先拦下） |
| 经 Clash `127.0.0.1:7897`（JP，`loc=JP`） | `403 FreeTierError`（**地区门过了**，换上客户端门） |

⇒ 地区门在客户端门**之前**；**换出口只让开第一道门，第二道原样还在**。
（顺带：用真实凭据打 11 个免费模型，8 个 `FreeTierError` + 3 个 `RegionError`
（`cat-jam-free` / `muse-spark-1.2-contributor-free` / `muse-spark-1.3-contributor-free`）
⇒ 地区门确实是**按出口 IP** 独立生效的。）

复现（`loc` 用 Cloudflare trace 读，比第三方 geo API 稳）：

```bash
curl -s -x http://127.0.0.1:7897 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc)='
curl -s -x http://127.0.0.1:7897 -X POST https://opencode.ai/zen/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'Authorization: Bearer public' \
  -d '{"model":"cat-jam-free","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

## 3. 直连面：**凭据不是判据**，但**报文形状是**（v1.18.72 改写）

### 3.1 先记住的结论

**凭据确实不是判据**（下表），**但"报文之外没有收敛点"这个推论是错的**——
判据就在报文里，而且是三样**完全可自造**的东西（§3.2）。这两句不矛盾：
下面这些变体之所以全 403，是因为它们**都缺 §3.2 的至少一条条件**，不是因为"给什么都一样"。

| 直连 `POST /zen/v1/chat/completions` | 结果 |
| --- | --- |
| 不带任何凭据 | `403 FreeTierError` |
| `Authorization: Bearer public` | `403 FreeTierError` |
| `Authorization: Bearer sk-AAAA…`（乱码） | `403 FreeTierError` |
| **`Authorization: Bearer st_…`（本机真实账号 OAuth token，39 位，有效期内）** | `403 FreeTierError` |
| 真 token + `X-Opencode-Org-Id` + `x-opencode-client: cli` + `UA: opencode/2.0.29` + `x-opencode-session` | `403 FreeTierError` |
| 付费模型（`glm-5.1` 等）无凭据 | **`401 AuthError: Missing API key.`** |
| 付费模型 + 真 token | `403 server_error: Model access is disabled` 或 `402 Insufficient account funds` |

**读法**：免费模型这一路上，**凭据给什么都没有区别**（`Authorization` 甚至不是必需项）；
付费模型那一路才会去看密钥（所以无凭据回 401 而不是 403）。
⇒ **免费层的门是"你是不是 OpenCode 客户端"，不是"你有没有钥匙"。**

### 3.2 ★ 门禁的三条条件（v1.18.72 实测，全部可自造）

三样**同时**满足就是 **200 + 真 SSE 正文**；缺任何一样都回 `403 FreeTierError`：

| # | 条件 | 判据 | 边界实测 |
| --- | --- | --- | --- |
| A | `User-Agent` 必须是 `opencode/<渠道>/<版本>/<名字>` 形状 | 4 段点分、首段为 `opencode` | `opencode/latest/2.0.29/cli` → 200、`opencode/latest/9.9.9/cli` → 200（版本随便）；`opencode/foo` → 403；`curl/8.0`、`Mozilla/5.0` → 403；**完全没有 UA → Cloudflare 400**（边缘层拦的，不是应用层） |
| B | `x-session-id` 必须是 `descending()` 形状的 `ses_…` | 见 §3.3 | 按该形状现铸的 ID **首次使用即 200**（无服务端注册表） |
| C | system 必须以官方**标题生成器提示词的前 ≥965 字符**开头，且 `stream:true`、**不带 `tools`** | 提示词全文 **2119 字符**（本机从 `opencode.exe` 抠出） | 前缀 `900/960/964` → 403，**`965` → 200**，`970/2119` → 200；`stream:false` → 403；带 `tools` → 403 |

**独立复核结果**（本轮由本文件作者自己重跑，不是转述）：

```
三条全满足                                    HTTP 200   ★ 正文="391"
全不满足（原始那发）                           HTTP 403   FreeTierError
只缺 UA / 只缺会话头 / 只缺 system 前缀         HTTP 403   FreeTierError
UA=opencode/latest/2.0.29/cli                HTTP 200   ★
UA=opencode/foo、curl/8.0、Mozilla/5.0        HTTP 403   FreeTierError
前缀 964 → 965                               HTTP 403 → HTTP 200  ★ 边界锐利
stream:false / 带 tools                       HTTP 403   FreeTierError
model=space-bunny-free / big-pickle /
      mimo-v2.6-flash-free                   HTTP 200   ★ 都真答了
model=gpt-6-astra（付费）                     HTTP 401   AuthError: Missing API key.
```

★ 关键推论：这不是"服务端签发凭证"那类机制。**注意边界 `965` 这种锐利的数字**——
它基本排除了"某种哈希/签名校验"，指向一个**朴素的字符串前缀比较**（服务端在判断
"这条 system 是不是我的标题生成器提示词"）。**这属于实现细节，随时可能被上游改掉**，
所以下面这条路**不适合作生产依赖**。

### 3.3 会话 ID 的形状（`descending()`）

权威出处是 `packages/schema/src/identifier.ts`（上游公开仓库）：

```ts
const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
const value = descending ? ~current : current        // descending() 取按位取反
// 12 位 hex 时间域 = value 的高 48 bit；后 14 位 = chars[byte % 62]
```

- 会话 ID = `"ses_" + 26 字符`（12 位 hex + 14 位 base62），**恰好 30 字符**。
- 实测边界（时间戳固定、只扫 counter）：`1/15/16` → 200；`100/4095` → 403。
  ⚠️ **"低 12 bit ≥ `0xff0`" 这条简化规则并不精确**——`counter=16` 时低 12 bit 已是 `0xfef`，
  实测仍 200；真正的边界落在 `0xf9b`（403）与 `0xfef`（200）之间，**具体判据未查明**。
  结论只取可靠的部分：**`descending()` + 小 counter 稳定通过**，别去手搓临界值。
- **不是服务端签发的凭证**：新铸的 ID 从裸 `tls.connect`、无任何前置握手、无账号的情况下**首次使用即 200**。
  ⇒ **不存在服务端会话注册表**（这一条推翻了我中途的假设）。

### 3.4 ★ 为什么仍然**不**把直连做成网关渠道

三条理由，任一条都够：

1. **它是明确伪造客户端身份**：假 UA + 自铸会话 ID + 借用官方提示词。边车那条路跑的是**真客户端**，
   一样能拿到免费模型，却**不需要伪造任何东西**。有正路就不走这条路。
2. **能力被限死**：`tools` 一律 403 ⇒ **没有原生工具调用**，只能文本仿真；
   单轮纯文本为主；模型被当成标题生成器用，输出天然偏短（要把它掰回助手得在提示词前缀后追加指令）。
3. **它踩在实现细节上**：`965` 这种锐利边界说明这是个朴素字符串比较，上游改一行就没了；
   而且它和边车**同样有封号风险**，还多背一条"伪造"。

⇒ **网关接入走 §5 的边车路**（已实现为 `protocol:"opencode"`）。本节保留，是为了留证
"这条路确实存在"以及"为什么没选它"，**不是**接入指引。

## 4. ★ 判决矩阵（核心实验：客户端身份 × 凭据，2×2 打满）

同一模型（`deepseek-v4.1-flash-free`）、同一出口、同一时间窗：

|  | **真客户端**（`opencode serve` / `run`） | **普通 HTTP**（`fetch` / `http2` / `curl`） |
| --- | --- | --- |
| **有真实凭据** | ✅ **200 真答**（`391` / `CRD41` / `W7Q3K` 逐字命中） | ❌ `403 FreeTierError` |
| **无凭据** | ❌ `503 Model unavailable` | ❌ `403 FreeTierError` |

这张表把两件事**同时**钉死：

- **第二列恒失败** ⇒ 光有凭据不够，"客户端身份"是**必要**条件。
- **第二行恒失败** ⇒ 光有客户端不够，凭据是**必要**条件。
- 第一格是唯一成功态 ⇒ 两者**合起来**才成立，而这个合成体就是**边车**。

⚠️ 注意第一行两格的差别**当时看着"不在报文里"**：我把真客户端发给上游的头部**逐字复制**（含
`authorization: Bearer st_…` 真 token、`x-opencode-org-id`、`x-opencode-client: cli`、
`x-opencode-project`、`x-opencode-session`×4 种别名、`b3`/`traceparent`），
用 `fetch` 与 `curl.exe` **两条独立通路**各打一遍，**8 个变体全部 403**。
HTTP/1.1 与 HTTP/2 各试过，同样 403。

**⚠️ 但"差别在报文之外"这个推论是错的**（v1.18.72 更正）：那些变体之所以全 403，
是因为**它们都缺 §3.2 的条件 C**（system 不以官方标题提示词开头）——
**"抄头部"抄不到那个条件，因为它在 body 里**。当时我得出的
"所以把头部抄全没有收敛点"是从"抄头部不奏效"跨到了"这条路不奏效"，
**跨错了**。真实情况是：**光抄头部不够，但报文里确实有可收敛的东西**（§3.2）。
详见 §9 误判 #5/#6。**不过接入仍然走 §5 的边车**——理由见 §3.4（不伪造 + `tools` 不被 403）。

## 5. ★ 真正可行的路径：本机 `opencode serve` 边车

### 5.1 为什么它能过

门要的是"这是 OpenCode"。`opencode serve` **就是** OpenCode 本体：它带着真实客户端身份与
真实凭据去访问上游。我们不去骗那道门，而是**让真客户端替我们说话**。

### 5.2 起边车（鉴权是 HTTP Basic）

```bash
# --hostname 127.0.0.1 --port <空闲端口>；用 OPENCODE_SERVER_PASSWORD 设 Basic 密码
#   用户名默认 opencode（env OPENCODE_SERVER_USERNAME 可改）
# 注意：若本机已有托管服务占着默认端口 49374，必须显式换端口
OPENCODE_SERVER_PASSWORD=<自设> opencode serve --port 49551 --hostname 127.0.0.1
```

凭据存在 `~/.local/share/opencode/opencode.db` 的 `credential` 表
（`integration_id='opencode'`、`type=oauth`、`methodID=device`；access token 前缀 `st_`）。
**本文不记录任何凭据值。**

#### 5.2.1 ★ 口令只从环境变量来，而且**「不设」不等于「不用」**（v1.18.72 补测）

这一段是被真实提问逼出来的——连问三次「这个变量在哪 / 钥匙框随便填行不行」，说明**它看着像"填个名字"，
其实是一个两处必须同值的共享秘密**。四条实测事实：

**① `serve` 没有 `--password` 这类参数。** `opencode serve --help` 的 FLAGS 只有
`--hostname` / `--port` / `--cors` / `--service` / `--stdio`（GLOBAL 是 `--help` / `--version` / `--wizard` /
`--completions` / `--log-level` / `--print-logs`）。⇒ **环境变量是设口令的唯一入口**，没有第二条路可走。

**② 它不是仓库里的某个配置文件，而是"起边车那个终端窗口里的一条临时设定"。** 你不敲它，它就不存在：

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'REPLACE_WITH_YOUR_OWN_PASSWORD'            # ← 执行完它才存在，边车才知道口令是这个
opencode serve --port 49551 --hostname 127.0.0.1
```

`$env:` 只活在**当前窗口**。窗口关掉 / 边车重启就要重设；要跨重启就 `setx OPENCODE_SERVER_PASSWORD "<值>"`
（写进用户环境变量，之后新开的窗口都有）。

**③ ★ 不设它，边车会"自己造一个口令"，而且把它打进 stdout 日志。**

```text
server listening on http://127.0.0.1:49611
server password <边车自己生成的随机串>
```

⇒ 「不设 = 省得对齐」这条路是**堵死的**：边车**永远**有口令。实测（同一边车，四次对照）：

| 打法 | 结果 | 含义 |
| --- | --- | --- |
| ① 完全不带 `Authorization` | **401** | 未设口令**不是**无鉴权 |
| ② 带我起边车时设的那个值 | **200** | 正路 |
| ③ 随便填一个（`whatever-i-like`） | **401** | 「随便填」不成立 |
| ④ 口令对但用户名写成 `admin` | **401** | 用户名也是判据的一部分 |

所以**自己设比不设更省事也更干净**：自己设，值是你知道的、干净的一串；不设，你得去日志里把那串
难抄的随机串抠出来，而且**它还躺在日志文件里**——日志本身就是一条泄露面（别把边车日志分享出去）。

**④ 渠道「API Key」框 = 上面那个**同一个值**。** 网关把它当 HTTP Basic 密码发给边车
（`opencode.js` 的 `basicAuth()`：用户名默认 `opencode`，密码 = 渠道 `apiKey`）。所以：

- 值的**内容**随你定（门户不校验它——上游认的是"你是不是被认可的那个客户端"，见 §4 的 2×2 矩阵）；
- 但**两处必须同一个值**：起边车的那处「定」它，控制台的钥匙框那处「递」它；不同源 → 401（上表 ③）。
- ⚠️ **别带冒号**：`basicAuth()` 把 `user:password` 形态当语法用（`raw.indexOf(':')`，第一个冒号前那段当用户名），
  这是为「改过 `OPENCODE_SERVER_USERNAME`」留的口子，口令里带冒号会被拆开。
- ⚠️ 这个值会落进网关的 `config.json`（已 gitignore），与其它渠道 `apiKey` 同级——**不要贴进对话/文档/截图**。

一句话记法：**`OPENCODE_SERVER_PASSWORD` 就是「渠道钥匙框里要填的那个值」的真名；你先决定它是什么，
然后在两处都写它。**

### 5.3 调它（118 条 OpenAPI 路径，`GET /openapi.json` 可自取）

只需两条：

```bash
# ① 建会话（模型在这里就定了；也可以后接 POST /api/session/{id}/model）
POST /api/session          {"model":{"id":"deepseek-v4.1-flash-free","providerID":"opencode"}}
  -> 200 {"id":"ses_…"}

# ② 生成（一次性、同步返回纯文本）
POST /api/session/{id}/generate   {"prompt":"What is 17*23? Reply with only the number."}
  -> 200 {"data":{"text":"391"}}
```

**踩过的形状坑**（都是 400 `InvalidRequestError`，报文根本没发出去）：

| 想当然的写法 | 真 schema | 错因 |
| --- | --- | --- |
| `{"modelID":"…","providerID":"…"}` | `{"model":{"id":"…","providerID":"…"}}` | `Missing key at ["model"]` |
| `{"parts":[{"type":"text",…}]}` | `{"text":"…"}` | `Missing key at ["text"]` |

（`/api/session/{id}/prompt` 也是 `{"text":…}`；`/api/session/{id}/generate` 是 `{"prompt":…}`。）

### 5.4 实测数字（本机，v2.0.29 客户端）

| 指标 | 实测 |
| --- | --- |
| 冷启动到 `/openapi.json` 可读 | **642 ms** |
| 建会话 | 9–37 ms |
| 免费模型 `generate` | **1.8–4.1 s**（`17*23`→`391`，随机口令逐字命中） |
| **4 路并发** | 全部 200 且答案正确，墙钟 **3.5 s** |
| **8 连发** | **8/8 成功，0 个 429** |
| 流式 | `generate`/`prompt` **都没有 `stream` 参数** ⇒ 只能伪流式（整段一次下发，同 hark） |
| token / 费用记账 | **接口不下发**（`/message` 里也找不到 `tokens`/`cost`）⇒ 网关侧只能按字符估 |
| **同一会话多轮记忆** | ❌ **不保留**（turn2 拿不回 turn1 的信息，实测空回复） |
| **把历史拍平进一个 prompt** | ✅ **有效**（system + 多轮拼成一段文本，模型正确答出仅存在于历史里的口令） |
| 免费 vs 付费 | 免费 → 正常；付费 → `503 Insufficient account funds` / `Model unavailable` |
| 无凭据边车 | 目录只剩 11 个模型，生成回 `503 Model unavailable` |

⇒ **接入姿势**：无状态、**每请求把 messages 拍平成一段 prompt**（不要把多轮记忆押在会话上），
拿回纯文本再包成客户端要的响应。

### 5.5 部署姿势（网关在容器里时）

边车跑在**宿主机**（它需要你的 opencode 登录态与 212MB 二进制），网关容器通过
`host.docker.internal:<port>` 访问——这与本项目 `proxy` 字段用
`host.docker.internal:7897` 的既有做法同型。**边车必须在网关之外**：
容器里没有你的登录态，装进去也没用。

### 5.6 ★ 边车 1.0+ 换了生成 API（2026-10-21，边车 1.4.2 实测）

§5.2–§5.5 的所有结论都是在 **0.x 那代边车**上测的。omnirush desktop 自带的这份已经升到 **1.4.2**，
**生成路由消失了**，而且失败形态极其安静——这一节是全部现场记录，别再用"老写法为什么不行"重新走一遍。

**① 老路由不存在，但服务端不会告诉你**。`POST /api/session/{id}/generate` 在 1.4.2 上回的是
**`200` + `text/html`（2884 字节的 SPA 兜底页）**——因为边车是个 SPA，**任何不存在的路径都吐 index.html**。
只认 `data.text` 的代码会走到 `safeJson()` 拿到 `null`，于是失败原因被写成"形状不对"；
而如果哪天有人"顺手"放宽成"拿不到 `data.text` 就用原文"，那就更糟：**一张网页会被当成模型的回答发给客户端**。
⇒ 处置：`opencode.js` 新增 `isHtmlBody()`，**任何一处收到 HTML 一律判失败**，错误文案直接点明"回了 HTML＝路由不存在"。

**② 正确的新路由**（用边车自带的 OpenAPI 文档 `GET /doc` 查到 162 条路由，权威）：

```
POST /session/{id}/message   {"parts":[{"type":"text","text":"…"}]}
  → 200 {"info":{…,"tokens":{total,input,output,reasoning,cache:{read,write}},"cost":0,"finish":"stop"},
         "parts":[{"type":"step-start"},{"type":"reasoning","text":"…"},{"type":"text","text":"…"},{"type":"step-finish"}]}
```

同步返回，本机实测 **7.1–9.1 s**（比 0.x 的 1.8–4.1 s 慢，见④）。三个坑：

| 坑 | 现象 | 处置 |
| --- | --- | --- |
| **没有 `/api` 前缀** | `/api/session/{id}/message` 只有 **GET**；对它 POST 拿到的是 SPA 兜底页 | 打 `/session/{id}/message` |
| **`reasoning` part 也带 `text` 字段** | 把所有 `parts[].text` 拼起来 = 把**思维链**当回答 | 只拼 `type==="text"` |
| **`/session/{id}/wait` 不可用** | `503 {"message":"Session wait is not available yet"}` | 别指望 wait；`/message` 本身就是同步的 |
| **`/api/session/{id}/prompt` 是异步受理** | 200 只回 `{data:{admittedSeq,…}}`，之后 60 s 内 `GET /api/session/{id}/message` **始终只有 user 那条** | 那条路要自己轮询/订阅，别用 |

**③ token 现在有真值了**：`info.tokens.{input,output,reasoning,cache.read}` + `info.cost`（免费模型 `cost=0`）。
网关账本改成"**有真值用真值、没有才按字符估**"，并在 `note` 里写明这一条是哪种口径。

**④ ★ 边车把 cwd 当项目根，会把整个项目塞进每一发请求**（这条最贵）：同一个边车，从**仓库目录**起时
一发"回个口令"的输入是 **`tokens.input=50627`**；把 cwd 换成**空目录**后同样的请求是 **8136**
（剩下的是边车自己的系统提示 + 工具定义）。⇒ 既白烧额度、又**把源码递给免费层**、还多花 1–2 s。
`deploy/opencode-sidecar.ps1` 因此强制 `-WorkingDirectory <空目录>`。

**⑤ 边车要由网关自己起，不能蹭别的应用的**（v1.18.89）。事故现场：渠道指 `host.docker.internal:49551`，
那是 omnirush desktop 自己拉起的边车；它重启后**端口与口令两个都漂了**，网关于是按
`health.intervalSec=300` 每 5 分钟敲一次，8.7 小时里落下 **87 条 `opencode: 连不上边车：AggregateError`、0 条成功**
（`AggregateError` ＝ `fetch` 双栈都被拒：`ECONNREFUSED@192.168.65.254:49551` + `ENETUNREACH@fdc4:…::254:49551`；
同一时间窗里其它渠道 **411 条成功** ⇒ 这不是"网关坏了"，是一条渠道孤零零地在敲死端口）。
⇒ `deploy/opencode-sidecar.ps1`：端口写死 4666、口令只从 `.env` 的 `OPENCODE_SIDECAR_PASSWORD` 来、
启动前查端口（幂等）、起完自检 `GET /api/model` 必须 2xx 否则大声失败。
⚠️ 两个边车**共用同一个数据目录**（`~/.local/share/opencode/opencode.db`，凭据在 `credential` 表里）：
好处是 omnirush 重启不再影响网关；代价是**两个进程共用一个 SQLite**（锁竞争面），
所以**不要**为了让它们互不干扰去复制 db——复制会让 OAuth refresh token 分叉，两边互相踢下线。

## 6. 其它探过的面

| 尝试 | 结果 | 读法 |
| --- | --- | --- |
| `POST /zen/go/v1/chat/completions` | `400 MissingSessionID` | `go` 面**要求服务端签发的会话**；编不出来 |
| `POST /zen/v1/responses` | `403 RegionError` | 换 API family 不绕过任何门 |
| `POST /zen/v1/messages` | `403 FreeTierError` | 同上 |
| `POST /zen/v1/systemone` | `451 Upstream request failed: Endpoint is unavailable.` | 服务端整块不可用 |
| `GET /inference/v1/{me,auth,session,install,free}` | 全 `404` | 没有"换身份"的公开端点 |
| `/inference/openai/v1/chat/completions` | `403 FreeTierError` | 与 `/zen/v1` 同一道门 |

唯一白捡的：`/zen/v1/models` 的 CORS 预检列出 `X-Opencode-Org-Id`，
`/zen/go/v1` 点明 `x-opencode-session`——名字都对，值拿不到（也不用拿了，见 §5）。

## 7. 付费面（仍是不需要新协议的那条路）

同一套端点的**付费**面是标准 OpenAI 兼容：

- 无密钥 → `401 AuthError: Missing API key.`
- OpenAI 家族：`/zen/v1/chat/completions` + `Authorization: Bearer <key>`
- Anthropic 家族：`/zen/v1/messages`；GPT 家族：`/zen/v1/responses`

⇒ 现有 `protocol: "openai"` + `baseUrl: https://opencode.ai/zen/v1` 即可
（`buildOutgoingUrl` 拼 `{base}/chat/completions`、probe 走 `{base}/models`，都对得上）。
⚠️ **baseUrl 必须带 `/zen/v1`**：`https://opencode.ai/zen` 会 404。

**免费 vs 付费的选择**：付费走现有协议、零改造但要钱；免费走边车、不要钱但要**新协议 + 一台
登录过的边车**（见 §10）。

## 8. 现状：你**已经**在中继上消费 opencode 系免费模型

`config.json` 里没有 `opencode` 协议的渠道，但有**中继**在做这件事：

| 渠道 | 协议 | 启用 | 别名 → 上游 | 现状 |
| --- | --- | --- | --- | --- |
| `20110318` | openai | **是** | `jev-1.13` → `自建opencode-1-中转-jev-1.13-free` | **503** |
| `bynara` | openai | 否 | `deepseek-v4.1-flash-free` → 同名 | — |
| `121628` | openai | 否 | `deepseek-v4.1-flash-free` → 同名 | 待办 #2 那个 503 |
| `apmix` / `apmix1` | openai | 否 | `gpt-6-luna-free` → 同名 | — |
| `freeapi` | openai | 否 | `容易满载/deepseek-v4.1-flash:free` → 同名 | — |

`20110318` 的真实上游错误：

```
No available channel for model 自建opencode-1-中转-jev-1.13-free under group default (distributor)
```

**判读**：瓶颈**不在网关、也不在 opencode 免费层**，而在**那家中继自己的上游容量**。
注意它的**别名是 `jev-1.13`、上游名却是 `自建opencode-1-中转-jev-1.13-free`** ——
上游 id 一改名这条就静默 503。

## 9. 六次误导（留档，别重犯）

| # | 现场现象 | 我的错判 | 真因 |
| --- | --- | --- | --- |
| 1 | "日志代理"端口上 `GET /zen/v1/models` 回 **200** | 以为抓到了真客户端报文 | **端口被 Docker backend 占着**；我的 node 早就 `EADDRINUSE` 退出。**"探针报成功"必须先验证探针自己活着** |
| 2 | 真客户端 `run` 回 `UnknownError … Unexpected server error` | 读成"上游拒绝了真客户端" | 是**客户端本地** `ProviderModelNotFoundError`，**报文根本没发出去**。**谁报的错要读原文** |
| 3 | 免费模型带任意 `Authorization` 都是 403 | 怀疑"要给一枚形状对的 key" | 这一路**根本不按密钥判**；付费面才判（所以回 401） |
| 4 | 真客户端（**隔离 XDG、无登录态**）`run` → `403 FreeTierError` | **当成"连正主都过不去"，并据此写下"免费层不可反代"** | **那条实验缺了登录态**。带上真实凭据重跑 → **真客户端是通的**（§4 第一格）。★ 教训：**"缺一个自变量"的失败实验，不能当成该方向的否定证据**——尤其当被隔离掉的正是"要不要登录"这种**前提性**变量时。本文件上一版（v1.18.70）整篇结论就是被这一条带偏的 |

> 上一版 §11 其实**自己写下了**这条风险：「本机没有 opencode 账号凭据，登录态这一维度**未测**
> （这是本结论唯一可能翻盘的变量）」——**它真的翻盘了**。以后再写这种"唯一可能翻盘的变量"，
> 应当**先把它测掉再下结论**，而不是留作免责声明。
>
> ### #5（v1.18.72 新增）★ **把"没解开 `chunked` + `Content-Encoding: br` 两层"当成了"上游没回正文"**
> **现场**：早期几轮探测里，好几组请求头看起来"是不是 FreeTierError 都无所谓"，据此得出
> "这些头不是必需的、门在报文之外"。
> **错判**：那些 403 的正文其实**全是** `FreeTierError`，只是响应是 `chunked` 且 `br` 压缩的，
> 没有逐层解开时正则匹配不到，于是**把"自己没读懂"读成了"上游没这么说"**。
> **真因**：403 的正文被压缩了，**判据（和结论）就在那段没被读出来的正文里**。
> **教训**：**"解析失败"与"内容为空"必须分开报**。本项目在 notion 探针那边已经栽过一次同类
> （`Accept-Encoding: identity` 是那边的硬要求），这次是在**没有那层保护的新探针**里重犯。
> 凡是"响应体读出来是乱码/空"的场合，先当成**解码问题**查，不要当成上游的语义。
>
> ### #6（v1.18.72 新增）★ **把会话 ID 的"值"读成了"服务端签发的凭证"**
> **现场**：看到真客户端抓包里的 `ses_…` 与我们自铸的 ID 报告结果不同，先入为主认为
> "ID 必须是服务端签发/注册过的"。
> **错判**：以为要搞到一枚合法 ID 才能进（那确实就等于"门在报文之外"）。
> **真因**：它只是 `identifier.ts` 里 **`descending()` 这一条可自造的格式约束**——
> 新铸的 ID **首次使用**、从裸 `tls.connect`、无账号就 200，**不存在服务端注册表**。
> **教训**：**"我们造的值不通过"要先排除"我们造得不对"，再考虑"它必须是别人给的"。**
> 这次的判别方法很便宜：**固定时间戳只扫 counter** → 边界立刻现形（§3.3）；

## 10. 结论：能不能接进网关

| 方案 | 可行性 | 处置建议 |
| --- | --- | --- |
| 直连反代**免费**模型（当普通 openai 渠道） | ⚠️ **技术上可行，但刻意不做** | 要同时伪造 UA + 自铸会话 ID + 借用官方提示词（§3.2），**且带 `tools` 一律 403**（没有原生工具调用）。有正路就不走这条路 |
| **`opencode serve` 边车 + 新协议** | ✅ **可行，已实测，已接入** | **v1.18.72 已实现** `protocol:"opencode"`（§13）。`baseUrl = http://host.docker.internal:<port>`，出站 `/api/session` + `/api/session/{id}/generate` + **用完即删**，**每请求把 messages 拍平成一个 prompt**，工具走文本仿真（**实测可用**）。⚠️ 需要一台**跑着边车且已登录**的机器；⚠️ 合规与封号风险见文首 |
| 普通渠道接**付费**模型面 | ✅ 可行 | 现有 `protocol:"openai"` + `baseUrl: https://opencode.ai/zen/v1`，**不需要新协议**，但要充值 |
| 继续用**中继**消费免费模型 | ⚠️ 可行但不可控 | 已有五条；瓶颈在中继自己（§8） |

**本项待办的答案**：**能反代。** 反代对象是**本机边车**，不是 `opencode.ai`（直连那条要伪造身份，故意不选）。
边车这条路已活体验证并**已完成网关接入**，代价是**一台常驻且已登录的边车 + 合规风险**。
若只想"用上 opencode 上的模型"，付费面与中继都不需要新协议。

## 11. 复现命令汇总（只读、低额度）

```bash
# ① 公共目录与免费清单
curl -s https://opencode.ai/zen/v1/models

# ② 直连免费层：这样打（缺 §3.2 任何一条）都是同一个 403
#    ⚠️ 本节刻意**不给**能通的那份报文的可复制版本——那条路要伪造客户端身份，
#       记录它的存在是为了留证（§3.2），不是接入指引。要接就用 §5/§13 的边车。
curl -s -X POST https://opencode.ai/zen/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
curl -s -X POST https://opencode.ai/zen/v1/chat/completions -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'

# ③ 付费面在等真 key（401 而不是 403）
curl -s -X POST https://opencode.ai/zen/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.1","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'

# ④ 地区门 vs 客户端门（对 cat-jam-free 交错打）
curl -s https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc)='
curl -s -x http://127.0.0.1:7897 https://www.cloudflare.com/cdn-cgi/trace | grep -E '^(ip|loc)='
```

配套工具：

- `node opencode-probe.js` —— **直连面**判决探针（只读、脱敏、低额度）。判"两道门"用。
- `node opencode-sidecar-probe.js` —— **边车面**判决探针（只读、脱敏、低额度）。
  自己起一个临时边车、跑一发随机口令，判"边车这条路在**这台机器上**通不通"。

## 12. 未找到证据 / 未做的事

- **没做**任何伪造：没有伪造会话、没有逆向签名、没有构造设备证明。
  §5 的路子是"跑真客户端"，不需要伪造。（§3.2 里那条**可伪造**的直连路只做了复核实验，
  **没有**把它写进网关，也**不建议**这么用。）
- **未测**：免费层**是否长期稳定**（官方明说 limited time）；边车的**上游配额上限**
  （8 连发未见 429，但没有打到限流点，也没有找到配额接口）。
- **未测**：边车在**多账号 / 多并发长跑**下的表现，以及封号风险的实际边界。
- **未查明**：§3.3 里 `descending()` 会话 ID 的**精确判据**——只知道 counter 的边界落在
  `0xf9b`(403) 与 `0xfef`(200) 之间，"低 12 bit ≥ `0xff0`"这条简化规则已被证伪（`counter=16` 就 200）。
  网关接入不依赖它（我们走边车，边车自己管会话 ID），所以没有再往下挖。
- 二进制是**编译产物**（Bun 单文件 ~200MB），本文的"源码"引用均为**字符串 + 上下文**，
  非原始 TS；函数名可能与上游仓库不同名。标题生成器提示词（2119 字符）就是从该二进制里
  **按 NUL 定界抠出来的**，非转述。

## 13. ★ 网关接入现状（v1.18.72，已实现并活体验证）

**协议名 `opencode`**，实现落在 `opencode.js`（出站）+ `server.js` 的 `tryOpencodeChannel`（收口）。

**链路**：`POST /api/session {model:{id,providerID:"opencode"}}` → `POST /api/session/{id}/generate {prompt}`
→ **`DELETE /api/session/{id}`（成功失败都删）**。会话 id 读 `data.id`（**顶层没有 `id`**，写错会静默 undefined）。

**四个必须守住的点**（每个都写进了 `test/opencode-channel-e2e.test.js`）：

| # | 纪律 | 为什么 |
| --- | --- | --- |
| 1 | **用完即删** | 会话落在**用户自己账号**下；漏删 = 每次网关请求堆一条会话，**而请求照样成功**（不跑测不出来） |
| 2 | **每请求拍平 messages** | 边车**不保留多轮记忆**（实测）；"复用会话省一次建会话"看着聪明，实际丢上下文 |
| 3 | **不给边车传 `stream`** | 该端点没有 stream 参数；真流式只能由网关**伪流式**伪造 |
| 4 | **200 + 空正文 = 失败** | 与 v1.18.26/32 同一条纪律："上游回 200"≠"客户端拿到了东西" |

**另外三条工程决定**：

- **只列免费模型**：边车目录带凭据时 42 个，其中 32 个付费模型在这台机器上必定
  `503 Insufficient account funds` —— 列进别名表就是给用户塞一批"存得下、永远失败"的渠道
  （v1.18.49「加上了却用不了」那一类现场）。所以探测只回 `/free$/` 那批。
- **它不属于"无目录协议"**：边车**有** `GET /api/model` 目录 → 不适用 hark/workbuddy/genspark/codex
  那两条硬要求（默认别名建议 + 零别名拦截），`autoAlias` 也能照常工作。
- **不给它配 `proxy`**：边车是**本地上游**（`host.docker.internal`），`proxy` 是给"出公网"用的。
  这也是它与 hark/genspark 的分野——那两个要 curl 子进程 + 代理，opencode 走注入的 `zzFetch` 即可。

**脱敏**：`GET /api/model` 每条模型都带 `headers:{"x-opencode-org-id":…}`（账号标识）。
网关**只取 `id`**，绝不把原始目录透进渠道列表、账本、日志或文档。e2e 用例专门用假边车在目录里
放了一个哨兵串，断言它不出现在探测响应里。

**真活体端到端结果**（真起 `opencode serve` + 真起网关，走真免费模型）：

```
① 边车就绪，目录 42 个模型
② 非流式单轮          HTTP 200  5793ms  正文="LIVE-OK-1"
③ 两轮历史（验拍平）   HTTP 200  2557ms  正文="GRANITE-42"   ← 上文真的带过去了
④ 流式（伪流式 SSE）   HTTP 200  5504ms  帧数=4 收尾=[DONE] 正文="1\n2\n3"
⑤ 工具仿真            HTTP 200  4741ms  tool_calls=[read_file{"path":"C:\\temp\\note.txt"}]
⑥ 会话清理            边车会话数 37 → 37  ★ 相等
```

⑤ 是关键：**工具调用真的能用**——模型按注入的协议回了 `[TOOL_CALL]` 标记，
网关把它还原成了标准 `tool_calls`。所以这条渠道不是"只能闲聊"。

⚠️ **它仍然有封号风险**（见文首）：免费层条款是 "can only be used from within OpenCode"。
网关侧刻意选了**不伪造**的那条路，但"把第三方流量中继进免费层"依然不是该层的设计用途。
