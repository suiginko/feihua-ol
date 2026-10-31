'use strict';
/* 争议裁决条：谁能看到哪些按钮（用 jsdom 渲染真实的 index.html + app.js）。
 *
 * 背景（2026-10-22 的线上 bug）：多人模式重构时，renderDispute() 里
 *   const canControl = !!(S && S.canControl);
 * 被误删，于是 const canJudge = canControl && !byMe; 抛 ReferenceError ——
 * 整条裁决条不再往下渲染：
 *   · 提交方看不到「撤回提交」
 *   · 对手 / 裁判看不到「有效」「要求重填」
 *   · 而且 renderDispute 后面的成员 / 事件面板一起停更（界面上完全看不出根因）
 * 这个测试不碰画笔、不开浏览器，只做两件事：
 *   1) 用真实服务端状态调用真实的渲染函数，逐席位断言三个按钮的可见性；
 *   2) 断言 window.__renderErrors 为空 —— 任何面板抛异常都会被记下来。
 *
 *   node tools/test_dispute_ui.js
 *   node tools/test_dispute_ui.js --use=http://127.0.0.1:8799
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jsdom = null;
try { jsdom = require('jsdom'); } catch (_) { jsdom = null; }

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

let PORT = 0;
let BASE = '';
let dataDir = '';
let child = null;

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/rooms');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(80);
  }
  return false;
}

async function boot() {
  dataDir = tmpDir('dispute-ui');
  for (let p = 8900; p < 9000; p++) {
    if (await portFree(p)) { PORT = p; break; }
  }
  BASE = 'http://127.0.0.1:' + PORT;
  const env = Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir });
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (c) => {
    const s = c.toString();
    if (!s.includes('[snap]') && !s.includes('ExperimentalWarning')) process.stderr.write(s);
  });
  if (!(await waitUp(10000))) throw new Error('服务在 ' + PORT + ' 启动超时');
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function peekState(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  const d = await r.json().catch(() => ({}));
  return d.state || null;
}

/* ---------- 页面：真实的 index.html + app.js，禁掉网络，只做渲染 ---------- */
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const TAG = '<script src="app.js"></script>';
/* fetch 返回一个永不 settle 的 Promise：init() 会安静地挂在第一屏，
   一个请求都不会发出去 —— 测试要的是「拿状态直接喂给 applyState」。 */
const STUB = '<script>window.fetch=function(){return new Promise(function(){});};' +
  'window.EventSource=function(){this.readyState=0;};' +
  'window.EventSource.prototype.close=function(){};' +
  'window.EventSource.prototype.addEventListener=function(){};</script>';

if (HTML.indexOf(TAG) < 0) {
  console.error('!! index.html 里找不到 ' + TAG + '，本测试的内联方式需要同步更新');
  process.exit(1);
}
const PAGE = HTML.split(TAG).join(STUB + '<script>' + APP + '</scr' + 'ipt>');

function openPage() {
  const dom = new jsdom.JSDOM(PAGE, {
    url: 'http://127.0.0.1:' + (PORT || 8787) + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  return dom;
}

function shown(win, id) {
  const el = win.document.getElementById(id);
  return !!el && !el.classList.contains('hidden');
}

/* 把一个真实服务端状态渲染进页面，读回三件事：裁决条 / 三个按钮 / 文本 */
function render(win, state) {
  win.applyState(state);
  return {
    bar: shown(win, 'disputeBar'),
    valid: shown(win, 'btnValid'),
    retry: shown(win, 'btnRetry'),
    withdraw: shown(win, 'btnWithdraw'),
    btns: shown(win, 'disputeBtns'),
    text: win.document.getElementById('disputeText').textContent.replace(/\s+/g, ' ').trim(),
    errors: (win.__renderErrors || []).slice(),
  };
}

/* 提交一句语料里肯定没有的「诗」，触发争议 */
function fakeFor(st) {
  let b = '';
  if (st && st.chars && st.board) {
    for (let i = 0; i < st.chars.length; i++) {
      if (st.board.charAt(i) === '0') { b = st.chars.charAt(i); break; }
    }
  }
  return (b || '') + '编造完全不存在假诗句';
}

async function main() {
  if (!jsdom) {
    console.log('!! 没装 jsdom，跳过。要跑先设 NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules');
    process.exit(0);
  }
  const argUse = process.argv.find((a) => a.startsWith('--use='));
  if (argUse) BASE = argUse.split('=')[1];
  else await boot();

  /* ---------- 双人局：提交方 / 对手 / 裁判 / 普通观众 ---------- */
  const c = await post('/api/create', { nick: '甲', size: 10, playerCount: 2 });
  check('双人房创建成功', c.data.ok === true);
  const roomId = c.data.roomId;
  const tokA = c.data.token;
  const j = await post('/api/join', { roomId, nick: '乙' });
  const tokB = j.data.token;
  const w = await post('/api/join', { roomId, nick: '看客' });
  const tokW = w.data.token;
  const r2 = await post('/api/join', { roomId, nick: '判官' });
  const tokR = r2.data.token;

  await post('/api/room/' + roomId + '/ready', { t: tokA, ready: true });
  await post('/api/room/' + roomId + '/ready', { t: tokB, ready: true });

  /* 把「判官」设为裁判：需要他的 mid */
  const stA0 = await peekState(roomId, tokA);
  const refMid = (stA0.members || []).find((m) => m.nick === '判官');
  check('成员列表里有刚进来的观众', !!refMid);
  const setRef = await post('/api/room/' + roomId + '/ref', { t: tokA, mid: refMid && refMid.mid, on: true });
  check('设为裁判的接口返回 ok', setRef.data.ok === true);

  /* 无争议时：整条都不该出现，三个按钮也必须藏着 */
  const pageA = openPage();
  const pageB = openPage();
  const pageW = openPage();
  const pageR = openPage();
  const quiet = render(pageA.window, await peekState(roomId, tokA));
  check('无争议：裁决条不显示', quiet.bar === false);
  check('无争议：三个按钮全隐藏', !quiet.valid && !quiet.retry && !quiet.withdraw);

  /* A 提交假诗 → 争议 */
  const mv = await post('/api/room/' + roomId + '/move', { t: tokA, text: fakeFor(await peekState(roomId, tokA)) });
  check('假诗进入待裁决而不是直接判负', mv.data.code === 'dispute' || mv.data.pending === true, mv.data);

  const sA = await peekState(roomId, tokA);
  check('服务端确实挂了 dispute', !!(sA && sA.dispute && sA.dispute.by === 'A'), sA && sA.dispute);
  check('服务端认为 A 能掌流程（选手）', sA.canControl === true);
  check('服务端认为判官是裁判', (await peekState(roomId, tokR)).youRef === true);

  const a = render(pageA.window, sA);
  check('提交方（A）看得到裁决条', a.bar === true);
  check('提交方（A）看得到「撤回提交」', a.withdraw === true);
  check('提交方（A）看不到「有效 / 重填」', !a.valid && !a.retry, a);
  check('提交方文本提到「自己撤回」', a.text.indexOf('撤回') >= 0, a.text);

  const b = render(pageB.window, await peekState(roomId, tokB));
  check('对手（B）看得到「有效」「重填」', b.valid && b.retry, b);
  check('对手（B）看不到「撤回提交」', b.withdraw === false);
  check('对手（B）的按钮组整体可见', b.btns === true);

  const rr = render(pageR.window, await peekState(roomId, tokR));
  check('裁判看得到「有效」「重填」', rr.valid && rr.retry, rr);
  check('裁判不看得到「撤回提交」', rr.withdraw === false);
  check('裁判文本点明「你以裁判身份裁决」', rr.text.indexOf('裁判') >= 0, rr.text);

  const ww = render(pageW.window, await peekState(roomId, tokW));
  check('普通观众看得到裁决条（知道在等谁）', ww.bar === true);
  check('普通观众一个按钮都没有', !ww.valid && !ww.retry && !ww.withdraw, ww);
  check('普通观众文本写明「观众不能判定」', ww.text.indexOf('观众不能判定') >= 0, ww.text);

  /* 任何面板都不许抛异常 —— 这正是当初「按钮不出现且成员面板停更」的根因 */
  check('渲染过程零异常（提交方视角）', a.errors.length === 0, a.errors);
  check('渲染过程零异常（对手视角）', b.errors.length === 0, b.errors);
  check('渲染过程零异常（观众视角）', ww.errors.length === 0, ww.errors);
  check('渲染过程零异常（裁判视角）', rr.errors.length === 0, rr.errors);

  /* 成员面板确实刷新了（renderMembers 排在 renderDispute 之后） */
  const memTxt = pageB.window.document.getElementById('memList')
    ? pageB.window.document.getElementById('memList').textContent
    : '';
  check('成员面板在争议期间照常渲染', memTxt.indexOf('判官') >= 0, memTxt.slice(0, 80));

  /* 撤回后按钮归位 */
  const wd = await post('/api/room/' + roomId + '/dispute', { t: tokA, accept: false });
  check('提交方撤回成功', wd.data.ok === true && wd.data.cancelled === true, wd.data);
  const afterW = render(pageA.window, await peekState(roomId, tokA));
  check('撤回后裁决条收回', afterW.bar === false);
  check('撤回后三个按钮重新隐藏（不留残影）', !afterW.valid && !afterW.retry && !afterW.withdraw);

  /* 这次让对手裁决：争论条应当真正收掉 */
  const stNow = await peekState(roomId, tokA);
  const turnTok = stNow.turn === 'A' ? tokA : tokB;
  const oppTok = stNow.turn === 'A' ? tokB : tokA;
  await post('/api/room/' + roomId + '/move', { t: turnTok, text: fakeFor(stNow) + '之二' });
  const accept = await post('/api/room/' + roomId + '/dispute', { t: oppTok, accept: false });
  check('对手判「要求重填」成功', accept.data.ok === true && accept.data.rejected === true, accept.data);

  /* ---------- 三人局：第三位选手也能裁决 ---------- */
  const c3 = await post('/api/create', { nick: '三甲', size: 10, playerCount: 3 });
  const room3 = c3.data.roomId;
  const t3a = c3.data.token;
  const t3b = (await post('/api/join', { roomId: room3, nick: '三乙' })).data.token;
  const t3c = (await post('/api/join', { roomId: room3, nick: '三丙' })).data.token;
  await post('/api/room/' + room3 + '/ready', { t: t3a, ready: true });
  await post('/api/room/' + room3 + '/ready', { t: t3b, ready: true });
  await post('/api/room/' + room3 + '/ready', { t: t3c, ready: true });

  const s3a = await peekState(room3, t3a);
  check('三人局开局成功', s3a.phase === 'playing', s3a.phase);
  const m3 = await post('/api/room/' + room3 + '/move', { t: t3a, text: fakeFor(s3a) });
  check('三人局假诗进入待裁决', m3.data.code === 'dispute' || m3.data.pending === true, m3.data);

  const p3b = openPage();
  const p3c = openPage();
  const p3a = openPage();
  const v3b = render(p3b.window, await peekState(room3, t3b));
  const v3c = render(p3c.window, await peekState(room3, t3c));
  const v3a = render(p3a.window, await peekState(room3, t3a));
  check('三人局：另一位选手（B）能裁决', v3b.valid && v3b.retry, v3b);
  check('三人局：第三位选手（C）能裁决', v3c.valid && v3c.retry, v3c);
  check('三人局：提交方（A）只能撤回', v3a.withdraw === true && !v3a.valid, v3a);
  check('三人局：零渲染异常', v3a.errors.length + v3b.errors.length + v3c.errors.length === 0,
    v3a.errors.concat(v3b.errors, v3c.errors));

  /* ---------- 四人局：翠营席位同样能裁决 ---------- */
  const c4 = await post('/api/create', { nick: '四甲', size: 10, playerCount: 4 });
  const room4 = c4.data.roomId;
  const t4 = [c4.data.token];
  for (const n of ['四乙', '四丙', '四丁']) t4.push((await post('/api/join', { roomId: room4, nick: n })).data.token);
  for (const t of t4) await post('/api/room/' + room4 + '/ready', { t, ready: true });

  const s4 = await peekState(room4, t4[0]);
  check('四人局开局成功', s4.phase === 'playing', s4.phase);
  await post('/api/room/' + room4 + '/move', { t: t4[0], text: fakeFor(s4) });
  const p4d = openPage();
  const v4d = render(p4d.window, await peekState(room4, t4[3]));
  check('四人局：翠营（D）能裁决', v4d.valid && v4d.retry, v4d);
  check('四人局：零渲染异常', v4d.errors.length === 0, v4d.errors);

  /* ---------- 单人局：本来就没有争议裁决，按钮一律不给 ---------- */
  const cs = await post('/api/create', { nick: '独行', playerCount: 1, size: 8 });
  await post('/api/room/' + cs.data.roomId + '/ready', { t: cs.data.token, ready: true });
  const pSolo = openPage();
  const vSolo = render(pSolo.window, await peekState(cs.data.roomId, cs.data.token));
  check('单人局不出裁决条', vSolo.bar === false);
  check('单人局三个按钮全隐藏', !vSolo.valid && !vSolo.retry && !vSolo.withdraw);

  for (const p of [pageA, pageB, pageW, pageR, p3a, p3b, p3c, p4d, pSolo]) {
    try { p.window.close(); } catch (_) {}
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  if (child) { try { child.kill(); } catch (_) {} }
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
}

main().catch((e) => {
  console.error('ERR', e);
  if (child) { try { child.kill(); } catch (_) {} }
  process.exit(1);
});
