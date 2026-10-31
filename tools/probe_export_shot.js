'use strict';
/* 目视核对：三人局导出的「战报截图」与「GIF 的一帧」里，金营是不是真的金色。
 *
 * 用一个临时实例造一局三人对局（真语料真落子），开无头 Chromium 进房，
 * 调页面里的 OLEXport.canvas() / __draw.gifFrame() 得到 PNG，落到 shots/ 下。
 *
 *   NODE_PATH=... node tools/probe_export_shot.js
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PORT = 0, BASE = '', child = null;

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
    try { if ((await fetch(BASE + '/api/rooms')).ok) return true; } catch (_) {}
    await sleep(80);
  }
  return false;
}

async function post(p, b) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
  });
  return r.json();
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

const BLOB = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'clauses.txt.gz'))).toString('utf8');
function pickLine(chars, board, seed) {
  const need = new Set();
  for (let i = 0; i < chars.length; i++) if (board.charAt(i) === '0') need.add(chars.charAt(i));
  let p = 5000 + ((seed * 7919) % 20000000);
  for (let i = 0; i < 6000; i++) {
    const e = BLOB.indexOf('\n', p);
    if (e < 0) { p = 0; continue; }
    const ln = BLOB.slice(p, e);
    p = e + 1;
    if (ln.length < 5 || ln.length > 10) continue;
    let hit = 0;
    for (const ch of ln) if (need.has(ch)) hit++;
    if (hit >= 2) return ln;
  }
  return null;
}

(async () => {
  const dataDir = tmpDir('probe-export');
  for (let p = 9000; p < 9100; p++) if (await portFree(p)) { PORT = p; break; }
  BASE = 'http://127.0.0.1:' + PORT;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }), stdio: 'ignore',
  });
  if (!(await waitUp(12000))) throw new Error('服务起不来');

  /* 三人局：赤 / 青 / 金 各打几手，让三营都有格子、都有记录 */
  const c = await post('/api/create', { nick: '阿赤', size: 8, playerCount: 3 });
  const roomId = c.roomId;
  const tokens = { A: c.token };
  tokens.B = (await post('/api/join', { roomId, nick: '阿青' })).token;
  tokens.C = (await post('/api/join', { roomId, nick: '阿金' })).token;
  for (const s of ['A', 'B', 'C']) await post('/api/room/' + roomId + '/ready', { t: tokens[s], ready: true });

  let st = null;
  for (let i = 0; i < 9; i++) {
    const peek = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(tokens.A));
    st = (await peek.json()).state;
    if (!st || st.phase !== 'playing') break;
    const seat = st.turn;
    const line = pickLine(st.chars, st.board, i + 1);
    if (!line) break;
    const r = await post('/api/room/' + roomId + '/move', { t: tokens[seat], text: line });
    if (!r.ok) break;
    await sleep(60);
  }

  const port = 9600 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1400,1100', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(ROOT, 'shots', '.profile-export'), 'about:blank',
  ], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    try { await fetch('http://127.0.0.1:' + port + '/json/version'); up = true; } catch (_) {}
  }
  if (!up) { chrome.kill(); child.kill(); throw new Error('Chromium 起不来'); }

  const t = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res) => ws.on('open', res));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId, seat: 'A', token: tokens.A }))});}catch(e){}`,
  });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(3500);

  const shot = await send('Runtime.evaluate', {
    expression: `(function(){ var cv = window.OLEXport.canvas(); return cv.toDataURL('image/png'); })()`,
    returnByValue: true,
  });
  const shotPng = shot.result && shot.result.value;
  if (!shotPng || shotPng.indexOf('data:image/png') !== 0) throw new Error('截图没拿到：' + JSON.stringify(shot).slice(0, 300));
  const shotPath = path.join(ROOT, 'shots', 'export-3p-shot.png');
  fs.writeFileSync(shotPath, Buffer.from(shotPng.split(',')[1], 'base64'));

  /* GIF 的一帧：直接调内部绘制函数，取金营出手的那一帧 */
  const gif = await send('Runtime.evaluate', {
    expression: `(function(){
      var D = window.OLEXport.__draw, m = D.gifMetrics(), G = D.gifColors(), hs = D.gifHistory();
      var i = 0; for (var k = 0; k < hs.length; k++) if (hs[k].rec && hs[k].rec.team === 'C') i = k;
      var cv = document.createElement('canvas'); cv.width = m.PW; cv.height = m.PH;
      var ctx = cv.getContext('2d');
      D.gifFrame(ctx, m, hs[i], i, hs.length - 1, G);
      return cv.toDataURL('image/png');
    })()`,
    returnByValue: true,
  });
  const gifPng = gif.result && gif.result.value;
  if (!gifPng || gifPng.indexOf('data:image/png') !== 0) throw new Error('GIF 帧没拿到：' + JSON.stringify(gif).slice(0, 300));
  const gifPath = path.join(ROOT, 'shots', 'export-3p-gifframe.png');
  fs.writeFileSync(gifPath, Buffer.from(gifPng.split(',')[1], 'base64'));

  console.log('WROTE ' + shotPath);
  console.log('WROTE ' + gifPath);
  ws.close();
  chrome.kill();
  child.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  if (child) { try { child.kill(); } catch (_) {} }
  process.exit(1);
});
