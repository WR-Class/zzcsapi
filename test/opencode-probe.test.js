/* test/opencode-probe.test.js —— opencode 免费层判决探针的装配守卫 + 离线 e2e
   （零依赖；node test/opencode-probe.test.js）

   为什么需要它：`opencode-probe.js` 的价值全在「**分得清两种 403**」这一件事上——
     · RegionError   → 换出口**有意义**（这一发根本没走到客户端门）
     · FreeTierError → 换出口**无效**（客户端门）
   而这两种 403 在控制台里都只是"渠道故障"。如果探针哪天把 RegionError 记成"失败/不通过"，
   或者把 br 压缩体当乱码（"自己没读懂"被读成"上游没回"），它就会**给出反向的结论**，
   而这种错误没有任何人眼看得出来（两种都长成一行红字）。
   所以这里既守装配（源码层的判别与纪律），也真起一个假上游把两种形态各跑一遍。

   ⚠️ 全程不碰网络、不碰仓库 config.json / usage.json、不需要任何密钥。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'opencode-probe.js');
const SRC = fs.readFileSync(PROBE, 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-oc-probe-'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}` + (detail !== undefined ? `  —— ${JSON.stringify(detail)}` : '')); }
}

/* ── 假上游：把两种 403 + 付费门 + go 面 + trace 都摆出来 ───────────────── */
const MODELS = {
  object: 'list',
  data: [
    'big-pickle', 'cat-jam-free', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free',
    'glm-5.1', 'deepseek-v4-flash', 'claude-sonnet-4-6',
  ].map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
};

function startFakeUpstream({ freeError }) {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => {
        const s = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(s);
      };
      if (req.method === 'GET' && url === '/zen/v1/models') return send(200, MODELS);
      if (req.method === 'GET' && url === '/cdn-cgi/trace') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('fl=1\nip=103.62.11.22\nloc=JP\n');
      }
      if (req.method === 'POST' && url === '/zen/go/v1/chat/completions') {
        return send(400, { type: 'error', error: { type: 'MissingSessionID', message: 'Request is missing x-opencode-session and cannot be routed efficiently.' } });
      }
      if (req.method === 'POST' && url === '/zen/v1/chat/completions') {
        let model = '';
        try { model = JSON.parse(body).model || ''; } catch {}
        const isFree = /free/.test(model) || model === 'big-pickle';
        if (isFree) return send(403, { type: 'error', error: { type: freeError, message: freeError === 'RegionError' ? 'This model is not available in your country' : "OpenCode's free tier can only be used from within OpenCode." } });
        return send(401, { type: 'error', error: { type: 'AuthError', message: 'Missing API key.' } });
      }
      send(404, { type: 'error', error: { type: 'NotFound', message: 'no such route' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ★ 必须**异步**跑探针，不能用 spawnSync：假上游就在本进程里，
   而 spawnSync 会阻塞本进程的事件循环 —— 于是假上游永远不响应，
   子进程一直等，最后超时被 kill（status=null、输出全丢）。
   同时把子进程输出**重定向到文件**而不是管道：既避开管道缓冲上限，
   也避开受限沙箱里"管道 = 命名管道"的 EPERM 边界（本仓库踩过的坑）。 */
let seq = 0;
function runProbe(base, extra = []) {
  return new Promise((resolve) => {
    const outPath = path.join(TMP, `probe-${++seq}.log`);
    const fd = fs.openSync(outPath, 'w');
    const child = spawn(process.execPath, [PROBE, '--base', `${base}/zen/v1`, '--trace-url', `${base}/cdn-cgi/trace`, ...extra],
      { stdio: ['ignore', fd, fd], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      try { fs.closeSync(fd); } catch {}
      let out = '';
      try { out = fs.readFileSync(outPath, 'utf8'); } catch {}
      resolve({ code, signal, out });
    });
  });
}

(async () => {
  console.log('══ §1 装配守卫（现抠 opencode-probe.js 源码）');

  check('★ 两种 403 分开判别（RegionError→blocked 与 FreeTierError→passed 是两条不同分支）',
    /if \(\/RegionError\/i\.test\(t\)\) \{ regionGate = 'blocked'/.test(SRC) &&
    /else if \(\/FreeTierError\/i\.test\(t\)\) \{ regionGate = 'passed'/.test(SRC));

  check('② 也分两种：三条同结果才判 client-only，出现 RegionError 一律判 region-first',
    SRC.includes(String.raw`freeGate = kinds.every((k) => /FreeTierError/i.test(k)) && kinds.length === 3 ? 'client-only'`) &&
    SRC.includes(String.raw`: (kinds.some((k) => /RegionError/i.test(k)) ? 'region-first' : 'other')`));

  check('★ 撞地区门记「未作判定」而不是失败（regionGate = \'blocked\' 走 undecided）',
    /regionGate = 'blocked'; undecided\(/.test(SRC));

  check('地区门过了才给通过项（regionGate = \'passed\' 走 check(true)）',
    /regionGate = 'passed'; check\(true/.test(SRC));

  check('三条凭据变体齐（不带凭据 / Bearer public / Bearer 乱码 key）',
    SRC.includes("['不带凭据', {}]") && /Bearer public/.test(SRC) && /'Bearer sk-' \+ 'A'\.repeat\(60\)/.test(SRC));

  check('★ 三条同结果才算「这一路不校验密钥」（uniq.length === 1）',
    /uniq\.length === 1 && \/FreeTierError\/i\.test/.test(SRC));

  check('★ 代理分支带 Accept-Encoding: identity（br 体不解压会被当成"上游没回"）',
    /'Accept-Encoding: identity'/.test(SRC));

  check('付费门按 401/AuthError 判（说明付费面只缺一枚 key）',
    /r\.status === 401 \|\| \/AuthError\/i\.test\(t\)/.test(SRC));

  check('go 面按 MissingSessionID 判（会话须服务端签发）',
    /\/MissingSessionID\/i\.test\(t\)/.test(SRC));

  check('判词是机器可读的一行（免费层 / 地区门 / 付费门 三段）',
    /判决：免费层=\$\{freeGate\} 地区门=\$\{regionGate\} 付费门=\$\{paidGate\}/.test(SRC));

  check('★ 探针不需要也不读任何凭据（不出现 .env / config.json / apiKey）',
    !/require\(.*\.env|config\.json|apiKey/.test(SRC));

  check('退出码语义：有失败才非 0（fail === 0 ? 0 : 1）',
    /process\.exitCode = fail === 0 \? 0 : 1/.test(SRC));

  /* ★ v1.18.72：本探针只测**直连面**，而"直连是死的 / 没有收敛点"这句话**已被推翻**
     （v1.18.71 就是那么写错的：它把"我们没构造那三样条件"读成了"这条路不通"）。
     文件头必须把两件事同时讲清，否则下一个人会把"探针恒 403"again 读成"这条路不通"：
       ① 这里的 403 是**探针刻意不构造**那三样条件的结果，**不是路的判词**（路其实是通的）；
       ② 网关接入走边车探针，并指向结论档。
     ⚠️ 特意加一条**否定断言**（不许再出现"没有收敛点"）——只加肯定断言挡不住旧话复发。 */
  check('★ 文件头说清"缺条件才 403"、且不再写"直连是死的 / 没有收敛点"（v1.18.71 就是那么写错的）',
    /刻意不构造/.test(SRC) && /能通|其实是通的/.test(SRC) && !/没有收敛点/.test(SRC));

  check('★ 文件头指向边车探针与结论档（直连 / 边车的区分不许丢）',
    /opencode-sidecar-probe\.js/.test(SRC) && /opencode-reverse-proxy-research\.md/.test(SRC));

  check('--trace-url 可注入（离线 e2e 的前提，不得硬编码到打不掉的地址）',
    /'--trace-url'/.test(SRC) && /opt\.traceUrl === 'none'/.test(SRC));

  /* ── §2 真跑：形态 A —— 直连免费层（永远 403，与凭据无关） ──────────── */
  console.log('\n══ §2 真跑形态 A：免费=FreeTierError、付费=401、go=MissingSessionID');
  let outA = '';
  let outB = '';
  {
    const up = await startFakeUpstream({ freeError: 'FreeTierError' });
    try {
      const base = `http://127.0.0.1:${up.port}`;
      const r = await runProbe(base);
      outA = r.out;
      check('探针正常退出（退出码 0 = 没有任何"失败"项）', r.code === 0, { code: r.code, signal: r.signal, out: r.out.slice(0, 300) });
      check('★ 判词 = 免费层 client-only（三条凭据同结果，是客户端门）',
        /判决：免费层=client-only/.test(outA), outA.match(/判决：.*/)?.[0]);
      check('★ 判词 = 地区门 passed（JP 出口过了地区门，撞客户端门 ⇒ 换出口无效）',
        /地区门=passed/.test(outA), outA.match(/判决：.*/)?.[0]);
      check('判词 = 付费门 key-required（付费面可用，只缺 key）',
        /付费门=key-required/.test(outA), outA.match(/判决：.*/)?.[0]);
      check('目录读到 7 个模型 / 4 个免费候选（big-pickle 也算免费，见 §1 过滤器）',
        /GET \/models 可读（7 个）/.test(outA) && /免费候选 4 个/.test(outA));
      check('三条凭据变体都如实打印了 FreeTierError', (outA.match(/FreeTierError/g) || []).length >= 3);
      check('go 面那条给了通过项', /✓ go 面点明 x-opencode-session/.test(outA));
      check('出口 loc 被如实读出（JP）', /出口 loc=JP/.test(outA));
      check('★ 没有任何"失败"项（失败 0）', /失败 0/.test(outA));
    } finally { up.server.close(); }
  }

  /* ── §2 真跑：形态 B —— 地区门先拦（本机 CN 出口的真实形态）──────────── */
  console.log('\n══ §2 真跑形态 B：免费模型先撞地区门（★ 不许记成失败）');
  {
    const up = await startFakeUpstream({ freeError: 'RegionError' });
    try {
      const base = `http://127.0.0.1:${up.port}`;
      const r = await runProbe(base);
      outB = r.out;
      check('★ 退出码仍然是 0 —— 撞地区门不是"探针失败"，是"这一发没走到客户端门"',
        r.code === 0, { code: r.code, signal: r.signal });
      check('★ 判词 = 免费层 region-first', /免费层=region-first/.test(outB), outB.match(/判决：.*/)?.[0]);
      check('★ 判词 = 地区门 blocked，且提示"换出口有意义"', /地区门=blocked/.test(outB) && /换出口\*\*有意义\*\*/.test(outB));
      check('★ 第二节如实说明"不足以判决客户端门，请换出口重跑"',
        /先撞\*\*地区门\*\*/.test(outB), outB.split('\n').find((l) => l.includes('地区门')));
      check('失败仍为 0（未作判定不计入失败）', /失败 0/.test(outB));
      check('未作判定项 ≥ 3（候选清单 + loc + 地区门）', Number((outB.match(/另有 (\d+) 项未作判定/) || [])[1] || 0) >= 3);
      check('★ 对照：形态 A 给出"客户端门"判决，形态 B 不给 —— 探针真有分辨力',
        /免费层=client-only/.test(outA) && /免费层=region-first/.test(outB) && !/免费层=client-only/.test(outB));
    } finally { up.server.close(); }
  }

  /* ── §3 健壮性：上游根本连不上时不许崩 ─────────────────────────────── */
  console.log('\n══ §3 健壮性：上游不可达');
  {
    const r = await runProbe('http://127.0.0.1:1', ['--trace-url', 'none']);
    check('探针不因连不上而上抛（仍走完并给判词）', r.code !== 2 && /判决：免费层=/.test(r.out), { code: r.code, out: r.out.slice(0, 200) });
    check('连不上时"失败"仍为 0（连不上 = 未作判定，不是渠道被判死）', /失败 0/.test(r.out));
    check('--trace-url none 时如实报跳过（不假装读到了 loc）', /已跳过出口地区读取/.test(r.out));
  }

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('!! 用例异常:', (e && e.stack) || e); process.exitCode = 1; });
