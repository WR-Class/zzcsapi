/* test/opencode-sidecar-probe.test.js —— opencode **边车**判决探针的装配守卫 + 离线 e2e
   （零依赖；node test/opencode-sidecar-probe.test.js）

   为什么需要它：免费层的门是「**客户端身份**」——直连（fetch/curl/http2）永远是
   `403 FreeTierError`，与有没有凭据无关；而本机跑着的 `opencode serve` 本体是**通的**。
   这两种结论听起来互相矛盾（一个说"不行"、一个说"行"），分不清就会把结论整篇写反
   —— 本仓库 v1.18.70 那一版研究文档就是这么错的（把"**未登录**的真客户端被拒"
   读成了"真客户端被拒"）。而这个探针的全部价值，就是**把这两件事分开判决**。

   所以这里既守装配（源码层的纪律），也真起一个**假边车**把三种形态各跑一遍：
     · 形态 A：边车真答（口令逐字命中）        → 边车=passed，退出码 0
     · 形态 B：边车在但生成回 503（模型不可用） → 边车=blocked，退出码 1
     · 形态 C：边车连不上                      → 边车=undecided，**退出码仍为 0**
   ★ 关键断言：形态 B/C 都"没答出来"，但判决**必须不同**（blocked vs undecided）——
     "测不到" ≠ "这条路不通"，混为一谈就会把"没装 opencode"误报成"这条路被堵死"。

   ★ 另有一条安全断言：探针**绝不打印密码**。Basic 密码只从环境变量读，
     绝不进命令行（否则会落进 shell 历史）。用例断言输出里不含那个密码值。

   ⚠️ 全程不出网、不碰仓库 config.json / usage.json、不起真实 opencode、不需要凭据。 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'opencode-sidecar-probe.js');
const SRC = fs.readFileSync(PROBE, 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-oc-sidecar-'));
const PW_ENV = 'ZZ_OC_TEST_PW';
const PW = crypto.randomBytes(12).toString('base64url'); // 自设，用来验"绝不打印"

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}` + (detail !== undefined ? `  —— ${JSON.stringify(detail)}` : '')); }
}

/* ── 假边车：把 /openapi.json + /api/model + 建会话 + generate 摆出来 ────── */
const FREE = 'deepseek-v4.1-flash-free';
const PAID = 'deepseek-v4-pro';

function startFakeSidecar({ mode, password }) {
  let sessionSeq = 0;
  const sessionModel = new Map(); // 会话 → 模型（付费对照要靠它判）
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
      };
      // 鉴权：Basic opencode:<password>
      const want = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
      if (req.headers.authorization !== want) {
        return send(401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
      }
      if (req.method === 'GET' && url === '/openapi.json') return send(200, { openapi: '3.1.0', paths: {} });
      if (req.method === 'GET' && url === '/api/model') {
        return send(200, {
          location: { directory: 'x' },
          data: [FREE, PAID, 'cat-jam-free'].map((id) => ({ id, providerID: 'opencode' })),
        });
      }
      if (req.method === 'POST' && url === '/api/session') {
        let model = '';
        try { model = (JSON.parse(body).model || {}).id || ''; } catch {}
        const id = `ses_test${++sessionSeq}`;
        sessionModel.set(id, model);
        return send(200, { id, model });
      }
      if (req.method === 'POST' && /^\/api\/session\/[^/]+\/generate$/.test(url)) {
        const sid = url.split('/')[3];
        const usedModel = sessionModel.get(sid) || '';
        let prompt = '';
        try { prompt = JSON.parse(body).prompt || ''; } catch {}
        if (mode === 'ok') {
          // 付费模型如实失败 —— 用来验"免费那发不是空壳"
          if (usedModel === PAID) {
            return send(503, { _tag: 'ServiceUnavailableError', message: 'Upstream request failed: Insufficient account funds' });
          }
          // 把 prompt 里要求回显的口令**逐字**回出来（模拟真答）
          const nonce = (prompt.match(/[A-Z0-9]{6,}/) || [])[0] || 'ZZ';
          return send(200, { data: { text: nonce } });
        }
        if (mode === 'unavailable') {
          return send(503, { _tag: 'ServiceUnavailableError', message: `Model unavailable: opencode/${FREE}` });
        }
        if (mode === 'wrongtext') {
          return send(200, { data: { text: 'I cannot do that.' } });
        }
        return send(500, { message: 'boom' });
      }
      send(404, { _tag: 'NotFound', message: 'no such route' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/* ★ 必须**异步** spawn 并把输出重定向到文件：假边车就在本进程里，
   spawnSync 会阻塞本进程事件循环，假边车永不响应。
   同时避开受限沙箱里"管道 = 命名管道"的 EPERM 边界。 */
let seq = 0;
function runProbe(base, extra = [], env = {}) {
  return new Promise((resolve) => {
    const outPath = path.join(TMP, `sidecar-${++seq}.log`);
    const fd = fs.openSync(outPath, 'w');
    const child = spawn(process.execPath, [PROBE, '--base', base, ...extra],
      { stdio: ['ignore', fd, fd], windowsHide: true, env: { ...process.env, ...env } });
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
  console.log('══ §1 装配守卫（现抠 opencode-sidecar-probe.js 源码）');

  check('★ --base（测已有边车）必须同时给 --password-env，否则拒绝 —— 密码不许进命令行',
    /args\.passwordEnv/.test(SRC) && /--base 需要同时给 --password-env/.test(SRC));

  check('★ 密码只从环境变量读（process.env[envName]），且从不打印',
    /pw = process\.env\[envName\] \|\| ''/.test(SRC) && !/console\.log\([^)]*\bpw\b/.test(SRC));

  check('自起边车时密码自设（crypto.randomBytes），不是硬编码',
    /pw = crypto\.randomBytes\(\d+\)\.toString\('base64url'\)/.test(SRC));

  check('★ 用 OPENCODE_SERVER_PASSWORD 起边车（HTTP Basic），并隔离 CONFIG/CACHE',
    /OPENCODE_SERVER_PASSWORD: pw/.test(SRC) && /XDG_CONFIG_HOME/.test(SRC) && /XDG_CACHE_HOME/.test(SRC));

  // ★ v1.18.72 补：探针**必须自己设**这个环境变量，不能靠"不设 = 无鉴权"。
  //   实测：`opencode serve` 没有 `--password` 参数，环境变量是设口令的唯一入口；
  //   而**不设它，边车会自己随机生成一个口令并打进 stdout 日志**（"不设"≠"不用"），
  //   探针若忘了设就会吃 401 而误报成 blocked——这正是"两种 403 分不清"那类误判的同族。
  //   断言要落在**真正传给边车的 argv** 上（口令不许过命令行），而不是"整个文件不许出现
  //   `--password` 这个词"——后者会把头注释里那句"serve 没有 --password"的说明也一起逼掉
  //   （本用例第一版就这么写，被自己新加的头注释绊倒，32/1 失败）。
  const spawnArgs = (SRC.match(/spawn\(bin,\s*\[([^\]]*)\]/) || [, ''])[1];
  check('★ 探针自己设 OPENCODE_SERVER_PASSWORD（不是靠"不设 = 无鉴权"——不设则边车自造口令并打进日志）',
    /OPENCODE_SERVER_PASSWORD: pw/.test(SRC)
    && /'serve'/.test(spawnArgs) && !/password/i.test(spawnArgs),
    { spawnArgs: spawnArgs.slice(0, 100) });

  check('凭据库**只读大小**，绝不读内容',
    /fs\.statSync\(db\)/.test(SRC) && /只报大小，绝不读内容/.test(SRC));

  check('★ 口令是每次运行现生成的随机串（比"模型答了什么"更硬）',
    /'ZC' \+ crypto\.randomBytes/.test(SRC));

  check('★ 口令必须**逐字命中**才算通过（不是"有回复就算"）',
    /gen\.status === 200 && text\.includes\(nonce\)/.test(SRC));

  check('★ 200 但没命中口令 = blocked，不许算通过',
    /200 但没命中口令/.test(SRC));

  check('撞不到/起不来一律 undecided（"测不到"≠"不通"）',
    /record\('生成', 'undecided'/.test(SRC) && /record\('起边车', 'undecided'/.test(SRC));

  check('★ 付费对照存在（证明免费那发不是"什么都答"的空壳）',
    /付费对照/.test(SRC) && /PAID_CONTROL = 'deepseek-v4-pro'/.test(SRC));

  check('★ 判词是机器可读的一行（边车 / 目录 / 生成 三段）',
    /判决：边车=\$\{sidecarVerdict\} 目录=.* 生成=\$\{genVerdict\}/.test(SRC));

  check('退出码语义：有 blocked 才非 0（fail === 0 ? 0 : 1）',
    /process\.exitCode = fail === 0 \? 0 : 1/.test(SRC));

  check('★ 收尾不用硬 process.exit（Windows 上会与 libuv 句柄关闭竞态成 0xC0000409）',
    /收尾\*\*不用硬 process\.exit\*\*/.test(SRC) && !/^\s*process\.exit\(fail/m.test(SRC));

  check('★ 探针不需要也不读任何密钥值（不出现 .env / config.json / apiKey）',
    !/config\.json|apiKey/.test(SRC));

  check('★ 文件头写明"合规/封号风险"与"直连死、边车活"的区分',
    /封号风险|合规/.test(SRC) && /直连.*403|FreeTierError/.test(SRC));

  /* ── §2 真跑形态 A：边车真答 ──────────────────────────────────────────── */
  console.log('\n══ §2 真跑形态 A：边车在且真答（口令逐字命中）');
  let outA = '', codeA = null;
  {
    const sc = await startFakeSidecar({ mode: 'ok', password: PW });
    try {
      const base = `http://127.0.0.1:${sc.port}`;
      const r = await runProbe(base, ['--password-env', PW_ENV, '--model', FREE], { [PW_ENV]: PW });
      outA = r.out; codeA = r.code;
      check('探针正常退出（退出码 0 = 没有任何 blocked 项）', r.code === 0, { code: r.code, out: r.out.slice(0, 400) });
      check('★ 判词 = 边车=passed', /判决：边车=passed/.test(outA), outA.match(/判决：.*/)?.[0]);
      check('★ 生成=ok（口令逐字命中）', /生成=ok/.test(outA) && /逐字命中/.test(outA));
      check('目录读到了免费模型数', /目录=3 个模型\/1 个免费/.test(outA) || /\d+ 个模型，其中 \d+ 个/.test(outA));
      check('★ 付费对照给了通过项（付费如实失败 ⇒ 免费那发是真答）',
        /★ 付费对照\s+passed/.test(outA) && /如实失败/.test(outA));
      check('★ 输出里**不含**密码原文', !outA.includes(PW), '(密码泄露!)');
    } finally { sc.server.close(); }
  }

  /* ── §2 真跑形态 B：边车在，但生成 503 ──────────────────────────────── */
  console.log('\n══ §2 真跑形态 B：边车在但上游说模型不可用');
  let outB = '', codeB = null;
  {
    const sc = await startFakeSidecar({ mode: 'unavailable', password: PW });
    try {
      const base = `http://127.0.0.1:${sc.port}`;
      const r = await runProbe(base, ['--password-env', PW_ENV, '--model', FREE], { [PW_ENV]: PW });
      outB = r.out; codeB = r.code;
      check('★ 判词 = 边车=blocked（拿到了响应但形状不对 ⇒ 这才是失败）',
        /判决：边车=blocked/.test(outB), outB.match(/判决：.*/)?.[0]);
      check('★ 退出码 1（blocked 要能被 CI 抓住）', r.code === 1, { code: r.code });
      check('如实打印上游原文（Model unavailable）', /Model unavailable/.test(outB));
    } finally { sc.server.close(); }
  }

  /* ── §2 真跑形态 C：边车连不上 ───────────────────────────────────────── */
  console.log('\n══ §2 真跑形态 C：边车连不上（★ 不许记成"这条路不通"）');
  let outC = '';
  {
    const r = await runProbe('http://127.0.0.1:1', ['--password-env', PW_ENV, '--model', FREE], { [PW_ENV]: PW });
    outC = r.out;
    check('★ 判词 = 边车=undecided', /判决：边车=undecided/.test(outC), outC.match(/判决：.*/)?.[0]);
    check('★ 退出码仍为 0 —— "测不到"不是"被堵死"', r.code === 0, { code: r.code });
    check('如实说明 undecided ≠ 不通', /测不到.*不等于.*不通|undecided ≠ 这条路不通/.test(outC));
  }

  /* ── §3 分辨力：三种形态的判词必须互不相同 ───────────────────────────── */
  console.log('\n══ §3 分辨力对照');
  check('★ A=passed / B=blocked / C=undecided 三态互不相同（探针真有分辨力）',
    /边车=passed/.test(outA) && /边车=blocked/.test(outB) && /边车=undecided/.test(outC));
  check('★ B 与 C 都是"没答出来"，但判决必须不同（这是本探针存在的理由）',
    /边车=blocked/.test(outB) && !/边车=blocked/.test(outC) && codeB !== 0);

  /* ── §4 稳健性：200 但答非所问 ─────────────────────────────────────── */
  console.log('\n══ §4 稳健性：200 但没命中口令');
  {
    const sc = await startFakeSidecar({ mode: 'wrongtext', password: PW });
    try {
      const base = `http://127.0.0.1:${sc.port}`;
      const r = await runProbe(base, ['--password-env', PW_ENV, '--model', FREE], { [PW_ENV]: PW });
      check('★ 200 但答非所问判 blocked（不许"有回复就通过"）',
        /判决：边车=blocked/.test(r.out), r.out.match(/判决：.*/)?.[0]);
      check('退出码 1', r.code === 1, { code: r.code });
    } finally { sc.server.close(); }
  }

  /* ── §5 无 --password-env 时拒绝（不许把密码塞命令行） ──────────────── */
  console.log('\n══ §5 无 --password-env 时拒绝');
  {
    const r = await runProbe('http://127.0.0.1:1', ['--model', FREE]);
    check('★ 缺 --password-env 时如实拒绝并给 undecided（不猜密码）',
      /需要同时给 --password-env/.test(r.out) && /边车=undecided/.test(r.out), r.out.slice(0, 200));
  }

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('!! 用例异常:', (e && e.stack) || e); process.exitCode = 1; });
