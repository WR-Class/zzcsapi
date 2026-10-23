# ZZCSAPI — 本地多渠道 AI 聚合网关

类似 new-api / sub2-api / one-api 的轻量自部署版，**零依赖，仅 Node 18+**。
把所有中转 API key 集中在一处，对外同时暴露 **OpenAI / Anthropic / Gemini** 三种兼容端点。

> 细节都在 `docs/`：本文只留速查与上手，每节末尾的链接点进去看全量。

## 特性

- 🚦 **多协议、多渠道自动调度**：同一模型在多个渠道之间按 priority + 健康状态排序调用
- 🔁 **失败自动切换**：只要还有能上场的候选，5xx / 超时 / 网络错误，以及上游 4xx（含"渠道声明了早已下架的模型"这类 404）都立刻试下一个渠道；客户端的 400 只在没有候选可切时原样透传
- 🛡 **熔断冷却（分级退避）**：连续失败的渠道按**错误类型**分别退避（瞬时 5s 起 / 凭证额度 5 分钟起 / 限流 1 分钟起，各自封顶），冷却中的排到候选链末尾，连续失败 3 次标记 `down`；健康探测只做"半愈合"，要一次真实对话成功才彻底恢复（[调度详解](docs/scheduling.md)）
- 🔍 **后台健康探测**：定时 GET 渠道的 models 端点，聚合 latency / 状态 / 真实模型清单
- 🌊 **流式透传**：SSE 全程转发；上游响应是 OpenAI 协议时自动转成 Anthropic/Gemini 流；**同协议直通则原始字节直转**（CRLF/分帧都不动，v1.16）
- ⚡ **自带出站客户端（零依赖）**：Node 内置 `http/https` + keep-alive 连接池——实测把网关净增延迟从 +13.9ms 压到 **+0.93ms**（[行为细节 · 出站与流式写路径](docs/behavior.md)）
- 🧷 **会话粘性（v1.17，默认关）**：同一条会话固定走同一个上游渠道，让上游提示缓存 / KV cache 能复用；只改"谁是第一位"，不硬塞冷却中的渠道，也不污染加权份额统计
- 🚧 **客户端限流（v1.17，默认关）**：整机 rpm + 并发上限，超限回 `429` + `Retry-After`，在鉴权之前就挡住
- 📈 **`/metrics` 指标端点（v1.17）**：Prometheus 文本格式、零依赖，渠道/令牌/耗时/熔断分档/粘性/限流一屏看完
- 🧠 **thinking 回放（v1.18.8，默认关）**：同协议直通上把上游自己签的 `signature` 补回给弄丢它的开源客户端——四元键绝不跨会话/渠道/模型，没坏不碰（[设计记录](docs/thinking-replay-design.md)）
- 🔐 **双层鉴权**：`GATEWAY_KEY`（客户端）+ `ADMIN_KEY`（控制台与管理 API）；未设置则**首启自动生成**随机密钥（日志可查、写入 config.json）
- 🖥 **Web 控制台**：浏览器打开 `http://127.0.0.1:8787/console` 看渠道状态、改优先级、启停渠道
- 🕘 **配置历史与一键回滚（v1.18.83 后端 / v1.18.84 控制台入口）**：每次改写 `config.json` 前自动存一代（环形 20 代、hash 去重）；控制台「工具 → 配置历史」可看**「那一代 → 现在」的字段级差异**（直接点名少了哪个字段）并**两步确认**回滚——热生效渠道/设置/封禁表，密钥段不动，回滚本身也能再回滚（[机制详解](docs/config-history.md)）
- 🔤 **字体自托管（v1.18.37）**：全站用**寒蝉全圆体**（ChillRoundF，SIL OFL 1.1）的子集化**改名**版 `HCRound`，266 个 woff2 分片按 `unicode-range` 从**同源** `/console/fonts/**` 按需加载——不向任何第三方域名发请求（[字体与授权记录](docs/fonts.md)）
- 📊 **统一模型清单**：`/v1/models`、`/anthropic/v1/models` 自动合并各协议所有可用模型
- 🧩 **OpenAI Responses API（v1.18.38）**：`/v1/responses`（POST，含流式）+ `/v1/responses/{id}`（GET 取回 / DELETE）——入站按 Responses 报文收，出站转回 `response` 对象与 Responses 的 SSE 事件序列，中间复用同一条候选链与全部兜底（[协议详解](docs/protocols.md)）
- 🩺 **手动测试的流式模式 + 真实流量单独一条欠账（v1.18.40）**：控制台「测试模型」默认按**流式**打（真实客户端走的就是流式，只测非流式等于只测了一半，`stream:true` 可选）；且**只有真实客户端请求成功才算"这家对话能用"**——手动测试与 `/models` 探测成功只放开冷却、还清探测侧的账，**不再清零真实流量的连败计数**，熔断因此真的会跳开"测试过、真实挂"的死家（[调度详解](docs/scheduling.md)）
- 📎 **notion 渠道的内联附件（v1.18.41，渠道级 `notionAttachments`，默认关）**：客户端发 OpenAI `{type:"file",file:{filename,file_data:"data:…;base64,…"}}`（或 Anthropic `document` 块）时，网关把文件**内联进提示词**并打开 `enableCsvAttachmentSupport`——这是参照实现 notion2api 实发报文的形状，**CSV 不上 S3、不建任务**（[机制与诚实边界](docs/notion-attachment-upload-research.md)）。✅ **「模型真读到了」已活体验证（v1.18.42）**：对照那一发模型答"没找到你上传的 CSV"，带附件那一发答出**只存在于 CSV 里**的串，并经本地容器网关 `/v1/chat/completions` 复验（见研究文档 §8）
- 🪪 **渠道级「自定义请求头」（v1.18.44）**：有些上游不只看密钥、还**看客户端指纹**——`agentrouter` 实测只带 `Authorization` 一律 **401 `unauthorized client detected`**，带上 `User-Agent: claude-cli/2.0.0 (external, cli)` 才 **200**（**浏览器 UA 一样被拒**：它认的是 Claude CLI 指纹本身）。现在渠道编辑弹窗的「自定义请求头」可填（每行一条 `Name: value`，`Authorization` 不可覆盖），探测/测试/聊天都带上它。**这轮的真凶其实是我们自己**：那个输入框此前**从不回填**，于是「获取模型」发出去的探测不带该 UA、必吃 401；而保存渠道还会**静默删掉**已配的值（[协议详解](docs/protocols.md)）
- 🚦 **notion 出站通道链（v1.18.42，根因于 v1.18.43 修正为两个维度）**：Notion 推理接口会回一道软墙（HTTP 200 + `temporarily-unavailable`，反爬式静默拒绝）。**软墙有两个独立维度**：① **账号状态**（主导，与传输无关、随时间变——`notion7` 在本地与云端、五种传输一起软墙，且在云端曾有短暂开口）；② **客户端指纹**（只在账号可过时才看得见——同一秒交替打：curl 3/3 真答、fetch 0/3 软墙）。出站因此做成 **curl 主 → HTTP/2 兜底 → fetch 最后**，且**软墙会在通道内自动换**（墙内那一发不消耗真实推理）；**这一修法治 ②，治不了 ①**（那时网关如实报 `ok:false / notion: temporarily-unavailable`，不伪装成"200 空回复"）。这是 ③ 的活体判据之所以能取得的前提（[协议详解](docs/protocols.md) §notion 出站通道链 · 复现仪器 `notion-wall-probe.js`）

## 快速开始

### 方式一：Docker（推荐）

> **v1.18.86 起：配置 / 用量 / 代际快照统一放在宿主机 `./data` 目录挂载**（此前是三个单文件/目录挂载混着）。
> 全新部署只需要建一个空目录，**不用手动拷贝 `config.json` / `usage.json`**——`./data` 为空时网关会自动从镜像自带的
> `config.example.json` 生成一份（含 5 条示例渠道，去控制台改成自己的），`usage.json` 首次写入时自动创建。

```powershell
mkdir data
docker compose up -d --build
# 控制台 http://127.0.0.1:8787/console
# 首次启动的 ADMIN_KEY / GATEWAY_KEY 打印在容器日志里：docker logs zzcsapi | grep ADMIN_KEY
# 想固定自己的密钥：根目录建 .env 写 ZZCSAPI_ADMIN_KEY=... / ZZCSAPI_GATEWAY_KEY=...
```

> 🛡️ **容器加固（v1.18.87）**：compose 已开 `read_only: true`（只读根文件系统）+ `cap_drop: ALL` + `no-new-privileges:true` + `/tmp` tmpfs。
> 含义：**即使网关被拿下（RCE），攻击者也没法在镜像里落东西**（改不了 `/app/console.html`、塞不进后门脚本），
> 唯一可写处是 `./data`、`./dump` 两个宿主机可见目录和内存盘 `/tmp`。实测：容器内 `touch /app/x` → `Read-only file system`，
> `CapEff` 全 0、`NoNewPrivs: 1`，而 `usage.json` 与 `config.json.bak` / 代际快照照常写入。
> ⚠️ **代价（改代码前必读）**：以后任何"要写磁盘"的新功能，目标**必须**落在 `CONFIG_PATH` / `CONFIG_HISTORY_DIR` /
> `USAGE_PATH` / `DUMP_DIR` 这四个派生路径下（容器里即 `/app/data` 与 `/app/dump`）或走 `os.tmpdir()`；写别处会**运行期 `EROFS`**，
> 而本机 `node server.js` 一切正常——这是"本机好好的、容器里报错"里最难查的一类。详见 [docs/security-hardening.md](docs/security-hardening.md) §容器加固。
> ⚠️ **改完代码要确认容器真的换了镜像**（v1.18.1 现场踩到过）：`up -d --build` 有时只构建不重建（输出是 `Running` 而不是 `Recreated`），刷新看到的还是旧代码。
> 判断：`docker inspect zzcsapi --format '{{.Image}}'` 与 `docker images zzcsapi:local --format '{{.ID}}'` 不一致就补 `docker compose up -d --force-recreate`。`/console` 带 `no-store`，不需要强刷浏览器。
> ⚠️ **别再问"config.json 要不要先在宿主机存在"**（v1.18.86 之前的老顾虑，现在反过来）：数据目录挂载下宿主机为空才是**正确**的首启状态。反过来，**千万别把 `config.json` 当单文件挂**（`./config.json:/app/config.json`）——容器里那个路径是挂载点本身、与 `/app` 跨 device，原子写的 `rename()` 必然 `EXDEV`/`EBUSY`（v1.18.85 现场：点一次保存 → 网关 `Exited(1)`）。
> ⚠️ **`Dockerfile` 的 `COPY` 是显式白名单**（v1.18.48 现场踩到过）：新增任何被 `server.js` `require` 的文件（如 v1.18.47 的 `hark.js`）都必须同时加一条 `COPY`，漏了**本机 `node server.js` 一切正常**，但容器会**启动即 crash-loop**（`Cannot find module '/app/xxx.js'`、healthz 连不上，症状离原因很远）。`node test/docker-image-files.test.js` 守这条；改完照旧要 `docker compose build && up -d` 并确认 `docker ps` 里是 `Up (healthy)`。
> 端口映射 `8787:8787`（局域网可访问）；手工 `docker run` 别忘 `ZZCSAPI_BIND=0.0.0.0`、`TZ=Asia/Shanghai`、`-v "$PWD/data:/app/data" -e ZZCSAPI_CONFIG=/app/data/config.json`（compose 已写死，不会踩到）。
> 想让来源统计看到**每台机器的真实 IP**（而不是一行网桥 IP）走 [方式三](#方式三反代采信模式想让来源统计看到每台机器真实-ip)。

### 方式三：反代采信模式（想让来源统计看到每台机器真实 IP）

**问题**：Docker Desktop 的端口发布是 NAT——打进 `8787` 的连接（宿主机自己 + 局域网其他机器）进容器后源地址都变成网桥网关那**一个** IP，来源统计永远只有一行（v1.18.11 的 per-IP 态势等于废掉一半）。

**处置**：宿主机 nginx 是连接的真正终点，看得到真实客户端 IP；把它写进 `X-Forwarded-For`，网关只在"这条连接来自受信反代"时才采信（`config.security.trustedProxy`）。

```
局域网客户端 ──► 宿主机 nginx :8787 ──► 127.0.0.1:18787 ──► 网关容器 :8787
              （看到真实来源 IP、覆写 XFF）  （只绑回环，局域网绕不过）  （trustedProxy 采信 XFF）
```

```powershell
# 1) 网关改成只绑宿主回环的转发口：根目录 .env 加一行（.env 不入仓库）
#    ZZCSAPI_PUBLISH=127.0.0.1:18787:8787
docker compose up -d

# 2) config.json 的 security.trustedProxy 填【本项目固定子网的网桥网关】（compose 已固定 172.28.137.0/24）
#    "security": { "trustedProxy": "172.28.137.1" }
docker compose restart zzcsapi

# 3) 宿主机跑 nginx（for Windows 便携版解压到 D:\DSHXM\nginx-rt，路径可换；它不是 Windows 服务）
D:\DSHXM\nginx-rt\nginx.exe -p D:\DSHXM\nginx-rt\ -c D:\DSHXM\ZZCSAPI\deploy\nginx-reverse-proxy.conf
# 改配置后生效 / 停止：把启动参数换成 -s reload / -s stop
```

客户端地址**不用改**（仍是 `http://<局域网IP>:8787`）；统计页会显示「反代采信：172.28.137.1」，每台机器各占一行。

- **trustedProxy 填网桥网关（172.28.137.1），不是宿主机的局域网 IP**——网关眼里"nginx 转进来的连接"源地址就是这个。compose 用 `${ZZCSAPI_SUBNET:-172.28.137.0/24}` 固定子网就是为了让它恒定：不固定则每次建网换网段，采信静默失效（统计又退回一行）。
- **nginx 不是 Windows 服务**：重启电脑后不会自己起来，8787 没人监听 = 所有客户端连不上。用 `deploy/start-reverse-proxy.ps1`（幂等启动）登记开机自启，撤销就是删掉那条启动项——命令见脚本头部注释。
- **别把 nginx 放进容器**：容器里看到的源地址同样会被 Docker NAT 折叠成网桥 IP，等于白搭。
- **四条纪律**（XFF **覆写**为 `$remote_addr` 而非追加、转发口只绑回环、`proxy_buffering off` 否则 SSE 卡死、`server_tokens off` 不给扫描器报版本号）写在 [deploy/nginx-reverse-proxy.conf](deploy/nginx-reverse-proxy.conf) 头部，由 `test/reverse-proxy-config.test.js` 守着，改坏当场报错。改响应头记得 **nginx 与网关两层一起看**（外部复测的特别提示：别改了网关却被 nginx 盖住，或反之）。
- **回到默认直连模式**：`.env` 里删掉 `ZZCSAPI_PUBLISH`（或改回 `8787:8787`）→ `docker compose up -d`，并清空 `security.trustedProxy`。

### 方式四：公网部署（域名 + TLS + 反代采信）

方式三的同一套架构，把前端换成公网 TLS 层：[deploy/nginx-public.conf](deploy/nginx-public.conf)（跑在服务器宿主机 nginx 上——Let's Encrypt 证书、80 段只留 ACME 验证与 301 跳转、业务全走 443、HSTS/COOP/CORP 三头）。

```bash
# 1) 服务器准备：Docker + nginx + certbot；防火墙只放 SSH/80/443（默认全拒）
curl -fsSL https://get.docker.com | sh && apt-get install -y nginx certbot
ufw allow <你的SSH端口>/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# 2) 域名 A 记录指向服务器公网 IP，然后把仓库克隆到服务器
git clone -b master https://github.com/WR-Class/zzcsapi.git /opt/zzcsapi && cd /opt/zzcsapi   # -b master：仓库默认分支 main 停在旧版

# 3) 写 .env（三件事：只绑回环转发口、**公网必须换新密钥**、域名登记进 Host 门）
#    示例密钥是公开的（就躺在本仓库里），公网照抄 = 裸奔
A=$(openssl rand -hex 12)Aa1-; G=$(openssl rand -hex 16)g9
printf 'ZZCSAPI_PUBLISH=127.0.0.1:18787:8787\nZZCSAPI_ALLOWED_HOSTS=你的域名\nZZCSAPI_ADMIN_KEY=%s\nZZCSAPI_GATEWAY_KEY=%s\n' "$A" "$G" > .env
chmod 600 .env
#    钥匙名必须带 ZZCSAPI_ 前缀——compose 的映射读的是 .env 里的 ZZCSAPI_ADMIN_KEY / ZZCSAPI_GATEWAY_KEY；
#    写成裸 ADMIN_KEY= 会静默失效：容器回落首启生成，.env 里的钥匙两头都不生效（v1.18.17 公网现场教训）

# 4) 只需要准备 config.json（本地挑好再传上去，此文件不入仓库）——data/ 里**不要**预先塞 usage.json：
#    网关首次写入时自己创建，缺文件/内容坏掉都会自动补成空账本（ensureUsage()），预置反而是多一步
mkdir -p data && docker compose up -d --build
curl -s http://127.0.0.1:18787/healthz   # {"ok":true}——此刻只有服务器本机摸得到它

# 5) 签证书：nginx-public.conf 的 443 段引用的证书还没存在，nginx 起不来——
#    先用 80-only 引导配置把 ACME 跑通
mkdir -p /var/www/certbot
cat > /etc/nginx/nginx.conf <<'EOF'
events { worker_connections 256; }
http { server { listen 80; server_name 你的域名;
  location /.well-known/acme-challenge/ { root /var/www/certbot; }
  location / { return 301 https://$host$request_uri; } } }
EOF
nginx -t && systemctl start nginx
certbot certonly --webroot -w /var/www/certbot -d 你的域名 --register-unsafely-without-email -n --agree-tos

# 6) 证书到手，换上真正的公网前端（TLS 三头在这层生效；certbot.timer 自动续期）
cp deploy/nginx-public.conf /etc/nginx/nginx.conf && nginx -t && systemctl reload nginx && systemctl enable nginx
```

- **回退**：`docker compose down` + `systemctl stop nginx`；证书重签删 `/etc/letsencrypt/live/你的域名` 等目录即可。
- **公网后每一条小改动都要两层一起想**（nginx 前端 + 网关），改响应头尤其如此。
- 域名托管在 **Cloudflare** 时两种姿势都行：
  - **灰云（DNS only）**：最简单——访客直连源站，来源统计天然真实，TLS 由本层证书终结；
  - **橙云（Proxied）**：套 CF 的 DDoS 防护、藏源站 IP。仓库姿势（v1.18.18 起 `deploy/nginx-public.conf` 已内置）：nginx realip 白名单采信 **CF 网段**回源带的 `CF-Connecting-IP`（真实访客 IP），直连源站的伪造头一律无视——`$remote_addr` 恢复成真实访客，XFF 覆写纪律与网关侧采信链零改动，per-IP 统计/封禁照常工作。CF 控制台 **SSL/TLS 必须设 Full (strict)**（Flexible 会走 80 回源、撞上 301 跳转 = 访客无限重定向循环）。建议**源站锁定**：ufw 只放 CF 网段进 80/443（`for n in $(curl -s https://www.cloudflare.com/ips-v4); do ufw allow proto tcp from $n to any port 80,443; done`，v6 同理）——不然知道源站 IP 的人可绕过 CF 直连（Host 门只认域名，分不出谁走了 CF）。**切回灰云前必须先放开**：`ufw allow 80/tcp && ufw allow 443/tcp`（否则全站不可达；灰云期间 certbot 续期也依赖 80 直达）。两个代价要有数：CF 免费版 **100 秒无字节超时**——慢思考的 SSE 长回复两次事件间隔超 100 秒会被掐（nginx 侧 3600s 的耐心只对直连有效）；CF 网段表变动时要同步 conf 里的 `set_real_ip_from`（不然新网段的访客 IP 会显示成 CF 边缘 IP）。
- 客户端地址换成 `https://你的域名`；控制台在 `https://你的域名/console`。来源统计照常生效（XFF 覆写纪律同源，`security.trustedProxy` 填网桥网关 `172.28.137.1`，同方式三）。

### 方式二：裸 Node（18+）

```bash
node server.js          # 1) 首次运行自动从 config.example.json 生成 config.json
# 2) 编辑 config.json 填入真实渠道，再重启
```

> **要用 `opencode` 渠道？先起它自己的专职边车**（v1.18.89）：
> `powershell -NoProfile -ExecutionPolicy Bypass -File deploy/opencode-sidecar.ps1`（`-Stop` 停）。
> 固定端口 **4666**、口令取 `.env` 的 `OPENCODE_SIDECAR_PASSWORD`、**工作目录设成空目录**（边车把 cwd 当项目根，
> 从仓库起会把整个项目塞进每一发请求）；脚本幂等、可挂到 HKCU `Run` 自启（`zzcsapi-opencode`）。
> 别再指向别的应用（如 omnirush desktop）拉起的边车——它一重启**端口和口令两个都漂**，
> 实测网关按 5 分钟一次敲了 **87 次全失败、0 次成功**。细节见
> [docs/protocols.md](docs/protocols.md) 的 opencode 一节与[研究文档 §5.6](docs/opencode-reverse-proxy-research.md)。

可选环境变量：

```bash
GATEWAY_KEY=xxx  node server.js    # 客户端必须带 Bearer xxx
ADMIN_KEY=yyy    node server.js    # 控制台 + /admin/* 必须带 Bearer yyy
ZZCSAPI_NOAUTH=1 node server.js    # 本地开发：完全关闭鉴权（仅限本机自用）
ZZCSAPI_BIND=0.0.0.0 node server.js  # 绑定地址，缺省 127.0.0.1（裸跑时对外提供服务的必填项）
ZZCSAPI_ALLOWED_HOSTS=a.com,b.com node server.js  # Host 门白名单域名（逗号分隔）。默认放行 localhost 与回环/私网 IP 字面量；反代/公网域名必须在此登记，否则 421（v1.18.10 渗透整改 V-07：拦 DNS 重绑定）
ZZCSAPI_CONFIG=data/config.json node server.js    # 配置放哪（默认 ./config.json）。指向 ./data 就与容器共用同一份；
                                                  # usage.json 与 config-history/ 会自动跟到同一目录（同 device ⇒ 原子写生效）
ZZCSAPI_DUMP_BODIES=/app/dump node server.js  # 【排查用，默认关】把客户端会话类请求体原样落盘到该目录，用于留证"上游异常"的真实请求形态（v1.18.27）
ZZCSAPI_DUMP_MAX=30 node server.js            # 落盘最多保留几个（默认 30，钳到 1–500）
ZZCSAPI_CONTEXT_DIET=1 node server.js         # 【默认关】上下文节食：摘掉几十轮前的旧截图（v1.18.61）
ZZCSAPI_DIET_KEEP_MSGS=30 node server.js      # 节食窗口：只保留最近 K 条消息里出现的图（默认 30）
ZZCSAPI_DIET_KEEP_IMAGES=5 node server.js     # 节食上限：最多保留最近 N 张图（默认 5）。显式写 0 = 全部摘掉
ZZCSAPI_FIRST_BYTE_SCALING=0 node server.js   # 【默认开】写成 0 即关掉"首字死线随体积缩放"，退回写死的 30s/60s
ZZCSAPI_CONFIG_HISTORY_DIR=/app/config-history node server.js  # 配置代际快照目录（默认 config.json 同级的 config-history/，v1.18.83）
ZZCSAPI_CONFIG_HISTORY_MAX=20 node server.js   # 环上保留几代配置（默认 20，钳到 1–100）。见[配置代际与回滚](docs/config-history.md)
ZZCSAPI_FIRST_BYTE_PER_KB=40 node server.js   # 缩放斜率：报文体每 1KB 多加多少毫秒（默认 40）
ZZCSAPI_FIRST_BYTE_MAX_MS=90000 node server.js # 缩放上限（默认 90000 = 90s，钳到 600000）
```

**上下文节食（v1.18.61，默认关闭）**：设 `ZZCSAPI_CONTEXT_DIET` 后，**几十轮之前的旧截图**不再随每一轮请求重发，改成一行占位符。
动机来自对真实落盘报文的实测（不是估算）：一份 **4.52MB** 的请求里 **8 张图占 3.96MB（85%）**，其中 **7 张距今 88~189 条消息**——它们早就被分析完、结论写在后面的 assistant 消息里，字节却每轮原样重发。**每张旧截图会让之后每一轮的请求体永久 +500KB。** 摘掉之后：4.52MB → 约 0.62MB。
规则：**两条同时满足才保留** —— 在最近 `ZZCSAPI_DIET_KEEP_MSGS` 条消息内，**且**在最近 `ZZCSAPI_DIET_KEEP_IMAGES` 张之内；其余换成 `[图片已省略：…如需我重新查看该图，请重新发送。]`。
纪律：**默认不设 = 零行为变化**（字节级原样透传）；**只摘图**，文本 / 工具结果 / 工具调用参数一律不碰；任何异常都吞掉并原样发送（节食绝不搞坏请求）；每条受影响的请求打一行 `[diet]` 日志（摘了几张、省了多少字节）便于事后核账。
**有意为之的连带效应**：摘完若请求里已无图，含图渠道裁剪不再生效，**候选链会变宽**——这是正确的，我们真的不再发图了。
覆盖四套客户端入口：`/v1/chat/completions`、`/v1/responses`、`/anthropic/v1/messages`、Gemini `:generateContent`（openai 形 `image_url` / anthropic 形 `image` 块 / gemini 形 `inlineData`；gemini 的 `fileData` 是外链引用，不动）。回归：`test/context-diet.test.js`。
配套工具：`node payload-report.js [dump目录]` 只读分析请求体构成（尺寸 / 类型 / 内容块去重 / 被取代的旧工具流量），**只打印尺寸与哈希，不打印对话内容**。

**首字死线随请求体积缩放（v1.18.61，默认开启）**：等"第一个字节"的时长不再写死 30s/60s，而是 `基础值 + 报文体KB × 40ms`，钳在 **90s** 以内（v1.18.62 上限由 120s 降为 90s，`ZZCSAPI_FIRST_BYTE_PER_KB` / `ZZCSAPI_FIRST_BYTE_MAX_MS` 可调，`ZZCSAPI_FIRST_BYTE_SCALING=0` 可关）。**上限必须小于客户端单次超时**——否则那一家永远得不到一次完整的尝试（客户端在它跑完之前就走了）。
动机是实测：同一渠道 hebox1 单变量实验 —— **0KB → 4.8s、39KB → 7.2s、391KB → >30s（撞死线）**；而真实流量常带 0.5~1MB 的体（上下文 + 工具目录 + 历史），于是"慢但答得出"的家一律被误判成挂死，用户看到的是"一直在换家、最后报错"。
**决定性对照**：上下文节食把报文体从 **4.5MB 砍到 0.85MB（降 82%）**，**失败率却纹丝不动（67% → 65%）** —— 因为 0.85MB 仍然大于那个已经撞线的 391KB。**光减体积不够，死线也得跟着体积走。**
纪律：① **只放大首字死线，不放大流内空闲死线** —— 后者等的是"已经开始出字却卡住"，上游真挂了与提示多大无关，跟着放大只会让卡死的流多挂几分钟（v1.18.30 曾把两者统一成同一个值，此处刻意拆开）；② 渠道级 `firstChunkTimeoutMs` 仍然最高优先，**显式配置压过推导值**，配了的家不参与缩放；③ 关掉即退回旧的写死值。回归：`test/channel-timeout-attribution-e2e.test.js`。

**让重试真正前进（v1.18.62）**：把**三层时钟**摆在一起看才发现问题——客户端**单次尝试** 120s、用户**整轮**（1 次 + 最多 5 次重试）约 720s，而网关**一条候选链没有任何总时长上限**（最多 13 家 × 每渠道死线）。而首字超时的冷却只有 **5 秒**，重试间隔却是 **120 秒起步**：冷却早过期，**每次重试都从第 1 家重新开始，5 次重试全砸在同一家上**；同时最多 **6 条链**并跑，排在前面的坏家被反复吸住，排在后面的好家要 8×65s ≈ 520s 才轮到。四件事：
① **客户端断开 → 立刻停链**（`res.on('close')` 置标志，每次尝试前先查）——「没人等的工」不再做；
② **候选游标**：同一会话 + **逐字节相同**的报文（= 客户端自动重试）从上次停下的**下一家**继续；报文一变（用户新一轮）**归零**，绝不把上一轮的失败算到这一轮头上。**只前移、不除名**（越过的家仍在链里，回绕后照样被试到），过期（`ZZCSAPI_CHAIN_CURSOR_TTL_MS`，默认 15 分钟）也归零。**游标存的是渠道 id 而非序号**——候选表每一发都被加权轮询重排，序号会指向别的家；
③ 每渠道死线上限 120s → **90s**；
④ **失败行记真实的入参规模与耗时**——此前写死 `inputTokens: 0, latencyMs: 0`，账本里失败行永远是 `in=0 out=0`，"那发到底多大、等了多久"完全看不见（多次误判的根因）。用 `AsyncLocalStorage` 做请求作用域（**不能用模块级变量**：await 会让并发请求互相覆盖，把 A 的耗时记到 B 的失败行上）。回归：`test/retry-chain-progress.test.js`。

**请求体落盘诊断（v1.18.27，默认关闭）**：设 `ZZCSAPI_DUMP_BODIES` 后，客户端会话类请求（`/v1/chat/completions`、`/anthropic/v1/messages`、Gemini `:generateContent`）的**请求体原文**会落到该目录（compose 场景已挂 `./dump:/app/dump`，仓库 `.gitignore` 已忽略 `dump/`）。
用途：当上游出现「200 + `finish_reason=length` + 输出仅 1 个 token」「200 + 空流」这类**伪装成成功**的失败时，客户端侧只有 token 计数、没有请求形态（系统提示 / 工具目录 / 工具调用历史），无法复现——这个开关就是为留证而设。
纪律：只落**客户端会话类**请求，`/admin/*` 一律不落（那里有密钥）；URL 里的 `?key=` 会打码；最多保留 `ZZCSAPI_DUMP_MAX` 个；**默认不设该变量 = 零落盘零副作用**。⚠ dump 文件含**完整对话内容**，只在本机排查时开，公网部署不要长期开启。

**密钥从哪来（分享/分发友好）**：

1. **显式设置** `ADMIN_KEY` / `GATEWAY_KEY` 环境变量 → 以你设置的为准（compose 场景写进 `.env`）；
2. **没设置** → 首次启动自动生成 48 位随机密钥，**打印到容器日志**并写回 `config.json`（重启不变）；
3. **想换** → 环境变量优先级最高；或控制台「密钥管理」在线轮换（[行为细节](docs/behavior.md)）。

只有显式开启 `ZZCSAPI_NOAUTH=1` 才完全不鉴权——否则密钥恒存在，不再有"空密钥 = 谁都能进"的洞。

## 在 DSH / Cursor / Cline 等客户端里配置

### OpenAI 协议
```
baseURL = http://127.0.0.1:8787/v1
apiKey  = <GATEWAY_KEY 的值；未显式设置时看容器日志里首启生成的那一串>
model   = <channels[*].models 里 alias，左边的键>
```

### OpenAI Responses 协议（v1.18.38）
```
baseURL = http://127.0.0.1:8787/v1     # 用 /v1/responses 的客户端 SDK
apiKey  = <GATEWAY_KEY>
model   = <alias>
```
> 客户端发 `input` / `instructions` / `max_output_tokens` / 扁平工具，网关转成 chat 报文走上游再把响应转回
> `response` 对象（流式则是 Responses 的事件序列）；`previous_response_id` **不做服务端续接**（多轮请把历史放进 `input`），
> 内置工具（`web_search` 等）我们没有 chat 对应物、会被丢掉。

### Anthropic 协议（DSH 的 Anthropic 兼容地址）
```
baseURL = http://127.0.0.1:8787/anthropic
apiKey  = <GATEWAY_KEY>
model   = <alias>
```

> 鉴权三种写法都认：`Authorization: Bearer`、`x-api-key:`（**Anthropic SDK 的默认头**）、`?key=`。

### Gemini 协议
```
baseURL = http://127.0.0.1:8787/gemini/v1beta
apiKey  = <GATEWAY_KEY>
```

> **鉴权**：`x-goog-api-key:`（**Gemini SDK 的默认头**）、`?key=`、`Authorization: Bearer` 都行。
> **支持图片**：`inlineData`（base64）与 `fileData`（`fileUri` 直链）都会转成上游的图片块转发，部件顺序保留；
> 带图请求只走 `openai` / `anthropic` / `gemini` / `workbuddy` 四种协议的渠道（[含图请求的候选裁剪](docs/scheduling.md)）。

## Web 控制台

```
http://127.0.0.1:8787/console
```

首次打开有一个「输入管理密钥」的小门——验证通过后换回**会话 cookie**（`HttpOnly` + `SameSite=Strict`，12 小时），
密钥本身**不落浏览器**；管理 API 每次调用仍强制鉴权（"页面能开 ≠ 有权限"），会话失效时自动重新弹门（详见 [行为细节 · 管理面会话](docs/behavior.md)）。

可做：实时看每个渠道的健康/延迟/错误/探测时间、改 priority、启停渠道、触发单渠道或全量重新探测、看各协议聚合模型清单、
**测试停用渠道里的模型**（停用只是"不参与调度与自动探测"，不代表不能手动打一发验证）、测试结果每行写明**测的哪个模型 + 通过/空回复/失败 + 延迟与 token + 回复或错误原文**、
**在「工具 → 配置历史」里查配置代际并一键回滚**（v1.18.84；代际按需拉取、不进 8 秒轮询，列表/详情里都不出现任何密钥原文）。

> 自动 vs 手动的边界：自动探测（启动时 + `health.intervalSec`）**只探启用渠道**；手动（「测试」/「重探测」/ `/admin/api/test` / `/admin/api/recheck`）不受此限，连停用渠道一起探。

## 文档

> ⚠️ **强制约定：改代码必须同步改文档**（无论改动来自谁）。完整规则见 [`AGENTS.md`](AGENTS.md)。

| 文档 | 用途 |
| --- | --- |
| [协议与渠道详解](docs/protocols.md) | 协议速查表之外的**全量细节**：原生出站与同协议直通、三条客户端路由的工具调用方向、notion-agent / workbuddy / genspark / codex / hark 配置要点、`proxy` 字段、图片转换 |
| [调度详解](docs/scheduling.md) | 调度顺序全量语义：同渠道重试、熔断冷却分级、加权轮询、自动权重（v1.18.63 起可选生效）、有效优先级、含图请求的候选裁剪 |
| [运行期设置（五组开关）](docs/runtime-settings.md) | 会话粘性 / 客户端限流 / `/metrics` / thinking 回放 / 自动权重的语义与 `GET/POST /admin/api/settings` 用法 |
| [配置代际与回滚](docs/config-history.md) | **为什么需要**（`persistConfig` 的显式白名单会静默吞字段，PT29 一族连发四例）、快照目录与 hash 去重、三个端点、回滚语义（哪些热生效 / 哪些要重启 / **为什么不动密钥段**）、**原子写与启动三跳自愈**（v1.18.85）、运维与边界（v1.18.83） |
| [行为细节](docs/behavior.md) | 4xx 兜底判据、流式失败、协议转换有损点、thinking 边界与回放、工具调用映射、密钥轮换、管理面会话、鉴权写法、v1.16 出站与流式写路径实测 |
| [测试清单](docs/tests.md) | 64 个测试文件 · 3114 项断言：每条守的是什么、「改什么 → 必跑什么」速查、测试哲学 |
| [安全整改记录](docs/security-hardening.md) | 渗透测试六批整改（v1.18.3–v1.18.10）逐批内容与守卫测试、11 项发现全量处置台账、复查记录 |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [字体与授权记录](docs/fonts.md) | 全站 `HCRound` 的**来龙去脉**：OFL-1.1 逐条依据、**为什么必须改名**（子集化＝修改版，不得沿用保留字体名）、改了哪些 `name` 字段、交付形态与缓存分层、字重映射逐处理由、可复现的再生成步骤与两个踩坑 |
| [控制台「运行期设置」页实现规格](docs/console-settings-spec.md) | 设置页的施工图：字段契约、五张卡结构、必须守住的交互细节、验收清单 |
| [thinking 回放缓存设计与实现记录](docs/thinking-replay-design.md) | 三次决策完整过程、跨协议 thinking/签名保真度地图、as-built 边界与验收映射 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | 动代码前过目：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查） |
| [同类网关内部机制对比](docs/gateway-comparison.md) | 本项目 vs new-api / one-api / sub2api / CLIProxyAPI / **notion2api** 的内部机制/性能/全面性对照（只比机制，不比多用户），含实测数字（v1.18.86 已全量重测本项目那一列，口径见 §5.1）与各家源码级证据；**§1.5 = 与 notion2api 七项差异的强弱结论**（附件/CSV 那一格 v1.18.42 起**已追平**，另加一条"教训型差异"：同一个软墙我们误判过三次，它的实现里根本没有这道坎） |
| [Genspark Claw 反代研究](docs/genspark-claw-reverse-proxy-research.md) | 逆向过程留档 |
| [hark.com 网页会话反代研究](docs/hark-reverse-proxy-research.md) | **已接入**（`protocol: "hark"`）：为什么不能当 openai 渠道填 base_url（`/v1/*` 回的是 SPA 壳）、**本机 403 的真因是 Node/curl 不读系统代理而不是 IP 声誉**（同一台机器 PowerShell 走代理 200）、回复整段下发（伪流式）、**上游工具全在服务端**（流里零 `tool_add`，客户端工具只能文本仿真）、**每轮约 11.5 万 harkTokens → 免费日额度只够约 69 轮**、系统路径护栏、复现命令 |
| [PromptQL（prompt.ql.app）反代研究](docs/promptql-reverse-proxy-research.md) | 结论：不建议接（多人协作 bot 工作台、按 OLU 计量付费，不是可蹭的模型额度；控制面 `auth.pro.ql.app` 本机被 DNS 污染） |
| [Arena 协议](docs/arena-protocol.md) / [Prism 反代研究](docs/prism-reverse-proxy-research.md) | 已撤渠道留档 |
| [notion 附件上传研究](docs/notion-attachment-upload-research.md) | **机制查明 + 活体验证 + 软墙根因**：**★ 最有价值的是抓法**——notion2api 的 `upstream.base_url` 可配，指向记录代理就抓到它发给 Notion 的原始报文（含三个必踩的坑：`origin`/`referer` 由 base_url 推出来、账号要按完整 probe JSON 导入、失败会把账号打成 `error`）。据此查明：CSV **不上 S3**，而是 `enableCsvAttachmentSupport:true` + 把 `{"file":{"file_data":"data:…","filename":"…"},"type":"file"}` 内联进 user step 正文（已按此实现为 opt-in 渠道字段，字节逐字对齐，见 `test/notion-attachment-inline-e2e.test.js`）；另白捡到 `getInferenceTranscriptsForUser` 的正确形状。**✅「模型真读到了」v1.18.42 已活体验证**（§8：对照答"没找到文件"、带附件答出只存在于 CSV 里的 `K7Q2M9`）——仍默认关，但那是**稳妥默认**不是"没验证过"。**§7/§7.7 = 软墙的两个维度**（账号状态主导、与传输无关且随时间变；客户端指纹只在账号可过时才看得见——同一秒交替打 curl 3/3 真答、fetch 0/3 软墙）；**§5/§6 是被推翻的旧结论、§7.4 是三次误判的留档，别重犯**。含上传链留档（取目标 → S3 桶根 204 → 公开 URL）、**软墙 ≠ 形状错的判别纪律**、判决实验与复现命令 |
| [notion 反代实现文档](docs/notion-implementation.md) | **照着配就能用**：`notion`（逆向 `token_v2`）与 `notion-agent`（官方 Agent API）两条路的区别、四类 `transcript` step 与 NDJSON 响应解析、出站通道链（软墙**两个维度**）、凭据发现与缓存、33 个模型代号表、伪流式输出与流断取回、**工具调用全流程**（注入协议原文、四种工具定义形状、流式扫描器、验证方法与失败模式表）、内联附件，以及「取凭据 → 建渠道 → 三级验证 → 故障排查表」全流程。协议层细节见[协议与渠道详解](docs/protocols.md)，逆向取证留档见[notion 附件上传研究](docs/notion-attachment-upload-research.md) |
| [OpenCode Zen 免费模型反代研究](docs/opencode-reverse-proxy-research.md) | **结论：可反代，两条路都通**（v1.18.72 第二次更正）——**① 正路 = 本机 `opencode serve` 边车**（**已接入**为 `protocol:"opencode"`）：跑的是真客户端、**不伪造任何东西**，建会话 + `generate` 即可拿到免费模型答复（实测口径与数字见 §5）。**② 直连面其实也是通的**，但必须同时伪造三样：UA 写成 `opencode/<渠道>/<版本>/<名字>`、`x-session-id` 铸一个 `descending()` 形状的 `ses_…`、system 以 OpenCode 标题生成器提示词的**前 ≥965 字符**开头并强制 `stream:true`（v1.18.71 写的"直连是死的、判据在报文之外、没有收敛点"**已被推翻**，§3 改写、§9 补第五/六条误判）。两种 403 仍要分开读（`RegionError` = 换出口有用 / `FreeTierError` = 换出口没用）。工程约束：**无 `stream` 参数**（只能伪流式）、不下发 token/费用、**同一会话不保留多轮记忆** ⇒ 必须把 `messages` 拍平成一个 prompt；工具只能文本仿真（**实测可用**）。合规：免费层条款写的是 "can only be used from within OpenCode"，**两条路都有封号风险**，直连那条更重（明确伪造客户端身份）。**付费面反而标准可用**（无密钥回 401 `AuthError`）⇒ 用现有 `openai` 渠道 + `baseUrl: https://opencode.ai/zen/v1` 即可。另查明：你已有五条中继渠道在供 opencode 系免费模型（`20110318` 等），链路瓶颈在中继自己的分组容量（§8） |
| [AI 工具调用桥接](docs/AI工具调用桥接-群友分享版.md) | 群友分享版说明 |

### 前端构建管线（一句话版）

生产控制台 `console.html` **不是手写的，是构建产物**：`node build/build.js` 组装
`console-redesign.html`（视觉唯一真源）+ `build/` 下的 head / shell / extra.css / app.js，
**不要手改产物**（下次构建会被覆盖）。管线图、文件角色表、行号换算见 [前端代码地图 §0](docs/frontend-code-map.md)。
改完 `console-redesign.html` / `build/*` 后**必须重新构建**，并按 [AGENTS.md](AGENTS.md) §1.2 重核行号锚点。

### 测试（一句话版）

**64 个文件 · 3114 项断言，全部零依赖**（e2e 真起「假上游 + 临时网关」，动态端口 + 临时目录，不碰仓库运行文件，不出网）。
跑全量：`node _run_all_tests.js`（仓库根，零依赖，逐个跑 `test/*.test.js` 并汇总文件数与断言数）。
全量清单、每条守的是什么、改什么必跑什么：[测试清单](docs/tests.md)。新增测试时登记进该文档与 `AGENTS.md` §3。

## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },   // perChannel = 同一家失败后原地再试几次
                                                              //   （只对 5xx/超时/网络错误；0/缺省 = 不重试，上限 5）
  // v1.18.88 重试预算（可选，缺省 32 次 / 10 分钟，正常请求够不着）：
  //   "budgetAttempts": 32,   // 一次请求最多发多少上游尝试（同渠道重试也算），1..500，0 = 不限
  //   "budgetMs": 600000,     // 一次请求最多花多久，1s..1h，0 = 不限
  //   命中时回 502 + error.budget 明细，不是伪装成"渠道全挂"（见 docs/scheduling.md「重试预算」）
  "channels": [
    {
      "id": "vendor-a-openai",
      "name": "中转A (OpenAI)",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "protocol": "openai",                  // openai | anthropic | gemini
      "priority": 10,                        // 顺序：谁先试、谁兜底
      "weight": 3,                           // 分流：同模型候选里按比例轮询（不填/0 = 不参与；⚠️ 打开 autoWeight 后 0/留空/1 等价、都进池，见「调度详解」）
      "enabled": true,
      "proxy": "http://host.docker.internal:7897",  // 可选：HTTP 代理（见协议详解），留空/删掉 = 直连
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
      "models": { "claude-3-5-sonnet": "claude-3-5-sonnet-20241022" }
    },
    {
      "id": "vendor-gemini",
      "name": "Gemini 中转",
      "baseUrl": "https://generativelanguage.googleapis.com",
      "apiKey": "AIza-xxx",
      "protocol": "gemini",
      "priority": 10,
      "models": { "gemini-1.5-pro": "gemini-1.5-pro-latest" }
    }
  ],
  "security": {                                // 来源 IP 态势与封禁（v1.18.11）：bannedIPs 持久化；trustedProxy 见下
    "bannedIPs": [],                           //   已封禁来源列表（客户端面一律 403；管理面/控制台不受影响）
    "trustedProxy": ""                         //   逗号分隔的反代地址：只有来自这些来源的 X-Forwarded-For 第一跳才被采信
  }
}
```

> 渠道字段 `proxy`（可选）：HTTP 代理地址，探测/测试/聊天全部经代理转发（流式会整体缓冲后回放）；
> `notion` / `notion-agent` 不支持代理。细则见 [协议与渠道详解](docs/protocols.md)。
> 渠道字段 `dropParams`（可选，v1.18.33）：**渠道级「不发这些参数」**——出站前从这家渠道的请求报文里删掉指定的几个参数。
> 用于「上游只吃不下某个参数」的场合：某渠道对「`tools` + `reasoning_effort`」组合直接 400，而客户端每次请求都带这两样，
> 参数是客户端发的、网关只原样转发 → 开关只能放在渠道上。**只接受白名单内的名字**（`reasoning_effort` / `thinking` /
> `temperature` / `max_tokens` 等；`messages`/`model`/`stream`/`tools` 这类结构性字段不在内，配错名字最多"没生效"、不会把请求打残），
> 白名单外的名字 **400** 并回带合法清单（不静默忽略）。生效于常规链路与同协议直通；`workbuddy` / `codex` / `genspark` /
> `notion-agent` / `hark` 自带专用报文构造，**不适用**。控制台入口：渠道编辑弹窗「不发这些参数」，合法名清单由
> `GET /admin/api/config` 的 `dropParamWhitelist` 下发。细则见 [协议与渠道详解](docs/protocols.md)。
> 渠道字段 `headers`（可选，v1.18.44）：**渠道级「自定义请求头」**——出站时把这几条头附加到这家渠道的请求上（每行一条 `Name: value`）。
> 用于「上游不只看密钥、还看客户端指纹」的场合：`agentrouter` 实测只带 `Authorization` 一律 **401 `unauthorized client detected`**，
> 带上 `User-Agent: claude-cli/2.0.0 (external, cli)` 才 **200**（**浏览器 UA 一样被拒**——它认的是 Claude CLI 指纹本身，所以别去"换个更像浏览器的 UA"）。
> `Authorization` 不可覆盖（后端会删掉，防止渠道配置顶掉网关自己的鉴权头）；生效于常规链路（openai / anthropic / gemini 系出站），
> `workbuddy` / `codex` / `genspark` / `notion-agent` / `notion` / `hark` 自带专用报文构造、**不适用**。
> 语义与 `dropParams` 同款：**显式值（含 `""`）优先、`""` 清空、不传该字段则保留旧值**。控制台入口：渠道编辑弹窗「自定义请求头」。
> 细则见 [协议与渠道详解](docs/protocols.md)。
> 渠道字段 `notionAttachments`（可选，v1.18.41，**默认关**）：**只对 `notion` 协议有意义**——打开后，客户端发来的
> 内联附件（OpenAI `{type:"file",file:{filename,file_data:"data:…;base64,…"}}` 或 Anthropic `document` 块，
> 单文件 ≤1MB、最多 3 个）会被**内联进提示词**并同时打开 config step 的 `enableCsvAttachmentSupport`。
> 形状抄自参照实现 notion2api 的**实发报文**（**CSV 不上 S3、不建任务、不插 attachment step**）；
> ✅ 「模型真读到了」**已活体验证**（v1.18.42：对照答"没找到文件"、带附件答出只存在于 CSV 里的串，
> 并经本地容器网关复验），但仍**默认关**——不显式打开时报文与从前**逐字相同**（稳妥默认，不是"没验证过"）。
> 非布尔值 **400**；对非 `notion` 协议配它 **400**。机制、判据与活体验证见
> [notion 附件上传研究](docs/notion-attachment-upload-research.md) §4。
> 渠道字段 `firstChunkTimeoutMs` / `timeoutMs`（可选，v1.18.46，整数毫秒）：**渠道级「首字死线」与「每渠道总超时」**。
> 首字死线默认**有其它候选 30s / 末位 60s**，总超时默认按路径 **90s / 120s / 180s**——正常渠道**不必配**。
> 它专治「这家很慢或上游挂死」：那种渠道会让网关**白等 30~60 秒**才换下一家（客户端先超时，用户看到"等两分钟然后失败"）；
> 给它配个小值（例 `"firstChunkTimeoutMs": 8000`）就能**几秒内被跳过**，慢家不再拖累整体响应。
> 值域：`firstChunkTimeoutMs` **1000~300000**、`timeoutMs` **1000~600000**，越界/非整数 **400**。
> **`0` 不是"不超时"**——运行期是 `ch.def.timeoutMs || 默认`，`0` 会被换成默认值（"配了不生效"），所以**留空才是回到默认**。
> 控制台入口：渠道编辑弹窗「首字死线 (ms)」「总超时 (ms)」。⚠️ v1.18.46 之前这两个字段**运行期一直在读、却三处都没登记**：
> 配好之后**保存任意一个渠道**就会被 `persistConfig` 的显式字段清单抹掉（下次重启悄悄回默认），GET 也不下发（控制台看不到它）。
> 现已补齐（落库清单 / GET 下发 / POST 三态语义），回归见 `test/channel-timeout-attribution-e2e.test.js` §E。
> 🛟 **这一类"保存即丢字段"的事故现在有兜底了（v1.18.83 后端 / v1.18.84 控制台入口）**：每次改写 `config.json` 前都会先存一代快照，
> 控制台「配置历史」页（工具 → 配置历史）可以查「某一代 → 现在」的**字段级差异**（直接点名少了哪个字段）并一键回滚（两步确认、不动密钥、回滚本身也可撤销）。
> 见[配置代际与回滚](docs/config-history.md)。
> 🛡️ **写盘与启动也补硬了（v1.18.85 起，v1.18.86 补齐容器侧）**：`config.json` / `usage.json` / 代际快照一律**原子写**（同目录 tmp → **fsync** → rename），
> 进程在写盘中途被杀不会再留下半截 JSON；万一 `config.json` 已经坏了，启动会按「正主 → `config.json.bak` → 代际快照」
> **三跳自动恢复**（坏文件留档 `config.json.corrupt-<时间戳>`、好版本原子写回正主，下次启动不再需要退路），
> **三跳全坏才报错退出**——绝不会静默用空配置起来骗你说启动成功。
> ⚠️ **原子写的前提是"tmp 与目标同 device"**：旧版 `docker-compose.yml` 把配置挂成**单文件**
> （`./config.json:/app/config.json`），容器里那是**挂载点本身**、与 `/app` 不在同一 device ⇒ `rename` 失败。
> **v1.18.85 第一版没兜这条，实测"点一次保存渠道 → 网关 `Exited(1)`"**（`EBUSY`）；补了降级后功能正常但只剩"坏了能救"。
> **v1.18.86 起改为挂一个目录 `./data:/app/data`**（`config.json` / `usage.json` / `config-history/` 都在里面），
> tmp 与目标同 device，**rename 成功、原子性完整**——实测启动与真实保存后日志里**不再出现** `[atomic] … 已降级`。
> 本机 `node server.js` 想与容器共用同一份配置：`ZZCSAPI_CONFIG=data/config.json node server.js`。
> 见[配置代际与回滚](docs/config-history.md) §2.4 / §2.5 / §2.6，回归见 `test/config-atomic-write-e2e.test.js`。
> 调度旋钮（`cooldown` / `retries` / `autoWeight`）与运行期五组开关（`sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay` / `autoWeight`）
> 的全量取值与钳制范围见 [调度详解](docs/scheduling.md) 与 [运行期设置](docs/runtime-settings.md)。
> `security.trustedProxy` 只在网关部署在反向代理后面时才需要：留空 = 直连模式，一律只认 socket 地址
> （`X-Forwarded-For` 是客户端可伪造的头，不设门槛就采信会把封禁变成假功能）。Docker 下想让来源统计
> 看到每台机器真实 IP 的完整接法（宿主机 nginx + 固定子网 + `ZZCSAPI_PUBLISH` 开关）见上面[方式三](#方式三反代采信模式想让来源统计看到每台机器真实-ip)；
> 来源统计是**内存态**（网关重启清零），封禁表落 `config.json` 重启不丢——语义见 [行为详解](docs/behavior.md)。

## 协议说明

| protocol | 探活 URL | 鉴权头 | 出站报文 |
| --- | --- | --- | --- |
| `openai` | `GET /models` | `Authorization: Bearer ...` | OpenAI 格式，原样转发 |
| `anthropic` | `GET /v1/models` | `x-api-key: ...` + `anthropic-version` | **原生 Anthropic**：`POST /v1/messages` |
| `gemini` | `GET /v1beta/models` | `x-goog-api-key: ...` | **原生 Gemini**：`POST /v1beta/models/{m}:generateContent` |
| `notion` | `POST getSpaces` | `Cookie: token_v2=...` | 逆向 Notion AI（需 token_v2 Cookie） |
| `notion-agent` | `POST /v1/agents/query` | `Authorization: Bearer ntn_...` | Notion 官方 Agent API（公开 beta） |
| `workbuddy` | 自检 `chat/completions` | `Authorization: Bearer ...` + **会话信封三件套** | WorkBuddy 逆向（必须走 curl 子进程；token 是 JWT，新版已加密）。**v1.18.78 起上游对流式请求校验 `X-Conversation-ID` / `-Request-ID` / `-Message-ID`，三个缺一即 400 `request illegal`**（网关每次请求现生成，无需配置）。**v1.18.80：报文里只要有一条 `role:"developer"` 就吃同一枚 `11-128`（文案变成 `Illegal API invocation from an unapproved channel`，看着像客户端指纹、实际只认角色名），网关已统一把 `developer` 归一成 `system`**。**v1.18.81：原生 `tools` 可用，非流式回包也会带回 `tool_calls`**（按 `index` 拼回分片）。**v1.18.82：可带图**——它走的是 OpenAI 兼容面的原生透传，`image_url` 原样转发（实测上游 200 且模型真读了图），已进 `IMAGE_CAPABLE_PROTOCOLS` |
| `codex` | 一次令牌刷新 | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效） |
| `genspark` | `GET /api/is_login` | `Cookie: session_id=...` | Genspark 网页会话反代（**必须配代理**；工具调用靠文本仿真） |
| `hark` | `GET /api/auth/get-session` | `Cookie: __Secure-hark.session_token=...` | hark.com 网页会话反代（**本机必须配代理**，云端直连；建会话 + REST 发消息 + SSE 收 patch；伪流式、工具靠文本仿真）。**别名至少要配一条**（上游没有 `/v1/models`，推荐 `hark-agent`）——控制台点「获取模型」会拿到这条默认建议；别名表空 = 这个渠道永远不会被请求命中 |
| `opencode` | `GET /api/model` | `Authorization: Basic`（用户名 `opencode`，密码=边车口令） | **本机 `opencode serve` 边车的免费模型**（v1.18.72，[研究](docs/opencode-reverse-proxy-research.md)）。上游是**宿主机上那个已登录的边车**，不是 `opencode.ai`——直连面永远 403（判据是客户端身份）。**★ v1.18.89 起边车由网关自己起**：`deploy/opencode-sidecar.ps1`（固定端口 **4666** + 口令取 `.env` 的 `OPENCODE_SIDECAR_PASSWORD` + **工作目录设成空目录**）——蹭别的应用拉起的边车会**端口与口令双漂**，实测按 5 分钟一次敲出 **87 次全失败 / 0 次成功**。生成路由**两代兼容**（新版 `POST /session/{id}/message` → `parts[].text`，老版 `/api/session/{id}/generate` → `data.text`），**收到 HTML 一律判失败**（边车是 SPA，不存在的路由回 200 + 兜底页）。建会话 + 生成 + **用完即删**；伪流式、**新版给真 token**（老版估算）、**没有多轮记忆**（每请求把 messages 拍平成一段）⇒ 工具靠文本仿真。baseUrl 填容器能访问的边车地址（容器里用 `host.docker.internal:4666`；边车绑 `127.0.0.1` 就够，Docker Desktop 会转发到宿主回环），**不要给它配代理**（本地跳，不是出公网）。⚠️ 免费层条款是「can only be used from within OpenCode」，中继第三方流量**有封号风险** |

`arena` 协议已撤（[留档](docs/arena-protocol.md)）。

**客户端说哪套协议、渠道讲哪套协议，互不绑定**：任一客户端路由都能打到任一协议的渠道（出站自动转原生格式）；
**同协议的那格直通不翻译**（v1.15——`thinking` / `cache_control` / `seed` 等原样到达，响应逐字节一致；v1.18.8 起还带
thinking 回放修复）。**七条**专用报文渠道（`notion` / `notion-agent` / `workbuddy` / `genspark` / `codex` / `hark` / `opencode`）的响应输出也走各客户端面的
收口钩子（v1.18.38 修正：此前它们自己写 OpenAI 报文，Responses / Anthropic / Gemini 面会拿到错形态）；
**候选链分层**——Anthropic / Gemini 两条链只兜底到 `notion` / `notion-agent` / `codex`，`workbuddy` / `genspark` / `hark` / `opencode` 只挂在 OpenAI 类链上。
`notion` 渠道另有**流断取回兜底**（v1.18.39：上游流断/带错误/零内容时，用同一 `threadId` 把同一份 transcript 再发一次取回成品答案；
触发判据只看"权威全文到没到"，正常请求零额外延迟与额度，取不回仍如实判失败）。
矩阵表、工具调用四方向、各渠道配置要点、有损点诚实清单：[协议与渠道详解](docs/protocols.md)。

## 调度顺序（摘要）

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias——**同协议优先，跨协议兜底**（现有 `openai` 渠道先后顺序不受影响），最后才是 notion → notion-agent → workbuddy → genspark → **codex → hark** → opencode 文本链（顺序以 `server.js` 里那张遍历表为准：`['openai','notion','notion-agent','workbuddy','genspark','codex','hark','opencode']`；v1.18.88 前这里把 codex 与 hark 写反了）
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数第二；`probation`（半愈合观察期）→ 健康渠道之后；同状态按**有效优先级**降序，再看 latency
4. **加权轮询**（填了 `weight` 的渠道按比例决定谁排第一；⚠️ 打开 `autoWeight` 后**没填也进池**，基底取 1，见 [调度详解](docs/scheduling.md)「自动权重」；★ v1.18.76 起**一次真实请求只记一次命中、且只记真正竞争的那个池**——控制台那列份额不再被"只是排在后面的兜底协议"虚抬）；**会话粘性**（开着时）把这条会话上次成功的那家提到第一位
5. **含图请求**先按图片能力门裁剪候选；纯文本不受影响
6. 依次尝试直到成功；全部失败返回 502 + 错误详情。**同渠道重试**（`retries.perChannel`）只对 5xx/网络/超时原地再试，4xx 一律不重试；**上游报文里明说 `isRetryable:false` 时也跳过重试**（目前只有 notion 会这么说，见 [调度详解](docs/scheduling.md)「上游否决」）
7. **重试预算**（`retries.budgetAttempts` / `budgetMs`，v1.18.88，缺省 32 次 / 10 分钟）：给"`perChannel` × `maxModelFallbacks`"这个乘积加总闸——同渠道重试也吃预算，两条上限先到先停；命中时回 502 + `error.budget` 明细（不伪装成"渠道全挂"）。正常请求够不着，`0` = 不限。见 [调度详解](docs/scheduling.md)「重试预算」

```
有效优先级 effPriority = priority − 失败率 × 3      // 失败率取滚动窗口 ch.roll（样本 ≥5 生效，120 次后减半衰减）
```

重试/冷却/权重/自动权重/图片门的全量语义与调参：[调度详解](docs/scheduling.md)。

## 响应头（排查用）

客户端面的每个响应都带两枚头——**"谁"与"为什么"是两个问题**，所以两枚都留：

| 头 | 举例 | 说明 |
| --- | --- | --- |
| `X-ZZCSAPI-Channel` | `vendor-a-openai` | **实际服务的渠道 id**（身份以这枚为准，v1.14 起） |
| `X-ZZCSAPI-Route` | `ch=vendor-a-openai; pick=priority; pos=1/3; attempt=1; skipped=0` | **为什么是这家**（v1.18.88）：`pick` 取值见下表 |

`pick` 的全量取值（不多不少，每一种都有确定含义）：

| 值 | 含义 |
| --- | --- |
| `priority` | 按有效优先级排到链首（没配 weight / 没命中粘性 / 没续试，正常路径） |
| `weighted` | 加权轮询（smooth WRR）把它选出来提到链首 |
| `affinity` | 会话粘性命中，把这条会话上次用的那家提到链首 |
| `cursor` | 同报文续试，从上一发停下的**下一家**开始（v1.18.62 的候选游标） |
| `fallback` | 前面那些家已经失败/冷却，**轮到**这一家（不是"选出来的"） |
| `all-failed` | 整条链都试过了，仍没有一家成功（502） |
| `exhausted` | 重试预算先用尽，后面还有没试到的候选（502，`error.budget` 有明细） |
| `all-cooldown` | 一个都没试：全部候选都在冷却（503，`error.cooldown` 有明细） |

- `pos=<第几家>/<候选总数>`、`attempt=<本请求已发上游尝试数>`、`skipped=<因冷却跳过的家数>` 是三个计数，方便一眼看出"是不是在链尾兜底"。
- 取值是**纯 ASCII 分号键值对**（HTTP 头不允许非 ASCII）：渠道 id 里的非 ASCII 一律换成 `?`、分号换成逗号（否则一个 id 能把头拆成两个键）。
- 它**不替代** `X-ZZCSAPI-Channel`——排查"为什么这次走了兜底家 / 为什么跳过了第 1 家 / 是不是加权轮询把它提上来的"看这枚；要"谁在干活"看那枚。

## 端点

| 路径 | 方法 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `/healthz` | GET | 无 | 网关自身存活探针（只回 `{ok:true}`，v1.18.9 起不带渠道数/密钥状态——渗透整改 V-08） |
| `/console` | GET | admin | Web 控制台 HTML |
| `/console/fonts/**` | GET | 无 | **自托管字体资产**（v1.18.37）：`font.css`（按 `unicode-range` 分片入口）+ `regular/`、`bold/` 下的 woff2 + `LICENSE.txt`（OFL 原文，**承重件**）。只查启动时扫出的白名单表、不做路径拼接，分片内容哈希故 `immutable` 长缓存，入口 CSS 短缓存 + 惰性 brotli。见 [字体与授权记录](docs/fonts.md) |
| `/admin/api/status` | GET | admin | 渠道详细状态（控制台用；含 `weight`/`weightedShare`/自动权重观测/`effectivePriority` 等字段） |
| `/admin/api/usage` | GET | admin | 用量统计（总量 / 按模型 / 按渠道 / 按天〔北京时间日〕/ 近 200 条 / 24h 分布〔北京时间小时〕） |
| `/admin/api/usage/clear` | POST | admin | 清零用量统计 |
| `/admin/api/stats` | GET | admin | **来源 IP 态势统计**（per-IP 敲门数 / token / 模型 / 峰值并发 / 会话估计 / 24h 桶 / 封禁命中；内存态，重启清零） |
| `/admin/api/bans` | POST | admin | 封禁来源 IP（body `{ip}`，字面量校验，立即生效 + 落库，幂等） |
| `/admin/api/bans/{ip}` | DELETE | admin | 解封来源 IP（不存在 404）；封禁只拦客户端面，管理面/控制台永远可达 |
| `/admin/api/recheck` | POST | admin | 立即重探测（body 可传 `{id}`）；**不带 id = 全部重探测，含停用渠道** |
| `/admin/api/channel` | POST | admin | 改渠道（`{id, priority?, enabled?, weight?}`，立即生效并持久化） |
| `/admin/api/channels` | GET | admin | 渠道列表（`apiKey` 只下发掩码 + `apiKeySet` 布尔） |
| `/admin/api/channels` | POST | admin | 新增 / 覆盖渠道（upsert，落库并立即探测一次）；**`apiKey` 留空 = 保持原密钥**；`dropParams` 显式空数组 = 清空、不传 = 沿用旧值（v1.18.33）；`headers` 同款语义（显式值含 `""` 优先、`""` 清空、不传 = 沿用旧值，v1.18.44）；请求体不是 JSON 对象 → **400 `invalid json body`**（v1.18.57：此前 `safeReadJson` 返回 `null` 时直接取 `body.id`，畸形报文会把**整个网关进程打退出**，靠容器 restart 自愈） |
| `/admin/api/channels` | DELETE | admin | 删除渠道（body `{id}`） |
| `/admin/api/probe` | POST | admin | 临时探测上游模型清单（不落库） |
| `/admin/api/test` | POST | admin | 真发一次最小 chat 请求；带 `channelId` 时**只打该渠道且不看 `enabled`**；**`stream:true`（v1.18.40）= 按真实客户端姿势发流式请求**并按真实链路同一套判据（`classifyStreamFrame`）判定（流内 error 帧 / 200 零正文流 / 上游无视 `stream` 回整段 JSON 都算失败），结果回带 `stream`、`streamFrames`、`streamIgnored`、`ttfbMs`；**测试成功只"半愈合"**（放开冷却 + 清 `probeFail`），**不清真实流量的连败计数**（见[调度详解](docs/scheduling.md)） |
| `/admin/api/codex-import` | POST | admin | 导入 codex 凭据（完整 JSON 或裸 RT） |
| `/admin/api/codex-quota` | GET | admin | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import` | POST | admin | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config` | GET | admin | 接入信息（URL / 端口 + 密钥**掩码** + `keysInsecure`；不交任何密钥原文）+ `dropParamWhitelist`（渠道 `dropParams` 的合法参数名，控制台照用） |
| `/admin/api/config/history` | GET | admin | **配置代际列表**（v1.18.83）：每次改写 `config.json` 前存一代（hash 去重、环上默认留 20 份）；**只给 seq / 时间 / 字节 / hash / 渠道数，不含任何配置内容**（快照含明文 key） |
| `/admin/api/config/history/{seq}` | GET | admin | 取某一代的**掩码视图** + 「那一代 → 当前」的字段级 `diff`——`diff.channels.changed[].fields` 直接点名**被静默抹掉了哪个字段** |
| `/admin/api/config/rollback` | POST | admin | **一键回滚**（body `{seq}`）：写回 `config.json` 并**热应用**渠道 / 五组设置 / 封禁表；`port`/`health`/`retries`/`cooldown` 报 `needsRestart`；**密钥段不动**（`keysPreserved`）；回滚前自动存一代 ⇒ 可撤销。见[配置代际与回滚](docs/config-history.md) |
| `/admin/api/channels/{id}/key` | GET | admin | **按需揭示**：取单个渠道的上游密钥原文 |
| `/admin/api/gateway-key` | GET | admin | **按需揭示**：取网关 `GATEWAY_KEY` 原文 |
| `/admin/api/admin-key` | GET | admin | **按需揭示**：取管理 `ADMIN_KEY` 原文 |
| `/admin/api/keys` | GET | admin | 密钥管理：两把密钥的**掩码 + 来源** + `keysInsecure` + `rotatedAt`，绝不含明文 |
| `/admin/api/keys` | POST | admin | **控制台轮换密钥**：body `{gatewayKey?, adminKey?}`，立即生效并落库（优先级高于环境变量），旧密钥立即失效 |
| `/admin/api/keys/generate` | POST | admin | 随机生成新密钥（48 位，四样字符齐全）：body `{target: "gateway"\|"admin"\|"both"}` |
| `/admin/api/keys/reset` | POST | admin | 删掉 `config.json` 的 `auth` 段，回到「环境变量 → 首启生成」取值链 |
| `/admin/api/session` | POST | 匿名（登录门） | 交一次 `ADMIN_KEY` 换回 `HttpOnly` 会话 cookie（12 小时）；登录失败计入 admin 失败限流 |
| `/admin/api/session` | DELETE | 会话 cookie | 退出登录：只杀自己那枚 token + 过期 cookie；其余方法 405 |
| `/admin/api/settings` | GET/POST | admin | **运行期设置**：读写 `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay` / `autoWeight` 五组（PATCH 语义，立即生效 + 落库，未知字段 400 点名）——语义见 [运行期设置](docs/runtime-settings.md) |
| `/metrics` | GET | admin（`metrics.public:true` 时匿名） | **Prometheus 文本格式**：请求/渠道/令牌/耗时/熔断分档/粘性/限流/回放指标；`enabled:false` 时 404 |
| `/admin/status` / `/admin/recheck` | */POST | admin | 旧版兼容路径 |
| `/v1/models` | GET | gateway | OpenAI 聚合模型 |
| `/v1/chat/completions` | POST | gateway | OpenAI chat（支持 stream） |
| `/v1/embeddings` | POST | gateway | 透传 |
| `/v1/images/generations` | POST | gateway | OpenAI 生图（需上游渠道支持图像接口） |
| `/v1/responses` | POST | gateway | **OpenAI Responses API（v1.18.38）**：入站按 Responses 报文收（`input`/`instructions`/`max_output_tokens`/扁平工具），转成 chat 报文后**复用同一条候选链**，出站转回 `response` 对象 / Responses 的 SSE 事件序列；`store:false` 不落内存表。有损点（`previous_response_id` 不续接、内置工具丢弃）见 [协议详解](docs/protocols.md) |
| `/v1/responses/{id}` | GET / DELETE | gateway | 取回 / 删除已存响应（内存表：最近 200 条、1 小时 TTL，重启即清空；`store:false` 的取不到） |
| `/v1/completions` | POST | gateway | 透传 |
| `/anthropic/v1/models` | GET | gateway | Anthropic 聚合模型 |
| `/anthropic/v1/messages` | POST | gateway | Anthropic Messages（支持 stream） |
| `/gemini/v1beta/models/{m}:generateContent` | POST | gateway | Gemini 非流式（支持 `inlineData`/`fileData` 图片） |
| `/gemini/v1beta/models/{m}:streamGenerateContent` | POST | gateway | Gemini 流式 |

## notion 附件判决实验（只读脚本，低额度）

`node notion-attachment-verdict.js` 回答一个问题：**notion 渠道的「内联附件」到底有没有让模型读到文件？**
判据只有一条——模型能不能答出**只存在于 CSV 里**的随机串（`K7Q2M9`）。做法是**成对打**：同一账号同一时刻先打**对照**（不带附件），
对照真答了才打**附件**那一发。**为什么必须成对**：软墙（200 + `temporarily-unavailable`）下发出来的"空"与"附件没生效"长得一模一样，
不成对打就会把软墙误判成"附件不生效"。

```powershell
node notion-attachment-verdict.js              # 默认预算 14 发
node notion-attachment-verdict.js 8            # 更小的预算
node notion-attachment-verdict.js 8 notion5    # 只打某个渠道
```

三种结论：**已打通**（答出随机串 → 可以打开渠道的 `notionAttachments`）/ **没读到**（对照与附件都真答但答不出随机串）/
**未取得**（账号全在软墙里，实验条件不成立）。成本：还在墙里的账号一发只花 ~1~2 秒、**不消耗真实推理**。
**报告绝不回显任何凭据**。

**它已经给出过结论（2026-10-06，v1.18.42）**：在 `notionls` 上**已打通** —— 对照那一发模型答
「我在这段对话里没有找到你上传的 CSV 文件」，带附件那一发答出 **`K7Q2M9`**（只存在于 CSV 里的串）。
为什么此前它一直报"未取得"、以及为什么**不要再为软墙改报文形状**（真根因是**两个维度**：账号状态主导、客户端指纹次之），
见 [notion 附件上传研究](docs/notion-attachment-upload-research.md) §5–§8。

## notion 软墙探针（只读脚本，低额度）

`node notion-wall-probe.js` 把软墙的**两个维度**分开——两个维度给客户端的表象一模一样
（都是 `200 + temporarily-unavailable`），只看见一个就会得出**只对一半**的结论（本项目为此误判过三次）：

| 维度 | 是什么 | 怎么认出来 |
| --- | --- | --- |
| **A · 账号状态**（主导） | 账号自身在墙里/不在墙里，**与传输无关**，且**随时间变** | 所有传输**一起**软墙 ⇒ 换传输没用，网关会如实报 `ok:false / notion: temporarily-unavailable` |
| **B · 客户端指纹** | 账号可过时，curl 过、Node 的 `fetch`/undici 不过 | 同一窗口里 **curl 真答、fetch 软墙** ⇒ 这正是通道链的排序依据 |

做法是**在同一个时间窗内把待比较的传输交错打**（C F C F …），而不是"今天打 A、明天打 B"：

```powershell
node notion-wall-probe.js                           # 默认 notionls，交错 curl,fetch × 3 轮
node notion-wall-probe.js notion7                   # 指定渠道
node notion-wall-probe.js notionls curl,fetch,h2 2  # 指定传输序列与轮数（chain = 线上真实走的通道链）
```

读法：`★"收到"` = 真答、`W` = 软墙、`?` = 其它响应、`E` = 异常；末尾会直接给**维度 A / 账号可过 / 未取得**的判决。
**报告绝不回显凭据**；还在墙里的账号一发只花 ~1~2 秒、**不消耗真实推理**。
⚠️ **克制使用**：有未验证的怀疑——高频用 Node 客户端敲门会把账号推入维度 A；
而唯一已知可过的账号往往正是活体判据的来源，拿它刷量的代价大于收益（看维度 B，2~3 轮就够）。

## 渠道指纹判决探针（只读脚本，低额度）

`node channel-fingerprint-probe.js <渠道id>` 回答一个问题：**这家上游是不是在查客户端指纹？**
——即"模型不回答 / 获取模型失败"到底是**上游挑客户端**，还是**上游今天心情不好**（凭证、额度、渠道本身）。

做法是把那一刻的对照实验固定下来：**同一渠道、同一时刻、只改一个变量**——先带渠道配的
`headers` 探一发，剥掉 `headers` 再探同一发，然后直接给判决。

```powershell
node channel-fingerprint-probe.js agentrouter        # 判决这一家
node channel-fingerprint-probe.js agentrouter --save-check   # 加做「保存不丢请求头」那一组（会写一次配置）
node channel-fingerprint-probe.js --all              # 扫全部已启用渠道（★ 慎用，见下）
```

判决三态：**①成 ②败** ⇒ 这家在查客户端指纹，且它要的就是渠道里配的那套头；
**①败 ②败** ⇒ 不是指纹问题（凭证/额度/上游故障），探针**给不出一致结论就不硬下**；
**①成 ②成** ⇒ 不查指纹。`--save-check` 单独验证 v1.18.44 的现场：控制台保存渠道时若没带
`headers` 字段，落库后请求头必须**仍在**（旧写法会静默删掉它）。

为什么值得留一个探针：这类问题本项目已经踩过两次，**两次都花了一整轮去定性**——
Notion 的软墙（同一秒交替打，curl 3/3 真答、fetch 0/3 软墙）与 AgentRouter 的 401
（只带 `Authorization` 必 401，加上 `User-Agent: claude-cli/2.0.0 (external, cli)` 就 200 列出模型，
**而浏览器 UA 一样被拒**——它认的是那个客户端指纹本身，不是"任意浏览器化的 UA"）。

**它只发探测、不发对话，不消耗推理额度**；报告绝不回显凭据（`apiKey` 只出长度，错误文案也过 mask）。
⚠️ `--all` 会对每一家已启用渠道各敲两发，渠道多时既慢又唐突，**别当例行体检跑**；
notion 的软墙问题请优先用 `notion-wall-probe.js`（它是同一时间窗内交错打的，更省更准）。

## opencode 判决探针（只读脚本，低额度）

opencode 的免费层有**两个面**，**两条路都能通、但代价完全不同**，两个探针分开测——
分不清就会像 v1.18.70 / v1.18.71 那两版一样把结论写反（一版说"都不可反代"，一版说"直连是死的"）。

### 直连面：`node opencode-probe.js`

回答一个问题：**opencode 那 11 个 `-free` 模型，直连时到底哪一道门在拦我们？**

opencode 的失败体有**两种 403**，含义完全不同、处置也完全不同，而控制台里都只是一句"渠道故障"：

| 失败体 | 含义 | 处置 |
| --- | --- | --- |
| `RegionError` | 出口 IP 的地区不开放该模型 | 换出口**有用** |
| `FreeTierError` | 客户端身份不是 OpenCode | 换出口**没用** |

所以它**按层分开打**（目录 / 凭据门 / 付费门 / 地区门 / go 面），末尾给一行机器可读判词：

```powershell
node opencode-probe.js                              # 直连
node opencode-probe.js --proxy http://127.0.0.1:7897  # 走代理（★ Node/curl 不读系统代理）
```

**它给出的结论（v1.18.72 第二次更正）**：直连这一面**其实是通的**，v1.18.71 说的"判据在报文之外、没有收敛点"**是错的**——
门禁是**报文里三样可自造的东西**：① `User-Agent` 必须是 `opencode/<渠道>/<版本>/<名字>` 形状
（`opencode/foo` 与任何普通 UA 都是 403）；② `x-session-id` 铸一个 `descending()` 形状的 `ses_…`
（**不是服务端签发的凭证**，新铸的 ID 首次使用即通过）；③ system 必须以 OpenCode **标题生成器提示词的
前 ≥965 字符**开头（边界实测 `964`→403 / `965`→200），且强制 `stream:true`、不带 `tools`。
三条齐了就是 **200 + 真 SSE 正文**（已独立复核，见研究文档 §3）。**但这条路要伪造客户端身份**，
且能力被限成单轮纯文本，所以**网关接入走的是边车那条正路**（`protocol:"opencode"`）。
另外**付费面反而是可用的**（无密钥回 401 `AuthError`，不是 403）⇒
要接付费模型就用现有 `openai` 渠道 + `baseUrl: https://opencode.ai/zen/v1`，**不需要新协议**。
完整证据与**六次**误判留档见 [OpenCode Zen 免费模型反代研究](docs/opencode-reverse-proxy-research.md)。

读法：**撞 `RegionError` 时本项记「未作判定」而不是失败**——那不是探针没干活，是这一发根本没走到客户端门，
必须换出口重跑，否则会把"地区问题"当成"客户端问题"，在两个不同的层上排查半天。
**不消耗真实推理额度**（全部 `max_tokens=16`）；不需要也不回显任何凭据。
⚠️ **克制使用**：它测的是"直连面能不能被伪造通行"，**不是**接入建议——要接就接边车（下面那个）。

### 边车面：`node opencode-sidecar-probe.js` —— ★ **这条路是通的**

```powershell
node opencode-sidecar-probe.js                      # 自己起一个临时 opencode serve 来测
node opencode-sidecar-probe.js --bin <opencode.exe> # 指定可执行文件
node opencode-sidecar-probe.js --base http://127.0.0.1:49551 --password-env ZZ_OC_PW  # 测已在跑的边车
```

**它给出的结论**：`opencode serve`（那个自带 HTTP 服务）**就是被上游认可的那个客户端**——
它用你的登录态 + 真客户端身份发请求，`POST /api/session` 建会话、`POST /api/session/{id}/generate` 发一句，
就能拿到 `deepseek-v4.1-flash-free` 等免费模型的答复（实测 `17*23`→`391`、随机口令逐字命中、
4 路并发全中、8 连发 0 个 429、冷启动 0.64 秒）。

它按层打：起边车 → 目录 → 凭据库（**只报大小，不读内容**）→ **生成**（随机口令**逐字命中**才算通）
→ **付费对照**（付费模型必须如实失败，证明免费那发不是"什么都答"的空壳）。
判词：`判决：边车=<passed|blocked|undecided> 目录=… 生成=…`。

- **连不上/起不来记 `undecided`，不是 `blocked`**——"测不到"≠"这条路不通"，别把两者混为一谈。
- **密码只从环境变量读**（`--base` 必须配 `--password-env`），绝不进命令行、绝不打印。
- ⚠️ **合规/封号风险**：免费层条款写的是 "can only be used from within OpenCode"。跑真客户端本身没有伪造，
  但把第三方流量中继进免费层**不是该层的设计用途**，官方也明说免费是 limited time。要不要上生产由你决定。

工程现状（**接之前先读**）：边车 API **不是 chat-completions** ⇒ 网关侧要写**新协议**；
**没有 `stream` 参数**（只能伪流式）、**不下发 token/费用**、**同一会话不保留多轮记忆**
（每请求要把 `messages` 拍平成一个 prompt）；边车必须跑在**那台已登录的机器上**，容器经
`host.docker.internal:<port>` 访问（同现有 `proxy` 字段的用法）。详见研究文档 §5/§10。

### 已经接好了：`protocol:"opencode"`（v1.18.72）

上面那些工程约束**已经落进代码**，不用自己写：

**① 在宿主机上起一个边车**（要有登录态；自带的管理服务不接受自选密码，所以必须自己起一个）：
**口令是你自己定的 —— 先定它，然后在两处写同一个值（这里 + 控制台的钥匙框）。**

```powershell
$env:OPENCODE_SERVER_PASSWORD = 'REPLACE_WITH_YOUR_OWN_PASSWORD'      # ← 口令在这里"定"下来；内容随你，记住它
opencode serve --port 49551 --hostname 127.0.0.1
```

> ★ **「不设口令」不等于「不用口令」**（v1.18.72 实测）：`serve` 没有 `--password` 参数，
> **环境变量是设口令的唯一入口**；而**不设它，边车会自己随机生成一个口令并打进 stdout 日志**
> （`server password <随机串>`）——你**仍然**得把它抄进钥匙框，只是更难抄、且它躺在日志里（日志即泄露面）。
> 所以自己设更省事也更干净。四条对照实测：不带 `Authorization` **401** / 口令对 **200** /
> 随便填 **401** / 口令对但用户名错 **401**。另：`$env:` 只活在当前窗口，跨重启用
> `setx OPENCODE_SERVER_PASSWORD "<值>"`。⚠️ 口令里**别带冒号**（`user:密码` 是语法，冒号前会被当用户名）。
> 详见 [研究文档 §5.2.1](docs/opencode-reverse-proxy-research.md)。

**② 控制台 → 渠道 → 新建**：协议选 `opencode 免费模型`，`baseUrl` 填 `http://host.docker.internal:49551`
（容器里的写法；本机 `node server.js` 直跑就填 `http://127.0.0.1:49551`），
**钥匙填 ① 里那个一模一样的口令**（不是用户名、不是另想一个），点「获取模型」——
只会列出**免费**模型（付费模型在这台机器上必定 `503 Insufficient account funds`，列出来就是给你塞一批永远失败的渠道），
随手保存即可（它有真目录，别名会自动补，**不需要**手配）。

**③ 就这么用**：请求 `deepseek-v4.1-flash-free` 等免费模型即可。工具调用走**文本仿真**
（与 hark 同一套路：注入工具协议 → 解析 `[TOOL_CALL]` 标记 → 还原成真 `tool_calls`），**实测可用**。

三条它会替你守住、值得知道的纪律：**每个请求都会建会话并在用完后删掉**（边车里的会话落在你账号下，
不删就会无限堆积）；**每次请求都把 `messages` 拍平成一段文本再发**（边车不保留多轮记忆，
"复用会话省一次建会话"看起来聪明，实际会把上下文丢掉）；**边车回 200 但正文是空的算失败**，
不会被记成"成功"。
⚠️ 仍**不要**给这个渠道配 `proxy`——边车是本地上游，不是出公网。

## 安全体检（只读脚本）

`node sec-audit.js` 对任意部署跑一遍只读体检，**报告里绝不回显密钥**：

```powershell
node sec-audit.js                                  # 体检本机 127.0.0.1:8787
$env:ZZ_BASE='http://1.2.3.4:8787'; node sec-audit.js   # 体检远端（不带密钥时只查匿名面）
$env:ZZ_TRY_DEFAULTS='1'; node sec-audit.js             # 额外试一下仓库里公开的示例默认密钥（判断有没有沿用默认）
# 密钥从哪来（不打印值）：
$e = docker inspect zzcsapi --format '{{range .Config.Env}}{{println .}}{{end}}'
$env:ADMIN_KEY  = ($e | Select-String '^ADMIN_KEY='   | Select -First 1).Line -replace '^ADMIN_KEY=',''
$env:GATEWAY_KEY= ($e | Select-String '^GATEWAY_KEY=' | Select -First 1).Line -replace '^GATEWAY_KEY=',''
node sec-audit.js
```

查这些：① 哪些口匿名可达（应只有 `/healthz`、`/console`）② 示例默认密钥是否仍可用 ③ 控制台版本指纹 ④ 安全响应头 / CORS
⑤ 三态鉴权覆盖面 ⑥ 密钥泄露面 ⑦ 路径穿越与私有文件暴露。

整改现状：渗透测试发现**全部有归宿**——六批已修（v1.18.3–v1.18.10，含 V-07 Host/Origin 门与 V-08 探针精简）、其余逐项处置台账在案（V-09/V-11 风险接受的理由、V-05 compose 内成文注释、刻意不做的两条）——完整过程、复查记录与每批的守卫测试见 [安全整改记录](docs/security-hardening.md)。**给公网部署者**：请在可信网络或反代后暴露，公网入口务必加 TLS，反代/公网域名记得登记 `ZZCSAPI_ALLOWED_HOSTS`（否则 421）；仓库已备好反代采信层（[方式三](#方式三反代采信模式想让来源统计看到每台机器真实-ip)：`deploy/nginx-reverse-proxy.conf` + `ZZCSAPI_PUBLISH` 开关 + 固定子网），在它之上加 TLS 证书即可。

## 行为细节（摘要）

- **上游 4xx 不短路**：`401/402/403/404/408/429` 属渠道侧问题一律切下家兜底；其余 4xx 只在**没有能上场的候选时**原样透传（透传的是最后一家上游的错误体，不是网关伪造的 502）
- **流式失败不换渠道**：已向客户端写过 200 + chunk 后上游断开，不换（避免半截回复）
- **协议转换**：三边走内部 OpenAI 中转，出站按渠道 `protocol` 走原生格式；有损点（`tool_choice:"none"`、`cache_control`/`top_k`/thinking 签名跨格式丢弃）仅跨协议时存在，同协议直通零转换
- **思维链边界**：跨协议双向不带 thinking 块；想要思维链走同协议 Anthropic 渠道（直通，签名原样活着）——thinking 回放（v1.18.8）只补同协议直通上弄丢的 `signature`
- **工具调用**：三条客户端路由四个往返方向全支持（Gemini 按函数名配对、无状态客户端退文本不硬造 id）
- **密钥轮换（v1.18.5）**：`config.auth` > 环境变量 > 首启生成；控制台轮换立即生效、旧密钥立即失效、换管理密钥清空全部会话
- **管理面会话（v1.18.6）**：登录门交一次密钥换 `HttpOnly` 会话 cookie（12 小时、上限 256 条、重启全部掉线）；管理面**不接受 `?key=`**（客户端面保留，Gemini SDK 另一鉴权模式）
- **鉴权写法**：网关密钥认 `Bearer` / `?key=` / 原生 SDK 默认头（`x-api-key` / `x-goog-api-key`）；管理面只认 Bearer 或会话 cookie
- **别名**：区分大小写不敏感，upstream 透传原样
- **冷启动**：第一次请求时 `status=unknown` 仍会被选中（探测在后台进行）

4xx 兜底判据全文、流式收尾、图片统一转换、出站与流式写路径实测数字（+13.9ms → +0.93ms 等）：[行为细节](docs/behavior.md)。

## 计划中

- ~~**自动权重「生效版」**~~ —— **已落地（v1.18.63）**：`autoWeight.enabled: true` 真的把健康系数乘进权重、真的改分流；关掉逐字节回旧行为。当初列的三个问题在实现时都定下来了（手工权重与自动系数**相乘**、四条护栏不变、份额变化进 `/admin/api/status` 的观测字段）。详见 [调度详解](docs/scheduling.md)「自动权重」。
- **容器内非 root 用户（`USER node`）——评估过，不做。** 不是"忘了"，是**净值不划算**：在 `read_only` + `cap_drop: ALL` + `no-new-privileges` 之后，容器里的 root 已经被削到只剩"uid 是 0"这个数字（不能 bind 低端口、不能 mount、不能改内核参数、不能写 `/app`），而可写面本来就只有 `./data` / `./dump` / `/tmp`；更要紧的是 `config.json` 是 `600 root:root`，改成 uid 1000 之后**进程连读都读不到**，症状是"起不来"或**静默回落到 `config.example.json`**（那等于把你的渠道配置换成示例）。所以它换来的是启动故障，不是安全增益。评估过程与实测数字见 [安全整改记录](docs/security-hardening.md)「容器加固：只读根文件系统 + 全丢 capability（v1.18.87）」末尾那段「刻意没做的」。
- **精确匹配响应缓存——评估过，不做（有实测数据）。** 判据是"同一发报文会不会反复打"，所以直接量了自己的日志：`usage.recent` 最近 800 条（8.7 小时）里**成功的 388 条按 `模型+入token+出token` 分组是 388 组，零重复**；`dump/` 里 30 份完整请求体**逐字节零重复**，而且这 30 份**全是 `stream:true` 且带 `tools`**——恰好是缓存"做不了（流式只能录放）"和"必须硬拒（工具轮回放会让 agent 跳过真实执行）"的两个集合。⇒ 在这台机器的真实流量上命中率是 **0%**，做了只白占内存。**什么时候值得回头做**：如果你开始反复跑同一批固定 prompt（渠道轮测、回归夹具），先跑一遍同样的统计，重复率上去了再说。
