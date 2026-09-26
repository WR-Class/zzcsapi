# ZZCSAPI — 本地多渠道 AI 聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，**零依赖，仅 Node 18+**。
把所有中转 API key 集中在一处，对外同时暴露 **OpenAI / Anthropic / Gemini** 三种兼容端点。

## 特性

- 🚦 **多协议、多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：4xx 客户端错误之外，遇到 5xx / 超时 / 网络错误立刻试下一个渠道
- 🛡 **熔断冷却**：连续失败的渠道进入指数退避冷却期（1s, 2s, 4s ... 上限 60s）
- 🔍 **后台健康探测**：定时 GET 渠道的 models 端点，聚合 latency / 状态 / 真实模型清单
- 🌊 **流式透传**：SSE 全程转发；上游响应是 OpenAI 协议时自动转成 Anthropic/Gemini 流
- 🔐 **双层鉴权**：`GATEWAY_KEY`（客户端）+ `ADMIN_KEY`（控制台与管理 API）
- 🖥 **Web 控制台**：浏览器打开 `http://127.0.0.1:8787/console` 看渠道状态、改优先级、启停渠道
- 📊 **统一模型清单**：`/v1/models`、`/anthropic/v1/models` 自动合并各协议所有可用模型

## 快速开始

### 方式一：Docker（推荐）

```powershell
# usage.json 是运行时持久化文件，不入仓库，首次部署先由模板生成
Copy-Item usage.example.json usage.json
docker compose up -d --build
# 控制台 http://127.0.0.1:8787/console（默认管理密钥 zz-admin-change-me）
```

`docker-compose.yml` 挂载 `./config.json` 和 `./usage.json`。
⚠️ 这两个文件都**必须先在宿主机上存在**：`config.json` 由 `server.js` 首次运行自动从 `config.example.json` 生成；
`usage.json` 需要手动从 `usage.example.json` 复制。**若缺失，Docker 会把挂载点建成目录**，
服务不会崩（`ensureUsage` 有兜底），但用量统计将**无法落盘、每次重启归零**，且不易察觉。
`usage.json` 已列入 `.gitignore`（每次请求都会改写，提交它只会产生噪声 diff）。

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
```

不设置则只允许本机 127.0.0.1 访问（不强制鉴权）。

## 在 DSH / Cursor / Cline 等客户端里配置

### OpenAI 协议
```
baseURL = http://127.0.0.1:8787/v1
apiKey  = <GATEWAY_KEY 的值，没设就随便填>
model   = <channels[*].models 里 alias，左边的键>
```

### Anthropic 协议（DSH 的 Anthropic 兼容地址）
```
baseURL = http://127.0.0.1:8787/anthropic
apiKey  = <GATEWAY_KEY>
model   = <alias>
```

### Gemini 协议
```
baseURL = http://127.0.0.1:8787/gemini/v1beta
apiKey  = <GATEWAY_KEY>
```

## Web 控制台

```
http://127.0.0.1:8787/console?key=YOUR_ADMIN_KEY
```

打开后把 key 存进 sessionStorage（URL 自动脱敏），可：

- 实时看每个渠道的健康 / 延迟 / 错误 / 探测时间
- 改 priority、启停某个渠道
- 触发单渠道或全量重新探测
- 看每个协议聚合后的模型清单

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
| `build/build.js` | 组装脚本（含「产物中 `</style>` 只能出现一次」的构建期自检） |
| `console.html` | **构建产物**，已提交进仓库。**不要手改**——下次构建会被覆盖 |

**因此：改视觉/字号/留白/圆角 → 改 `console-redesign.html` 的 `<style>` → 重新 `node build/build.js`。**
改完请确认 `console.html` 同步更新（构建是覆盖式的，忘了构建就等于没改）。

> 生产与原型**变量名完全相同**（生产直接复用设计稿 CSS），不存在映射表。
> 生产独有能力（genspark 双导入、codex 配额条、渠道级自定义请求头、密钥掩码↔明文切换、有效优先级角标、
> 真实测试/导入/Playground 请求）原型里没有，**原型不必追平**。

改前端前请先读这两份文档：

| 文档 | 用途 |
| --- | --- |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计文档](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | **动代码前过目**：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查）、前端独立审查 |


## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },
  "channels": [
    {
      "id": "vendor-a-openai",
      "name": "中转A (OpenAI)",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "protocol": "openai",                  // openai | anthropic | gemini
      "priority": 10,
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

| protocol       | 探活 URL                  | 鉴权头              | 网关对外路径                          |
| -------------- | ------------------------- | ------------------- | ------------------------------------- |
| `openai`       | `GET /models`             | `Authorization: Bearer ...` | `/v1/chat/completions` 之类     |
| `anthropic`    | `GET /v1/models`          | `x-api-key: ...`    | `/anthropic/v1/messages`              |
| `gemini`       | `GET /v1beta/models`      | `x-goog-api-key: ...` | `/gemini/v1beta/models/{m}:{action}` |
| `notion`       | `POST getSpaces`          | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query`  | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） |
| `arena`        | —                        | —                    | **已撤**：Arena.ai 逆向已整体移除（见 docs/arena-protocol.md 留档）  |
| `workbuddy`    | 自检 `chat/completions`   | `Authorization: Bearer ...` | WorkBuddy 逆向（**必须走 curl 子进程**：上游对 Node/undici 的 TLS 指纹直接 ECONNRESET） |
| `codex`        | 一次令牌刷新             | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效，RT 一次性轮转） |
| `genspark`     | `GET /api/is_login`      | `Cookie: session_id=...` | Genspark 网页会话反代（**渠道必须配代理**；session 约 20 天过期） |

> 中转渠道如果用 OpenAI 兼容但 `protocol` 想挂到 Anthropic 端点用，把 `protocol` 设成 `anthropic` 即可——网关会把请求体自动转成 OpenAI 格式丢给它，再把响应转回 Anthropic 格式。同理 Gemini。

#### notion-agent（Notion 官方 Agent API）

调用 Notion 工作区的 Custom Agent（需要 Business/Enterprise 版工作区，在 Notion 网页聊天侧栏创建代理）。

- **Base URL**：`https://api.notion.com`
- **API Key**：**集成令牌**（开发者门户 → 我的集成 → 复制内部令牌 `ntn_...`），且集成的能力必须勾选「**查看会话并与代理交互**」（测试版）
- ⚠️ **个人访问令牌（PAT）不行**：PAT 能列代理、能建会话，但执行时会被服务端直接拒绝（`session_failed`，零 credits 消耗）——这是令牌能力限制，不是配置错误
- **模型行**：alias 填对外模型名（如 `gpt-6-astra`），上游填**智能体名称**（如 `Magnificent Pioneer`）；一个智能体锁定一个模型，多个模型就建多个代理
- 会话中智能体的确认门（requires_action）自动批准（最多 5 次）
- 每次对话消耗工作区 AI credits，因此 notion-agent 渠道排在调度兜底链**最后**，仅当 openai/notion 渠道都失败时才启用

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

## 调度顺序

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数；同状态按**有效优先级**降序，再看 latency
4. 依次尝试直到成功；全部失败返回 502 + 错误详情

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

## 端点

| 路径                                | 方法 | 鉴权        | 说明                                  |
| ----------------------------------- | ---- | ----------- | ------------------------------------- |
| `/healthz`                          | GET  | 无          | 网关自身存活探针                      |
| `/console`                          | GET  | admin       | Web 控制台 HTML                       |
| `/admin/api/status`                 | GET  | admin       | 渠道详细状态（控制台用）              |
| `/admin/api/usage`                  | GET  | admin       | 用量统计（总量 / 按模型 / 按渠道 / 按天 / 近 200 条 / 24h 分布） |
| `/admin/api/usage/clear`            | POST | admin       | 清零用量统计                          |
| `/admin/api/recheck`                | POST | admin       | 立即重探测（body 可传 `{id}`）        |
| `/admin/api/channel`                | POST | admin       | 改渠道（`{id, priority?, enabled?}`） |
| `/admin/api/channels`               | GET  | admin       | 渠道集合完整列表                      |
| `/admin/api/channels`               | POST | admin       | 新增 / 覆盖渠道（upsert，落库并立即探测一次） |
| `/admin/api/channels`               | DELETE | admin     | 删除渠道（body `{id}`）               |
| `/admin/api/probe`                  | POST | admin       | 临时探测上游模型清单（不落库，控制台「获取模型」用） |
| `/admin/api/test`                   | POST | admin       | 真发一次最小 chat 请求，返回首字延迟 / 总耗时 / 错误 |
| `/admin/api/codex-import`           | POST | admin       | 导入 codex 凭据（完整 JSON 或裸 `rt.1.` 开头 RT） |
| `/admin/api/codex-quota`            | GET  | admin       | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import`        | POST | admin       | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config`                 | GET  | admin       | 暴露接入信息（含 key 与 URL），仅本机 admin |
| `/admin/status` / `/admin/recheck`  | */POST | admin    | 旧版兼容路径                          |
| `/v1/models`                        | GET  | gateway     | OpenAI 聚合模型                       |
| `/v1/chat/completions`              | POST | gateway     | OpenAI chat（支持 stream）            |
| `/v1/embeddings`                    | POST | gateway     | 透传                                  |
| `/v1/images/generations`            | POST | gateway     | OpenAI 生图（需上游渠道支持图像接口）  |
| `/v1/responses` / `/v1/completions` | POST | gateway     | 透传                                  |
| `/anthropic/v1/models`              | GET  | gateway     | Anthropic 聚合模型                    |
| `/anthropic/v1/messages`            | POST | gateway     | Anthropic Messages（支持 stream）     |
| `/gemini/v1beta/models/{m}:generateContent`        | POST | gateway | Gemini 非流式        |
| `/gemini/v1beta/models/{m}:streamGenerateContent`  | POST | gateway | Gemini 流式          |

## 行为细节

- **4xx 重试规则**：`400/422` 等明确请求本身错的不再切渠道，原样透传；`401/402/403/404/408/429` 是渠道侧问题（鉴权/余额/该渠道没有此模型/超时/限频，跨渠道各不相同）→ 切下一候选兜底。404 进兜底名单的动机：渠道「声明有此模型」但上游实际没有（别名表过期）时，下一个声明者很可能真的有。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
- **协议转换**：OpenAI ↔ Anthropic 走内部 OpenAI 协议中转；Anthropic 渠道里跑的是 OpenAI 也能用。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **别名区分大小写不敏感**，upstream 透传原样。

## 计划中

- 真正的加权轮询（按权重比例分流，当前只是失败率降权 + priority 排序）
- Anthropic tool_use 完整转换
- Gemini 多模态（图片）适配
