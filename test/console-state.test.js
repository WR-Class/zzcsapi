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
 * 第 10 节起覆盖 v1.18「运行期设置」页：草稿跨轮询保留（dirty 时不被覆盖）、POST 的 PATCH 语义
 *   （只发有改动的组/字段、留空数字不下发）、400 的 error 原文直显；并含"旧写法无条件覆盖草稿"对照组。
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
    /* 测试结果行是 insertAdjacentHTML('beforeend', …) 追加的：桩里累加到 innerHTML，
       这样测试才能对"到底渲染出了什么"做断言（真实浏览器由解析器完成） */
    insertAdjacentHTML(pos, html) { this.innerHTML += html; },
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

/* ═══════ 3b. 渠道级「不发这些参数」（v1.18.33）════════════════════════════════
   现场：某渠道（agentrouter）每天固定开放额度，却对「tools + reasoning_effort」组合直接 400
   ——`Function tools with reasoning_effort are not supported for gpt-6-astra`，而 DSH 每次请求
   都同时带这两样 → 该渠道对我们 100% 失败（19 行 0 成功）。处置是把开关放在**渠道**上：
   出站前从这家渠道的请求报文里删掉指定参数（后端 validateChannelDef 只收白名单内的名字）。
   这一节守三件事：
     ① 表单能填、能回填、**总是**提交——框空 = 显式 `[]` = 清空。这与 weight 等字段的
        "留空 = 不动"语义**刻意不同**：服务端对 dropParams 是"传了空数组才清空、压根不传就沿用
        旧值"，前端若不发这个字段，用户就永远清不掉已配的清单；
     ② 合法参数名清单**只从服务端下发取**（GET /admin/api/config 的 dropParamWhitelist）。
        前端自己抄一份迟早漂移，用户就会撞上"表单里能填、保存却 400"——那正是这次现场的病根形态；
     ③ 服务端没下发清单时优雅降级：不显示 chips、字段照常可用（后端仍会 400 兜底，且文案自带清单）。

   ★ 写成 `async function` 并由下面的主流程 `await` 调用，**不能**写成顶层裸块：块里的
   `return (async () => …)()` 在 CommonJS 模块顶层等于 `return` 整个模块——第 4 节起的用例
   与末尾的汇总行会一起被跳过，而退出码仍是 0（假绿）。第一版就是这么写的，跑了才发现输出里
   没有汇总行。 */
async function testDropParams() {
  G('3b. 渠道级「不发这些参数」：回填 / 总是提交 / 清单来自服务端 / 降级');

  /* 3b.1 adapt()：服务端的 dropParams 收成数组 dp（没配 = 空数组，模板才能直接 join） */
  {
    const dom = makeDom();
    const RAW = {
      channels: [
        { id: 'd-on', name: '配了', protocol: 'openai', enabled: true, status: 'ok', priority: 5, dropParams: ['reasoning_effort', 'temperature'], aliases: [] },
        { id: 'd-off', name: '没配', protocol: 'openai', enabled: true, status: 'ok', priority: 5, aliases: [] },
      ],
      usage: null,
    };
    const a = new Function('RAW', 'DATA', 'esc', 'svg', 'nf', '$',
      'let CFG=null, loaded=false;\n' + extract('adapt') + '\nreturn { adapt, get DATA(){ return DATA } };'
    )(RAW, { channels: [], models: [], meta: {} }, esc, svg, nf, dom.$);
    a.adapt();
    const on = a.DATA.channels.find((c) => c.id === 'd-on');
    const off = a.DATA.channels.find((c) => c.id === 'd-off');
    check('★ 服务端的 dropParams 被接成数组 dp（两项都在、顺序不变）',
      Array.isArray(on.dp) && on.dp.length === 2 && on.dp[0] === 'reasoning_effort' && on.dp[1] === 'temperature');
    check('没配的渠道 → dp 是**空数组**（不是 undefined，模板才能直接 join / 判长度）',
      Array.isArray(off.dp) && off.dp.length === 0);
  }

  /* 3b.2 清单与回填：dropWhitelist() / dropParamsOf() / dropChipsHtml() */
  {
    const mk = (cfg) => new Function('CFG', 'esc',
      extract('dropWhitelist') + '\n' + extract('dropParamsOf') + '\n' + extract('dropChipsHtml')
      + '\nreturn { dropWhitelist, dropParamsOf, dropChipsHtml };')(cfg, esc);

    /* 桩里刻意给一份**与真实白名单明显不同**的短清单：界面显示的是桩里那份 → 证明没有硬编码 */
    const stub = ['zz-alpha', 'zz-beta'];
    const f = mk({ dropParamWhitelist: stub });
    const chips = f.dropChipsHtml();
    check('★ chips 来自服务端下发的清单（桩里是 zz-alpha / zz-beta，界面就该是这两个）',
      chips.includes('zz-alpha') && chips.includes('zz-beta') && !chips.includes('reasoning_effort'));
    check('每个 chip 都走 data-act 委托（不写内联事件属性）',
      (chips.match(/data-act="fill-drop-param"/g) || []).length === 2 && !/\sonclick=/.test(chips));
    check('参数名经 esc() 进属性（它是服务端/用户可控值）',
      mk({ dropParamWhitelist: ['a"b<c'] }).dropChipsHtml().includes('data-k="a&quot;b&lt;c"'));

    check('★ 回填：配了两项 → \'a, b\' 文本；没配 → 空框',
      f.dropParamsOf({ dp: ['reasoning_effort', 'temperature'] }) === 'reasoning_effort, temperature'
      && f.dropParamsOf({ dp: [] }) === '' && f.dropParamsOf(undefined) === '');

    /* ③ 降级：服务端没下发清单（老版本后端 / 该请求挂了）→ 不抛、不画 chips、字段照常可用 */
    const deg = mk({});
    let threw = '';
    let degHtml = '';
    try { degHtml = deg.dropChipsHtml(); } catch (e) { threw = e.message; }
    check('★ 服务端没下发清单时优雅降级：不抛异常、不画 chips（后端仍会 400 兜底并把清单写在文案里）',
      threw === '' && degHtml === '' && deg.dropWhitelist().length === 0);
    check('清单里混进非字符串（脏数据）也不炸，只把字符串留下',
      mk({ dropParamWhitelist: ['ok-one', 42, null, ''] }).dropWhitelist().join(',') === 'ok-one');
  }

  /* 3b.3 addDropParam()：点 chip 把名字填进框（去重、去空白） */
  {
    const dom = makeDom();
    const f = new Function('$', extract('addDropParam') + '\nreturn { addDropParam };')(dom.$);
    const inp = dom.$('#f-drop');
    inp.value = '';
    f.addDropParam('reasoning_effort');
    check('空框点一下 → 填进这个名字', inp.value === 'reasoning_effort');
    f.addDropParam('temperature');
    check('再点一个 → 逗号接上', inp.value === 'reasoning_effort, temperature');
    f.addDropParam('reasoning_effort');
    check('★ 重复点同一个不重复塞（用户在框里手打过也一样）', inp.value === 'reasoning_effort, temperature');
    inp.value = 'a, b';
    f.addDropParam('  c  ');
    check('手打的内容被尊重：去空白后接上（不是覆盖掉）', inp.value === 'a, b, c');
    f.addDropParam('');
    check('空名字/非字符串直接忽略（不塞空项）', inp.value === 'a, b, c');
  }

  /* 3b.4 saveChannel()：**总是**提交 dropParams；框空 = 显式 [] = 清空 */
  {
    const run = (dropVal) => {
      const dom = makeDom();
      const sent = [], toasts = [];
      const apiStub = async (p, opt) => { sent.push({ p, body: JSON.parse(opt.body) }); return { existed: false }; };
      const f = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'toast', 'api', 'closeModal', 'loadAll',
        'let modalChId=null, modalModels=[];\n' + extract('saveChannel') + '\nreturn { saveChannel };'
      )(dom.$, dom.$$, { channels: [] }, esc, svg, nf, (m) => toasts.push(m), apiStub, () => { }, async () => { });
      const v = (id, val) => { dom.$('#' + id).value = val; };
      v('f-id', 'new-ch'); v('f-name', '新渠道'); v('f-base', 'https://x.test/v1'); v('f-key', 'sk-x');
      v('f-proto', 'openai'); v('f-pri', '5'); v('f-weight', '0'); v('f-on', '1'); v('f-proxy', ''); v('f-headers', '');
      v('f-drop', dropVal);
      dom.$('#f-autoAlias').checked = true;
      return f.saveChannel().then(() => ({ sent, toasts }));
    };
    return (async () => {
      let r = await run('reasoning_effort, temperature');
      check('★ 表单里的清单进了请求体（逗号文本 → 数组两项）',
        r.sent.length === 1 && Array.isArray(r.sent[0].body.dropParams)
        && r.sent[0].body.dropParams.join(',') === 'reasoning_effort,temperature', r.sent[0] && r.sent[0].body.dropParams);
      check('同一发里其它字段照旧（没被这个新字段挤掉）',
        r.sent[0].body.id === 'new-ch' && r.sent[0].body.weight === 0 && r.sent[0].body.protocol === 'openai');

      r = await run('  a  ,, b  ');
      check('脏输入（多余空格 / 连续逗号 / 空项）被清成干净两项',
        r.sent[0].body.dropParams.join(',') === 'a,b', r.sent[0].body.dropParams);

      r = await run('');
      check('★ 框空 = 显式提交空数组（= 清空）。这条与 weight 的"留空 = 不动"刻意不同——'
        + '不发这个字段的话，服务端会沿用旧值，用户就永远清不掉已配的清单',
        Array.isArray(r.sent[0].body.dropParams) && r.sent[0].body.dropParams.length === 0, r.sent[0].body.dropParams);
    })();
  }

  /* 3b.5 结构守卫：前端不许自己抄一份白名单（抄了会与后端漂移） */
  {
    const hard = /'reasoning_effort'\s*,\s*'reasoning'\s*,\s*'verbosity'/.test(src)
      || /reasoning_effort',\s*'thinking',\s*'temperature'/.test(src);
    check('★ build/app.js 里没有硬编码的完整白名单（清单唯一来源是服务端下发的 dropParamWhitelist）',
      !hard && /CFG&&CFG\.dropParamWhitelist/.test(src));
    check('产物侧同样只认服务端下发的清单（console.html 与 app.js 同源，构建即同步）',
      !hard);
  }
}

/* ═══════ 4. 自动权重观测（v1.6 静默版）：adapt() 接字段 + 观测卡渲染 ═══════
   这一节守住"看得见"那一半：后端算出来的观测字段真被接进 DATA、观测卡真把
   「若启用会怎么分」画出来，并且**卡面上写明只算不生效**（不许让用户以为已经生效了）。 */
function testAutoWeight() {
  G('4. 自动权重观测：adapt() 接字段 → 观测卡画出预测份额 + 明示"只算不生效"');

  /* 4.1 adapt()：观测字段与 DATA.auto 都要接进来 */
  {
    const dom = makeDom();
    const RAW = {
      channels: [
        { id: 'a', name: 'A', protocol: 'openai', enabled: true, status: 'ok', aliases: [], autoH: 0.62, autoFailRate: 0.3, autoSamples: 20, autoLatMs: 240, autoSpeedRatio: 2.4 },
        { id: 'b', name: 'B', protocol: 'openai', enabled: true, status: 'ok', aliases: [], autoSamples: 0 },
      ],
      usage: null,
      auto: {
        enabled: true, effective: false, knobs: { floor: 0.2, maxShare: 70, latencyPenalty: 0.5, minSamples: 10 }, at: 123,
        models: [{ model: 'm1', requests: 9, manualOff: true, excluded: [], candidates: [{ id: 'a', share: 38, h: 0.62 }, { id: 'b', share: 62, h: 1 }] }],
      },
    };
    const a = new Function('RAW', 'DATA', 'esc', 'svg', 'nf', '$',
      'let CFG=null, loaded=false;\n' + extract('adapt') + '\nreturn { adapt, get DATA(){ return DATA } };'
    )(RAW, { channels: [], models: [], meta: {} }, esc, svg, nf, dom.$);
    a.adapt();
    const D = a.DATA;
    const chA = D.channels.find((c) => c.id === 'a');
    const chB = D.channels.find((c) => c.id === 'b');
    check('★ 每个渠道的观测字段都接进来了（健康系数/失败率/样本/延迟/速度比）',
      chA.ah === 0.62 && chA.aFail === 0.3 && chA.aN === 20 && chA.aLat === 240 && chA.aSpd === 2.4);
    check('没有数据的渠道给 null/0，而不是 undefined（模板能直接算）',
      chB.ah === null && chB.aFail === null && chB.aN === 0 && chB.aLat === null && chB.aSpd === null);
    check('★ DATA.auto 的观测块接进来了（含预测份额与旋钮）',
      D.auto && D.auto.models.length === 1 && D.auto.models[0].candidates[0].share === 38 && D.auto.knobs.maxShare === 70);
    check('★ effective=false 被如实带过来（界面上要能看出"还没生效"）',
      D.auto.effective === false && D.auto.enabled === true);
  }

  /* 4.2 autoWeightCard()：画出"若启用会怎么分"，并明确写着当前分流没动 */
  {
    const mk = (auto) => {
      const dom = makeDom();
      const DATA = {
        channels: [{ id: 'a', name: '甲渠道' }, { id: 'b', name: '乙渠道' }],
        auto,
      };
      const f = new Function('DATA', 'esc', 'nf', extract('autoWeightCard') + '\nreturn { autoWeightCard };')(DATA, esc, nf);
      return f.autoWeightCard();
    };
    const html = mk({
      enabled: true, effective: false, knobs: { floor: 0.2, maxShare: 70, latencyPenalty: 0.5, minSamples: 10 }, at: 1,
      models: [
        { model: 'm1', requests: 42, manualOff: true, excluded: [], candidates: [
          { id: 'a', share: 38, h: 0.62, failRate: 0.3, samples: 20, latMs: 240, speedRatio: 2.4, nowShare: null },
          { id: 'b', share: 62, h: 1, failRate: 0, samples: 12, latMs: 100, speedRatio: 1, nowShare: null },
        ] },
      ],
    });
    check('卡里出现模型名与两个候选的预测份额', html.includes('m1') && html.includes('38%') && html.includes('62%'));
    check('★ 用渠道**名字**而不是 id 展示（否则用户对不上是哪家）', html.includes('甲渠道') && html.includes('乙渠道'));
    check('★ 份额列只留显示名，不再跟一个 id 小片（列窄时省地方，名字不被 id 挤走）',
      html.includes('甲渠道') && !html.includes('class="id"'));
    check('★ 不合格的候选给出可解释的原因（失败率 / 速度倍数）', html.includes('失败率 30%') && html.includes('2.4 倍'));
    check('★ 份额带与标签同列：每个候选一列（列宽 = 份额），标签就在自己那一段正下方',
      html.includes('class="aw-col"') && html.includes('class="aw-seg"') && html.includes('class="aw-cap"'));
    check('份额为 0 的候选不进列（列宽 0 画出来看不见），单独一行交代理由',
      (() => {
        const z = mk({
          enabled: true, effective: false, knobs: {}, at: 0,
          models: [{ model: 'm4', requests: 9, manualOff: true, excluded: [], candidates: [
            { id: 'a', share: 100, h: 1, failRate: 0, samples: 40, latMs: 100, speedRatio: 1, nowShare: null },
            { id: 'b', share: 0, h: 0, failRate: 0.6, samples: 30, latMs: 500, speedRatio: 4, nowShare: null },
          ] }],
        });
        return z.includes('未参与分流：') && z.includes('失败率 60%')
          && z.split('class="aw-col"').length - 1 === 1;
      })());
    check('★ 卡头明示「当前分流一字未动」（不许让人误以为已经生效）', html.includes('当前分流一字未动'));
    check('旋钮值也写出来（速度权重 / 地板 / 上限 / 样本门槛）',
      html.includes('速度权重 0.5') && html.includes('地板 0.2') && html.includes('单渠道上限 70%') && html.includes('失败率样本 <10 条不扣分'));

    /* 真机实测会遇到的情形：新渠道失败率样本不足（该项不扣分），但它延迟很慢 → h 仍被速度项压低。
       此时提示必须写清"是哪一项在扣分"，否则用户会以为"样本不足就不该动"。 */
    const noSamples = mk({
      enabled: true, effective: false, knobs: { floor: 0.2, maxShare: 70, latencyPenalty: 0.5, minSamples: 10 }, at: 1,
      models: [{ model: 'm3', requests: 7, manualOff: true, excluded: [], candidates: [
        { id: 'a', share: 30, h: 0.53, failRate: null, samples: 1, latMs: 12304, speedRatio: 19, nowShare: null },
        { id: 'b', share: 70, h: 1, failRate: 0, samples: 40, latMs: 640, speedRatio: 1, nowShare: null },
      ] }],
    });
    check('★ 失败率样本不足时标明"这一项不扣分"，同时仍给出速度项的理由（速度不看样本）',
      noSamples.includes('失败率样本只有 1 条（不足 10，这一项不扣分）') && noSamples.includes('延迟 12304ms（最快的 19 倍）'));
    check('健康的那家不显示"健康 1.00"这种噪音（只显示"健康"）', !html.includes('健康 1.00'));

    const empty = mk({ enabled: false, effective: false, knobs: {}, at: 0, models: [] });
    check('★ 没有多候选模型时给空状态，而不是画一张空表', empty.includes('暂无可观测的分流'));

    const single = mk({ enabled: true, effective: false, knobs: {}, at: 0, models: [{ model: 'solo', requests: 3, candidates: [{ id: 'a', share: 100, h: 1 }] }] });
    check('★ 单候选模型不进卡（一个提供方谈不上分流，显示了只会是"100%"噪音）',
      single.includes('暂无可观测的分流'));

    const withNow = mk({
      enabled: true, effective: false, knobs: {}, at: 0,
      models: [{ model: 'm2', requests: 5, manualOff: false, excluded: ['c'], candidates: [
        { id: 'a', share: 40, h: 0.8, failRate: 0.2, samples: 30, latMs: 200, speedRatio: 2, nowShare: 75 },
        { id: 'b', share: 60, h: 1, failRate: 0, samples: 30, latMs: 100, speedRatio: 1, nowShare: 25 },
      ] }],
    });
    check('有手工权重时给出「当前 x%」的对照（能看出自动和手工会差多少）', withNow.includes('当前 75%') && withNow.includes('当前 25%'));
    check('被排除的候选（冷却/down）单独写出来', withNow.includes('已排除'));
  }

  /* 4.3 抽屉里那一块：结构守卫（渲染要一整套 stub，这里只保证文案与字段还在） */
  {
    const oc = extract('openChannel');
    check('★ 抽屉里有「自动权重（观测 · 只算不生效）」这一节', oc.includes('自动权重（观测 · 只算不生效）'));
    check('★ 抽屉里把判断依据摊开（健康系数 / 样本 / 失败率 / 延迟）',
      oc.includes('健康系数') && oc.includes('样本 ') && oc.includes('失败率 ') && oc.includes('延迟 '));
    check('抽屉里也写明"系数不会被执行"', oc.includes('上面的系数不会被执行'));
    check('★ 观测页真的挂上了观测卡（否则写了没人用）', extract('vAutoWeight').includes('autoWeightCard()'));
    check('★ 观测卡不再挤在渠道管理页（渠道页只剩页签 + 表格）', !extract('vChannels').includes('autoWeightCard()'));
    check('★ 自动权重是「资源」下的独立页（NAV 有入口、go() 有路由）',
      src.includes("id:'autoweight'") && src.includes('autoweight:vAutoWeight'));
  }
}

/* ═══════ 5. 停用渠道也要能手动测：测试弹窗不再把停用渠道整个跳过 ═══════
   需求：「停用的渠道点击测试也可以测试我添加的模型」。整改前 openTestModels 里一句
   `if(!c.on)continue;` 会让从停用渠道点「测试」弹出空列表、「运行测试」按钮直接是灰的。
   这里在最小 DOM 桩里真跑那个函数，断言弹窗里到底列出了什么。 */
function testDisabledTest() {
  G('5. 停用渠道的手动测试（弹窗里必须列得出它自己的模型）');
  const dom = makeDom();
  const chAliasesSrc = (src.match(/const chAliases=[^\n]+/) || [])[0];
  check('装配：从 build/app.js 现抠到 chAliases 的真实实现（不另写一份）', !!chAliasesSrc);
  const D2 = {
    channels: [
      { id: 'live', name: '启用家', proto: 'openai', on: true, aliases: [{ alias: 'm-on', upstream: 'up-on' }] },
      { id: 'stopped', name: '停用家', proto: 'openai', on: false, aliases: [{ alias: 'm-dis', upstream: 'up-dis' }] },
    ],
  };
  const run = (opts) => {
    let html = '';
    const f = new Function('$', '$$', 'DATA', 'esc', 'svg', 'modal', 'closeModal',
      chAliasesSrc + '\n' + extract('openTestModels') + '\nreturn { openTestModels };');
    f(dom.$, dom.$$, D2, esc, svg, (h) => { html = h; }, () => { }).openTestModels(opts);
    return html;
  };

  const onlyDis = run({ channelId: 'stopped' });
  check('★ 指定停用渠道：列得出它的模型（整改前这里是空列表）', onlyDis.includes('m-dis'));
  check('★ 而且只列这一条渠道（不会把别的渠道混进来）', !onlyDis.includes('m-on'));
  check('★ 明确标出「已停用」，不让人误以为它在参与调度', onlyDis.includes('已停用'));
  check('★ 并说明测通也不会启用它、且不参与自动探测', onlyDis.includes('停用渠道不参与自动探测'));
  check('运行测试按钮不再是灰的（有模型可勾）', /id="testRun"[^>]*>/.test(onlyDis) && !/id="testRun"[^>]*disabled/.test(onlyDis));

  const onlyOn = run({ channelId: 'live' });
  check('对照：指定启用渠道行为没变（只列它自己、且没有「已停用」标记）',
    onlyOn.includes('m-on') && !onlyOn.includes('m-dis') && !onlyOn.includes('已停用'));

  const all = run({});
  check('全局「测试模型」也带上停用渠道的模型（手动测试本来就该能测到全部）',
    all.includes('m-on') && all.includes('m-dis'));
  check('★ 但启用渠道排在前面（先看能用的，停用的垫底）', all.indexOf('m-on') < all.indexOf('m-dis'));
  check('全局模式也有"其中 N 个来自已停用渠道"的提示', all.includes('来自<b>已停用</b>渠道'));

  /* 结构守卫：runTests 必须逐条带 channelId —— 否则停用渠道的模型会被当成"完整调度"去路由，
     拿回 404 no channel（这正是"测不了"的另一种翻车方式） */
  check('★ runTests 每条都带 channelId（指定渠道测试，不走调度）', extract('runTests').includes('channelId:p.chan'));

  /* 对照组：按整改前"跳过停用"的写法，停用渠道列得出 0 个模型 → 本用例具备捕捉能力 */
  const legacy = D2.channels.filter(c => c.id === 'stopped').filter(c => c.on)
    .map(c => ({ c, items: chAliasesStub(c).map(r => r.alias) })).filter(g => g.items.length);
  check('对照组：旧写法（!c.on 就跳过）下停用渠道 0 个模型 → 测试抓得住这个 bug', legacy.length === 0);
}
function chAliasesStub(c) { return (c.aliases || []).map(r => ({ alias: r.alias, upstream: r.upstream })); }

/* ═══════ 6. 测试结果要看得懂：每行带模型名 + 明确的通过/空回复/失败 ═══════
   用户反馈（原话）："我不知道哪个是成功的哪个是失败的。完全不知道测试的是哪个模型。"
   旧渲染只写渠道名（一个渠道挂多个模型时等于没说测的是谁），且成功/失败只靠颜色区分，
   而"HTTP 200 但回复为空"被当成成功（绿色）显示成一对空引号 —— 三种结果长得都差不多。 */
async function testRunTests() {
  G('6. 测试结果：模型名 + 三档明确结论（通过 / 空回复 / 失败）');

  /* 6.1 判定真值表（纯函数） */
  const verdict = new Function(extract('testRowVerdict') + '\nreturn testRowVerdict;')();
  check('有回复 → 通过', verdict({ ok: true, reply: 'Hi' }) === 'ok');
  check('前后空白也算有回复', verdict({ ok: true, reply: '  Hi  ' }) === 'ok');
  check('★ 回复为空字符串 → 空回复（不是"通过"）', verdict({ ok: true, reply: '' }) === 'empty');
  check('★ 只有空白 → 空回复', verdict({ ok: true, reply: '   ' }) === 'empty');
  check('★ 根本没带 reply 字段 → 空回复', verdict({ ok: true }) === 'empty');
  check('没通 → 失败', verdict({ ok: false, error: 'x' }) === 'fail');
  check('HTTP 400 → 失败', verdict({ ok: false, status: 400 }) === 'fail');
  check('上游没返回结果（null）→ 失败', verdict(null) === 'fail');
  check('ok 缺失 → 失败（不把"不确定"当成功）', verdict({ reply: 'Hi' }) === 'fail');

  /* 6.2 真跑 runTests（DOM 桩 + 桩 HTTP + 桩 document），看它到底渲染了什么 */
  const dom = makeDom();
  const D3 = {
    channels: [
      { id: 'huchan', name: '虎哥', proto: 'openai', on: true, aliases: [{ alias: '[free]kimi-k3', upstream: 'kimi-k3' }] },
      { id: 'other', name: '别家', proto: 'openai', on: true, aliases: [{ alias: 'x', upstream: 'x' }] },
    ],
  };
  const picks = [
    { dataset: { m: '[free]kimi-k3', c: 'huchan' } },   /* 有回复 */
    { dataset: { m: '[free]kimi-k3', c: 'huchan' } },   /* 空回复 */
    { dataset: { m: '[free]kimi-k3', c: 'huchan' } },   /* HTTP 400 */
  ];
  const canned = [
    { ok: true, reply: 'Hi there! How can I help you today?', latencyMs: 11300, promptTokens: 687, completionTokens: 49 },
    { ok: true, reply: '', latencyMs: 9660, promptTokens: 636, completionTokens: 16 },
    { ok: false, status: 400, error: 'The provider rejected the request. Check that the request is well-formed.', latencyMs: 15500 },
  ];
  let nth = 0;
  const $$ = (sel) => (sel.indexOf('#testList') === 0 ? picks : []);
  dom.$('#testPrompt').value = 'hi';
  const out = dom.$('#testOut');
  const runTests = new Function('$', '$$', 'DATA', 'esc', 'svg', 'fMs', 'api', 'toast', 'setStatus', 'loadAll', 'document',
    extract('chName') + '\n' + extract('testRowVerdict') + '\n' + extract('runTests') + '\nreturn runTests;');
  /* fMs 也是现抠的真实实现（用 nf 那种恒等桩会把 "11.3 s" 断言成 "11300"，是假通过/假失败的来源） */
  const fMsSrc = (src.match(/const fMs=[^\n]+/) || [])[0];
  check('装配：从 build/app.js 现抠到 fMs 的真实实现', /ms<1000/.test(fMsSrc));
  const fMs = new Function(fMsSrc + '\nreturn fMs;')();
  const summary = dom.$('#testSummary');
  await runTests(dom.$, $$, D3, esc, svg, fMs, async () => ({ results: [canned[nth++]] }), toast,
    (el, text) => { el.textContent = text; }, async () => { }, { createElement: () => mkEl('tmp') })();

  const html = out.innerHTML;
  check('渲出了 3 行结果', (html.match(/class="r /g) || []).length === 3);
  check('★ 每一行都写了模型名（一个渠道挂多个模型时才认得出测的是谁）',
    (html.match(/<b>\[free\]kimi-k3<\/b>/g) || []).length === 3);
  check('★ 也写了渠道显示名（不是拿 id 让人猜）', (html.match(/虎哥/g) || []).length === 3 && !html.includes('@ huchan'));
  check('★ 三档都有中文结论，不再只靠颜色', html.includes('通过') && html.includes('空回复') && html.includes('失败'));
  check('★ 三档用三种样式（ok / wait / fail），空回复不再是绿色"成功"',
    /class="r ok"/.test(html) && /class="r wait"/.test(html) && /class="r fail"/.test(html));
  check('★ 空回复那行写清楚原因，而不是显示一对空引号',
    /class="r wait"[\s\S]*?HTTP 200 但回复为空[\s\S]*?模型没说任何话/.test(html) && !html.includes('""'));
  check('失败那行带 HTTP 状态码与上游错误原文',
    /class="r fail"[\s\S]*?HTTP 400[\s\S]*?provider rejected the request/.test(html));
  /* 抓整行来断言（回复在行尾的 .e 里、token 数在中间那格，跨格用顺序正则会假失败） */
  const rowOf = (cls) => (html.match(new RegExp('<div class="r ' + cls + '">[\\s\\S]*?</div>')) || [''])[0];
  const okRow = rowOf('ok');
  check('成功那行带真实回复与 token 数',
    okRow.includes('Hi there!') && okRow.includes('687+49 tok') && okRow.includes('11.3 s'));
  check('★ 汇总分开算三档（不是笼统的 x/y 通过）',
    /通过 1 · 空回复 1 · 失败 1（共 3 个/.test(summary.textContent));
  check('旧写法（只写渠道名 <b>huchan</b>）已消失 → 本用例抓得住旧渲染',
    !/<b>huchan<\/b>/.test(html));

  /* 6.3 结构守卫：程序里的模型名与渠道名都必须经过 esc（渲染的是用户可控文本） */
  const rt = extract('runTests');
  check('模型名与渠道名都过 esc 再进 HTML', rt.includes('esc(p.model)') && rt.includes('esc(chName(p.chan))'));
  check('★ 提示词里没有"空回复"时也不谎报（三档由 verdict 决定，不是拿 ok 一刀切）',
    rt.includes('testRowVerdict(row)') && !/if\(row\.ok\)okN\+\+/.test(rt));
}

/* ═══════ 7. 调用日志：渠道列显示渠道名（不是 id），且紧跟请求 ID ═══════ */
function testLogs() {
  G('7. 调用日志：渠道列显示**渠道名**（不是 ch-a 这类 id），且紧跟请求 ID 之后');
  const fMs = ms => ms < 0 ? '—' : ms + ' ms';
  const protoLabel = { openai: 'OpenAI' };
  const logs = [
    { t:'2026-09-28 10:00:00', ts:1, id:'req_1', m:'demo-model-a', c:'ch-a', n:'主渠道', p:'openai', ok:true, ms:120, i:10, o:20, note:'' },
    { t:'2026-09-28 10:00:01', ts:2, id:'req_2', m:'demo-model-b', c:'ch-b', n:'备用渠道', p:'openai', ok:false, ms:300, i:5, o:0, note:'' },
  ];
  const render = (drawSrc) => {
    const dom = makeDom();
    const api = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'fMs', 'protoLabel', 'openLog',
      "let lgRange='all', lgCh='', lgOk='all', lgQ='';\n" + extract('logRows') + '\n' + drawSrc + '\n' +
      'return { drawLogTable, logRows, setQ:(q)=>{lgQ=q}, get rows(){return logRows()} };'
    )(dom.$, dom.$$, { logs }, esc, svg, nf, fMs, protoLabel, () => {});
    api.drawLogTable();
    return { html: dom.$('#lgTable').innerHTML, api };
  };
  const cur = render(extract('drawLogTable'));
  check('★ 表头里「渠道」紧跟「请求 ID」（不再排在模型后面）',
    cur.html.indexOf('<th>请求 ID</th><th>渠道</th><th>模型</th>') >= 0);
  check('★ 渠道格显示渠道名（主渠道 / 备用渠道），不是 id',
    cur.html.indexOf('主渠道') >= 0 && cur.html.indexOf('备用渠道') >= 0
    && cur.html.indexOf('>ch-a<') < 0 && cur.html.indexOf('>ch-b<') < 0);
  check('★ 一格顺序就是 请求 ID → 渠道名 → 模型名（用户要的"在请求 ID 后面"）',
    /req_1<\/td>\s*<td class="cell-name">主渠道<\/td>\s*<td class="cell-name">demo-model-a<\/td>/.test(cur.html));
  check('搜索按渠道名能命中（按名字搜比按 id 自然）',
    (() => { cur.api.setQ('主渠道'); return cur.api.rows.length === 1 && cur.api.rows[0].c === 'ch-a'; })());
  check('搜索按 id 仍能命中（老习惯不破）',
    (() => { cur.api.setQ('ch-b'); return cur.api.rows.length === 1; })());

  /* adapt() 必须把渠道名解析进每条日志，否则渲染层根本没有 n 可用 */
  const RAW = {
    channels: [{ id:'ch-a', name:'主渠道', protocol:'openai', enabled:true, aliases:[] }],
    usage: { recent: [{ ts:1700000000000, model:'demo-model-a', channelId:'ch-a', ok:true, ms:120, in:10, out:20 }] },
    config: null,
  };
  const a = new Function('RAW', 'DATA', 'esc', 'svg', 'nf', '$', 'fmtTs', 'reqIdOf', 'protoOfChannel',
    'let CFG=null, loaded=false;\n' + extract('adapt') + '\nreturn { adapt, get DATA(){return DATA} };'
  )(RAW, { channels:[], models:[], meta:{} }, esc, svg, nf, makeDom().$,
    (t) => String(t), (t) => 'req_' + Number(t || 0).toString(36), () => 'openai');
  a.adapt();
  check('★ adapt() 把渠道名解析进日志条目（n=主渠道），id 仍保留（c=ch-a，筛选/导出仍可用）',
    a.DATA.logs[0].n === '主渠道' && a.DATA.logs[0].c === 'ch-a');

  /* 对照组：按整改前「渠道格写 id、且排在模型后面」的写法，必须失败 */
  const legacy = render(extract('drawLogTable')
    .replace('<th>请求 ID</th><th>渠道</th><th>模型</th>', '<th>请求 ID</th><th>模型</th><th>渠道</th>')
    .replace('<td class="cell-name">${esc(l.n)}</td>', '<td class="mono" style="font-size:12px">${l.c}</td>'));
  check('对照组：旧写法（渠道格写 id）下看不到渠道名 → 本用例抓得住',
    legacy.html.indexOf('>ch-a<') >= 0 && legacy.html.indexOf('主渠道') < 0);
}

/* ═══════ 8. 对照组：证明本测试抓得住「没有回填」的旧写法（防恒真） ═══════ */
function testControl() {
  G('8. 对照组（用整改前的写法跑同样断言，必须失败）');
  const v = mkEl('viewport');
  v.innerHTML = '<div class="search"><input id="mQ" placeholder="搜索模型名…"></div>';   /* 整改前的模板 */
  const rendered = (v.innerHTML.match(/id="mQ"[^>]*value="([^"]*)"/) || [])[1];
  check('旧写法（无 value= 回填）重绘后取不到搜索词 → 测试具备捕捉能力', rendered === undefined);
}

/* ═══════ 9. 零数据（全新部署）不许把页面/抽屉打挂 ═══════
   用户报告的 bug（v1.18.1）：新部署的实例上「渠道管理 → 详情」点了毫无反应。
   根因不在事件绑定，而在渲染：新实例 /admin/api/usage 还没有任何记录 → adapt() 算出
   trend=[] → areaChart 里 `pts[0][0]` 抛 TypeError。而详情抽屉是在 drawer(...) **之前**
   调图表函数的，于是整个 openChannel() 中断——界面无声无息，只有浏览器控制台一行红字。
   这类"空数据炸渲染"的 bug 有个共同特征：**有数据时全绿**，所以任何只用满数据跑的用例
   都抓不住它。这一节专门用"零数据"再跑一遍同样的渲染路径。 */
function testEmptyData() {
  G('9. 零数据（全新部署：还没有任何调用记录）—— 图表与详情抽屉都不许抛');
  /* 一行式 helper 直接从源码现抠，避免在测试里维护第二份实现 */
  const pickLine = (name) => {
    const m = src.match(new RegExp('^const ' + name + '=[^\\n]*$', 'm'));
    if (!m) throw new Error('build/app.js 里找不到 const ' + name + '（改名了？请同步本脚本）');
    return m[0] + '\n';
  };
  const dom = makeDom();
  const build = (trend) => {
    const DATA = {
      trend,
      channels: [{
        id: 'stub-alpha', name: '主渠道', proto: 'openai', on: true, status: 'ok', ms: 120, pri: 0, eff: 0,
        fail: 0, w: 0, wHits: 0, wShare: 0, ah: null, aN: 0, aFail: null, aLat: null, aSpd: null,
        req: 0, err: 0, models: 1, baseUrl: 'https://api.example.com/v1', apiKey: 'sk-stub',
        aliases: [{ alias: 'demo-model-a', upstream: 'demo-model-a' }],
      }],
    };
    const body = [pickLine('esc'), pickLine('nf'), pickLine('pct'), pickLine('fMs'), pickLine('maskKey'),
      pickLine('stTxt'), pickLine('protoLabel'), pickLine('chBaseUrl'), pickLine('chAliases'),
      extract('chKey'),   /* chKey 是函数声明而不是箭头常量，走 extract */
      extract('areaChart'), extract('sparkline'), extract('drawer'), extract('openChannel'),
      'return { areaChart, sparkline, openChannel };'].join('\n');
    return new Function('$', '$$', 'DATA', 'svg', 'toast', 'copyText', body)(
      dom.$, dom.$$, DATA, svg, () => {}, () => {});
  };

  /* ① 图表基元：空数组 / 单点 / 满数据 */
  const empty = build([]);
  let threw = null;
  try { empty.areaChart([], 520, 150, { pad: [12, 10, 22, 32] }); } catch (e) { threw = e; }
  check('★ 空曲线不抛异常（原 bug：pts[0] of undefined）', threw === null, threw && threw.message);
  const emptySvg = empty.areaChart([], 520, 150, { pad: [12, 10, 22, 32] });
  check('★ 空曲线给的是占位图（写明"暂无数据"），不是空白也不是崩', /暂无数据/.test(emptySvg) && /<svg/.test(emptySvg));
  threw = null;
  try { empty.areaChart([['09-24', 5]], 520, 150, {}); } catch (e) { threw = e; }
  check('单点曲线也不抛（n=1 是合法输入）', threw === null, threw && threw.message);
  threw = null;
  try { empty.sparkline([], 72, 22, null, true); } catch (e) { threw = e; }
  check('★ 空迷你曲线不抛（stretch 分支以前会取 pts[pts.length-1][0]）', threw === null, threw && threw.message);
  check('★ 单点迷你曲线不出 NaN（以前 w/(length-1) = w/0）', !/NaN/.test(empty.sparkline([5], 72, 22)));
  check('满数据的曲线照旧画得出来（空数据保护没有改行为）',
    /<path d="M/.test(empty.areaChart([['a', 1], ['b', 3], ['c', 2]], 520, 150, {}))
    && /<path d="M/.test(empty.sparkline([1, 3, 2])));

  /* ② 端到端：真的走「详情」那条路径（这正是用户点的那一下） */
  const zero = build([]);
  const before = dom.$('#drawer').innerHTML;
  threw = null;
  try { zero.openChannel('stub-alpha'); } catch (e) { threw = e; }
  check('★★ 零数据下点「详情」不抛异常（原 bug：整个抽屉打不开）', threw === null, threw && threw.message);
  const drew = dom.$('#drawer').innerHTML;
  check('★★ 抽屉真的画出来了（不是停在上一屏）', drew.length > before.length && drew.includes('drawer-hd'));
  check('抽屉里有这个渠道的名字与"暂无数据"占位', drew.includes('主渠道') && drew.includes('暂无数据'));

  const full = build([['09-22', 10], ['09-23', 14], ['09-24', 9]]);
  threw = null;
  try { full.openChannel('stub-alpha'); } catch (e) { threw = e; }
  const drewFull = dom.$('#drawer').innerHTML;
  check('有数据时抽屉照旧画出曲线', threw === null && /<path d="M/.test(drewFull));

  /* ③ 结构守卫：空数据保护必须留在源码里（别在后续重构里被"简化"掉） */
  check('结构守卫：areaChart 开头有空数据早返回', /function areaChart\(data,w,h,opts\)\{[\s\S]{0,1200}?if\(!Array\.isArray\(data\)/.test(src));
  check('结构守卫：sparkline 开头有空数据早返回', /function sparkline\(vals,w=72,h=22,c,stretch\)\{[\s\S]{0,800}?if\(!Array\.isArray\(vals\)/.test(src));
}

/* ═══════ 10. 运行期设置页：草稿跨轮询保留 · 只提交改动组 · 400 原文直显 ═══════
   v1.18 新增页（规格见 docs/console-settings-spec.md）。三条最容易悄悄坏掉的契约：
   ① 8 秒轮询重绘不许吞掉正在编辑的草稿（dirty 时 syncSettingsDraft 绝不覆盖）；
   ② POST 是 PATCH 语义，只发有改动的组 / 字段（没带的不动、不归零；留空数字不下发）；
   ③ 后端 400 的 error 原文要直接显示（否则用户不知道该改哪个字段）。 */
function testSettings() {
  G('10. 运行期设置 vSettings（草稿跨轮询保留 · 只提交改动组 · 400 原文直显）');

  /* 整段实现从源码现抠：setDraft 声明 → saveSettings 结束（含中间所有 helper） */
  const SAVE_SRC = extract('saveSettings');
  const SET_SRC = src.slice(src.indexOf('let setDraft=null'), src.indexOf(SAVE_SRC) + SAVE_SRC.length);
  check('装配：从 build/app.js 现抠到运行期设置整段实现（setDraft 声明 → saveSettings）',
    SET_SRC.includes('let setDraft=null') && SET_SRC.includes('function vSettings(') && SET_SRC.includes('function setPayload('));

  /* 位置守卫（v1.18.2）：运行期设置归「工具」组，夹在 Playground 与接入信息之间（不在「资源」组）。 */
  {
    const navBlock = src.slice(src.indexOf('const NAV=['), src.indexOf('let page='));
    const iRes = navBlock.indexOf("sec:'资源'"), iTool = navBlock.indexOf("sec:'工具'");
    const iPg = navBlock.indexOf("id:'playground'"), iSet = navBlock.indexOf("id:'settings'"), iAcc = navBlock.indexOf("id:'access'");
    check('★ 运行期设置归「工具」组（在 资源 之后、工具 段内），夹在 Playground 与接入信息之间',
      iRes >= 0 && iTool > iRes && iPg > iTool && iSet > iPg && iAcc > iSet);
  }

  const mkRaw = () => ({
    settings: {
      config: {
        sessionAffinity: { enabled: false, ttlSec: 5, maxEntries: 2000, deriveFromBody: false },
        rateLimit: { enabled: false, rpm: 60, burst: 0, maxConcurrent: 0 },
        metrics: { enabled: true, public: false },
        thinkingReplay: { enabled: false, ttlSec: 90, maxEntries: 2048 },
      },
      effective: {
        sessionAffinity: { enabled: false, ttlSec: 30, maxEntries: 2000, deriveFromBody: false },
        rateLimit: { enabled: false, rpm: 60, burst: 60, maxConcurrent: 0 },
        metrics: { enabled: true, public: false },
        thinkingReplay: { enabled: false, ttlSec: 90, maxEntries: 2048 },
      },
      status: {
        affinity: { entries: 3, hits: 2, misses: 1, learned: 4 },
        rateLimit: { inflight: 0, peakInflight: 2, limitedRate: 0, limitedConcurrent: 0 },
        metrics: {},
        thinkingReplay: { entries: 2, hits: 1, misses: 1, learned: 3, stale: 0 },
      },
    },
  });

  const build = (rawSrc, raw, apiStub, toasts) => {
    const dom = makeDom();
    /* vSettings 用 dom.root、saveSettings 用 $('#viewport') 与无根的 $('#setSave') 三处取容器，
       桩必须让它们指同一个对象，否则 #setErr / 按钮会落在不同桩元素上，断言成假通过。 */
    const $ = (sel, root) => (sel === '#viewport' ? dom.root : dom.$(sel, root || dom.root));
    const f = new Function('$', '$$', 'RAW', 'DATA', 'esc', 'svg', 'nf', 'toast', 'api', 'copyText', 'render', 'location',
      rawSrc + '\nreturn { vSettings, setPayload, setToggle, syncSettingsDraft, saveSettings, ' +
      'get setDraft(){return setDraft}, get setDirty(){return setDirty}, get setError(){return setError}, get setSaving(){return setSaving} };');
    const api = f($, dom.$$, raw, { channels: [], models: [], meta: {} }, esc, svg, nf,
      (m, k) => toasts.push([m, k]), apiStub, () => {}, () => {}, { origin: 'http://127.0.0.1:8787' });
    return { dom, api };
  };

  /* ── 10.1 首渲染：config 回填表单、effective 只在与 config 不同处给「生效：」角标 ── */
  {
    const { dom, api } = build(SET_SRC, mkRaw(), async () => ({}), []);
    api.vSettings(dom.root);
    const html = dom.root.innerHTML;
    check('首渲染：四张卡都在（会话粘性 / 客户端限流 / 指标端点 / thinking 回放）',
      html.includes('会话粘性') && html.includes('客户端限流') && html.includes('指标端点') && html.includes('thinking 回放'));
    check('第四张卡（thinking 回放）字段齐全：开关 + 缓存时长 + 最多缓存条数，回填 config 原值',
      html.includes('id="setTg_thinkingReplay"') && html.includes('id="set_thinkingReplay_ttlSec"') &&
      html.includes('id="set_thinkingReplay_maxEntries"') && /value="2048"/.test(html));
    check('★ 表单回填 config 原值（ttlSec=5），而不是 effective 的 30',
      html.includes('value="5"') && !html.includes('value="30"'));
    check('★ 同时给出钳制后的生效值角标（ttlSec 5 → 生效：30），避免"我填的 5 怎么没生效"',
      html.includes('生效：30'));
    check('已启用的卡（指标端点）开关是 on，未启用的卡整卡降权（muted）',
      html.includes('id="setTg_metrics"') && /set-card muted/.test(html));
    check('无改动时保存按钮 disabled（没东西可提交就不让点）', dom.$('#setSave', dom.root).disabled === true);
    check('指标卡给出可复制的抓取地址（带 origin）',
      html.includes('复制抓取地址') && html.includes('http://127.0.0.1:8787/metrics'));
    check('★ 接口没数据时给「设置接口不可用」占位，不白屏',
      (() => {
        const bad = build(SET_SRC, { settings: null }, async () => ({}), []);
        bad.api.vSettings(bad.dom.root);
        return bad.dom.root.innerHTML.includes('设置接口不可用');
      })());
  }

  /* ── 10.2 输入跨轮询保留（dirty 时 syncSettingsDraft 绝不覆盖） ── */
  {
    const { dom, api } = build(SET_SRC, mkRaw(), async () => ({}), []);
    const v = dom.root;
    api.vSettings(v);
    const input = dom.$('#set_sessionAffinity_ttlSec', v);
    check('数字输入框已绑定 oninput', typeof input.oninput === 'function');
    input.oninput({ target: { value: '120' } });
    check('输入写回草稿（ttlSec=120）且标脏', api.setDraft.sessionAffinity.ttlSec === 120 && api.setDirty === true);
    check('有改动后保存按钮变可用', dom.$('#setSave', v).disabled === false);

    api.vSettings(v);   /* ← 等价于 8 秒轮询触发的那次重绘 */
    check('★ 重绘后草稿仍在（value="120"），没被服务端的 5 覆盖',
      v.innerHTML.includes('value="120"') && !v.innerHTML.includes('value="5"'));

    /* 对照组：去掉 dirty 守卫（整改前的写法：无条件覆盖），同样的重绘会把草稿吞掉 */
    const legacySrc = SET_SRC.replace(
      'if(force||!setDraft||!setDirty) setDraft=JSON.parse(JSON.stringify(s.config));',
      'setDraft=JSON.parse(JSON.stringify(s.config));');
    check('对照组装配：旧写法确实少了 dirty 守卫', legacySrc !== SET_SRC && !legacySrc.includes('!setDirty'));
    const legacy = build(legacySrc, mkRaw(), async () => ({}), []);
    legacy.api.vSettings(legacy.dom.root);
    legacy.dom.$('#set_sessionAffinity_ttlSec', legacy.dom.root).oninput({ target: { value: '120' } });
    legacy.api.vSettings(legacy.dom.root);
    check('★ 对照组：旧写法重绘后被覆盖回 value="5" → 本用例抓得住"输入被轮询吞掉"',
      legacy.dom.root.innerHTML.includes('value="5"') && !legacy.dom.root.innerHTML.includes('value="120"'));
  }

  /* ── 10.3 只提交有改动的组 / 字段（PATCH 语义；留空数字不下发） ── */
  {
    const { dom, api } = build(SET_SRC, mkRaw(), async () => ({}), []);
    const v = dom.root;
    api.vSettings(v);
    check('★ 无改动 → payload 为空（不会把四组原样回写）', Object.keys(api.setPayload()).length === 0);

    api.setToggle('rateLimit');   /* 只开限流这一组 */
    let p = api.setPayload();
    check('★ 只带被改的组（rateLimit），没动的 sessionAffinity / metrics / thinkingReplay 不出现',
      !!p.rateLimit && !p.sessionAffinity && !p.metrics && !p.thinkingReplay);
    check('★ 组内只带被改的字段（enabled），其余字段不跟着回写',
      Object.keys(p.rateLimit).length === 1 && p.rateLimit.enabled === true);

    dom.$('#set_rateLimit_rpm', v).oninput({ target: { value: '120' } });
    p = api.setPayload();
    check('改了 rpm → payload 里 rateLimit 同时含 enabled 与 rpm',
      p.rateLimit.rpm === 120 && p.rateLimit.enabled === true);

    dom.$('#set_rateLimit_rpm', v).oninput({ target: { value: '' } });
    p = api.setPayload();
    check('★ 数字留空 = 不下发（留空 ≠ 0，否则会被后端当成"限流 0"静默改语义）',
      !!p.rateLimit && p.rateLimit.rpm === undefined);

    api.setToggle('rateLimit');   /* 再点一次 = 还原成原值 */
    check('改回原值后该组不再出现在 payload（不是"改过就必发"）', api.setPayload().rateLimit === undefined);

    api.setToggle('thinkingReplay');   /* 第四组同样的 PATCH 语义 */
    p = api.setPayload();
    check('第四组（thinking 回放）开着才进 payload，组内只带 enabled',
      !!p.thinkingReplay && Object.keys(p.thinkingReplay).length === 1 && p.thinkingReplay.enabled === true);
    api.setToggle('thinkingReplay');
  }

  /* ── 10.4 保存成功：落库回读 + 清脏；400 失败：error 原文直显 ── */
  return (async () => {
    {
      const raw = mkRaw();
      const toasts = [], sent = [];
      const nextCfg = {
        sessionAffinity: { enabled: true, ttlSec: 120, maxEntries: 2000, deriveFromBody: false },
        rateLimit: { enabled: false, rpm: 60, burst: 0, maxConcurrent: 0 },
        metrics: { enabled: true, public: false },
        thinkingReplay: { enabled: true, ttlSec: 120, maxEntries: 2048 },
      };
      const { dom, api } = build(SET_SRC, raw, async (path, opt) => {
        sent.push({ path, body: JSON.parse(opt.body) });
        return { config: nextCfg, effective: nextCfg, status: raw.settings.status };
      }, toasts);
      const v = dom.root;
      api.vSettings(v);
      api.setToggle('sessionAffinity');
      dom.$('#set_sessionAffinity_ttlSec', v).oninput({ target: { value: '120' } });
      await api.saveSettings();
      check('保存走 POST /admin/api/settings', sent.length === 1 && sent[0].path === '/admin/api/settings');
      check('★ 报文只含被改的 sessionAffinity 组（PATCH 语义，第四组没动就不出现）',
        !!sent[0].body.sessionAffinity && !sent[0].body.rateLimit && !sent[0].body.metrics && !sent[0].body.thinkingReplay);
      check('保存成功后清脏、草稿与服务端对齐',
        api.setDirty === false && raw.settings.config.sessionAffinity.ttlSec === 120);
      check('给出成功提示', /设置已保存/.test(toasts.map((t) => t[0]).join('')));
      check('保存结束后按钮文案恢复、可再次点击',
        dom.$('#setSave', v).innerHTML.includes('保存设置') && !dom.$('#setSave', v).innerHTML.includes('保存中'));
    }

    {
      const raw = mkRaw();
      const { dom, api } = build(SET_SRC, raw, async () => {
        const e = new Error('http 400'); e.status = 400; e.body = { error: 'unknown field rateLimit.rpmm' }; throw e;
      }, []);
      const v = dom.root;
      api.vSettings(v);
      dom.$('#set_rateLimit_rpm', v).oninput({ target: { value: '120' } });
      await api.saveSettings();
      check('★ 400 的 error 原文被原样存下（不是"保存失败"这种空话）',
        api.setError === 'unknown field rateLimit.rpmm');
      const errEl = dom.$('#setErr', v);
      check('★ 错误条真的显示出来（class 加 on）', errEl.className === 'set-err on');
      check('★ 错误条文本就是后端点名的字段', errEl.textContent === 'unknown field rateLimit.rpmm');
      check('失败后按钮也恢复（不会卡在"保存中…"）',
        dom.$('#setSave', v).innerHTML.includes('保存设置') && api.setSaving === false);
      check('失败不清脏（草稿还在，用户改完字段能重试）', api.setDirty === true);
    }
  })();
}


/* ── 11. 密钥管理：掩码展示、草稿保留、轮换与会话语义（v1.18.6）────────── */
async function testKeys() {
  G('11. 密钥管理 vKeys（掩码 · 草稿跨轮询 · 轮换 · 会话语义）');

  const RESET_SRC = extract('resetKeysAction');
  const begin = src.indexOf('const KEY_SRC_TXT=');
  const end = src.indexOf(RESET_SRC) + RESET_SRC.length;
  const KEY_SRC = src.slice(begin, end);
  check('装配：从 build/app.js 现抠到密钥管理整段实现',
    begin >= 0 && end > begin && KEY_SRC.includes('function vKeys(') &&
    KEY_SRC.includes('function rotateKey(') && KEY_SRC.includes('function toggleKeyReveal('));

  {
    /* v1.18.6 会话化：管理密钥从「常驻 localStorage/sessionStorage、api() 每次带 Bearer」
       改成「登录门 POST /admin/api/session 一次 → HttpOnly 会话 cookie」。
       任何 adminKey 落存储的写法回潮（含 api() 注 Authorization、登录门存 key），本守卫直接红。 */
    check('★ 管理密钥不落任何浏览器存储（登录门换会话 cookie，不再存 key）',
      !src.includes("sessionStorage.getItem('adminKey')") &&
      !src.includes("localStorage.setItem('adminKey'") &&
      !src.includes("sessionStorage.setItem('adminKey'") &&
      !src.includes("localStorage.getItem('adminKey')"));
    check('★ api() 不再注入 Authorization（鉴权只靠同源会话 cookie）',
      !/headers\['Authorization'\]\s*=/.test(src.slice(src.indexOf('async function api('), src.indexOf('async function api(') + 900)));
    check('★ 登录门走 POST /admin/api/session 换会话，?key= 通道已拆除',
      src.includes("fetch('/admin/api/session',{method:'POST'") &&
      !src.includes('searchParams.get(\'key\')'));
    check('对照组：旧写法（keyFlow 收 ?key= 进 localStorage）会被本守卫抓红',
      !src.includes('__ZZ_HAS_KEY__'));
  }

  {
    const nav = src.slice(src.indexOf('const NAV=['), src.indexOf('let page='));
    const iTool = nav.indexOf("sec:'工具'"), iSet = nav.indexOf("id:'settings'");
    const iKeys = nav.indexOf("id:'keys'"), iAccess = nav.indexOf("id:'access'");
    check('★ 密钥管理归「工具」组，位于运行期设置与接入信息之间',
      iTool >= 0 && iSet > iTool && iKeys > iSet && iAccess > iKeys);
    check('★ render() 与 go() 两张路由表都注册 keys:vKeys',
      (src.match(/keys:vKeys/g) || []).length === 2);
  }

  {
    /* 状态横幅必须自带内边距：.card 只有 overflow:hidden、没有 padding，
       内容直接塞 .row 会贴着边框（v1.18.6 修的"框怪怪的"就是这个）。 */
    check('★ 密钥状态横幅走 card-bd（.card 自身无 padding，漏了会贴边框）',
      /class="card-bd row" style="gap:9px/.test(KEY_SRC));
    const legacyKey = KEY_SRC.replace('class="card-bd row" style="gap:9px', 'class="row" style="gap:9px');
    check('对照组：漏 card-bd 的旧写法不满足该守卫 → 本用例抓得住"内容贴边框"回归',
      !/class="card-bd row" style="gap:9px/.test(legacyKey));
  }

  {
    /* 密钥值的 span 原本写的是 class="mask mono"，而 .mask 是**弹窗遮罩**
       （position:fixed;inset:0;opacity:0，见设计稿 modal 区块）——套上来密钥值就成了
       一个铺满视口、透明、脱离文档流的元素：行里只剩「当前值 / 显示 / 复制」，值看不见。
       这个类名冲突设计稿里就带着（接入信息页的 GATEWAY_KEY 一起中招），v1.18.6 修。 */
    check('★ 密钥值走 .kval，不得再借用弹窗遮罩的 .mask 类名',
      KEY_SRC.includes('class="kval mono"') && !/class="mask mono"/.test(KEY_SRC));
    check('★ 接入信息页的 GATEWAY_KEY 值同样走 .kval（同一个冲突，两处一起修）',
      src.includes('<span>GATEWAY_KEY</span><span class="kval mono">') &&
      !/<span>GATEWAY_KEY<\/span><span class="mask mono">/.test(src));
    const legacyVal = KEY_SRC.replace('class="kval mono"', 'class="mask mono"');
    check('对照组：旧写法 class="mask mono" 不满足该守卫 → 本用例抓得住"密钥值整行不可见"回归',
      /class="mask mono"/.test(legacyVal));
  }

  {
    /* 光看源码不够：类名冲突是 CSS 层面的，产物里必须真的没有 .ep-key .mask 规则、
       且 .mask 仍是那条弹窗遮罩（否则守卫会在"把遮罩改名"这种改法下失效）。 */
    const built = fs.readFileSync(path.join(__dirname, '..', 'console.html'), 'utf8');
    check('★ 产物里 .ep-key .kval 有样式，且 .ep-key .mask 规则已消失',
      built.includes('.ep-key .kval{') && !built.includes('.ep-key .mask{'));
    check('★ .mask 仍是弹窗遮罩（position:fixed + inset:0 + opacity:0 一条不少）',
      /\.mask\{[^}]*position:fixed[^}]*opacity:0/.test(built));
  }

  const mkRaw = () => ({ keys: {
    gatewayKey: { masked: 'sk-a…1234', set: true, source: 'env' },
    adminKey: { masked: 'admi…7890', set: true, source: 'console' },
    rotatedAt: '2026-09-29T02:03:04.000Z', keysInsecure: false,
  }});
  const storage = () => {
    const m = new Map();
    return { getItem:k => m.has(k) ? m.get(k) : null,
      setItem:(k,v) => m.set(k,String(v)), removeItem:k => m.delete(k) };
  };
  const build = (raw, apiStub, sent, toasts) => {
    const dom = makeDom();
    const $ = (sel, root) => sel === '#viewport' ? dom.root : dom.$(sel, root || dom.root);
    const sessionStorage = storage(), localStorage = storage();
    const apiWrap = async (path, opts) => {
      sent.push({ path, opts: opts || {} });
      return apiStub(path, opts || {});
    };
    const factory = new Function('$', '$$', 'RAW', 'DATA', 'esc', 'svg', 'nf', 'toast',
      'api', 'copyText', 'render', 'reload', 'sessionStorage', 'localStorage', 'location', 'logout',
      KEY_SRC + '\nreturn { vKeys, rotateKey, resetKeysAction, toggleKeyReveal, armConfirm, fillGeneratedKey,' +
      ' get keyDraft(){return keyDraft}, get keyReveal(){return keyReveal} };');
    const api = factory($, dom.$$, raw, { channels:[], models:[], meta:{} }, esc, svg, nf,
      (m,k) => toasts.push([m,k]), apiWrap, () => {}, () => {}, async () => {},
      sessionStorage, localStorage, { origin:'http://127.0.0.1:8787' }, async () => {});
    return { dom, api, sessionStorage, localStorage };
  };

  {
    const sent=[], toasts=[];
    const x = build(mkRaw(), async () => ({}), sent, toasts);
    x.api.vKeys(x.dom.root);
    const html = x.dom.root.innerHTML;
    check('首渲染：两类密钥、掩码与来源均显示，不把明文塞进页面快照',
      html.includes('网关密钥') && html.includes('管理密钥') &&
      html.includes('sk-a…1234') && html.includes('admi…7890') &&
      html.includes('来源：环境变量') && html.includes('来源：控制台轮换'));
    check('接口没数据时给可理解的空状态，不白屏', (() => {
      const y = build({keys:null}, async () => ({}), [], []);
      y.api.vKeys(y.dom.root);
      return y.dom.root.innerHTML.includes('密钥接口不可用');
    })());

    const input = x.dom.$('#ki_gateway', x.dom.root);
    check('网关密钥输入框绑定 oninput', typeof input.oninput === 'function');
    input.oninput({target:{value:'manual-gateway-key-123456'}});
    x.api.vKeys(x.dom.root);
    check('★ 轮询重绘后手填草稿仍回填，不会被 8 秒刷新吞掉',
      x.dom.root.innerHTML.includes('value="manual-gateway-key-123456"'));
  }

  {
    const sent=[], toasts=[];
    const x = build(mkRaw(), async (path) => path.endsWith('/api/keys')
      ? {ok:true,newKeys:{adminKey:'new-admin-key-1234567890'}} : {}, sent, toasts);
    // 随机生成只在本地填进输入框，不发任何请求（用户要先看到/复制新值，再点「轮换」确认生效）
    x.api.fillGeneratedKey('admin');
    const genDraft = x.api.keyDraft.admin;
    check('★ 随机生成把 48 位四样字符齐全的密钥填进草稿框且不发请求',
      /^[\x21-\x7e]{48}$/.test(genDraft) && /[a-z]/.test(genDraft) && /[A-Z]/.test(genDraft) &&
      /[0-9]/.test(genDraft) && /[^a-zA-Z0-9]/.test(genDraft) && sent.length===0);
    check('随机生成后提示「点轮换生效」，不撒谎说已生效',
      toasts.some(t => String(t[0]).includes('轮换」生效')));
    const btn = mkEl('rotate-admin'); btn.dataset.arm='1';
    await x.api.rotateKey('admin', genDraft, btn);
    check('★ 轮换走统一轮换端点并提交框内的新值', (() => {
      const q=sent[0], body=JSON.parse(q.opts.body);
      return q.path==='/admin/api/keys' && q.opts.method==='POST' && body.adminKey===genDraft;
    })());
    check('★ 管理密钥轮换后不往任何浏览器存储写值（会话 cookie 由服务端 Set-Cookie 补发，浏览器自己种）',
      x.sessionStorage.getItem('adminKey')===null && x.localStorage.getItem('adminKey')===null);
    check('轮换成功后清空管理密钥草稿并提示旧值立即失效',
      x.api.keyDraft.admin==='' && toasts.some(t => String(t[0]).includes('旧值已立即失效')));
  }

  {
    const sent=[];
    const x = build(mkRaw(), async path => path==='/admin/api/admin-key'
      ? {ok:true,adminKey:'revealed-admin-key-123456'} : {}, sent, []);
    await x.api.toggleKeyReveal('admin');
    check('显示管理密钥时才按需请求明文端点',
      sent.length===1 && sent[0].path==='/admin/api/admin-key' &&
      x.api.keyReveal.admin==='revealed-admin-key-123456');
  }

  {
    const sent=[];
    const x = build(mkRaw(), async () => ({ok:true}), sent, []);
    const btn = mkEl('reset'); btn.dataset.arm='1';
    await x.api.resetKeysAction(btn);
    check('「回到环境变量值」调用独立 reset 端点',
      sent.length===1 && sent[0].path==='/admin/api/keys/reset' && sent[0].opts.method==='POST');
    check('危险动作保留两步确认守卫与 6 秒自动复位窗口',
      KEY_SRC.includes("btn.dataset.arm==='1'") && KEY_SRC.includes('setTimeout(') && KEY_SRC.includes('6000'));
  }
}

/* ══ §12 事件委托（v1.18.7）：内联事件处理器清零后的全站唯一事件入口 ══
   内联 onclick=/onchange=/onkeydown= 属性已全部换成 data-act / data-change + document 委托。
   本节把产品里**真实的委托块**（ACTS 表 + click/change 两个 document 监听）原样抠出来，
   在桩函数上真跑分发：参数真的从 dataset 到达动作函数；嵌套点击只触发最近那枚
   （行内按钮不再冒泡去触发行/卡片自己的动作——stopPropagation 成为历史）；未知动作与
   空白点击静默不炸；change 走同一条路；数值参数走 +el.dataset.idx。另含双向覆盖守卫：
   模板里用到的每个 data-act/data-change 都注册过，注册过的都被模板用到。
   46 个动作函数名刻意硬编码在本节：ACTS 里新增引用了不在此列的函数名时，
   "逐个真调"会当场 ReferenceError，逼着同步本表与产品。 */
function testDelegation() {
  const SHELL = fs.readFileSync(path.join(__dirname, '..', 'build', 'shell.html'), 'utf8');
  const start = src.indexOf('const ACTS={');
  const chgIdx = src.indexOf("document.addEventListener('change'", start);
  const end = src.indexOf('});', chgIdx);
  if (start < 0 || chgIdx < 0 || end < 0) throw new Error('build/app.js 里找不到事件委托块（ACTS / document 监听）');
  const block = src.slice(start, end + 3);

  const names = ['exportUsage','recheckAll','go','openChannel','openLog','openModel','toggleMenu',
    'openImport','openTestModels','openChannelForm','toggleCh','closeDrawer','toggleDrawerKey',
    'copyChKey','reprobe','delChannel','exportModels','copyModels','copyText','copyCurl','clearUsage',
    'exportLogs','drawLogTable','pgClear','pgCopyCurl','copyAllEndpoints','copyGwKey','showKeyHelp',
    'closeModal','toggleKeyField','addModelRow','probeUpstream','saveChannel','testRowModel',
    'delModelRow','probeSelectAll','probeClearSel','probeAddSelected','importFiles','doImport','runTests',
    'refreshStats','stFilter','render','banIp','unbanIp','addDropParam'];
  const calls = [];
  const stubs = {}; names.forEach(n => stubs[n] = (...a) => { calls.push([n].concat(a)); });
  const doc = {
    listeners: {},
    addEventListener(kind, fn) { this.listeners[kind] = fn; },
    getElementById() { return { click() {} }; },
  };
  const ACTS = new Function(...names, 'document', block + '\n;return ACTS;')(
    ...names.map(n => stubs[n]), doc);

  check('委托块给 document 挂了 click 与 change 两个监听',
    typeof doc.listeners.click === 'function' && typeof doc.listeners.change === 'function');
  check('ACTS 注册了 49 个动作（与模板用到的动作种类数一致）', Object.keys(ACTS).length === 49,
    Object.keys(ACTS).length);

  /* 逐个真调：每个注册动作都解析得到底层函数（引用了列表外的函数名会当场炸） */
  const probeEl = { dataset: {}, getAttribute() { return 'open-model'; } };
  let allResolvable = true, resolveErr = '';
  for (const k of Object.keys(ACTS)) {
    try { ACTS[k](probeEl); } catch (e) { allResolvable = false; resolveErr = k + ': ' + e.message; break; }
  }
  check('ACTS 的动作逐个真调全部可达（引用未登记的函数名会当场报错）', allResolvable, resolveErr);

  /* click 分发真跑：dataset 参数真的到达动作函数 */
  const click = el => doc.listeners.click({ target: { closest: () => el } });
  const btn = (act, dataset) => ({
    dataset: dataset || {},
    getAttribute(k) { return k === 'data-act' || k === 'data-change' ? act : null; },
  });
  calls.length = 0;
  click(btn('open-channel', { id: 'ch-9' }));
  check('click 分发把 dataset.id 真的送进 openChannel',
    calls.length === 1 && calls[0][0] === 'openChannel' && calls[0][1] === 'ch-9', calls);
  calls.length = 0;
  click(btn('toggle-ch', { id: 'ch-9' }));          /* 渠道行里的停用开关：嵌套点击 */
  check('嵌套点击只触发最近那枚（行内按钮不冒泡去触发行/卡片自己的动作）',
    calls.length === 1 && calls[0][0] === 'toggleCh' && calls[0][1] === 'ch-9', calls);
  calls.length = 0;
  click(btn('unknown-act'));
  doc.listeners.click({ target: { closest: () => null } });
  check('未知动作与空白点击都静默不炸、不派发', calls.length === 0, calls);
  calls.length = 0;
  ACTS['open-test-models'](btn('open-test-models', { id: 'ch-2' }));
  ACTS['open-test-models'](btn('open-test-models'));
  check('openTestModels 的参数形状保留（有 id 带 channelId、无 id 给空对象）',
    calls.length === 2 && JSON.stringify(calls[0][1]) === '{"channelId":"ch-2"}' &&
    JSON.stringify(calls[1][1]) === '{}', calls);
  calls.length = 0;
  ACTS['open-channel-form'](btn('open-channel-form'));
  check('openChannelForm 无 id 时传 undefined（不拼字符串）',
    calls.length === 1 && calls[0][1] === undefined, calls);
  calls.length = 0;
  ACTS['test-row-model'](btn('test-row-model', { idx: '3' }));
  check('数值参数走 +dataset.idx（"3" 变回数字 3）',
    calls.length === 1 && calls[0][1] === 3 && typeof calls[0][1] === 'number', calls);

  /* change 分发真跑：导入文件框走同一条委托路 */
  calls.length = 0;
  const fileEl = btn('import-files', { kind: 'codex-json' });
  doc.listeners.change({ target: { closest: () => fileEl } });
  check('change 分发把 dataset.kind 与元素本体送进 importFiles',
    calls.length === 1 && calls[0][0] === 'importFiles' && calls[0][1] === 'codex-json' && calls[0][2] === fileEl, calls);

  /* 双向覆盖：模板用到的都注册过、注册过的都被模板用到（含 shell.html 的遮罩） */
  const all = src + SHELL;
  const used = new Set([].concat(
    [...all.matchAll(/data-act="([a-z-]+)"/g)].map(m => m[1]),
    [...all.matchAll(/data-change="([a-z-]+)"/g)].map(m => m[1])));
  const registered = new Set(Object.keys(ACTS));
  const missing = [...used].filter(k => !registered.has(k));
  const dead = [...registered].filter(k => !used.has(k));
  check('data-act/data-change 与 ACTS 双向一一对应（缺注册或死注册都算失败）',
    missing.length === 0 && dead.length === 0, { missing, dead });
}

/* ══ §13 数据统计页（v1.18.11）：渲染形状、空态、过滤、转义与封禁按钮 ══
   在最小 DOM 桩里真跑 vStats / openIpStats（现抠真实源码 + 真实 areaChart/sparkline）：
   零数据（stats=null / 刚重启清零）不抛且有空态文案；满数据画出 per-IP 表与 24 小时 sparkline；
   客户端过滤（从调用日志跳转的那条路）只留匹配行并显示清除按钮；
   UA 标签是外部可控值（服务端只截断不消毒）→ 模板必须 esc()；
   封禁/解封按钮真实存在且 data-t 带 IP（走 data-act 委托，绝不拼内联）。 */
function testStats() {
  G('13. 数据统计页（v1.18.11）：来源 IP 态势渲染 + 空态 + 过滤 + 转义');
  const stFilter = { client: '' };
  const mk = (st) => {
    const dom = makeDom();
    let drawerHtml = null;
    const api = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'fmtTs', 'sparkline', 'areaChart', 'drawer', 'stFilter', 'openIpStats',
      "let RAW=null, page='stats';\n" + extract('areaChart') + '\n' + extract('sparkline') + '\n' + extract('stClients') + '\n' + extract('openIpStats') + '\n' + extract('vStats') + '\nreturn { vStats, openIpStats };'
    )(dom.$, dom.$$, { stats: st }, esc, svg, nf,
      (t) => String(t).slice(0, 17),
      (v, w, h) => '<svg class="spark-stub"></svg>',
      (d, w, h) => '<svg class="area-stub"></svg>',
      (html) => { drawerHtml = html; return html; },
      stFilter, null);
    const v = mkEl('viewport');
    api.vStats(v);
    return {
      html: v.innerHTML,
      drawer: () => { api.openIpStats(((st && st.ips && st.ips[1]) || {}).ip); return drawerHtml; },
    };
  };
  const buckets = new Array(24).fill(0); buckets[10] = 7; buckets[23] = 3;
  const full = {
    global: { calls: 12, tokIn: 100, tokOut: 60, cur: 0, peak: 3, bannedHits: 2, activeIps: 2, since: 1700000000000 },
    ips: [
      { ip: '203.0.113.7', calls: 10, tokIn: 90, tokOut: 50, cur: 0, peak: 3, bannedHits: 2, banned: true, sessions: 5, sessSat: false, clients: [{ k: 'curl', n: 10 }], models: [{ k: 'm-a', n: 10 }], modelCount: 1, buckets: buckets.slice(), lastSeen: 1700000123000, since: 1700000000000 },
      { ip: '198.51.100.5', calls: 2, tokIn: 10, tokOut: 10, cur: 0, peak: 1, bannedHits: 0, banned: false, sessions: 512, sessSat: true, clients: [{ k: '<img>', n: 1 }, { k: 'curl', n: 1 }], models: [{ k: 'm-b', n: 2 }], modelCount: 1, buckets: buckets.slice(), lastSeen: 1700000123000, since: 1700000000000 },
    ],
    banned: ['203.0.113.7'],
    models: [{ k: 'm-a', n: 10 }, { k: 'm-b', n: 2 }],
    trustedProxy: '10.0.0.5',
    since: 1700000000000,
  };

  const n0 = mk(null);
  check('stats=null → 空态文案（旧版本网关，不抛）', n0.html.includes('统计端点不可达'));
  const e0 = mk({ global: { calls: 0, tokIn: 0, tokOut: 0, cur: 0, peak: 0, bannedHits: 0, activeIps: 0, since: Date.now() }, ips: [], banned: [], models: [], trustedProxy: '', since: Date.now() });
  check('刚重启清零 → 空态文案（内存态丢得起，不抛）', e0.html.includes('还没有任何客户端面流量'));

  const f = mk(full);
  check('满数据：两个来源各一行（含已封禁那个）', f.html.includes('203.0.113.7') && f.html.includes('198.51.100.5'));
  check('封禁行带「已封禁」标记 + 封禁命中小字', f.html.includes('已封禁') && f.html.includes('封禁命中 2'));
  check('会话饱和显示 ≥512（上限标记，不是裸数字）', f.html.includes('≥512'));
  check('反代采信模式显示 trustedProxy（直连时不显示）', f.html.includes('反代采信') && f.html.includes('10.0.0.5'));
  check('封禁名单卡带解封按钮（data-act + data-t，无内联）', f.html.includes('data-act="unban-ip" data-t="203.0.113.7"') && !/onclick=/.test(f.html));
  check('每行 24 小时 sparkline 真的画出来（现抠真函数遮蔽桩）', (f.html.match(/<svg/g) || []).length >= 2, (f.html.match(/<svg/g) || []).length);
  check('按模型聚合卡存在', f.html.includes('按模型'));

  stFilter.client = 'curl';
  const flt = mk(full);
  check('客户端过滤：只留匹配来源（curl 两个来源都在）', (flt.html.match(/cell-name/g) || []).length >= 2);
  stFilter.client = 'codex CLI';
  const flt2 = mk(full);
  check('客户端过滤：无匹配时空态并显示标签名（转义后）', flt2.html.includes('没有使用客户端') && flt2.html.includes('codex CLI'));
  stFilter.client = '';

  const raw = mk(full);
  check('UA 标签是外部可控值：模板 esc()（<img> 不裸插）', !raw.html.includes('<img>') && raw.html.includes('&lt;img&gt;'));
  const dh = raw.drawer();
  check('来源详情抽屉：24 小时分布 + 封禁按钮 data-t 带 IP（开的是未封禁行）',
    dh.includes('24 小时分布') && dh.includes('data-act="ban-ip" data-t="198.51.100.5"'), dh && dh.slice(0, 200));

  /* ── v1.18.13：调用日志客户端 chip → 跳数据统计 + 直接弹开最活跃来源的抽屉 ──
     用户报「跳过去之后不知道这个客户端属于哪个 IP」——现在点击后过滤 + 弹抽屉一步到位。
     另修一颗雷：旧绑定按 NodeList 索引对 rows 取标签——无标签的行不渲染 chip，索引错位，
     第 1 行无标签时点第 2 行的 chip 会套用第 1 行的空标签（过滤悄悄失效）。标签改从 chip 自带 data-cl 取。 */
  {
    const stFilterJump = { client: '' };
    let goPage = null, drawerIp = null, stopProp = false, logOpened = null;
    const DATAJ = {
      logs: [
        { t: '10-01 08:00', ts: Date.now(), id: 'r-1', n: '主渠道', m: 'm-x', c: 'ch-a', p: 'openai', ok: true, ms: 12, i: 1, o: 2, cl: '' },
        { t: '10-01 08:01', ts: Date.now(), id: 'r-2', n: '主渠道', m: 'm-x', c: 'ch-a', p: 'openai', ok: true, ms: 12, i: 1, o: 2, cl: 'codex CLI' },
        { t: '10-01 08:02', ts: Date.now(), id: 'r-3', n: '备用渠道', m: 'm-y', c: 'ch-b', p: 'openai', ok: true, ms: 12, i: 1, o: 2, cl: 'curl' },
      ],
      stats: { ips: [
        { ip: '203.0.113.7', calls: 10, clients: [{ k: 'codex CLI', n: 10 }] },
        { ip: '198.51.100.5', calls: 2, clients: [{ k: 'codex CLI', n: 2 }] },
      ] },
    };
    const box = mkEl('lgTable');
    let chips = [];
    const fnJump = new Function('$', '$$', 'DATA', 'esc', 'svg', 'nf', 'fMs', 'protoLabel', 'stFilter', 'stClients', 'openLog', 'go', 'openIpStats',
      "let lgRange='7d', lgCh='', lgOk='all', lgQ='';\n" + extract('logRows') + '\n' + extract('stClients') + '\n' + extract('drawLogTable') + '\nreturn drawLogTable;'
    )(() => box, (sel) => (sel.indexOf('.cell-client') >= 0 ? chips : []), DATAJ, esc, svg, nf, () => '12 ms', { openai: 'OpenAI' },
      stFilterJump, (r) => (r && r.clients) || [], (id) => { logOpened = id; }, (p) => { goPage = p; }, (ip) => { drawerIp = ip; });
    fnJump();
    check('★ 客户端 chip 自带 data-cl 属性（模板渲染，esc 过），只有标签行才有 chip',
      box.innerHTML.includes('data-cl="codex CLI"') && box.innerHTML.includes('data-cl="curl"'));
    /* 桩里模拟浏览器解析：data-cl 从渲染出的 HTML 解析回 dataset（真实浏览器由解析器完成），
       再跑一遍 drawLogTable 让绑定真的挂到这些 chip 上 */
    chips = [...box.innerHTML.matchAll(/data-cl="([^"]*)"/g)].map(m => ({ dataset: { cl: m[1] }, onclick: null }));
    check('★ 渲染出的 chip 数 = 有标签的行数（3 行日志只有 2 个 chip）', chips.length === 2, chips.length);
    fnJump();
    chips[0].onclick({ stopPropagation() { stopProp = true; } });
    check('★ 索引错位回归：第 1 行无标签，点第 2 行的 chip → 过滤词是 codex CLI 不是空（旧写法按 rows[i] 取到第 1 行的空标签）',
      stFilterJump.client === 'codex CLI', stFilterJump.client);
    check('★ 跳转 + 弹抽屉一步到位：go 到统计页，抽屉弹最活跃来源（两个来源共用该标签 → 弹敲门最多的 203.0.113.7）',
      goPage === 'stats' && drawerIp === '203.0.113.7', goPage + ' / ' + drawerIp);
    check('★ 行点击不被连坐：stopPropagation 生效，请求详情抽屉没开', stopProp === true && logOpened === null);
    drawerIp = null;
    chips[1].onclick({ stopPropagation() {} });
    check('★ 统计里没有该标签的来源时：只过滤不弹抽屉（不误开别的 IP）',
      stFilterJump.client === 'curl' && drawerIp === null);
    check('★ 源码守卫：绑定取 dataset 不按索引对 rows（防错位回潮）',
      src.includes("stFilter.client=el.dataset.cl||''") && !src.includes('stFilter.client=rows[i].cl'));
  }

  /* ── v1.18.12 布局整改守卫：KPI 居中 / 列宽定量 / 占位符居中 / 表头居中 ──
     用户确认的原型（_st_preview.html）落进生产代码后，用这些断言把它钉住，
     避免下次改渲染时又退回"内联字号 + auto 列宽 + 数值右对齐"的旧样子。 */
  check('★ KPI 四卡走 .st-kpi + .st-kpi-num（居中），不再内联 font-size:22px',
    (f.html.match(/class="card st-kpi"/g) || []).length === 4 &&
    (f.html.match(/class="mono st-kpi-num"/g) || []).length === 4 &&
    !f.html.includes('style="font-size:22px;font-weight:700"'));
  check('★ 来源明细表走 .st-fixed + 9 列 colgroup（定量列宽，替掉 auto 布局的挤/空失衡）',
    f.html.includes('class="tbl st-fixed"') && (f.html.match(/<col style="width:/g) || []).length === 9);
  check('★ 表头居中：数值列改 t-c（来源 IP/敲门/会话/峰值并发/Token/24 小时/最近）',
    ['来源 IP', '敲门', '会话', '峰值并发', 'Token 入/出', '24 小时', '最近']
      .every(h => f.html.includes('<th class="t-c">' + h + '</th>')));
  check('★ 数值单元格改 t-c，统计页旧的 t-r 已清零',
    f.html.includes('class="t-c mono"') && !f.html.includes('class="t-r mono"'));
  check('★ 分区标题走 .st-sec（与卡片 16px 对齐，不再贴边框）',
    (f.html.match(/class="sec-title st-sec"/g) || []).length === 2);
  check('★ 按模型表走 .st-models，次数/占比表头居中',
    f.html.includes('class="tbl st-models"') &&
    f.html.includes('<th class="t-c">次数</th>') && f.html.includes('<th class="t-c">占比</th>'));

  /* 占位符「—」自己居中，真实模型名/客户端标签仍左对齐 —— 这是本次整改的核心诉求 */
  const ph = mk({ global: full.global, ips: [
    { ip: '10.0.0.7', calls: 9, tokIn: 0, tokOut: 0, cur: 0, peak: 1, bannedHits: 9, banned: true,
      sessions: 512, sessSat: true, clients: [], models: [], modelCount: 0,
      buckets: buckets.slice(), lastSeen: 1700000123000, since: 1700000000000 },
  ], banned: ['10.0.0.7'], models: [], trustedProxy: '', since: 1700000000000 });
  check('★ 占位符「—」走 .t-c-ph（自己居中），真实名字不套（左对齐才好看）',
    ph.html.includes('class="muted t-c-ph">—</span>') &&
    !f.html.includes('t-c-ph') && f.html.includes('m-a') && f.html.includes('curl'));

  {
    const built = fs.readFileSync(path.join(__dirname, '..', 'console.html'), 'utf8');
    check('★ 产物里 .st-* 与 .t-c-ph 规则在（补在 extra.css）',
      built.includes('.st-kpi-num{') && built.includes('table.tbl.st-fixed{') &&
      built.includes('table.tbl.st-models th:first-child') &&
      built.includes('.st-sec{padding:0 16px}') && built.includes('.t-c-ph{display:block;text-align:center}'));
    check('★ 表头居中补了权重（与设计稿 .t-c 同款，否则输给表头基样式 text-align:left）',
      built.includes('table.tbl thead th.t-c{text-align:center}'));
    const legacy = f.html.replace(/class="card st-kpi"/g, 'class="card"').replace(/class="t-c mono"/g, 'class="t-r mono"');
    check('对照组：旧写法（无 st-kpi / 数值 t-r）不满足守卫 → 本用例抓得住',
      !legacy.includes('class="card st-kpi"') && legacy.includes('class="t-r mono"'));
  }
}

/* ── 装配：被测函数与状态声明必须真实存在于产品源码，否则直接报错 ── */
try {
  ['vModels', 'drawMTable', 'vPlayground', 'drawPG', 'drawRoute', 'adapt', 'drawChTable', 'saveChannel',
   'autoWeightCard', 'vAutoWeight', 'openChannel', 'vChannels', 'openTestModels', 'runTests',
   'chName', 'testRowVerdict', 'areaChart', 'sparkline', 'drawer',
   'vSettings', 'setCard', 'setHint', 'setPayload', 'setToggle', 'syncSettingsDraft', 'saveSettings',
   'vKeys', 'keyCard', 'toggleKeyReveal', 'rotateKey', 'resetKeysAction',
   'vStats', 'stClients', 'openIpStats', 'vLogs', 'drawLogTable', 'logRows'].forEach(extract);
  ["let mTab='all', mQ=''", "let pgDraft=''", 'id="f-weight"', 'let setDraft=null',
   "let keyDraft={gateway:'',admin:''}", "let stFilter={client:''}"].forEach(s => {
    if (!src.includes(s)) throw new Error('build/app.js 里找不到状态声明 / 关键标记 ' + s);
  });
  ['const ACTS={', "document.addEventListener('change'"].forEach(s => {
    if (!src.includes(s)) throw new Error('build/app.js 里找不到事件委托块标记 ' + s);
  });
} catch (e) {
  console.error('✗ 装配失败：' + e.message);
  process.exit(1);
}

/* ═══════════ 17. 错误显示统一口 errMsgOf + 登录门 trim（v1.18.17）═══════════
   公网部署 wurong.us.ci 实测抓到（用户报「拿到密钥还是提示 [object Object] 进不去控制台」）：
   ① 网关错误体是 {error:{message,type}}，api() 的错误 toast 与登录门的 errEl.textContent
     都直接拼 j.error——对象进字符串变 [object Object]，真实失败原因被吞；
   ② 登录门提交前只判非空不 trim，从终端 cat 复制的密钥带尾随换行/空格也被打成 401。
   errMsgOf 统一口：对象取 message、字符串透传、j.message 兜底、空体走回退文案。 */
function testGateErr() {
  G('17. errMsgOf 错误显示统一口 + 登录门 trim（v1.18.17 公网实测）');
  const m = src.match(/const errMsgOf=\(j,fb\)=>\{[^]*?\};/);
  check('errMsgOf 存在于 build/app.js', !!m);
  if (m) {
    const f = eval('(function(){' + m[0] + ' return errMsgOf;})()');
    check('对象错误取 message（不再 [object Object]）', f({ error: { message: '不对', type: 'bad_request' } }, '回退') === '不对');
    check('字符串 error 透传 / j.message 兜底 / 空体走回退', f({ error: '字符串型' }, '回退') === '字符串型' && f({ message: '顶层' }, '回退') === '顶层' && f(null, '回退') === '回退');
  }
  check('api() 的错误 toast 走 errMsgOf', src.includes("toast(errMsgOf(j,'HTTP '+r.status),'bad')"));
  check('登录门错误显示走 errMsgOf（旧裸拼模式全仓清零）', src.includes("errEl.textContent=errMsgOf(j,'密钥不对（HTTP '+r.status+'）')") && !src.includes('(j&&(j.error||j.message))'));
  check('登录门提交前 trim（终端 cat 复制带尾随空白不再 401）', src.includes('const k=input.value.trim();if(!k)return;'));
}

function testProbeTrim() {
  G('18. 「从上游探测」钥匙 trim（v1.18.19 现场教训：粘贴尾巴的换行发上游吃 401）');
  const m = src.match(/let key=\$\('#f-key'\)\.value\.trim\(\)/);
  check('probeUpstream 读取钥匙框时 .trim()（与保存路径 2198 对齐）', !!m);
  check('旧写法（未 trim 直接读）已清零', !src.includes("let key=$('#f-key').value;"));
  check('保存路径仍带 .trim()（两路对齐不回退）', src.includes("const key=$('#f-key').value.trim();"));
  const probe = src.match(/async function probeUpstream\(\)\{[^]*?\n\}/);
  check('probeUpstream 仍在（结构守卫，防误删）', !!probe);
}

function testKeyAutofill() {
  G('19. 密码框 autocomplete（v1.18.20 现场教训：浏览器把登录密钥自动填进渠道钥匙框）');
  check('渠道表单钥匙框带 autocomplete="new-password"（浏览器不再自动填入已存登录密钥）',
    src.includes('id="f-key" type="password" value="" autocomplete="new-password"'));
  check('登录门输入框带 autocomplete="new-password"（管理密钥不被浏览器收进密码库）',
    src.includes('id="zz-gate-input" type="password" autocomplete="new-password"'));
  const pw = (src.match(/type="password"/g) || []).length;
  const guarded = (src.match(/type="password"[^>]*autocomplete="new-password"/g) || []).length;
  check('全仓 password 框无一裸奔（每个都带 new-password）', pw === 2 && guarded === 2, { pw, guarded });
}

/* ══ §20 右上角全局搜索框已移除（v1.18.24） ══
   背景：那个框只做一件事——回车把关键词塞进 `chQ` 再跳渠道页，而渠道页自己就有筛选框、
   其它页各有各的搜索（现场报告 2026-10-07：它在各页都在，却总跳渠道管理，是重复入口）。
   v1.18.23 曾为它补过"清空对称"（当时的真 bug），用户拍板**整体移除**后该补丁一并作废。
   本节守的是"它真的没了、也没被换名字加回来"——比守它的行为更能防止回潮。 */
function testSearchClear() {
  G('20. 右上角全局搜索框已移除（v1.18.24：重复入口，删掉不回归）');
  const shell = fs.readFileSync(path.join(__dirname, '..', 'build', 'shell.html'), 'utf8');
  const out = fs.readFileSync(path.join(__dirname, '..', 'console.html'), 'utf8');
  const proto = fs.readFileSync(path.join(__dirname, '..', 'console-redesign.html'), 'utf8');
  check('build/shell.html 里不再有全局搜索框（#globalSearch / .search 顶栏容器）',
    !shell.includes('globalSearch') && !/class="search"/.test(shell));
  check('build/app.js 里不再有 syncGlobalSearch 与它的监听', !src.includes('syncGlobalSearch'));
  check('build/app.js 里没有 Ctrl/⌘+K 抢焦点到搜索框的代码',
    !/e\.key\.toLowerCase\(\)==='k'/.test(src) && !src.includes("$('#globalSearch')"));
  check('产物 console.html 里同样没有了（构建已生效）',
    !out.includes('globalSearch') && !/e\.key\.toLowerCase\(\)==='k'/.test(out));
  check('设计稿 console-redesign.html 同步移除（原型与产品一致）',
    !proto.includes('globalSearch') && !/e\.key\.toLowerCase\(\)==='k'/.test(proto));
  /* 渠道页自己的筛选框必须还在（它是唯一的渠道搜索入口） */
  check('渠道页筛选框仍在（左框是唯一渠道搜索入口，没被误删）',
    src.includes("$('#chQ',v).oninput=e=>{chQ=e.target.value;drawChTable()}"));
}

(async () => {
  testModels();
  testPlayground();
  await testWeight();
  await testDropParams();
  testAutoWeight();
  testDisabledTest();
  await testRunTests();
  testLogs();
  testControl();
  testEmptyData();
  await testSettings();
  await testKeys();
  testDelegation();
  testStats();
  testGateErr();
  testProbeTrim();
  testKeyAutofill();
  testSearchClear();
  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
