/* 反代采信层配置守卫（v1.18.14，零依赖）：宿主机 nginx + 网关只绑回环转发口 + 固定子网 + 自启脚本。
   背景：Docker Desktop 的端口发布是 NAT——直连打进来的所有连接进容器后源地址都折叠成网桥网关
   那一个 IP，来源统计永远只有一行。宿主机 nginx 是连接终点，看得到真实客户端 IP，覆写
   X-Forwarded-For 交给网关采信（config.security.trustedProxy 登记反代直连地址 = 网桥网关）。
   本用例守四条命脉（改坏任何一条都是真漏洞 / 真退化 / 真断网）：
   ① XFF 必须**覆写**为 $remote_addr——追加模式（$proxy_add_x_forwarded_for）会让局域网客户端
     预置假 XFF 伪造来源统计、甚至借封禁功能把别人锁死；
   ② 转发口只绑宿主回环（127.0.0.1:18787）——局域网绕不过 nginx（绕过 = 统计分家 + 采信层架空）；
   ③ 默认直连模式不能改坏——新克隆的人不配 nginx 也要开箱能用，故 compose 的发布口走
     `${ZZCSAPI_PUBLISH:-8787:8787}` 变量开关，代理端口只出现在 .env/README 里；
   ④ 固定子网（网桥网关 IP 恒定）+ README 写的 trustedProxy 与之逐字一致——子网漂移 =
     trustedProxy 静默失效（来源统计悄悄退回一行网桥 IP）。
   另守两条现场教训：nginx 不是 Windows 服务 → 自启脚本必须存在且幂等；
   Windows PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1 → 脚本必须纯 ASCII（中文注释会让它语法错）。
   2026-10-04 外部复测（交付包 retest-after-fix.md）处置增补：server_tokens off（N-01，
   Server 头不报版本号——版本号是给扫描器的免费情报）。
   同日公网部署（v1.18.16）增补：deploy/nginx-public.conf（公网 TLS 前端）——XFF 覆写
   同源、HSTS/COOP/CORP 三头（N-03 TLS 里程碑落地）、TLS 只开 1.2/1.3、80 只留
   ACME+301、LE 标准证书路径、README 公网四件套；compose 必须真透传
   ZZCSAPI_ALLOWED_HOSTS（现场教训：注释行透传 → 公网域名一律 421）。
   橙云姿势（v1.18.18）增补：CF Proxied 下真实访客 IP 靠 nginx realip 白名单采信
   CF-Connecting-IP（只认 CF 网段直接对端，直连伪造头一律无视）；网关侧绝不读该头
   （XFF 覆写仍是唯一通路）；CF 侧必须 Full (strict)（Flexible + 源站 80 的 301
   = 访客无限重定向循环）；README 必须写全橙云姿势与源站锁定/切回灰云放行。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let fails = 0, n = 0;
function check(name, ok, extra) {
  n++;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok || extra === undefined ? '' : '（' + extra + '）'));
  if (!ok) fails++;
}
/* 注释不算配置：守卫只看生效行——注释里会正当地出现反面教材（如"别用 $proxy_add_x_forwarded_for"）
   与开关示例值，直接 includes 会误报（v1.18.14 首次运行踩到）。 */
const stripComments = (text) => text.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');

console.log('反代采信层配置守卫（docker-compose.yml + deploy/nginx-reverse-proxy.conf + README 一致性）');

const NGINX = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx-reverse-proxy.conf'), 'utf8');
const COMPOSE_RAW = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
const NGINX_LIVE = stripComments(NGINX);
const COMPOSE = stripComments(COMPOSE_RAW);
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const EXAMPLE = fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8');
const STARTER = fs.readFileSync(path.join(ROOT, 'deploy', 'start-reverse-proxy.ps1'), 'utf8');

/* ── ① XFF 覆写纪律（安全命脉）── */
check('nginx X-Forwarded-For 覆写为 $remote_addr（受信反代交给网关的唯一真实来源）',
  NGINX.includes('proxy_set_header X-Forwarded-For $remote_addr;'));
check('nginx 绝不用追加模式 $proxy_add_x_forwarded_for（客户端预置假 XFF 会伪造来源统计/借道封禁）',
  !NGINX_LIVE.includes('$proxy_add_x_forwarded_for'));
check('nginx 透传原始 Host（$http_host）——网关的 Host 门要看客户端原始值',
  NGINX.includes('proxy_set_header Host $http_host;'));

/* ── ② 转发口只绑宿主回环 ── */
check('nginx 转发目标 = 127.0.0.1:18787（网关容器只绑宿主回环的转发口）',
  NGINX.includes('proxy_pass http://127.0.0.1:18787;'));
check('nginx 监听 8787（局域网入口）', /listen\s+8787;/.test(NGINX));

/* ── ③ 默认直连模式不能被改坏（新克隆开箱可用）── */
check('compose 发布口走 ${ZZCSAPI_PUBLISH:-8787:8787} 变量开关（默认仍是直连模式）',
  COMPOSE.includes('${ZZCSAPI_PUBLISH:-8787:8787}'));
check('compose 不把反代端口写死（代理口只出现在 .env / README，不污染默认部署）',
  !COMPOSE.includes('127.0.0.1:18787:8787'));

/* ── ④ 固定子网与 trustedProxy 一致性 ── */
check('compose 固定子网（默认 172.28.137.0/24）——网桥网关 IP 才恒定',
  COMPOSE.includes('${ZZCSAPI_SUBNET:-172.28.137.0/24}'));
check('服务挂到 zznet 固定子网（不挂则分到默认网段，网桥网关 IP 不定）',
  /networks:\s*\n\s*-\s*zznet/.test(COMPOSE) && /networks:\s*\n\s*zznet:/.test(COMPOSE));
check('README 写的 trustedProxy 值 = 子网网桥网关 172.28.137.1（漂移即静默失效）',
  README.includes('172.28.137.1'));

/* ── 流式与体量纪律 ── */
check('nginx proxy_buffering off（SSE 流式被缓冲会卡死）', NGINX.includes('proxy_buffering off;'));
check('nginx proxy_read_timeout ≥ 3600s（慢流式长回复不被掐断）',
  /proxy_read_timeout\s+(\d+)s/.test(NGINX) && Number((NGINX.match(/proxy_read_timeout\s+(\d+)s/) || [])[1]) >= 3600);
check('nginx client_max_body_size 有上限（网关自身不设限，这里是唯一上限）',
  /client_max_body_size\s+\d+m/.test(NGINX));
check('nginx 上游长连接（proxy_http_version 1.1 + Connection ""）',
  NGINX.includes('proxy_http_version 1.1;') && NGINX.includes('proxy_set_header Connection "";'));
check('nginx server_tokens off（Server 头不报版本号——外部复测 N-01：版本号是给扫描器的免费情报）',
  NGINX_LIVE.includes('server_tokens off;'));

/* ── 自启脚本（nginx 不是 Windows 服务：重启后不启动 = 8787 没人监听，客户端全连不上）── */
check('自启脚本存在且幂等（已在 8787 监听时静默退出）',
  STARTER.includes('Get-NetTCPConnection -LocalPort 8787') && STARTER.includes('exit 0'));
check('自启脚本按本仓库的 conf 启动（不是另抄一份配置）',
  STARTER.includes("'nginx-reverse-proxy.conf'"));
check('★ 自启脚本纯 ASCII（Windows PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1，中文注释会当场语法错）',
  !/[^\x00-\x7F]/.test(STARTER));

/* ── 文档接线（新增部署件必须在 README 落地：开、关、坑）── */
check('README 给出开启开关（ZZCSAPI_PUBLISH=127.0.0.1:18787:8787）',
  README.includes('ZZCSAPI_PUBLISH=127.0.0.1:18787:8787'));
check('README 引用 nginx 配置文件与自启脚本', README.includes('deploy/nginx-reverse-proxy.conf') && README.includes('start-reverse-proxy.ps1'));
check('README 写了回退路径（删/改 ZZCSAPI_PUBLISH + 清空 trustedProxy）',
  /ZZCSAPI_PUBLISH/.test(README) && /清空\s*`?security\.trustedProxy`?/.test(README));
check('README 提醒"别把 nginx 放进容器"（容器里同样被 NAT 折叠，白搭）',
  README.includes('别把 nginx 放进容器'));
check('config.example.json 仍登记 security.trustedProxy（部署者按示例可发现）',
  EXAMPLE.includes('trustedProxy'));

/* ── 公网前端（v1.18.16：deploy/nginx-public.conf，TLS + 反代采信）── */
const NGINXP = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx-public.conf'), 'utf8');
const NGINXP_LIVE = stripComments(NGINXP);
check('公网 nginx XFF 同样一律覆写为 $remote_addr（追加模式 = 公网客户端伪造统计/借封禁锁人）',
  NGINXP.includes('proxy_set_header X-Forwarded-For $remote_addr;') && !NGINXP_LIVE.includes('$proxy_add_x_forwarded_for'));
check('公网 nginx 只反代宿主回环转发口 127.0.0.1:18787（网关不经此层不可达，ufw 兜底）',
  NGINXP.includes('proxy_pass http://127.0.0.1:18787;'));
check('公网 nginx server_tokens off（Server 头不报版本号——N-01 同款纪律）',
  NGINXP_LIVE.includes('server_tokens off;'));
check('TLS 层三头齐全：HSTS/COOP/CORP（N-03 既定姿势：只在公网 TLS 层加，本机 http 层不加）',
  NGINXP_LIVE.includes('Strict-Transport-Security') && NGINXP_LIVE.includes('Cross-Origin-Opener-Policy') && NGINXP_LIVE.includes('Cross-Origin-Resource-Policy'));
check('公网 TLS 只开 1.2/1.3（出现 SSLv3/TLS1.0/TLS1.1 即失败）',
  NGINXP_LIVE.includes('ssl_protocols TLSv1.2 TLSv1.3;') && !/TLSv1\.?[01]\b|SSLv/.test(NGINXP_LIVE));
check('80 段只留 ACME webroot 与 301 跳转；业务只在 443（强制加密红线）',
  NGINXP.includes('listen 80;') && NGINXP.includes('/.well-known/acme-challenge/') && NGINXP.includes('root /var/www/certbot;') && NGINXP.includes('return 301 https://$host$request_uri;') && NGINXP.includes('listen 443 ssl http2;'));
check("证书走 Let's Encrypt 标准位（live/<域名>/fullchain+privkey，certbot.timer 续期直接覆盖）",
  NGINXP.includes('/etc/letsencrypt/live/') && NGINXP.includes('fullchain.pem;') && NGINXP.includes('privkey.pem;'));
check('公网流式与体量纪律同源（proxy_buffering off / read_timeout ≥3600s / client_max_body_size）',
  NGINXP.includes('proxy_buffering off;') && Number((NGINXP.match(/proxy_read_timeout\s+(\d+)s/) || [])[1]) >= 3600 && /client_max_body_size\s+\d+m/.test(NGINXP));
check('compose 真透传 ZZCSAPI_ALLOWED_HOSTS（v1.18.16 现场教训：注释行透传 → 公网域名一律 421）',
  COMPOSE.includes('ZZCSAPI_ALLOWED_HOSTS: ${ZZCSAPI_ALLOWED_HOSTS:-}'));
check('README 公网部署四件套齐：部署步骤、ZZCSAPI_ALLOWED_HOSTS、公网必须换新密钥、certbot 续期',
  /公网部署/.test(README) && /ZZCSAPI_ALLOWED_HOSTS/.test(README) && /换新密钥/.test(README) && /certbot/.test(README));
check('README 方式四 .env 钥匙名带 ZZCSAPI_ 前缀（v1.18.17 现场教训：裸 ADMIN_KEY= 被 compose 的 ZZCSAPI_ADMIN_KEY 映射漏掉 → 静默回落首启生成，.env 的钥匙两头都不生效）',
  README.includes('ZZCSAPI_ADMIN_KEY=%s') && README.includes('ZZCSAPI_GATEWAY_KEY=%s') &&
  !README.includes('\\nADMIN_KEY=%s') && !README.includes('\\nGATEWAY_KEY=%s'));

/* ── CF 橙云（v1.18.18）：真实来源恢复在 nginx 层、网关侧零改动 ── */
const SRV = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
check('公网层 CF 橙云真实来源：realip 只对 CF 网段采信 CF-Connecting-IP（≥22 条 set_real_ip_from），XFF 覆写纪律一字不动',
  NGINXP_LIVE.includes('real_ip_header CF-Connecting-IP;') && (NGINXP_LIVE.match(/set_real_ip_from/g) || []).length >= 22 && NGINXP_LIVE.includes('proxy_set_header X-Forwarded-For $remote_addr;'));
check('网关侧绝不读 CF-Connecting-IP（真实来源唯一通路 = nginx realip 恢复进 XFF 那一跳，网关只认 XFF 采信链）',
  !SRV.includes('CF-Connecting-IP'));
check('README 方式四橙云姿势写全：Proxied + Full (strict) 防重定向循环、CF-Connecting-IP/源站锁定说明、切回灰云放行提醒、100 秒超时告警',
  /橙云/.test(README) && /Full \(strict\)/.test(README) && /CF-Connecting-IP/.test(README) && /100 秒/.test(README) && /源站锁定/.test(README));

/* ── 容器加固（v1.18.87）：只读根文件系统 + 丢弃全部 capability + no-new-privileges ──
   为什么守：这三项都是"删掉不报错、但保护全没了"的配置。尤其是 read_only ——
   它和 v1.18.86 的"统一数据目录"是**绑定关系**：数据没全进挂载点时开 read_only
   必然 EROFS，所以只能等目录挂载落地后才敢开。守卫要同时钉住"开了"和"前提还在"：
   一旦有人把某个写盘目标挪回 /app（根fs），下面的源码扫描就该红。 */
console.log('\n容器加固（read_only / cap_drop / no-new-privileges + 写盘目标全在挂载点内）');
check('compose 开 read_only: true（根fs 只读——RCE 也改不了 /app、塞不进后门）',
  /(^|\n) {4}read_only:\s*true\b/.test(COMPOSE));
check('compose 挂 tmpfs /tmp（只读根下 Node/libuv 需要一个可写临时目录，否则启动期 ENOENT）',
  /(^|\n) {4}tmpfs:\s*\n\s*-\s*\/tmp\b/.test(COMPOSE));
check('compose cap_drop: ALL（网关只监听 8787，不需要任何 capability；全丢后提权原语失效）',
  /(^|\n) {4}cap_drop:\s*\n\s*-\s*ALL\b/.test(COMPOSE));
check('compose no-new-privileges:true（禁止 setuid/setgid 提权）',
  /no-new-privileges:true/.test(COMPOSE));
check('★ read_only 的前提：两个绑定目录覆盖全部写盘目标（./data:/app/data + ./dump:/app/dump）',
  COMPOSE.includes('./data:/app/data') && COMPOSE.includes('./dump:/app/dump'));
check('★ 写盘目标经 env 指进挂载目录（ZZCSAPI_CONFIG / ZZCSAPI_USAGE / ZZCSAPI_CONFIG_HISTORY_DIR 都在 /app/data 下）',
  COMPOSE.includes('ZZCSAPI_CONFIG: /app/data/config.json') &&
  COMPOSE.includes('ZZCSAPI_USAGE: /app/data/usage.json') &&
  COMPOSE.includes('ZZCSAPI_CONFIG_HISTORY_DIR: /app/data/config-history'));
// 源码扫描：不允许任何 fs 写盘调用把目标直接写在 __dirname 下（= 容器里的只读 /app）。
// 这是"本机 node server.js 一切正常、容器里运行期 EROFS"那类现象的唯一结构性拦法。
check('★ 源码里没有 fs 写盘调用直接写 __dirname（否则只读根下运行期 EROFS，而本机无感）',
  !/fs\.(writeFileSync|mkdirSync|copyFileSync|appendFileSync|createWriteStream)\(\s*path\.join\(__dirname/.test(SRV) &&
  !/fs\.(writeFileSync|mkdirSync|copyFileSync|appendFileSync)\(\s*__dirname/.test(SRV));
// 四个写盘常量必须从 CONFIG_PATH / env 派生——容器里改 env 就能把它们整体搬进挂载目录。
check('★ 四个写盘常量全部从 CONFIG_PATH / env 派生（CONFIG_PATH / CONFIG_HISTORY_DIR / USAGE_PATH / DUMP_DIR）',
  /const CONFIG_PATH = process\.env\.ZZCSAPI_CONFIG \|\| path\.join\(__dirname, 'config\.json'\)/.test(SRV) &&
  /const CONFIG_HISTORY_DIR = process\.env\.ZZCSAPI_CONFIG_HISTORY_DIR \|\| path\.join\(path\.dirname\(CONFIG_PATH\), 'config-history'\)/.test(SRV) &&
  /const USAGE_PATH = process\.env\.ZZCSAPI_USAGE \|\| path\.join\(path\.dirname\(CONFIG_PATH\), 'usage\.json'\)/.test(SRV) &&
  /const DUMP_DIR = process\.env\.ZZCSAPI_DUMP_BODIES \|\| ''/.test(SRV));

/* ── opencode 专职边车（v1.18.89）：deploy/opencode-sidecar.ps1 ──
   为什么守：这条边车是"蹭别人的"换成"自己起"的产物，而它三个关键决定都属于
   "删掉照样能跑、但坑会回来"的类型——端口一漂就是 87 次 AggregateError（每 5 分钟一次，0 成功），
   口令一上命令行就进 shell 历史，cwd 一回到仓库就把整个项目的源码塞给免费层（实测 input 50627 vs 8136）。 */
console.log('\nopencode 专职边车（deploy/opencode-sidecar.ps1 + 默认端口一致性）');
const SIDECAR = fs.readFileSync(path.join(ROOT, 'deploy', 'opencode-sidecar.ps1'), 'utf8');
// 口令相关判定要在**去掉注释**之后做：脚本头刻意写着"`serve` 没有 --password 这个参数"，
// 直接扫全文会把这句说明本身判成违规（第一版就是这么假红的）。
const SIDECAR_CODE = SIDECAR.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
check('★ 边车脚本纯 ASCII（与自启脚本同一条：PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1，中文注释当场语法错）',
  !/[^\x00-\x7F]/.test(SIDECAR));
check('端口写死 4666 且幂等（已在监听就 exit 0，重启安全）',
  /\$Port\s*=\s*4666/.test(SIDECAR) && SIDECAR.includes('Get-NetTCPConnection -LocalPort') && SIDECAR.includes('exit 0'));
check('口令只从 .env 读、不进命令行（serve 没有 --password；不设它边车会自造一个并打进 stdout＝泄露面）',
  SIDECAR_CODE.includes('OPENCODE_SIDECAR_PASSWORD') && SIDECAR_CODE.includes('$env:OPENCODE_SERVER_PASSWORD = $pw') &&
  !/--password/.test(SIDECAR_CODE) && !/-ArgumentList[^\n]*\$pw/.test(SIDECAR_CODE));
check('★ 工作目录是专用空目录、绝不是仓库（边车把 cwd 当项目根，会把源码塞进每一发请求）',
  SIDECAR.includes("-WorkingDirectory $WorkDir") && /\$WorkDir\s*=\s*Join-Path \$LogDir 'work'/.test(SIDECAR) &&
  !/-WorkingDirectory\s+(\.|\$PWD|\.\.)/.test(SIDECAR));
check('起完自检 GET /api/model 必须 2xx，否则非零退出（"起了"≠"能用"）',
  SIDECAR.includes('/api/model') && /throw|exit 1/.test(SIDECAR));
check('★ 文档接线：README 与 docs/protocols.md 都写了这个脚本（换端口/换口令时人找得到真源）',
  README.includes('deploy/opencode-sidecar.ps1') &&
  /deploy[\\/]opencode-sidecar\.ps1/.test(fs.readFileSync(path.join(ROOT, 'docs', 'protocols.md'), 'utf8')));
check('★ opencode.js 的默认端口与脚本一致（4666）——两处漂移就是下一个"连不上边车"',
  /const DEFAULT_BASE = 'http:\/\/host\.docker\.internal:4666';/.test(fs.readFileSync(path.join(ROOT, 'opencode.js'), 'utf8')));
check('★ opencode.js 硬拒 HTML 响应（SPA 兜底页是 200，只认 data.text 会把它当模型回答）',
  /function isHtmlBody\(/.test(fs.readFileSync(path.join(ROOT, 'opencode.js'), 'utf8')) &&
  /if \(isHtmlBody\(gen\.text\)\)/.test(fs.readFileSync(path.join(ROOT, 'opencode.js'), 'utf8')));

console.log('──────────────────────────────────────────────────────');
if (fails) { console.log('✗ 失败 ' + fails + ' / ' + n + ' 项'); process.exit(1); }
console.log('✓ 全部通过（' + n + ' 项断言）');
