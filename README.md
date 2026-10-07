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
- 🔤 **字体自托管（v1.18.37）**：全站用**寒蝉全圆体**（ChillRoundF，SIL OFL 1.1）的子集化**改名**版 `HCRound`，266 个 woff2 分片按 `unicode-range` 从**同源** `/console/fonts/**` 按需加载——不向任何第三方域名发请求（[字体与授权记录](docs/fonts.md)）
- 📊 **统一模型清单**：`/v1/models`、`/anthropic/v1/models` 自动合并各协议所有可用模型
- 🧩 **OpenAI Responses API（v1.18.38）**：`/v1/responses`（POST，含流式）+ `/v1/responses/{id}`（GET 取回 / DELETE）——入站按 Responses 报文收，出站转回 `response` 对象与 Responses 的 SSE 事件序列，中间复用同一条候选链与全部兜底（[协议详解](docs/protocols.md)）
- 🩺 **手动测试的流式模式 + 真实流量单独一条欠账（v1.18.40）**：控制台「测试模型」默认按**流式**打（真实客户端走的就是流式，只测非流式等于只测了一半，`stream:true` 可选）；且**只有真实客户端请求成功才算"这家对话能用"**——手动测试与 `/models` 探测成功只放开冷却、还清探测侧的账，**不再清零真实流量的连败计数**，熔断因此真的会跳开"测试过、真实挂"的死家（[调度详解](docs/scheduling.md)）
- 📎 **notion 渠道的内联附件（v1.18.41，渠道级 `notionAttachments`，默认关）**：客户端发 OpenAI `{type:"file",file:{filename,file_data:"data:…;base64,…"}}`（或 Anthropic `document` 块）时，网关把文件**内联进提示词**并打开 `enableCsvAttachmentSupport`——这是参照实现 notion2api 实发报文的形状，**CSV 不上 S3、不建任务**（[机制与诚实边界](docs/notion-attachment-upload-research.md)）。✅ **「模型真读到了」已活体验证（v1.18.42）**：对照那一发模型答"没找到你上传的 CSV"，带附件那一发答出**只存在于 CSV 里**的串，并经本地容器网关 `/v1/chat/completions` 复验（见研究文档 §8）
- 🪪 **渠道级「自定义请求头」（v1.18.44）**：有些上游不只看密钥、还**看客户端指纹**——`agentrouter` 实测只带 `Authorization` 一律 **401 `unauthorized client detected`**，带上 `User-Agent: claude-cli/2.0.0 (external, cli)` 才 **200**（**浏览器 UA 一样被拒**：它认的是 Claude CLI 指纹本身）。现在渠道编辑弹窗的「自定义请求头」可填（每行一条 `Name: value`，`Authorization` 不可覆盖），探测/测试/聊天都带上它。**这轮的真凶其实是我们自己**：那个输入框此前**从不回填**，于是「获取模型」发出去的探测不带该 UA、必吃 401；而保存渠道还会**静默删掉**已配的值（[协议详解](docs/protocols.md)）
- 🚦 **notion 出站通道链（v1.18.42，根因于 v1.18.43 修正为两个维度）**：Notion 推理接口会回一道软墙（HTTP 200 + `temporarily-unavailable`，反爬式静默拒绝）。**软墙有两个独立维度**：① **账号状态**（主导，与传输无关、随时间变——`notion7` 在本地与云端、五种传输一起软墙，且在云端曾有短暂开口）；② **客户端指纹**（只在账号可过时才看得见——同一秒交替打：curl 3/3 真答、fetch 0/3 软墙）。出站因此做成 **curl 主 → HTTP/2 兜底 → fetch 最后**，且**软墙会在通道内自动换**（墙内那一发不消耗真实推理）；**这一修法治 ②，治不了 ①**（那时网关如实报 `ok:false / notion: temporarily-unavailable`，不伪装成"200 空回复"）。这是 ③ 的活体判据之所以能取得的前提（[协议详解](docs/protocols.md) §notion 出站通道链 · 复现仪器 `notion-wall-probe.js`）

## 快速开始

### 方式一：Docker（推荐）

```powershell
# usage.json 是运行时持久化文件，不入仓库，首次部署先由模板生成
Copy-Item usage.example.json usage.json
docker compose up -d --build
# 控制台 http://127.0.0.1:8787/console
# 首次启动的 ADMIN_KEY / GATEWAY_KEY 打印在容器日志里：docker logs zzcsapi | grep ADMIN_KEY
# 想固定自己的密钥：根目录建 .env 写 ZZCSAPI_ADMIN_KEY=... / ZZCSAPI_GATEWAY_KEY=...
```

> ⚠️ **改完代码要确认容器真的换了镜像**（v1.18.1 现场踩到过）：`up -d --build` 有时只构建不重建（输出是 `Running` 而不是 `Recreated`），刷新看到的还是旧代码。
> 判断：`docker inspect zzcsapi --format '{{.Image}}'` 与 `docker images zzcsapi:local --format '{{.ID}}'` 不一致就补 `docker compose up -d --force-recreate`。`/console` 带 `no-store`，不需要强刷浏览器。
> ⚠️ `config.json` / `usage.json` **必须先在宿主机存在**，否则 Docker 会把挂载点建成目录（服务不崩，但用量统计每次重启归零）。
> ⚠️ **`Dockerfile` 的 `COPY` 是显式白名单**（v1.18.48 现场踩到过）：新增任何被 `server.js` `require` 的文件（如 v1.18.47 的 `hark.js`）都必须同时加一条 `COPY`，漏了**本机 `node server.js` 一切正常**，但容器会**启动即 crash-loop**（`Cannot find module '/app/xxx.js'`、healthz 连不上，症状离原因很远）。`node test/docker-image-files.test.js` 守这条；改完照旧要 `docker compose build && up -d` 并确认 `docker ps` 里是 `Up (healthy)`。
> 端口映射 `8787:8787`（局域网可访问）；手工 `docker run` 别忘 `ZZCSAPI_BIND=0.0.0.0`、`TZ=Asia/Shanghai`、`ZZCSAPI_CONFIG=/app/config.json`（compose 已写死，不会踩到）。
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

# 4) config.json 准备好渠道（本地挑好再传上去，此文件不入仓库）+ usage.json 空档起步
touch usage.json && docker compose up -d --build
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

可选环境变量：

```bash
GATEWAY_KEY=xxx  node server.js    # 客户端必须带 Bearer xxx
ADMIN_KEY=yyy    node server.js    # 控制台 + /admin/* 必须带 Bearer yyy
ZZCSAPI_NOAUTH=1 node server.js    # 本地开发：完全关闭鉴权（仅限本机自用）
ZZCSAPI_BIND=0.0.0.0 node server.js  # 绑定地址，缺省 127.0.0.1（裸跑时对外提供服务的必填项）
ZZCSAPI_ALLOWED_HOSTS=a.com,b.com node server.js  # Host 门白名单域名（逗号分隔）。默认放行 localhost 与回环/私网 IP 字面量；反代/公网域名必须在此登记，否则 421（v1.18.10 渗透整改 V-07：拦 DNS 重绑定）
ZZCSAPI_DUMP_BODIES=/app/dump node server.js  # 【排查用，默认关】把客户端会话类请求体原样落盘到该目录，用于留证"上游异常"的真实请求形态（v1.18.27）
ZZCSAPI_DUMP_MAX=30 node server.js            # 落盘最多保留几个（默认 30，钳到 1–500）
```

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
> 带图请求只走 `openai` 协议渠道（[含图请求的候选裁剪](docs/scheduling.md)）。

## Web 控制台

```
http://127.0.0.1:8787/console
```

首次打开有一个「输入管理密钥」的小门——验证通过后换回**会话 cookie**（`HttpOnly` + `SameSite=Strict`，12 小时），
密钥本身**不落浏览器**；管理 API 每次调用仍强制鉴权（"页面能开 ≠ 有权限"），会话失效时自动重新弹门（详见 [行为细节 · 管理面会话](docs/behavior.md)）。

可做：实时看每个渠道的健康/延迟/错误/探测时间、改 priority、启停渠道、触发单渠道或全量重新探测、看各协议聚合模型清单、
**测试停用渠道里的模型**（停用只是"不参与调度与自动探测"，不代表不能手动打一发验证）、测试结果每行写明**测的哪个模型 + 通过/空回复/失败 + 延迟与 token + 回复或错误原文**。

> 自动 vs 手动的边界：自动探测（启动时 + `health.intervalSec`）**只探启用渠道**；手动（「测试」/「重探测」/ `/admin/api/test` / `/admin/api/recheck`）不受此限，连停用渠道一起探。

## 文档

> ⚠️ **强制约定：改代码必须同步改文档**（无论改动来自谁）。完整规则见 [`AGENTS.md`](AGENTS.md)。

| 文档 | 用途 |
| --- | --- |
| [协议与渠道详解](docs/protocols.md) | 协议速查表之外的**全量细节**：原生出站与同协议直通、三条客户端路由的工具调用方向、notion-agent / workbuddy / genspark / codex / hark 配置要点、`proxy` 字段、图片转换 |
| [调度详解](docs/scheduling.md) | 调度顺序全量语义：同渠道重试、熔断冷却分级、加权轮询、自动权重（观测版）、有效优先级、含图请求的候选裁剪 |
| [运行期设置（四组开关）](docs/runtime-settings.md) | 会话粘性 / 客户端限流 / `/metrics` / thinking 回放的语义与 `GET/POST /admin/api/settings` 用法 |
| [行为细节](docs/behavior.md) | 4xx 兜底判据、流式失败、协议转换有损点、thinking 边界与回放、工具调用映射、密钥轮换、管理面会话、鉴权写法、v1.16 出站与流式写路径实测 |
| [测试清单](docs/tests.md) | 52 个测试文件 · 2487 项断言：每条守的是什么、「改什么 → 必跑什么」速查、测试哲学 |
| [安全整改记录](docs/security-hardening.md) | 渗透测试六批整改（v1.18.3–v1.18.10）逐批内容与守卫测试、11 项发现全量处置台账、复查记录 |
| [前端代码地图](docs/frontend-code-map.md) | **快速定位**：行号锚点表、构建管线与行号换算、CSS/z-index 全景、JS 函数索引、数据契约、修改路由表、坑位清单 |
| [控制台前端详细设计](docs/frontend-console-detailed.md) | **理解与扩展**：设计系统（主题变量/字体/配色取向）、布局骨架、组件规范、页面与交互流程、变更日志 |
| [字体与授权记录](docs/fonts.md) | 全站 `HCRound` 的**来龙去脉**：OFL-1.1 逐条依据、**为什么必须改名**（子集化＝修改版，不得沿用保留字体名）、改了哪些 `name` 字段、交付形态与缓存分层、字重映射逐处理由、可复现的再生成步骤与两个踩坑 |
| [控制台「运行期设置」页实现规格](docs/console-settings-spec.md) | 设置页的施工图：字段契约、四张卡结构、必须守住的交互细节、验收清单 |
| [thinking 回放缓存设计与实现记录](docs/thinking-replay-design.md) | 三次决策完整过程、跨协议 thinking/签名保真度地图、as-built 边界与验收映射 |
| [Ponytail 全项目审查](docs/PONYTAIL_REVIEW.md) | 动代码前过目：整改项 PT 清单（file:line 证据 + 最小修复）、已验证的非问题（别重查） |
| [同类网关内部机制对比](docs/gateway-comparison.md) | 本项目 vs new-api / one-api / sub2api / CLIProxyAPI / **notion2api** 的内部机制/性能/全面性对照（只比机制，不比多用户），含实测数字与各家源码级证据；**§1.5 = 与 notion2api 七项差异的强弱结论**（附件/CSV 那一格 v1.18.42 起**已追平**，另加一条"教训型差异"：同一个软墙我们误判过三次，它的实现里根本没有这道坎） |
| [Genspark Claw 反代研究](docs/genspark-claw-reverse-proxy-research.md) | 逆向过程留档 |
| [hark.com 网页会话反代研究](docs/hark-reverse-proxy-research.md) | **已接入**（`protocol: "hark"`）：为什么不能当 openai 渠道填 base_url（`/v1/*` 回的是 SPA 壳）、**本机 403 的真因是 Node/curl 不读系统代理而不是 IP 声誉**（同一台机器 PowerShell 走代理 200）、回复整段下发（伪流式）、**上游工具全在服务端**（流里零 `tool_add`，客户端工具只能文本仿真）、**每轮约 11.5 万 harkTokens → 免费日额度只够约 69 轮**、系统路径护栏、复现命令 |
| [PromptQL（prompt.ql.app）反代研究](docs/promptql-reverse-proxy-research.md) | 结论：不建议接（多人协作 bot 工作台、按 OLU 计量付费，不是可蹭的模型额度；控制面 `auth.pro.ql.app` 本机被 DNS 污染） |
| [Arena 协议](docs/arena-protocol.md) / [Prism 反代研究](docs/prism-reverse-proxy-research.md) | 已撤渠道留档 |
| [notion 附件上传研究](docs/notion-attachment-upload-research.md) | **机制查明 + 活体验证 + 软墙根因**：**★ 最有价值的是抓法**——notion2api 的 `upstream.base_url` 可配，指向记录代理就抓到它发给 Notion 的原始报文（含三个必踩的坑：`origin`/`referer` 由 base_url 推出来、账号要按完整 probe JSON 导入、失败会把账号打成 `error`）。据此查明：CSV **不上 S3**，而是 `enableCsvAttachmentSupport:true` + 把 `{"file":{"file_data":"data:…","filename":"…"},"type":"file"}` 内联进 user step 正文（已按此实现为 opt-in 渠道字段，字节逐字对齐，见 `test/notion-attachment-inline-e2e.test.js`）；另白捡到 `getInferenceTranscriptsForUser` 的正确形状。**✅「模型真读到了」v1.18.42 已活体验证**（§8：对照答"没找到文件"、带附件答出只存在于 CSV 里的 `K7Q2M9`）——仍默认关，但那是**稳妥默认**不是"没验证过"。**§7/§7.7 = 软墙的两个维度**（账号状态主导、与传输无关且随时间变；客户端指纹只在账号可过时才看得见——同一秒交替打 curl 3/3 真答、fetch 0/3 软墙）；**§5/§6 是被推翻的旧结论、§7.4 是三次误判的留档，别重犯**。含上传链留档（取目标 → S3 桶根 204 → 公开 URL）、**软墙 ≠ 形状错的判别纪律**、判决实验与复现命令 |
| [AI 工具调用桥接](docs/AI工具调用桥接-群友分享版.md) | 群友分享版说明 |

### 前端构建管线（一句话版）

生产控制台 `console.html` **不是手写的，是构建产物**：`node build/build.js` 组装
`console-redesign.html`（视觉唯一真源）+ `build/` 下的 head / shell / extra.css / app.js，
**不要手改产物**（下次构建会被覆盖）。管线图、文件角色表、行号换算见 [前端代码地图 §0](docs/frontend-code-map.md)。
改完 `console-redesign.html` / `build/*` 后**必须重新构建**，并按 [AGENTS.md](AGENTS.md) §1.2 重核行号锚点。

### 测试（一句话版）

**51 个文件 · 2430 项断言，全部零依赖**（e2e 真起「假上游 + 临时网关」，动态端口 + 临时目录，不碰仓库运行文件，不出网）。
全量清单、每条守的是什么、改什么必跑什么：[测试清单](docs/tests.md)。新增测试时登记进该文档与 `AGENTS.md` §3。

## 配置示例 (`config.example.json`)

```jsonc
{
  "port": 8787,
  "health": { "intervalSec": 300, "timeoutMs": 8000 },
  "retries": { "perChannel": 1, "maxModelFallbacks": 99 },   // perChannel = 同一家失败后原地再试几次
                                                              //   （只对 5xx/超时/网络错误；0/缺省 = 不重试，上限 5）
  "channels": [
    {
      "id": "vendor-a-openai",
      "name": "中转A (OpenAI)",
      "baseUrl": "https://api.example-a.com/v1",
      "apiKey": "sk-xxx",
      "protocol": "openai",                  // openai | anthropic | gemini
      "priority": 10,                        // 顺序：谁先试、谁兜底
      "weight": 3,                           // 分流：同模型候选里按比例轮询（不填/0 = 不参与，见「调度详解」）
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
> 调度旋钮（`cooldown` / `retries` / `autoWeight`）与运行期四组开关（`sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay`）
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
| `workbuddy` | 自检 `chat/completions` | `Authorization: Bearer ...` | WorkBuddy 逆向（必须走 curl 子进程；token 是 JWT，新版已加密） |
| `codex` | 一次令牌刷新 | `Bearer <AT>` + `account_id` | ChatGPT/Codex 订阅反代（AT 约 10 天有效） |
| `genspark` | `GET /api/is_login` | `Cookie: session_id=...` | Genspark 网页会话反代（**必须配代理**；工具调用靠文本仿真） |
| `hark` | `GET /api/auth/get-session` | `Cookie: __Secure-hark.session_token=...` | hark.com 网页会话反代（**本机必须配代理**，云端直连；建会话 + REST 发消息 + SSE 收 patch；伪流式、工具靠文本仿真） |

`arena` 协议已撤（[留档](docs/arena-protocol.md)）。

**客户端说哪套协议、渠道讲哪套协议，互不绑定**：任一客户端路由都能打到任一协议的渠道（出站自动转原生格式）；
**同协议的那格直通不翻译**（v1.15——`thinking` / `cache_control` / `seed` 等原样到达，响应逐字节一致；v1.18.8 起还带
thinking 回放修复）。六条**专用报文**渠道（`notion` / `notion-agent` / `workbuddy` / `genspark` / `codex` / `hark`）的响应输出也走各客户端面的
收口钩子（v1.18.38 修正：此前它们自己写 OpenAI 报文，Responses / Anthropic / Gemini 面会拿到错形态）；
**候选链分层**——Anthropic / Gemini 两条链只兜底到 `notion` / `notion-agent` / `codex`，`workbuddy` / `genspark` / `hark` 只挂在 OpenAI 类链上。
`notion` 渠道另有**流断取回兜底**（v1.18.39：上游流断/带错误/零内容时，用同一 `threadId` 把同一份 transcript 再发一次取回成品答案；
触发判据只看"权威全文到没到"，正常请求零额外延迟与额度，取不回仍如实判失败）。
矩阵表、工具调用四方向、各渠道配置要点、有损点诚实清单：[协议与渠道详解](docs/protocols.md)。

## 调度顺序（摘要）

1. 按请求的 `model` 在所有 `enabled` 且协议匹配的渠道里查 alias——**同协议优先，跨协议兜底**（现有 `openai` 渠道先后顺序不受影响），最后才是 notion → notion-agent → workbuddy → genspark → hark → codex 文本链
2. 候选 = 命中的渠道 ∪ 探测结果里识别到该模型的渠道（有效优先级 -0.5）
3. 排序：冷却中 → 末位；`down` → 倒数第二；`probation`（半愈合观察期）→ 健康渠道之后；同状态按**有效优先级**降序，再看 latency
4. **加权轮询**（填了 `weight` 的渠道按比例决定谁排第一）；**会话粘性**（开着时）把这条会话上次成功的那家提到第一位
5. **含图请求**先按图片能力门裁剪候选；纯文本不受影响
6. 依次尝试直到成功；全部失败返回 502 + 错误详情。**同渠道重试**（`retries.perChannel`）只对 5xx/网络/超时原地再试，4xx 一律不重试；**上游报文里明说 `isRetryable:false` 时也跳过重试**（目前只有 notion 会这么说，见 [调度详解](docs/scheduling.md)「上游否决」）

```
有效优先级 effPriority = priority − 失败率 × 3      // 失败率取滚动窗口 ch.roll（样本 ≥5 生效，120 次后减半衰减）
```

重试/冷却/权重/自动权重/图片门的全量语义与调参：[调度详解](docs/scheduling.md)。

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
| `/admin/api/channels` | POST | admin | 新增 / 覆盖渠道（upsert，落库并立即探测一次）；**`apiKey` 留空 = 保持原密钥**；`dropParams` 显式空数组 = 清空、不传 = 沿用旧值（v1.18.33）；`headers` 同款语义（显式值含 `""` 优先、`""` 清空、不传 = 沿用旧值，v1.18.44） |
| `/admin/api/channels` | DELETE | admin | 删除渠道（body `{id}`） |
| `/admin/api/probe` | POST | admin | 临时探测上游模型清单（不落库） |
| `/admin/api/test` | POST | admin | 真发一次最小 chat 请求；带 `channelId` 时**只打该渠道且不看 `enabled`**；**`stream:true`（v1.18.40）= 按真实客户端姿势发流式请求**并按真实链路同一套判据（`classifyStreamFrame`）判定（流内 error 帧 / 200 零正文流 / 上游无视 `stream` 回整段 JSON 都算失败），结果回带 `stream`、`streamFrames`、`streamIgnored`、`ttfbMs`；**测试成功只"半愈合"**（放开冷却 + 清 `probeFail`），**不清真实流量的连败计数**（见[调度详解](docs/scheduling.md)） |
| `/admin/api/codex-import` | POST | admin | 导入 codex 凭据（完整 JSON 或裸 RT） |
| `/admin/api/codex-quota` | GET | admin | 查询 codex 配额（5h/7d 窗口、计划类型、重置时间） |
| `/admin/api/genspark-import` | POST | admin | 导入 genspark 网页会话（提取 sessionId → 换 key 并免费验证登录） |
| `/admin/api/config` | GET | admin | 接入信息（URL / 端口 + 密钥**掩码** + `keysInsecure`；不交任何密钥原文）+ `dropParamWhitelist`（渠道 `dropParams` 的合法参数名，控制台照用） |
| `/admin/api/channels/{id}/key` | GET | admin | **按需揭示**：取单个渠道的上游密钥原文 |
| `/admin/api/gateway-key` | GET | admin | **按需揭示**：取网关 `GATEWAY_KEY` 原文 |
| `/admin/api/admin-key` | GET | admin | **按需揭示**：取管理 `ADMIN_KEY` 原文 |
| `/admin/api/keys` | GET | admin | 密钥管理：两把密钥的**掩码 + 来源** + `keysInsecure` + `rotatedAt`，绝不含明文 |
| `/admin/api/keys` | POST | admin | **控制台轮换密钥**：body `{gatewayKey?, adminKey?}`，立即生效并落库（优先级高于环境变量），旧密钥立即失效 |
| `/admin/api/keys/generate` | POST | admin | 随机生成新密钥（48 位，四样字符齐全）：body `{target: "gateway"\|"admin"\|"both"}` |
| `/admin/api/keys/reset` | POST | admin | 删掉 `config.json` 的 `auth` 段，回到「环境变量 → 首启生成」取值链 |
| `/admin/api/session` | POST | 匿名（登录门） | 交一次 `ADMIN_KEY` 换回 `HttpOnly` 会话 cookie（12 小时）；登录失败计入 admin 失败限流 |
| `/admin/api/session` | DELETE | 会话 cookie | 退出登录：只杀自己那枚 token + 过期 cookie；其余方法 405 |
| `/admin/api/settings` | GET/POST | admin | **运行期设置**：读写 `sessionAffinity` / `rateLimit` / `metrics` / `thinkingReplay` 四组（PATCH 语义，立即生效 + 落库，未知字段 400 点名）——语义见 [运行期设置](docs/runtime-settings.md) |
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

- **自动权重「生效版」**：v1.6 只做到观测（算得出来、看得见，但一行不碰真实分流）。下一步才是把健康系数折进候选份额真正生效——需要同时解决「自动份额与手填权重并存谁优先」「护栏（地板/上限）被反复触碰时如何告警」「份额变化要不要写日志」三个问题。**当前刻意再等等：线上观测时间还不够长**。
