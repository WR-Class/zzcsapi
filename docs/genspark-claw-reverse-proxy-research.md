# Genspark Claw 反代可行性研究（2026-09-25）

> 结论先行：**本地确实存有 key（与 workbuddy 同款模式），且 Genspark 官方本身就是标准 OpenAI/Gemini 兼容 API，反代技术上零难度**；
> 但当前账号是免费计划，`llm_proxy` 端点对免费计划完全封禁（`free_plan_block`），**不付费无法实际出话**——连 Claw 客户端自带的 agent 在免费账号下都不可用（实测证据见 §3）。

## 1. 客户端与本地凭据存储

- 安装位置：`D:\Genspark Claw\Genspark Claw.exe`（Electron 应用，内置 OpenClaw agent 运行时 + Node 22）
- 数据目录：`%APPDATA%\Genspark Claw`
- **key 存放位置**（对应 workbuddy 的 `.info` 文件，本机路径为 `C:\Users\RongWu\AppData\Roaming\...`）：
  - `%APPDATA%\Genspark Claw\users\<账号uuid>\agents\main\agent\auth-profiles.json` —— 权威存储（key + usageStats）
  - 同目录上级的 `openclaw.json` —— provider 配置（baseUrl + apiKey + 模型清单），key 同一份
  - 本机实际路径：`C:\Users\RongWu\AppData\Roaming\Genspark Claw\users\bc80ac7d-efa4-4505-8aef-34fddac56246\`
- **凭据结构**：`gsk-` 前缀 + base64url(JSON payload) + `f`（分隔/版本字节）+ base64url 签名段（43 字符 ≈ 32 字节）
  - payload 字段：`{"cogen_id":"<账号uuid>","key_id":"<uuid>","ctime":<秒级时间戳>,"claude_big/middle/small_model":null}`
  - **payload 无过期时间字段**；`cogen_id` 与本地 users 目录 uuid 一致 → 账号级设备 key
  - llm_proxy 与 gemini proxy 是**两把独立 key**（key_id 不同，ctime 相差 ~2 分钟）
- 登录/签发流程（app.log 实录）：Azure AD B2C OAuth（login.genspark.ai）→ `GET /api/auth?code=...` 换永久 session_id → `POST /api/api_tokens/create` 签发 gsk- key → 写入 auth-profiles.json
- key 轮换：客户端重新登录会重新签发，auth-profiles.json 与 openclaw.json 同步更新

## 2. 端点与协议实测

### 2.1 OpenAI 兼容端点（主力）

- baseUrl：`https://www.genspark.ai/api/llm_proxy/v1`，`Authorization: Bearer gsk-...`
- `GET /models` → **HTTP 200**，共 **62 个模型**（比客户端配置的 39 个多 23 个：gpt-6-sol、gpt-6-luna、gpt-5.6-luna-max、gpt-5/5.2/5.3-codex、claude-opus-4-5、claude-sonnet-4-5、claude-opus-5-low、claude-opus-4-7-extended-cache、grok-4.7、deepseek-v4.1-flash-max/novita、deep-seek-v4-pro-0813-baseten、minimax-m2p5/m3-rft-slide-v1、trinity-mini/large-preview、glm-5p3-flash-no-think 等）
- 模型家族两种 API 形态（openclaw.json 标注）：多数走 `chat/completions`；gpt-5.4/5.5/5.6-sol/terra/luna、gpt-6-*、gpt-5.4-mini/nano 走 `responses`（Responses API）
- `POST /chat/completions` → HTTP 200，标准 OpenAI 响应形状，但内容是计费墙文案（见 §3）

### 2.2 Gemini 兼容端点

- baseUrl：`https://www.genspark.ai/api/llm_proxy/gemini/v1beta`，`x-goog-api-key: gsk-...`（第二把 key）
- `GET /models` → HTTP 200（gemini-2.5-pro/flash、gemini-3-pro-preview、3.1-pro-preview、3-flash-preview、3.x-flash 系）
- `POST /models/{m}:generateContent` → HTTP 200 + 同样的计费墙文案

### 2.3 传输层

- 直连即可：PowerShell（.NET Schannel）与 Node fetch 均能通过——**没有 workbuddy 那种 TLS 指纹封锁**（Cloudflare 在前但只做常规防护，JA3 不拦）
- 无强制 stream、无"首条必须 system"要求 → 比 workbuddy 渠道还简单，不需要 curl 子进程传输

## 3. 免费计划封禁（当前不可用的根因）

三次独立实测（本机 OpenAI chat 调用、本机 Gemini generateContent 调用、以及 2026-09-25 00:02 Claw 客户端自带 agent 的会话记录）全部命中同一堵墙：

- 响应头：`x-genspark-credit-wall: free_plan_block`、`x-genspark-upgrade-url: https://www.genspark.ai/pricing?fromurl=credit_exhausted&entry=llm_proxy`
- 响应体（**HTTP 200 包装的软错误**）：`"x_genspark":{"code":"free_plan_block","audience":"free","signal_version":1}`，message content 为订阅引导文案
- 客户端自身证据：`users\<uuid>\agents\main\sessions\*.jsonl` 里昨晚 00:02 的会话——用户问"你的apikey存放在什么位置"，agent（gpt-5.6-luna，openai-responses 形态）回复的就是这条墙文案 → **免费账号连 Claw 客户端本身的 agent 都不可用**
- 含义：这不是调用姿势/headers 问题，是账号计划级限制；`/models` 不消耗额度所以鉴权层 200 正常

## 4. 付费后的接入方案（现成可用，无需新协议代码）

标准 openai 渠道即可接入：

```json
{
  "id": "genspark",
  "name": "Genspark Claw",
  "baseUrl": "https://www.genspark.ai/api/llm_proxy/v1",
  "apiKey": "<gsk-... 从 auth-profiles.json 复制>",
  "protocol": "openai",
  "priority": 0,
  "enabled": true,
  "autoAlias": false,
  "models": {
    "claude-fable-5": "claude-fable-5",
    "gpt-6-astra": "gpt-6-astra",
    "deepseek-v4.1-flash": "deep-seek-v4.1-flash",
    "glm-5.3": "glm-5p3",
    "kimi-k3": "kimi-k3"
  }
}
```

注意点：

- Genspark 的模型命名：GLM 系带 `p` 前缀（`glm-5p3`/`glm-5p2`）、DeepSeek 用连字符全称（`deep-seek-v4.1-flash`），别名映射时留意
- Responses API 家族模型经网关 `/v1/responses` 透传可用；其余走 `/v1/chat/completions`
- **建议加计费墙检测**：上游返回 200 但 `x-genspark-credit-wall` 响应头存在或响应体 `x_genspark.code` 非空 → 按渠道失败处理（类似 notion 空输出判定），否则墙文案会被当成正常模型回复透传给客户端
- key 失效/轮换时从 `auth-profiles.json` 重新取（客户端重登录会更新）；沿用 workbuddy 先例直接硬编码进 config.json 也可

## 5. 结论

| 项 | 结果 |
|---|---|
| 本地是否有 key | ✅ 有，存储模式与 workbuddy 相同（auth-profiles.json） |
| key 是否有效 | ✅ 鉴权通过（/models HTTP 200，62 个模型） |
| 反代技术难度 | ✅ 零难度：标准 OpenAI/Gemini 兼容、直连无 TLS 指纹问题 |
| 当前能否实际出话 | ❌ 免费计划被 llm_proxy 封禁（free_plan_block），官方客户端自身也不可用 |
| 解锁条件 | 订阅付费计划或购买额度：<https://www.genspark.ai/pricing?fromurl=credit_exhausted&entry=llm_proxy> |

*实测时间：2026-09-25 01:30（GMT+8）前后；账号为 09-24 晚新登录的免费计划。定价页被 WAF 挡（HTTP 403）未能抓取具体价格，API 计费标准待付费意愿确认后再查。*
