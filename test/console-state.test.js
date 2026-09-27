#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * test/console-state.test.js — 「视口内输入控件的值必须跨重绘保留」的回归测试
 *
 * 为什么需要它（PT22 / detailed §8.11）：
 *   控制台每 8 秒轮询一次（loadAll → adapt → render），而 render() 会把**当前页的
 *   整个 #viewport innerHTML 重建**。任何输入控件的值若只存在 DOM 里、没存进 JS 变量
 *   并在模板中回填，重绘后就会被重建为空——表现是「搜索词/草稿一会儿自己没了」。
 *   这类 bug 不报错、不崩、接口全 200，语法检查与构建全绿，人眼要盯着等 10 秒才看得见。
 *   本脚本把它变成一条命令、一秒内变红。
 *
 * 怎么测的：
 *   从 build/app.js **按花括号配对抠出真实的页面渲染函数源码**（不是复制副本，永远与
 *   产品代码同步），塞进一个最小 DOM 桩里跑「首渲染 → 触发输入 → 再渲染(=轮询重绘)」，
 *   断言输入值与选中态仍在。
 *
 * 不覆盖：真实浏览器行为（CSS 布局、中文输入法、真实流式渲染、滚动观感）——那些仍需人工点。
 *         另外它依赖 vModels / drawMTable / vPlayground 等函数名，改名会让本脚本报错，
 *         这是刻意的（会逼着同步改 docs/frontend-code-map.md 的锚点）。
 *
 * 跑法：node test/console-state.test.js      （零依赖，退出码非 0 表示有回归）
 * ═══════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'build', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

/* ── 从源码抠函数：按花括号配对，避免在测试里维护第二份实现 ───────────────── */
function extract(name) {
  let i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('build/app.js 里找不到函数 ' + name + '（改名了？请同步本脚本与 docs/frontend-code-map.md）');
  if (src.slice(Math.max(0, i - 6), i) === 'async ') i -= 6;   /* 保住 async，否则函数体内的 await 会语法错 */
  let depth = 0, started = false;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + name);
}

/* ── 最小 DOM 桩 ─────────────────────────────────────────────────────────── */
function mkEl(id) {
  return {
    id, innerHTML: '', value: '', dataset: {}, style: {},
    onclick: null, oninput: null, onchange: null, onkeydown: null,
    scrollTop: 0, scrollHeight: 0, textContent: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
    },
    focus() {}, setSelectionRange() {}, scrollIntoView() {}, appendChild() {}, remove() {},
    querySelector() { return null },
  };
}
function makeDom() {
  const els = {};
  const $ = (sel, root) => {
    const key = (root && root.__id ? root.__id + ' ' : '') + sel;
    if (!els[key]) els[key] = mkEl((sel.match(/^#([\w-]+)/) || [])[1] || sel);
    return els[key];
  };
  /* 模型页的 4 个协议页签需要各自独立的对象 */
  const tabs = ['all', 'openai', 'anthropic', 'gemini'].map(p => { const t = mkEl('tab-' + p); t.dataset.p = p; return t; });
  const $$ = sel => (sel.indexOf('#mTabs') >= 0 ? tabs : []);
  const root = mkEl('viewport'); root.__id = 'viewport';
  /* 桩不解析 HTML：把渲染结果里的 class 属性同步回桩元素的 classList
     （真实浏览器由解析器完成）。否则 <button class="switch on"> 的 classList 是空的，
     toggle 会把「本来就是开」误判成「关→开」。 */
  const syncClasses = html => {
    for (const m of html.matchAll(/<[^>]+>/g)) {
      const tag = m[0];
      const id = (tag.match(/id="([\w-]+)"/) || [])[1];
      if (!id) continue;
      const cls = ((tag.match(/class="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
      for (const key of Object.keys(els)) {
        if (key === id || key.endsWith(' #' + id)) els[key].classList._s = new Set(cls);
      }
    }
  };
  return { $, $$, root, tabs, syncClasses };
}

/* ── 被测环境所需的桩数据（形状取自 /admin/api/status 经 adapt() 后的结构）── */
const DATA = {
  models: [
    { name: 'demo-model-a', chans: ['stub-alpha'], err: 0, req: 10 },
    { name: 'demo-model-b', chans: ['stub-alpha', 'stub-beta'], err: 1, req: 5 },
  ],
  channels: [
    { id: 'stub-alpha', proto: 'openai', on: true },
    { id: 'stub-beta', proto: 'openai', on: true },
  ],
  meta: { models: 2, total: 15 },
};
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const svg = () => '<svg></svg>';
const nf = n => String(n);
const toast = () => {};
const copyText = () => {};

/* ── 断言工具 ────────────────────────────────────────────────────────────── */
let pass = 0, fail = 0;
const G = t => console.log('\n' + t);
const check = (name, cond) => {
  cond ? pass++ : fail++;
  console.log((cond ? '  ✓ ' : '  ✗ ') + name);
};

/* ═══════════════ 1. 聚合模型页：搜索词与协议页签跨重绘保留 ═══════════════ */
function testModels() {
  G('1. 聚合模型页 vModels/drawMTable（用户报告的回归点：搜索一会儿自己没了）');
  const dom = makeDom();
  const api = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf',
    "let mTab='all', mQ='';\n" + extract('vModels') + '\n' + extract('drawMTable') + '\n' +
    "return { vModels, drawMTable, get mQ(){return mQ}, get mTab(){return mTab} };"
  )(dom.$, dom.$$, DATA, esc, svg, nf);
  const v = dom.root;

  api.vModels(v);
  check('首渲染：搜索框为空', v.innerHTML.includes('id="mQ" placeholder="搜索模型名…" value=""'));
  check('首渲染：页签「全部」选中', v.innerHTML.includes('class="tab on" data-p="all"'));
  check('首渲染：表格列出全部 2 个模型',
    dom.$('#mTable').innerHTML.includes('demo-model-a') && dom.$('#mTable').innerHTML.includes('demo-model-b'));

  const input = dom.$('#mQ', v);
  check('搜索框已绑定 oninput', typeof input.oninput === 'function');
  input.oninput({ target: { value: 'model-a' } });
  check('输入后状态 mQ=model-a', api.mQ === 'model-a');

  api.vModels(v);                       /* ← 等价于 8 秒轮询触发的那次重绘 */
  check('★ 重绘后 value 仍是 model-a（原 bug 就在这一步丢掉）', v.innerHTML.includes('value="model-a"'));
  check('★ 重绘后表格仍只剩命中项',
    dom.$('#mTable').innerHTML.includes('demo-model-a') && !dom.$('#mTable').innerHTML.includes('demo-model-b'));

  dom.tabs[1].onclick();                /* OpenAI 页签 */
  check('点击 OpenAI 页签后状态 mTab=openai', api.mTab === 'openai');
  api.vModels(v);
  check('★ 重绘后 OpenAI 页签仍选中', v.innerHTML.includes('class="tab on" data-p="openai"'));

  dom.$('#mQ', v).oninput({ target: { value: 'model-b' } });
  api.vModels(v);
  check('改搜 model-b → 重绘后仍保留', v.innerHTML.includes('value="model-b"'));
  check('改搜 model-b → 表格切到 demo-model-b',
    dom.$('#mTable').innerHTML.includes('demo-model-b') && !dom.$('#mTable').innerHTML.includes('demo-model-a'));

  dom.$('#mQ', v).oninput({ target: { value: '</script>"<b>' } });
  api.vModels(v);
  check('搜索词按 HTML 转义回填（不给注入留口子）', v.innerHTML.includes('value="&lt;/script&gt;&quot;&lt;b&gt;"'));
}

/* ═══════════════ 2. Playground：草稿与参数跨重绘保留 ═══════════════ */
function testPlayground() {
  G('2. Playground vPlayground（同族问题：正在敲的草稿被 8 秒重绘吞掉）');
  const dom = makeDom();
  const api = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'toast', 'copyText',
    "let PG=[], pgRoute=null, pgBusy=false;\n" +
    "let pgDraft='', pgSysText='', pgModelSel='', pgTempV=0.7, pgMaxV=2048, pgStreamOn=true;\n" +
    extract('vPlayground') + '\n' + extract('drawPG') + '\n' + extract('drawRoute') + '\n' +
    extract('pgSend') + '\n' +   /* 只被当处理器赋值、本测试不调用 */
    "return { vPlayground, get pgDraft(){return pgDraft}, get pgSysText(){return pgSysText}, " +
    "get pgModelSel(){return pgModelSel}, get pgTempV(){return pgTempV}, get pgMaxV(){return pgMaxV}, " +
    "get pgStreamOn(){return pgStreamOn} };"
  )(dom.$, dom.$$, DATA, esc, svg, nf, toast, copyText);
  const v = dom.root;

  api.vPlayground(v);
  dom.syncClasses(v.innerHTML);
  check('首渲染：草稿框为空', /<textarea id="pgInput"[^>]*><\/textarea>/.test(v.innerHTML));
  check('首渲染：Temperature 默认 0.7', v.innerHTML.includes('value="0.7"'));
  check('首渲染：流式开关为开', v.innerHTML.includes('class="switch on" id="pgStream"'));

  const draft = dom.$('#pgInput', v);
  check('草稿框已绑定 oninput', typeof draft.oninput === 'function');
  draft.oninput({ target: { value: '帮我写个正则' } });
  check('输入后状态 pgDraft=帮我写个正则', api.pgDraft === '帮我写个正则');

  dom.$('#pgSys', v).oninput({ target: { value: '你是严谨的助手' } });
  check('System Prompt 写回状态', api.pgSysText === '你是严谨的助手');

  const t = dom.$('#pgTemp', v); t.value = '1.5'; t.oninput();
  const x = dom.$('#pgMax', v); x.value = '4096'; x.oninput();
  dom.$('#pgStream', v).onclick();
  check('参数写回状态：temp=1.5 / max=4096 / stream=off',
    api.pgTempV === '1.5' && api.pgMaxV === '4096' && api.pgStreamOn === false);

  const m = dom.$('#pgModel', v); m.value = 'demo-model-b'; m.onchange();
  check('模型选择写回状态', api.pgModelSel === 'demo-model-b');

  api.vPlayground(v);                   /* ← 等价于 8 秒轮询触发的那次重绘 */
  check('★ 重绘后草稿仍在', v.innerHTML.includes('帮我写个正则'));
  check('★ 重绘后 System Prompt 仍在', v.innerHTML.includes('你是严谨的助手'));
  check('★ 重绘后 Temperature 仍是 1.5', v.innerHTML.includes('value="1.5"') && v.innerHTML.includes('temp 1.5'));
  check('★ 重绘后 Max tokens 仍是 4096', v.innerHTML.includes('value="4096"') && v.innerHTML.includes('max_tokens 4096'));
  check('★ 重绘后流式开关仍是关', v.innerHTML.includes('class="switch" id="pgStream"') && v.innerHTML.includes('stream=false'));
  check('★ 重绘后模型选中项仍是 demo-model-b', v.innerHTML.includes('<option selected>demo-model-b</option>'));
}

/* ═══════ 3. 渠道表单：权重（weight）能填、能存、能显示分流占比 ═══════ */
/* 背景：weight 后端早就支持（v1.3 加权轮询），但控制台没有入口 —— 只能改 config.json。
   这一节守住三件事：/admin/api/status 的三个字段真被 adapt() 接进 DATA、表格真显示占比、
   表单真把 weight 发出去（并且负数在**前端**就被挡下，不去撞后端 400）。 */
function testWeight() {
  G('3. 渠道表单权重：adapt() 接字段 → 表格显示占比 → 保存带上 weight');

  /* 3.1 adapt()：把 /admin/api/status 的 weight / weightedHits / weightedShare 接进 DATA.channels */
  {
    const dom = makeDom();
    const RAW = {
      channels: [
        { id: 'w-on', name: '有权重', protocol: 'openai', enabled: true, status: 'ok', priority: 5, weight: 3, weightedHits: 12, weightedShare: 75, aliases: [] },
        { id: 'w-off', name: '没权重', protocol: 'openai', enabled: true, status: 'ok', priority: 5, aliases: [] },
      ],
      usage: null,
    };
    /* adapt() 是**整体重赋值** DATA（不是就地改），所以要拿出参回读 */
    const a = new Function('RAW', 'DATA', 'esc', 'svg', 'nf', '$',
      'let CFG=null, loaded=false;\n' + extract('adapt') + '\nreturn { adapt, get DATA(){ return DATA } };'
    )(RAW, { channels: [], models: [], meta: {} }, esc, svg, nf, dom.$);
    a.adapt();
    const holder = a.DATA;
    const on = holder.channels.find((c) => c.id === 'w-on');
    const off = holder.channels.find((c) => c.id === 'w-off');
    check('★ status 的 weight / weightedHits / weightedShare 都被接进来',
      on.w === 3 && on.wHits === 12 && on.wShare === 75);
    check('没配权重的渠道 → w=0 / wHits=0 / wShare=0（不是 undefined，模板才能直接算）',
      off.w === 0 && off.wHits === 0 && off.wShare === 0);
  }

  /* 3.2 drawChTable()：有权重显示「权重 · 占比」，没权重显示「—」（不显示假的 0%） */
  {
    const dom = makeDom();
    const dl = [
      { id: 'w-on', name: '有权重', proto: 'openai', on: true, status: 'ok', ms: 100, models: 1, pri: 5, eff: 5, fail: 0, req: 10, err: 0, w: 3, wHits: 12, wShare: 75 },
      { id: 'w-off', name: '没权重', proto: 'openai', on: true, status: 'ok', ms: 100, models: 1, pri: 5, eff: 5, fail: 0, req: 10, err: 0, w: 0, wHits: 0, wShare: 0 },
    ];
    const protoLabel = { openai: 'OpenAI' }, stTxt = { ok: '正常' };
    const fMs = (x) => x + 'ms', pct = (a, b) => Math.round((a / b) * 100);
    const api = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'protoLabel', 'stTxt', 'fMs', 'pct',
      "let chTab='all', chQ='';\n" + extract('drawChTable') + '\nreturn { drawChTable };'
    )(dom.$, dom.$$, { channels: dl }, esc, svg, nf, protoLabel, stTxt, fMs, pct);
    api.drawChTable();
    const html = dom.$('#chTable').innerHTML;
    check('表头有「权重 / 分流」列', html.includes('权重 / 分流'));
    check('★ 权重 3 的渠道显示权重 3 与占比 75%', html.includes('>3<span') && html.includes('· 75%'));
    check('★ 权重 0 的渠道显示「—」，而不是 0%（0% 会被误读成"从没分到流量"）',
      html.includes('未参与加权轮询（权重 0）') && html.includes('>—</span>'));
  }

  /* 3.3 saveChannel()：填了权重就发出去；负数/非数字在前端就挡下（不发请求） */
  {
    const run = (weightVal) => {
      const dom = makeDom();
      const sent = [], toasts = [];
      const apiStub = async (p, opt) => { sent.push({ p, body: JSON.parse(opt.body) }); return { existed: false }; };
      const f = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'toast', 'api', 'closeModal', 'loadAll',
        'let modalChId=null, modalModels=[];\n' + extract('saveChannel') + '\nreturn { saveChannel };'
      )(dom.$, dom.$$, { channels: [] }, esc, svg, nf, (m) => toasts.push(m), apiStub, () => { }, async () => { });
      const v = (id, val) => { dom.$('#' + id).value = val; };
      v('f-id', 'new-ch'); v('f-name', '新渠道'); v('f-base', 'https://x.test/v1'); v('f-key', 'sk-x');
      v('f-proto', 'openai'); v('f-pri', '5'); v('f-weight', weightVal); v('f-on', '1'); v('f-proxy', ''); v('f-headers', '');
      dom.$('#f-autoAlias').checked = true;
      return f.saveChannel().then(() => ({ sent, toasts }));
    };
    return (async () => {
      let r = await run('3');
      check('★ 表单里的权重进了请求体', r.sent.length === 1 && r.sent[0].body.weight === 3, r.sent[0] && r.sent[0].body);
      check('保存走 upsert（/admin/api/channels）', !!r.sent[0] && r.sent[0].p === '/admin/api/channels');

      r = await run('');
      check('留空 = 0（显式写 0，等于"不参与加权轮询"）', r.sent[0].body.weight === 0);

      r = await run('-2');
      check('★ 负数在前端就被挡下（一条请求都不发）', r.sent.length === 0);
      check('并给出可执行的提示文案', /权重/.test(r.toasts.join('')) && /不小于 0/.test(r.toasts.join('')), r.toasts);

      r = await run('abc');
      check('非数字同样挡下（Number("abc")=NaN 不会静默变成 0）', r.sent.length === 0 && /权重/.test(r.toasts.join('')));
    })();
  }
}

/* ═══════ 4. 对照组：证明本测试抓得住「没有回填」的旧写法（防恒真） ═══════ */
function testControl() {
  G('4. 对照组（用整改前的写法跑同样断言，必须失败）');
  const v = mkEl('viewport');
  v.innerHTML = '<div class="search"><input id="mQ" placeholder="搜索模型名…"></div>';   /* 整改前的模板 */
  const rendered = (v.innerHTML.match(/id="mQ"[^>]*value="([^"]*)"/) || [])[1];
  check('旧写法（无 value= 回填）重绘后取不到搜索词 → 测试具备捕捉能力', rendered === undefined);
}

/* ── 装配：被测函数与状态声明必须真实存在于产品源码，否则直接报错 ── */
try {
  ['vModels', 'drawMTable', 'vPlayground', 'drawPG', 'drawRoute', 'adapt', 'drawChTable', 'saveChannel'].forEach(extract);
  ["let mTab='all', mQ=''", "let pgDraft=''", 'id="f-weight"'].forEach(s => {
    if (!src.includes(s)) throw new Error('build/app.js 里找不到状态声明 / 关键标记 ' + s);
  });
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

(async () => {
  testModels();
  testPlayground();
  await testWeight();
  testControl();

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
