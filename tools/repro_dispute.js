'use strict';
/* 复现「待裁决 / 撤回」按钮显示问题：两个真实标签页同时开着，观察状态迁移。
   用法：先 node server.js，再 NODE_PATH=... node tools/repro_dispute.js */

const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
  return r.json();
};
async function state(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return (await r.json()).state;
}

function cdp(ws) {
  let id = 0;
  const waiters = new Map();
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && waiters.has(m.id)) {
      const { resolve, reject } = waiters.get(m.id);
      waiters.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    waiters.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
}

async function newTab(port, sess) {
  const r = await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' });
  const t = await r.json();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res) => ws.on('open', res));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify(sess))});}catch(e){}`,
  });
  await send('Page.navigate', { url: BASE + '/' });
  return { send, ws, id: t.id };
}

async function evalJs(tab, expr) {
  const r = await tab.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r.result && r.result.value;
}

const READ = `JSON.stringify({
  disputeBar: !document.getElementById('disputeBar').classList.contains('hidden'),
  valid: !document.getElementById('btnValid').classList.contains('hidden'),
  retry: !document.getElementById('btnRetry').classList.contains('hidden'),
  withdraw: !document.getElementById('btnWithdraw').classList.contains('hidden'),
  btns: !document.getElementById('disputeBtns').classList.contains('hidden'),
  text: document.getElementById('disputeText').textContent.slice(0, 46),
  you: (window.ME&&ME.seat)||null
})`;

(async () => {
  const port = 9500 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(__dirname, '..', 'shots', '.profile-r'),
    'about:blank',
  ], { stdio: 'ignore' });

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(250);
    try { await fetch('http://127.0.0.1:' + port + '/json/version'); ok = true; } catch (_) {}
  }
  if (!ok) { console.log('!! Chromium 起不来'); chrome.kill(); process.exit(1); }

  const c = await api('/api/create', { size: 10, nick: '甲' });
  const j = await api('/api/join', { roomId: c.roomId, nick: '乙' });
  await api('/api/room/' + c.roomId + '/ready', { t: c.token, ready: true });
  await api('/api/room/' + c.roomId + '/ready', { t: j.token, ready: true });

  const tabA = await newTab(port, { roomId: c.roomId, seat: 'A', token: c.token });
  const tabB = await newTab(port, { roomId: c.roomId, seat: 'B', token: j.token });
  const tabW = await newTab(port, { roomId: c.roomId, seat: null, token: (await api('/api/join', { roomId: c.roomId, nick: '看客' })).token });
  await sleep(2500);

  console.log('— 开局后（无争议）');
  for (const [n, t] of [['A', tabA], ['B', tabB], ['观众', tabW]]) console.log('  ' + n + '  ' + await evalJs(t, READ));

  const mv = await api('/api/room/' + c.roomId + '/move', { t: c.token, text: '我编了一句根本不存在的诗啊' });
  console.log('\n— A 提交假诗 →', mv.code);
  await sleep(1200);
  for (const [n, t] of [['A', tabA], ['B', tabB], ['观众', tabW]]) console.log('  ' + n + '  ' + await evalJs(t, READ));

  const wd = await api('/api/room/' + c.roomId + '/dispute', { t: c.token, accept: false });
  console.log('\n— A 撤回 →', JSON.stringify(wd));
  await sleep(1200);
  for (const [n, t] of [['A', tabA], ['B', tabB], ['观众', tabW]]) console.log('  ' + n + '  ' + await evalJs(t, READ));

  /* 再走一次：这次由 B 裁决「要求重填」，看双方按钮是否归位 */
  const st = await state(c.roomId, c.token);
  const tokNow = st.turn === 'A' ? c.token : j.token;
  const tokOpp = st.turn === 'A' ? j.token : c.token;
  await api('/api/room/' + c.roomId + '/move', { t: tokNow, text: '再编一句同样不存在的诗句' });
  await sleep(1000);
  const rej = await api('/api/room/' + c.roomId + '/dispute', { t: tokOpp, accept: false });
  console.log('\n— 对手点「要求重填」→', JSON.stringify(rej));
  await sleep(1200);
  for (const [n, t] of [['A', tabA], ['B', tabB], ['观众', tabW]]) console.log('  ' + n + '  ' + await evalJs(t, READ));

  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
