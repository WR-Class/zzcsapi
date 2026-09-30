# 安全整改记录（渗透测试六批 + 处置台账 + 复查记录）

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

**第六批（v1.18.10）已修**：**Host/Origin 门**——渗透报告 V-07 点名"`Host`/`Origin` 无校验是 DNS 重绑定土壤"。
两道门拦在一切路由之前：① `Host` 白名单 = `localhost` + 回环/私网/链路本地 **IP 字面量**（用户按裸 IP 访问控制台与 API 的常态
天然通过，**不误伤局域网用法**——这是当初没按整改指南原方案做的原因：指南的域名白名单默认会拒掉所有者自己的局域网访问，
本方案反过来"按 IP 字面量放行、按域名默认拒"）+ `ZZCSAPI_ALLOWED_HOSTS` 显式登记域名（反代/公网场景必须登记，公网默认拒是刻意姿势）；
其余一律 **421**——重绑定页面必须带着攻击者的域名来，正好被拦死。② `Origin` 与 `Host` 不同源一律 **403**（本网关不开 CORS；
服务器间脚本不带 Origin，零影响；与 `SameSite=Strict` 叠加，跨源写双保险）。**没有**引入指南建议的 `X-ZZ-Request` 强制头
（会破坏全部现有脚本，而 `SameSite=Strict` + Origin 门已挡住跨源写）。验收直接用了交付包自己的复测脚本：
`raw.mjs hostEvil` 从 200 变 421。守卫在 `test/security-headers-e2e.test.js`（421 / 403 / 放行三态 + 装配位置 + 白名单注入）。

## 处置台账（2026-09-29 渗透交付复查后定稿）

外部渗透交付包共 **11 项漏洞（V-01~V-11）+ 3 项鉴权后审计发现（C-01/02/03）+ 1 条风险接受（RA-01）**，逐项处置：

| 发现 | 处置 | 落在哪 |
| --- | --- | --- |
| V-01 XSS / V-04 响应头 / V-06 `?key=` / C-01 / C-02 / C-03 | **已修** | 第一~四批（上）+ v1.18.5 轮换工具 + RA-01 风险接受 |
| V-03 无限爆破 | **已修**（`authGate` 30 次/分钟 + 429 + `timingSafeEqual`；审计落盘随"多用户/角色/审计"一并刻意不做） | 第二批（上） |
| V-08 `/healthz` 泄露内部状态 | **已修** | 第五批（v1.18.9，上） |
| V-05 监听 `::` 且无 TLS | **部分成文接受** | 裸 Node 默认 `127.0.0.1`（server.js `listen` 缺省值）；docker 刻意放开局域网——compose 文件内注释即风险接受记录（含收紧写法指引）；"非回环且无 TLS 拒绝启动"不做：本网关设计上跑 http 本地/局域网，见下"给公网部署者" |
| V-07 `Host`/`Origin` 无校验 | **已修（第六批 v1.18.10）** | Host 白名单（IP 字面量放行 + 域名默认拒 421）+ 跨源 Origin 403——当初"已知未修"时记录的顾虑（指南原方案会拒掉所有者自己的局域网访问）已由"按 IP 字面量放行"的设计化解，2026-09-29 复查后用户拍板加强（有缓解 ≠ 安全） |
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
- **复查后的追加决策（2026-09-29）**：台账里 V-07"已知未修"经用户复核改判为**加强**（有缓解 ≠ 安全）→ 第六批（v1.18.10）落地；V-11 维持接受（威胁模型边界论证见台账行）。

## 外部复测处置（2026-10-04，交付包 retest-after-fix.md）

> **交付包存放位置（补登记）**：本机**桌面**的 `ZZCSAPI-渗透测试交付` 文件夹（`reports/` 五件：pentest-report / remediation-guide / authenticated-readonly-audit / retest-after-fix / README；`logs/` `artifacts/` `notes/` 为证据）。此前台账只引内容不记位置，接手者要全盘搜索才能找到——2026-10-04 补记在此（含本机用户名的完整路径不写进公开仓库）。

复测结论（黑盒只读，与基线逐项对比）：**V-01 / V-02（C-01/C-02） / V-03 / V-06 / V-07 / V-08 全部确认已修**；V-04 大部分（残余 = HSTS/COOP/CORP + `Server` 版本号，处置见下）；V-05 判"未修复"（**维持接受**，见下）；V-09 / V-11 不在其复测范围内（**台账既有处置不变**：V-09 是一次性引导行为，且本部署两把密钥都来自 `.env`、首启打印路径根本不激活；V-11 是 admin-only 面）；V-10 维持 RA-01。复测另注"已鉴权端点无限流"——通用 `rateLimit` 是运行期开关（默认关），记录在案不处置。新增 5 项小发现（N-01~N-05），处置：

| 发现 | 处置 |
| --- | --- |
| N-01 `Server: nginx/1.28.0` 暴露版本号 | **已修**：`deploy/nginx-reverse-proxy.conf` 加 `server_tokens off`（守卫进 `test/reverse-proxy-config.test.js`） |
| N-02 `/metrics` 401 无 `Cache-Control` | **已修**：server.js 响应头收口从 `/admin/api/`+`/healthz` 扩到 `/metrics`（401/404 全态 `no-store`；守卫进 `test/security-headers-e2e.test.js`）。修在网关收口而非 nginx 全局加——全局 `no-store` 会把 `/console` 壳自己的缓存策略一并改掉 |
| N-03 HSTS / COOP / CORP 缺 | **已落地（v1.18.16 公网部署）**：三头加在公网 TLS 前端 `deploy/nginx-public.conf` 的 nginx 层（复测建议的原位，README「方式四」）——本机 http 前端刻意不加（http 上 HSTS 无效；与会话 cookie 刻意无 `Secure` 同一姿势） |
| N-04 CSP 引外部字体 CDN（供应链/隐私面） | **维持**（AGENTS §2 的 MiSans 官方 CDN 是刻意约定；自托管子集化是独立工作项，风险在此记录在案） |
| N-05 内联脚本无 nonce，CSP 需 `'unsafe-inline'` | **维持**（单文件交付是项目前提；XSS 防线 = 转义纪律 + `security-headers-e2e` 守卫；脚本外置是独立工作项） |

**V-05 维持接受，但修正复测报告的一处事实**：报告称"8787 入站放行规则：无（仍靠默认阻止策略兜底）"——本机实测相反，Windows 防火墙存在 nginx.exe 的**显式放行规则**（公用档；nginx 首次启动弹窗时点了允许，否则局域网客户端根本连不进来）。真实边界 = 路由器 NAT + 这条放行规则；接受理由不变：用户 2026-10-04 确认**单机家用网络**，且 `0.0.0.0:8787` 是功能需要（局域网接入 = per-IP 来源统计的前提）。将来接共享网络或上公网时，先收紧防火墙档位（仅专用网络放行）或把 nginx 收到 `listen 127.0.0.1:8787`。

复测"特别提示"（nginx 层引入后改响应头要**两层一起看**，别"改了网关却被 nginx 覆盖"或反之）：已落 README「方式三」纪律清单与 `test/reverse-proxy-config.test.js` 的 conf↔compose↔README 一致性守卫。

实测（2026-10-04，curl）：`Server: nginx`（无版本号）；`/metrics` 无密钥 → **401 + `Cache-Control: no-store`**。

## 其余建议的处置：刻意不做

**强制密钥长度/熵（不符合就拒绝启动）与多用户/角色/审计**：本项目定位是**单用户自托管**，首启随机生成密钥、示例默认值只服务本地开发，把这两条做进来会破坏开箱即用（外部渗透测试报告的建议据此驳回，理由记在此处以免重复提）。

**给公网部署者**：本项目的隐藏前提是「知道密钥的人就是管理员」——请只在可信网络或反向代理后暴露，并务必给公网入口加 TLS（会话 cookie 刻意没加 `Secure` 旗标，就是为 http 本地/局域网；公网 TLS 部署时应在反代层终止并保留 `HttpOnly`/`SameSite` 语义）。**反代层仓库已备好**（v1.18.14，README「方式三」）：`deploy/nginx-reverse-proxy.conf` + compose 的 `ZZCSAPI_PUBLISH` 开关 + 固定子网 `172.28.137.0/24`（`security.trustedProxy` 登记网桥网关 `172.28.137.1` 即可拿到真实来源 IP），公网部署在它之上加 TLS 证书即可；nginx 侧**必须保持 `X-Forwarded-For` 覆写语义**（`$remote_addr`）——换成追加模式（`$proxy_add_x_forwarded_for`）会让客户端预置假 XFF 伪造来源统计、甚至借封禁把人锁死（守卫在 `test/reverse-proxy-config.test.js`）。**公网前端仓库已备好（v1.18.16，README「方式四」）**：`deploy/nginx-public.conf`（Let's Encrypt TLS + HSTS/COOP/CORP 三头 + XFF 覆写同源 + 只反代回环转发口 127.0.0.1:18787），80 段只留 ACME 验证与 301 跳转，续期走 certbot.timer。**公网实例必须换全新密钥**——示例密钥公开在本仓库，公网照抄 = 裸奔（"单机自用"风险接受的失效触发点）；域名必须登记 `.env` 的 `ZZCSAPI_ALLOWED_HOSTS`（Host 门默认拒陌生域名，421；compose 自 v1.18.16 真透传该变量——此前是 compose 清单里的注释行，公网域名一律 421），公网防火墙只放 SSH/80/443。

## 来源 IP 统计的数据留存界限（v1.18.11 补记）

v1.18.11 加了来源 IP 态势统计（per-IP 敲门 / token / 并发 / 会话估计 / 客户端标签）与封禁。留存的刻意边界，与渗透整改期「不留可关联数据」的姿势对齐：

- **统计是内存态**：网关重启清零；不落任何盘上文件（检测数据丢得起，学管理面会话的先例）。留存的**有界**：IP 上限 512 行（超限丢最旧 lastSeen）、每 IP 会话 512 / 客户端标签 8 / 模型 64；24 小时桶本地时区、跨天清零。
- **封禁表落 `config.json`**（`config.security.bannedIPs`）——这是**所有者自己的封禁决定**，不是被动采集的关联数据，重启不丢是功能要求。
- **`X-Forwarded-For` 只在 `config.security.trustedProxy` 登记的来源上采信第一跳**（XFF 客户端可伪造；不设门槛就采信会把封禁变成假功能——任意客户端伪造 IP 甩锅给别人）。全仓只有 `clientIpOf` 一处读它，`::ffff:` 前缀两侧归一。
- **客户端标签（UA 自报）只做显示**，绝不进任何控制逻辑的判定（UA 同样可伪造）；渲染层 `esc()` 过（外部可控值）。
- **封禁只拦客户端面**：管理面/控制台/健康检查永远可达——解封按钮永远不会把自己锁在门外（被抄走的密钥也不该有能力把所有者锁在门外）。
- 挂反代时（公网部署常态）**必须**把反代地址填进 `security.trustedProxy`，否则统计与封禁都会记/封反代自己的 IP（假功能）；同时按上文给公网入口加 TLS。Docker Desktop 上尤其要在意这条：不加反代层时端口发布是 NAT，**所有来源都会折叠成网桥网关一个 IP**（per-IP 态势等于废掉一半，且封禁会变成"一封封全部"）——现成接法见 README「方式三」（宿主机 nginx + `ZZCSAPI_PUBLISH` 开关 + 固定子网 `172.28.137.0/24`，`trustedProxy` 填网桥网关 `172.28.137.1`；配置守卫 `test/reverse-proxy-config.test.js`）。

语义与守卫：`test/ip-stats-ban-e2e.test.js`（62 项，含 trustedProxy 采信与伪造对照组）；行为细节见 docs/behavior.md「来源 IP 态势统计与封禁」。
