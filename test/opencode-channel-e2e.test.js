/* ═══════════════════════════════════════════════════════════════════════════
 * test/opencode-channel-e2e.test.js —— opencode 免费模型渠道（v1.18.72）的端到端回归
 *
 * 跑法：node test/opencode-channel-e2e.test.js   （退出码非 0 表示有回归）
 *
 * 这个文件守的是"**能把 opencode 免费模型接进网关**"这件事的**行为**，
 * 而不是"代码里出现了 opencode 这个词"。做法同 test/channel-default-alias-e2e.test.js：
 * 真起「假边车」+「临时网关实例」，走完整 HTTP 链路（动态空闲端口；配置/用量在临时目录，
 * **绝不动仓库 config.json/usage.json**）。
 *
 * 为什么值得单开一个文件（而不是并进 hark 那个）：opencode 这条链路有**四个专属陷阱**，
 * 每一个都只有真跑才看得见，而且失败形态都很"安静"：
 *   ① **会话必须用完即删** —— 边车里的会话落在用户自己账号下。漏删 = 每一次网关请求
 *      都在用户账号里堆一条会话，上不封顶，而请求本身**照样成功**，所以不跑就永远发现不了。
 *   ② **每请求必须拍平 messages** —— 边车的会话**不保留多轮记忆**（实测），
 *      所以"复用会话省一次建会话"是个看起来聪明、实际把上下文丢掉的优化。
 *   ③ **不许给边车传 `stream`** —— 那个端点没有 stream 参数；真流式只能由网关伪流式伪造。
 *   ④ **200 + 空正文 = 失败**（v1.18.26/32 的纪律）：边车回了 200 不等于客户端拿到了东西。
 *
 * 另有一组**脱敏守卫**：边车 `GET /api/model` 的每一条模型都带 `headers:{"x-opencode-org-id":…}`，
 * 那是账号标识。渠道目录只许取 `id`——这个文件用假边车**故意**在目录里放一个哨兵字符串，
 * 断言它**绝不出现在探测响应、渠道模型表、错误文案里**（AGENTS.md 的密钥与隐私血泪条款）。
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const MOD = fs.readFileSync(path.join(ROOT, 'opencode.js'), 'utf8').replace(/\r\n/g, '\n');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
const DESIGN = fs.readFileSync(path.join(ROOT, 'console-redesign.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'build', 'app.js'), 'utf8');
const CONSOLE_HTML = fs.readFileSync(path.join(ROOT, 'console.html'), 'utf8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-opencode-'));

const GW_KEY = 'oc-gw', AD_KEY = 'oc-admin';
const PW = 'test-sidecar-pw';
const ALIAS = 'oc-free';
const UPSTREAM = 'deepseek-v4.1-flash-free';
const ORG_SENTINEL = 'org_SENTINEL_MUST_NOT_LEAK_12345';
const CATALOG = [UPSTREAM, 'nemotron-3.5-lightning-free', 'space-bunny-free', 'gpt-6-astra', 'glm-5.3'];
// v1.18.89：边车 1.0+ 换了生成路由（`POST /session/{id}/message`）。这里放两个哨兵钉住两件事：
//   · `REASONING_SENTINEL` 只出现在 `reasoning` part 里 ⇒ 它**绝不许**混进给客户端的正文；
//   · `SPA_SENTINEL` 是"路由不存在的 200 + text/html 兜底页"⇒ 收到它必须判失败，不能当回答。
const REASONING_SENTINEL = 'REASONING_THOUGHTS_MUST_NOT_LEAK_777';
const SPA_SENTINEL = '<!doctype html><html><body>SPA_FALLBACK_MUST_NOT_BE_ANSWER</body></html>';
const NEW_TEXT = '新路由答复（POST /session/{id}/message）';
const NEW_IN = 4321, NEW_OUT = 7;

let pass = 0, fail = 0;
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (extra !== undefined ? '   ← ' + JSON.stringify(extra).slice(0, 320) : '')); }
};
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────── 假 opencode 边车 ───────────────────────────────
// 只实现网关真正会用到的那四个端点，够用即可（过多实现反而会让守卫失去分辨力）。
function startFakeSidecar(opts) {
  const o = opts || {};
  const seen = { catalog: 0, creates: [], generates: [], deletes: [], news: [] };
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c.toString('utf8'); });
    req.on('end', () => {
      const p = (req.url || '').split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      // 真边车是 SPA：**任何不存在的路径都回 200 + text/html**（这正是老路由换版后的失败形态）
      const sendHtml = () => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(SPA_SENTINEL); };
      // 鉴权：HTTP Basic，用户名必须 opencode、密码必须 PW（否则 401 —— 与真边车一致）
      const auth = String(req.headers.authorization || '');
      const ok = auth === 'Basic ' + Buffer.from('opencode:' + PW, 'utf8').toString('base64');
      if (!ok) return send(401, { _tag: 'UnauthorizedError', message: 'Authentication required' });

      if (p === '/api/model' && req.method === 'GET') {
        seen.catalog++;
        // ★ 每条都带 org id（真边车就是这样）——网关只许取 id
        return send(200, { location: { directory: '/tmp/x' }, data: CATALOG.map((id) => ({ id, providerID: 'opencode', headers: { 'x-opencode-org-id': ORG_SENTINEL } })) });
      }
      if (p === '/api/session' && req.method === 'POST') {
        const id = 'ses_test' + (++n);
        seen.creates.push({ id, body });
        return send(200, { data: { id, tokens: { input: 0, output: 0 }, cost: 0 } });
      }
      // ★ v1.18.89 新版路由（无 /api 前缀）：同步返回 {info:{tokens}, parts:[…]}
      const nm = p.match(/^\/session\/([^/]+)\/message$/);
      if (nm && req.method === 'POST' && /^(new|reasoning|html)$/.test(String(o.mode || ''))) {   // 只有这三档模拟新版；其余档（empty/paid503/freetier）走老路径，§3/§4 的守卫原样保留
        seen.news.push({ id: nm[1], body });
        if (o.mode === 'html') return sendHtml();
        const parts = [{ type: 'step-start' }];
        if (o.mode === 'reasoning') parts.push({ type: 'reasoning', text: REASONING_SENTINEL });
        parts.push({ type: 'text', text: o.newReply || NEW_TEXT });
        parts.push({ type: 'step-finish' });
        return send(200, { info: { tokens: { input: NEW_IN, output: NEW_OUT, cache: { read: 96 }, reasoning: 0 }, cost: 0 }, parts });
      }
      const gm = p.match(/^\/api\/session\/([^/]+)\/generate$/);
      if (gm && req.method === 'POST') {
        seen.generates.push({ id: gm[1], body });
        if (o.mode === 'html') return sendHtml();   // 老路由在 1.4.2 上回的就是这个
        if (o.mode === 'empty') return send(200, { data: { text: '' } });
        if (o.mode === 'paid503') return send(503, { _tag: 'ServiceUnavailableError', message: 'Upstream request failed: Insufficient account funds' });
        if (o.mode === 'freetier') return send(503, { _tag: 'ServiceUnavailableError', message: "OpenCode's free tier can only be used from within OpenCode." });
        return send(200, { data: { text: o.reply || '边车正常答复' } });
      }
      const dm = p.match(/^\/api\/session\/([^/]+)$/);
      if (dm && req.method === 'DELETE') {
        seen.deletes.push(dm[1]);
        res.writeHead(204); return res.end();
      }
      // 'new' 模式：老路由在 1.4.2 上其实是 200+HTML；这里用 404 也行（网关两条都覆盖）
      send(404, { _tag: 'NotFoundError', message: 'no route ' + p });
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) })));
}

async function startGateway(channels) {
  const port = await freePort();
  const cfgPath = path.join(TMP, `cfg-${port}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ port, gatewayKey: GW_KEY, adminKey: AD_KEY, channels }, null, 2));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, `usage-${port}.json`) },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += d.toString(); });
  srv.stderr.on('data', (d) => { log += d.toString(); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base + '/health'); if (r.status < 500) break; } catch {} await sleep(150); }
  return { base, log: () => log, stop: async () => { try { srv.kill(); } catch {} await sleep(300); } };
}

const jpost = async (base, p, body, key) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

// 渠道 lastError 读管理面即可——但它会被探测的"半愈合"清掉（v1.18.40 的设计：
// 探测成功只放开冷却，不证明对话能用）。所以"失败原因记下来了没有"要看**账本**（ok:false 那行）
// 或客户端拿到的错误体，不能只看 lastError 那一瞬：假边车在 empty/paid503 模式下
// `GET /api/model` 照样 200，探测一跑就把 lastError 抹了——第一版就是这么假红的。
const usageBlobOf = async (base) => {
  const r = await fetch(base + '/admin/api/usage', { headers: { Authorization: 'Bearer ' + AD_KEY } });
  return await r.text().catch(() => '');
};
const lastErrorOf = async (base, id) => {
  const r = await fetch(base + '/admin/api/channels', { headers: { Authorization: 'Bearer ' + AD_KEY } });
  let j = null; try { j = await r.json(); } catch {}
  const c = ((j && j.channels) || []).find((x) => x.id === id);
  return String((c && (c.lastError || c.error)) || '');
};

function chDef(sidecarPort, extra) {
  return Object.assign({
    id: 'oc1', name: 'opencode 边车', protocol: 'opencode',
    baseUrl: `http://127.0.0.1:${sidecarPort}`, apiKey: PW,
    models: { [ALIAS]: UPSTREAM }, enabled: true, autoAlias: false, priority: 0,
  }, extra || {});
}

(async () => {
  // ─────────────────────────── §1 装配守卫（现读源码，防回潮）───────────────────────────
  console.log('══ §1 装配守卫（现读源码）══');
  check('server.js require 了 opencode.js', /const opencode = require\('\.\/opencode\.js'\)/.test(SRC));
  check('★ Dockerfile 白名单有 COPY opencode.js（漏了 = 容器启动即 crash-loop）', /^COPY opencode\.js \.\/$/m.test(DOCKERFILE));
  check('protocol 允许清单含 opencode（含报错文案）', /\|hark\|opencode'/.test(SRC));
  check('探测分支（probeChannel）走边车目录', /opencode\.opencodeCatalog\(ch\.def, zzFetch/.test(SRC));
  check('探测分支（probeDef，即控制台「获取模型」）走边车目录', /opencode\.opencodeCatalog\(def, zzFetch/.test(SRC));
  check('聊天出站走 tryOpencodeChannel', /return await tryOpencodeChannel\(specialOpts\)/.test(SRC) && /async function tryOpencodeChannel\(opts\)/.test(SRC));
  check('候选链兜底含 opencode（openAICandidateChain）', /channelsServing\(requested, 'opencode'\)/.test(SRC));
  check('管理面手动测试有 opencode 分支且真发一条', /if \(ch\.def\.protocol === 'opencode'\)[\s\S]{0,400}opencode\.opencodeGenerate\(ch\.def, zzFetch/.test(SRC));
  check('聚合模型列表的 aliasedProto 含 opencode', /aliasedProto = \[[^\]]*'opencode'\]/.test(SRC));
  // 目录里带 org id 是**真事**，所以模块里必须留着这个名字做警示——但只许出现在注释里：
  // 断言"整个文件不含这个词"是错的（那会把警示注释也逼掉），要断言的是"代码行不碰它"。
  const orgLines = MOD.split('\n').filter((l) => l.includes('x-opencode-org-id'));
  check('★ 目录只取 id，代码绝不读 entry.headers（org id 只作为注释里的警示出现）',
    /arr\.map\(\(m\) => String\(\(m && m\.id\) \|\| ''\)\)/.test(MOD)
    && !/\bm\.headers\b|\bentry\.headers\b/.test(MOD)
    && orgLines.length > 0 && orgLines.every((l) => l.trim().startsWith('//')),
    { orgLines: orgLines.length, sample: orgLines[0] && orgLines[0].trim().slice(0, 60) });
  check('★ 会话 id 读的是 data.id（不是顶层 id——写错会静默 undefined）', /const id = j && j\.data && j\.data\.id/.test(MOD));
  check('★ 删除会话在 generate 之后、且成功失败都走（finally 语义）', /opencodeDeleteSession\(def, fetchFn, ses\.id/.test(MOD));
  check('模块 exports 齐（generate / catalog / flatten / probe）', /opencodeGenerate/.test(MOD) && /flattenForOpencode/.test(MOD) && /module\.exports/.test(MOD));
  check('前端 PROTO_META 含 opencode（设计稿）', /opencode:\{label:'opencode 免费模型'/.test(DESIGN));
  check('前端 PROTO_ORDER 含 opencode（设计稿）', /PROTO_ORDER=\[[^\]]*'opencode'\]/.test(DESIGN));
  check('前端 PROTO_META / PROTO_ORDER 含 opencode（生产 build/app.js）', /opencode:\{label:'opencode 免费模型'/.test(APP_SRC) && /PROTO_ORDER=\[[^\]]*'opencode'\]/.test(APP_SRC));
  check('★ 产物 console.html 已重建（含 opencode 协议项）', /opencode:\{label:'opencode 免费模型'/.test(CONSOLE_HTML) && /PROTO_ORDER=\[[^\]]*'opencode'\]/.test(CONSOLE_HTML));
  check('模块头写明合规/封号风险（免费层条款是 from within OpenCode）', /can only be used from within OpenCode/.test(MOD) && /封号风险/.test(MOD));

  // ★ v1.18.72 补：渠道钥匙框里的那个值**不是给渠道起的名**，而是**两处必须同值的共享秘密**
  //   —— 起边车时由 `OPENCODE_SERVER_PASSWORD` 定下来，网关在这里一字不差地递回去。
  //   这一段是被真实提问逼出来的（连问三次"这个变量在哪 / 随便填行不行"），所以钉住它，
  //   别让"钥匙框随便填"的误解再回来。
  const ocMod = require(path.join(ROOT, 'opencode.js'));
  const b64 = (s) => 'Basic ' + Buffer.from(s, 'utf8').toString('base64');
  check('★ basicAuth：普通口令 → Basic base64("opencode:<口令>")（用户名默认 opencode，不用你填）',
    ocMod.basicAuth({ apiKey: PW }) === b64('opencode:' + PW));
  check('★ basicAuth：`user:pass` 形态按**第一个冒号**拆 ⇒ 口令里带冒号会被静默当成"改用户名"（所以口令别带冒号）',
    ocMod.basicAuth({ apiKey: 'someone:' + PW }) === b64('someone:' + PW)
    && ocMod.basicAuth({ apiKey: 'my:key' }) === b64('my:key')
    && ocMod.basicAuth({ apiKey: 'my:key' }) !== b64('opencode:my:key'),
    { plain: ocMod.basicAuth({ apiKey: 'my:key' }) });
  check('★ 模块头留住"不设口令 ≠ 不用口令"这条实测（`serve` 没有 --password；不设则边车自造一个并打进日志 = 泄露面）',
    /不设口令/.test(MOD) && /--password/.test(MOD) && /日志/.test(MOD));

  // ─────────────────────────── §2 探测：只列免费 + 不泄露 org id ───────────────────────────
  console.log('\n══ §2 探测（控制台「获取模型」）══');
  const fake = await startFakeSidecar({});
  const gw = await startGateway([chDef(fake.port)]);

  let r = await jpost(gw.base, '/admin/api/probe', { baseUrl: `http://127.0.0.1:${fake.port}`, apiKey: PW, protocol: 'opencode' }, AD_KEY);
  check('探测成功', r.status === 200 && r.j.ok === true, { status: r.status, j: r.j });
  const models = (r.j && r.j.models) || [];
  check('★ 只列免费模型（付费模型在这台机器上必定 503，列了就是塞一批永远失败的渠道）',
    models.length === 3 && models.includes(UPSTREAM) && !models.includes('gpt-6-astra') && !models.includes('glm-5.3'), models);
  check('★ 目录里的 org id 哨兵绝不出现在探测响应里（密钥与隐私血泪条款）',
    !JSON.stringify(r.j || {}).includes(ORG_SENTINEL), String(JSON.stringify(r.j || {})).slice(0, 200));
  check('探测带 account.note 说明"只列免费、付费会 503"', !!(r.j && r.j.account && /免费/.test(String(r.j.account.note)) && /503/.test(String(r.j.account.note))), r.j && r.j.account);
  check('note 里也点明了封号风险（别让用户以为只是"配置一下")', !!(r.j && r.j.account && /风险|条款/.test(String(r.j.account.note))), r.j && r.j.account);

  r = await jpost(gw.base, '/admin/api/probe', { baseUrl: `http://127.0.0.1:${fake.port}`, apiKey: 'wrong-pw', protocol: 'opencode' }, AD_KEY);
  check('★ 密码错 → 探测失败且文案点明是"边车密码"（不是"模型不可用"）',
    r.status === 200 && r.j.ok === false && /401|密码/.test(String(r.j.error)), { j: r.j });

  // ─────────────────────────── §3 非流式对话：拍平 + 用完即删 ───────────────────────────
  console.log('\n══ §3 非流式对话（真链路）══');
  const before = { creates: fake.seen.creates.length, deletes: fake.seen.deletes.length };
  let resp = await fetch(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model: ALIAS, messages: [{ role: 'system', content: '你是助手' }, { role: 'user', content: '你好' }] }),
  });
  let j = null; try { j = await resp.json(); } catch {}
  check('★ 端到端：正文从边车回到客户端', resp.status === 200 && j && j.choices && j.choices[0].message.content === '边车正常答复', { status: resp.status, j: j && j.error });
  check('响应是标准 OpenAI 非流式形状（object=chat.completion）', j && j.object === 'chat.completion' && j.choices[0].finish_reason === 'stop');

  const gen1 = fake.seen.generates[fake.seen.generates.length - 1];
  const genBody = JSON.parse(gen1.body);
  check('★ 发给边车的报文只有 prompt 一个字段（边车没有 stream 参数，多传就是自找 400）',
    Object.keys(genBody).length === 1 && typeof genBody.prompt === 'string', Object.keys(genBody));
  check('★ messages 被拍平成一段文本（含【系统设定】与【用户】两段——边车不保留多轮记忆，不拍平就丢上下文）',
    /【系统设定】/.test(genBody.prompt) && /【用户】/.test(genBody.prompt) && genBody.prompt.indexOf('【系统设定】') < genBody.prompt.indexOf('【用户】'), genBody.prompt.slice(0, 120));
  check('拍平文本保留了原文内容（系统与用户各自的原话都在）', genBody.prompt.includes('你是助手') && genBody.prompt.includes('你好'));

  const created1 = fake.seen.creates[fake.seen.creates.length - 1];
  check('建会话用的是 {model:{id,providerID}} 形状（providerID 必须是 opencode）',
    JSON.parse(created1.body).model.id === UPSTREAM && JSON.parse(created1.body).model.providerID === 'opencode', JSON.parse(created1.body));
  check('★ 用掉的会话真的被删了（不删就在用户账号里堆会话，而请求照样成功）',
    fake.seen.deletes.includes(gen1.id), { gen: gen1.id, deletes: fake.seen.deletes });
  check('★ 会话建/删数量相等（每个请求都配平）',
    fake.seen.creates.length - before.creates === fake.seen.deletes.length - before.deletes,
    { c: fake.seen.creates.length - before.creates, d: fake.seen.deletes.length - before.deletes });
  check('账本按估算记账（边车不下发 token，usage 是估出来的正数）',
    j && j.usage && j.usage.prompt_tokens > 0 && j.usage.completion_tokens > 0, j && j.usage);

  // ─────────────────────────── §4 流式：伪流式 SSE 形状 ───────────────────────────
  console.log('\n══ §4 流式（伪流式）══');
  resp = await fetch(gw.base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
    body: JSON.stringify({ model: ALIAS, stream: true, messages: [{ role: 'user', content: '流式问一句' }] }),
  });
  const sse = await resp.text();
  check('流式请求 200 + text/event-stream', resp.status === 200 && String(resp.headers.get('content-type') || '').includes('text/event-stream'), resp.headers.get('content-type'));
  check('★ SSE 有 role 首帧', /"delta":\{"role":"assistant"/.test(sse), sse.slice(0, 160));
  check('★ SSE 正文帧带边车原文', sse.includes('边车正常答复'));
  check('★ SSE 以 finish_reason=stop 收尾', /"finish_reason":"stop"/.test(sse));
  check('★ SSE 以 data: [DONE] 结束（少这一帧客户端会一直等）', /data: \[DONE\]/.test(sse.trim()));
  check('流式这条也把会话删干净了', fake.seen.creates.length === fake.seen.deletes.length, { c: fake.seen.creates.length, d: fake.seen.deletes.length });

  // ─────────────────────────── §5 失败面：三个"安静失败"都要如实失败 ───────────────────────────
  console.log('\n══ §5 失败面（都必须如实失败，不许伪装成功）══');
  const gw2 = await startGateway([chDef(fake.port)]);

  for (const [mode, label, want] of [
    ['empty', '★ 200 + 空正文 → 判失败（"上游回 200"≠"客户端拿到了东西"）', /empty|空/],
    ['paid503', '★ 503 余额不足 → 如实失败', /503|funds/],
  ]) {
    const f = await startFakeSidecar({ mode });
    const g = await startGateway([chDef(f.port)]);
    const rr = await fetch(g.base + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'x' }] }),
    });
    const bodyText = await rr.text().catch(() => '');
    const seenOk = rr.status === 200 && bodyText.includes('边车正常答复');
    check(label, !seenOk && rr.status >= 400, { status: rr.status, body: bodyText.slice(0, 120) });
    const led = await usageBlobOf(g.base);
    check('  └ 失败原因带 opencode: 前缀进了错误体或账本（失败行要看得出在调哪家）',
      /opencode:/.test(bodyText) && want.test(bodyText) || (/opencode:/.test(led) && want.test(led)),
      { body: bodyText.slice(0, 140), led: led.slice(0, 140) });
    // ★ 失败也要删会话（不能因为 generate 失败就把建出来的会话留在账号里）
    check('  └ ★ generate 失败时建出来的会话也被删了', f.seen.creates.length === f.seen.deletes.length, { c: f.seen.creates.length, d: f.seen.deletes.length });
    await g.stop(); await f.close();
  }

  // 免费层墙：只有"会话路"是被认可的；万一撞上，必须原样把上游那句话带出来
  {
    const f = await startFakeSidecar({ mode: 'freetier' });
    const g = await startGateway([chDef(f.port)]);
    const rr = await fetch(g.base + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'x' }] }),
    });
    const bodyText = await rr.text().catch(() => '');
    const le = await lastErrorOf(g.base, 'oc1');
    check('★ 撞免费层墙时把上游原话带进渠道 lastError 或错误体（否则"没登录态"会被读成"模型不可用"）',
      /free tier can only be used from within OpenCode/i.test(le) || /free tier can only be used from within OpenCode/i.test(bodyText),
      { lastError: le.slice(0, 120), body: bodyText.slice(0, 120) });
    await g.stop(); await f.close();
  }

  // 连不上边车（边车没起）→ 失败，而不是空成功
  {
    const dead = await freePort();
    const g = await startGateway([chDef(dead)]);
    const rr = await fetch(g.base + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: 'x' }] }),
    });
    check('★ 边车没起 → 请求失败（不是 200 空回复）', rr.status >= 400, rr.status);
    await g.stop();
  }

  // ─────────────── §5b 边车版本兼容（v1.18.89）：新路由 / 200 HTML 陷阱 / reasoning 隔离 ───────────────
  // 为什么单开一节：边车升到 1.0+ 之后**老生成路由消失**，而 SPA 把"路由不存在"回成 **200 + text/html**。
  // 按老写法（只认 data.text、不看 content-type）网关会把一张网页当模型的回答发给客户端——
  // 那是一种"看起来成功、内容全错"的坏法，比报错难查得多。三条断言各钉一个：走新路由、只拼 text part、HTML 必判失败。
  console.log('\n══ §5b 边车版本兼容（新路由 + 200 HTML 陷阱 + reasoning 隔离）══');
  {
    const chat = (base) => fetch(base + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY },
      body: JSON.stringify({ model: ALIAS, messages: [{ role: 'user', content: '你好' }] }),
    });

    // 5b-1 新路由优先，且用上游真 token
    const fNew = await startFakeSidecar({ mode: 'new' });
    const gNew = await startGateway([chDef(fNew.port)]);
    let rr = await chat(gNew.base);
    let jj = null; try { jj = await rr.json(); } catch {}
    check('★ 新版路由被用上（POST /session/{id}/message）', fNew.seen.news.length === 1, fNew.seen.news.length);
    check('★ 新版优先时不再白打一发老路由（/api/session/{id}/generate）', fNew.seen.generates.length === 0, fNew.seen.generates.length);
    check('正文取自 parts 里的 text part', rr.status === 200 && String((jj && jj.choices && jj.choices[0] && jj.choices[0].message && jj.choices[0].message.content) || '').includes(NEW_TEXT), jj);
    check('★ 上游真 token 进 usage（不是 estimateTokens 按字符估的）',
      !!(jj && jj.usage) && jj.usage.prompt_tokens === NEW_IN && jj.usage.completion_tokens === NEW_OUT, jj && jj.usage);
    check('★ 新路由下会话照样被删（建/删配平——这条纪律换路由也不许丢）',
      fNew.seen.creates.length === fNew.seen.deletes.length, { creates: fNew.seen.creates.length, deletes: fNew.seen.deletes.length });
    await gNew.stop(); await fNew.close();

    // 5b-2 reasoning part 不许混进正文
    const fRe = await startFakeSidecar({ mode: 'reasoning' });
    const gRe = await startGateway([chDef(fRe.port)]);
    rr = await chat(gRe.base);
    jj = null; try { jj = await rr.json(); } catch {}
    const content = String((jj && jj.choices && jj.choices[0] && jj.choices[0].message && jj.choices[0].message.content) || '');
    check('★ reasoning part 的正文绝不混进回答（它也带 text 字段，不过滤就是把思维链当答案）',
      !content.includes(REASONING_SENTINEL) && content.includes(NEW_TEXT), { len: content.length });
    await gRe.stop(); await fRe.close();

    // 5b-3 200 + text/html 必须判失败
    const fH = await startFakeSidecar({ mode: 'html' });
    const gH = await startGateway([chDef(fH.port)]);
    rr = await chat(gH.base);
    const body = await rr.text();
    check('★ 边车回 200 + HTML（路由不存在的 SPA 兜底页）→ 网关判失败，绝不把网页当回答发给客户端',
      rr.status >= 400 && !body.includes('SPA_FALLBACK_MUST_NOT_BE_ANSWER'), { status: rr.status, head: body.slice(0, 140) });
    check('错误文案点明"回了 HTML / 路由不存在"（把人直接引到版本问题，而不是去猜模型）',
      /HTML/.test(body), body.slice(0, 220));
    await gH.stop(); await fH.close();
  }
  // ─────────────── §6 与 hark 的分野：opencode **有**目录，不适用"无目录协议"硬要求 ───────────────
  console.log('\n══ §6 与 hark 的分野（有目录 vs 无目录）══');
  check('★ opencode 探测分支**不**套"无目录协议"的默认别名建议（它有 GET /api/model）',
    !/if \(\(def\.protocol \|\| 'openai'\) === 'opencode'\)[\s\S]{0,900}if \(!models\.length\) models = \[/.test(SRC));
  const sites = (SRC.match(/let models = Object\.values\(def\.models \|\| \{\}\)\.filter\(Boolean\);\s*\n\s*if \(!models\.length\) models = \[/g) || []).length;
  check('"无目录协议"仍是四家（opencode 不算进去）', sites === 4, sites);
  check('validateChannelDef 的零别名守卫只 scoped 到 hark（opencode 可自动补别名）', /if \(def\.protocol === 'hark'\)/.test(SRC) && !/def\.protocol === 'opencode'\)\s*\{\s*const aliases/.test(SRC));

  await gw2.stop(); await gw.stop(); await fake.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n══════ 通过 ${pass} · 失败 ${fail} ══════`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
