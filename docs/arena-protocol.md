# Arena.ai 反代协议研究（2026-09-06）

## 端点与请求（已验证）

```
POST https://arena.ai/nextjs-api/stream/create-evaluation
headers: content-type: application/json; cookie: arena-auth-prod-v1=<auth>; (origin/referer: https://arena.ai/?mode=direct)
body: {
  id, userMessageId, modelAMessageId, modelBMessageId,   // 全部 UUIDv7（zod 严格校验）
  mode: "direct" | "battle",
  modelAId, modelBId,                                    // arena 模型 UUID（battle 双方；direct 只有 A）
  userMessage: { content: <string 或结构化>, experimental_attachments: [], metadata: {} },
  modality: "chat" | "image",
  recaptchaV3Token: <reCAPTCHA Enterprise token>,       // action="chat_submit"
  secrets: (webdev 模式用)
}
```

- 响应 SSE 前缀：`a0:` 文本增量（JSON string 转义）、`ag:` 推理、`ad:` 完成、`a2:` 心跳/图片、`a3:` 错误、`af:` 元数据
- 匿名注册：`POST /nextjs-api/sign-up {recaptchaToken(action="sign_up"), provisionalUserId}` → set-cookie arena-auth-prod-v1
- 会话刷新：`POST /nextjs-api/refresh`（返回 58KB RSC 数据 + 轮换 cookie）
- reCAPTCHA Enterprise sitekey: `6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0`
- 模型清单：页面 RSC 数据 `initialModels`（1052 条，含 id/organization/displayName/capabilities/rank）
  - 例：claude-sonnet-4-6 → id 019c6d29-a30c-7e20-9bd0-6650af926623（org anthropic, provider googleVertexAnthropic）
  - 阵容：claude-opus-4-5~4-8/5 系、gpt-5.4 系、gemini-3.1-pro、grok-4.6、deepseek-v4、qwen 系等

## 风控结论（实测）

- Direct 模式匿名 → **401 LOGIN_GATE**（需登录）
- Battle 模式匿名 → **403 recaptcha validation failed**（token 有效/action 正确仍被拒）
- 根因：dshb 共享浏览器为 **Headless Chrome + navigator.webdriver=true** → reCAPTCHA Enterprise 判 bot 低分
- sign-up action 阈值松（能过），chat_submit 阈值高（headless 环境全灭）
- **推断**：真人正常浏览器匿名 battle 可用（LMArena 核心产品）；Direct 需要账号
- 页面 UI 的 uuidv7 生成有 46-hex bug（首次发送 400，自动重试正常）

## 三个参考项目（全是浏览器扩展架构）

- deanxv/lmarena2api（老，canary.lmarena.ai 已死）
- flay-o/arena2api → ranbeerrathore56-art/arena2api（15d）→ kekurttel/Arena2api-fixed（2mo）
- 架构：用户浏览器装扩展 → 保持 arena.ai 页面开启 → 扩展每 80s grecaptcha execute 刷 token 池 → 推给服务器 → 服务器带 cookie+token 从 Python 发请求
- 均未解决凭据/token 自动化；cookie 可能分片（arena-auth-prod-v1.0 + v1.1）

## 候选方案

- **A. 内置有头浏览器伴生服务**：gateway 侧跑 Playwright headed（stealth 反 webdriver 检测）开 arena.ai → 页面内刷 token + 页面内发请求（同源真实 Chrome TLS）→ 转发。全自动但复杂。
- **B. 账号 cookie 直连**：用户登录一次 → 导出 arena-auth-prod-v1 → 网关 Node/curl 直连。待验证：登录态 chat 是否免 token（chunk 代码显示 token 可为 null 继续发送）+ Node TLS 指纹是否被 CF 拦（gorouter 教训：需 curl.exe Schannel 通道）。
- **C. 用户真人浏览器验证匿名可用性后，再选 A 或 B。**

## Notion token 自动化（用户提出）

- Notion 支持邮箱+密码登录 API：`POST /api/v3/loginWithEmail {email, password, ...}` → set-cookie token_v2
- 可在网关加 notionEmail/notionPassword 配置，token 失效时自动登录换 token_v2（而非用户手动复制）
