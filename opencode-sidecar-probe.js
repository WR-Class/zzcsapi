#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   opencode **边车**判决探针（只读，低额度，报告绝不回显任何凭据）

   存在的理由：opencode 免费层的门是"**客户端身份**"，不是密钥 ——
   拿真实账号 token + 真客户端逐字报文从普通 HTTP 打，永远是
   `403 FreeTierError`（见 docs/opencode-reverse-proxy-research.md §3/§4）。
   但同一台机器上，**跑着的 `opencode serve` 本体是通的**（§5）。
   这两种结论听起来矛盾：一个说"直连不行"、一个说"边车可行"，
   分不清就会像 v1.18.70 那一版一样把整篇结论写反（§9 误判 #4）。

   它按层分开打，并给出可复现的判决：
     ① 起边车    自己起一个**临时** `opencode serve`（自设密码、随机空闲端口、
                 隔离 XDG_CONFIG/CACHE，**只用真实凭据库**），就绪即测
     ② 目录      GET /api/model —— 边车看到多少个模型 / 多少个 `-free`
     ③ 凭据      `~/.local/share/opencode/opencode.db` 在不在（**只报大小，不读内容**）
     ④ 生成      POST /api/session 建会话 + POST /api/session/{id}/generate 打一发
                 随机口令 —— **口令逐字命中**才算"边车这条路通"
                 口令每次运行现生成，比"模型答了个什么"更硬（排除缓存/模板回话）
     ⑤ 付费对照  同一会话面打一个付费模型 —— 期望明确失败（`Insufficient account funds`
                 或 `Model unavailable`），用来证明第 ④ 步不是"什么都答"的空壳

   用法：
     node opencode-sidecar-probe.js [--bin <path>] [--port <n>] [--model <id>]
                                    [--base <url>] [--password-env <NAME>]

     （默认）自己起边车：需要一个 opencode 可执行文件（`PATH` 上的 `opencode`，
             或 `--bin` 指定）。首次会花几秒起进程。
     --base  探测**已经在跑**的边车（如 `http://127.0.0.1:49551`）。
             这时必须用 `--password-env ZZ_OC_PW` 给出 Basic 密码所在的环境变量名 ——
             **密码只从环境变量读，绝不写进命令行历史、也绝不被打印**。
             ★ 起边车时探针**必须自己设** OPENCODE_SERVER_PASSWORD —— **不能**指望"不设就是无鉴权"。
               实测：`opencode serve --help` **没有** `--password` 这类参数（环境变量是设口令的唯一入口），
               而**不设它，边车会自己随机生成一个口令并打进 stdout 日志**（"不设"≠"不用"）。
               忘了设就只会吃 401 而把这条路误报成 blocked —— 与"两种 403 分不清"是同族的误判。
     --model 默认 deepseek-v4.1-flash-free

   判决行（机器可读）：
     判决：边车=<passed|blocked|undecided> 目录=<n 个模型/n 个免费> 生成=<ok|fail|->

   ⚠️ 撞"上游连不上 / 起不来"一律记 **undecided**（"测不到"≠"这条路不通"），
      只有"拿到了响应但形状不对"才算失败（blocked）。
   ⚠️ 合规：把第三方流量中继进免费层**不是该层的设计用途**，官方也明说免费是
      limited time ⇒ 有封号风险。探针只做判决，不替你决定要不要上生产。
   额度：一发 `generate` + 一发付费对照 —— 都极短，不跑长对话。
   凭据：探针**不打印**任何密钥/token/密码；`opencode.db` 只报存在与大小。
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_MODEL = 'deepseek-v4.1-flash-free';
const PAID_CONTROL = 'deepseek-v4-pro';

const HELP = `opencode 边车判决探针（只读，低额度）
  node opencode-sidecar-probe.js [--bin <path>] [--port <n>] [--model <id>]
                                 [--base <url>] [--password-env <NAME>]
  （默认）自己起一个临时 opencode serve 来测
  --base + --password-env  改为测一个**已经在跑**的边车
  --model  默认 ${DEFAULT_MODEL}
详见文件头注释与 docs/opencode-reverse-proxy-research.md`;

function parseArgs(argv) {
  const out = { bin: '', port: 0, model: DEFAULT_MODEL, base: '', passwordEnv: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bin') out.bin = argv[++i] || '';
    else if (a === '--port') out.port = parseInt(argv[++i], 10) || 0;
    else if (a === '--model') out.model = argv[++i] || DEFAULT_MODEL;
    else if (a === '--base') out.base = (argv[++i] || '').replace(/\/+$/, '');
    else if (a === '--password-env') out.passwordEnv = argv[++i] || '';
    else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
  }
  return out;
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function credentialDbInfo() {
  const db = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  try {
    const st = fs.statSync(db);
    return { exists: true, size: st.size }; // 只报大小，绝不读内容
  } catch { return { exists: false, size: 0 }; }
}

/* 出网一律 `Connection: close`：不留 keep-alive 套接字。
   为什么在意：本探针收尾**不用硬 process.exit**（见文件尾注释），
   留着 keep-alive 连接会把进程多吊住几秒。 */
async function jfetch(base, pw, method, p, body) {
  const headers = { 'Content-Type': 'application/json', Connection: 'close' };
  if (pw) headers.Authorization = 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64');
  const r = await fetch(base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  const record = (name, verdict, detail) => {
    results.push({ name, verdict, detail });
    const mark = verdict === 'passed' ? '★' : verdict === 'blocked' ? '✗' : '?';
    console.log(`  ${mark} ${name.padEnd(10)} ${verdict.padEnd(10)} ${detail}`);
  };

  console.log('opencode 边车判决探针（只读，低额度）');
  console.log('  结论依据：docs/opencode-reverse-proxy-research.md §4/§5\n');

  const cred = credentialDbInfo();
  console.log(`  凭据库：${cred.exists ? `存在（${cred.size} 字节，内容不读）` : '不存在'}`);
  console.log(`  边车目录：${cred.exists ? '有登录态，模型清单应含付费模型' : '无登录态，模型清单只剩免费那批'}\n`);

  let child = null;
  let base = args.base;
  let pw = '';
  const ownTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-oc-sidecar-'));

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (child) child.kill(); } catch {}
    try { fs.rmSync(ownTmp, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  /* 判词只有一个出口：早退路径也要走它，否则"连不上"那条会没有解释行，
     读者就分不清 undecided 与 blocked。 */
  const printVerdict = (sidecarVerdict, models, genVerdict) => {
    const freeN = models.filter((m) => /-free$/.test(m)).length;
    const fail = results.filter((r) => r.verdict === 'blocked').length;
    const undec = results.filter((r) => r.verdict === 'undecided').length;
    const dirText = models.length ? `${models.length} 个模型/${freeN} 个免费` : '-';
    console.log('\n' + '─'.repeat(66));
    console.log(`判决：边车=${sidecarVerdict} 目录=${dirText} 生成=${genVerdict}`);
    console.log(`判决探针：${results.length} 项，通过 ${results.length - fail - undec}，失败 ${fail}，另有 ${undec} 项未作判定`);
    if (sidecarVerdict === 'passed') {
      console.log('  ⇒ 这台机器上 **边车这条路是通的**：可接入网关（需新协议，见研究文档 §10）。');
      console.log('  ⚠️ 合规提醒：把第三方流量中继进免费层并非该层的设计用途，且有封号风险（研究文档文首）。');
    } else if (sidecarVerdict === 'blocked') {
      console.log('  ⇒ 边车在，但**这一发没答出来**：看上面"生成"那行，多半是模型名不对或上游额度。');
      console.log('  ⚠️ 注意：这与"直连免费层"是两回事 —— 直连永远是 403 FreeTierError（§3）。');
    } else {
      console.log('  ⇒ 未作判定：多半是没装 opencode / 端口被占 / 连不上。');
      console.log('     **"测不到"不等于"这条路不通"** —— 别把 undecided 读成 blocked。');
    }
    process.exitCode = fail === 0 ? 0 : 1;
  };

  // ── 取 base / 起边车 ────────────────────────────────────────────────────
  if (!base) {
    const bin = args.bin || 'opencode';
    if (!args.port) args.port = await freePort();
    pw = crypto.randomBytes(18).toString('base64url'); // 自设，绝不打印
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: path.join(ownTmp, 'cfg'),
      XDG_CACHE_HOME: path.join(ownTmp, 'cache'),
      OPENCODE_SERVER_PASSWORD: pw,
    };
    for (const d of ['cfg', 'cache', 'work']) fs.mkdirSync(path.join(ownTmp, d), { recursive: true });
    let logFd = null;
    try { logFd = fs.openSync(path.join(ownTmp, 'serve.log'), 'w'); } catch {}
    try {
      child = spawn(bin, ['serve', '--port', String(args.port), '--hostname', '127.0.0.1'],
        { cwd: path.join(ownTmp, 'work'), env, stdio: ['ignore', logFd, logFd] });
    } catch (e) {
      record('起边车', 'undecided', `起不来：${e.message.slice(0, 60)}（用 --bin 指定可执行文件）`);
      printVerdict('undecided', [], '-');
      return;
    }
    base = `http://127.0.0.1:${args.port}`;
    let ready = false;
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(base + '/openapi.json', {
          headers: { Authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') },
        });
        if (r.status === 200) { ready = true; break; }
      } catch {}
    }
    if (!ready) {
      const tail = (() => { try { return fs.readFileSync(path.join(ownTmp, 'serve.log'), 'utf8').slice(-260); } catch { return ''; } })();
      record('起边车', 'undecided', `启动超时/失败${tail ? '：' + tail.replace(/\s+/g, ' ').slice(0, 120) : ''}`);
      printVerdict('undecided', [], '-');
      return;
    }
    record('起边车', 'passed', `${base}（密码自设，未打印）`);
  } else {
    const envName = args.passwordEnv;
    if (!envName) {
      console.log('  ✗ --base 需要同时给 --password-env <NAME>（密码只从环境变量读，不进命令行历史）');
      printVerdict('undecided', [], '-');
      return;
    }
    pw = process.env[envName] || '';
    if (!pw) {
      console.log(`  ✗ 环境变量 ${envName} 为空`);
      printVerdict('undecided', [], '-');
      return;
    }
    try {
      const r = await fetch(base + '/openapi.json', {
        headers: { Connection: 'close', Authorization: 'Basic ' + Buffer.from(`opencode:${pw}`).toString('base64') },
      });
      if (r.status !== 200) {
        record('连边车', 'blocked', `${base} → HTTP ${r.status}（鉴权或端口不对）`);
        printVerdict('blocked', [], '-');
        return;
      }
      record('连边车', 'passed', base);
    } catch (e) {
      record('连边车', 'undecided', `连不上：${e.message.slice(0, 60)}`);
      printVerdict('undecided', [], '-');
      return;
    }
  }

  // ── ② 目录 ──────────────────────────────────────────────────────────────
  let models = [];
  try {
    const r = await jfetch(base, pw, 'GET', '/api/model');
    if (r.status === 200 && r.json) {
      models = (Array.isArray(r.json) ? r.json : (r.json.data || [])).map(m => m.id).filter(Boolean);
    }
    const freeN = models.filter(m => /-free$/.test(m)).length;
    if (models.length) record('目录', 'passed', `${models.length} 个模型，其中 ${freeN} 个 \`-free\``);
    else record('目录', 'blocked', `形状不对：HTTP ${r.status} ${r.text.slice(0, 70)}`);
  } catch (e) {
    record('目录', 'undecided', `打不到：${e.message.slice(0, 60)}`);
  }

  // ── ③ 目标模型在不在边车目录里 ──────────────────────────────────────────
  if (models.length) {
    if (models.includes(args.model)) record('目标模型', 'passed', `${args.model} 在目录里`);
    else record('目标模型', 'blocked', `${args.model} 不在边车目录里 —— 换一个（见 --model）`);
  }

  // ── ④ 生成（随机口令，逐字命中才算通）──────────────────────────────────
  const nonce = 'ZC' + crypto.randomBytes(3).toString('hex').toUpperCase();
  let genVerdict = 'undecided';
  try {
    const ses = await jfetch(base, pw, 'POST', '/api/session', {
      model: { id: args.model, providerID: 'opencode' },
    });
    const sid = ses.json && (ses.json.id || ses.json.sessionID || (ses.json.data && ses.json.data.id));
    if (!sid) {
      record('生成', 'blocked', `建会话失败：HTTP ${ses.status} ${ses.text.slice(0, 80)}`);
      genVerdict = 'fail';
    } else {
      const gen = await jfetch(base, pw, 'POST', `/api/session/${sid}/generate`, {
        prompt: `Reply with exactly this token and nothing else: ${nonce}`,
      });
      const text = (gen.json && gen.json.data && gen.json.data.text) || '';
      if (gen.status === 200 && text.includes(nonce)) {
        record('生成', 'passed', `口令 ${nonce} 逐字命中`);
        genVerdict = 'ok';
      } else if (gen.status === 200) {
        record('生成', 'blocked', `200 但没命中口令：${JSON.stringify(text).slice(0, 70)}`);
        genVerdict = 'fail';
      } else {
        record('生成', 'blocked', `HTTP ${gen.status} ${gen.text.slice(0, 90)}`);
        genVerdict = 'fail';
      }
    }
  } catch (e) {
    record('生成', 'undecided', `打不到：${e.message.slice(0, 60)}`);
  }

  // ── ⑤ 付费对照（证明第 ④ 步不是"什么都答"的空壳）──────────────────────
  if (genVerdict === 'ok' && models.includes(PAID_CONTROL)) {
    try {
      const ses = await jfetch(base, pw, 'POST', '/api/session', {
        model: { id: PAID_CONTROL, providerID: 'opencode' },
      });
      const sid = ses.json && (ses.json.id || ses.json.sessionID || (ses.json.data && ses.json.data.id));
      if (sid) {
        const gen = await jfetch(base, pw, 'POST', `/api/session/${sid}/generate`, { prompt: 'hi' });
        const ok = gen.status === 200 && (gen.json && gen.json.data && gen.json.data.text);
        if (ok) record('付费对照', 'undecided', `${PAID_CONTROL} 居然也通了 —— 免费结论需复核`);
        else record('付费对照', 'passed', `${PAID_CONTROL} 如实失败（HTTP ${gen.status}），说明免费那发是真答`);
      } else {
        record('付费对照', 'blocked', `建会话失败：HTTP ${ses.status}`);
      }
    } catch (e) {
      record('付费对照', 'undecided', `打不到：${e.message.slice(0, 60)}`);
    }
  }

  const sidecarVerdict = results.some(r => r.name === '生成' && r.verdict === 'passed') ? 'passed'
    : results.some(r => r.name === '生成' && r.verdict === 'blocked') ? 'blocked'
      : 'undecided';
  printVerdict(sidecarVerdict, models, genVerdict);
  cleanup();
}

/* ⚠️ 收尾**不用硬 process.exit**：在 Windows 上，带着未关闭的套接字/子进程硬退
   会和 libuv 的句柄关闭竞态，退出码变成 0xC0000409（=3221226505），
   把"全过的探针"报成崩溃。改为置 process.exitCode 让它自然退出
   （配合上面的 `Connection: close`，不会被 keep-alive 拖住）。 */
main().catch((e) => {
  console.error('探针异常：', e && e.message);
  process.exitCode = 2;
});
