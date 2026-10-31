/* 真实浏览器双开取证：离开房间 → 大厅 → 后退 → 重进，看玩家实际看到什么。
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules \
 *   node tools/probe_leave_ui.js http://127.0.0.1:8787
 *
 * 依赖：本机 ms-playwright 的 chromium + workspace 里的 ws（走 CDP，不用装 playwright）。
 * 输出写 shots/leave_ui.txt，图片写 shots/leave-*.png。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const SHOTS = path.resolve(__dirname, '..', 'shots');
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lines = [];
function log(...a) { const s = a.join(' '); lines.push(s); console.log(s); }

class Tab {
  constructor(name, ws) { this.name = name; this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async open(name, url) {
    const r = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
    const info = await r.json();
    const ws = new WebSocket(info.webSocketDebuggerUrl, { perMessageDeflate: false });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const t = new Tab(name, ws);
    t.targetId = info.id;
    ws.on('message', (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch (_) { return; }
      if (msg.id && t.pending.has(msg.id)) { t.pending.get(msg.id)(msg); t.pending.delete(msg.id); }
    });
    await t.send('Page.enable');
    await t.send('Runtime.enable');
    return t;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res) => {
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(async()=>{' + expr + '})()', awaitPromise: true, returnByValue: true,
    });
    if (r.result && r.result.exceptionDetails) return { error: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : undefined;
  }
  async nav(url) {
    await this.send('Page.navigate', { url });
    await this.waitFor('return !!document.readyState && document.readyState === "complete"', 15000);
    await sleep(300);
  }
  async waitFor(expr, limitMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (limitMs || 10000)) {
      let v = false;
      try { v = await this.eval(expr); } catch (_) {}
      if (v) return true;
      await sleep(150);
    }
    return false;
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(path.join(SHOTS, file), Buffer.from(r.result.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch (_) {} }
}

/* 页面里「我现在是谁、看到什么」 */
const WHO = `
  const me = (() => { try { return JSON.parse(sessionStorage.getItem('feihua-ol') || 'null'); } catch (_) { return null; } })();
  const lobbyHidden = document.getElementById('lobby').classList.contains('hidden');
  const gameHidden = document.getElementById('game').classList.contains('hidden');
  const rows = Array.from(document.querySelectorAll('#roomList .roomrow')).map((li) => ({
    code: (li.querySelector('.rcode') || {}).textContent,
    who: (li.querySelector('.rwho') || {}).textContent,
    btn: (li.querySelector('button') || {}).textContent,
    state: (li.querySelector('.rstate') || {}).textContent,
  }));
  return { me, lobbyHidden, gameHidden, hash: location.hash, href: location.pathname + location.search,
           rows, url: location.href };
`;

(async () => {
  if (!fs.existsSync(SHOTS)) fs.mkdirSync(SHOTS);
  const profile = path.join(os.tmpdir(), 'fb-leave-' + Date.now());
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,900', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-http-cache', 'about:blank',
  ], { stdio: 'ignore' });

  for (let i = 0; i < 60; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch (_) {}
    await sleep(300);
  }
  log('BASE = ' + BASE);

  const A = await Tab.open('A', BASE + '/');
  const B = await Tab.open('B', BASE + '/');
  await A.waitFor('return !!document.getElementById("btnCreate")', 10000);
  await B.waitFor('return !!document.getElementById("btnJoin")', 10000);
  await sleep(800);          /* 等 app.js 把按钮事件绑上，否则点了没反应 */

  const nickA = '甲' + String(Date.now()).slice(-4);
  const nickB = '乙' + String(Date.now()).slice(-4);

  /* 甲建房 */
  await A.eval('document.getElementById("nick").value = "' + nickA + '"; document.getElementById("btnCreate").click(); return 1;');
  const created = await A.waitFor('return !!sessionStorage.getItem("feihua-ol")', 8000);
  if (!created) throw new Error('甲没能建房（按钮点了没反应）');
  await A.waitFor('return !document.getElementById("game").classList.contains("hidden")', 8000);
  const roomId = (await A.eval(WHO)).me.roomId;
  log('\n[1] 甲建房 ' + roomId + '（昵称 ' + nickA + '），A 页 = ' + JSON.stringify((await A.eval(WHO)).me));

  /* 乙从大厅「加入」进同一个房间 */
  await B.eval('document.getElementById("nick").value = "' + nickB + '"; document.getElementById("joinCode").value = "' + roomId + '"; document.getElementById("btnJoin").click(); return 1;');
  const joined = await B.waitFor('return !document.getElementById("game").classList.contains("hidden")', 10000);
  log('[2] 乙加入：' + (joined ? '进入房间' : '没进去') + '，B 页 = ' + JSON.stringify((await B.eval(WHO)).me));
  await sleep(800);

  const before = await A.eval(`
    return { members: Array.from(document.querySelectorAll('#memberList li')).map(li => li.textContent.trim()),
             seatB: (document.querySelector('#seatB') || {}).textContent };
  `);
  log('[3] 甲看到的成员：' + JSON.stringify(before));

  /* 乙点「离开房间」 */
  await B.shot('leave-1-inroom.png');
  await B.eval('window.confirm = () => true; document.getElementById("btnLeave").click(); return 1;');
  await sleep(2500);
  const afterB = await B.eval(WHO);
  log('\n[4] 乙离开后 B 页：' + JSON.stringify(afterB));
  await B.shot('leave-2-lobby.png');

  const afterA = await A.eval(`
    return { members: Array.from(document.querySelectorAll('#memberList li')).map(li => li.textContent.trim()),
             seatB: (document.querySelector('#seatB') || {}).textContent };
  `);
  log('[5] 甲看到：' + JSON.stringify(afterA));

  /* 乙在大厅等一轮刷新，看房间行 */
  await sleep(6000);
  log('[6] 6 秒后 B 页大厅房间行：' + JSON.stringify((await B.eval(WHO)).rows));

  /* 乙点「后退」，看会不会把已经离开的房间画面拿回来（bfcache） */
  await B.eval('history.back(); return 1;');
  await sleep(1500);
  const backB = await B.eval(WHO);
  log('\n[7] 乙按后退：' + JSON.stringify(backB));
  await B.shot('leave-3-back.png');

  /* 乙再前进回大厅，然后从大厅「加入」重进 */
  await B.eval('history.forward(); return 1;');
  await sleep(1200);
  /* 点这个房间那一行（不是列表第一行），并记下按钮文案 */
  const clicked = await B.eval(`
    const li = Array.from(document.querySelectorAll('#roomList .roomrow'))
      .find((x) => (x.querySelector('.rcode') || {}).textContent === ${JSON.stringify(roomId)});
    if (!li) return '（列表里没有这间房）';
    const btn = li.querySelector('button');
    const label = btn ? btn.textContent : '';
    if (btn) btn.click();
    return label;
  `);
  log('[8] 乙点的那一行按钮文案：' + clicked);
  await sleep(2000);
  const reB = await B.eval(WHO);
  log('[9] 乙重进后：' + JSON.stringify(reB));
  await B.shot('leave-4-rejoin.png');

  const reA = await A.eval(`
    return { members: Array.from(document.querySelectorAll('#memberList li')).map(li => li.textContent.trim()),
             seatB: (document.querySelector('#seatB') || {}).textContent };
  `);
  log('[10] 甲这时看到：' + JSON.stringify(reA));

  /* 心跳：等一个周期（20 秒）再看页面是否真的发出过 /beat。
     注意别用 performance 资源时序判断 —— 带 keepalive 的 fetch 不进那个缓冲区，
     会得到「一次都没有」的假阴性。这里换成在进房间前包装 fetch 计数。 */
  log('\n[11] 等 21 秒验心跳…');
  await sleep(21000);
  const res = await B.eval(`
    const all = performance.getEntriesByType('resource').map((e) => e.name.replace(location.origin, ''));
    return {
      hasStartBeat: typeof startBeat === 'function',
      hasBeatOnce: typeof beatOnce === 'function',
      meRoom: (() => { try { return (JSON.parse(sessionStorage.getItem('feihua-ol') || 'null') || {}).roomId; } catch (_) { return null; } })(),
      tail: all.slice(-6),
      total: all.length,
    };
  `);
  log('[11] 页面里：startBeat=' + res.hasStartBeat + ' beatOnce=' + res.hasBeatOnce +
    ' ME.roomId=' + res.meRoom + '（/beat 不出现在资源时序里，心跳由下面独立验）');
  log('[11] 页面最近的资源请求：' + JSON.stringify(res.tail) + '（共 ' + res.total + ' 条）');
  const stillIn = await B.eval(WHO);
  log('[12] 21 秒后乙仍在房间：' + (!stillIn.gameHidden && !!stillIn.me) + '，seat=' + (stillIn.me && stillIn.me.seat));

  /* ---- 刷新页面：应当原地接回，席位不变、不回到大厅 ---- */
  const meB = (await B.eval(WHO)).me;
  await B.eval('location.reload(); return 1;');
  await sleep(3000);
  const afterReload = await B.eval(WHO);
  log('[13] 刷新后：' + JSON.stringify({ me: afterReload.me, gameHidden: afterReload.gameHidden, lobbyHidden: afterReload.lobbyHidden }));

  /* ---- 真的关掉标签页：服务端应当立刻不再认为他还在 ---- */
  await fetch('http://127.0.0.1:' + PORT + '/json/close/' + B.targetId).catch(() => {});
  await sleep(1500);
  /* 注意：这里绝对不能带 token 去 peek —— peek 会把「刚离开的人」原样接回来，
     一探就把人探活了。只能看大厅列表里的席位。 */
  const rowAfterClose = await (await fetch(BASE + '/api/rooms', { cache: 'no-store' })).json().catch(() => null);
  const row = ((rowAfterClose && rowAfterClose.rooms) || []).find((r) => r.id === roomId);
  log('[14] 关掉标签页 1.5 秒后大厅视角：' + JSON.stringify(row ? { A: row.players.A, B: row.players.B, joinable: row.joinable } : '（房间已消失）'));

  /* ---- 用同昵称重进 ---- */
  const C = await Tab.open('C', BASE + '/');
  await C.waitFor('return !!document.getElementById("btnJoin")', 10000);
  await sleep(800);
  const cJoin = await C.eval(`
    document.getElementById('nick').value = ${JSON.stringify(nickB)};
    document.getElementById('joinCode').value = ${JSON.stringify(roomId)};
    document.getElementById('btnJoin').click();
    for (let i = 0; i < 40; i++) { if (sessionStorage.getItem('feihua-ol')) break; await new Promise(r => setTimeout(r, 200)); }
    return JSON.parse(sessionStorage.getItem('feihua-ol') || 'null');
  `);
  log('[16] 关掉标签页后用同昵称重进：' + JSON.stringify(cJoin));
  await sleep(1500);
  const cWho = await C.eval(WHO);
  log('[17] 重进后大厅里那一行：' + JSON.stringify((cWho.rows || []).filter((r) => r.code === roomId)));
  const cMem = await C.eval(`
    return Array.from(document.querySelectorAll('#memList li')).map((li) => li.textContent.replace(/\\s+/g, ' ').trim());
  `);
  log('[18] 重进后的成员列表：' + JSON.stringify(cMem));

  log('\n（结束）');
  A.close(); B.close(); C.close();
  try { chrome.kill(); } catch (_) {}
  fs.writeFileSync(path.join(SHOTS, 'leave_ui.txt'), lines.join('\n') + '\n');
  process.exitCode = 0;
})().catch((e) => {
  log('probe 自身异常：' + (e && e.stack));
  try { fs.writeFileSync(path.join(SHOTS, 'leave_ui.txt'), lines.join('\n') + '\n'); } catch (_) {}
  process.exitCode = 1;
});
