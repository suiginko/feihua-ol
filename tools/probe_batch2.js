'use strict';
/* 探针：本批改动的视觉与交互核对。
 *  1) lobby   —— 房间条目带「文体 · 额外字」；缺席一方是灰色「空位」；「语料规模」整段消失；有「反馈」入口
 *  2) game    —— 顶部「第 xx 轮」行里带文体与额外字
 *  3) mobile  —— 390px 宽度下顶部行不溢出
 *  4) feedback—— 点「反馈」→ 填 → 发送 → 服务端收到
 *  5) admin   —— 审阅页能列出已结束的对局
 *
 * 用法：先起一个实例（建议 PORT=8799），再 node tools/probe_batch2.js */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const KEY = fs.readFileSync(path.join(__dirname, '..', 'admin.key'), 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function getJSON(p) {
  const r = await fetch(BASE + p);
  return r.json();
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
  /* ---------- 造场景 ---------- */
  /* 房 1：满员并开局（用来看局内顶部行，也用来产出一条存档） */
  const g1 = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20, extra: 4 });
  const g1b = await api('/api/join', { roomId: g1.roomId, nick: '小满' });
  await api('/api/room/' + g1.roomId + '/ready', { t: g1.token, ready: true });
  await api('/api/room/' + g1.roomId + '/ready', { t: g1b.token, ready: true });
  /* 房 2：房主中途离开 → 左侧空位 */
  const g2 = await api('/api/create', { nick: '老王', size: 8, rounds: 10 });
  await api('/api/join', { roomId: g2.roomId, nick: '小李' });
  await api('/api/room/' + g2.roomId + '/leave', { t: g2.token });
  /* 房 3：只有房主，没人坐下 → 右侧空位 */
  const g3 = await api('/api/create', { nick: '独坐', size: 9, rounds: 12 });

  const port = 9800 + Math.floor(Math.random() * 150);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(OUT, '.profile-b2'), 'about:blank',
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

  const errors = [];
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  let seedId = null;
  async function shot(name, setupSrc, needGame, size) {
    const w = (size && size[0]) || 1280, h = (size && size[1]) || 1000;
    await send('Emulation.setDeviceMetricsOverride', {
      width: w, height: h, deviceScaleFactor: 1, mobile: !!size,
    });
    if (seedId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedId }); seedId = null; }
    if (setupSrc) {
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: setupSrc });
      seedId = r.identifier;
    }
    await send('Page.navigate', { url: BASE + '/' });
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const r = await send('Runtime.evaluate', {
        expression: `JSON.stringify({ready:document.readyState,playing:!document.getElementById('game').classList.contains('hidden')})`,
        returnByValue: true,
      });
      const v = JSON.parse(r.result.value || '{}');
      if (v.ready === 'complete' && (!needGame || v.playing)) break;
    }
    await sleep(700);
    const data = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.data, 'base64'));
  }
  async function text(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result ? String(r.result.value == null ? '' : r.result.value) : '';
  }

  /* ---------- 1) 大厅 ---------- */
  await shot('b2-lobby', `try{sessionStorage.clear();}catch(e){}`, false);
  console.log('房间条目：' + await text(`JSON.stringify([...document.querySelectorAll('#roomList .roomrow')].map(li=>({
    code: li.querySelector('.rcode').textContent,
    who: li.querySelector('.rwho').textContent,
    spec: li.querySelector('.rspec').textContent,
    emptySeats: li.querySelectorAll('.empty-seat').length
  })))`));
  console.log('大厅文案检查：' + await text(`JSON.stringify({
    有语料规模字样: document.body.textContent.includes('语料规模'),
    有万句: /万句/.test(document.body.textContent),
    反馈按钮: !!document.getElementById('btnFbLobby'),
    反馈按钮文字: (document.getElementById('btnFbLobby')||{}).textContent||''
  })`));
  console.log('空位颜色：' + await text(`(()=>{const e=document.querySelector('.empty-seat');return e?getComputedStyle(e).color:'(无)'})()`));

  /* 窄屏大厅：条目多了「文体 · 额外字」，确认没把宽度撑破 */
  await shot('b2-lobby-mobile', `try{sessionStorage.clear();}catch(e){}`, false, [390, 844]);
  console.log('窄屏大厅溢出：' + await text(`JSON.stringify({sw:document.scrollingElement.scrollWidth, iw:innerWidth})`));

  /* ---------- 2) 局内顶部行 ---------- */
  const sess = JSON.stringify({ roomId: g1.roomId, seat: 'A', token: g1.token });
  await shot('b2-game', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`, true);
  console.log('局内顶部行：' + await text(`JSON.stringify({
    roundinfo: (document.querySelector('.roundinfo')||{}).textContent||'',
    cfgText: (document.getElementById('cfgText')||{}).textContent||''
  })`));

  /* ---------- 3) 手机宽度 ---------- */
  await shot('b2-mobile', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`, true, [390, 844]);
  console.log('窄屏溢出检查：' + await text(`JSON.stringify({
    sw: document.scrollingElement.scrollWidth, iw: innerWidth,
    roundinfo: (document.querySelector('.roundinfo')||{}).textContent||''
  })`));

  /* ---------- 4) 反馈 ---------- */
  await shot('b2-feedback', `try{sessionStorage.clear();}catch(e){}`, false);
  await send('Runtime.evaluate', { expression: `document.getElementById('btnFbLobby').click()` });
  await sleep(300);
  await send('Runtime.evaluate', { expression: `
    document.getElementById('fbText').value = '探针留言：希望大厅能按房号排序';
    document.getElementById('fbContact').value = 'probe@test';
  ` });
  await sleep(250);
  let fbPng = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'b2-feedback-open.png'), Buffer.from(fbPng.data, 'base64'));
  await send('Runtime.evaluate', { expression: `document.getElementById('fbSend').click()` });
  await sleep(1200);
  fbPng = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'b2-feedback-sent.png'), Buffer.from(fbPng.data, 'base64'));
  console.log('发送后提示：' + await text(`(document.getElementById('toast')||{}).textContent||'(无)'`));
  console.log('弹窗是否关闭：' + await text(`document.getElementById('fbOverlay').classList.contains('hidden')`));
  const fb = await getJSON('/api/feedback?key=' + encodeURIComponent(KEY));
  console.log('服务端收到反馈条数：' + ((fb.list || []).length) + '｜最新：' +
    JSON.stringify((fb.list || [])[0] && (fb.list[0].text + ' / ' + fb.list[0].contact)));

  /* ---------- 5) 审阅页（先结束一局以产生存档） ---------- */
  await api('/api/room/' + g1.roomId + '/finish', { t: g1.token });
  await api('/api/room/' + g1.roomId + '/consent', { t: g1b.token, accept: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/admin?key=' + encodeURIComponent(KEY) });
  await sleep(1500);
  console.log('审阅页：' + await text(`JSON.stringify({
    title: (document.querySelector('h1')||{}).textContent||'',
    sub: (document.getElementById('sub')||{}).textContent||'',
    rows: document.querySelectorAll('#recList tbody tr').length,
    firstRow: (document.querySelector('#recList tbody tr')||{}).innerText||''
  })`));
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'b2-admin.png'), Buffer.from(png.data, 'base64'));

  if (errors.length) console.log('!! 页面报错：' + errors.slice(0, 3).join(' | '));
  else console.log('页面无 JS 报错');
  chrome.kill();
})();
