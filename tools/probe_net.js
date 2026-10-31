'use strict';
/* 探针：断线重连的行为验收。
 *
 * 2026-10-24 起「连接中断」遮罩已按用户要求整体移除 —— SSE 偶尔抖动时它 1.2 秒就浮出来、
 * 重连成功又立刻收起，一天里频繁闪几次，比什么都不显示更影响体验。
 * 所以本探针的断言从「遮罩该不该出现」改成「任何情况下都不许弹出遮罩」，
 * 同时仍要验证更重要的东西：**断线期间的重连与对局恢复没有被这次改动弄坏**。
 *
 *   1) 正常进入对局：页面里已经没有 #netMask 节点；
 *   2) 把服务杀掉 → 等 3 秒，界面不弹出任何浮层（这是本次改动的核心验收）；
 *   3) 服务重启、磁盘留着（发布保护生效）→ 自动重连，对局原样还在；
 *   4) 再杀一次并清空数据目录（模拟「新容器拿到干净磁盘」）→ 给出 toast 提示，仍不弹遮罩，
 *      且不把玩家打回大厅。
 *
 * 第 3 步是房间快照（发布保护）的验收：以前发布一定会走到第 4 步，现在只有磁盘真被换掉才会。
 *
 * 用法：node tools/probe_net.js（会自己起停 8799 实例，别在有人用的端口上跑） */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const PORT = Number(process.env.PROBE_PORT || 8799);
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(__dirname, '..', 'shots');
const ROOT = path.join(__dirname, '..');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 实例的数据目录：启动时清一次；第 4 步要「磁盘被换掉」，再清一次。 */
const DATA = require('./_tmpdir')('probe-net');
function wipeData() { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (_) {} }

let srv = null;

async function startServer() {
  srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const r = await fetch(BASE + '/api/rooms');
      if (r.ok) return true;
    } catch (_) {}
  }
  throw new Error('服务没起来');
}
async function stopServer() {
  if (!srv) return;
  try { srv.kill('SIGKILL'); } catch (_) {}
  srv = null;
  for (let i = 0; i < 20; i++) {
    await sleep(150);
    try { await fetch(BASE + '/api/rooms'); } catch (_) { return; }
  }
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
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
  let bad = 0;
  const check = (name, ok, extra) => {
    if (!ok) bad++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra != null && !ok ? '  → ' + JSON.stringify(extra) : ''));
  };

  await startServer();
  const g = await api('/api/create', { nick: '阿墨', size: 8, rounds: 20 });
  const b = await api('/api/join', { roomId: g.roomId, nick: '小满' });
  await api('/api/room/' + g.roomId + '/ready', { t: g.token, ready: true });
  await api('/api/room/' + g.roomId + '/ready', { t: b.token, ready: true });

  const port = 9800 + Math.floor(Math.random() * 150);
  /* 每次一个全新的 profile 目录：复用旧目录会把上一次的 index.html 缓存下来，
     页面上就会少掉这次新加的节点（排查这个坑花了不少时间）。 */
  const profile = path.join(OUT, '.profile-net-' + Date.now().toString(36));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-http-cache',
    '--window-size=1280,900', '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile, 'about:blank',
  ]);
  await sleep(1500);
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  /* 同一个 user-data-dir 反复跑会把旧 index.html / app.js 缓存下来，必须关掉 */
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面表达式出错：' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result ? r.result.value : undefined;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    return f;
  };
  /* 导航/reload 期间 evaluate 会打到还没销毁的旧上下文（about:blank），所以统一靠轮询等 */
  const waitFor = async (expr, ms = 12000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr)) return true; } catch (_) {}
      await sleep(250);
    }
    return false;
  };
  /* 断线期间页面该是什么样：没有任何遮罩节点，也没有浮层盖住界面 */
  const maskState = () => ev(`(() => {
    const m = document.getElementById('netMask');
    const overlays = Array.prototype.slice.call(document.querySelectorAll('.overlay'))
      .filter((o) => !o.classList.contains('hidden'))
      .map((o) => o.id || '(匿名)');
    return { hasNode: !!m, shown: !!(m && !m.classList.contains('hidden')), overlays };
  })()`);

  /* ---- 1) 正常进局 ---- */
  /* 本机有代理介入 127.0.0.1，静态页可能被缓存住 —— 每次带唯一查询串绕开 */
  const q = () => '?p=' + Date.now().toString(36);
  await send('Page.navigate', { url: BASE + '/' + q() });
  const ready = await waitFor(`document.readyState === 'complete' && !!document.getElementById('board')`);
  check('首页加载完成（棋盘节点就位）', ready === true);
  await ev(`sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: g.roomId, seat: 'A', token: g.token }))})`);
  await send('Page.navigate', { url: BASE + '/' + q() });
  const inGame = await waitFor(`!document.getElementById('game').classList.contains('hidden')`);
  check('刷新后用本地身份直接回到对局', inGame === true);
  await sleep(600);
  let m = await maskState();
  check('遮罩节点已从页面移除（2026-10-24 用户要求去掉）', m.hasNode === false, m);
  check('正常情况下没有浮层盖住界面', m.overlays.length === 0, m);

  /* ---- 2) 服务被杀：这一条是本次改动的核心验收 ---- */
  await stopServer();
  await sleep(3000);
  m = await maskState();
  check('断线 3 秒后依然不弹任何遮罩', m.hasNode === false && m.shown === false && m.overlays.length === 0, m);
  console.log('截图：' + await shot('net-offline'));

  /* ---- 3) 服务重启，磁盘还在 → 自动重连，对局原样还在 ---- */
  await startServer();
  /* 没有遮罩可以等「收起」，改为等一轮 SSE 重连 + state 推送落地 */
  await sleep(9000);
  const resumed = await ev(`({
    inGame: !document.getElementById('game').classList.contains('hidden'),
    room: document.getElementById('roomChip').textContent.trim(),
    round: document.getElementById('roundNow').textContent.trim(),
    cells: document.getElementById('board').children.length,
  })`);
  check('对局界面还在（没有被打回大厅）', resumed.inGame === true);
  check('房号还是原来那一间', resumed.room === g.roomId, resumed.room + ' vs ' + g.roomId);
  check('棋盘格数原样保留', resumed.cells === 64, resumed.cells);
  m = await maskState();
  check('重连完成后仍然没有任何遮罩', m.hasNode === false && m.overlays.length === 0, m);
  console.log('截图：' + await shot('net-restored'));

  /* ---- 4) 再杀一次，并且把数据目录清空 = 新容器拿到干净磁盘 ---- */
  await stopServer();
  wipeData();
  await sleep(300);
  await startServer();
  /* 房间确实没了：应当只给一条 toast，而不是盖一层遮罩 */
  const turnedGone = await waitFor(`document.getElementById('toast').textContent.indexOf('本局在服务端已结束') >= 0`, 25000);
  check('房间真没了时给 toast 提示', turnedGone === true);
  m = await maskState();
  check('此时依然没有任何遮罩', m.hasNode === false && m.overlays.length === 0, m);
  const stillGame = await ev(`!document.getElementById('game').classList.contains('hidden')`);
  check('房间失效后仍留在缓存窗口，不被打回大厅', stillGame === true);
  console.log('截图：' + await shot('net-gone'));

  ws.close();
  chrome.kill();
  await stopServer();
  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n全部通过');
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error('探针失败：' + e.message);
  try { await stopServer(); } catch (_) {}
  process.exit(1);
});
