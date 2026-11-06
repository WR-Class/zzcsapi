# magpie 研究（`yetone/magpie`）

> 研究日期 2026-11-06。对象：<https://github.com/yetone/magpie>，`main` 分支提交 `80ae904`。
> 全部数字与结论都来自**实测**（GitHub API + 浅克隆 + 读源码），命令见文末「复现」。

## 0. 一句话

**它不是一个"反代网关"，是"本机 agent 的模型总闸 + 账号编排器"。**
Claude Code 用的是 Kimi，Codex 用的是 DeepSeek，Gemini CLI 用的是 GLM——在一个菜单栏里点一下换掉，
底下是 `127.0.0.1:3425` 的一个本地网关，四个 wire API 互译，配额用完了自动换下一个账号/下一个模型。

和本项目的关系：**场景不重叠，机制有四处值得抄。**（§4 逐条）

## 1. 规模与状态（2026-11-06 实测）

| 项 | 值 |
| --- | --- |
| 创建 / 最后推送 | 2026-09-23 / 2026-11-06（今天） |
| Stars / Forks / Open issues | **31,131** / 2,708 / **3,295** |
| 语言 / 许可 | Go 1.26.8 / MIT |
| 仓库大小 | 279,881 KB（约 273 MB） |
| 文件数 | 8,205（其中 `internal/` 7,225） |
| 已检出的 2,612 个文件 | **1,832 个是 `_test.go`**，Go 代码 **525,099 行** |
| `internal/gateway` | 292 个非测试文件 + **1,124 个测试文件**；`gateway.go` 单文件 **422 KB** |
| 默认端口 | `3425`（`internal/settings/settings.go:1790` `DefaultPort`） |

六个星期冲到 3.1 万星、3,295 个未关 issue、单文件 422 KB——**这是"作者一人高速迭代 + 社区灌 issue"的形态**，
和本项目的"慢、有守卫、64 文件 3125 断言"是两种工程哲学。评估它时要看清这一点（§5）。

**治理上一条硬事实：这个仓库不接受 PR**（`allow_forking` 但 `pull_request_creation_policy: collaborators_only`，
README 明写"想要功能去 Discord 说"）。⇒ **你不能给它打补丁，只能等作者**。这决定了它对你只能是"参考"，
不可能是"依赖"。

## 2. 它到底由什么组成

单个 Go 二进制，四种皮：**Wails v3 桌面 GUI + Bubbletea TUI + CLI + Docker/web UI**（`go.mod` 里
`wailsapp/wails/v3`、`charmbracelet/bubbletea`、`moejs`（JS 运行时绑定）、`modernc.org/sqlite`）。

网关面（`gateway.go` 的 `routes()`，逐条读过）：

```
/v1/chat/completions  /chat/completions          OpenAI Chat
/v1/responses         /responses                 OpenAI Responses（还支持 GET + WebSocket：responses_ws.go）
/v1/messages          + /v1/messages/count_tokens Anthropic Messages
/v1beta/models + /v1beta/models/{call...}         Gemini
/api/chat  /api/tags  /api/show  /api/version     Ollama 兼容（!）
/v1/native/{provider}/{path...}                  原生透传
/codex/…  /v1/systemone                           ChatGPT Codex 后端、System One
/mcp/{name}  /mcp/run/{name} + search/vision/image/browser/tools/hub MCP   网关自己当 MCP hub
/v1/images/generations|edits  /v1/embeddings  /v1/rerank  /v1/audio/*  /v1/videos
/v1/magpie/*（quotas / usage / route / trace / concurrency / limit / statusline）  观测面
keys 签发 / OIDC / 远程 magpie / 键页面            多租户面
heap / CPU / goroutine profile、restart-to-update  诊断面
```

**关键认知**：它比"四个协议互译"做得宽得多——**还兼做 MCP 服务器宿主、图片/视频/音频/嵌入的中转、
以及 agent 配置文件的改写器**（`internal/agent/` 155 个非测试文件，一个 agent 一个文件，覆盖 62 个客户端）。

## 3. 七个值得记的机制

### 3.1 IR 中间表示做四协议互译

`internal/gateway/ir.go` 头部自己写了：

> The APIs are close cousins; everything below is the shape they have in common.
> A request is parsed into it, and a reply is produced from it.

请求 → 共同结构（IR）→ 目标协议报文；回复同理。**O(N×M) 的逐对转换器变成 O(N+M)。**
配套文件：`anthropic.go`(70KB)、`anthropic_shapes.go`、`chat.go`、`responses.go`(88KB)、`gemini.go`、
`chattidy.go`(39KB)、`textcalls.go`(32KB，文本工具调用仿真)、`affinity.go`(54KB，缓存亲和)、
`fastjson.go`(54KB，自写 JSON 快路径——性能敏感到这个程度)。

### 3.2 每个 agent 一枚子 token

```go
func TokenFor(agent string) string { return Token + "-" + agent }   // gateway.go:59
func agentOf(r *http.Request) string { ... }                        // gateway.go:63
```

一把主 token，按**调用方 agent** 派生子 token（`Token-<agent>`），网关据此知道"现在是 Claude Code 在问、
还是 Codex 在问"，从而应用不同的模型选择。还有 `codexForClaudeCode(h)`——从请求头认出"Claude Code 其实要 Codex"。
**用身份而不是配置来表达"谁在用"，这是它整个换模型体验的支点。**

### 3.3 账号/订阅编排：5 种路由 + 6 步排序 + 会话黏性

`docs/reference.md` L1764-2216 是一份完整规格（约 450 行），要点：

- 五种路由：`smart`（用完前最浪费的机制：谁先重置先用谁）/ `order` / `rotate` / `usage`（最少用的先）/
  `pace`（剩余份额 ÷ 剩余小时数，最高的先用）。
- 六步排序：能答的 → 路由排序 → 429 的垫后 → provider 兜底模型 → **休息中的垫后（但永不剔除）** → 会话所在账号提到最前。
- **缓存感知的黏性**（这条最细）：一个会话一旦被某账号答过，只要"上一发从缓存读了、且读写合计 ≥1024 token、
  且 5 分钟内答过"，就一直留在那个账号上——**因为 prompt cache 还值钱**。首轮读不到（缓存是空的），
  第二轮才读到，所以第二轮起才黏。98% 用量的账号不再被拉回，`Stays: Strict` 则宁可直接报错也不换。
- 配额按**窗口**（5 小时窗 / 周窗 / 月窗 / credits）各自算，跨窗口取最满的那个。

### 3.4 按 vendor 逐个分类失败

`routing.go` 里是一堆**厂商专属判据**，不是通用正则：

```
dashScopeRate(p, status, body)      // 百炼的限流长什么样
googleSuspended(p, status, body)    // Google 封号/停用
openRouterSharedPool(body)          // OpenRouter 共享池
restrictedRefused / restrictedSaid  // 区域/政策拒绝
plainForbidden / plainUnavailable   // 401/403 vs 503
creditBackoff(id, header, body, now) // 从 Retry-After / 响应体推冷却时长
```

冷却是**贴着上游真实 reset 算的**（"out of credit 半小时 / out of quota 直到它说重置 / 429 直到它说重试 /
否则一分钟且每失败一次更长"），不是固定指数退避。**本项目的熔断分级（`docs/scheduling.md`）是同一种思路，
但 magpie 多走了一步：把"什么时候真的回来"写进 trace，Routing 页面直接显示。**

### 3.5 隐私脱敏（`internal/redact` + `internal/pii`，重得惊人）

`redact.go` 文件头把设计说清了，三条都值得记：

1. **占位符 = 值的 keyed hash**（HMAC-SHA256 → base32，形如 `{{API_KEY_k3v9x2mq}}`），**不是序号**。
   于是"同一个值永远是同一个占位符"——会话历史逐轮一致，**prompt cache 仍然命中、thinking 的 signature 仍然对得上**。
2. **只在内存**：重启丢光也没关系，下一次请求会再带上来。落盘的记录只留种类、长度、前几个字符。
3. **流式还原**：流里的文本和工具调用参数都要还原，所以 agent 真正跑的命令里是真 key。

规则侧还有中文专属文件：`zhname.go`(19KB) / `zhpassword.go` / `dateword.go` / `fieldvalue.go`(13KB)——
中文姓名、中文密码、日期词、字段值。**脱敏默认关**（Settings → Privacy），开了跑不动就拒发（503）而不是原样发出。

`internal/pii/` 是可选的那一层"本机小模型"（1.6 GB，跑 CPU），找规则找不到的姓名/地址/密码。

### 3.6 插件 = Bun + 中间件

`internal/plugin/`：插件跑在 **Bun**（首次用到时下载），`moejs` 做绑定。除了"当一个 provider"，
第三种形态是**网关中间件**：`onRequest` 可改写/拒绝请求，`onEvent` 看每个流事件，`onResponse` 看整条回复；
钩子抛异常或超时就"请求原样放行"。社区插件仓库里有一批**对齐 New API 语义**的中间件
（`param-override` = `param_override`、`model-map` = `model_mapping`、`word-guard` = 敏感词过滤、`think-tags`）。

### 3.7 订阅当 provider（这台机器上最"重"的一招）

- **Claude**：不是打 API，而是**驱动本机真的 `claude` 二进制**，把 agent 的工具通过 MCP 桥过去
  （`claude_subscription.go` 254 KB + `claude_warmup.go`）。
- **Codex/ChatGPT**：走 ChatGPT 后端（`codex_backend.go` 164 KB）。
- 账号从本机**发现**：读 Claude Code / Codex 的登录文件与 Keychain（`magpie accounts discovery off` 可关，
  `MAGPIE_NO_ACCOUNTS=1` 单次关）。
- **Daily warm-up**：在指定时间点把 Claude/ChatGPT 账号的 5 小时窗"提前开"，或在上一个重置的瞬间开——
  这是把"配额窗口"当资源来经营。

## 4. 与本项目的对照

| 维度 | magpie | 本项目（zzcsapi） |
| --- | --- | --- |
| 形态 | Go 单二进制 + GUI/TUI/CLI/Docker | Node 零依赖 + `server.js` 单进程 + 内嵌控制台 |
| 服务对象 | **本机上已装 agent 的单个开发者**（换模型、多账号） | **一组客户端/多人**的多协议反代网关 |
| wire API | Chat / Responses / Anthropic / Gemini **+ Ollama 兼容 + MCP hub** | Chat / Responses / Anthropic / Gemini（`docs/protocols.md`） |
| 协议互译 | IR 中间表示（O(N+M)） | 逐对转换器 + 专用报文渠道的输出收口 |
| 上游种类 | API + **订阅（驱动官方客户端）+ 本地模型 + 插件** | API 反代，12 种协议（含 notion/hark/workbuddy/genspark/codex/opencode 逆向） |
| 调度强项 | **配额窗口**（5h/周/月/credits）+ 缓存亲和 + 6 步排序 | **渠道健康**（熔断冷却分级/半愈合/加权轮询/自动权重）+ 有效优先级 |
| 失败判据 | 按 vendor 逐个硬编码 | 按状态码 + 兜底白名单 + 专用渠道判别 |
| 脱敏 | 有，且很重（HMAC 占位符 + 中文规则 + 可选本机模型） | 无（只有密钥掩码下发） |
| 多租户 | 本地网络共享 + 每 key 日/周/月限额 | 来源 IP 态势 + 封禁 + 管理员会话 |
| 观测 | `/v1/magpie/trace` + Routing 页面逐请求解释 | 控制台九页 + `/metrics` |
| 测试 | **1,832 个 `_test.go`**（部分检出） | 64 文件 / 3,125 断言 |

**不是替代关系**：magpie 治的是"我这台机器上 62 个 agent 各用哪个模型、配额还剩多少"；
zzcsapi 治的是"一群客户端的请求往哪个渠道走、哪个渠道挂了"。硬要选边：**你现在的场景是后者**。

## 5. 值得抄的五条（按性价比排序）

1. **占位符用 keyed hash 而不是序号**（若本项目将来做脱敏）。理由不是安全，是**兼容性**：
   同值同占位 ⇒ 会话历史逐轮一致 ⇒ prompt cache 命中率不塌、thinking 签名不失效。
   这一条别人踩过才写得出来，值得直接照抄。
2. **冷却时长贴着上游的 reset，不贴自己的退避曲线**。本项目现在是指数曲线（`docs/scheduling.md` 三曲线），
   但**没把"上游说它什么时候回来"当一等公民**。magpie 的 `creditBackoff` 把 `Retry-After` 与响应体里的
   reset 时间一起读——这条可以直接加到 `cooldownMsFor()` 旁边。
3. **缓存感知的会话黏性判据**：本项目有会话粘性（`docs/runtime-settings.md`），但判据是"时间窗"，
   没有"这一发到底吃到缓存没有"。magpie 用 **cache_read > 0 且读写合计 ≥1024 token 且 5 分钟内** 三条同时成立
   才继续黏。给现有粘性加一个"值不值得黏"的旁路判据，是不小的质量提升。
4. **每个调用方一枚子 token**（`Token-<agent>`）。本项目现在只有一把 `GATEWAY_KEY`；若将来要"按客户端切换策略"
   （不同客户端给不同模型/不同限流），这是最省事的一步。
5. **IR 中间表示**——理论上最优，但**现在别动**。你的四协议转换器已经有 e2e 守卫（`docs/protocols.md` 那套 3×3 矩阵、
   专用渠道收口、`special-channel-output-seam-e2e` 的计数守卫）。为了 O(N+M) 去重写它，
   换来的收益是"加第 5 个协议时少写代码"，代价是全链路重验——**当前不值得**。记着这个方向就行。

## 6. 不该抄 / 要当心

- **单文件 422 KB**（`gateway.go`）、`fallback.go` 177 KB、`claude_subscription.go` 254 KB。
  这是"一个人连续高速迭代"的产物，不是可以模仿的结构。本项目"一函数一屏 + 守卫测试"的纪律更值得守。
- **3,295 个未关 issue + 不收 PR**：能力再强，你也只能等作者。**别把它当依赖。**
- **默认读本机凭据**（Claude Code/Codex 登录文件 + Keychain）。能力强 = 授权大。要开就先想清楚。
- **每日心跳遥测**（随机 id + 版本 + 系统 + 用到的 agent/provider/model），可 `DO_NOT_TRACK=1` 或 Settings 关。
  本项目"密钥与隐私"那条血泪条款意味着：这种默认开着的上报，我们不会做。
- **macOS 优先**：Keychain、菜单栏、Wails；Windows/Linux 是后补的（有 `*_windows.go` 分文件，能看出补的痕迹）。
- **前沿依赖**：Go 1.26.8、Wails v3 `beta.24`。版本折腾起来会很痛。

## 7. 复现

```powershell
# 1) 仓库元数据（别用 127.0.0.1，走代理；GitHub API 有 IP 限流，失败就等或换出口）
curl.exe -sS -x http://127.0.0.1:7897 https://api.github.com/repos/yetone/magpie

# 2) 只拿源码骨架，不下 273MB 的 blob（浅克隆 + blobless + 稀疏检出）
git -c http.proxy=http://127.0.0.1:7897 clone --depth 1 --filter=blob:none --no-checkout `
  https://github.com/yetone/magpie.git src
cd src
git sparse-checkout set internal/gateway internal/redact internal/pii internal/provider docs
git checkout main          # 只拉这几个目录的 blob

# 3) 定位关键实现
Select-String -Path internal\gateway\gateway.go -Pattern '^func |^type '            # 网关主体
Select-String -Path internal\gateway\routing.go -Pattern '^func '                   # 账号/配额编排
Get-Content internal\gateway\ir.go -TotalCount 22                                   # IR 中间表示
Get-Content internal\redact\redact.go -TotalCount 34                                # 脱敏设计
Select-String -Path docs\reference.md -Pattern '^### '  -Context 0,0                # 规格目录
```

> ⚠️ 别用 `git ls-tree -r -l`：blobless 克隆下它会**按需把整个仓库的 blob 拉下来**（本机实测卡住，已中止）。

## 8. 结论

magpie 值得读，不值得依赖。它把"本机 agent 的模型/账号/配额"这一层做到了本项目的盲区之外——
尤其是**配额窗口经营、缓存亲和的黏性判据、keyed-hash 占位符、按 vendor 的失败分类**这四样，
是本项目当前没有的、且能局部搬过来的。

它的形态（单二进制 + 62 个 agent 配置改写器 + 订阅驱动官方客户端）不适合本项目现在的定位，
但它的 `docs/reference.md`（251 KB，逐条写清"为什么这样排"）在**文档纪律**上和本项目是同路人——
这一点比它的代码更值得看。
