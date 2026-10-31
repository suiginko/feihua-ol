'use strict';
/* 探针：审阅页的「启动记录」和「房间快照」两个标签。
 * 用法：先起实例（建议 PORT=8799），再 node tools/probe_admin.js
 *       BASE 可以用环境变量改，例如 BASE=http://127.0.0.1:8787 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const OUT = path.join(__dirname, '..', 'shots');
const KEY = fs.readFileSync(path.join(__dirname, '..', 'admin.key'), 'utf8').trim();
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (!ok && extra != null ? '  → ' + JSON.stringify(extra) : ''));
  };

  const port = 9800 + Math.floor(Math.random() * 150);
  const profile = path.join(OUT, '.profile-admin-' + Date.now().toString(36));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-http-cache',
    '--window-size=1180,980', '--remote-debugging-port=' + port,
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
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面出错：' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
    return r.result ? r.result.value : undefined;
  };
  const waitFor = async (expr, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (await ev(expr)) return true; } catch (_) {}
      await sleep(250);
    }
    return false;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name + '.png');
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    return f;
  };

  /* 先造一间房，这样「房间快照」标签有东西可列（不强求数量，只看有没有这一间） */
  const made = await (await fetch(BASE + '/api/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nick: '审阅' + Date.now().toString().slice(-3), size: 8, rounds: 10 }),
  })).json();

  await send('Page.navigate', { url: BASE + '/admin?key=' + encodeURIComponent(KEY) });
  check('审阅页打开', await waitFor(`!!document.getElementById('paneBoot')`));
  check('五个标签都在', await ev(`document.querySelectorAll('.tab').length === 5`));

  await ev(`document.querySelector('.tab[data-tab="boot"]').click()`);
  const ok = await waitFor(`document.querySelectorAll('#bootList tbody tr').length > 0`);
  check('「启动记录」能列出条目', ok === true);

  const info = await ev(`(() => {
    var rows = document.querySelectorAll('#bootList tbody tr').length;
    var v = document.getElementById('bootVerdict').innerText.replace(/\\s+/g, ' ').trim();
    var heads = [].map.call(document.querySelectorAll('#bootList thead th'), function (h) { return h.textContent; });
    return { rows: rows, verdict: v, heads: heads, paneShown: document.getElementById('paneBoot').style.display !== 'none' };
  })()`);
  console.log('条目数：' + info.rows);
  console.log('列：' + info.heads.join(' / '));
  console.log('结论：' + info.verdict);
  check('面板确实切到启动记录', info.paneShown === true);
  check('给了「磁盘是否延续」的结论', /磁盘/.test(info.verdict), info.verdict);
  console.log('截图：' + await shot('admin-boot'));

  /* ---- 房间快照 ---- */
  await ev(`document.querySelector('.tab[data-tab="snap"]').click()`);
  const snapOk = await waitFor(`document.querySelectorAll('#snapVerdict .sub').length > 0`);
  check('「房间快照」能读出状态', snapOk === true);
  const snap = await ev(`(() => {
    var v = document.getElementById('snapVerdict').innerText.replace(/\\s+/g, ' ').trim();
    var heads = [].map.call(document.querySelectorAll('#snapList thead th'), function (h) { return h.textContent; });
    var ids = [].map.call(document.querySelectorAll('#snapList tbody tr td:first-child'), function (t) { return t.textContent; });
    return {
      verdict: v, heads: heads, ids: ids,
      paneShown: document.getElementById('paneSnap').style.display !== 'none',
      bootHidden: document.getElementById('paneBoot').style.display === 'none',
    };
  })()`);
  console.log('列：' + snap.heads.join(' / '));
  console.log('结论：' + snap.verdict);
  check('面板确实切到房间快照', snap.paneShown === true && snap.bootHidden === true, snap);
  check('给出了「内存里 / 快照里」两个数', /内存里\s*\d+\s*间/.test(snap.verdict) && /快照里\s*\d+\s*间/.test(snap.verdict), snap.verdict);
  check('给出了「这一轮接回了几间」的交代', /接回|没有接回/.test(snap.verdict), snap.verdict);
  check('列表里有刚建的那间房', made.ok === true && snap.ids.indexOf(made.roomId) >= 0, { want: made.roomId, got: snap.ids });
  console.log('截图：' + await shot('admin-snap'));

  /* ---- 公告：改完不用重新发布 ---- */
  await ev(`document.querySelector('.tab[data-tab="nt"]').click()`);
  const ntOk = await waitFor(`document.getElementById('paneNt').style.display !== 'none'`);
  check('「公告」标签切得过去', ntOk === true);
  const ntShown = await ev(`(() => ({
    snapHidden: document.getElementById('paneSnap').style.display === 'none',
    state: document.getElementById('ntState').textContent,
  }))()`);
  check('切过去之后快照面板收起来了', ntShown.snapHidden === true, ntShown);

  /* 在页面里真的打字 + 点保存，而不是直接调接口 —— 验的是这条人能走的路 */
  await ev(`(function () {
    var t = document.getElementById('ntText');
    t.value = '这条公告是从审阅页写进去的';
    t.dispatchEvent(new Event('input'));
  })()`);
  await ev(`document.getElementById('btnNtSave').click()`);
  await sleep(600);
  const ntAfter = await ev(`document.getElementById('ntState').textContent`);
  check('点保存之后状态变成「已保存」', /已保存/.test(ntAfter), ntAfter);
  const ntApi = await (await fetch(BASE + '/api/notice', { cache: 'no-store' })).json();
  check('接口里确实存下了这段文字', ntApi.notice && ntApi.notice.text === '这条公告是从审阅页写进去的', ntApi.notice);

  /* 撤下 */
  await ev(`document.getElementById('btnNtClear').click()`);
  await sleep(600);
  const ntCleared = await (await fetch(BASE + '/api/notice', { cache: 'no-store' })).json();
  check('点「撤下」之后接口回 null', ntCleared.notice === null, ntCleared.notice);
  check('撤下之后状态说「已撤下」', /已撤下/.test(await ev(`document.getElementById('ntState').textContent`)));
  console.log('截图：' + await shot('admin-notice'));

  ws.close();
  chrome.kill();
  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('探针失败：' + e.message); process.exit(1); });
