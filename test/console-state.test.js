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
    { name: 'glm-5.3', chans: ['hcnsec'], err: 0, req: 10 },
    { name: 'kimi-k3', chans: ['hcnsec', 'bqgy'], err: 1, req: 5 },
  ],
  channels: [
    { id: 'hcnsec', proto: 'openai', on: true },
    { id: 'bqgy', proto: 'openai', on: true },
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
    dom.$('#mTable').innerHTML.includes('glm-5.3') && dom.$('#mTable').innerHTML.includes('kimi-k3'));

  const input = dom.$('#mQ', v);
  check('搜索框已绑定 oninput', typeof input.oninput === 'function');
  input.oninput({ target: { value: 'glm' } });
  check('输入后状态 mQ=glm', api.mQ === 'glm');

  api.vModels(v);                       /* ← 等价于 8 秒轮询触发的那次重绘 */
  check('★ 重绘后 value 仍是 glm（原 bug 就在这一步丢掉）', v.innerHTML.includes('value="glm"'));
  check('★ 重绘后表格仍只剩命中项',
    dom.$('#mTable').innerHTML.includes('glm-5.3') && !dom.$('#mTable').innerHTML.includes('kimi-k3'));

  dom.tabs[1].onclick();                /* OpenAI 页签 */
  check('点击 OpenAI 页签后状态 mTab=openai', api.mTab === 'openai');
  api.vModels(v);
  check('★ 重绘后 OpenAI 页签仍选中', v.innerHTML.includes('class="tab on" data-p="openai"'));

  dom.$('#mQ', v).oninput({ target: { value: 'kimi' } });
  api.vModels(v);
  check('改搜 kimi → 重绘后仍保留', v.innerHTML.includes('value="kimi"'));
  check('改搜 kimi → 表格切到 kimi-k3',
    dom.$('#mTable').innerHTML.includes('kimi-k3') && !dom.$('#mTable').innerHTML.includes('glm-5.3'));

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

  const m = dom.$('#pgModel', v); m.value = 'kimi-k3'; m.onchange();
  check('模型选择写回状态', api.pgModelSel === 'kimi-k3');

  api.vPlayground(v);                   /* ← 等价于 8 秒轮询触发的那次重绘 */
  check('★ 重绘后草稿仍在', v.innerHTML.includes('帮我写个正则'));
  check('★ 重绘后 System Prompt 仍在', v.innerHTML.includes('你是严谨的助手'));
  check('★ 重绘后 Temperature 仍是 1.5', v.innerHTML.includes('value="1.5"') && v.innerHTML.includes('temp 1.5'));
  check('★ 重绘后 Max tokens 仍是 4096', v.innerHTML.includes('value="4096"') && v.innerHTML.includes('max_tokens 4096'));
  check('★ 重绘后流式开关仍是关', v.innerHTML.includes('class="switch" id="pgStream"') && v.innerHTML.includes('stream=false'));
  check('★ 重绘后模型选中项仍是 kimi-k3', v.innerHTML.includes('<option selected>kimi-k3</option>'));
}

/* ═══════ 3. 对照组：证明本测试抓得住「没有回填」的旧写法（防恒真） ═══════ */
function testControl() {
  G('3. 对照组（用整改前的写法跑同样断言，必须失败）');
  const v = mkEl('viewport');
  v.innerHTML = '<div class="search"><input id="mQ" placeholder="搜索模型名…"></div>';   /* 整改前的模板 */
  const rendered = (v.innerHTML.match(/id="mQ"[^>]*value="([^"]*)"/) || [])[1];
  check('旧写法（无 value= 回填）重绘后取不到搜索词 → 测试具备捕捉能力', rendered === undefined);
}

/* ── 装配：被测函数与状态声明必须真实存在于产品源码，否则直接报错 ── */
try {
  ['vModels', 'drawMTable', 'vPlayground', 'drawPG', 'drawRoute'].forEach(extract);
  ["let mTab='all', mQ=''", "let pgDraft=''"].forEach(s => {
    if (!src.includes(s)) throw new Error('build/app.js 里找不到状态声明 ' + s);
  });
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

testModels();
testPlayground();
testControl();

console.log('\n' + '─'.repeat(58));
console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
process.exit(fail ? 1 : 0);
