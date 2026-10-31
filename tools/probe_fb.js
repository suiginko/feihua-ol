'use strict';
/* 探针：反馈弹窗的标题与说明文案核对 + 截图。
 * 用法：先起实例，再 node tools/probe_fb.js（默认 http://127.0.0.1:8787） */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CHROME = 'C:/Users/Hg/AppData/Local/ms-playwright/chromium-1200/chrome-win64/chrome.exe';
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const OUT = path.join(__dirname, '..', 'shots');
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
  const port = 9800 + Math.floor(Math.random() * 150);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=900,760', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(OUT, '.profile-fb'), 'about:blank',
  ]);
  await sleep(1400);
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
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

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1800);

  /* 点大厅的「反馈」按钮打开弹窗 */
  await ev(`document.getElementById('btnFbLobby').click()`);
  await sleep(500);

  const info = await ev(`(() => {
    const box = document.getElementById('fbOverlay');
    const h2 = box.querySelector('h2');
    const ps = [...box.querySelectorAll('p')].map((p) => p.textContent.trim());
    return {
      open: !box.classList.contains('hidden'),
      title: h2 ? h2.textContent.trim() : '(无)',
      paras: ps,
      gap: (() => {
        const ta = document.getElementById('fbText');
        return Math.round(ta.getBoundingClientRect().top - h2.getBoundingClientRect().bottom);
      })(),
      btnTitles: [...document.querySelectorAll('.fb-open')].map((b) => b.title),
    };
  })()`);
  console.log('弹窗已打开：' + info.open);
  console.log('标题：' + info.title);
  console.log('正文段落：' + (info.paras.length ? JSON.stringify(info.paras) : '(无)'));
  console.log('标题与输入框间距：' + info.gap + 'px');
  console.log('按钮悬停提示：' + JSON.stringify(info.btnTitles));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, 'fb-modal.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('截图：' + file);

  if (errors.length) console.log('!! 页面报错：' + errors.slice(0, 3).join(' | '));
  else console.log('页面无 JS 报错');

  ws.close();
  chrome.kill();
  process.exit(0);
})().catch((e) => { console.error('探针失败：' + e.message); process.exit(1); });
