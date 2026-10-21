/**
 * test/config-atomic-write-e2e.test.js — 配置落盘的原子性与启动自愈（v1.18.85）
 *
 * 为什么要这个用例（不是"函数存在"的仪式，而是一类**尚未触发但会致命**的现场）：
 *   `persistConfig` 长期用裸 `fs.writeFileSync(CONFIG_PATH, ...)` 直接覆盖正主文件。进程在写盘中途
 *   被 kill（控制台保存、一键回滚、Ctrl+C 撞在同一毫秒）或磁盘在这几 KB 上写满，盘上留下的就是
 *   **半截 JSON**。而 `loadConfig` 里 `JSON.parse` 没有兜底 —— 于是"上一次保存被打断"直接变成
 *   "网关起不来"，报错还是 `Unexpected end of JSON input`，离真因很远。
 *
 *   本项目其实早就知道这个模式：`writeHistoryIndex` 一直是 tmp + rename（注释还写着"半截索引比
 *   没有索引更难查"）。**索引用了，正主忘了用。** 本用例就是把这个缺口焊死。
 *
 * 四条断言主线（都必须是真链路，不能只看源码里有没有那个词）：
 *   ① 保存一次之后，目录里**没有** `.tmp` 残留，且 config.json 是完整合法 JSON；
 *   ② 正主被写坏 → 重启能**从 config.json.bak 恢复**并自愈写回，坏文件留档 `.corrupt-*`；
 *   ③ `.bak` 也坏 → 重启能**从代际快照恢复**（v1.18.83 每代都是整份原文）；
 *   ④ 全部退路都坏 → **必须报错退出**（绝不能静默用空配置起来，那等于把用户渠道全丢了还说成功）。
 *
 * 跑法：node test/config-atomic-write-e2e.test.js   （退出码非 0 表示有回归）
 * 零依赖、零外网：假上游起在动态端口，配置/历史/用量全部落在临时目录，**绝不动仓库的 config.json**。
 */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-atomic-'));
const GW_KEY = 'atom-gw', AD_KEY = 'atom-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const tmpLeftovers = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')); } catch { return []; } };
const corruptFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => /\.corrupt-/.test(f)); } catch { return []; } };

(async () => {
  /* ══════════ 0. 装配守卫（源码结构；跑真链路之前先确保"判据本身"没被改坏） ══════════ */
  console.log('0. 装配守卫');
  {
    const fnStart = SRC.indexOf('function writeFileAtomic(');
    check('writeFileAtomic 存在', fnStart > 0);
    const fnBody = fnStart > 0 ? SRC.slice(fnStart, SRC.indexOf('\n}\n', fnStart)) : '';
    check('★ tmp 与目标**同目录**（跨盘 rename 会退化成 copy+unlink，中途失败照样半截）',
      /path\.dirname\(target\)/.test(fnBody) && /path\.join\(dir,/.test(fnBody));
    check('★ 先 fsync 再 rename（否则断电可能拿到"长度对、内容空"的文件）',
      fnBody.indexOf('fsyncSync') > 0 && fnBody.indexOf('fsyncSync') < fnBody.indexOf('renameSync'));
    check('★ 失败时清理 tmp（别在目录里越堆越多）', /unlinkSync\(tmp\)/.test(fnBody));
    // 全仓不再有"裸写 config.json / usage.json / 历史索引"。
    // 必须剥掉**块注释**再找——本用例第一版只按行首 `//`/`*` 过滤，漏掉了块注释里的续行
    // （writeFileAtomic 的说明注释里就引着 `fs.writeFileSync(CONFIG_PATH, ...)` 当反例），把自己误报成失败。
    const codeLines = (() => {
      const out = [];
      let inBlock = false;
      for (const l of SRC.split('\n')) {
        const t = l.trim();
        if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
        if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
        if (t.startsWith('//')) continue;
        out.push(l);
      }
      return out;
    })();
    const bareWrites = codeLines.filter((l) => /fs\.writeFileSync\((CONFIG_PATH|USAGE_PATH|HISTORY_INDEX|snapshotPath\()/.test(l));
    check('★ 配置 / 用量 / 历史索引 / 代际快照四处落盘都改走原子写（无裸 writeFileSync）',
      bareWrites.length === 0, bareWrites);
    check('loadConfig 走 readConfigWithFallback（而不是直接 JSON.parse 正主）',
      /function loadConfig[\s\S]{0,1200}?readConfigWithFallback\(\)/.test(SRC));
    check('★ 启动恢复顺序：正主 → .bak → 代际快照（后两者都在 readConfigWithFallback 里）',
      /function readConfigWithFallback[\s\S]{0,2500}?CONFIG_PATH \+ '\.bak'[\s\S]{0,1500}?gen-/.test(SRC));
    check('★ 恢复后把好版本原子写回正主（否则每次重启都要再走一遍退路）',
      /from !== 'main'[\s\S]{0,1200}?writeFileAtomic\(CONFIG_PATH/.test(SRC));
    check('★ 坏文件留档 .corrupt-<时间戳>（不直接覆盖掉现场）', /\.corrupt-/.test(SRC));
    check('HISTORY_DIR 与 loadConfig 用的是同一个来源（CONFIG_HISTORY_DIR），不重复算两遍',
      /const HISTORY_DIR = CONFIG_HISTORY_DIR;/.test(SRC) && /const CONFIG_HISTORY_DIR =/.test(SRC));
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('★ 临时文件与坏文件留档都 gitignore（两者都含明文渠道 key）',
      /^\.\*\.tmp$/m.test(gi) && /^\*\.corrupt-\*$/m.test(gi), gi.split('\n').filter((l) => /tmp|corrupt/.test(l)));
  }

  /* ══════════ 1b. 目标不可替换（Docker 单文件挂载）必须降级，不许把进程打挂 ══════════
     这是容器实测抓到的真回归：`-v ./config.json:/app/config.json` 让容器里那个路径成为**挂载点**，
     `rename()` 到它必然 EBUSY。第一版没兜住 → "点一次保存渠道 → 网关 Exited(1)"。
     这里用 vm 把**源码里那段函数**原样抠出来、注入会抛 EBUSY 的假 fs，确定性复现（不依赖平台）。 */
  console.log('\n1b. rename 不可用（EBUSY）→ 降级原地覆写');
  {
    const vm = require('vm');
    const fnStart = SRC.indexOf('function writeFileAtomic(');
    const fnEnd = SRC.indexOf('\n}\n', fnStart) + 3;
    const fnSrc = SRC.slice(fnStart, fnEnd);
    check('能从源码里抠出完整的 writeFileAtomic 函数', fnSrc.length > 200 && fnSrc.trim().endsWith('}'));

    function runWith(renameErr) {
      const calls = { opens: [], writes: [], renamed: [], unlinked: 0, logs: [] };
      const fakeFs = {
        openSync(p, flags) { calls.opens.push([p, flags]); return calls.opens.length; },
        writeFileSync(fd, text) { calls.writes.push(String(text)); },
        fsyncSync() { }, closeSync() { },
        renameSync(from, to) { if (renameErr) throw Object.assign(new Error('busy'), { code: renameErr }); calls.renamed.push([from, to]); },
        unlinkSync() { calls.unlinked++; },
      };
      const sandbox = {
        fs: fakeFs,
        path: { dirname: (p) => p.replace(/[\\/][^\\/]*$/, '') || '.', basename: (p) => p.split(/[\\/]/).pop(), join: (...a) => a.join('/') },
        process: { pid: 4242 }, Math, Set, console: { log: (m) => calls.logs.push(String(m)) },
      };
      sandbox.ATOMIC_DEGRADED = new Set();
      vm.runInNewContext(fnSrc + '\n; this.__w = writeFileAtomic;', sandbox);
      let threw = null;
      try { sandbox.__w('/app/config.json', '{"channels":[]}', 'utf8'); } catch (e) { threw = e; }
      return { calls, threw };
    }

    const ok = runWith(null);
    check('正常路径：rename 成功且不碰目标文件（原子替换）',
      ok.threw === null && ok.calls.renamed.length === 1 && ok.calls.opens.length === 1);
    check('正常路径：tmp 在收尾被清理', ok.calls.unlinked === 1);

    const busy = runWith('EBUSY');
    check('★ EBUSY 时**不抛异常**（进程不会被打挂）', busy.threw === null, busy.threw && String(busy.threw));
    check('★ EBUSY 时降级为原地覆写：以 "w" 打开**目标本身**并写入',
      busy.calls.opens.some(([p, f]) => p === '/app/config.json' && f === 'w')
      && busy.calls.writes.includes('{"channels":[]}'));
    check('★ 降级时打一行明确日志（不许让人以为还是原子的）',
      busy.calls.logs.some((m) => m.includes('[atomic]') && m.includes('EBUSY')));
    check('降级后 tmp 仍被清理', busy.calls.unlinked === 1);

    const exdev = runWith('EXDEV');
    check('EXDEV（跨设备）同样降级而不是抛', exdev.threw === null && exdev.calls.writes.includes('{"channels":[]}'));
    const other = runWith('EIO');
    check('其它错误（EIO）仍然如实抛出，不被吞掉', other.threw !== null && other.threw.code === 'EIO');
  }

  /* ══════════ 假上游（只为让渠道"活着"，本用例不关心它答什么） ══════════ */
  const UP = await freePort();
  const up = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'up-model', object: 'model' }] }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  await new Promise((r) => up.listen(UP, '127.0.0.1', r));

  const mkChannel = (id, over) => Object.assign({
    id, name: id.toUpperCase(), protocol: 'openai',
    baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: 'sk-' + id + '-SECRET-9999',
    priority: 5, enabled: true, models: { [id + '-model']: 'up-model' },
  }, over || {});

  function makeDir(name) {
    const dir = path.join(TMP, name);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, cfgPath: path.join(dir, 'c.json'), histDir: path.join(dir, 'hist'), usagePath: path.join(dir, 'u.json') };
  }
  function writeCfg(cfgPath, obj) { fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2) + '\n'); }
  function envOf(d) {
    return Object.assign({}, process.env, {
      ZZCSAPI_CONFIG: d.cfgPath,
      ZZCSAPI_USAGE: d.usagePath,
      ZZCSAPI_CONFIG_HISTORY_DIR: d.histDir,
      GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1',
    });
  }
  async function boot(d, port) {
    const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: envOf(d), stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + '/healthz')).ok) return { gw, base, port }; } catch { }
      await sleep(150);
    }
    throw new Error('网关未启动');
  }
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const adminCall = (base, method, p, body) => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ code: r.status, text: await r.text() })).catch((e) => ({ code: 0, text: String(e && e.message) }));

  /* ══════════ 1. 原子写：保存后无 tmp 残留，文件完整 ══════════ */
  console.log('\n1. 原子写：保存后目录干净、config.json 完整');
  {
    const d = makeDir('main');
    const port = await freePort();
    writeCfg(d.cfgPath, { port, health: { intervalSec: 3600, timeoutMs: 8000 }, channels: [mkChannel('alpha')] });
    const { gw, base } = await boot(d, port);
    try {
      const save = await adminCall(base, 'POST', '/admin/api/channels', mkChannel('alpha', { priority: 9 }));
      check('保存渠道成功', save.code === 200, save.text.slice(0, 160));
      check('★ 保存后目录里没有 .tmp 残留', tmpLeftovers(d.dir).length === 0, tmpLeftovers(d.dir));
      const onDisk = readJson(d.cfgPath);
      check('★ 保存后 config.json 是完整合法 JSON 且改动已落盘',
        !!onDisk && Array.isArray(onDisk.channels) && (onDisk.channels.find((c) => c.id === 'alpha') || {}).priority === 9);
      check('保存会顺手留一份 config.json.bak（供下面第 2 节当退路）', fs.existsSync(d.cfgPath + '.bak'));
    } finally { await stop(gw); }
  }

  /* ══════════ 2. 正主坏 → 从 .bak 恢复 + 自愈写回 + 坏文件留档 ══════════ */
  console.log('\n2. 正主写坏 → 从 .bak 恢复');
  {
    const d = makeDir('bak');
    const port = await freePort();
    writeCfg(d.cfgPath, { port, health: { intervalSec: 3600, timeoutMs: 8000 }, channels: [mkChannel('alpha'), mkChannel('beta')] });
    const first = await boot(d, port);
    // 保存一次，确保 config.json.bak 里是"两个渠道"的完整版本
    await adminCall(first.base, 'POST', '/admin/api/channels', mkChannel('alpha', { priority: 7 }));
    await stop(first.gw);
    check('前置：.bak 已生成', fs.existsSync(d.cfgPath + '.bak'));

    // 把正主写成半截 JSON —— 模拟"上次写盘被打断"
    fs.writeFileSync(d.cfgPath, '{"port": ' + port + ', "channels": [{"id": "alpha"', 'utf8');
    check('前置：正主此刻确实是坏 JSON（读不出来）', readJson(d.cfgPath) === null);

    // 端口写死在坏文件里读不出来，但 .bak 里存着原端口 → 恢复后仍监听原端口
    let gw2 = null;
    try { gw2 = await boot(d, port); } catch { gw2 = null; }
    try {
      check('★ 正主写坏后网关仍能启动（从 .bak 恢复，而不是直接崩）', !!gw2);
      if (gw2) {
        check('★ 恢复后 config.json 被原子写回成合法 JSON', readJson(d.cfgPath) !== null);
        const rec = readJson(d.cfgPath);
        check('★ 恢复的是 .bak 里那份完整配置（两个渠道都在）',
          !!rec && Array.isArray(rec.channels) && rec.channels.length === 2, rec && rec.channels && rec.channels.length);
        check('★ 坏文件被留档成 .corrupt-*（现场不丢）', corruptFiles(d.dir).length >= 1, corruptFiles(d.dir));
        check('★ 恢复后目录里没有 .tmp 残留', tmpLeftovers(d.dir).length === 0, tmpLeftovers(d.dir));
      }
    } finally { if (gw2) await stop(gw2.gw); }
  }

  /* ══════════ 3. 正主 + .bak 都坏 → 从代际快照恢复 ══════════ */
  console.log('\n3. 正主与 .bak 都坏 → 从代际快照恢复');
  {
    const d = makeDir('gen');
    const port = await freePort();
    writeCfg(d.cfgPath, { port, health: { intervalSec: 3600, timeoutMs: 8000 }, channels: [mkChannel('alpha'), mkChannel('beta')] });
    const first = await boot(d, port);
    await adminCall(first.base, 'POST', '/admin/api/channels', mkChannel('alpha', { priority: 8 }));
    await stop(first.gw);
    const gens = (() => { try { return fs.readdirSync(d.histDir).filter((f) => /^gen-\d+\.json$/.test(f)); } catch { return []; } })();
    check('前置：已产生至少一代快照', gens.length >= 1, gens);

    // 正主与 .bak 都写成坏 JSON
    fs.writeFileSync(d.cfgPath, '{ broken', 'utf8');
    fs.writeFileSync(d.cfgPath + '.bak', '{ also broken', 'utf8');
    check('前置：正主与 .bak 都不可读', readJson(d.cfgPath) === null && readJson(d.cfgPath + '.bak') === null);

    let gw3 = null;
    try { gw3 = await boot(d, port); } catch { gw3 = null; }
    try {
      check('★ 正主与 .bak 都坏时仍能启动（从代际快照恢复）', !!gw3);
      if (gw3) {
        const rec = readJson(d.cfgPath);
        check('★ 从快照恢复出的配置结构合法且渠道在',
          !!rec && Array.isArray(rec.channels) && rec.channels.length === 2, rec && rec.channels && rec.channels.length);
        check('★ 恢复后目录里没有 .tmp 残留', tmpLeftovers(d.dir).length === 0, tmpLeftovers(d.dir));
      }
    } finally { if (gw3) await stop(gw3.gw); }
  }

  /* ══════════ 4. 全部退路都坏 → 必须报错退出（不许静默用空配置起来） ══════════ */
  console.log('\n4. 全部退路都坏 → 报错退出');
  {
    const d = makeDir('dead');
    const port = await freePort();
    writeCfg(d.cfgPath, { port, health: { intervalSec: 3600, timeoutMs: 8000 }, channels: [mkChannel('alpha')] });
    const first = await boot(d, port);
    await adminCall(first.base, 'POST', '/admin/api/channels', mkChannel('alpha', { priority: 6 }));
    await stop(first.gw);

    // 正主、.bak、所有代际快照全部写坏
    fs.writeFileSync(d.cfgPath, '{ broken', 'utf8');
    fs.writeFileSync(d.cfgPath + '.bak', '{ broken', 'utf8');
    try {
      for (const f of fs.readdirSync(d.histDir)) {
        if (/^gen-\d+\.json$/.test(f)) fs.writeFileSync(path.join(d.histDir, f), '{ broken', 'utf8');
      }
    } catch { }

    const r = spawnSync(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT, env: envOf(d), encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    check('★ 全坏时进程以非 0 退出（不能假装启动成功）', r.status !== 0, { status: r.status, signal: r.signal });
    check('★ 错误信息点明"已尝试 .bak 与代际快照"（把排查方向直接写出来）',
      /已尝试 config\.json\.bak 与[\s\S]{0,120}代际快照|代际快照[\s\S]{0,80}均不可用/.test(out) || /解析失败/.test(out),
      out.slice(0, 400));
  }

  /* ══════════ 收尾 ══════════ */
  try { up.close(); } catch { }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }

  console.log('\n────────────────────────────────────────');
  console.log('通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('用例崩溃: ' + (e && e.stack || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  process.exit(1);
});
