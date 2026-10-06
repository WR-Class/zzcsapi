# 测试清单（48 个文件 · 2260 项断言，零依赖）

> 本文从 README 拆出（v1.18.8）：README 只留摘要与「改什么必跑什么」，本文收全部 47 条命令与每条守的是什么。
> 全部测试**零依赖**（只用 Node 内置模块）；e2e 用例**真起进程**（假上游 + 临时网关），
> **动态空闲端口；配置/用量在系统临时目录，绝不动仓库 `config.json` / `usage.json`**，不出网、不烧额度。
> 退出码非 0 = 有回归。跑单个：`node test/<名字>.test.js`。

## 改什么 → 必跑什么（速查）

| 你改了 | 必跑 |
| --- | --- |
| 渲染 / 交互 / `build/app.js` | `console-state` + `security-headers-e2e` |
| 协议转换（入站 / 出站 / 流式） | 对应协议的 `*-tools` / `native-channels` / `streaming-e2e` / `same-protocol-passthrough` / `responses-api-e2e` |
| **专用报文渠道的输出收口**（notion / notion-agent / workbuddy / genspark / codex 的响应写出口、`tryChannel` 的输出钩子转发、新增/修改客户端报文面） | `special-channel-output-seam-e2e`（装配守卫会当场抓住"某条路径又自己写响应"）+ `genspark-tools` + `workbuddy-quota` |
| 新增/修改**客户端路由**（新报文面、POST 白名单、鉴权点） | `responses-api-e2e` + `gemini-multimodal` + `session-affinity-e2e` + `ip-stats-ban-e2e` + `security-headers-e2e` —— 后四个各有一条「每个客户端面都必须接上 X」的**计数守卫**（图片门 / 粘性键 / statsCtx / authGate），加一个面就会当场报错，改完必须一起更新计数 |
| 调度 / 候选链 / 重试 / 冷却 / 权重 | `weighted-rr*` / `auto-weight*` / `per-channel-retry-e2e` / `cooldown-grading-e2e` / `upstream-4xx-fallback-e2e` / `session-affinity-e2e` |
| 流式读取循环 / 流内错误帧 / 懒提交（writeHead 时机） | `stream-error-frame-e2e` + `streaming-e2e` + `outbound-http-client`（直通字节一致性） |
| 流式或非流式的「200 但空」记账（零正文 / 空回复判据、直通空流） | `stream-error-frame-e2e` + `same-protocol-passthrough` |
| 常规链路的流式记账口径（上游 usage 帧 / 工具轮的 out / `reason`） | `tool-turn-accounting-e2e` + `reasoning-only-fallback-e2e` |
| 账本的「天 / 小时」口径（`byDay` 桶、24 小时分布、per-IP 24 桶的日界） | `usage-day-key` |
| 渠道级出站参数剔除（`dropParams` 白名单 / 出站副本不串味 / 直通路径 / 落库与清空语义） | `channel-drop-params-e2e` + `console-state`（§3b 表单回填与"总是提交"） + `same-protocol-passthrough`（直通路径） |
| 运行期四组开关（粘性 / 限流 / metrics / 回放） | `settings-api-e2e` + 对应开关的 e2e |
| 密钥 / 鉴权 / 会话 / 响应头 | `security-headers-e2e` + `key-rotation-e2e` + `admin-session-e2e` |
| 来源 IP 统计 / 封禁 / trustedProxy 采信 / 客户端标签列 | `ip-stats-ban-e2e` + `console-state`（统计页渲染与日志跳转链路一节） |
| 部署配置（docker-compose / 反代层 / 来源 IP 采信开关） | `reverse-proxy-config` + `ip-stats-ban-e2e`（trustedProxy 采信语义） |
| thinking / 签名 / 回放 | `thinking-fidelity` + `thinking-replay-e2e` |
| 静态文件 / 鉴权面 / 控制台版本 | `node sec-audit.js`（仓库根，只读体检，见 README「安全体检」） |
| 请求体落盘诊断（`ZZCSAPI_DUMP_BODIES` 与 compose 的 dump 挂载；v1.18.38 起含 `/v1/responses` 且只落 POST） | `body-dump-diagnostic-e2e` |
| notion 渠道的流断取回兜底（触发判据 = 权威全文没到 / 复用同一 threadId / 次数与预算上限 / 取不回仍如实失败） | `notion-refetch-fallback-e2e` |
| 流式提交时机 / 扣帧窗口 / 思考吃光（reasoning-only） | `reasoning-only-fallback-e2e` + `stream-error-frame-e2e` + `streaming-e2e` |
| 渠道超时（首字/总超时）/ 挂死换家 / 失败行归因 | `channel-timeout-attribution-e2e` + `cooldown-grading-e2e` |
| **手动测试的判据**（流式模式 / 与非流式刻意不同的"只有思考"判定 / 测试成功只半愈合） | `channel-test-stream-and-streak-e2e` + `channel-test-reasoning-e2e` + `disabled-channel-manual-test-e2e` |
| **熔断记账与冷却曲线**（两条 streak / `probeFail` / 半愈合不清真实欠账 / `markTrafficOk` 唯一清零入口 / `effFailStreak`） | `channel-test-stream-and-streak-e2e` + `cooldown-grading-e2e` + `weighted-rr`（不进池语义） |
| 输出预算（max_tokens / max_completion_tokens）跨协议保真 | `budget-passthrough-e2e` + `native-channels` |
| 手动测试（`/admin/api/test`）的预算与判据 | `channel-test-reasoning-e2e` + `disabled-channel-manual-test-e2e` + `channel-test-stream-and-streak-e2e` |
| 字体资产 / `head.html` 字体入口 / `font-assets.js` 投递 / CSP 的 `font-src` / Dockerfile 字体 `COPY` | `font-assets-e2e`（授权与改名断言在内，改前先读 `docs/fonts.md`） |

## 全量清单

```bash
node test/console-state.test.js           # 251 项断言，退出码非 0 = 有回归（含渠道表单权重：能填 → 能存 → 能显示；**渠道级「不发这些参数」（v1.18.33 §3b）：adapt() 收 dropParams → dp 数组、表单回填 `'a, b'`、saveChannel **总是**提交（框空 = 显式 `[]` = 清空，与 weight 的"留空 = 不动"刻意不同）、chips 来自服务端下发的 dropParamWhitelist（桩里给一份与真实白名单明显不同的短清单，界面显示的是桩里那份 → 证明没有硬编码）、服务端没下发时降级不抛、点 chip 去重去空白、结构守卫：前端不许抄白名单**；自动权重观测页渲染；停用渠道的手动测试弹窗；测试结果行：模型名 + 通过/空回复/失败三档；调用日志渠道列：显示渠道名不显示 id、紧跟请求 ID、按名字/按 id 都能搜，**客户端标签列（v1.18.11，v1.18.13 跳转直开抽屉 + 索引错位回归）**；运行期设置页：草稿跨轮询保留、**四张卡（v1.18.8 增 thinking 回放）**、POST 只发改动组、400 原文直显；密钥管理页：掩码可见、草稿跨轮询、轮换、**会话语义（密钥不落任何浏览器存储）**；**事件委托：真实委托块在桩上真跑分发——dataset 参数到达动作函数、嵌套只触发最近那枚、未知动作不炸、change 走同一条路、ACTS 双向覆盖（49 个函数名硬编码）**；**数据统计页（v1.18.11）：stats=null / 刚清零不抛且有空态、满数据画 per-IP 表与 sparkline、客户端过滤（日志跳转那条路）、UA 标签 esc()、封禁/解封按钮 data-act+data-t、详情抽屉；v1.18.12 增布局守卫：KPI 四卡 `.st-kpi*` 居中、来源明细表 `.st-fixed`+9 列 colgroup、表头与数值 `t-c` 居中（旧 `t-r` 清零）、占位符「—」走 `.t-c-ph` 而真名左对齐、产物 CSS 存在性 + 旧写法对照组；v1.18.13 增跳转链路：真跑 `drawLogTable` 的客户端 chip 绑定——chip 自带 `data-cl`、点击跳统计页并直接弹开最活跃来源的详情抽屉、无标签行在前时"旧写法按 rows[i] 取标签"的索引错位回归、无匹配标签不误弹、stopPropagation 不连坐行点击**；**v1.18.17 错误显示与登录门**：errMsgOf 真值表（网关错误体 {error:{message,type}} 直接拼 j.error 会显示 [object Object]——对象取 message、字符串透传、j.message 兜底）+ api()/登录门两处装配守卫与旧裸拼全仓清零 + 登录门提交前 trim（终端 cat 复制带尾随换行/空格不再 401）；**v1.18.19「从上游探测」钥匙 trim**：probeUpstream 读钥匙框 `.trim()` 与保存路径对齐——粘贴尾巴的换行没 trim 时把脏钥匙发上游吃 401 Invalid token（库里存的原文其实一直是好的，服务器侧原文直发 302 个模型验证）；**v1.18.20 密码框 autocomplete**：渠道表单钥匙框与登录门输入框都带 `autocomplete="new-password"`、全仓 password 框无一裸奔——浏览器把登录密钥自动填进渠道钥匙框（现场报告：编辑渠道点「明文」显示出来的是登录控制台的那把钥匙），配合服务端 400 闸门双保险）
node test/font-assets-e2e.test.js        # 44 项断言（v1.18.37）：自托管字体资产的**授权、交付与安全边界**——§0 装配守卫（启动扫成白名单 Map、只查表不拼路径、扩展名只放 woff2/css/txt、分片 immutable 而入口 CSS 短缓存、woff2 不二次压缩、Dockerfile 两条 COPY、`build/head.html` 仍 21 行且字体入口已换、CSP 的 style-src/font-src 收回 'self'、全仓无第三方字体主机、产物带 HCRound 字体栈、源码里 font-weight 500/600 清零）；§1 资产自洽（266 条 @font-face = 片数、引用逐一存在、400/700 都真声明、CSS 无保留字体名、LICENSE.txt 是 OFL 原文、★ **266 片解压后的 name 表都不含 ChillRoundF/ChillRoundM** 且都带原始版权）；§2 真链路（临时网关：br/gzip/原样三条压缩线、缓存分层、真 wOF2 字节与 font/woff2、**八种路径穿越写法全部 404**、不存在分片/目录路径 404、POST 405+Allow、nosniff + font-src 'self'、/console 真发出来的 HTML 同源、匿名管理面仍 401）。**用例自带最小 woff2 解码器**：woff2 的表数据是一条 Brotli 流，在压缩字节上直接搜字体名**永远是"假通过"**；解码器带"解压长度 = Σ表长"自检与 HCRound 正对照，并用分片内真实存在的 7 条 name 记录揭穿了"result.css 头部有 LicenseDescription"这个假证据（那份头读的是**输入**字体，切分工具会丢掉输出分片的 nameID 13/14）
node test/reverse-proxy-config.test.js  # 37 项断言：反代采信层配置守卫——本机层（XFF 必须**覆写**不可追加、转发口只绑宿主回环 127.0.0.1:18787、server_tokens off 不报版本号（复测 N-01）、固定子网与 README 写的 trustedProxy 逐字一致、默认直连模式走 ${ZZCSAPI_PUBLISH:-8787:8787} 不被写死、自启脚本幂等且纯 ASCII、README 开/关/坑齐）+ 公网层 v1.18.16（nginx-public.conf：XFF 覆写同源、只反代回环转发口、server_tokens off、**HSTS/COOP/CORP 三头（N-03 TLS 里程碑落地）**、TLS 只开 1.2/1.3、80 只留 ACME webroot+301 / 业务只在 443、Let's Encrypt 标准证书路径、README 公网四件套：域名进 ZZCSAPI_ALLOWED_HOSTS、公网必须换新密钥、certbot 续期、防火墙收口；另守 compose 真透传 ZZCSAPI_ALLOWED_HOSTS——注释行透传 = 公网域名一律 421；v1.18.17 增 README 方式四 .env 钥匙名必须带 ZZCSAPI_ 前缀——裸 ADMIN_KEY= 被 compose 映射漏掉，静默回落首启生成，.env 钥匙两头都不生效；v1.18.18 增 CF 橙云姿势——nginx realip 只对 CF 网段（≥22 条 set_real_ip_from）采信 CF-Connecting-IP 恢复真实访客 IP、XFF 覆写纪律一字不动、**网关侧（server.js）绝不读该头**、README 必须写全 Full (strict) 防重定向循环/源站锁定/切回灰云放行/100 秒超时告警）；改 docker-compose.yml / deploy/* 或部署方式后必跑
node test/gemini-multimodal.test.js       # 41 项断言：图片转换 / 候选裁剪 / 原生 SDK 鉴权头（单元级）
node test/gemini-multimodal-e2e.test.js   # 22 项断言：真起「假上游 + 临时网关」，走完整 HTTP 链路（约 5 秒）
node test/anthropic-tools.test.js         # 60 项断言：Anthropic tool_use ↔ OpenAI tool_calls（含工具结果带图、id 往返、有状态流式）
node test/anthropic-tools-e2e.test.js     # 30 项断言：两轮工具回合（要工具 → 回传结果）真 HTTP 链路
node test/responses-api-e2e.test.js       # 71 项断言（v1.18.38）：OpenAI Responses API（客户端第四套报文）——§1 单元级（从 server.js 现抠 responsesToOpenAI / openAIToResponsesResponse / createResponsesStreamConverter：instructions→system、developer→system、input_text 纯文本退回字符串、input_image→image_url、function_call/function_call_output 配对、扁平工具→嵌套、max_output_tokens→max_completion_tokens、usage 口径、finish=length→status incomplete）；§2 真链路（假上游 + 临时网关：上游**真收到** chat 报文而不是 input、instructions 变 system、URL 是 chat/completions、客户端拿到 object=response、GET/DELETE /v1/responses/{id}、未知 id 404 且说明留存策略、取回面同样要密钥、store:false 不落表、流式九类事件齐全且正文由 delta 拼成、流式那一发也能按 id 取回、账本有 kind=responses 行、**chat 面未回归的对照**、空 input/缺 model 400、GET 无 id 405）；§3 装配守卫（**不设 clientProto**（设了就直通、把 input 塞给 chat 上游）、两段路由共用一次 authGate、`/v1/responses` 已从 handleOpenAIRequest 白名单摘掉、chat 与 responses 共用 `openAICandidateChain`、`[DONE]` 与 epilogue 收敛到同一个幂等 end()）
node test/streaming-e2e.test.js           # 19 项断言：三协议流式（首块不丢字节 / 事件序列 / 收尾兜底）
node test/special-channel-output-seam-e2e.test.js # 53 项断言（v1.18.38 修正）：**专用报文渠道的输出收口**——notion / notion-agent / workbuddy / genspark / codex 五条路径自己构造上游报文，历史上也**自己写响应**（非流式 res.end(chat 报文)、流式 res.write(chat SSE 行)），于是 Anthropic / Gemini / OpenAI Responses 三个面拿到的是 OpenAI 形态。现场（公网实测）：Responses 客户端打到 notion 渠道收到 {"object":"chat.completion","id":"chatcmpl-notion-…"}；Anthropic 面流式打到这些渠道没有 message_start。§1 装配守卫（★ tryChannel 的 specialOpts 必须转发 onSuccessNonStream/onStreamChunk/streamPrelude/streamEpilogue 四个输出钩子——漏了它们这五条路径就只能自己写；五条路径函数体里 0 处"自写 200 JSON"、0 处"自写 SSE 头"、0 处裸 res.write；调用点计数 8/5/5/≥20；★ specialStreamLine 有钩子时只写钩子返回、空串不回退成原始报文，没钩子才写原始行；specialStreamHead 写头后立刻发 prelude；specialStreamEnd 先发 epilogue 再 end()）；§2–§5 真链路（假 workbuddy 上游〔只回 SSE〕+ 假 notion 上游〔getSpaces + runInferenceTranscript NDJSON〕+ 临时网关）：★ notion × Responses 拿到 object:"response" / resp_ 前缀 / output_text / 流式有 response.created + output_text.delta + response.completed 且**每个 data 行都配一个 event 行**、★ workbuddy × Responses 同样、★ notion × Anthropic 拿到 type:"message" 且流式有 message_start + content_block_delta + message_stop、★ notion × Gemini 拿到 candidates[0].content.parts[0].text；§6 对照（notion/workbuddy 的 OpenAI 面仍是 chat.completion + chatcmpl-* 前缀 + usage，流式仍是裸 data 行 + [DONE] 且**一个 event 行都没有**——钩子转发对老路字节等价）；§7 上游报文未被改动（workbuddy 仍收强制流式 OpenAI 报文、notion 仍收自己的 runInferenceTranscript 报文、getSpaces 只做一次有缓存）。**改 tryChannel 分派 / 这五条专用路径的输出 / 新增客户端报文面时必跑**
node test/notion-refetch-fallback-e2e.test.js # 42 项断言（v1.18.39）：**notion 渠道的流断取回兜底**——上游 NDJSON 流里 `record-map` 才是权威全文、`patch` 只是增量，三种现场会让客户端拿到残次品：① 流里带 soft-block 错误（200 + temporarily-unavailable）② 200 但零内容 ③ 流被截断（只剩半截 patch、record-map 从没到）。而线程在 Notion 侧已落库（`saveAllThreadOperations:true`）→ 用**同一 threadId** 把同一份 transcript 再发一次（`createThread:false` + `isPartialTranscript:true`，活体验证：首发 6.3s 拿 record-map；同一 threadId 再发 4.7s 拿同一条线程的全文；**空 transcript 的"只取回"被上游 400 拒**）。§1 装配守卫（★ 触发判据含 `!probe.sawFinal`——权威全文到了就一次都不重发；★ 三种现场都覆盖；★ 取回发生在首个 `specialStreamHead`/`specialNonStreamOut` **之前**（流式也不许"先写半截再回填"）；次数上限 ≤3 + 总预算 + 报文级错误立刻放弃；账本 note 只在真取回时写；`notionBuildPayload` 不传 opts 时与首发逐字节同形状、传 opts 时复用 threadId 并翻转两开关；parser 的 `sawFinal` 语义：record-map → true、只有 patch → false）；§2–§6 真链路（假 Notion 上游可编程四模式 + 临时网关）：★ 流被截断 → 客户端拿到**成品答案**而不是"半截回答"、上游被打了两次且第二次复用同一 threadId / 同份 transcript / 新 traceId、★ 流式面正文是完整一份（无"半截 + 追加"双份、半截没漏出去）、★ 流内 soft-block → 兜底救回（旧行为是直接判渠道失败）、★ 对照组"首发就带 record-map → 上游只被打一次"、★ 诚实边界"两次都零内容 → 仍如实判渠道失败（单候选 502）"；§7 账本留痕（取回行 `note=notion-refetch` 且 ok:true，正常行没有）。**改 notion 渠道出站/取回、notion.js 的 payload 与解析器、或调度失败判据时必跑**
node test/stream-error-frame-e2e.test.js  # 31 项断言（v1.18.21；v1.18.26 增场景 E；v1.18.32 增场景 F）：流内错误帧与零正文流——上游 200 但 SSE 里塞 data:{"error":…}（超长上下文打到上限小的渠道就是这么回，现场 req_mur6vapv：66,991 进 / 0 出，网关却记"成功"）。真起「假上游 + 临时网关」四条：①预检期错误帧（正文未出、响应未提交）→ 取消读取、切下一候选拿到正文、**不**记渠道失败但用量记 ok:false；②已提交后的错误帧（正文已流出）→ 流如实转发、`ok:false` 记账、渠道 lastError 带 `stream error frame`（连败进冷却）；③非流式 200+error 报文同样切候选（旧写法记成功还回 200）；④对照组：正常流逐字节透传零改动、只记一条 ok:true；**⑤v1.18.26 场景 E：200 + 零正文流**（role + usage(0) + [DONE]，无 error 帧）→ 判失败、切下一候选、用量记 ok:false、**失败行带上请求的模型名**（此前 recordFailure 写死 `—`，实测 88% 的失败行看不出在调哪个模型）；**⑥v1.18.32 场景 F：非流式 200 + 空回复**（`choices[0].message.content === ''`、无 tool_calls、无思考——现场 `gpt-6-astra` 91 行"幽灵成功"的形态，只能来自没有空正文判据的非流式路径）→ 判失败、**切下一候选**（非流式响应未提交，真换得了家）、用量记 `ok:false`、备注写明空回复、失败行带模型名，外加"good 渠道的正常非流式仍 `ok:true` 且 `out > 0`"对照
node test/reasoning-only-fallback-e2e.test.js # 15 项断言（v1.18.28）：★「思考吃光预算」必须换下一家——上游只流 reasoning_content + finish=length + 可见正文 0（现场 dump 实证：Fireworks 托管的推理模型）→ 判失败、切到能出正文的家、账本 ok:false + reason 字段；三条对照（有思考也有正文不切 / 只有工具调用帧不切 / max_tokens=8 探测类不切）
node test/budget-passthrough-e2e.test.js # 19 项断言（v1.18.31）：客户端的输出预算必须活着穿过每一层——DSH 发的是新字段 max_completion_tokens=32768（不发 max_tokens），而转换器只读老字段，于是 anthropic 渠道被静默换成缺省 8192、gemini 渠道整个丢掉，推理型上游把思考算进同一份预算，8192 被吃光就是「可见正文 0 字符 + finish=length」。真链路断言 anthropic 上游真收到 32768、gemini 真收到 maxOutputTokens=32768，另含"客户端没给 → anthropic 仍 8192 / gemini 仍不设"与"两个字段都给 → 老字段优先"两组对照，外加三处共用 clientBudgetOf 的结构守卫
node test/channel-timeout-attribution-e2e.test.js # 9 项断言（v1.18.30）：挂死渠道要快速换家 + 失败行能归因——渠道连响应头都不回时首字死线必须生效（旧逻辑只在拿到头之后才起计时器，挂死家会吃掉整个 90s 总超时，客户端先超时）；断言 1s 内换家拿到正文、失败行记 ok:false+原因、失败行带 client 标签与模型名，并结构守卫默认值（首字 30s/60s、总超时 90s）
node test/channel-test-stream-and-streak-e2e.test.js # 50 项断言（v1.18.40）：**手动测试的流式模式 + 真实流量单独一条欠账**（用户点出的两处真问题）。①`/admin/api/test` 一律发非流式、而真实客户端一律走流式 → "非流式答得好、流式那条路是坏的"渠道永远测不出来；②探测成功把欠账**减半**、手动测试成功把欠账**清零** → 熔断的唯一跳开机制（cooldownUntil，指数退避）被反复抹掉，"测试过、真实挂"的死家**永远熔断不掉**。§1 `classifyStreamFrame` 真值表（role-only 开场帧不算正文、usage 末帧、原生三形态、垃圾输入不炸）；§2 装配守卫（帧分类只有一份实现、真实链路与手动测试**共用**它、测试分支里 `markTrafficOk` 一次都不许出现、真实清零入口唯一、`probeFail` 已下发）；§3 **★ 同一个渠道「非流式测试通过、流式测试失败」必须被抓出来**（①的核心断言，上游真的收到 `stream:true`）+ 流式其余四形态（正常拼正文 / 流内 error 帧 / 上游无视 stream 回整段 JSON → `streamIgnored` / 思考吃光预算 `finish=length`）；§4 对照：同一家的**非流式**测试仍判可用（v1.18.29 的宽容只留给非流式模式）；§5 **★ 真实流量欠 2 笔 → 手动测试成功**不清零**（仍 2，`probeFail` 回 0、冷却放开、进观察期）→ `GET /models` 探测成功**也不清零** → 只有真实成功才清零**；§6 测试失败只记 `probeFail`（真实 streak 纹丝不动）
node test/channel-test-reasoning-e2e.test.js # 8 项断言（v1.18.29）：手动测试必须为推理型模型兜底——测试请求预算 ≥256（原来只有 16，token 全被思考吃光 → 200+正文空 → 控制台判不过）；只有思考的家仍判可用并标 reasoningOnly；真·空回复仍如实显示；上游 5xx 带回原文
node test/channel-drop-params-e2e.test.js # 85 项断言（v1.18.33）：★渠道级「不发这些参数」（dropParams）——现场 agentrouter 每天固定开放额度，却对「tools + reasoning_effort」组合直接 400（Function tools with reasoning_effort are not supported for gpt-6-astra），而 DSH 每次请求都同时带这两样 → 该渠道 19 行 0 成功。真起「假上游 + 临时网关」：主用例断言上游**真收不到** reasoning_effort 而 tools 仍在、对照组（没配的渠道）照样收到、**不串味**（第一家失败切到第二家后，第二家仍收到该参数——剔除只作用于出站副本、不污染共用报文对象）、同协议直通也生效、白名单外的名字 400 并回带合法清单、落库往返 + 保存别的渠道后仍在（persistConfig 显式字段清单）、显式空数组 = 清空、GET /admin/api/config 下发 dropParamWhitelist；边界：workbuddy/codex/genspark/notion-agent 配了**不生效**（自带专用报文构造）
node test/body-dump-diagnostic-e2e.test.js # 14 项断言（v1.18.27）：请求体落盘诊断——开启后真落盘且内容一致、?key= 打码（密钥绝不进 dump）、/admin/ 不落盘、默认关闭零副作用、轮转只留最近 N 个、落盘失败不影响请求
node test/weighted-rr.test.js             # 31 项断言：加权轮询算法（3:1→75/25、平滑性、老配置零影响对照）
node test/weighted-rr-e2e.test.js         # 12 项断言：真 HTTP 数落点，验证实际分流比例与降级行为
node test/native-channels.test.js         # 78 项断言：原生出站双向转换（请求/响应/流式状态机/URL 鉴权头/错误体不翻译）
node test/native-channels-e2e.test.js     # 33 项断言：原生假上游 × 三条客户端路由，验证上游真的收到原生报文
node test/console-weight-e2e.test.js      # 18 项断言：控制台表单报文 → 真网关落库 → 真流量分流 → 表格那一格显示出来
node test/auto-weight.test.js             # 66 项断言：自动权重算法（健康系数/地板/死区平滑/份额封顶）＋**静默不变式**（观测不许改分流）＋后台节拍装配守卫
node test/auto-weight-e2e.test.js         # 37 项断言：真流量下预测与健康系数自洽、分流一字未动、配置往返旋钮不丢、后台节拍不依赖控制台
node test/upstream-4xx-fallback-e2e.test.js  # 43 项断言：上游 4xx 不许短路兜底（404/400 都继续切、最后一家才透传、冷却位不算后手）；v1.18.34 加两节——全链 429 → 502 时每条 attempts 都要带 HTTP 码与上游原文（现场 channel_error 光秃秃、看不出是余额还是 WAF）+ 对照组防拼两遍
node test/tool-turn-accounting-e2e.test.js # 41 项断言（v1.18.35；v1.18.40 更新结构守卫）：★工具轮不许被记成"零产出的成功"——现场账本里 deepseek-v4.1-flash 有 196 行 ok:true 且 out=0（耗时只有 8~38 秒、与有正文的行同渠道同分钟交错），开留证开关抓 DSH 真实报文后**逐字节回放**才定性：客户端拿到的是 49 个 tool_call、finish=tool_calls、可见正文 0 字符，而上游 usage 帧自报 prompt_tokens=176351 / completion_tokens=114，账本却记 in=56324 out=0。根因在常规链路（openai 渠道 → openai 客户端）的记账侧：usage 帧被整帧丢掉（只数可见正文），纯工具轮 out 就是 0。断言：两个新函数的真值表（工具帧的 name+arguments 也算输出、usage 帧归一、全 0 空帧不覆盖累计）；真链路 ★ 纯工具轮 + usage 帧 → in/out 取上游真值、留 tool_calls 标记；真链路 ★ 纯工具轮**没有** usage 帧 → out>0（旧写法=0）；文本轮两组对照（有 usage → 上游优先、没有 → 仍是估算）；思考轮 reason 用上游自报数字且 ≤ out；结构守卫：usage 帧必须在 `if (sawStreamContent) return` 早退**之前**抓（上游常把 usage 放最后一个 chunk）
node test/usage-day-key.test.js            # 27 项断言（v1.18.36）：账本的「天 / 小时」一律按**北京时间**切——现场查「yu1 渠道 24 小时用量」时发现日桶与小时桶对不上：`byDay` 用 `new Date(ts).toISOString().slice(0,10)`（UTC 日）、24 小时分布用 `getHours()`（本地小时），同一个账本里两套钟，日界落在北京时间早上 8 点（`ipStatsBumpHour` 更自相矛盾：注释写"本地时区跨天清零"，代码是 UTC 日 + 本地小时）。处置：新增 `cnDayKey()`/`cnHour()`（**固定 +8**，不依赖进程时区——compose 设了 TZ 但裸跑可能是 UTC），账本四处统一走它们。断言：真值表（北京 00:00 边界、跨月跨年、字符串 ts、`cnHour` 三态、**老写法在同一点上差一天**的对照）；★ 真链路**用 TZ=UTC 起网关**——`byDay` 桶键 = 该行 `ts` 的北京日、不含 UTC 日桶、`hourly` 落在北京小时而 **UTC 小时那格必须是 0**、per-IP 24 桶同理；结构守卫（`bumpUsageBucket(u.byDay, …)` 的 day 来自 `cnDayKey`、`ipStatsBumpHour` 不再混用、全仓 Date→日字符串的转换只有 `cnDayKey` 一处）
node test/per-channel-retry-e2e.test.js   # 34 项断言：同渠道重试（抖动被原地救回、4xx 绝不重试、0/缺省=不重试、上限钳到 5）
node test/cooldown-grading-e2e.test.js    # 57 项断言（v1.18.40 契约更新）：熔断分级（瞬时/凭证/限流三条曲线 + Retry-After + 半愈合 + 观察期排序）——**半愈合不再把欠账减半**（探测成功只放开冷却、清 probeFail、进观察期，consecutiveFail 一字不动）、探测失败不再把 3 变 1、真机第 6 节改为"欠账原样保留 + probeFail 回 0"；`cooldownMsFor` 现在读 effFailStreak，沙箱里必须一起抠出 `effFailStreak` / `markTrafficOk`
node test/gemini-tools.test.js            # 44 项断言：Gemini 客户端路由的工具转换（functionCall⇄tool_calls、id 配对与无状态退路、toolConfig 三态、流式分片攒整、仿真链兼容）
node test/gemini-tools-e2e.test.js        # 29 项断言：真起「假上游 + 临时网关」走 /gemini/... 两轮工具回合（含流式与三种 toolConfig）
node test/same-protocol-passthrough.test.js # 52 项断言：同协议直通（Anthropic/Gemini 客户端 → 同协议渠道不翻译；thinking/cache_control/seed 原样到达、响应逐字节一致、真实 token 仍记录、跨协议仍走转换、v1.18.8 修复只注入同协议直通且没坏不碰）；**v1.18.32 §3b 直通空流**：上游只回 `message_start` + `message_stop`（零 `content_block_delta`）→ 客户端仍拿 200 + 上游原始 SSE（字节已写出、换不了家）、用量如实记 `ok:false`（备注含 `no content`/零正文）、该渠道 `lastError` 写明 `stream empty` 且 `consecutiveFail ≥ 1`（下一发才会退避），并含"正常直通流之后 `ant-native` 仍是零欠账"的对照 + 那条判据逐字为 `streamError === null && !nativeStream && !sawStreamContent` 的结构守卫（`!nativeStream` 必须在，也不许再加 `streamOutText.length === 0`）
node test/workbuddy-quota.test.js      # 39 项断言：WorkBuddy 额度用尽要看得懂（trim 后再判 JSON、重置时刻→精确冷却、错误带 HTTP 码与响应开头、密文 token 提前拦、冷却跳过也带原因）
node test/genspark-tools.test.js          # 47 项断言：Genspark 网页会话反代的工具调用（system 折叠 + [TOOL_CALL] 仿真往返 + 真网关经假代理跑完整链路；v1.18.38 起流式分支的源码断言改为 `specialStreamLine(opts, candidate, chunk(…))`——纯文本分支的行为一字未变，只是出口改走收口钩子）
node test/disabled-channel-manual-test-e2e.test.js  # 26 项断言：停用渠道「能手动测、不被自动测」（自动探测 0 次 / 手动测试真打通 / 手动重探测照探）
node test/outbound-http-client.test.js    # 32 项断言：出站长连接客户端（fetch 形状真值表 + 20 次请求 0 条新连接、对照 agent:false 建 20 条）+ 直通流式逐字节一致（含 CRLF 与跨片帧）
node test/session-affinity-e2e.test.js    # 67 项断言：会话粘性（键推导真值表 + 过期/淘汰 + 冷却/down 不硬塞 + 同会话 8 次落同一家 + 上游挂了重新粘 + 关闭时零状态）
node test/rate-limit-e2e.test.js          # 50 项断言：客户端限流（令牌桶真值表 + 429 带 Retry-After + 按时间回填 + 并发闸门 + 管理面不受影响 + 关闭时零影响）
node test/metrics-e2e.test.js             # 45 项断言：/metrics（Prometheus 格式合法性 + 标签转义 + 计数随真流量动 + 密钥绝不出现在正文 + public/关闭两态 + thinking 回放 gauge 与六事件）
node test/thinking-fidelity.test.js        # 36 项断言：thinking/签名 保真度地图（跨协议双向都不产出 thinking 块 → 跨协议"无签名块触发 400"不可达；`signature` 只活在回放块与 4xx 作废分支；直通仍是唯一活路，回放只补上游真签过的）
node test/thinking-replay-e2e.test.js      # 64 项断言：thinking 回放缓存（v1.18.8，同协议直通签名修复）——复现失败（关=400）→ 开=补回原签名（逐字段）→ 跨会话/渠道/模型绝不回放（三组反向）→ 过期/淘汰/作废计数 → 流式分片攒对照样修 → 完好客户端一字不动 → 设置第四组/status/metrics 暴露
node test/settings-api-e2e.test.js        # 68 项断言：运行期设置端点（四组窄口白名单 + 钳制与启动路径共用同一份规则 + 改完不重启立即生效（真发请求看到 429/404）+ 落库并重启后仍在 + 400 点名字段）
node test/security-headers-e2e.test.js    # 72 项断言：安全加固（渲染层"裸插值"必须一个不剩 + toast/data-t 必须转义 + 安全响应头覆盖 401/404/静态壳/所有 API + 管理面与 /healthz 带 no-store + **/metrics 全态 no-store（外部复测 N-02：未鉴权 401 也不落中间层缓存）** + **/healthz 只回 {ok:true}（V-08：匿名面不带渠道数与密钥状态）** + 页面壳零密钥明文 + **CSP 逐字等于设计稿（v1.18.6）** + 管理面 ?key= 已停用 / 客户端面保留 + **内联事件属性必须为 0 且 ACTS 与模板双向一一对应（v1.18.7）** + **第六批（v1.18.10）Host/Origin 门：陌生域名与公网 IP → 421、白名单域名与回环/私网 IP 字面量 → 200、跨源 Origin 写请求 → 403（揣着正确密钥也拒）、同源/无 Origin 照常、装配位置必须在一切路由分支之前（V-07，含 ZZCSAPI_ALLOWED_HOSTS 注入）** + **v1.18.20 数据损失闸门：POST 渠道 apiKey 填的是管理/网关密钥一律 400 拒收且原密钥不被覆盖（浏览器把登录密钥自动填进渠道钥匙框 / 剪贴板残值的保险丝）**）
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
