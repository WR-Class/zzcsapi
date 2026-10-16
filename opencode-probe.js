#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   opencode 免费层判决探针（只读，低额度，报告绝不回显任何凭据）

   存在的理由：opencode 的失败体有两种 **403**，含义完全不同、处置也完全不同：
     · RegionError    —— 出口 IP 的地区不开放该模型（换出口**有用**）
     · FreeTierError  —— 客户端身份不是 OpenCode（换出口**没用**）
   光看控制台那句"渠道故障"分不清是哪一层，就会在错误的层上排查半天（本项目
   notion 软墙误判过三次，opencode 这一轮又踩了两次，见
   docs/opencode-reverse-proxy-research.md §9）。

   它按层分开打，并给出可复现的判决：
     ① 目录      GET {base}/models —— 有多少个 -free 模型（免费层的**候选集**）
     ② 凭据门    免费模型：不带凭据 / Bearer public / 乱码 key —— 三条**应同结果**
                 （同结果 ⇒ 这一路**不按密钥判**，不是"缺一枚形状对的 key"）
                 ⚠️ 注意"不按密钥判"**不等于**"密钥是万能解药的反面"：实测带上
                    真实账号 token **也**是同一个 403 ⇒ 判据是**客户端身份**。
                    能过这道门的是 `opencode serve` 边车，见
                    `opencode-sidecar-probe.js` 与研究文档 §4/§5。
     ③ 付费门    付费模型不带凭据 —— 期望 401 AuthError（说明它就在等一枚真 key）
     ④ 地区门    用 Cloudflare trace 读出口 loc，并对一个地区敏感模型打一发
                 —— 撞 RegionError 时本项**记"未作判定"**：那不是探针失败，
                    而是"免费层这道门这一发根本没走到"，必须换出口重跑
     ⑤ go 面     POST /zen/go/v1/... —— 期望点明 x-opencode-session（"会话"硬要求的直接证据）

   用法：
     node opencode-probe.js [--proxy <url>] [--base <url>] [--region-model <id>]

     --proxy  给**宿主机**跑用的代理（容器里那条是 host.docker.internal:7897，
              宿主机上常常不可达）。Node 原生 fetch **不读** Windows 系统代理，
              不配这一项时地区门那一节会直接测出本机真实出口（本机 = CN）。
     --base   默认 https://opencode.ai/zen/v1（客户端内置目录里写的就是它；
              ⚠️ 写成 https://opencode.ai/zen 会 404）
     --region-model  用来测地区门的模型，默认 cat-jam-free（本机实测它先撞地区门）

   额度：全部请求 max_tokens=16、单轮、无对话历史 —— 不消耗真实推理。
   凭据：本探针**不需要**任何密钥，也不会打印密钥。
   ⚠️ 本探针测的是**直连面**，发出的都是"缺条件"的报文 ⇒ 结论恒为 403 FreeTierError。
      **别据此说"这条路是死的"**（v1.18.71 就是这么写错的）——直连面其实**能通**，
      条件是报文里三样可自造的东西（UA 形状 / 自铸 descending 会话 id / 官方标题提示词前 ≥965 字符 +
      stream:true + 不带 tools）。本探针**刻意不构造**那三样：那条路要伪造客户端身份，不是接入建议。
      **网关接入走的是边车面**，用 `opencode-sidecar-probe.js`（`protocol:"opencode"`）。
      结论、边界实测与六次误判留档见 docs/opencode-reverse-proxy-research.md §3/§9/§13。
   ═══════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const tls = require('tls');
const { URL } = require('url');

const DEFAULT_BASE = 'https://opencode.ai/zen/v1';
const DEFAULT_REGION_MODEL = 'cat-jam-free';
// 出口地区用 Cloudflare trace 读（比第三方 geo API 稳）。可覆盖，供离线 e2e 用。
const DEFAULT_TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

const HELP = `opencode 免费层判决探针（只读，低额度）
  node opencode-probe.js [--proxy <url>] [--base <url>] [--region-model <id>] [--trace-url <url|none>]
  --proxy  宿主机上跑时填 http://127.0.0.1:7897（Node 原生 fetch 不读系统代理）
  --base   默认 ${DEFAULT_BASE}
  --trace-url  读出口 loc 的来源；填 none 跳过该步（离线 e2e 用）
详见文件头注释与 docs/opencode-reverse-proxy-research.md`;

function parseArgs(argv) {
  const out = { proxy: '', base: DEFAULT_BASE, regionModel: DEFAULT_REGION_MODEL, traceUrl: DEFAULT_TRACE_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--proxy') out.proxy = argv[++i] || '';
    else if (a === '--base') out.base = (argv[++i] || '').replace(/\/+$/, '');
    else if (a === '--region-model') out.regionModel = argv[++i] || DEFAULT_REGION_MODEL;
    else if (a === '--trace-url') out.traceUrl = argv[++i] || '';
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  }
  return out;
}

/* 出网：Node 原生 fetch 不认 HTTP(S)_PROXY，所以配了代理就自己起一条 CONNECT 隧道。
   手写最小 HTTP/1.1：**必须带 Accept-Encoding: identity** —— 上游默认回 br，
   而这里不解压，否则 JSON 会被当成乱码（"探针自己没读懂"会被误读成"上游没回"）。 */
function proxyConnect(targetUrl, proxyUrl) {
  return new Promise((resolve, reject) => {
    const t = new URL(targetUrl);
    const p = new URL(proxyUrl);
    const port = Number(t.port || 443);
    const req = http.request({
      host: p.hostname, port: Number(p.port || 80), method: 'CONNECT',
      path: `${t.hostname}:${port}`, headers: { Host: `${t.hostname}:${port}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
      const s = tls.connect({ socket, servername: t.hostname }, () => resolve(s));
      s.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function request(url, { method = 'GET', body, proxy, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (!proxy) {
    const r = await fetch(url, {
      method, headers: h, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  }
  const u = new URL(url);
  const sock = await proxyConnect(url, proxy);
  return await new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const lines = [
      `${method} ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.hostname}`,
      'Connection: close',
      'Accept-Encoding: identity',
    ];
    for (const [k, v] of Object.entries(h)) lines.push(`${k}: ${v}`);
    if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(payload)}`);
    sock.write(lines.join('\r\n') + '\r\n\r\n' + payload);

    let raw = '';
    sock.on('data', (d) => { raw += d.toString('utf8'); });
    sock.on('end', () => {
      const i = raw.indexOf('\r\n\r\n');
      if (i < 0) return resolve({ status: 0, text: '' });
      const head = raw.slice(0, i);
      const status = Number((head.match(/^HTTP\/\d\.\d\s+(\d+)/) || [])[1] || 0);
      let rest = raw.slice(i + 4);
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        let out = '', pos = 0;
        for (;;) {
          const nl = rest.indexOf('\r\n', pos);
          if (nl < 0) break;
          const size = parseInt(rest.slice(pos, nl), 16);
          if (!Number.isFinite(size) || size === 0) break;
          out += rest.slice(nl + 2, nl + 2 + size);
          pos = nl + 2 + size + 2;
        }
        rest = out;
      }
      resolve({ status, text: rest });
    });
    sock.on('error', reject);
  });
}

function errOf(text) {
  try {
    const j = JSON.parse(text);
    if (j && j.error) return String(j.error.type || j.error.message || '');
  } catch { /* 非 JSON */ }
  return '';
}

const results = [];
function check(ok, label, note) {
  results.push({ ok, label });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${note ? '  —— ' + note : ''}`);
}
function undecided(label) { results.push({ ok: null, label }); console.log(`  · ${label}`); }

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  console.log('opencode 免费层判决探针（只读 · 低额度 · 不回显凭据）');
  console.log(`  base  = ${opt.base}`);
  console.log(`  proxy = ${opt.proxy || '<直连>（Node 原生 fetch 不读系统代理）'}`);
  console.log('');

  const freeBody = (m) => ({ model: m, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 });
  const post = (path, b, extra) => request(`${opt.base}${path}`, { method: 'POST', proxy: opt.proxy, body: b, headers: extra || {} });

  /* ── ① 目录：免费层的候选集 ─────────────────────────────────────────── */
  console.log('① 目录（免费层的候选集）');
  let freeModels = [];
  let paidModel = 'glm-5.1';
  try {
    const r = await request(`${opt.base}/models`, { proxy: opt.proxy });
    const ids = (JSON.parse(r.text).data || []).map((m) => m.id);
    freeModels = ids.filter((i) => /free/i.test(i) || i === 'big-pickle');
    const paid = ids.filter((i) => !/free/i.test(i) && i !== 'big-pickle');
    paidModel = paid.find((i) => /^(glm|kimi|deepseek|minimax|mistral)/.test(i)) || paid[0] || paidModel;
    check(r.status === 200 && ids.length > 0, `GET /models 可读（${ids.length} 个）`, `免费候选 ${freeModels.length} 个`);
    if (freeModels.length) undecided(`免费候选：${freeModels.slice(0, 8).join(', ')}${freeModels.length > 8 ? ' …' : ''}`);
    else undecided('目录里没有任何免费模型 —— 上游可能已下线免费层');
  } catch (e) {
    // 连不上/解析前就抛 = 传输层没通 ⇒ "测不到"（未作判定），不是"上游变了"（失败）。
    undecided(`GET /models 没打通（${e.message}）—— 未作判定，先修通道；上游真变了会在拿到响应后判失败`);
  }
  console.log('');

  const freeModel = freeModels.includes('deepseek-v4.1-flash-free') ? 'deepseek-v4.1-flash-free' : (freeModels[0] || 'deepseek-v4.1-flash-free');

  /* ── ② 凭据门：三条应**同结果**（同结果 = 密钥根本没被校验）─────────── */
  console.log(`② 凭据门（免费模型 ${freeModel}；三条同结果 ⇒ 这一路不校验密钥）`);
  const variants = [
    ['不带凭据', {}],
    ['Bearer public', { Authorization: 'Bearer public' }],
    ['Bearer 乱码 key', { Authorization: 'Bearer sk-' + 'A'.repeat(60) }],
  ];
  const kinds = [];
  for (const [label, extra] of variants) {
    try {
      const r = await post('/chat/completions', freeBody(freeModel), extra);
      const t = errOf(r.text);
      kinds.push(t);
      // 状态在前、标签在后：标签里中英混排，padEnd 按码点数补空格会错位。
      console.log(`    HTTP ${String(r.status).padEnd(4)} ${String(t).padEnd(15)} ← ${label}`);
    } catch (e) {
      kinds.push('ERR:' + e.message);
      console.log(`    ERR            ← ${label}（${e.message}）`);
    }
  }
  const uniq = [...new Set(kinds)];
  if (kinds.length && kinds.every((k) => String(k).startsWith('ERR:'))) {
    // 三条全都没打通上游 —— 这是"测不到"，不是"渠道被判死"。
    undecided('三条都没打通上游（传输层就不通）—— 本项未作判定，先修通道再复测');
  } else if (/RegionError/i.test(kinds[0] || '')) {
    undecided('免费模型先撞**地区门** —— 这一节不足以判决客户端门，请换出口重跑（见 ④）');
  } else {
    check(uniq.length === 1 && /FreeTierError/i.test(kinds[0] || ''),
      '三条同结果且都是 FreeTierError ⇒ 这一路不校验密钥（是客户端门）',
      uniq.length === 1 ? kinds[0] : `★ 三条结果不一致：${uniq.join(' / ')}`);
  }
  console.log('');

  /* ── ③ 付费门：期望 401 AuthError（在等一枚真 key）─────────────────── */
  console.log(`③ 付费门（${paidModel} 不带凭据）`);
  let paidGate = 'n/a';
  try {
    const r = await post('/chat/completions', freeBody(paidModel), {});
    const t = errOf(r.text);
    paidGate = (r.status === 401 || /AuthError/i.test(t)) ? 'key-required' : `other(${r.status})`;
    check(r.status === 401 || /AuthError/i.test(t), '付费模型无凭据 → 401 AuthError（付费面可用，只缺 key）', `HTTP ${r.status} ${t}`);
  } catch (e) { paidGate = 'unreachable'; undecided(`付费门探测没打通上游（${e.message}）—— 未作判定，先修通道再复测`); }
  console.log('');

  /* ── ④ 地区门：读出口 loc，再打一发地区敏感模型 ─────────────────────── */
  console.log('④ 地区门（Cloudflare trace 读出口 loc + 打一发地区敏感模型）');
  if (!opt.traceUrl || opt.traceUrl === 'none') {
    undecided('已跳过出口地区读取（读不到 loc 不影响本条判决：只看错误类型）');
  } else {
    try {
      const tr = await request(opt.traceUrl, { proxy: opt.proxy });
      const loc = (tr.text.match(/^loc=(\w+)/m) || [])[1] || '?';
      const ip = (tr.text.match(/^ip=(.+)$/m) || [])[1] || '';
      const masked = /^\d+\.\d+\./.test(ip) ? ip.replace(/^(\d+\.\d+)\..*/, '$1.x.x') : (ip ? ip.slice(0, 4) + '…' : 'n/a');
      undecided(`出口 loc=${loc} ip=${masked}`);
    } catch (e) {
      undecided(`出口地区读取失败（${e.message}）—— 不影响本条判决，只看错误类型`);
    }
  }
  let regionGate = 'n/a';
  try {
    const rr = await post('/chat/completions', freeBody(opt.regionModel), {});
    const t = errOf(rr.text);
    if (/RegionError/i.test(t)) { regionGate = 'blocked'; undecided(`${opt.regionModel} 撞地区门 —— 换出口**有意义**，换完必须重跑 ②`); }
    else if (/FreeTierError/i.test(t)) { regionGate = 'passed'; check(true, `${opt.regionModel} 地区门已过、撞客户端门 ⇒ 换出口**无效**`, t); }
    else undecided(`${opt.regionModel} → HTTP ${rr.status} ${t}`);
  } catch (e) { undecided(`地区敏感模型探测失败：${e.message}`); }
  console.log('');

  /* ── ⑤ go 面：会话是硬要求的直接证据 ──────────────────────────────── */
  console.log('⑤ go 面（"会话"是硬要求的直接证据）');
  try {
    const goBase = opt.base.replace(/\/zen\/v1$/, '/zen/go/v1');
    const r = await request(`${goBase}/chat/completions`, { method: 'POST', proxy: opt.proxy, body: freeBody(freeModel) });
    const t = errOf(r.text);
    check(/MissingSessionID/i.test(t), 'go 面点明 x-opencode-session（会话须服务端签发，编不出来）', `HTTP ${r.status} ${String(t).slice(0, 80)}`);
  } catch (e) { undecided(`go 面探测失败：${e.message}`); }
  console.log('');

  /* ── 判决 ─────────────────────────────────────────────────────────── */
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const nd = results.filter((r) => r.ok === null).length;
  const freeGate = kinds.every((k) => /FreeTierError/i.test(k)) && kinds.length === 3 ? 'client-only'
    : (kinds.some((k) => /RegionError/i.test(k)) ? 'region-first' : 'other');
  console.log(`判决：免费层=${freeGate} 地区门=${regionGate} 付费门=${paidGate}`);
  console.log(`判决探针：${results.length} 项，通过 ${pass}，失败 ${fail}，另有 ${nd} 项未作判定`);
  console.log('');
  console.log('读法（完整推理见 docs/opencode-reverse-proxy-research.md）：');
  console.log('  · 免费模型回 FreeTierError ⇒ **直连这条免费路径不可反代**：那道门认的是');
  console.log('    **客户端身份**，与密钥无关（带真实账号 token 逐字同结果，研究文档 §3/§4）。');
  console.log('    ★ 但**边车那条路是通的**：本机跑真客户端 `opencode serve` 即可拿到免费模型的答复。');
  console.log('      用 `node opencode-sidecar-probe.js` 验证（研究文档 §5）。');
  console.log('  · 付费模型回 401 AuthError ⇒ 付费面是标准 OpenAI 兼容，买 key 即可用现有 openai 渠道接。');
  console.log('  · 撞 RegionError ⇒ 只是出口地区问题，换出口后**必须重跑本探针**再下结论。');
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => { console.error('探针异常：', e && e.message); process.exitCode = 2; });
