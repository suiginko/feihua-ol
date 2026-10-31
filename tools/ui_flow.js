'use strict';
/* 交互探针：真的在页面上输入诗句并回车，验证
   ① 提交按钮跟随回合方墨色 ② .msg 判罚条出现 ③ 记录与棋盘同步更新
   用法：node server.js 跑着，然后 node tools/ui_flow.js  */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOB = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'clauses.txt.gz'))).toString('utf8');

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function peek(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return (await r.json()).state;
}

/* 从语料里挑一句「至少命中 2 个未涂色格」的真句 */
function pickLine(st, used, seed) {
  const need = new Set();
  for (let i = 0; i < st.board.length; i++) if (st.board.charAt(i) === '0') need.add(st.chars.charAt(i));
  let p = 2000 + ((seed * 6151) % 15000000);
  for (let i = 0; i < 4000; i++) {
    const e = BLOB.indexOf('\n', p);
    if (e < 0) { p = 0; continue; }
    const ln = BLOB.slice(p, e);
    p = e + 1;
    if (ln.length < 5 || ln.length > 12 || used.has(ln)) continue;
    let hit = 0;
    for (const ch of ln) if (need.has(ch)) hit++;
    if (hit >= 2) return ln;
  }
  return null;
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
  const a = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20 });
  const b = await api('/api/join', { roomId: a.roomId, nick: '青岚' });
  let st = await peek(a.roomId, a.token);
  console.log('房间', a.roomId, '· 棋盘', st.size + '×' + st.size, '· 轮到', st.turn);

  const valid = pickLine(st, new Set(), 7);
  if (!valid) { console.log('!! 挑不到测试用句'); process.exit(1); }
  console.log('测试句：' + valid);

  const port = 9500 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(OUT, '.flow-profile'), 'about:blank',
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
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails.exception || {}).description || 'exception');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((x) => x.value || x.description || '').join(' '));
    }
  });

  const sess = JSON.stringify({ roomId: a.roomId, seat: 'A', token: a.token });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`,
  });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(2200);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // ① 提交按钮跟随回合方墨色 + 输入框可用
  const before = JSON.parse(await evalJs(`JSON.stringify({
    btnClass: document.getElementById('btnSubmit').className,
    readOnly: document.getElementById('poem').readOnly,
    logItems: document.querySelectorAll('#logList li').length,
    msg: document.getElementById('verdict').className
  })`));
  console.log('提交前', JSON.stringify(before));

  const typeAndEnter = async (text) => {
    await evalJs(`(() => {
      const t = document.getElementById('poem');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(t, ${JSON.stringify(text)});
      t.dispatchEvent(new Event('input', { bubbles: true }));
      t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
  };

  // ② 先试伪造句（此时仍是我的回合）→ 必须显示 err 且不落墨
  await typeAndEnter('我编了一句根本不在书上的假诗');
  await sleep(1200);
  const bad = JSON.parse(await evalJs(`JSON.stringify({
    msgClass: document.getElementById('verdict').className,
    msgText: document.getElementById('verdict').textContent,
    logItems: document.querySelectorAll('#logList li').length
  })`));
  console.log('伪造句', JSON.stringify(bad));

  // ③ 再提交真句 → 应通过并落墨，回合交给对手
  await typeAndEnter(valid);
  let after = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    after = JSON.parse(await evalJs(`JSON.stringify({
      logItems: document.querySelectorAll('#logList li').length,
      msgClass: document.getElementById('verdict').className,
      msgText: document.getElementById('verdict').textContent,
      ownA: document.querySelectorAll('.cell.own-A').length,
      ownB: document.querySelectorAll('.cell.own-B').length,
      turn: document.getElementById('turnWho').textContent
    })`));
    if (after.logItems > before.logItems) break;
  }
  console.log('真句提交', JSON.stringify(after));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'flow.png'), Buffer.from(shot.data, 'base64'));

  const okBtn = /team-a|team-b/.test(before.btnClass);
  const okReject = /msg show err/.test(bad.msgClass) && bad.logItems === before.logItems;
  const okSubmit = after && after.logItems > before.logItems
    && /msg show ok/.test(after.msgClass) && after.ownA + after.ownB > 0;
  console.log('\n结果：');
  console.log('  提交按钮随队色  ' + (okBtn ? 'PASS' : 'FAIL'));
  console.log('  伪造句判负      ' + (okReject ? 'PASS' : 'FAIL'));
  console.log('  回车提交落墨    ' + (okSubmit ? 'PASS' : 'FAIL'));
  console.log('  JS 报错         ' + (errors.length ? 'FAIL · ' + errors.join(' | ') : 'none'));

  chrome.kill();
  process.exit(okBtn && okSubmit && okReject && !errors.length ? 0 : 1);
})().catch((e) => { console.log('!! ' + e.message); process.exit(1); });
