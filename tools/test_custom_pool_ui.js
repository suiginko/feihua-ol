'use strict';
/* 自定义字库 + 单格重随 —— 前端回归（jsdom，加载真实的 index.html + app.js）
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules node tools/test_custom_pool_ui.js
 *
 * 服务端那条（test_custom_pool.js）证明「数据对」，这条证明「点了真的会发请求、界面对」：
 *   1) 开局前、有权限 → 每格都带 pickable，提示条露出来，按钮可用；
 *   2) 点第 6 格 → POST /reroll，index=5（不是 6，也不是 undefined）；
 *   3) 无权限 / 已开局 → 格子不带 pickable，点了**一个请求都不发**；
 *   4) 字库弹窗：识别字数提示、留空提示「撤下」、应用时把原文按原样交出去
 *      （归一化在服务端做，前端只负责把原文老实传过去）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? ''
      : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

const TAG = '<script src="app.js"></script>';
function boot() {
  if (HTML.indexOf(TAG) < 0) throw new Error('index.html 里找不到 ' + TAG);
  /* split/join 而不是 replace(str, str)：app.js 里有 '$&' 这类字面量 */
  const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
  return new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'dangerously', pretendToBeVisual: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 100 个互不相同的汉字当盘面 */
const CHARS = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');

function state(over) {
  return Object.assign({
    id: 'ABC12', phase: 'waiting', size: 10,
    chars: CHARS, board: '0'.repeat(100),
    cfg: { size: 10, extra: 0, rounds: 20, playerCount: 2, turnSeconds: 120, maxPoemLen: 17, kinds: { 诗: true } },
    turn: 'A', turnNo: 1, round: 1, rounds: 20,
    score: { a: 0, b: 0, c: 0, d: 0, n: 100 },
    log: [], events: [], seats: { A: { nick: '甲', online: true, mid: 'mA' }, B: { nick: '乙', online: true, mid: 'mB' } },
    you: 'A', role: 'player', youNick: '甲', youMid: 'mA',
    refs: [], youRef: false, canControl: true,
    cfgEditable: true, pool: { count: 0, preview: '', by: '' }, canPickCells: true,
    members: [], watchers: [], watcherNicks: [], isPrivate: false, youHidden: false,
    deadline: 0, serverNow: Date.now(), reason: '', req: null, canUndo: false,
    ready: { A: false, B: false, C: false, D: false }, paused: null, dispute: null,
    poolInfo: null,
  }, over || {});
}

(async () => {
  const dom = boot();
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);

  /* 请求全部截下来，一个都不许真发 */
  const calls = [];
  w.fetch = async (url, opt) => {
    calls.push({ url: url, body: opt && opt.body ? JSON.parse(opt.body) : null });
    return { ok: true, json: async () => ({ ok: true, ch: '甲', index: 5, pool: { count: 12 } }) };
  };

  function mount(over) {
    w.eval('S = ' + JSON.stringify(state(over)) + ';');
    w.eval('ME = { roomId: "ABC12", token: "tk-1" };');
    w.eval('renderBoard(); renderPool();');
  }

  /* ---------- 1) 开局前有权限 ---------- */
  console.log('--- 开局前（选手） ---');
  mount({});
  check('棋盘铺出 100 格', w.document.querySelectorAll('#board .cell').length === 100,
    w.document.querySelectorAll('#board .cell').length);
  check('每格都带 pickable（点得动）',
    w.document.querySelectorAll('#board .cell.pickable').length === 100,
    w.document.querySelectorAll('#board .cell.pickable').length);
  check('「点格子换字」提示条露出来', !$('pickHint').classList.contains('hidden'));
  check('字库按钮可用', $('btnOpenPool').disabled === false);
  check('没字库时不显示「撤下」', $('btnClearPool').classList.contains('hidden'));
  check('状态写「系统字库」', $('poolStat').textContent === '系统字库', $('poolStat').textContent);

  /* ---------- 2) 点第 6 格 ---------- */
  console.log('--- 点格子 ---');
  calls.length = 0;
  w.document.querySelectorAll('#board .cell')[5].click();
  await sleep(30);
  check('点格子发出了一个请求', calls.length === 1, calls.length);
  check('请求打到 /reroll', calls[0] && calls[0].url === '/api/room/ABC12/reroll', calls[0] && calls[0].url);
  check('index 是 5（第 6 格，别差一）', calls[0] && calls[0].body && calls[0].body.index === 5,
    calls[0] && calls[0].body);
  check('带了 token', calls[0] && calls[0].body && calls[0].body.t === 'tk-1', calls[0] && calls[0].body);
  check('换完那一格的字变了', w.eval('S.chars.charAt(5)') === '甲', w.eval('S.chars.charAt(5)'));

  /* ---------- 3) 已开局 / 无权限 ---------- */
  console.log('--- 只读与开局后 ---');
  mount({ canPickCells: false });
  check('无权限时格子不带 pickable',
    w.document.querySelectorAll('#board .cell.pickable').length === 0,
    w.document.querySelectorAll('#board .cell.pickable').length);
  check('无权限时提示条藏起来', $('pickHint').classList.contains('hidden'));
  check('无权限时字库按钮禁用', $('btnOpenPool').disabled === true);
  calls.length = 0;
  w.document.querySelectorAll('#board .cell')[3].click();
  await sleep(30);
  check('无权限时点格子一个请求都不发', calls.length === 0, calls.length);

  mount({ phase: 'playing', canPickCells: false, board: 'A'.repeat(100) });
  check('对局中格子不可点',
    w.document.querySelectorAll('#board .cell.pickable').length === 0);
  calls.length = 0;
  w.document.querySelectorAll('#board .cell')[7].click();
  await sleep(30);
  check('对局中点格子也不发请求', calls.length === 0, calls.length);

  /* ---------- 4) 有字库时的状态文字 ---------- */
  console.log('--- 已设字库 ---');
  mount({ pool: { count: 30, preview: '东风不来三月的柳絮不飞', by: '甲' } });
  const stat = $('poolStat').textContent;
  check('状态显示自定义 30 字', /自定义\s*30\s*字/.test(stat), stat);
  check('不够铺满时说明「格由系统补」', /70\s*格由系统补/.test(stat), stat);
  check('有字库时「撤下」露出来', !$('btnClearPool').classList.contains('hidden'));
  check('缩略放进了 title（不挤版面）', /东风不来/.test($('poolStat').title), $('poolStat').title);

  mount({ pool: { count: 100, preview: '东风', by: '甲' } });
  check('字库够铺满时不提「由系统补」', !/由系统补/.test($('poolStat').textContent), $('poolStat').textContent);

  /* ---------- 5) 字库弹窗 ---------- */
  console.log('--- 字库弹窗 ---');
  mount({});
  w.eval('openPoolModal()');
  check('弹窗打开了', !$('poolOverlay').classList.contains('hidden'));
  check('打开时文本框是空的', $('poolText').value === '');
  check('空文本提示「撤下」', /留空保存 = 撤下/.test($('poolMeta').textContent), $('poolMeta').textContent);

  $('poolText').value = '东风不来，三月的柳絮不飞。你的心如小小的寂寞的城。';
  $('poolText').dispatchEvent(new w.Event('input', { bubbles: true }));
  const meta = $('poolMeta').textContent;
  check('识别出 17 个不同的汉字', /识别到\s*17\s*个不同的汉字/.test(meta), meta);
  check('说明棋盘 100 格', /棋盘\s*100\s*格/.test(meta), meta);
  check('说明还差多少格由系统补', /还差\s*83\s*格/.test(meta), meta);

  $('poolText').value = 'abc 123 !!!';
  $('poolText').dispatchEvent(new w.Event('input', { bubbles: true }));
  check('纯英文数字 → 提示没有汉字', /没有汉字/.test($('poolMeta').textContent), $('poolMeta').textContent);

  /* 应用：前端把原文原样交出去，归一化交给服务端 */
  calls.length = 0;
  $('poolText').value = '東風夜放花千樹';
  $('btnApplyPool').click();
  await sleep(40);
  check('应用字库发出了请求', calls.length === 1, calls.length);
  check('请求打到 /pool', calls[0] && calls[0].url === '/api/room/ABC12/pool', calls[0] && calls[0].url);
  check('交的是原文（不在这里做归一化）',
    calls[0] && calls[0].body && calls[0].body.text === '東風夜放花千樹', calls[0] && calls[0].body);
  check('应用成功后弹窗关闭', $('poolOverlay').classList.contains('hidden'));

  /* ---------- 6) 撤下 ---------- */
  console.log('--- 撤下 ---');
  mount({ pool: { count: 12, preview: '春江花月夜', by: '甲' } });
  calls.length = 0;
  $('btnClearPool').click();
  await sleep(40);
  check('撤下发了一个请求', calls.length === 1, calls.length);
  check('撤下交的是空文本', calls[0] && calls[0].body && calls[0].body.text === '', calls[0] && calls[0].body);

  /* ---------- 7) 点遮罩关闭 ---------- */
  mount({});
  w.eval('openPoolModal()');
  const ov = $('poolOverlay');
  ov.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('点遮罩能关掉弹窗', ov.classList.contains('hidden'));

  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
