#!/usr/bin/env node
/* notion 内联附件（CSV/文件让 AI 读，v1.18.41）—— 零依赖回归
 *
 * 现场与依据（详见 docs/notion-attachment-upload-research.md §4）：notion2api 的 windows 发布包里
 * `upstream.base_url` 是可配的，把它指向一个记录代理就抓到了它发给 Notion 的**原始报文**。
 * 抓到的关键两样，也是本用例守的东西：
 *   ① config step 里有 `enableCsvAttachmentSupport: true`（我们此前只发 4 个字段，没有这个开关）；
 *   ② **CSV 根本不上 S3** —— 它把文件内联进 user step 正文，追加一行
 *      {"file":{"file_data":"data:text/csv;base64,…","filename":"probe.csv"},"type":"file"}
 *
 * 本用例守四件事：
 *   ① 单元：只认 base64 data URL；文件名净化；OpenAI / Anthropic 两种客户端形状都收；上限 3 个 / 1MB；
 *      ★ 产出的那一行与 notion2api 抓到的字节**逐字相同**（下面是把抓包原文嵌进来的字面量）。
 *   ② 真链路（假 Notion 上游 + 临时网关）：开了 notionAttachments 的渠道，上游真收到那个开关与那一行；
 *      ★ 对照组：没开的渠道一个字节都不多（报文与从前逐字同形）。
 *   ③ 渠道字段：落库往返 + 保存别的渠道后仍在（persistConfig 是显式字段清单）+ 非布尔 400。
 *   ④ 默认**关**：v1.18.42 起这条的理由不再是"没验证过"，而是**稳妥默认**——内联附件会改 user step
 *      正文、吃 prompt 预算，开关交给渠道自己决定。活体判据已取得（研究文档 §8：对照答"没找到文件"、
 *      带附件答出只存在于 CSV 里的 `K7Q2M9`），"默认关"这条本身仍是断言。
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
const NSRC = fs.readFileSync(path.join(ROOT, 'notion.js'), 'utf8').replace(/\r\n/g, '\n');
const notion = require(path.join(ROOT, 'notion.js'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-attach-'));
const GW_KEY = 'att-gw', AD_KEY = 'att-admin';

// notion2api 实发报文里那一行的原文（抓包抄录，别改）
const CSV = 'secret,note\nK7Q2M9,only-in-file\n';
const B64 = Buffer.from(CSV, 'utf8').toString('base64');
const N2A_LINE = '{"file":{"file_data":"data:text/csv;base64,' + B64 + '","filename":"probe.csv"},"type":"file"}';

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
function sliceFn(name, src = SRC) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return '';
  const rest = src.slice(at + 1);
  const m = rest.match(/\n(?:async )?function |\n\/\/ ─/);
  return m ? rest.slice(0, m.index) : rest;
}

/* 假 Notion 上游：getSpaces 供账号发现，runInferenceTranscript 回一段能出正文的 NDJSON */
function makeNotionFake() {
  const st = { getSpaces: 0, transcripts: 0, bodies: [] };
  const ANSWER = 'K7Q2M9';
  const patch = (t) => JSON.stringify({ type: 'patch', v: [{ o: 'a', p: '/s/-', type: 'text', v: { type: 'text', value: [{ type: 'text', content: t }] } }] }) + '\n';
  const recmap = (t) => {
    const iv = { step: { type: 'markdown-chat', value: [{ type: 'text', content: t }] }, last_edited_time: 1, created_time: 1 };
    return JSON.stringify({ type: 'record-map', recordMap: { thread_message: { m1: { value: { value: iv } } } } }) + '\n';
  };
  st.server = http.createServer((req, res) => {
    const cs = []; req.on('data', (c) => cs.push(c)); req.on('end', () => {
      const url = req.url || '';
      if (url.includes('/getSpaces')) {
        st.getSpaces++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          'user-1': {
            space: { 'space-1': { value: { value: { name: 'Demo Space' } } } },
            space_view: { 'sv-1': { value: { value: { space_id: 'space-1' } } } },
            notion_user: { 'user-1': { value: { value: { given_name: 'Demo', email: 'demo@example.com' } } } },
          },
        }));
      }
      if (url.includes('/runInferenceTranscript')) {
        st.transcripts++;
        let body = null;
        try { body = JSON.parse(Buffer.concat(cs).toString('utf8') || '{}'); } catch { }
        st.bodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        return res.end(patch(ANSWER) + recmap(ANSWER));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return st;
}

const postJson = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { }
  return { status: r.status, body: j, text: t };
};
const getJson = async (url, headers) => {
  const r = await fetch(url, { headers: headers || {} });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { }
  return { status: r.status, body: j, text: t };
};

(async () => {
  /* ══════════ 1. 单元 + 装配守卫 ══════════ */
  console.log('1. 单元：data URL / 文件名净化 / 两种客户端形状 / 上限');
  {
    const acct = { userId: 'user-1', spaceId: 'space-1' };
    check('文件名净化：路径分隔符被剥掉（不把目录带进报文）',
      notion.sanitizeAttachmentFileName('a/b\\c.csv') === 'c.csv' && notion.sanitizeAttachmentFileName('../../etc/passwd') === 'passwd');
    check('文件名净化：引号/换行/控制字符被删（否则整条 step 的 JSON 会破）',
      notion.sanitizeAttachmentFileName('x"y\nz.csv') === 'xyz.csv');
    check('文件名净化：空/非字符串回落 attachment', notion.sanitizeAttachmentFileName('') === 'attachment' && notion.sanitizeAttachmentFileName(null) === 'attachment');
    check('★ 只认 base64 的 data URL（非 base64 一律不收，不猜）',
      !!notion.parseInlineDataUrl('data:text/csv;base64,' + B64) && notion.parseInlineDataUrl('data:text/csv,abc') === null
      && notion.parseInlineDataUrl('https://example.com/x.csv') === null && notion.parseInlineDataUrl('') === null);
    check('单文件超 1MB 拒收（内联进 prompt，不能无限大）',
      notion.parseInlineDataUrl('data:text/csv;base64,' + 'A'.repeat(1500000)) === null && notion.ATTACH_MAX_BYTES === 1024 * 1024);

    const openaiMsgs = [{ role: 'user', content: [{ type: 'text', text: 'Q' }, { type: 'file', file: { filename: 'probe.csv', file_data: 'data:text/csv;base64,' + B64 } }] }];
    const anthMsgs = [{ role: 'user', content: [{ type: 'text', text: 'Q' }, { type: 'document', title: 'probe.csv', source: { type: 'base64', media_type: 'text/csv', data: B64 } }] }];
    check('★ OpenAI 形状收得到（{type:file,file:{filename,file_data}}）',
      notion.notionCollectInlineFiles(openaiMsgs).length === 1 && notion.notionCollectInlineFiles(openaiMsgs)[0].filename === 'probe.csv');
    check('★ Anthropic 形状也收得到（{type:document,source:{type:base64}}）',
      notion.notionCollectInlineFiles(anthMsgs).length === 1 && notion.notionCollectInlineFiles(anthMsgs)[0].mime === 'text/csv');
    check('不认的形状一律忽略（image_url / 纯文本 / 缺 file_data）',
      notion.notionCollectInlineFiles([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }]).length === 0
      && notion.notionCollectInlineFiles([{ role: 'user', content: 'Q' }]).length === 0
      && notion.notionCollectInlineFiles([{ role: 'user', content: [{ type: 'file', file: { filename: 'a.csv' } }] }]).length === 0);
    const four = [{ role: 'user', content: [1, 2, 3, 4].map((i) => ({ type: 'file', file: { filename: i + '.csv', file_data: 'data:text/csv;base64,' + B64 } })) }];
    check('最多 3 个（上限是断言，不是注释）', notion.notionCollectInlineFiles(four).length === 3 && notion.ATTACH_MAX_FILES === 3);

    console.log('\n1b. 与 notion2api 抓到的报文逐字比对');
    const on = notion.buildNotionTranscript(openaiMsgs, 'auto', acct, { attachments: true });
    const userText = on.transcript.find((s) => s.type === 'user').value[0][0];
    check('★ user step 正文里那一行与抓包原文逐字相同', userText.split('\n').pop() === N2A_LINE, userText.split('\n').pop());
    check('★ config step 带上了 enableCsvAttachmentSupport:true（我们此前没有这个开关）',
      on.transcript[0].value.enableCsvAttachmentSupport === true);
    check('原有四个字段一个不动（type/model/modelFromUser/useWebSearch）',
      on.transcript[0].value.type === 'workflow' && on.transcript[0].value.modelFromUser === true && on.transcript[0].value.useWebSearch === true && !!on.transcript[0].value.model);
    const lineCount = userText.split('\n').length;
    check('提示词与附件行之间只有一个换行（不多不少）', lineCount === 2, lineCount);

    console.log('\n1c. 默认关：不开时一个字节都不改');
    const off = notion.buildNotionTranscript(openaiMsgs, 'auto', acct, {});
    const offText = off.transcript.find((s) => s.type === 'user').value[0][0];
    check('★ 不传 attachments → 不开开关', off.transcript[0].value.enableCsvAttachmentSupport === undefined);
    check('★ 不传 attachments → 正文里没有附件行（内容仍与旧版逐字一致）', offText === 'Q', offText);
    const onNoFile = notion.buildNotionTranscript([{ role: 'user', content: 'Q' }], 'auto', acct, { attachments: true });
    check('★ 开了但这一发没有附件 → 报文与"关"逐字相同（开关只为真带附件而加）',
      JSON.stringify(onNoFile.transcript[0].value) === JSON.stringify(off.transcript[0].value)
      && onNoFile.transcript.find((s) => s.type === 'user').value[0][0] === 'Q');
  }

  console.log('\n1d. 装配守卫（源码）');
  {
    const bt = sliceFn('buildNotionTranscript', NSRC);
    check('★ 收集只在 opts.attachments 为真时发生（默认关是源码事实）',
      /const files = \(opts && opts\.attachments\) \? notionCollectInlineFiles\(messages\) : \[\];/.test(bt), bt.match(/const files[\s\S]{0,120}/));
    check('★ 开关只在真有文件时加（不是无条件发）',
      /\.\.\.\(files\.length \? \{ enableCsvAttachmentSupport: true \} : \{\}\)/.test(bt));
    check('附件行只挂到最后一条 user step（不是每条、也不是 context）',
      /const lastUser = \[\.\.\.t\]\.reverse\(\)\.find\(\(s\) => s\.type === 'user'\);/.test(bt));
    check('notion.js 导出新函数（外部/测试能直接用）',
      /sanitizeAttachmentFileName,/.test(NSRC) && /notionCollectInlineFiles,/.test(NSRC) && /notionInlineAttachmentLine,/.test(NSRC));
    const tfn = sliceFn('tryNotionChannel');
    check('★ 真链路把渠道开关透传给构造器（ch.def.notionAttachments === true）',
      /attachments: ch\.def\.notionAttachments === true/.test(tfn), tfn.match(/buildNotionTranscript\(effMessages[\s\S]{0,160}/));
    check('★ 默认关：判定一律 === true（缺字段/字符串/数字都不算开）',
      (SRC.match(/notionAttachments === true/g) || []).length >= 3
      && (sliceFn('tryNotionChannel').match(/notionAttachments/g) || []).length === 1);
    const pc = sliceFn('persistConfig');
    check('★ persistConfig 白名单含 notionAttachments（漏一行就被下一次渠道保存抹掉）',
      /notionAttachments: ch\.def\.notionAttachments === true \? true : undefined,/.test(pc));
    check('GET /admin/api/channels 也回填它（否则表单回写就把开关抹了）',
      (SRC.match(/notionAttachments: ch\.def\.notionAttachments === true \? true : undefined,/g) || []).length === 2);
    check('POST /admin/api/channels 接受它（显式 false 就是关；不传沿用旧值）',
      /notionAttachments: body\.notionAttachments !== undefined \? \(body\.notionAttachments === true \|\| body\.notionAttachments === 'true'\) : \(prevDef \? prevDef\.notionAttachments : undefined\),/.test(SRC));
    check('★ 非布尔一律 400（"配了却没生效"正是 dropParams 那条现场教训）',
      /notionAttachments must be a boolean/.test(sliceFn('validateChannelDef')) && /notionAttachments 只对 notion 渠道有意义/.test(sliceFn('validateChannelDef')));
    check('/admin/api/status 下发该字段（诊断能看出开没开）',
      /notionAttachments: ch\.def\.notionAttachments === true,/.test(SRC));
  }

  /* ══════════ 2. 真链路：假 Notion 上游 + 临时网关 ══════════ */
  console.log('\n2. 真链路：开了的渠道上游真收到开关与附件行；没开的一个字节不多');
  const P_UP = await freePort(), GW = await freePort();
  const up = makeNotionFake();
  await new Promise((r) => up.server.listen(P_UP, '127.0.0.1', r));
  const mkChan = (id, alias, extra) => ({
    id, name: id, protocol: 'notion', baseUrl: `http://127.0.0.1:${P_UP}`, apiKey: 'mock-token-v2',
    priority: 1, enabled: true, models: { [alias]: 'claude-sonnet4.6' },
    firstChunkTimeoutMs: 20000, timeoutMs: 30000, ...(extra || {}),
  });
  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [mkChan('nt-on', 'att-on', { notionAttachments: true }), mkChan('nt-off', 'att-off')],
  }));
  const env = { ...process.env, ZZCSAPI_CONFIG: cfgPath, ZZCSAPI_USAGE: path.join(TMP, 'u.json'), GATEWAY_KEY: GW_KEY, ADMIN_KEY: AD_KEY, ZZCSAPI_BIND: '127.0.0.1' };
  const gw = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  const stop = () => new Promise((res) => {
    if (!gw || gw.exitCode !== null || gw.signalCode !== null) return res();
    gw.once('exit', () => res());
    try { gw.kill(); } catch { }
    setTimeout(res, 1500);
  });
  const base = `http://127.0.0.1:${GW}`;
  const chat = (alias, withFile) => postJson(base + '/v1/chat/completions', {
    model: alias,
    messages: [{
      role: 'user',
      content: withFile
        ? [{ type: 'text', text: '我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。' }, { type: 'file', file: { filename: 'probe.csv', file_data: 'data:text/csv;base64,' + B64 } }]
        : '我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。',
    }],
    stream: false,
  }, { Authorization: 'Bearer ' + GW_KEY });

  try {
    for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/health'); if (r.status === 200) break; } catch { } await sleep(250); }

    const rOn = await chat('att-on', true);
    check('开了的渠道：请求成功（附件不许把请求搞坏）', rOn.status === 200, { s: rOn.status, t: rOn.text.slice(0, 160) });
    const bOn = up.bodies[up.bodies.length - 1];
    check('★ 上游真收到 config 里的 enableCsvAttachmentSupport:true',
      !!bOn && bOn.transcript[0].type === 'config' && bOn.transcript[0].value.enableCsvAttachmentSupport === true,
      bOn && bOn.transcript[0].value);
    const uOn = bOn && bOn.transcript.filter((s) => s.type === 'user').pop();
    check('★ 上游真收到 user step 正文里的附件行（与抓包同形）',
      !!uOn && uOn.value[0][0].split('\n').pop() === N2A_LINE, uOn && uOn.value[0][0].slice(-200));
    check('附件行挂在**最后**一条 user step 上（不是第一条、不是 context）',
      !!uOn && uOn.value[0][0].includes('我上传的 CSV'));
    check('step 的 id 仍是 uuid（v1.18.39 的现场：非 uuid 会拿到 200 + 0 字节）',
      bOn.transcript.every((s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s.id)));

    const rOff = await chat('att-off', true);
    check('没开的渠道：请求照样成功（只是不带附件能力）', rOff.status === 200, { s: rOff.status });
    const bOff = up.bodies[up.bodies.length - 1];
    check('★ 对照组：没开的渠道上游**收不到**那个开关',
      !!bOff && bOff.transcript[0].value.enableCsvAttachmentSupport === undefined, bOff && bOff.transcript[0].value);
    check('★ 对照组：正文里没有附件行（报文与从前逐字同形，只是提示词）',
      bOff.transcript.filter((s) => s.type === 'user').pop().value[0][0] === '我上传的 CSV 里 secret 这一列的值是什么？只回答那个值本身。');
    check('对照组：config 的原有四字段仍在',
      bOff.transcript[0].value.type === 'workflow' && bOff.transcript[0].value.modelFromUser === true && bOff.transcript[0].value.useWebSearch === true);

    const rPlain = await chat('att-on', false);
    check('开了的渠道、这一发没有附件 → 报文里同样没有开关（不为空手请求付代价）',
      rPlain.status === 200 && up.bodies[up.bodies.length - 1].transcript[0].value.enableCsvAttachmentSupport === undefined);

    /* ══════════ 3. 渠道字段落库往返 ══════════ */
    console.log('\n3. 渠道字段：落库往返 + 保存别的渠道后仍在 + 非布尔 400');
    const adm = { Authorization: 'Bearer ' + AD_KEY };
    const st1 = await getJson(base + '/admin/api/status', adm);
    const c1 = st1.body.channels.find((c) => c.id === 'nt-on');
    check('★ /admin/api/status 下发 notionAttachments=true', !!c1 && c1.notionAttachments === true, c1 && c1.notionAttachments);
    check('/admin/api/status 对没开的渠道下发 false（不是 undefined，前端好判）',
      st1.body.channels.find((c) => c.id === 'nt-off').notionAttachments === false);

    const bad = await postJson(base + '/admin/api/channels', { id: 'nt-bad', name: 'bad', protocol: 'notion', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', notionAttachments: 'yes' }, adm);
    check('★ 非布尔 → 400 并回带原因', bad.status === 400 && /notionAttachments must be a boolean/.test(bad.text), { s: bad.status, t: bad.text.slice(0, 160) });
    const badProto = await postJson(base + '/admin/api/channels', { id: 'nt-bad2', name: 'bad2', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', notionAttachments: true }, adm);
    check('对非 notion 协议 → 400（这个开关只对 notion 有意义）', badProto.status === 400 && /只对 notion 渠道有意义/.test(badProto.text));

    const saveOther = await postJson(base + '/admin/api/channels', { id: 'nt-off', name: 'nt-off', protocol: 'notion', baseUrl: `http://127.0.0.1:${P_UP}`, apiKey: 'mock-token-v2', models: { 'att-off': 'claude-sonnet4.6' } }, adm);
    check('保存别的渠道成功', saveOther.status === 200, saveOther.text.slice(0, 160));
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    check('★ 保存别的渠道之后，nt-on 的 notionAttachments 仍在（persistConfig 白名单真的生效）',
      (onDisk.channels.find((c) => c.id === 'nt-on') || {}).notionAttachments === true,
      onDisk.channels.map((c) => [c.id, c.notionAttachments]));
    check('没开的渠道不落盘该字段（不污染 config.json）',
      (onDisk.channels.find((c) => c.id === 'nt-off') || {}).notionAttachments === undefined);
    const st2 = await getJson(base + '/admin/api/status', adm);
    check('保存后仍在生效（status 复读）', st2.body.channels.find((c) => c.id === 'nt-on').notionAttachments === true);
  } finally {
    await stop();
    try { up.server.close(); } catch { }
    await sleep(200);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { }
  }

  console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('异常：' + (e && e.stack || e.message));
  process.exitCode = 1;
});
