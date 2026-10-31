'use strict';
/* 开发者模式 —— 前端回归（jsdom，加载真实的 index.html + app.js）
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules node tools/test_dev_ui.js
 *
 * 看四件事：
 *   1) `?dev=<口令>` 被读进来之后立刻从地址栏抹掉，只留在 sessionStorage；
 *   2) 之后站内请求自动带 dev，但**分享链接绝不带**（roomLink / selfLink）——
 *      这一条最要紧：邀请链接会把当前 query 原样带出去，留着就等于把口令发给对手；
 *   3) 大厅里私密房有「私密」标、5 位房号不会被 44px 的固定宽度压出格子；
 *   4) 隐形观战时观众条写清楚「别人看不到你」，而且不给「坐下」按钮。
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

function boot(url) {
  /* 用 split/join 而不是 replace(str, str)：app.js 里有 '$&' 这类字符串，
     replace 的第二参数会把 $& 展开成匹配到的整段（见 AGENTS.md 陷阱）。 */
  const TAG = '<script src="app.js"></script>';
  if (HTML.indexOf(TAG) < 0) throw new Error('index.html 里找不到 ' + TAG);
  const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
  return new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
}

const KEY = 'dev-key-ui-1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  /* ---------- 1) 带口令进来 ---------- */
  const dom = boot('http://127.0.0.1:8787/?dev=' + KEY + '&sharecode=MZA5YPLHV3');
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);

  check('带口令时 DEV.on 为真', w.eval('DEV.on') === true, w.eval('DEV.on'));
  check('口令立刻从地址栏抹掉', !/dev=/.test(w.location.search), w.location.search);
  check('sharecode 等其他参数保留', /sharecode=MZA5YPLHV3/.test(w.location.search), w.location.search);
  check('口令留在 sessionStorage 里（刷新后仍然有效）',
    w.sessionStorage.getItem('feihua-dev') === KEY, w.sessionStorage.getItem('feihua-dev'));
  check('站内请求自动带上 dev',
    w.eval("DEV.url('/api/rooms')") === '/api/rooms?dev=' + KEY, w.eval("DEV.url('/api/rooms')"));
  check('已有 query 的 URL 用 & 接',
    w.eval("DEV.url('/api/room/1/peek?t=abc')") === '/api/room/1/peek?t=abc&dev=' + KEY,
    w.eval("DEV.url('/api/room/1/peek?t=abc')"));

  /* 分享链接绝不能带口令 */
  const link = w.roomLink('ABCD');
  check('邀请链接里没有 dev 口令', !/dev=/.test(link), link);
  check('邀请链接仍然是「房号 + sharecode」', link === 'http://127.0.0.1:8787/?r=ABCD&sharecode=MZA5YPLHV3', link);
  const self = w.selfLink();
  check('返回大厅的链接里没有 dev 口令', !/dev=/.test(self), self);

  /* 第二道保险：哪怕地址栏里还残留着 dev（别的代码手动改过 URL、或抹除失败），
     分享链接也必须干净 —— 这条专门锁 accessQuery() 里那句 q.delete('dev')。 */
  w.history.replaceState(null, '', '/?dev=' + KEY + '&sharecode=MZA5YPLHV3');
  const leak = w.roomLink('ABCD');
  check('地址栏残留 dev 时，邀请链接依然不带口令', !/dev=/.test(leak), leak);
  w.history.replaceState(null, '', '/?sharecode=MZA5YPLHV3');

  /* ---------- 2) 入房 / 大厅请求都走同一个包装 ---------- */
  let seenUrl = '';
  w.fetch = async (u) => { seenUrl = u; return { ok: true, json: async () => ({}) }; };
  await w.post('/api/join', { roomId: '000' });
  check('入房请求带上了 dev（否则就不是隐形观众）', seenUrl === '/api/join?dev=' + KEY, seenUrl);

  /* ---------- 3) 大厅：私密房渲染 ---------- */
  $('lobby').classList.remove('hidden');
  w.fetch = async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      rooms: [
        { id: 'ABCDE', isPrivate: true, host: '私密房主', playerCount: 2, size: 10, rounds: 20,
          turnSeconds: 120, kinds: '诗', extra: 0, phase: 'waiting', joinable: true, ready: {},
          players: { A: '私密房主', B: null }, watchers: 0 },
        { id: '007', host: '公开房主', playerCount: 2, size: 10, rounds: 20,
          turnSeconds: 120, kinds: '诗', extra: 0, phase: 'playing', joinable: false, ready: { A: true, B: true },
          score: { a: 3, b: 2 }, players: { A: '公开房主', B: '对手' }, watchers: 2 },
      ],
      total: 2,
    }),
  });
  await w.loadRooms();
  await sleep(10);
  const listHtml = $('roomList').innerHTML;
  check('大厅里私密房带「私密」标', /class="rpriv">私密</.test(listHtml), listHtml.slice(0, 160));
  check('5 位房号用 wide 样式（不再被 44px 挤掉）', /class="rcode wide">ABCDE</.test(listHtml), listHtml.slice(0, 160));
  check('3 位房号不加 wide', /class="rcode">007</.test(listHtml), listHtml.slice(0, 200));
  check('开发者提示条出现', /class="devnote"/.test(listHtml));
  check('提示条说明了「进房是隐形的」', /隐形观战/.test(listHtml));

  /* ---------- 3) 隐形观战的观众条 ---------- */
  w.eval("S = { you: null, youHidden: true, cfg: { playerCount: 2 }, watchers: 0, seats: { A: { nick: '甲' }, B: null } };");
  w.renderWatch();
  check('隐形观战时观众条写明「别人看不到你」', /别人看不到你/.test($('watchHint').textContent), $('watchHint').textContent);
  check('隐形观战时没有「坐下」按钮', ['btnSeatA', 'btnSeatB', 'btnSeatC', 'btnSeatD']
    .every((id) => !$(id) || $(id).classList.contains('hidden')),
    ['btnSeatA', 'btnSeatB'].map((id) => $(id) && $(id).className));

  /* ---------- 4) 反向：普通观众仍有「坐下」入口 ---------- */
  w.eval("S = { you: null, youHidden: false, cfg: { playerCount: 2 }, watchers: 0, seats: { A: { nick: '甲' }, B: null } };");
  w.renderWatch();
  check('普通观众的观众条不带「隐形」字样', !/别人看不到你/.test($('watchHint').textContent), $('watchHint').textContent);
  check('普通观众仍然能坐下', !$('btnSeatB').classList.contains('hidden'), $('btnSeatB').className);

  /* ---------- 5) 「关闭开发者模式」开关 ---------- */
  const offBtn = w.document.getElementById('btnDevOff');
  check('大厅提示条里有「关闭开发者模式」按钮', !!offBtn, offBtn && offBtn.className);
  if (offBtn) offBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  check('点关闭后 sessionStorage 里的口令被清掉', !w.sessionStorage.getItem('feihua-dev'),
    w.sessionStorage.getItem('feihua-dev'));
  check('点关闭后 DEV.on 变回 false', w.eval('DEV.on') === false, w.eval('DEV.on'));
  check('关闭后请求不再带 dev', w.eval("DEV.url('/api/rooms')") === '/api/rooms', w.eval("DEV.url('/api/rooms')"));
  w.close();

  /* ---------- 5) 不带口令进来：一切照旧 ---------- */
  const dom2 = boot('http://127.0.0.1:8787/?sharecode=MZA5YPLHV3');
  const w2 = dom2.window;
  check('不带口令时 DEV.on 为假', w2.eval('DEV.on') === false, w2.eval('DEV.on'));
  check('不带口令时请求不额外加参数', w2.eval("DEV.url('/api/rooms')") === '/api/rooms', w2.eval("DEV.url('/api/rooms')"));
  check('地址栏原样不动', w2.location.search === '?sharecode=MZA5YPLHV3', w2.location.search);
  w2.close();

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})();
