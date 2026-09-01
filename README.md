# ZZCSAPI — 本地多渠道 OpenAI 兼容聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，零依赖，**仅 Node 18+**。
把所有中转 API key 集中在一处，对外只暴露一个 OpenAI 兼容地址。

## 特性

- 🚦 **多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：4xx 客户端错误之外，遇到 5xx / 超时 / 网络错误立刻试下一个渠道
- 🛡 **熔断冷却**：连续失败的渠道进入指数退避冷却期（1s, 2s, 4s ... 上限 60s）
- 🔍 **后台健康探测**：定时 GET `{base}/models`，聚合 `latency / 状态 / 真实模型清单`
- 🌊 **流式透传**：SSE 全程转发，已发出 200 不会中途切换（避免半截回复）
- 📊 **统一模型清单**：`/v1/models` 自动合并所有渠道的别名 + 探测到的真实模型
- 🧰 **管理面板**：`/admin/status` 查看所有渠道，`POST /admin/recheck` 立即重探测

## 快速开始

```bash
# 1) 首次运行自动从 config.example.json 生成 config.json
node server.js

# 2) 编辑 config.json 填入你的渠道
#    然后再次启动
node server.js
```

## 在 DSH 里配置

把 DSH 里的 OpenAI 兼容 API 地址改成：

```
http://127.0.0.1:8787/v1
```

API Key 随便填一个非空字符串（网关目前不强制鉴权，留待 `ADMIN_KEY` 后续扩展）。
模型名用 `config.json` 里 channels[*].models 配置的 **alias**（左边的键）。

## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },
  "channels": [
    {
      "id": "vendor-a",
      "name": "中转A",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "priority": 10,                // 数字越大越优先
      "enabled": true,
      "models": {                     // alias(对外) -> upstream(实际)
        "gpt-4o": "gpt-4o",
        "gpt-4o-mini": "gpt-4o-mini",
        "my-coding": "gpt-4o"         // 同一渠道同一 upstream 可挂多个别名
      }
    },
    {
      "id": "vendor-b",
      "name": "中转B",
      "baseUrl": "https://api.example-b.com/v1",
      "apiKey": "sk-yyy",
      "priority": 5,
      "enabled": true,
      "models": {
        "gpt-4o": "gpt-4o"            // 同一个 alias 的备胎
      }
    }
  ]
}
```

## 调度顺序

对用户请求的模型 `M`：

1. 在所有 `enabled` 渠道里查找 `M` 是否在 alias 映射中
2. 候选 = 命中的渠道 ∪ 自动从探测结果中识别出 M 的渠道（优先级 -0.5）
3. 排序：
   - 冷却中 → 最末
   - 状态为 down → 倒数
   - 同状态 → priority 大的先
   - 再看 latency
4. 依次尝试直到成功；所有失败后返回 `502` + 错误详情

## 端点

| 路径                          | 方法 | 说明                                   |
| ----------------------------- | ---- | -------------------------------------- |
| `/v1/models`                  | GET  | 聚合模型清单（带渠道状态）             |
| `/v1/chat/completions`        | POST | 调度 chat（支持 stream）               |
| `/v1/embeddings`              | POST | 透传（不做特殊处理）                   |
| `/v1/responses`               | POST | 透传                                   |
| `/v1/completions`             | POST | 透传                                   |
| `/healthz`                    | GET  | 网关自身存活探针                       |
| `/admin/status`               | GET  | 渠道详细状态                           |
| `/admin/recheck`              | POST | 立即触发一次所有渠道健康探测           |

## 行为细节

- **4xx 重试规则**：`400/401/403/422` 等明确是请求本身错的不再切渠道；`408/429` 会切。
- **流式失败**：已经开始向客户端写 200 + 任意 chunk 后，上游断开不会再换渠道。
- **冷启动**：第一次请求时 `status=unknown` 仍然会被选中（health 探测在后台进行）。
- **别名区分大小写不敏感**，upstream 透传原样。

## 计划中

- 鉴权 (`ADMIN_KEY` env)
- 简易 Web 控制台
- 渠道权重与加权轮询
- Anthropic / Gemini 适配
