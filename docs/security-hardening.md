# 安全整改记录（渗透测试四批 + 刻意不做）

> 本文从 README 拆出（v1.18.8）：README「安全体检」一节只留 sec-audit 脚本用法与整改现状一句话，本文收完整过程。
> 每一批的守卫都在 `test/security-headers-e2e.test.js`（+ 会话批的 `test/admin-session-e2e.test.js`）里，
> 改鉴权 / 静态文件 / 响应头 / 控制台时必跑。

## 本机实测结论（2026-10-02，v1.18.2 部署）

鉴权覆盖面完整（管理面/客户端面无密钥与错密钥均 401）、示例默认密钥被拒、
私有文件全部 404、错误体不含密钥、无 CORS。

## 同日外部渗透测试（黑盒、未读源码）复核

10 项发现中 9 项属实，已按批次整改——

**第一批（v1.18.3）已修**：无密钥/错密钥下 `/console` 可打开且全站**无任何安全响应头**（现补 `nosniff` / `X-Frame-Options: DENY` /
`Referrer-Policy: no-referrer` / `Permissions-Policy`，管理面与 `/healthz` 加 `Cache-Control: no-store`）；
控制台**渲染层转义不一致**（模型名/渠道名等裸插值 + `toast()` 把上游错误串当 HTML，构成"持有网关密钥 → 管理端脚本执行"的存储型 XSS 链，
现已统一过 `esc()`，以 `test/security-headers-e2e.test.js` 的"裸插值必须为零"守卫锁住）。

**第二批（v1.18.4）已修**：管理面**默认不再下发任何密钥原文**——`/admin/api/status` 与 `/admin/api/channels` 的 `apiKey` 只给
`maskSecret()` 掩码（另给 `apiKeySet` 布尔；本机实测 32/32 条全是掩码、查询正文里不含任何一把真密钥）；`/admin/api/config` 不再
同时交出 `ADMIN_KEY` 与 `GATEWAY_KEY`（改给掩码 + `keysInsecure` 布尔）。原文只能**按需单取**：两个新端点
`GET /admin/api/channels/{id}/key`、`GET /admin/api/gateway-key` 仍走 admin 鉴权（把"一次泄漏 = 全部密钥"降成"一次泄漏 = 一把"）。
渠道 `POST` 的 `apiKey` 改为「**留空 = 保持原密钥**」，防止控制台带着掩码回写把密钥抹掉；`checkAuth` 改 `sha256` +
`crypto.timingSafeEqual` 恒定时间比较，9 处鉴权点统一走 `authGate()`（每类每分钟最多 30 次**失败**尝试 → 429 + `Retry-After`，
成功一次即清零，窗口式不永久锁定，正密钥不受影响）。控制台相应改成"点一下才现取一次原文"。

**第三批（v1.18.6）已修**：① 补上 **CSP 响应头**（`default-src 'self'`，脚本/样式因单文件控制台开放 `'unsafe-inline'`——真正的兜底在
`connect-src 'self'`：即使 XSS 偷到会话 cookie 也发不出去；字体走 MiSans CDN 已在 `font-src` 白名单）；② **`/console?key=…` 拆除**——渗透报告点名
"密钥进浏览器历史"，v1.18.6 起管理面不再认 `?key=`（正确密钥走查询串也 401），浏览器改走**会话 cookie**（见 [docs/behavior.md](behavior.md)「管理面会话」）；
客户端面 `?key=` **保留**（Gemini SDK 的另一默认鉴权模式，不在整改面内）。

**第四批（v1.18.7）已修**：**彻底消灭内联事件处理器**——`build/app.js` 与 `build/shell.html` 里 72 处
`onclick=`/`onchange=`/`onkeydown=` 属性全部清零：动作进 `data-act`（change 走 `data-change`）、参数走 `data-*`、
`document` 上两个委托监听统一分发（`ACTS` 表 44 个动作与模板**双向一一对应**，新增交互必须先注册）。行内按钮天然只触发
最近那枚，`stopPropagation` 成为历史；渠道 ID/请求 ID 不再拼进事件代码字符串（v1.18.3 的 `esc()` 仍守一切进入 HTML
的外部值，包括 `data-*` 属性值）。守卫在 `test/security-headers-e2e.test.js`（内联属性必须为 0 + ACTS 双向覆盖 +
遮罩也走 `data-act`）与 `test/console-state.test.js`（把真实委托块抠出来在桩上真跑分发：dataset 参数到达、嵌套只触发
最近那枚、未知动作不炸、change 同路）。

## 其余建议的处置：刻意不做

**强制密钥长度/熵（不符合就拒绝启动）与多用户/角色/审计**：本项目定位是**单用户自托管**，首启随机生成密钥、示例默认值只服务本地开发，把这两条做进来会破坏开箱即用（外部渗透测试报告的建议据此驳回，理由记在此处以免重复提）。

**给公网部署者**：本项目的隐藏前提是「知道密钥的人就是管理员」——请只在可信网络或反向代理后暴露，并务必给公网入口加 TLS（会话 cookie 刻意没加 `Secure` 旗标，就是为 http 本地/局域网；公网 TLS 部署时应在反代层终止并保留 `HttpOnly`/`SameSite` 语义）。
