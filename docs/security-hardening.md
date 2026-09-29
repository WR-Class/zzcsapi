# 安全整改记录（渗透测试五批 + 处置台账 + 复查记录）

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

**第五批（v1.18.9）已修**：**`/healthz` 精简到 `{ok:true}`**——渗透报告 V-08 点名"存活探针免鉴权是有意设计，但返回体超出了存活所需"：
匿名面原来还能读到渠道规模（`channels:32`）与双密钥配置状态（等于免费给未鉴权者做侦察：这个网关值不值得打、密钥在不在用）。
v1.18.9 起只回答"活着吗"；守卫断言在 `test/security-headers-e2e.test.js`（`/healthz` 响应体的键集必须是 `["ok"]`），
消费方核验过全部只看状态码（docker healthcheck 的 `wget` 只看退出码、全部 e2e 只看 `.ok`、sec-audit 只看 200）。

## 处置台账（2026-09-29 渗透交付复查后定稿）

外部渗透交付包共 **11 项漏洞（V-01~V-11）+ 3 项鉴权后审计发现（C-01/02/03）+ 1 条风险接受（RA-01）**，逐项处置：

| 发现 | 处置 | 落在哪 |
| --- | --- | --- |
| V-01 XSS / V-04 响应头 / V-06 `?key=` / C-01 / C-02 / C-03 | **已修** | 第一~四批（上）+ v1.18.5 轮换工具 + RA-01 风险接受 |
| V-03 无限爆破 | **已修**（`authGate` 30 次/分钟 + 429 + `timingSafeEqual`；审计落盘随"多用户/角色/审计"一并刻意不做） | 第二批（上） |
| V-08 `/healthz` 泄露内部状态 | **已修** | 第五批（v1.18.9，上） |
| V-05 监听 `::` 且无 TLS | **部分成文接受** | 裸 Node 默认 `127.0.0.1`（server.js `listen` 缺省值）；docker 刻意放开局域网——compose 文件内注释即风险接受记录（含收紧写法指引）；"非回环且无 TLS 拒绝启动"不做：本网关设计上跑 http 本地/局域网，见下"给公网部署者" |
| V-07 `Host`/`Origin` 无校验 | **已知未修，记录在案** | 现有缓解：会话 cookie 按域名（127.0.0.1/局域网 IP）键控 + `SameSite=Strict`，DNS 重绑定页面带不走它；写操作仍需 Bearer；`frame-ancestors 'none'` 挡读 console。整改方案建议的 421 白名单 + `X-ZZ-Request` 自定义头会**破坏现有脚本/测试**且默认白名单会把所有者自己的局域网访问 421 掉——不值得为单用户自托管引入。复测时**不当新发现重复上报** |
| V-09 首启密钥进容器日志 | **接受** | 首启打印是一次性引导行为：拿到 `docker logs` 读权限的人本就能读挂载的 `config.json`，日志不构成新增暴露面；密钥同时落 `config.json`（重启不变），看完日志即可换掉（v1.18.5 控制台轮换）。README 快速开始照旧教这条命令，属刻意保留 |
| V-11 渠道 `baseUrl`/`proxy` 无 SSRF 约束 | **接受** | 渠道配置是 admin-only 面（拿到 ADMIN_KEY 的人已等价于本机管理员）；且**默认禁私网会打断本项目的核心用法**——genspark 渠道必须走 `host.docker.internal` 代理、上游多为中转私网地址。渗透报告自标"设计缺陷，未实测利用"，其武器化前提（XSS 偷会话）已在第一/四批关闭 |
| V-10 单一静态密钥 | **阶段一已修**（会话/退出/轮换清会话，v1.18.6），角色/审计**刻意不做**（下节） | 第三批（上） |

## 复查记录（2026-09-29，渗透交付包附录 B 脚本现场复测）

整改后按交付包 `notes/risk-acceptance.md` 约定的复测动作，把附录 B 脚本对生产实例全部跑了一遍：

- **未授权面**：`probe.mjs sweep` 全部敏感路径（`.env` / `.git/config` / `config.json` / `server.js` / `usage.json` / `backup.zip` 等）均 404，匿名可达仅 `/healthz`、`/console` ✓
- **爆破限流**：`authz.mjs ratelimit` 40 发错密钥 → 401×N 后 **429 + Retry-After（约 60 秒）**，V-03 修复实证 ✓
- **协议层**：`raw.mjs` 九项——CLTE/TECL 走私 400 拒、路径穿越 404、超长 URL/头 431、CRLF 注入不成立 ✓；`Host: evil.example` 仍 200（即上方 V-07 台账"已知未修"）
- **点击劫持**：`frame-ancestors 'none'` + `X-Frame-Options: DENY` 实测在位，PoC 页 iframe 被拒 ✓
- **双实例疑云解除**：交付包复测待办第 4 条担心"旧实例未升级导致修复等于没修"——实测当年观察到的 `::1` PID 7272 是 **wslrelay**（Docker Desktop 的 localhost 中继，不是第二个网关进程），`::` PID 9220 是 `com.docker.backend`；两者是**同一个容器端口的两条发布路径**。唯一服务实例 = zzcsapi 容器，其 `console.html` MD5 与仓库一致（54e3da…）✓

## 其余建议的处置：刻意不做

**强制密钥长度/熵（不符合就拒绝启动）与多用户/角色/审计**：本项目定位是**单用户自托管**，首启随机生成密钥、示例默认值只服务本地开发，把这两条做进来会破坏开箱即用（外部渗透测试报告的建议据此驳回，理由记在此处以免重复提）。

**给公网部署者**：本项目的隐藏前提是「知道密钥的人就是管理员」——请只在可信网络或反向代理后暴露，并务必给公网入口加 TLS（会话 cookie 刻意没加 `Secure` 旗标，就是为 http 本地/局域网；公网 TLS 部署时应在反代层终止并保留 `HttpOnly`/`SameSite` 语义）。
