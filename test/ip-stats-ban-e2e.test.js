#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/ip-stats-ban-e2e.test.js — 来源 IP 态势统计与封禁回归（v1.18.11，真起进程，零依赖）
 *
 * 守的是什么：密钥被放进"中转站"转卖时看得见（per-IP 调用数 / token / 模型 / 峰值并发 /
 * 会话数估计 / 24 小时桶），且固定来源的滥用者可以外科手术式封禁（403，落 config.security.bannedIPs）。
 *
 * 覆盖：
 *   · 装配守卫：封禁闸门在 Host/Origin 门之后、限流之前、只在客户端面（管理面/控制台永远够得着解封）；
 *     在飞数归还挂在限流同一条 finish/close settle 路径；per-IP token/模型记账只在 recordUsage 一处
 *     （单漏斗）；persistConfig 白名单含 security（否则一次渠道保存就把封禁名单抹掉）；
 *     X-Forwarded-For 只在 trustedProxy 登记来源上采信（伪造头不能把封禁变成假功能）；
 *     4 处客户端路由都注入 statsCtx；
 *   · 纯函数真值表（现抠真实源码跑）：isValidIpLiteral / clientLabelOf / clientIpOf（采信与不采信）、
 *     记账/在飞/会话/桶/淘汰语义、快照形状与排序；
 *   · 真链路：预置封禁 → 403 且 bannedHits 在涨；XFF 三个来源各占一行；401 也算敲门；
 *     token/模型/客户端标签/会话数记进成功路径；并行两发 → 峰值并发 ≥2 且结束归零；
 *     POST/DELETE 封禁端点全语义（400/404/幂等）；封禁后管理面照常可达；
 *     封禁落 config.json；重启 → 统计清零、封禁还在；
 *   · 对照组：不设 trustedProxy 时 XFF 一律不采信（全部记成直连 IP）。
 *
 * 安全约束：动态空闲端口；配置/用量在系统临时目录（绝不动仓库 config.json/usage.json）。
 * 跑法：node test/ip-stats-ban-e2e.test.js      （退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-ipstats-'));
const GW_KEY = 'e2e-gw', AD_KEY = 'e2e-admin';

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// 现抠真实统计模块（横幅到 createServer 之前），注入 config + 桩 affinityKeyFor 跑真值表
const STATS_SRC = SRC.slice(SRC.indexOf('const SECURITY_BANNED = new Set('), SRC.indexOf('const server = http.createServer'));
function makeStats(cfg) {
  const factory = new Function('config', 'affinityKeyFor', STATS_SRC + `
    return { SECURITY_BANNED, isValidIpLiteral, trustedProxyList, clientIpOf, clientLabelOf, IP_STATS, IP_STATS_CAP, IPSTATS_GLOBAL, ipStatsEntry, noteClientAttempt, noteBannedHit, ipStatsAcquire, ipStatsRelease, statsIpUsage, ipStatsSnapshot };`);
  return factory(cfg, () => '');
}

(async () => {
  /* ─────────────────────────── 0. 装配守卫 ─────────────────────────── */
  console.log('\n0. 装配守卫（源码级：闸门位置与单漏斗）');
  const hostGateIdx = SRC.indexOf('if (!hostAllowedForV07(hostPort))');
  const faceIdx = SRC.indexOf("if (url.pathname === '/v1/models' || url.pathname.startsWith('/v1/')");
  const banGateIdx = SRC.indexOf('if (SECURITY_BANNED.has(sip))');
  const rateGateIdx = SRC.indexOf('const verdict = rateCheck();');
  check('封禁闸门在 Host/Origin 门之后（Host 门先拦陌生域名，封禁再拦来源）', banGateIdx > hostGateIdx && banGateIdx > 0);
  check('封禁闸门在客户端面分支内（只拦 /v1 /anthropic /gemini，管理面/控制台/健康检查不拦）',
    banGateIdx > faceIdx && SRC.indexOf('banned source ip', banGateIdx) < SRC.indexOf('const slabel = clientLabelOf', banGateIdx));
  check('封禁闸门在限流之前（被封的请求不占并发额度、不烧令牌）', banGateIdx < rateGateIdx);
  check('per-IP 在飞数归还挂在与限流同一条 finish/close settle 路径',
    /rateRelease\(\);\s*\n\s*ipStatsRelease\(sip\);/.test(SRC) &&
    (SRC.match(/res\.on\('close', settle\)/g) || []).length === 1 && (SRC.match(/res\.on\('finish', settle\)/g) || []).length === 1);
  check('敲开次数在鉴权之前记（401/429 也算指纹）',
    SRC.indexOf('noteClientAttempt(sip, slabel)') < SRC.indexOf("if (!authGate(req, res, 'gateway')) return;"));
  check('per-IP token/模型记账只在 recordUsage 一处（单漏斗，不与用量统计分叉）',
    (SRC.match(/statsIpUsage\(/g) || []).length === 2 && /statsCtx && statsCtx\.ip/.test(SRC));
  check('persistConfig 白名单含 security（否则控制台保存渠道会把封禁名单抹掉）',
    /security: \(config && config\.security\) \|\| undefined/.test(SRC));
  check('X-Forwarded-For 全仓只在 clientIpOf 里读（采信必须过 trustedProxy 匹配）',
    (SRC.match(/x-forwarded-for/g) || []).length === 1 && /for \(const tp of trustedProxyList\(\)\)/.test(SRC));
  check('4 处客户端路由（openai/anthropic/gemini 聊天 + 图片）都注入 statsCtx',
    (SRC.match(/statsCtx: makeStatsCtx\(req, res, body\)/g) || []).length === 4);
  check('封禁端点在 handleAdminApi 里（管理面统一鉴权）',
    SRC.indexOf("url.pathname === '/admin/api/bans'") > SRC.indexOf('async function handleAdminApi'));
  check('启动时封禁表从 config.security.bannedIPs 初始化（重启不丢）',
    /const SECURITY_BANNED = new Set\(\s*\n\s*\(\(config && config\.security && config\.security\.bannedIPs\) \|\| \[\]\)/.test(SRC));

  /* ─────────────────────────── 1. 纯函数真值表 ─────────────────────────── */
  console.log('\n1. 纯函数真值表（现抠真实源码）');
  {
    const a = makeStats({ security: { trustedProxy: '127.0.0.1' } });
    check('isValidIpLiteral：IPv4/IPv6 字面量放行', a.isValidIpLiteral('1.2.3.4') && a.isValidIpLiteral('10.0.0.1') && a.isValidIpLiteral('::1') && a.isValidIpLiteral('fe80::1'));
    check('isValidIpLiteral：坏段/域名/空值/五段全拒', !a.isValidIpLiteral('1.2.3.256') && !a.isValidIpLiteral('1.2.3') && !a.isValidIpLiteral('evil.example') && !a.isValidIpLiteral('') && !a.isValidIpLiteral('1.2.3.4.5') && !a.isValidIpLiteral('999.1.1.1'));
    const reqOf = (sock, xff) => ({ socket: { remoteAddress: sock }, headers: xff ? { 'x-forwarded-for': xff } : {} });
    check('clientIpOf：socket 地址归一（::ffff: 前缀剥掉）', makeStats({}).clientIpOf(reqOf('::ffff:127.0.0.1')) === '127.0.0.1');
    check('clientIpOf：trustedProxy 登记来源上的 XFF 第一跳被采信', a.clientIpOf(reqOf('127.0.0.1', '203.0.113.7, 10.0.0.9')) === '203.0.113.7');
    check('clientIpOf：未登记 trustedProxy 时 XFF 一律不采信（伪造头无效）', makeStats({}).clientIpOf(reqOf('127.0.0.1', '1.2.3.4')) === '127.0.0.1');
    check('clientIpOf：socket 不是登记的反代时 XFF 照样不采信', makeStats({ security: { trustedProxy: '10.0.0.9' } }).clientIpOf(reqOf('127.0.0.1', '1.2.3.4')) === '127.0.0.1');
    check('clientIpOf：XFF 里的 ::ffff: 前缀也剥掉', a.clientIpOf(reqOf('127.0.0.1', '::ffff:203.0.113.9')) === '203.0.113.9');
    const b = makeStats({});
    check('clientLabelOf：常见 CLI 映射成短标签', b.clientLabelOf('codex_cli_rs/1.0') === 'codex CLI' && b.clientLabelOf('claude-cli/2.2 (mac)') === 'Claude Code' && b.clientLabelOf('Cline/1.0') === 'Cline' && b.clientLabelOf('Go-http-client/2.0') === 'go-http-client');
    check('clientLabelOf：空 UA → unknown；认不出的原样截断不瞎猜', b.clientLabelOf('') === 'unknown' && b.clientLabelOf('MyAgent/1.0') === 'MyAgent/1.0' && b.clientLabelOf('Mozilla/5.0 (Windows NT 10.0; Win64)').endsWith('…'));
  }
  {
    const a = makeStats({ security: { trustedProxy: '127.0.0.1' } });
    a.noteClientAttempt('203.0.113.7', 'codex CLI');
    a.noteClientAttempt('203.0.113.7', 'codex CLI');
    a.noteBannedHit('203.0.113.7');
    a.ipStatsAcquire('203.0.113.7'); a.ipStatsAcquire('203.0.113.7');
    a.statsIpUsage('203.0.113.7', 'm1', 11, 7, 'b:pc:session-aaaa');
    a.statsIpUsage('203.0.113.7', 'm1', 5, 3, 'b:pc:session-bbbb');
    const snap = a.ipStatsSnapshot();
    check('快照：两个会话键各占一格（会话数估计）', snap.ips[0].sessions === 2, snap.ips[0]);
    check('快照：token 只记成功用量（11+5 入 / 7+3 出）', snap.ips[0].tokIn === 16 && snap.ips[0].tokOut === 10, snap.ips[0]);
    check('快照：敲门 2 次 + 封禁命中单独计（bannedHits 不混进 calls）', snap.ips[0].calls === 2 && snap.ips[0].bannedHits === 1, snap.ips[0]);
    check('快照：模型按次数聚合', snap.ips[0].models[0].k === 'm1' && snap.ips[0].models[0].n === 2, snap.ips[0].models);
    check('快照：24 小时桶 24 格且当小时被记', snap.ips[0].buckets.length === 24 && snap.ips[0].buckets[new Date().getHours()] === 3, snap.ips[0].buckets);
    a.ipStatsRelease('203.0.113.7'); a.ipStatsRelease('203.0.113.7');
    check('快照：峰值并发在飞数被记下，归还后归零', snap.ips[0].peak === 2 && a.ipStatsSnapshot().ips[0].cur === 0 && a.IPSTATS_GLOBAL.cur === 0);
    check('快照：全局计数与 per-IP 一致（中转站对照的分子；封禁命中单独计）', a.IPSTATS_GLOBAL.calls === 2 && a.IPSTATS_GLOBAL.bannedHits === 1 && a.IPSTATS_GLOBAL.tokIn === 16 && a.IPSTATS_GLOBAL.peak === 2, a.IPSTATS_GLOBAL);
    a.noteClientAttempt('198.51.100.5', 'curl');
    check('快照：按敲门次数排序（最吵的排最前）', a.ipStatsSnapshot().ips[0].ip === '203.0.113.7');
    for (let i = 0; i < 600; i++) a.statsIpUsage('198.51.100.5', 'm1', 1, 1, 'b:pc:s' + i);
    const s2 = a.ipStatsSnapshot();
    check('会话基数有界：记满 512 后置饱和标记（显示 ≥512 不再无限涨）', s2.ips.find((x) => x.ip === '198.51.100.5').sessSat === true);
    for (let i = 0; i < 530; i++) a.noteClientAttempt('10.1.' + (i % 256) + '.' + ((i / 256) | 0), 'node-fetch');
    check('IP 基数有界：512 上限 + 淘汰 lastSeen 最旧（不无限涨）', a.IP_STATS.size <= a.IP_STATS_CAP + 1, a.IP_STATS.size);
  }

  /* ─────────────────────────── 2. 真链路 ─────────────────────────── */
  console.log('\n2. 真链路（假上游 + 临时网关 + trustedProxy 模拟多来源）');
  const upState = { slowMs: 0 };
  const up = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      if (req.method === 'GET' && /models/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-ip' }] }));
      }
      const done = () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      };
      if (upState.slowMs) setTimeout(done, upState.slowMs); else done();
    });
  });
  const PU = await freePort(), GW = await freePort();
  await new Promise((r) => up.listen(PU, '127.0.0.1', r));

  const cfgPath = path.join(TMP, 'ip.json');
  const writeCfg = (security) => fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW, health: { intervalSec: 3600, timeoutMs: 3000 }, retries: { perChannel: 0, maxModelFallbacks: 99 },
    security,
    channels: [
      { id: 'mock-ip', name: 'M', protocol: 'openai', baseUrl: `http://127.0.0.1:${PU}/v1`, apiKey: 'sk-i', priority: 10, enabled: true, models: { 'mock-ip': 'mock-ip' } },
    ],
  }));

  let gw = null;
  const spawnGw = async (suffix) => {
    gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'usage' + suffix + '.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' },
      stdio: 'ignore',
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      try { if ((await fetch(`http://127.0.0.1:${GW}/healthz`)).ok) return true; } catch { }
      await sleep(200);
    }
    return false;
  };
  const stopGw = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const chat = (xff, key, extra) => fetch(`http://127.0.0.1:${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (key === undefined ? GW_KEY : key), ...(xff ? { 'X-Forwarded-For': xff } : {}), 'User-Agent': (extra && extra.ua) || 'codex_cli_rs/1.0' },
    body: JSON.stringify({ model: 'mock-ip', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }], ...(extra && extra.pck ? { prompt_cache_key: extra.pck } : {}) }),
  });
  const stats = async () => (await fetch(`http://127.0.0.1:${GW}/admin/api/stats`, { headers: { Authorization: 'Bearer ' + AD_KEY } })).json();
  const rowOf = (s, ip) => (s.ips || []).find((x) => x.ip === ip);

  try {
    writeCfg({ trustedProxy: '127.0.0.1', bannedIPs: ['203.0.113.7'] });
    if (!await spawnGw('1')) throw new Error('临时网关未起来');

    const banned = await chat('203.0.113.7');
    check('预置封禁（config.security.bannedIPs）→ 客户端面 403', banned.status === 403, banned.status);
    check('403 错误体写明来源被封', /banned source ip/.test(await banned.text()));
    const ok5 = await chat('198.51.100.5', undefined, { pck: 'session-alpha-01' });
    check('未封禁来源照常 200', ok5.status === 200, ok5.status);
    const wrongKey = await chat('198.51.100.99', 'wrong-key');
    check('错误密钥 → 401（鉴权照常）', wrongKey.status === 401, wrongKey.status);

    let s = await stats();
    check('统计端点：三个来源各占一行（含被封的那个）', !!rowOf(s, '203.0.113.7') && !!rowOf(s, '198.51.100.5') && !!rowOf(s, '198.51.100.99'), s.ips && s.ips.map((x) => x.ip));
    check('401 也算敲门（刷鉴权是指纹不是隐形）', rowOf(s, '198.51.100.99').calls === 1, rowOf(s, '198.51.100.99'));
    check('成功来源：token/模型/客户端标签/会话都记上', (() => { const r = rowOf(s, '198.51.100.5'); return r.tokIn === 3 && r.tokOut === 2 && r.models[0].k === 'mock-ip' && r.clients.some((c) => c.k === 'codex CLI') && r.sessions === 1; })(), rowOf(s, '198.51.100.5'));
    check('被封来源：banned 标记 + 封禁命中在涨（封了还在敲看得见）', rowOf(s, '203.0.113.7').banned === true && rowOf(s, '203.0.113.7').bannedHits === 1, rowOf(s, '203.0.113.7'));
    check('全局计数 = 全部来源敲门数（封禁命中单独计，中转站对照的分子）', s.global.calls === 2 && s.global.bannedHits === 1, s.global);

    const ok5b = await chat('198.51.100.5', undefined, { pck: 'session-beta-02' });
    check('同一来源换会话键 → 会话数 +1', ok5b.status === 200 && rowOf(await stats(), '198.51.100.5').sessions === 2);

    upState.slowMs = 350;
    const [pa, pb] = await Promise.all([chat('198.51.100.5'), chat('198.51.100.5')]);
    check('并行两发（同来源）都 200（限流默认关不误伤）', pa.status === 200 && pb.status === 200, [pa.status, pb.status]);
    await sleep(450);
    s = await stats();
    check('per-IP 峰值并发 ≥2 被记下（中转站指纹）', rowOf(s, '198.51.100.5').peak >= 2, rowOf(s, '198.51.100.5'));
    check('全局峰值并发 ≥2（全局远超任何单 IP = 轮换出口的中转站指纹）', s.global.peak >= 2, s.global);
    check('结束后在飞数归零（finish/close 双路归还生效）', s.global.cur === 0 && rowOf(s, '198.51.100.5').cur === 0, s.global);
    upState.slowMs = 0;

    const badBan = await fetch(`http://127.0.0.1:${GW}/admin/api/bans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY }, body: JSON.stringify({}) });
    check('POST /admin/api/bans 空 body → 400', badBan.status === 400, badBan.status);
    const badBan2 = await fetch(`http://127.0.0.1:${GW}/admin/api/bans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY }, body: JSON.stringify({ ip: 'evil.example' }) });
    check('POST /admin/api/bans 非字面量 → 400（不进任何匹配逻辑）', badBan2.status === 400, badBan2.status);

    const ban23 = await fetch(`http://127.0.0.1:${GW}/admin/api/bans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY }, body: JSON.stringify({ ip: '198.51.100.23' }) });
    const ban23j = await ban23.json();
    check('POST 封禁 → 200 且名单回显', ban23.status === 200 && ban23j.banned.includes('198.51.100.23'), ban23j);
    const after23 = await chat('198.51.100.23');
    check('封禁立即生效：该来源 403', after23.status === 403, after23.status);
    const still5 = await chat('198.51.100.5');
    check('外科手术式：别的来源不受牵连', still5.status === 200, still5.status);
    const adm = await fetch(`http://127.0.0.1:${GW}/admin/api/stats`, { headers: { Authorization: 'Bearer ' + AD_KEY } });
    check('封禁不影响管理面（解封按钮永远够得着）', adm.status === 200, adm.status);
    s = await stats();
    check('封禁后继续敲 → bannedHits 又 +1', rowOf(s, '198.51.100.23').bannedHits === 1, rowOf(s, '198.51.100.23'));
    const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('封禁落 config.json（security 段持久化）且渠道没被抹掉', (disk.security.bannedIPs || []).includes('198.51.100.23') && disk.channels.length === 1, disk.security);

    const unban = await fetch(`http://127.0.0.1:${GW}/admin/api/bans/198.51.100.23`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + AD_KEY } });
    check('DELETE 解封 → 200', unban.status === 200, unban.status);
    const back23 = await chat('198.51.100.23');
    check('解封立即生效：该来源又能 200', back23.status === 200, back23.status);
    const unban404 = await fetch(`http://127.0.0.1:${GW}/admin/api/bans/198.51.100.23`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + AD_KEY } });
    check('重复解封 → 404（不装死也不重复扣）', unban404.status === 404, unban404.status);
    const disk2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('解封也落盘（名单里已移除，渠道仍在）', !(disk2.security.bannedIPs || []).includes('198.51.100.23') && disk2.channels.length === 1, disk2.security);

    await stopGw();
    if (!await spawnGw('1b')) throw new Error('重启网关未起来');
    s = await stats();
    check('重启后：统计清零（内存态，检测数据丢得起）', s.global.calls === 0 && s.global.bannedHits === 0 && s.ips.length === 0, s.global);
    check('重启后：封禁名单从 config 恢复可见', s.banned.includes('203.0.113.7'), s.banned);
    const rebanned = await chat('203.0.113.7');
    check('重启后：预置封禁仍在（403）', rebanned.status === 403, rebanned.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
  }

  /* ─────────────────────────── 3. 对照组：不设 trustedProxy 时 XFF 一律不采信 ─────────────────────────── */
  console.log('\n3. 对照组：无 trustedProxy（直连部署）');
  try {
    writeCfg({});
    if (!await spawnGw('2')) throw new Error('对照网关未起来');
    const r = await chat('1.2.3.4');
    check('带伪造 XFF 的请求照常 200（不因带头被拒）', r.status === 200, r.status);
    const s = await stats();
    check('伪造 XFF 不被采信：来源记成真实 socket 地址', !!rowOf(s, '127.0.0.1') && !rowOf(s, '1.2.3.4'), s.ips && s.ips.map((x) => x.ip));
    const banSpoof = await fetch(`http://127.0.0.1:${GW}/admin/api/bans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + AD_KEY }, body: JSON.stringify({ ip: '1.2.3.4' }) });
    check('照 IP 字面量照样能封（封的是键，不是"采信"逻辑）', banSpoof.status === 200, banSpoof.status);
  } catch (e) {
    fail++;
    console.log('  ✗ 运行异常: ' + (e && e.message));
  } finally {
    await stopGw();
    try { up.close(); } catch { }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exitCode = fail ? 1 : 0;   // 不 process.exit()：Windows 上撞到未关句柄会崩
})();
