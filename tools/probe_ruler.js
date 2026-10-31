'use strict';
/* 探针：三处文案改动的视觉核对。
 *  1) referee-log —— 裁判判「有效」的落子，飞花记录里写的是「裁判 XX 裁定有效」而不是「对方裁定有效」
 *  2) lobby-hint  —— 大厅「当前房间」标题右侧不再有「两边都点「准备好了」才开局」
 *  3) seat-label  —— 观众补位按钮写「坐到赤营 / 坐到青营」
 *
 * 用法：先 node server.js，再 node tools/probe_ruler.js */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}
async function state(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return (await r.json()).state;
}

/* 造一个「人工判有效」的现场：甲 vs 乙，甲先飞一句语料查不到的句子，
   withRef=true 时再拉丙当裁判、由丙判有效；withRef=false 时由对手乙判有效。 */
async function setup(withRef) {
  const a = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20 });
  const b = await api('/api/join', { roomId: a.roomId, nick: '小满' });
  let w = null;
  if (withRef) {
    w = await api('/api/join', { roomId: a.roomId, nick: '老周' });
    const st0 = await state(a.roomId, a.token);
    const midW = (st0.members.find((m) => m.nick === '老周') || {}).mid;
    await api('/api/room/' + a.roomId + '/ref', { t: a.token, mid: midW, on: true });
  }
  await api('/api/room/' + a.roomId + '/ready', { t: a.token, ready: true });
  await api('/api/room/' + a.roomId + '/ready', { t: b.token, ready: true });
  let st = await state(a.roomId, a.token);

  const mover = st.turn === 'A' ? a : b;
  const judge = withRef ? w : (st.turn === 'A' ? b : a);
  /* 取一个空格上的字 + 生僻字，保证语料里查不到、棋盘上又有字 */
  let blank = '';
  for (let i = 0; i < st.chars.length; i++) if (st.board.charAt(i) === '0') { blank = st.chars.charAt(i); break; }
  const fake = blank + '魑魅魍魉';
  const mv = await api('/api/room/' + a.roomId + '/move', { t: mover.token, text: fake });
  if (mv.code !== 'dispute') throw new Error('没能造出争议：' + JSON.stringify(mv));
  const yes = await api('/api/room/' + a.roomId + '/dispute', { t: judge.token, accept: true });
  if (!yes.accepted) throw new Error('裁决失败：' + JSON.stringify(yes));
  st = await state(a.roomId, a.token);
  const entry = (st.log || []).filter((e) => e.via === 'manual').pop();
  return { roomId: a.roomId, tokenA: a.token, moverSeat: st.turn === 'A' ? 'B' : 'A', moverTok: mover.token, entry, fake };
}

function cdp(ws) {
  let id = 0;
  const waiters = new Map();
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    if (msg.id && waiters.has(msg.id)) {
      const { resolve, reject } = waiters.get(msg.id);
      waiters.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    waiters.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
}

(async () => {
  const g = await setup(true);
  console.log('裁定记录自带：ruler=' + JSON.stringify(g.entry.ruler) + ' via=' + g.entry.via);

  const port = 9700 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(OUT, '.profile-ruler'), 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(250);
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((x) => x.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (_) {}
  }
  if (!wsUrl) { console.log('!! 连不上 Chromium'); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  const errors = [];
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
  });

  let seedId = null;
  async function shot(name, setupSrc, needGame) {
    if (seedId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedId }); seedId = null; }
    if (setupSrc) {
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: setupSrc });
      seedId = r.identifier;
    }
    await send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ready: document.readyState, playing: !document.getElementById('game').classList.contains('hidden')})`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value || '{}');
      if (v.ready === 'complete' && (!needGame || v.playing)) break;
    }
    await sleep(600);
    const data = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.data, 'base64'));
  }
  async function text(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result ? String(r.result.value == null ? '' : r.result.value) : '';
  }

  const sess = JSON.stringify({ roomId: g.roomId, seat: g.moverSeat, token: g.moverTok });

  /* 1) 飞花记录里的裁定来源 */
  await shot('ruler-log', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`, true);
  console.log('飞花记录首条来源：' + await text(`(document.querySelector('#logList li .src')||{}).textContent||'(无)'`));
  console.log('飞花记录首条句子：' + await text(`(document.querySelector('#logList li .line')||{}).textContent||''`));
  console.log('事件记录尾部：' + await text(`JSON.stringify([...document.querySelectorAll('#evList li, #eventList li')].slice(-3).map(li=>li.textContent.trim()))`));

  /* 2) 大厅标题右侧不再有准备提示 */
  await shot('lobby-hint', `try{sessionStorage.clear();}catch(e){}`, false);
  console.log('当前房间标题：' + await text(`JSON.stringify({
    title: (document.querySelector('.sec-title')||{}).textContent||'',
    hint: (document.querySelector('.sec-title .hint')||{}).textContent||'(无 hint)',
    hasReadyHint: document.body.textContent.includes('两边都点')
  })`));

  /* 3) 观众补位按钮文案 */
  const w2 = await api('/api/join', { roomId: g.roomId, nick: '看客' });
  await shot('seat-label', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: g.roomId, seat: null, token: w2.token }))});}catch(e){}`, true);
  console.log('补位按钮：' + await text(`JSON.stringify({
    seatA: (document.getElementById('btnSeatA')||{}).textContent||'',
    seatB: (document.getElementById('btnSeatB')||{}).textContent||'',
    watchHint: (document.getElementById('watchHint')||{}).textContent||''
  })`));

  /* 4) 导出图里同样要写「裁判 XX 裁定有效」而不是「对方裁定有效」
     —— 拦掉真实下载，只记录 canvas 上画出来的文字 */
  await shot('ruler-log', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`, true);
  await send('Runtime.evaluate', {
    expression: `(() => {
      window.__txt = [];
      const orig = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (t) { try { window.__txt.push(String(t)); } catch (e) {} return orig.apply(this, arguments); };
      HTMLAnchorElement.prototype.click = function () { window.__dl = this.download || this.href; };
      if (window.OLEXport && window.OLEXport.shot) window.OLEXport.shot();
    })()`,
    returnByValue: true,
  });
  await sleep(4000);
  console.log('导出图里的裁定文案：' + await text(`JSON.stringify((window.__txt||[]).filter(t=>/裁定有效/.test(t)))`));
  console.log('导出下载是否被拦下：' + await text(`String(window.__dl||'')`));

  /* 5) 对照组：对手判的仍然写「对方裁定有效」，别把两种情况混成一句 */
  const g2 = await setup(false);
  console.log('对手裁定记录：ruler=' + JSON.stringify(g2.entry.ruler));
  const sess2 = JSON.stringify({ roomId: g2.roomId, seat: g2.moverSeat, token: g2.moverTok });
  await shot('ruler-log-opp', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess2)});}catch(e){}`, true);
  console.log('对手裁定的记录文案：' + await text(`(document.querySelector('#logList li .src')||{}).textContent||'(无)'`));

  if (errors.length) console.log('!! 页面报错：' + errors.slice(0, 3).join(' | '));
  else console.log('页面无 JS 报错');
  chrome.kill();
})();
