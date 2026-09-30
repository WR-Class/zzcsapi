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
   ACME+301、LE 标准证书路径、README 公网四件套。 */
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
check('README 公网部署四件套齐：部署步骤、ZZCSAPI_ALLOWED_HOSTS、公网必须换新密钥、certbot 续期',
  /公网部署/.test(README) && /ZZCSAPI_ALLOWED_HOSTS/.test(README) && /换新密钥/.test(README) && /certbot/.test(README));

console.log('──────────────────────────────────────────────────────');
if (fails) { console.log('✗ 失败 ' + fails + ' / ' + n + ' 项'); process.exit(1); }
console.log('✓ 全部通过（' + n + ' 项断言）');
