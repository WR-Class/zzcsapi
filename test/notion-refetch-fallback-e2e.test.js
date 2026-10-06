#!/usr/bin/env node
/* ① Notion「流断取回」兜底（v1.18.39）—— 零依赖回归
 *
 * 现场：Notion 推理流中途断掉 / 200 但流里带 soft-block 错误时，客户端只拿到半截正文甚至空轮次，
 * 而线程在 Notion 侧已经落库（saveAllThreadOperations:true）。兜底 = 用**同一 threadId** 把同一份
 * transcript 再发一次（createThread:false + isPartialTranscript:true，活体验证过的形状）。
 *
 * 本用例守三件事：
 *   ① 装配（源码）：触发判据只看「权威全文到没到」；取回复用 threadId；有次数上限与总预算；
 *      取回发生在**任何一个字节写出去之前**（流式也不能"先写了一截再回填"）。
 *   ② 真链路（假 Notion 上游 + 临时网关）：流被截断 / 流内 soft-block / 200 零内容 三种现场都能
 *      拿回成品答案；★ 对照组：首发就带 record-map 时**一次都不重发**（零额外延迟、零额外额度）。
 *   ③ 诚实边界：两次都取不回时仍然如实判渠道失败（不许把兜底写成"假装成功"）。
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zzcsapi-refetch-'));
const GW_KEY = 'ref-gw', AD_KEY = 'ref-admin';
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkZW1vIn0.c2lnbmF0dXJl';

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
// 取一个**顶层函数**的源码：从 `function name(` 到下一个顶格 `function`/`async function`（正则字面量会让朴素括号配对翻车）
function sliceFn(name, src = SRC) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return '';
  const rest = src.slice(at + 1);
  const m = rest.match(/\n(?:async )?function |\n\/\/ ─/);
  return m ? rest.slice(0, m.index) : rest;
}

/* 假 Notion 上游：可编程的四种行为（cut / ok / err / dead） */
function makeNotionFake(mode) {
  const st = { getSpaces: 0, transcripts: 0, bodies: [], mode };
  const HALF = '半截回答';
  const FULL = '兜底取回的成品答案';
  const patch = (t) => JSON.stringify({ type: 'patch', v: [{ o: 'a', p: '/s/-', type: 'text', v: { type: 'text', value: [{ type: 'text', content: t }] } }] }) + '\n';
  const recmap = (t) => {
    const iv = { step: { type: 'markdown-chat', value: [{ type: 'text', content: t }] }, last_edited_time: 1, created_time: 1 };
    return JSON.stringify({ type: 'record-map', recordMap: { thread_message: { m1: { value: { value: iv } } } } }) + '\n';
  };
  const softBlock = JSON.stringify({ type: 'error', message: 'temporarily-unavailable', subType: 'temporarily-unavailable' }) + '\n';
  const emptyish = JSON.stringify({ type: 'patch-start' }) + '\n';
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
        const isRefetch = !!(body && body.createThread === false);
        let out;
        if (mode === 'ok') out = patch(FULL) + recmap(FULL);                      // 首发就完整 → 不该有第二次
        else if (mode === 'cut') out = isRefetch ? patch(FULL) + recmap(FULL) : patch(HALF);   // 流被截断（只有半截、无权威全文）
        else if (mode === 'err') out = isRefetch ? patch(FULL) + recmap(FULL) : softBlock;     // 流里带 soft-block 错误
        else out = emptyish;                                                      // dead：两次都零内容
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        return res.end(out);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return st;
}

(async () => {
  /* ══════════ 1. 装配守卫（源码 + 单元） ══════════ */
  console.log('1. 装配守卫：触发判据只看权威全文、取回复用 threadId、有上限、写在输出之前');
  {
    const refetch = sliceFn('notionRefetchAnswer');
    check('notionRefetchAnswer 存在且非空', refetch.length > 400, refetch.length);
    check('★ 复用同一 threadId（取回同一线程，不是另开一条）',
      /threadId, createThread: false, isPartialTranscript: true/.test(refetch), refetch.match(/notionBuildPayload[\s\S]{0,220}/));
    check('★ 取回形状 = createThread:false + isPartialTranscript:true',
      /createThread: false/.test(refetch) && /isPartialTranscript: true/.test(refetch));
    check('有次数上限（NOTION_REFETCH_MAX ≤ 3）',
      /const NOTION_REFETCH_MAX = (\d+);/.test(SRC) && Number(SRC.match(/const NOTION_REFETCH_MAX = (\d+);/)[1]) <= 3,
      SRC.match(/const NOTION_REFETCH_MAX = \d+;/));
    check('有重发间隔与预算（不是无限轮询）',
      /NOTION_REFETCH_GAP_MS = \d+/.test(SRC) && /Math\.min\(30_000, timeoutMs/.test(sliceFn('tryNotionChannel')));
    check('报文级错误（isNotionError）直接放弃，不空耗额度', /"isNotionError":\\s\*true/.test(refetch));

    const tfn = sliceFn('tryNotionChannel');
    check('★ 触发判据含 !probe.sawFinal（权威全文到了就一次都不重发）',
      /!probe\.sawFinal/.test(tfn), tfn.match(/const truncated[\s\S]{0,300}/));
    check('★ 三种现场都覆盖：stream-error / no-content / truncated',
      /streamError \? \('stream-error: ' \+ streamError\)/.test(tfn) && /'no-content'/.test(tfn) && /'truncated'/.test(tfn));
    check('★ 取回发生在写响应之前（首个 specialStreamHead / specialNonStreamOut 之前）',
      tfn.indexOf('notionRefetchAnswer(ch, acct, built, payload.threadId') > 0
      && tfn.indexOf('notionRefetchAnswer(ch, acct, built, payload.threadId') < tfn.indexOf('specialStreamHead(opts, candidate)')
      && tfn.indexOf('notionRefetchAnswer(ch, acct, built, payload.threadId') < tfn.indexOf('await specialNonStreamOut(opts, candidate,'),
      { refetchAt: tfn.indexOf('notionRefetchAnswer(ch, acct, built'), headAt: tfn.indexOf('specialStreamHead(opts, candidate)') });
    check('取回来的是整段 NDJSON（下游解析/工具仿真/思考合并不用改）', /ndjsonText = got\.body;/.test(tfn));
    check('取回失败仍如实判渠道失败（streamError / empty 两条原路保留）',
      /if \(streamError && !refetched\)/.test(tfn) && /notion stream: empty/.test(tfn));
    check('账本留痕：只有真取回过才写 note=notion-refetch（3 处记账点）',
      (SRC.match(/note: 'notion-refetch'/g) || []).length === 3 && /\.\.\.\(refetched \? \{ note: 'notion-refetch' \} : \{\}\)/.test(SRC));
    check('调度语义未变：notion-agent 那条路径不受影响（note 只出现在 tryNotionChannel 区间内）',
      (SRC.match(/note: 'notion-refetch'/g) || []).length === (tfn.match(/note: 'notion-refetch'/g) || []).length);

    // 单元：notion.js 的 payload 默认值与取回形状
    const acct = { spaceId: 'space-1', userId: 'user-1' };
    const tr = [{ id: 't1', type: 'user', value: [['hi']] }];
    const p0 = notion.notionBuildPayload(tr, 'workflow', acct, {});
    check('★ notionBuildPayload 不传 opts 时与首发逐字节同形状（createThread:true / isPartialTranscript:false）',
      p0.createThread === true && p0.isPartialTranscript === false && p0.generateTitle === true && /^[0-9a-f-]{36}$/.test(p0.threadId),
      { ct: p0.createThread, ipt: p0.isPartialTranscript, tid: p0.threadId });
    const p1 = notion.notionBuildPayload(tr, 'workflow', acct, { threadId: 'thread-X', createThread: false, isPartialTranscript: true });
    check('★ 传 opts 时复用指定 threadId 并翻转两个开关',
      p1.threadId === 'thread-X' && p1.createThread === false && p1.isPartialTranscript === true && p1.traceId !== p0.traceId,
      { tid: p1.threadId, ct: p1.createThread, ipt: p1.isPartialTranscript });

    // 单元：sawFinal 语义（兜底触发判据的唯一依据）
    const iv = { step: { type: 'markdown-chat', value: [{ type: 'text', content: '全文' }] }, last_edited_time: 1, created_time: 1 };
    const rmLine = JSON.stringify({ type: 'record-map', recordMap: { thread_message: { m1: { value: { value: iv } } } } });
    const pLine = JSON.stringify({ type: 'patch', v: [{ o: 'a', p: '/s/-', type: 'text', v: { type: 'text', value: [{ type: 'text', content: '半截' }] } }] });
    const parse = (lines) => {
      const p = notion.createNotionStreamParser(() => { });
      for (const l of lines) p.line(l);
      return p.state;
    };
    check('★ record-map 行 → sawFinal=true（权威全文到了）', parse([pLine, rmLine]).sawFinal === true);
    check('★ 只有 patch（流被截断）→ sawFinal=false 且有 content', parse([pLine]).sawFinal === false && parse([pLine]).sawContent === true);
    check('notion.js 两处权威全文分支都置 sawFinal（record-map / markdown-chat）',
      (NSRC.match(/st\.sawFinal = true;/g) || []).length === 2);
  }

  /* ══════════ 2. 真链路：假 Notion 上游 + 临时网关 ══════════ */
  const P_CUT = await freePort(), P_OK = await freePort(), P_ERR = await freePort(), P_DEAD = await freePort(), GW = await freePort();
  const fCut = makeNotionFake('cut'), fOk = makeNotionFake('ok'), fErr = makeNotionFake('err'), fDead = makeNotionFake('dead');
  for (const [f, p] of [[fCut, P_CUT], [fOk, P_OK], [fErr, P_ERR], [fDead, P_DEAD]]) {
    await new Promise((r) => f.server.listen(p, '127.0.0.1', r));
  }
  const mkChan = (id, port, alias) => ({
    id, name: id, protocol: 'notion', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'mock-token-v2',
    priority: 1, enabled: true, models: { [alias]: 'claude-sonnet4.6' },
    firstChunkTimeoutMs: 20000, timeoutMs: 30000,
  });
  const cfgPath = path.join(TMP, 'c.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: GW,
    health: { intervalSec: 3600, timeoutMs: 8000 },
    channels: [mkChan('nt-cut', P_CUT, 'ref-cut'), mkChan('nt-ok', P_OK, 'ref-ok'), mkChan('nt-err', P_ERR, 'ref-err'), mkChan('nt-dead', P_DEAD, 'ref-dead')],
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
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GW_KEY };
  const AH = { Authorization: 'Bearer ' + AD_KEY };
  const post = async (p, body, headers = H) => {
    const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    return { code: r.status, ct: r.headers.get('content-type') || '', text: await r.text() };
  };
  const jparse = (t) => { try { return JSON.parse(t); } catch { return null; } };
  const waitUp = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) return true; } catch { } await sleep(150); } return false; };
  const usage = async () => { const r = await fetch(base + '/admin/api/usage', { headers: AH }); return jparse(await r.text()) || { recent: [] }; };
  const FULL = '兜底取回的成品答案', HALF = '半截回答';

  try {
    check('临时网关起来了（4 条 notion 渠道，一模式一条）', await waitUp());

    console.log('\n2. 流被截断（首发只有半截 patch、没有 record-map）→ 兜底取回整段');
    {
      const r = await post('/v1/chat/completions', { model: 'ref-cut', messages: [{ role: 'user', content: 'ping' }] });
      const j = jparse(r.text);
      check('HTTP 200', r.code === 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 客户端拿到的是**成品答案**（不是半截 "半截回答"）',
        !!(j && j.choices && j.choices[0].message.content === FULL), j && j.choices && j.choices[0].message.content);
      check('★ 上游被打了两次（首发 + 一次取回）', fCut.transcripts === 2, fCut.transcripts);
      const [b1, b2] = fCut.bodies;
      check('★ 第二次复用同一 threadId', !!(b1 && b2 && b1.threadId === b2.threadId), { t1: b1 && b1.threadId, t2: b2 && b2.threadId });
      check('★ 第二次是 createThread:false + isPartialTranscript:true',
        !!(b2 && b2.createThread === false && b2.isPartialTranscript === true && b2.asPatchResponse === true),
        b2 && { ct: b2.createThread, ipt: b2.isPartialTranscript });
      check('第二次带的是同一份 transcript（不是空 transcript —— 空的那次实测 400）',
        !!(b1 && b2 && JSON.stringify(b1.transcript) === JSON.stringify(b2.transcript) && b2.transcript.length > 0));
      check('第二次 traceId 是新的（同一条线程、新的一次调用）', !!(b1 && b2 && b1.traceId !== b2.traceId));
      check('账号发现只做一次（有缓存）', fCut.getSpaces === 1, fCut.getSpaces);
    }

    console.log('\n3. 对照：首发就带 record-map → 一次都不重发（零额外延迟、零额外额度）');
    {
      const r = await post('/v1/chat/completions', { model: 'ref-ok', messages: [{ role: 'user', content: 'ping' }] });
      const j = jparse(r.text);
      check('HTTP 200 且正文正确', r.code === 200 && !!(j && j.choices[0].message.content === FULL), j && j.choices);
      check('★ 上游只被打了一次（兜底没被误触发）', fOk.transcripts === 1, fOk.transcripts);
      check('★ 首发报文没被改动（createThread:true / isPartialTranscript:false / 带 transcript）',
        !!(fOk.bodies[0] && fOk.bodies[0].createThread === true && fOk.bodies[0].isPartialTranscript === false));
    }

    console.log('\n4. 流式面：先缓冲后写 → 兜底在写出任何字节之前完成（客户端拿到完整正文）');
    {
      const r = await post('/v1/chat/completions', { model: 'ref-cut', messages: [{ role: 'user', content: 'ping' }], stream: true });
      check('流式 200 + text/event-stream', r.code === 200 && /text\/event-stream/.test(r.ct), r.ct);
      const deltas = r.text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
        .map((l) => jparse(l.slice(6))).filter(Boolean)
        .map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content || '').join('');
      check('★ 流式正文也是成品答案（没有半截 + 追加的双份）', deltas === FULL, JSON.stringify(deltas));
      check('流式没把首发那半截漏出去', !r.text.includes(HALF), r.text.slice(0, 160));
    }

    console.log('\n5. 流里带 soft-block 错误（200 + temporarily-unavailable）→ 兜底救回，不再直接判死');
    {
      const r = await post('/v1/chat/completions', { model: 'ref-err', messages: [{ role: 'user', content: 'ping' }] });
      const j = jparse(r.text);
      check('HTTP 200', r.code === 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 客户端拿到成品答案（旧行为：直接 return 渠道失败 → 单候选 502）',
        !!(j && j.choices && j.choices[0].message.content === FULL), j && j.choices);
      check('★ 上游被打了两次（首发错误帧 + 一次取回）', fErr.transcripts === 2, fErr.transcripts);
    }

    console.log('\n6. 诚实边界：两次都零内容 → 仍然如实判渠道失败（兜底不许伪装成功）');
    {
      const r = await post('/v1/chat/completions', { model: 'ref-dead', messages: [{ role: 'user', content: 'ping' }] });
      check('★ 没拿到 200 成功报文（单候选 → 502）', r.code !== 200, { code: r.code, text: r.text.slice(0, 200) });
      check('★ 两次都试过了（首发 + 2 次取回上限内的尝试 ≥ 2）', fDead.transcripts >= 2, fDead.transcripts);
      check('★ 上游错误说明里没出现"成功"字样（如实失败）', !/ok.*true/.test(r.text), r.text.slice(0, 200));
    }

    console.log('\n7. 账本留痕：取回过的行带 note=notion-refetch，正常行不带');
    {
      const u = await usage();
      const rows = (u.recent || []).filter((x) => String(x.model || '').startsWith('ref-'));
      const cutRow = rows.find((x) => x.model === 'ref-cut' && x.ok !== false);
      const okRow = rows.find((x) => x.model === 'ref-ok');
      check('★ 取回成功的那行 note=notion-refetch 且 ok:true', !!(cutRow && cutRow.note === 'notion-refetch' && cutRow.ok !== false), cutRow);
      check('★ 正常行（没触发兜底）没有这个 note', !!(okRow && !okRow.note), okRow);
      check('取回行的 channelId 就是那条 notion 渠道', !!(cutRow && cutRow.channelId === 'nt-cut'), cutRow && cutRow.channelId);
    }
  } finally {
    await stop();
    for (const f of [fCut, fOk, fErr, fDead]) { try { f.server.close(); } catch { } }
    await sleep(200);
  }

  console.log('\n' + '─'.repeat(58));
  console.log((fail === 0 ? '✓ Notion 流断兜底回归全通过' : '✗ 有失败') + `（${pass + fail} 项，通过 ${pass}，失败 ${fail}）`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
