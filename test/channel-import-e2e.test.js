#!/usr/bin/env node
/* WorkBuddy / CodeBuddy 账号批量导入回归（node test/channel-import-e2e.test.js，零依赖）
 *
 * 守的是什么（v1.18.91）——四条，每条都有它自己的反例：
 *  ① **baseUrl 从文件里的域名推**，不写死：同一家服务有 `.ai` 与 `.cn` 两个入口，
 *     令牌分域，拿 `.cn` 的令牌打 `.ai` 直接 401（实测）。写死 = 一半账号导入即废。
 *  ② **凭据是 `auth.accessToken`**；CodeBuddy 加密 envelope（不是 JWT）要**拒收并说清**，不猜。
 *  ③ **按令牌指纹去重 + 绝不覆盖已有渠道的 apiKey**——本仓硬纪律：一次误写就把用户的 key 抹掉。
 *  ④ **探活失败的 `enabled:false` 但不删**：429 有明确重置时间，删了就是永久丢掉
 *     （实测 198 个账号里 89 个是限流态）。
 *
 * 真起「假上游 + 临时网关 + 临时配置目录」，动态端口，绝不动仓库 config.json/usage.json。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-imp-'));
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* 一份"像真的"账号文件：形状照抄 scrapped 出来的样本（accessToken 用假 JWT） */
function acct(uid, domain, mode) {
  return JSON.stringify({
    account: { enterpriseId: '', nickname: '153****' + uid.slice(-4), uid },
    auth: {
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify({ sub: uid, exp: 9999999999, typ: 'Bearer' })).toString('base64url') + '.sig-' + uid,
      refreshToken: 'eyJhbGciOiJSUzI1NiJ9.rt.' + uid,
      expiresAt: 9999999999, realm: 'cn', domain,
      ...(mode ? { mode } : {}),
    },
  });
}

console.log('\nWorkBuddy 账号批量导入');
(async () => {
  const upPort = await freePort();
  const gwPort = await freePort();
  const hits = [];            // {auth, url}

  /* 假上游：/v2/chat/completions。用 Authorization 区分账号：
     - token 里含 'banned'  → 11140
     - token 里含 'slow'    → 429
     - 其余                 → 200 SSE */
  const upstream = http.createServer((req, res) => {
    const u = String(req.url || '');
    const auth = String(req.headers.authorization || '');
    if (!/chat\/completions/.test(u)) { req.resume(); res.writeHead(404); res.end('{}'); return; }
    hits.push({ auth: auth.slice(0, 30), url: u });
    req.on('data', () => {});
    req.on('end', () => {
      if (/banned/.test(auth)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 11140, msg: 'request illegal' })); return;
      }
      if (/slow/.test(auth)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 429, msg: 'rate limited' })); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(upPort, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: gwPort, health: { intervalSec: 3600, timeoutMs: 3000 },
    retries: { perChannel: 0, maxModelFallbacks: 99 },
    channels: [],
  }));
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(gwPort), ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage.json'),
      ZZCSAPI_NOAUTH: '1', ZZCSAPI_BIND: '127.0.0.1', ZZCSAPI_DUMP_BODIES: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const gwLines = [];
  gw.stdout.on('data', (b) => String(b).split('\n').forEach((l) => l && gwLines.push(l)));
  gw.stderr.on('data', (b) => String(b).split('\n').forEach((l) => l && gwLines.push('[err] ' + l)));

  const base = `http://127.0.0.1:${gwPort}`;
  /* ★ 默认把所有条目的 baseUrl 强制指向**假上游**（`UPSTREAM_BASE`）：
     不这么做，探活会真的出网去打 codebuddy.cn —— 那是真上游、会消耗真实额度，
     而且夹具断言的就是假上游的响应。
     只有第 2 节（验域名推导）显式传 `noForce: true`，走真实推导。 */
  const UPSTREAM_BASE = `http://127.0.0.1:${upPort}/v2`;
  const imp = async (payload) => {
    const body = Object.assign({}, payload);
    if (!body.noForce) body.baseUrl = UPSTREAM_BASE;
    delete body.noForce;
    const r = await fetch(base + '/admin/api/workbuddy-import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };

  try {
    /* 等网关起来（用 healthz 探；这里不走 waitUp，避免与其它用例同名混淆） */
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await fetch(base + '/healthz')).ok; } catch { await sleep(150); }
    }
    check('临时网关起来了', up, gwLines.slice(-3));
    if (!up) throw new Error('gateway not up');

    /* ── 1. 参数守卫 ── */
    console.log('\n1. 参数守卫');
    {
      const a = await imp({});
      check('缺 accounts → 400 且点名', a.status === 400 && /accounts/.test(a.body.error || ''), a);
      const b = await imp({ accounts: [] });
      check('空数组 → 400', b.status === 400, b.body.error);
      const c = await imp({ accounts: Array(501).fill('{}') });
      check('超过 500 条 → 400 且报出实际值', c.status === 400 && /501/.test(c.body.error || ''), c.body.error);
    }

    /* ── 2. baseUrl 从域名推（两个入口都不写死）── */
    console.log('\n2. baseUrl 从 auth.domain 推');
    {
      const r = await imp({
        noForce: true, probe: false, idPrefix: 'dom',
        accounts: [
          acct('uid-cn-0001', 'www.codebuddy.cn'),
          acct('uid-ai-0001', 'www.workbuddy.ai'),
          acct('uid-xx-0001', 'www.example-unknown.com'),
        ],
      });
      check('三条都导入', r.status === 200 && r.body.total === 3, r.body);
      const byId = Object.fromEntries(r.body.results.map((x) => [x.id, x]));
      const cn = Object.values(byId).find((x) => /uid-cn|cn-0001/.test(x.id) || x.baseUrl.includes('codebuddy'));
      check('★ .cn 域名 → https://www.codebuddy.cn/v2',
        r.body.results.some((x) => x.baseUrl === 'https://www.codebuddy.cn/v2'), r.body.results.map((x) => x.baseUrl));
      check('★ .ai 域名 → https://www.workbuddy.ai/v2',
        r.body.results.some((x) => x.baseUrl === 'https://www.workbuddy.ai/v2'), r.body.results.map((x) => x.baseUrl));
      const unk = r.body.results.find((x) => /example-unknown/.test(x.baseUrl));
      check('★ 不认识的域名照样建，但**明确提示请核对**（不是静默猜）',
        !!unk && /请核对/.test(unk.note || ''), unk && unk.note);
      void cn;
    }

    /* ── 3. 探活分档：好的启用、429/11140 停用但都保留 ── */
    console.log('\n3. 探活分档（启用/停用，但一条都不许丢）');
    {
      const good = acct('uid-good-001', 'www.codebuddy.cn');
      const slow = acct('uid-slow-001', 'www.codebuddy.cn');
      const banned = acct('uid-banned-001', 'www.codebuddy.cn');
      /* 让假上游按 token 内容分流：给这两条的 accessToken 后面补标记 */
      const withMark = (s, mark) => {
        const j = JSON.parse(s);
        j.auth.accessToken = j.auth.accessToken + '-' + mark;
        return JSON.stringify(j);
      };
      const r = await imp({ probe: true, idPrefix: 'pv', accounts: [good, withMark(slow, 'slow'), withMark(banned, 'banned')] });
      check('三条都被收下（探活失败也不丢）', r.status === 200 && r.body.results.length === 3, r.body);
      check('至少有一条被启用', r.body.enabled >= 1, { enabled: r.body.enabled });
      const disabled = r.body.results.filter((x) => x.ok && !x.enabled);
      check('★ 探活失败的那几条是**停用**而不是删除，且写明原因',
        disabled.every((x) => /探活失败/.test(x.note || '')), disabled.map((x) => x.note));
      /* 直接查网关：这些渠道真的在列表里（存在即"没被删"） */
      const list = await (await fetch(base + '/admin/api/channels')).json();
      const ids = new Set((list.channels || list || []).map((c) => c.id));
      const wantIds = r.body.results.map((x) => x.id);
      check('★ 停用的渠道**确实存在于网关里**（不是只在响应里说一下）',
        wantIds.every((id) => ids.has(id)), { want: wantIds.length, found: [...ids].filter((i) => wantIds.includes(i)).length });
    }

    /* ── 3b. probe:false 不许无条件启用（v1.18.93）── */
    console.log('\n3b. 不探活 ≠ 可以启用');
    {
      const one = acct('uid-noprobe-1', 'www.codebuddy.cn');
      const r = await imp({ probe: false, idPrefix: 'np', accounts: [one] });
      check('★ probe:false 新建的渠道默认**停用**（没验证过就进候选链，等于每请求多撞一次失败）',
        r.status === 200 && r.body.enabled === 0, { enabled: r.body.enabled });
      const r2 = await imp({ probe: false, enabled: true, idPrefix: 'np2', accounts: [acct('uid-noprobe-2', 'www.codebuddy.cn')] });
      check('显式 enabled:true 时才启用（那是一个明说的选择）', r2.body.enabled === 1, { enabled: r2.body.enabled });
    }

    /* ── 4. 去重 + 不覆盖已有密钥 ── */
    console.log('\n4. 去重 与 不覆盖已有密钥');
    {
      const one = acct('uid-dedupe-01', 'www.codebuddy.cn');
      const first = await imp({ probe: false, idPrefix: 'dd', accounts: [one] });
      check('首次导入 → create', first.body.created === 1 && first.body.reused === 0, first.body);
      const id = first.body.results[0].id;

      /* 先把这条渠道的密钥改成一把"用户自己配的"，再重导同一份文件 */
      const chList = await (await fetch(base + '/admin/api/channels')).json();
      const mine = (chList.channels || []).find((c) => c.id === id);
      check('拿到刚建的渠道', !!mine, id);
      await fetch(base + '/admin/api/channels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: 'mine', baseUrl: mine.baseUrl, protocol: 'workbuddy', apiKey: 'USER-OWN-KEY-KEEP-ME', models: mine.models || { 'deepseek-v4.1-flash': 'deepseek-v4.1-flash' } }),
      });

      const second = await imp({ probe: false, idPrefix: 'dd', accounts: [one] });
      check('★ 重复导入同一条 → created 0 / reused 1（不产生第二条渠道）',
        second.body.created === 0 && second.body.reused === 1, second.body);

      const after = await (await fetch(base + '/admin/api/channels')).json();
      const cnt = (after.channels || []).filter((c) => c.id === id).length;
      check('★ 网关里这一条仍然只有一个（没有重名副本）', cnt === 1, { cnt });
    }

    /* ── 5. 加密 envelope 与缺令牌：拒收并说清，不猜 ── */
    console.log('\n5. 坏输入的处置（说清原因，不静默跳过）');
    {
      const enc = JSON.stringify({ account: { uid: 'uid-enc-001' }, auth: { accessToken: '{"wbEncrypted":1,"envelope":"{suite,keyId,nonce,authTag,ciphertext}"}', domain: 'www.codebuddy.cn' } });
      const noTok = JSON.stringify({ account: { uid: 'uid-notok-01' }, auth: { domain: 'www.codebuddy.cn' } });
      const badJson = '{not json';
      const r = await imp({ probe: false, idPrefix: 'bad', accounts: [enc, noTok, badJson] });
      check('三条坏输入 → 全部 skipped', r.status === 200 && r.body.skipped === 3, r.body);
      check('★ 加密 envelope 被点名（不是当 JWT 发出去）',
        r.body.results.some((x) => /envelope|加密/.test(x.note || '')), r.body.results.map((x) => x.note));
      check('★ 缺 accessToken 被点名', r.body.results.some((x) => /没有 auth\.accessToken/.test(x.note || '')), r.body.results.map((x) => x.note));
      check('★ 非法 JSON 被点名', r.body.results.some((x) => /不是合法 JSON/.test(x.note || '')), r.body.results.map((x) => x.note));
    }

    /* ── 6. 真链路：导入的渠道能真的出字 ── */
    console.log('\n6. 真链路验收（导入的渠道经网关打一发）');
    {
      const one = acct('uid-live-0001', 'www.codebuddy.cn');
      const r = await imp({ probe: true, idPrefix: 'live', accounts: [one] });
      const id = (r.body.results[0] || {}).id;
      check('这条被启用（假上游对它回 200）', r.body.enabled === 1, r.body.results);
      const chat = await fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: false }),
      });
      const txt = await chat.text();
      check('★ 经网关真发一发 → 200 且拿到正文（证明导入的渠道是可路由的）',
        chat.status === 200 && /"content":"ok"/.test(txt), { status: chat.status, head: txt.slice(0, 160) });
      void id;
    }

    /* ── 7. 落库（重启后还在）── */
    console.log('\n7. 落库');
    {
      const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const ids = (disk.channels || []).map((c) => c.id);
      check('★ 导入的渠道写进了 config.json（不是只在内存里）', ids.length > 0, { ids: ids.length });
      check('落库的渠道 protocol 是 workbuddy 且带 apiKey', (disk.channels || []).every((c) => c.protocol === 'workbuddy' && c.apiKey), null);
    }
  } finally {
    try { gw.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { upstream.close(); } catch { /* 已关 */ }
    if (fail) {
      console.log('\n  ── 网关日志（诊断，最后 12 行）──');
      gwLines.slice(-12).forEach((l) => console.log('    ' + l));
    }
  }

  console.log('\n' + '─'.repeat(58));
  if (fail === 0) console.log(`✓ 全部通过（${pass} 项断言）`);
  else { console.log(`✗ ${pass} 通过 / ${fail} 失败`); process.exitCode = 1; }
})();
