# Arena.ai 渠道协议（2026-09-06 定稿）

## 架构（已上线）

```
客户端 → 网关容器(:8787, protocol:"arena") → HTTP → 宿主机 arena-agent(:9225)
                                            → CDP → 宿主机真 Chrome(headful) → arena.ai
```

- **arena-agent.js**（宿主机 Node，watchdog 开机自启）：spawn 真 Chrome（`--app` 窗口，
  `--remote-debugging-port=0`，profile 独立）→ CDP attach → cookie 注入 → 导航 arena.ai
  → /ensure（模型注册表）、/chat（NDJSON 流式）、/refresh（会话续期）
- **容器内不跑浏览器**：Alpine Chromium（含 headless=new + UA 覆盖）被 arena.ai 的
  Cloudflare **硬拦**（"Sorry, you have been blocked"，UA/UA-CH 全改也无效——二进制层指纹）。
  宿主机真 Chrome 同款二进制（用户日常浏览器）正常通过。
- **Chrome DevTools 拒绝非 localhost Host**：容器无法直连宿主机 CDP → 必须经 arena-agent 的
  HTTP API 中转（Docker Desktop 的 host.docker.internal 中继可达宿主机 127.0.0.1 端口）。
- cookie 轮换：sidecar 每 20 分钟 `POST /nextjs-api/refresh` → 新 cookie 经
  onPersist 写 agent-cookie.txt + 回传网关 → persistConfig 回写 config.json（用户无感）。

## 请求协议（OmniRoute PR #6280 对齐 + 实测验证）

```
POST https://arena.ai/nextjs-api/stream/create-evaluation   (页面内同源 fetch, credentials:include)
body: {
  id, userMessageId, modelAMessageId,          // UUIDv7（无 modelB* 字段！）
  mode: "direct-battle",                       // ⚠️ "direct" 报 400 "'direct' mode is not allowed
                                               //    when starting a new conversation"
  modelAId: <arena 模型 UUID>,
  userMessage: { content, experimental_attachments: [], metadata: {} },
  modality: "chat",
  recaptchaV3Token: <token | null>,
}
```

- content 格式（OmniRoute formatArenaPrompt）：单条用户消息→纯文本；多轮→
  `System:/User:/Assistant: ` 标签行，双换行分隔
- 响应行流 `[participant]code:value`（participant ∈ {a,b}）：
  `0` 文本增量、`g` 思考、`2` 心跳、`3` 错误、`d` 完成(finishReason=error 则错)、
  `ae:` 旧错误格式、`f` 元数据
- reCAPTCHA Enterprise sitekey `6LeTGMcsAAAAALuIlkVwIxaAuZA8VledA6d3Nnb0`，
  action **`chat_submit`**（前端 chunk 1cx59sa85p90e.js：`R = getRecaptchaV3Token("chat_submit")`）
- token mint：页面内 grecaptcha.enterprise.execute（enterprise.js 未加载时动态注入）

## 模型（注册表 1052 条 / 798 唯一名，key=displayName）

- 路由：config `models` = { alias: displayName }，运行时 displayName → id（大小写不敏感）
- **实弹验证可用**：claude-sonnet-4-6、claude-sonnet-5(→claude-sonnet-5-high)、
  claude-haiku-4-5(→claude-haiku-4-5-20251001)、gemini-3.1-pro
- **404 Model not found**（注册表有 id 但实际不可用，soft-exclude）：gpt-5.4、gpt-5.4-mini-high
- 部分模型带分层名：grok-4.6 实为 grok-4.6-medium/low/high；claude-sonnet-5 只有 -high/-search
- arena.ai 无 opus 系模型（注册表搜 "opus" 仅 "flying-octopus" 模型名）

## 风控实测

- **reCAPTCHA v3 行为评分**：headless（Edge/Chrome，含 UA 覆盖+CDP 行为预热）mint 的
  token 被 arena 服务端拒（403 recaptcha validation failed）→ GPT 系等强校验模型全拦。
  headful（--app 真窗口）+ 行为预热可通过（claude 系 200 实测）。
- **频率风控**：短时间批量请求（21 模型连发）后，arena 对该账户收紧 recaptcha 校验，
  连 claude 系也 403。正常低频使用不受影响；批量探测需要间隔/冷却。
- CF 对容器内 Chromium 的拦截与 UA 无关（二进制 TLS 指纹层）——见上文架构结论。

## 运维

- agent：`arena-chrome\watchdog.ps1`（开机自启：启动文件夹 ZZCSAPI-Arena-Chrome.bat；
  30s 心跳自愈），headful 模式 env `ZZCSAPI_ARENA_HEADFUL=1`
- **窗口隐藏**：headful 窗口移到屏幕外（--window-position=-32000,-32000），
  桌面无可见窗口，仅任务栏一个图标。注意 Chrome 遮挡检测可能延迟把屏幕外
  窗口判为 occluded（visibilityState=hidden）——已加
  `--disable-features=CalculateNativeWinOcclusion` 缓解，但部分版本仍会回落
  hidden；实证 claude/gemini 系模型不受影响（headless 下也 200 过），
  仅 GPT 系（严格 recaptcha 校验）理论上受损（gpt-5.4/5.4-mini 已下架）。
- 诊断端点：`GET http://127.0.0.1:9225/state`（页面 visibility/token 状态）、
  `/healthz`；agent 日志：`arena-data\agent.log` / `agent-err.log`
- 重启工具：`arena-chrome\restart-agent.ps1` / `restart-watchdog.ps1`
  （watchdog 重启勿在命令行内联过滤 powershell 进程——命令文本会匹配到宿主自身）
- cookie 上传：arena.ai 页面 F12 控制台
  `fetch('http://localhost:8787/admin/api/arena-cookie',{method:'POST',headers:{'content-type':'text/plain'},body:document.cookie})`
  （零转录：cookie 字节从浏览器直达网关；手动复制 3000+ 字符两次引入坏字节 → Vercel 500）
- 网关容器 env `ZZCSAPI_ARENA_AGENT=http://host.docker.internal:9225`；
  无此 env 时降级容器内 spawn（Windows 开发可用，Alpine 被 CF 拦）
- profile：`%TEMP%\zzcsapi-arena-profile`（浏览器本地数据；删除=重置设备身份）

## 参考

- OmniRoute PR #6280（lmarena executor 现代化，direct-battle 负载/流解析/content 格式的来源）
- deanxv/lmarena2api、flay-o/arena2api（cookie 分片处理、sitekey/action）
