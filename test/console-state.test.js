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

/* ═══════ 5. 对照组：证明本测试抓得住「没有回填」的旧写法（防恒真） ═══════ */
function testControl() {
  G('5. 对照组（用整改前的写法跑同样断言，必须失败）');
  const v = mkEl('viewport');
  v.innerHTML = '<div class="search"><input id="mQ" placeholder="搜索模型名…"></div>';   /* 整改前的模板 */
  const rendered = (v.innerHTML.match(/id="mQ"[^>]*value="([^"]*)"/) || [])[1];
  check('旧写法（无 value= 回填）重绘后取不到搜索词 → 测试具备捕捉能力', rendered === undefined);
}

/* ── 装配：被测函数与状态声明必须真实存在于产品源码，否则直接报错 ── */
try {
  ['vModels', 'drawMTable', 'vPlayground', 'drawPG', 'drawRoute', 'adapt', 'drawChTable', 'saveChannel',
   'autoWeightCard', 'vAutoWeight', 'openChannel', 'vChannels'].forEach(extract);
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
  testAutoWeight();
  testControl();

  console.log('\n' + '─'.repeat(58));
  console.log(fail ? `✗ ${pass} 通过 / ${fail} 失败` : `✓ 全部通过（${pass} 项断言）`);
  process.exit(fail ? 1 : 0);
})();
