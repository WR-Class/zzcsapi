/**
 * test/config-history-e2e.test.js — 配置代际与一键回滚（v1.18.83）
 *
 * 为什么要这个用例（不是"接口存在"的仪式，而是一类反复发生的真实事故）：
 *   `persistConfig` 是**显式字段白名单**——任何没进清单的渠道字段，都会在"保存任意一个渠道"时被
 *   **静默抹掉**。PT29 一族已经连发四例：`weight` → `dropParams` → `notionAttachments` →
 *   `firstChunkTimeoutMs`/`timeoutMs`。抹掉之后没有任何副本可查：`config.json.bak` 只留上一次，
 *   控制台批量保存一轮就把它也覆盖了，用户只能凭记忆重配。
 *   所以本用例的核心断言**不是**"历史里有几条"，而是这三条：
 *     ① 被白名单吞掉的字段，回滚后**真的回到 config.json**（连格式都在）；
 *     ② 回滚后**运行期也认**（不是只改了文件、内存里还是旧值——那种"看着好了、跑起来没好"最坑）；
 *     ③ 快照里全是明文密钥，而**列表/详情响应里一个字都不许出现**（否则回滚功能 = 密钥下载口）。
 *
 * 跑法：node test/config-history-e2e.test.js   （退出码非 0 表示有回归）
 * 零依赖、零外网：假上游起在动态端口，配置与历史全部落在临时目录，**绝不动仓库的 config.json**。
 */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-hist-'));
const GW_KEY = 'hist-gw', AD_KEY = 'hist-admin';
const ALPHA_SECRET = 'sk-alpha-1111-SECRET2222';   // 只出现在配置与快照里，**绝不**允许出现在任何响应里

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
const genFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => /^gen-\d+\.json$/.test(f)).sort(); } catch { return []; } };

(async () => {
  /* ══════════ 0. 装配守卫（源码结构；跑真链路之前先确保"判据本身"没被改坏） ══════════ */
  console.log('0. 装配守卫');
  {
    const persistStart = SRC.indexOf('function persistConfig()');
    const persistEnd = SRC.indexOf('\n}\n', persistStart);
    const persistBody = SRC.slice(persistStart, persistEnd);
    check('★ persistConfig 里先存快照、后写文件（顺序反了等于"存了新版本"，回滚回到同一个状态）',
      persistBody.indexOf('snapshotConfigForHistory(') > 0
      // v1.18.85 起落盘走 writeFileAtomic（不再是裸 writeFileSync），两种写法都认：
      // 这条守的是**顺序**，不是写盘方式——写盘方式由 config-atomic-write-e2e 单独守
      && persistBody.indexOf('snapshotConfigForHistory(') < persistBody.search(/writeFileAtomic\(CONFIG_PATH|writeFileSync\(CONFIG_PATH/));
    check('历史目录默认在 config.json 旁边（容器里就是 /app/config-history，随 compose 挂载）',
      /path\.join\(path\.dirname\(CONFIG_PATH\), 'config-history'\)/.test(SRC));
    check('快照失败不许影响落盘（snapshotConfigForHistory 自己吞异常）',
      /function snapshotConfigForHistory[\s\S]{0,200}?try \{/.test(SRC)
      && /\[history\] 快照失败（不影响配置落盘）/.test(SRC));
    check('★ hash 去重（内容没变就不存，否则同一状态占满整个环）',
      /entries\[entries\.length - 1\]\.hash === hash\) return null/.test(SRC));
    check('★ 列表视图只给元信息（historyEntryView 里不许出现 apiKey / config）',
      (() => {
        const i = SRC.indexOf('function historyEntryView');
        const body = SRC.slice(i, SRC.indexOf('\n}\n', i));
        return !/apiKey|config:|auth/.test(body);
      })());
    check('★ 详情一律掩码：删 adminKey / gatewayKey，auth 只报存在',
      /function maskConfigForView[\s\S]{0,700}?delete out\.adminKey;[\s\S]{0,200}?delete out\.gatewayKey;/.test(SRC)
      && /if \(out\.auth\) out\.auth = \{ redacted: true \}/.test(SRC)
      && /ch\.apiKey = maskSecret\(ch\.apiKey\)/.test(SRC));
    check('★ 回滚不动密钥段（buildRollbackConfig 用当前值覆盖 auth/adminKey/gatewayKey）',
      /function buildRollbackConfig[\s\S]{0,400}?for \(const k of \['adminKey', 'gatewayKey', 'auth'\]\)/.test(SRC));
    check('★ 回滚前先把"现在"存一代（回滚本身可撤销）',
      /snapshotConfigForHistory\('before-rollback'\)/.test(SRC));
    check('回滚前按与 loadConfig 同一套硬规矩校验快照（不许回滚到起不来的配置）',
      /snapshot channel missing id/.test(SRC) && /snapshot channel \$\{c\.id\} missing apiKey/.test(SRC));
    check('三个端点都在（列表 / 详情 / 回滚）',
      SRC.includes("'/admin/api/config/history'")
      // 详情路由在源码里是**转义过的正则字面量**（`\/admin\/api\/config\/history\/`），
      // 所以这里得按正则再转义一次——直接 includes 裸路径是找不到的（本用例第一版就栽在这）
      && /const histMatch = \/\^\\\/admin\\\/api\\\/config\\\/history\\\//.test(SRC)
      && SRC.includes("'/admin/api/config/rollback'"));
    const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    check('★ 快照目录已 gitignore（每一代都是整份配置原文，含渠道明文 key）', /^config-history\/$/m.test(gi));
    const yml = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
    // 只看真正的挂载行，别把注释算进来（本句注释里就写着那条错误示范）
    const mounts = yml.split(/\r?\n/).filter((l) => /^\s*-\s/.test(l));
    check('★ compose 挂的是**目录**不是文件（v1.18.86 起改挂 ./data：配置/用量/快照三者与 tmp **同 device**，rename 才能成功；'
      + '单文件挂载是挂载点、跨 device，原子写必然降级）',
      mounts.some((l) => l.includes('./data:/app/data'))
      && !mounts.some((l) => /\.\/config\.json:/.test(l) || /\.\/usage\.json:/.test(l) || /config-history\.json:/.test(l)),
      mounts.filter((l) => l.includes('data') || l.includes('config') || l.includes('usage')));
    check('★ ZZCSAPI_CONFIG 指向**被挂载的那个目录**内（快照目录由它的 dirname 推导 ⇒ 不指进去就会落到容器另一层）',
      /ZZCSAPI_CONFIG:\s*\/app\/data\/config\.json/.test(yml), yml.match(/ZZCSAPI_CONFIG:.*/));
  }

  /* ══════════ 假上游（只为让渠道"活着"，本用例不关心它答什么） ══════════ */
  function makeUpstream() {
    const st = { hits: 0 };
    st.server = http.createServer((req, res) => {
      st.hits++;
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'up-model', object: 'model' }] }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
    });
    return st;
  }

  const UP = await freePort();
  const up = makeUpstream();
  await new Promise((r) => up.server.listen(UP, '127.0.0.1', r));

  /* 初始配置：alpha 带 timeoutMs/dropParams，**外加一个 persistConfig 白名单里没有的字段**
     （`customField`）——它模拟"下一次任意保存就会消失"的那类字段，是回滚要救的东西。 */
  const baseChannel = (over) => Object.assign({
    id: 'alpha', name: 'Alpha', protocol: 'openai',
    baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: ALPHA_SECRET,
    priority: 5, enabled: true, models: { 'alpha-model': 'up-model' },
    dropParams: ['temperature'], timeoutMs: 30000, customField: 42,
  }, over || {});

  async function boot(dirName, extraEnv) {
    const dir = path.join(TMP, dirName);
    fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, 'c.json');
    const histDir = path.join(dir, 'hist');
    const port = await freePort();
    fs.writeFileSync(cfgPath, JSON.stringify({
      port,
      health: { intervalSec: 3600, timeoutMs: 8000 },
      channels: [baseChannel(), { id: 'beta', name: 'Beta', protocol: 'openai', baseUrl: `http://127.0.0.1:${UP}/v1`, apiKey: 'sk-beta-3333-4444', priority: 3, enabled: true, models: { 'beta-model': 'up-model' } }],
    }, null, 2) + '\n');
    const env = Object.assign({}, process.env, {
      ZZCSAPI_CONFIG: cfgPath,
      ZZCSAPI_USAGE: path.join(dir, 'u.json'),
      ZZCSAPI_CONFIG_HISTORY_DIR: histDir,
      GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY,
      ZZCSAPI_BIND: '127.0.0.1',
    }, extraEnv || {});
    const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    let up2 = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { up2 = true; break; } } catch { }
      await sleep(150);
    }
    if (!up2) throw new Error('网关未启动（' + dirName + '）');
    return { dir, cfgPath, histDir, base, gw };
  }
  const stop = (cp) => new Promise((res) => {
    if (!cp || cp.exitCode !== null || cp.signalCode !== null) return res();
    cp.once('exit', () => res());
    try { cp.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const mkApi = (base, adminKey) => {
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminKey };
    return (method, p, body) => fetch(base + p, {
      method, headers: H, body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => {
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch { }
      return { code: r.status, text: t, json: j };
    }).catch((e) => ({ code: 0, text: String(e && e.message), json: null }));
  };

  /* ══════════ 1. 真链路：保存 → 看历史 → 看差异 → 回滚 ══════════ */
  console.log('\n1. 真链路：保存 → 历史 → 差异 → 回滚');
  let gw1, g2;
  try {
    gw1 = await boot('main');
    const call = mkApi(gw1.base, AD_KEY);

    const h0 = await call('GET', '/admin/api/config/history');
    check('刚启动时没有历史（只有真的改写才存一代）', h0.code === 200 && h0.json && h0.json.entries.length === 0, h0.text.slice(0, 160));

    // 保存一次 alpha（priority 5 → 7）。这一次保存会把 customField 从 config.json 里抹掉
    const save = await call('POST', '/admin/api/channels', Object.assign(baseChannel({ priority: 7 }), { customField: undefined }));
    check('保存渠道成功', save.code === 200, save.text.slice(0, 200));

    const onDisk = readJson(gw1.cfgPath);
    const alphaDisk = (onDisk.channels || []).find((c) => c.id === 'alpha') || {};
    check('★ 保存后 customField 确实被白名单吞掉了（这就是要救的那类字段损失）',
      alphaDisk.customField === undefined && alphaDisk.priority === 7, alphaDisk);
    check('未被吞的字段照常写进去（dropParams / timeoutMs 还在）',
      JSON.stringify(alphaDisk.dropParams) === '["temperature"]' && alphaDisk.timeoutMs === 30000);

    const h1 = await call('GET', '/admin/api/config/history');
    check('保存前的那一代被存下来了', h1.code === 200 && h1.json.entries.length === 1, h1.text.slice(0, 200));
    check('★ 列表里没有任何密钥原文（快照含明文 key，列表一个字都不许漏）',
      !h1.text.includes(ALPHA_SECRET) && !h1.text.includes('sk-beta-3333-4444'), h1.text.slice(0, 300));
    check('列表项带 seq / 时间 / 字节 / hash / 渠道数',
      (() => { const e = (h1.json.entries || [])[0] || {}; return Number.isFinite(e.seq) && !!e.at && e.bytes > 0 && String(e.hash).length === 12 && e.channels === 2; })(),
      (h1.json.entries || [])[0]);

    const d1 = await call('GET', '/admin/api/config/history/1');
    check('详情可读', d1.code === 200 && !!d1.json, d1.text.slice(0, 200));
    check('★ 详情里的 apiKey 是掩码（回滚功能不能变成密钥下载口）',
      !d1.text.includes(ALPHA_SECRET) && /sk-a…2222/.test(d1.text), (d1.json && d1.json.config.channels[0] || {}).apiKey);
    check('★ 详情里根本没有 adminKey / gatewayKey 字段',
      !('adminKey' in (d1.json.config || {})) && !('gatewayKey' in (d1.json.config || {})));
    check('★ 差异直接点出"被抹掉了哪个字段"（这就是排障价值：不用再靠猜）',
      (() => {
        const ch = ((d1.json.diff || {}).channels || {}).changed || [];
        const a = ch.find((x) => x.id === 'alpha') || {};
        return (a.fields || []).includes('customField') && (a.fields || []).includes('priority');
      })(), (d1.json.diff || {}).channels);

    // 回滚
    const rb = await call('POST', '/admin/api/config/rollback', { seq: 1 });
    check('回滚成功', rb.code === 200 && rb.json && rb.json.ok === true, rb.text.slice(0, 240));
    check('响应里报明"密钥段没动"（避免用户以为回滚换了门锁）', rb.json && rb.json.keysPreserved === true);
    check('★ 回滚后 customField 真的回到了 config.json（连白名单都挡不住它）',
      (() => { const d = readJson(gw1.cfgPath); const a = (d.channels || []).find((c) => c.id === 'alpha') || {}; return a.customField === 42 && a.priority === 5; })(),
      (readJson(gw1.cfgPath).channels || []).find((c) => c.id === 'alpha'));
    check('★ 运行期也认（不是只改了文件、内存里还是 7）',
      await call('GET', '/admin/api/channels').then((r) => {
        const a = ((r.json || {}).channels || []).find((c) => c.id === 'alpha') || {};
        return a.priority === 5;
      }));
    const h2 = await call('GET', '/admin/api/config/history');
    check('★ 回滚本身也留了一代（reason=before-rollback ⇒ 回滚可撤销）',
      (h2.json.entries || []).some((e) => e.reason === 'before-rollback'), (h2.json.entries || []).map((e) => e.reason));

    // 去重：**结果内容相同**的连续保存，从第二次起不再占新的一代。
    // 注意要连发三次：回滚刚把文件改成"快照原文"，而 persistConfig 写出的是它自己的字段顺序，
    // 两者**文本**不同 ⇒ 第一次保存仍会存一代（这是正确的：内容确实变了），第二次起才稳定下来。
    const before = (await call('GET', '/admin/api/config/history')).json.entries.length;
    await call('POST', '/admin/api/channels', Object.assign(baseChannel({ priority: 5 }), { customField: 42 }));
    await call('POST', '/admin/api/channels', Object.assign(baseChannel({ priority: 5 }), { customField: 42 }));
    const mid = (await call('GET', '/admin/api/config/history')).json.entries.length;
    await call('POST', '/admin/api/channels', Object.assign(baseChannel({ priority: 5 }), { customField: 42 }));
    const after = (await call('GET', '/admin/api/config/history')).json.entries.length;
    check('★ hash 去重：内容没变的重复保存不再占一代（否则真该回滚的那代会被顶掉）',
      after === mid && mid >= before, { before, mid, after });

    // 边界
    check('回滚到不存在的 seq → 404', (await call('POST', '/admin/api/config/rollback', { seq: 99999 })).code === 404);
    check('缺 seq → 400', (await call('POST', '/admin/api/config/rollback', {})).code === 400);
    check('详情取不存在的 seq → 404', (await call('GET', '/admin/api/config/history/99999')).code === 404);

    // ── 密钥段不回滚 ──
    const rot = await call('POST', '/admin/api/keys/generate', { target: 'admin' });
    const newAd = (rot.json && rot.json.newKeys && rot.json.newKeys.adminKey) || null;
    check('轮换管理密钥成功（为了验证"回滚不动密钥段"）', rot.code === 200 && !!newAd, rot.text.slice(0, 160));
    const callNew = mkApi(gw1.base, newAd);
    const hist3 = await callNew('GET', '/admin/api/config/history');
    const seqAfterRot = (hist3.json.entries || [])[0] && hist3.json.entries[0].seq;
    const rb2 = await callNew('POST', '/admin/api/config/rollback', { seq: seqAfterRot });
    check('回滚到一个"还没有 auth 段"的快照也成功', rb2.code === 200, rb2.text.slice(0, 200));
    check('★ 密钥段没被回滚掉：config.json 里仍有 auth，且是新轮换的值',
      (() => { const d = readJson(gw1.cfgPath); return !!(d.auth && d.auth.adminKey === newAd); })(),
      (readJson(gw1.cfgPath).auth || {}).adminKey ? '有 auth（值已掩码）' : 'auth 被抹掉了');
    check('★ 新管理密钥在回滚后仍然有效（没把用户锁在门外）',
      (await callNew('GET', '/admin/api/config')).code === 200);
    check('旧管理密钥仍然失效（回滚没有把旧钥匙复活）', (await call('GET', '/admin/api/config')).code === 401);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(gw1 && gw1.gw);
  }

  /* ══════════ 2. 环形上限 + 坏快照 ══════════ */
  console.log('\n2. 环形上限（最多留 N 代，且淘汰的文件真的删掉）与坏快照');
  try {
    g2 = await boot('ring', { ZZCSAPI_CONFIG_HISTORY_MAX: '3' });
    const call2 = mkApi(g2.base, AD_KEY);
    for (let p = 1; p <= 5; p++) {
      await call2('POST', '/admin/api/channels', Object.assign(baseChannel({ priority: p }), { customField: 42 }));
    }
    const h = await call2('GET', '/admin/api/config/history');
    check('★ 历史条数封顶在 N（默认 20，这里设成 3）', (h.json.entries || []).length === 3, (h.json.entries || []).length);
    check('★ 环外的快照文件真的被删了（不留残骸占盘、也不留"能点开但不在列表里"的幽灵代）',
      genFiles(g2.histDir).length === 3, genFiles(g2.histDir));
    check('列表按新的在前（控制台直接照着画）',
      (h.json.entries[0].seq > h.json.entries[2].seq), (h.json.entries || []).map((e) => e.seq));

    // 坏快照：渠道缺 apiKey ⇒ 必须 400，且不许把 config.json 写坏
    const before = fs.readFileSync(g2.cfgPath, 'utf8');
    const bad = JSON.parse(before);
    delete bad.channels[0].apiKey;
    bad.channels[0].id = 'bad';
    fs.writeFileSync(path.join(g2.histDir, 'gen-000900.json'), JSON.stringify(bad, null, 2));
    const idxPath = path.join(g2.histDir, 'index.json');
    const idx = readJson(idxPath) || { version: 1, entries: [] };
    idx.entries.push({ seq: 900, at: new Date().toISOString(), hash: 'deadbeefdead', bytes: 1, reason: 'manual', channels: 2 });
    fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1) + '\n');
    const rb = await call2('POST', '/admin/api/config/rollback', { seq: 900 });
    check('★ 快照不合法（渠道缺 apiKey）→ 400，不是"回滚了再说"',
      rb.code === 400 && /missing apiKey/.test(rb.text), { code: rb.code, text: rb.text.slice(0, 160) });
    check('★ 拒绝回滚后 config.json 一个字节都没动', fs.readFileSync(g2.cfgPath, 'utf8') === before);
    check('拒绝回滚后渠道仍在（没有半截状态）',
      await call2('GET', '/admin/api/channels').then((r) => (((r.json || {}).channels) || []).some((c) => c.id === 'alpha')));
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message) + '\n' + (e && e.stack ? String(e.stack).split('\n').slice(1, 4).join('\n') : ''));
  } finally {
    await stop(g2 && g2.gw);
    try { up.server.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;
})();
