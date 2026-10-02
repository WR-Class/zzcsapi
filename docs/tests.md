# 测试清单（34 个文件 · 1700 项断言，零依赖）

> 本文从 README 拆出（v1.18.8）：README 只留摘要与「改什么必跑什么」，本文收全部 34 条命令与每条守的是什么。
> 全部测试**零依赖**（只用 Node 内置模块）；e2e 用例**真起进程**（假上游 + 临时网关），
> **动态空闲端口；配置/用量在系统临时目录，绝不动仓库 `config.json` / `usage.json`**，不出网、不烧额度。
> 退出码非 0 = 有回归。跑单个：`node test/<名字>.test.js`。

## 改什么 → 必跑什么（速查）

| 你改了 | 必跑 |
| --- | --- |
| 渲染 / 交互 / `build/app.js` | `console-state` + `security-headers-e2e` |
| 协议转换（入站 / 出站 / 流式） | 对应协议的 `*-tools` / `native-channels` / `streaming-e2e` / `same-protocol-passthrough` |
| 调度 / 候选链 / 重试 / 冷却 / 权重 | `weighted-rr*` / `auto-weight*` / `per-channel-retry-e2e` / `cooldown-grading-e2e` / `upstream-4xx-fallback-e2e` / `session-affinity-e2e` |
| 运行期四组开关（粘性 / 限流 / metrics / 回放） | `settings-api-e2e` + 对应开关的 e2e |
| 密钥 / 鉴权 / 会话 / 响应头 | `security-headers-e2e` + `key-rotation-e2e` + `admin-session-e2e` |
| 来源 IP 统计 / 封禁 / trustedProxy 采信 / 客户端标签列 | `ip-stats-ban-e2e` + `console-state`（统计页渲染与日志跳转链路一节） |
| 部署配置（docker-compose / 反代层 / 来源 IP 采信开关） | `reverse-proxy-config` + `ip-stats-ban-e2e`（trustedProxy 采信语义） |
| thinking / 签名 / 回放 | `thinking-fidelity` + `thinking-replay-e2e` |
| 静态文件 / 鉴权面 / 控制台版本 | `node sec-audit.js`（仓库根，只读体检，见 README「安全体检」） |

## 全量清单

```bash
node test/console-state.test.js           # 225 项断言，退出码非 0 = 有回归（含渠道表单权重：能填 → 能存 → 能显示；自动权重观测页渲染；停用渠道的手动测试弹窗；测试结果行：模型名 + 通过/空回复/失败三档；调用日志渠道列：显示渠道名不显示 id、紧跟请求 ID、按名字/按 id 都能搜，**客户端标签列（v1.18.11，v1.18.13 跳转直开抽屉 + 索引错位回归）**；运行期设置页：草稿跨轮询保留、**四张卡（v1.18.8 增 thinking 回放）**、POST 只发改动组、400 原文直显；密钥管理页：掩码可见、草稿跨轮询、轮换、**会话语义（密钥不落任何浏览器存储）**；**事件委托：真实委托块在桩上真跑分发——dataset 参数到达动作函数、嵌套只触发最近那枚、未知动作不炸、change 走同一条路、ACTS 双向覆盖（46 个函数名硬编码）**；**数据统计页（v1.18.11）：stats=null / 刚清零不抛且有空态、满数据画 per-IP 表与 sparkline、客户端过滤（日志跳转那条路）、UA 标签 esc()、封禁/解封按钮 data-act+data-t、详情抽屉；v1.18.12 增布局守卫：KPI 四卡 `.st-kpi*` 居中、来源明细表 `.st-fixed`+9 列 colgroup、表头与数值 `t-c` 居中（旧 `t-r` 清零）、占位符「—」走 `.t-c-ph` 而真名左对齐、产物 CSS 存在性 + 旧写法对照组；v1.18.13 增跳转链路：真跑 `drawLogTable` 的客户端 chip 绑定——chip 自带 `data-cl`、点击跳统计页并直接弹开最活跃来源的详情抽屉、无标签行在前时"旧写法按 rows[i] 取标签"的索引错位回归、无匹配标签不误弹、stopPropagation 不连坐行点击**；**v1.18.17 错误显示与登录门**：errMsgOf 真值表（网关错误体 {error:{message,type}} 直接拼 j.error 会显示 [object Object]——对象取 message、字符串透传、j.message 兜底）+ api()/登录门两处装配守卫与旧裸拼全仓清零 + 登录门提交前 trim（终端 cat 复制带尾随换行/空格不再 401）；**v1.18.19「从上游探测」钥匙 trim**：probeUpstream 读钥匙框 `.trim()` 与保存路径对齐——粘贴尾巴的换行没 trim 时把脏钥匙发上游吃 401 Invalid token（库里存的原文其实一直是好的，服务器侧原文直发 302 个模型验证））
node test/reverse-proxy-config.test.js  # 37 项断言：反代采信层配置守卫——本机层（XFF 必须**覆写**不可追加、转发口只绑宿主回环 127.0.0.1:18787、server_tokens off 不报版本号（复测 N-01）、固定子网与 README 写的 trustedProxy 逐字一致、默认直连模式走 ${ZZCSAPI_PUBLISH:-8787:8787} 不被写死、自启脚本幂等且纯 ASCII、README 开/关/坑齐）+ 公网层 v1.18.16（nginx-public.conf：XFF 覆写同源、只反代回环转发口、server_tokens off、**HSTS/COOP/CORP 三头（N-03 TLS 里程碑落地）**、TLS 只开 1.2/1.3、80 只留 ACME webroot+301 / 业务只在 443、Let's Encrypt 标准证书路径、README 公网四件套：域名进 ZZCSAPI_ALLOWED_HOSTS、公网必须换新密钥、certbot 续期、防火墙收口；另守 compose 真透传 ZZCSAPI_ALLOWED_HOSTS——注释行透传 = 公网域名一律 421；v1.18.17 增 README 方式四 .env 钥匙名必须带 ZZCSAPI_ 前缀——裸 ADMIN_KEY= 被 compose 映射漏掉，静默回落首启生成，.env 钥匙两头都不生效；v1.18.18 增 CF 橙云姿势——nginx realip 只对 CF 网段（≥22 条 set_real_ip_from）采信 CF-Connecting-IP 恢复真实访客 IP、XFF 覆写纪律一字不动、**网关侧（server.js）绝不读该头**、README 必须写全 Full (strict) 防重定向循环/源站锁定/切回灰云放行/100 秒超时告警）；改 docker-compose.yml / deploy/* 或部署方式后必跑
node test/gemini-multimodal.test.js       # 41 项断言：图片转换 / 候选裁剪 / 原生 SDK 鉴权头（单元级）
node test/gemini-multimodal-e2e.test.js   # 22 项断言：真起「假上游 + 临时网关」，走完整 HTTP 链路（约 5 秒）
node test/anthropic-tools.test.js         # 60 项断言：Anthropic tool_use ↔ OpenAI tool_calls（含工具结果带图、id 往返、有状态流式）
node test/anthropic-tools-e2e.test.js     # 30 项断言：两轮工具回合（要工具 → 回传结果）真 HTTP 链路
node test/streaming-e2e.test.js           # 19 项断言：三协议流式（首块不丢字节 / 事件序列 / 收尾兜底）
node test/weighted-rr.test.js             # 31 项断言：加权轮询算法（3:1→75/25、平滑性、老配置零影响对照）
node test/weighted-rr-e2e.test.js         # 12 项断言：真 HTTP 数落点，验证实际分流比例与降级行为
node test/native-channels.test.js         # 78 项断言：原生出站双向转换（请求/响应/流式状态机/URL 鉴权头/错误体不翻译）
node test/native-channels-e2e.test.js     # 33 项断言：原生假上游 × 三条客户端路由，验证上游真的收到原生报文
node test/console-weight-e2e.test.js      # 18 项断言：控制台表单报文 → 真网关落库 → 真流量分流 → 表格那一格显示出来
node test/auto-weight.test.js             # 66 项断言：自动权重算法（健康系数/地板/死区平滑/份额封顶）＋**静默不变式**（观测不许改分流）＋后台节拍装配守卫
node test/auto-weight-e2e.test.js         # 37 项断言：真流量下预测与健康系数自洽、分流一字未动、配置往返旋钮不丢、后台节拍不依赖控制台
node test/upstream-4xx-fallback-e2e.test.js  # 32 项断言：上游 4xx 不许短路兜底（404/400 都继续切、最后一家才透传、冷却位不算后手）
node test/per-channel-retry-e2e.test.js   # 34 项断言：同渠道重试（抖动被原地救回、4xx 绝不重试、0/缺省=不重试、上限钳到 5）
node test/cooldown-grading-e2e.test.js    # 53 项断言：熔断分级（瞬时/凭证/限流三条曲线 + Retry-After + 探测半愈合 + 观察期排序）
node test/gemini-tools.test.js            # 44 项断言：Gemini 客户端路由的工具转换（functionCall⇄tool_calls、id 配对与无状态退路、toolConfig 三态、流式分片攒整、仿真链兼容）
node test/gemini-tools-e2e.test.js        # 29 项断言：真起「假上游 + 临时网关」走 /gemini/... 两轮工具回合（含流式与三种 toolConfig）
node test/same-protocol-passthrough.test.js # 44 项断言：同协议直通（Anthropic/Gemini 客户端 → 同协议渠道不翻译；thinking/cache_control/seed 原样到达、响应逐字节一致、真实 token 仍记录、跨协议仍走转换、v1.18.8 修复只注入同协议直通且没坏不碰）
node test/workbuddy-quota.test.js      # 39 项断言：WorkBuddy 额度用尽要看得懂（trim 后再判 JSON、重置时刻→精确冷却、错误带 HTTP 码与响应开头、密文 token 提前拦、冷却跳过也带原因）
node test/genspark-tools.test.js          # 47 项断言：Genspark 网页会话反代的工具调用（system 折叠 + [TOOL_CALL] 仿真往返 + 真网关经假代理跑完整链路）
node test/disabled-channel-manual-test-e2e.test.js  # 26 项断言：停用渠道「能手动测、不被自动测」（自动探测 0 次 / 手动测试真打通 / 手动重探测照探）
node test/outbound-http-client.test.js    # 32 项断言：出站长连接客户端（fetch 形状真值表 + 20 次请求 0 条新连接、对照 agent:false 建 20 条）+ 直通流式逐字节一致（含 CRLF 与跨片帧）
node test/session-affinity-e2e.test.js    # 67 项断言：会话粘性（键推导真值表 + 过期/淘汰 + 冷却/down 不硬塞 + 同会话 8 次落同一家 + 上游挂了重新粘 + 关闭时零状态）
node test/rate-limit-e2e.test.js          # 50 项断言：客户端限流（令牌桶真值表 + 429 带 Retry-After + 按时间回填 + 并发闸门 + 管理面不受影响 + 关闭时零影响）
node test/metrics-e2e.test.js             # 45 项断言：/metrics（Prometheus 格式合法性 + 标签转义 + 计数随真流量动 + 密钥绝不出现在正文 + public/关闭两态 + thinking 回放 gauge 与六事件）
node test/thinking-fidelity.test.js        # 36 项断言：thinking/签名 保真度地图（跨协议双向都不产出 thinking 块 → 跨协议"无签名块触发 400"不可达；`signature` 只活在回放块与 4xx 作废分支；直通仍是唯一活路，回放只补上游真签过的）
node test/thinking-replay-e2e.test.js      # 64 项断言：thinking 回放缓存（v1.18.8，同协议直通签名修复）——复现失败（关=400）→ 开=补回原签名（逐字段）→ 跨会话/渠道/模型绝不回放（三组反向）→ 过期/淘汰/作废计数 → 流式分片攒对照样修 → 完好客户端一字不动 → 设置第四组/status/metrics 暴露
node test/settings-api-e2e.test.js        # 68 项断言：运行期设置端点（四组窄口白名单 + 钳制与启动路径共用同一份规则 + 改完不重启立即生效（真发请求看到 429/404）+ 落库并重启后仍在 + 400 点名字段）
node test/security-headers-e2e.test.js    # 70 项断言：安全加固（渲染层"裸插值"必须一个不剩 + toast/data-t 必须转义 + 安全响应头覆盖 401/404/静态壳/所有 API + 管理面与 /healthz 带 no-store + **/metrics 全态 no-store（外部复测 N-02：未鉴权 401 也不落中间层缓存）** + **/healthz 只回 {ok:true}（V-08：匿名面不带渠道数与密钥状态）** + 页面壳零密钥明文 + **CSP 逐字等于设计稿（v1.18.6）** + 管理面 ?key= 已停用 / 客户端面保留 + **内联事件属性必须为 0 且 ACTS 与模板双向一一对应（v1.18.7）** + **第六批（v1.18.10）Host/Origin 门：陌生域名与公网 IP → 421、白名单域名与回环/私网 IP 字面量 → 200、跨源 Origin 写请求 → 403（揣着正确密钥也拒）、同源/无 Origin 照常、装配位置必须在一切路由分支之前（V-07，含 ZZCSAPI_ALLOWED_HOSTS 注入）**）
node test/key-rotation-e2e.test.js         # 85 项断言：控制台轮换密钥（优先级链 config.auth>env>首启生成 + 旧密钥立即失效 + 非法值不落库 + 重启后仍生效 + 回到环境变量值）
node test/admin-session-e2e.test.js        # 63 项断言：管理面会话 cookie（v1.18.6）——登录门换 HttpOnly+SameSite=Strict 会话、会话单独鉴权管理面、Bearer 通道保留、管理面 ?key= 拆除 / 客户端面保留、退出只杀自己、轮换清全会话并补发新会话、重启全部掉线、逐出先清过期
node test/ip-stats-ban-e2e.test.js         # 62 项断言：来源 IP 态势与封禁（v1.18.11）——装配（闸门在 Host/Origin 门后、限流前，只拦客户端面；在飞归还挂限流同一条 settle；单漏斗；persistConfig 白名单含 security；XFF 只在 trustedProxy 上采信；4 路由注入 statsCtx）+ 纯函数真值表（IP 字面量校验 / 标签映射 / 采信与伪造 / 记账 / 24h 桶 / 峰值 / 会话饱和 / 淘汰）+ 真链路（预置封禁 403、XFF 三来源各行、401 算敲门、token/模型/标签/会话记成功路径、并行峰值 ≥2 且归零、封禁端点全语义 400/404/幂等、封禁落 config 且渠道不丢、重启统计清零封禁仍在）+ 对照（无 trustedProxy 时伪造 XFF 不采信）
```

## 测试哲学（为什么这么写）

`console-state` 守住的是**「视口内输入控件的值必须跨重绘保留」**这条约定：控制台每 8 秒轮询一次，
`render()` 会重建当前页整个 DOM，输入控件的值只存在 DOM 里就会被重建为空
（表现：搜索词/草稿"一会儿自己没了"，PT22 / detailed §8.11）。
做法是从 `build/app.js` 现抠真实的渲染函数源码，在最小 DOM 桩里跑「输入 → 再渲染」并断言值仍在；
**新增带输入框的页面时请顺手补一条用例**（改名 `vModels` 等函数会让它报错，这是刻意的提醒）。

`gemini-multimodal` 守的是**「图片不能在翻译层被静默丢掉」**：它从 `server.js` 现抠
`geminiToOpenAI` / `bodyHasImages` / `filterCandidatesForImages` / `checkAuth` 的真实源码跑断言（也是零依赖，
两个协议命名变体、部件顺序、纯文本回退形态、能力门裁剪、原生 SDK 鉴权头与"管理面无提权"都在内）。

各 `*-e2e` 是单元级的**端到端姊妹**：真起一个假上游 + 临时网关实例（动态空闲端口，
配置与用量写在系统临时目录，**绝不碰仓库里的 `config.json` / `usage.json`**，不出网、不烧额度），
验证客户端协议 → 网关 → 上游的实际字节与响应形态。单元级测试覆盖不到「函数都在、就是接头不对」的缺陷——
PT23（非流式 shim 缺 `json()`）就是被这个脚本一次性抓到的。

新增测试时：登记进本文清单 + `AGENTS.md` §3 文档索引（一行用途即可，本文收全量描述）。
