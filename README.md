# ZZCSAPI — 本地多渠道 AI 聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，**零依赖，仅 Node 18+**。
把所有中转 API key 集中在一处，对外同时暴露 **OpenAI / Anthropic / Gemini** 三种兼容端点。

> 细节都在 `docs/`：本文只留速查与上手，每节末尾的链接点进去看全量。

## 特性

- 🚦 **多协议、多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：只要还有能上场的候选，5xx / 超时 / 网络错误，以及上游 4xx（含"渠道声明了早已下架的模型"这类 404）都立刻试下一个渠道；客户端的 400 只在没有候选可切时原样透传
- 🛡 **熔断冷却（分级退避）**：连续失败的渠道按**错误类型**分别退避（瞬时 5s 起 / 凭证额度 5 分钟起 / 限流 1 分钟起，各自封顶），冷却中的排到候选链末尾，连续失败 3 次标记 `down`；健康探测只做"半愈合"，要一次真实对话成功才彻底恢复（[调度详解](docs/scheduling.md)）
- 🔍 **后台健康探测**：定时 GET 渠道的 models 端点，聚合 latency / 状态 / 真实模型清单
- 🌊 **流式透传**：SSE 全程转发；上游响应是 OpenAI 协议时自动转成 Anthropic/Gemini 流；**同协议直通则原始字节直转**（CRLF/分帧都不动，v1.16）
- ⚡ **自带出站客户端（零依赖）**：Node 内置 `http/https` + keep-alive 连接池——实测把网关净增延迟从 +13.9ms 压到 **+0.93ms**（[行为细节 · 出站与流式写路径](docs/behavior.md)）
- 🧷 **会话粘性（v1.17，默认关）**：同一条会话固定走同一个上游渠道，让上游提示缓存 / KV cache 能复用；只改"谁是第一位"，不硬塞冷却中的渠道，也不污染加权份额统计
- 🚧 **客户端限流（v1.17，默认关）**：整机 rpm + 并发上限，超限回 `429` + `Retry-After`，在鉴权之前就挡住
- 📈 **`/metrics` 指标端点（v1.17）**：Prometheus 文本格式、零依赖，渠道/令牌/耗时/熔断分档/粘性/限流一屏看完
- 🧠 **thinking 回放（v1.18.8，默认关）**：同协议直通上把上游自己签的 `signature` 补回给弄丢它的开源客户端——四元键绝不跨会话/渠道/模型，没坏不碰（[设计记录](docs/thinking-replay-design.md)）
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

> ⚠️ **改完代码要确认容器真的换了镜像**（v1.18.1 现场踩到过）：`up -d --build` 有时只构建不重建（输出是 `Running` 而不是 `Recreated`），刷新看到的还是旧代码。
> 判断：`docker inspect zzcsapi --format '{{.Image}}'` 与 `docker images zzcsapi:local --format '{{.ID}}'` 不一致就补 `docker compose up -d --force-recreate`。`/console` 带 `no-store`，不需要强刷浏览器。
> ⚠️ `config.json` / `usage.json` **必须先在宿主机存在**，否则 Docker 会把挂载点建成目录（服务不崩，但用量统计每次重启归零）。
> 端口映射 `8787:8787`（局域网可访问）；手工 `docker run` 别忘 `ZZCSAPI_BIND=0.0.0.0`、`TZ=Asia/Shanghai`、`ZZCSAPI_CONFIG=/app/config.json`（compose 已写死，不会踩到）。

### 方式二：裸 Node（18+）

```bash
node server.js          # 1) 首次运行自动从 config.example.json 生成 config.json
# 2) 编辑 config.json 填入真实渠道，再重启
```

可选环境变量：

```bash
GATEWAY_KEY=xxx  node server.js    # 客户端必须带 Bearer xxx
ADMIN_KEY=yyy    node server.js    # 控制台 + /admin/* 必须带 Bearer yyy
ZZCSAPI_NOAUTH=1 node server.js    # 本地开发：完全关闭鉴权（仅限本机自用）
ZZCSAPI_BIND=0.0.0.0 node server.js  # 绑定地址，缺省 127.0.0.1（裸跑时对外提供服务的必填项）
ZZCSAPI_ALLOWED_HOSTS=a.com,b.com node server.js  # Host 门白名单域名（逗号分隔）。默认放行 localhost 与回环/私网 IP 字面量；反代/公网域名必须在此登记，否则 421（v1.18.10 渗透整改 V-07：拦 DNS 重绑定）
```

**密钥从哪来（分享/分发友好）**：

1. **显式设置** `ADMIN_KEY` / `GATEWAY_KEY` 环境变量 → 以你设置的为准（compose 场景写进 `.env`）；
2. **没设置** → 首次启动自动生成 48 位随机密钥，**打印到容器日志**并写回 `config.json`（重启不变）；
3. **想换** → 环境变量优先级最高；或控制台「密钥管理」在线轮换（[行为细节](docs/behavior.md)）。

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

> 鉴权三种写法都认：`Authorization: Bearer`、`x-api-key:`（**Anthropic SDK 的默认头**）、`?key=`。

### Gemini 协议
```
baseURL = http://127.0.0.1:8787/gemini/v1beta
apiKey  = <GATEWAY_KEY>
```

> **鉴权**：`x-goog-api-key:`（**Gemini SDK 的默认头**）、`?key=`、`Authorization: Bearer` 都行。
> **支持图片**：`inlineData`（base64）与 `fileData`（`fileUri` 直链）都会转成上游的图片块转发，部件顺序保留；
> 带图请求只走 `openai` 协议渠道（[含图请求的候选裁剪](docs/scheduling.md)）。

## Web 控制台

```
http://127.0.0.1:8787/console
```

首次打开有一个「输入管理密钥」的小门——验证通过后换回**会话 cookie**（`HttpOnly` + `SameSite=Strict`，12 小时），
密钥本身**不落浏览器**；管理 API 每次调用仍强制鉴权（"页面能开 ≠ 有权限"），会话失效时自动重新弹门（详见 [行为细节 · 管理面会话](docs/behavior.md)）。

可做：实时看每个渠道的健康/延迟/错误/探测时间、改 priority、启停渠道、触发单渠道或全量重新探测、看各协议聚合模型清单、
**测试停用渠道里的模型**（停用只是"不参与调度与自动探测"，不代表不能手动打一发验证）、测试结果每行写明**测的哪个模型 + 通过/空回复/失败 + 延迟与 token + 回复或错误原文**。

> 自动 vs 手动的边界：自动探测（启动时 + `health.intervalSec`）**只探启用渠道**；手动（「测试」/「重探测」/ `/admin/api/test` / `/admin/api/recheck`）不受此限，连停用渠道一起探。

## 文档

> ⚠️ **强制约定：改代码必须同步改文档**（无论改动来自谁）。完整规则见 [`AGENTS.md`](AGENTS.md)。

| 文档 | 用途 |
| --- | --- |
| [协议与渠道详解](docs/protocols.md) | 协议速查表之外的**全量细节**：原生出站与同协议直通、三条客户端路由的工具调用方向、notion-agent / workbuddy / genspark / codex 配置要点、`proxy` 字段、图片转换 |
| [调度详解](docs/scheduling.md) | 调度顺序全量语义：同渠道重试、熔断冷却分级、加权轮询、自动权重（观测版）、有效优先级、含图请求的候选裁剪 |
| [运行期设置（四组开关）](docs/runtime-settings.md) | 会话粘性 / 客户端限流 / `/metrics` / thinking 回放的语义与 `GET/POST /admin/api/settings` 用法 |
| [行为细节](docs/behavior.md) | 4xx 兜底判据、流式失败、协议转换有损点、thinking 边界与回放、工具调用映射、密钥轮换、管理面会话、鉴权写法、v1.16 出站与流式写路径实测 |
| [测试清单](docs/tests.md) | 33 个测试文件 · 1635 项断言：每条守的是什么、「改什么 → 必跑什么」速查、测试哲学 |
| [安全整改记录](docs/security-hardening.md) | 渗透测试六批整改（v1.18.3–v1.18.10）逐批内容与守卫测试、11 项发现全量处置台账、复查记录 |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [控制台「运行期设置」页实现规格](docs/console-settings-spec.md) | 设置页的施工图：字段契约、四张卡结构、必须守住的交互细节、验收清单 |
| [thinking 回放缓存设计与实现记录](docs/thinking-replay-design.md) | 三次决策完整过程、跨协议 thinking/签名保真度地图、as-built 边界与验收映射 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | 动代码前过目：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查） |
| [同类网关内部机制对比](docs/gateway-comparison.md) | 本项目 vs new-api / one-api / sub2api / CLIProxyAPI 的内部机制/性能/全面性对照（只比机制，不比多用户），含实测数字与各家源码级证据 |
| [Genspark Claw 反代研究](docs/genspark-claw-reverse-proxy-research.md) | 逆向过程留档 |
| [Arena 协议](docs/arena-protocol.md) / [Prism 反代研究](docs/prism-reverse-proxy-research.md) | 已撤渠道留档 |
| [AI 工具调用桥接](docs/AI工具调用桥接-群友分享版.md) | 群友分享版说明 |

### 前端构建管线（一句话版）

生产控制台 `console.html` **不是手写的，是构建产物**：`node build/build.js` 组装
`console-redesign.html`（视觉唯一真源）+ `build/` 下的 head / shell / extra.css / app.js，
**不要手改产物**（下次构建会被覆盖）。管线图、文件角色表、行号换算见 [前端代码地图 §0](docs/frontend-code-map.md)。
改完 `console-redesign.html` / `build/*` 后**必须重新构建**，并按 [AGENTS.md](AGENTS.md) §1.2 重核行号锚点。

### 测试（一句话版）

**32 个文件 · 1548 项断言，全部零依赖**（e2e 真起「假上游 + 临时网关」，动态端口 + 临时目录，不碰仓库运行文件，不出网）。
全量清单、每条守的是什么、改什么必跑什么：[测试清单](docs/tests.md)。新增测试时登记进该文档与 `AGENTS.md` §3。

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
      "weight": 3,                           // 分流：同模型候选里按比例轮询（不填/0 = 不参与，见「调度详解」）
      "enabled": true,
      "proxy": "http://host.docker.internal:7897",  // 可选：HTTP 代理（见协议详解），留空/删掉 = 直连
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
      "models": { "claude-3-5-sonnet": "claude-3-5-sonnet-20241022" }
    },
    {
      "id": "vendor-gemini",
      "name": "Gemini 中转",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza-xxx",
      "protocol": "gemini",
      "priority": 10,
      "models": { "gemini-1.5-pro": "gemini-1.5-pro-latest" }
    }
  ],
  "security": {                                // 来源 IP 态势与封禁（v1.18.11）：bannedIPs 持久化；trustedProxy 见下
    "bannedIPs": [],                           //   已封禁来源列表（客户端面一律 403；管理面/控制台不受影响）
    "trustedProxy": ""                         //   逗号分隔的反代地址：只有来自这些来源的 X-Forwarded-For 第一跳才被采信
  }
}
```

> 渠道字段 `proxy`（可选）：HTTP 代理地址，探测/测试/聊天全部经代理转发（流式会整体缓冲后回放）；
> `notion` / `notion-agent` 不支持代理。细则见 [协议与渠道详解](docs/protocols.md)。
> 调度旋钮（`cooldown` / `retries` / `autoWeight`）与运行期四组开关（`sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay`）
> 的全量取值与钳制范围见 [调度详解](docs/scheduling.md) 与 [运行期设置](docs/runtime-settings.md)。
> `security.trustedProxy` 只在网关部署在反向代理后面时才需要：留空 = 直连模式，一律只认 socket 地址
> （`X-Forwarded-For` 是客户端可伪造的头，不设门槛就采信会把封禁变成假功能）。来源统计是**内存态**
> （网关重启清零），封禁表落 `config.json` 重启不丢——语义见 [行为详解](docs/behavior.md)。

## 协议说明

| protocol | 探活 URL | 鉴权头 | 出站报文 |
| --- | --- | --- | --- |
| `openai` | `GET /models` | `Authorization: Bearer ...` | OpenAI 格式，原样转发 |
| `anthropic` | `GET /v1/models` | `x-api-key: ...` + `anthropic-version` | **原生 Anthropic**：`POST /v1/messages` |
| `gemini` | `GET /v1beta/models` | `x-goog-api-key: ...` | **原生 Gemini**：`POST /v1beta/models/{m}:generateContent` |
| `notion` | `POST getSpaces` | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query` | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） |
| `workbuddy` | 自检 `chat/completions` | `Authorization: Bearer ...` | WorkBuddy 逆向（必须走 curl 子进程；token 是 JWT，新版已加密） |
| `codex` | 一次令牌刷新 | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效） |
| `genspark` | `GET /api/is_login` | `Cookie: session_id=...` | Genspark 网页会话反代（**必须配代理**；工具调用靠文本仿真） |

`arena` 协议已撤（[留档](docs/arena-protocol.md)）。

**客户端说哪套协议、渠道讲哪套协议，互不绑定**：任一客户端路由都能打到任一协议的渠道（出站自动转原生格式）；
**同协议的那格直通不翻译**（v1.15——`thinking` / `cache_control` / `seed` 等原样到达，响应逐字节一致；v1.18.8 起还带
thinking 回放修复）。矩阵表、工具调用四方向、各渠道配置要点、有损点诚实清单：[协议与渠道详解](docs/protocols.md)。

## 调度顺序（摘要）

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias——**同协议优先，跨协议兜底**（现有 `openai` 渠道先后顺序不受影响），最后才是 notion → notion-agent → workbuddy → genspark → codex 文本链
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数第二；`probation`（半愈合观察期）→ 健康渠道之后；同状态按**有效优先级**降序，再看 latency
4. **加权轮询**（填了 `weight` 的渠道按比例决定谁排第一）；**会话粘性**（开着时）把这条会话上次成功的那家提到第一位
5. **含图请求**先按图片能力门裁剪候选；纯文本不受影响
6. 依次尝试直到成功；全部失败返回 502 + 错误详情。**同渠道重试**（`retries.perChannel`）只对 5xx/网络/超时原地再试，4xx 一律不重试

```
有效优先级 effPriority = priority − 失败率 × 3      // 失败率取滚动窗口 ch.roll（样本 ≥5 生效，120 次后减半衰减）
```

重试/冷却/权重/自动权重/图片门的全量语义与调参：[调度详解](docs/scheduling.md)。

## 端点

| 路径 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/healthz` | GET | 无 | 网关自身存活探针（只回 `{ok:true}`，v1.18.9 起不带渠道数/密钥状态——渗透整改 V-08） |
| `/console` | GET | admin | Web 控制台 HTML |
| `/admin/api/status` | GET | admin | 渠道详细状态（控制台用；含 `weight`/`weightedShare`/自动权重观测/`effectivePriority` 等字段） |
| `/admin/api/usage` | GET | admin | 用量统计（总量 / 按模型 / 按渠道 / 按天 / 近 200 条 / 24h 分布） |
| `/admin/api/usage/clear` | POST | admin | 清零用量统计 |
| `/admin/api/stats` | GET | admin | **来源 IP 态势统计**（per-IP 敲门数 / token / 模型 / 峰值并发 / 会话估计 / 24h 桶 / 封禁命中；内存态，重启清零） |
| `/admin/api/bans` | POST | admin | 封禁来源 IP（body `{ip}`，字面量校验，立即生效 + 落库，幂等） |
| `/admin/api/bans/{ip}` | DELETE | admin | 解封来源 IP（不存在 404）；封禁只拦客户端面，管理面/控制台永远可达 |
| `/admin/api/recheck` | POST | admin | 立即重探测（body 可传 `{id}`）；**不带 id = 全部重探测，含停用渠道** |
| `/admin/api/channel` | POST | admin | 改渠道（`{id, priority?, enabled?, weight?}`，立即生效并持久化） |
| `/admin/api/channels` | GET | admin | 渠道列表（`apiKey` 只下发掩码 + `apiKeySet` 布尔） |
| `/admin/api/channels` | POST | admin | 新增 / 覆盖渠道（upsert，落库并立即探测一次）；**`apiKey` 留空 = 保持原密钥** |
| `/admin/api/channels` | DELETE | admin | 删除渠道（body `{id}`） |
| `/admin/api/probe` | POST | admin | 临时探测上游模型清单（不落库） |
| `/admin/api/test` | POST | admin | 真发一次最小 chat 请求；带 `channelId` 时**只打该渠道且不看 `enabled`** |
| `/admin/api/codex-import` | POST | admin | 导入 codex 凭据（完整 JSON 或裸 RT） |
| `/admin/api/codex-quota` | GET | admin | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import` | POST | admin | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config` | GET | admin | 接入信息（URL / 端口 + 密钥**掩码** + `keysInsecure`；不交任何密钥原文） |
| `/admin/api/channels/{id}/key` | GET | admin | **按需揭示**：取单个渠道的上游密钥原文 |
| `/admin/api/gateway-key` | GET | admin | **按需揭示**：取网关 `GATEWAY_KEY` 原文 |
| `/admin/api/admin-key` | GET | admin | **按需揭示**：取管理 `ADMIN_KEY` 原文 |
| `/admin/api/keys` | GET | admin | 密钥管理：两把密钥的**掩码 + 来源** + `keysInsecure` + `rotatedAt`，绝不含明文 |
| `/admin/api/keys` | POST | admin | **控制台轮换密钥**：body `{gatewayKey?, adminKey?}`，立即生效并落库（优先级高于环境变量），旧密钥立即失效 |
| `/admin/api/keys/generate` | POST | admin | 随机生成新密钥（48 位，四样字符齐全）：body `{target: "gateway"\|"admin"\|"both"}` |
| `/admin/api/keys/reset` | POST | admin | 删掉 `config.json` 的 `auth` 段，回到「环境变量 → 首启生成」取值链 |
| `/admin/api/session` | POST | 匿名（登录门） | 交一次 `ADMIN_KEY` 换回 `HttpOnly` 会话 cookie（12 小时）；登录失败计入 admin 失败限流 |
| `/admin/api/session` | DELETE | 会话 cookie | 退出登录：只杀自己那枚 token + 过期 cookie；其余方法 405 |
| `/admin/api/settings` | GET/POST | admin | **运行期设置**：读写 `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay` 四组（PATCH 语义，立即生效 + 落库，未知字段 400 点名）——语义见 [运行期设置](docs/runtime-settings.md) |
| `/metrics` | GET | admin（`metrics.public:true` 时匿名） | **Prometheus 文本格式**：请求/渠道/令牌/耗时/熔断分档/粘性/限流/回放指标；`enabled:false` 时 404 |
| `/admin/status` / `/admin/recheck` | */POST | admin | 旧版兼容路径 |
| `/v1/models` | GET | gateway | OpenAI 聚合模型 |
| `/v1/chat/completions` | POST | gateway | OpenAI chat（支持 stream） |
| `/v1/embeddings` | POST | gateway | 透传 |
| `/v1/images/generations` | POST | gateway | OpenAI 生图（需上游渠道支持图像接口） |
| `/v1/responses` / `/v1/completions` | POST | gateway | 透传 |
| `/anthropic/v1/models` | GET | gateway | Anthropic 聚合模型 |
| `/anthropic/v1/messages` | POST | gateway | Anthropic Messages（支持 stream） |
| `/gemini/v1beta/models/{m}:generateContent` | POST | gateway | Gemini 非流式（支持 `inlineData`/`fileData` 图片） |
| `/gemini/v1beta/models/{m}:streamGenerateContent` | POST | gateway | Gemini 流式 |

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

查这些：① 哪些口匿名可达（应只有 `/healthz`、`/console`）② 示例默认密钥是否仍可用 ③ 控制台版本指纹 ④ 安全响应头 / CORS
⑤ 三态鉴权覆盖面 ⑥ 密钥泄露面 ⑦ 路径穿越与私有文件暴露。

整改现状：渗透测试发现**全部有归宿**——六批已修（v1.18.3–v1.18.10，含 V-07 Host/Origin 门与 V-08 探针精简）、其余逐项处置台账在案（V-09/V-11 风险接受的理由、V-05 compose 内成文注释、刻意不做的两条）——完整过程、复查记录与每批的守卫测试见 [安全整改记录](docs/security-hardening.md)。**给公网部署者**：请在可信网络或反代后暴露，公网入口务必加 TLS，反代/公网域名记得登记 `ZZCSAPI_ALLOWED_HOSTS`（否则 421）。

## 行为细节（摘要）

- **上游 4xx 不短路**：`401/402/403/404/408/429` 属渠道侧问题一律切下家兜底；其余 4xx 只在**没有能上场的候选时**原样透传（透传的是最后一家上游的错误体，不是网关伪造的 502）
- **流式失败不换渠道**：已向客户端写过 200 + chunk 后上游断开，不换（避免半截回复）
- **协议转换**：三边走内部 OpenAI 中转，出站按渠道 `protocol` 走原生格式；有损点（`tool_choice:"none"`、`cache_control`/`top_k`/thinking 签名跨格式丢弃）仅跨协议时存在，同协议直通零转换
- **思维链边界**：跨协议双向不带 thinking 块；想要思维链走同协议 Anthropic 渠道（直通，签名原样活着）——thinking 回放（v1.18.8）只补同协议直通上弄丢的 `signature`
- **工具调用**：三条客户端路由四个往返方向全支持（Gemini 按函数名配对、无状态客户端退文本不硬造 id）
- **密钥轮换（v1.18.5）**：`config.auth` > 环境变量 > 首启生成；控制台轮换立即生效、旧密钥立即失效、换管理密钥清空全部会话
- **管理面会话（v1.18.6）**：登录门交一次密钥换 `HttpOnly` 会话 cookie（12 小时、上限 256 条、重启全部掉线）；管理面**不接受 `?key=`**（客户端面保留，Gemini SDK 另一鉴权模式）
- **鉴权写法**：网关密钥认 `Bearer` / `?key=` / 原生 SDK 默认头（`x-api-key` / `x-goog-api-key`）；管理面只认 Bearer 或会话 cookie
- **别名**：区分大小写不敏感，upstream 透传原样
- **冷启动**：第一次请求时 `status=unknown` 仍会被选中（探测在后台进行）

4xx 兜底判据全文、流式收尾、图片统一转换、出站与流式写路径实测数字（+13.9ms → +0.93ms 等）：[行为细节](docs/behavior.md)。

## 计划中

- **自动权重「生效版」**：v1.6 只做到观测（算得出来、看得见，但一行不碰真实分流）。下一步才是把健康系数折进候选份额真正生效——需要同时解决「自动份额与手填权重并存谁优先」「护栏（地板/上限）被反复触碰时如何告警」「份额变化要不要写日志」三个问题。**当前刻意再等等：线上观测时间还不够长**。
