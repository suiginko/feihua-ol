'use strict';
/* 探针：大厅那条公告栏——真正的浏览器里，它到底有没有按预期出现 / 变色 / 撤下。
 *
 *   node tools/probe_notice.js
 *
 * 自带实例（临时端口 + 临时数据目录），不碰你正在用的 8787。
 * 核对的是四件在 HTTP 层看不见的事：
 *   1) 有公告时它真的露出来了，文字与接口一致；
 *   2) kind=warn 时换成警示样式，标签从「公告」变「注意」；
 *   3) 它横跨大厅两列（不加这一条的话它会把「开一局」那张卡挤到第二列去）；
 *   4) 没有公告 / 撤下之后变成灰条「暂无公告」，而不是整条消失——
 *      收走会让下面两块在撤下的瞬间往上跳一格。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'shots');
const KEY = 'probe-key-123';
const tmpDir = require('./_tmpdir');
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

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

let srv = null;
async function startServer(port) {
  srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: tmpDir('probe-notice-' + port),
      ADMIN_KEY: KEY,
      SWEEP_MS: '800',
    }),
    stdio: 'ignore',
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/stats', { cache: 'no-store' });
      if (r.ok) return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

async function setNotice(base, body) {
  const r = await fetch(base + '/api/notice?key=' + encodeURIComponent(KEY), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
}

(async () => {
  let port = 0;
  for (let p = 9770; p <= 9790; p++) { if (await portFree(p)) { port = p; break; } }
  if (!port) throw new Error('找不到空闲端口');
  const BASE = 'http://127.0.0.1:' + port;
  if (!(await startServer(port))) throw new Error('实例没起来');

  const chPort = 9800 + Math.floor(Math.random() * 120);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1180,820', '--remote-debugging-port=' + chPort,
    '--user-data-dir=' + path.join(OUT, '.profile-notice'), 'about:blank',
  ]);
  await sleep(1500);
  const list = await (await fetch('http://127.0.0.1:' + chPort + '/json/list')).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');

  const errors = [];
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(((m.params.exceptionDetails || {}).exception || {}).description || 'exception');
    }
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result ? r.result.value : undefined;
  };

  let pass = 0, fail = 0;
  const check = (name, ok, extra) => {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」')); }
  };

  const readBar = () => ev(`(() => {
    const box = document.getElementById('notice');
    if (!box) return { missing: true };
    const r = box.getBoundingClientRect();
    const lobby = document.getElementById('lobby').getBoundingClientRect();
    const card = document.querySelector('#lobby .card').getBoundingClientRect();
    return {
      hidden: box.classList.contains('hidden'),
      warn: box.classList.contains('warn'),
      empty: box.classList.contains('empty'),
      tag: document.getElementById('noticeTag').textContent,
      text: document.getElementById('noticeText').textContent,
      width: Math.round(r.width),
      lobbyWidth: Math.round(lobby.width),
      topVsCard: Math.round(card.top - r.top),
      display: getComputedStyle(box).display,
    };
  })()`);

  /* ---------- 1) 没有公告：留一条灰条「暂无公告」 ---------- */
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);
  let bar = await readBar();
  check('没有公告时仍然显示（不隐藏）', bar.hidden === false, bar.hidden);
  check('没有公告时文字是「暂无公告」', bar.text === '暂无公告', bar.text);
  check('没有公告时是灰调空态', bar.empty === true, bar.empty);
  check('没有公告时不是警示样式', bar.warn === false, bar.warn);
  check('空态也横跨两列', Math.abs(bar.width - bar.lobbyWidth) <= 2, [bar.width, bar.lobbyWidth]);

  /* ---------- 2) 写一条一般公告 ---------- */
  await setNotice(BASE, { text: '今晚 23:00 左右会更新一版，正在打的对局可能会中断。', kind: 'info' });
  await ev(`loadNotice()`);
  await sleep(400);
  bar = await readBar();
  check('有公告时露出来', bar.hidden === false, bar.hidden);
  check('文字与接口一致', bar.text === '今晚 23:00 左右会更新一版，正在打的对局可能会中断。', bar.text);
  check('一般公告的标签是「公告」', bar.tag === '公告', bar.tag);
  check('一般公告不是警示样式', bar.warn === false, bar.warn);
  check('横跨大厅两列（宽度接近整个大厅）', Math.abs(bar.width - bar.lobbyWidth) <= 2, [bar.width, bar.lobbyWidth]);
  check('排在「开一局」那张卡之前', bar.topVsCard > 0, bar.topVsCard);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'notice-info.png'), Buffer.from(shot1.data, 'base64'));

  /* ---------- 3) 换成警示样式 ---------- */
  await setNotice(BASE, { text: '服务器今晚维护，22:00 起暂停开新房。\n已开局的可以打完。', kind: 'warn' });
  await ev(`loadNotice()`);
  await sleep(400);
  bar = await readBar();
  check('警示公告换了样式', bar.warn === true, bar.warn);
  check('警示公告的标签是「注意」', bar.tag === '注意', bar.tag);
  check('多行公告保留换行', bar.text.indexOf('\n') > 0, JSON.stringify(bar.text));
  const bg = await ev(`getComputedStyle(document.getElementById('notice')).backgroundColor`);
  check('背景换成橙色系（不是蓝色）', bg !== 'rgb(238, 244, 255)', bg);
  console.log('警示底色：' + bg);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'notice-warn.png'), Buffer.from(shot2.data, 'base64'));

  /* ---------- 4) 撤下 ---------- */
  await setNotice(BASE, { text: '' });
  await ev(`loadNotice()`);
  await sleep(400);
  bar = await readBar();
  check('撤下之后回到「暂无公告」', bar.text === '暂无公告', bar.text);
  check('撤下之后是空态样式', bar.empty === true, bar.empty);
  check('撤下之后不再带警示样式', bar.warn === false, bar.warn);
  check('撤下之后仍然占位（下面不往上跳）', bar.display !== 'none' && bar.width > 0, bar.display);

  /* ---------- 5) 公告里的尖括号不能被当 HTML ---------- */
  await setNotice(BASE, { text: '<b>加粗</b> 与 <script>x</script>', kind: 'info' });
  await ev(`loadNotice()`);
  await sleep(400);
  const injected = await ev(`(() => {
    const p = document.getElementById('noticeText');
    return { text: p.textContent, html: p.innerHTML, bold: !!p.querySelector('b'), script: !!p.querySelector('script') };
  })()`);
  check('尖括号原样显示成文字', injected.text === '<b>加粗</b> 与 <script>x</script>', injected.text);
  check('没有被解析成 HTML 元素', injected.bold === false && injected.script === false, injected);

  if (errors.length) console.log('!! 页面报错：' + errors.slice(0, 3).join(' | '));
  else console.log('页面无 JS 报错');

  console.log('\n「公告栏」' + pass + ' 过 / ' + fail + ' 败');
  ws.close();
  try { chrome.kill(); } catch (_) {}
  try { srv.kill(); } catch (_) {}
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('探针失败：' + (e && e.stack || e));
  try { if (srv) srv.kill(); } catch (_) {}
  process.exitCode = 1;
});
