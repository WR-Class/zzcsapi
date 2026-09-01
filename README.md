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

### 协议说明

| protocol     | 探活 URL                  | 鉴权头              | 网关对外路径                          |
| ------------ | ------------------------- | ------------------- | ------------------------------------- |
| `openai`     | `GET /models`             | `Authorization: Bearer ...` | `/v1/chat/completions` 之类     |
| `anthropic`  | `GET /v1/models`          | `x-api-key: ...`    | `/anthropic/v1/messages`              |
| `gemini`     | `GET /v1beta/models`      | `x-goog-api-key: ...` | `/gemini/v1beta/models/{m}:{action}` |

> 中转渠道如果用 OpenAI 兼容但 `protocol` 想挂到 Anthropic 端点用，把 `protocol` 设成 `anthropic` 即可——网关会把请求体自动转成 OpenAI 格式丢给它，再把响应转回 Anthropic 格式。同理 Gemini。

## 调度顺序

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数；同状态按 `priority` 降序，再看 latency
4. 依次尝试直到成功；全部失败返回 502 + 错误详情

## 端点

| 路径                                | 方法 | 鉴权        | 说明                                  |
| ----------------------------------- | ---- | ----------- | ------------------------------------- |
| `/healthz`                          | GET  | 无          | 网关自身存活探针                      |
| `/console`                          | GET  | admin       | Web 控制台 HTML                       |
| `/admin/api/status`                 | GET  | admin       | 渠道详细状态（控制台用）              |
| `/admin/api/recheck`                | POST | admin       | 立即重探测（body 可传 `{id}`）        |
| `/admin/api/channel`                | POST | admin       | 改渠道（`{id, priority?, enabled?}`） |
| `/admin/status` / `/admin/recheck`  | */POST | admin    | 旧版兼容路径                          |
| `/v1/models`                        | GET  | gateway     | OpenAI 聚合模型                       |
| `/v1/chat/completions`              | POST | gateway     | OpenAI chat（支持 stream）            |
| `/v1/embeddings`                    | POST | gateway     | 透传                                  |
| `/v1/responses` / `/v1/completions` | POST | gateway     | 透传                                  |
| `/anthropic/v1/models`              | GET  | gateway     | Anthropic 聚合模型                    |
| `/anthropic/v1/messages`            | POST | gateway     | Anthropic Messages（支持 stream）     |
| `/gemini/v1beta/models/{m}:generateContent`        | POST | gateway | Gemini 非流式        |
| `/gemini/v1beta/models/{m}:streamGenerateContent`  | POST | gateway | Gemini 流式          |

## 行为细节

- **4xx 重试规则**：`400/401/403/422` 等明确请求本身错的不再切渠道；`408/429` 会切。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道（避免半截回复）。
- **协议转换**：OpenAI ↔ Anthropic 走内部 OpenAI 协议中转；Anthropic 渠道里跑的是 OpenAI 也能用。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **别名区分大小写不敏感**，upstream 透传原样。

## 计划中

- 加权轮询（不是单纯 priority 优先）
- 用量统计 / 配额
- Anthropic tool_use 完整转换
- Gemini 多模态（图片）适配
