'use strict';
/* UI 探针：起无头 Chromium，注入登录态，截大厅 / 对战两张图，并检查布局与报错。
   用法：node server.js 跑着，然后 node tools/ui_probe.js                */

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

const zlib = require('zlib');
const BLOB = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'clauses.txt.gz'))).toString('utf8');

function pickLine(state, used, seed) {
  const need = new Set();
  for (let i = 0; i < state.chars.length; i++) {
    if (state.board.charAt(i) === '0') need.add(state.chars.charAt(i));
  }
  let p = 2000 + ((seed * 6151) % 15000000);
  for (let i = 0; i < 3000; i++) {
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

async function state(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return (await r.json()).state;
}

async function setupGame() {
  const a = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20 });
  const b = await api('/api/join', { roomId: a.roomId, nick: '青岚' });
  /* 两人到齐不会自动开局，必须双方各点一次「准备好了」 */
  await api('/api/room/' + a.roomId + '/ready', { t: a.token, ready: true });
  await api('/api/room/' + a.roomId + '/ready', { t: b.token, ready: true });
  let st = await state(a.roomId, a.token);
  const used = new Set();
  for (let i = 0; i < 40 && st.phase === 'playing'; i++) {
    const team = st.turn;
    const tok = team === 'A' ? a.token : b.token;
    /* 第 3 手让青营放弃一次：检查「放弃本回合」是否也带赤/青徽标 */
    if (i === 2) {
      await api('/api/room/' + a.roomId + '/pass', { t: tok });
      st = await state(a.roomId, a.token);
      continue;
    }
    const ln = pickLine(st, used, i + 3);
    if (!ln) break;
    used.add(ln);
    const res = await api('/api/room/' + a.roomId + '/move', { t: tok, text: ln });
    if (!res.ok) continue;
    st = await state(a.roomId, a.token);
    if (i >= 9) break;
  }
  /* 让青营发一个撤销请求：A 的页面上应出现「对方请求撤销」的确认条 */
  await api('/api/room/' + a.roomId + '/undo', { t: b.token });
  st = await state(a.roomId, a.token);
  return { roomId: a.roomId, tokenA: a.token, state: st };
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
  const port = 9300 + Math.floor(Math.random() * 200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(OUT, '.profile'), 'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 40 && !wsUrl; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const list = await r.json();
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
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  let seedId = null;
  async function shot(name, setup) {
    if (seedId) { await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedId }); seedId = null; }
    if (setup) {
      const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: setup });
      seedId = r.identifier;
    }
    await send('Page.navigate', { url: BASE + '/' });
    if (setup) {
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        const r = await send('Runtime.evaluate', {
          expression: `JSON.stringify({ready: document.readyState, playing: !document.getElementById('game').classList.contains('hidden')})`,
          returnByValue: true,
        });
        const v = JSON.parse(r.result.value || '{}');
        if (v.ready === 'complete' && v.playing) break;
      }
      await sleep(500);
    } else {
      await sleep(900);
    }
    const m = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        sw: document.scrollingElement.scrollWidth, iw: innerWidth,
        board: (()=>{const b=document.getElementById('board');const r=b.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height),cells:b.children.length};})(),
        cellsVis: document.querySelectorAll('.cell').length,
        logItems: document.querySelectorAll('#logList li').length,
        marks: document.querySelectorAll('#logList u.mk').length,
        mkNew: document.querySelectorAll('#logList u.mk-new').length,
        mkCap: document.querySelectorAll('#logList u.mk-cap').length,
        mkHold: document.querySelectorAll('#logList u.mk-hold').length,
        verdict: (document.getElementById('verdict')||{}).textContent||'',
        active: [...document.querySelectorAll('.team.active')].map(e=>e.id).join(','),
        clock: (document.getElementById('clock')||{}).textContent||'',
        submitTeam: (document.getElementById('btnSubmit')||{}).className||'',
        cellFont: getComputedStyle(document.querySelector('.cell')||document.body).fontFamily.slice(0,18),
        overlay: ['waitOverlay','endOverlay'].filter(id=>!document.getElementById(id).classList.contains('hidden')),
        logFirst: (document.querySelector('#logList li .line')||{}).textContent||'',
        firstBadge: (()=>{const b=document.querySelector('#logList li .badge');return b?b.textContent+'|'+b.className:''})(),
        passBadges: [...document.querySelectorAll('#logList li')].filter(li=>li.querySelector('.line.dash')).map(li=>{
          const b=li.querySelector('.badge');return b?b.textContent+':'+b.className:'-'}).join(','),
        consent: !document.getElementById('consentBar').classList.contains('hidden'),
        consentText: (document.getElementById('consentText')||{}).textContent||'',
        undoDisabled: document.getElementById('btnUndo').disabled,
        finishDisabled: document.getElementById('btnFinish').disabled,
        toolBtns: document.querySelectorAll('.row.tools button').length
      })`,
      returnByValue: true,
    });
    const data = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.data, 'base64'));
    console.log(name, m.result.value);
  }

  async function poll(expr, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.value) return true;
      await sleep(300);
    }
    return false;
  }
  async function text(expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result ? String(r.result.value == null ? '' : r.result.value) : '';
  }

  const g = await setupGame();
  const sess = JSON.stringify({ roomId: g.roomId, seat: 'A', token: g.tokenA });

  await shot('lobby');
  console.log('大厅：' + await text(`JSON.stringify({
    joinMax: document.getElementById('joinCode').maxLength,
    sec: document.getElementById('turnSeconds').value,
    rounds: document.getElementById('rounds').value,
    endlessGrouped: !!document.getElementById('rounds').closest('.formrow').contains(document.getElementById('endless'))
  })`));
  console.log('战至最后一刻联动：' + await text(`(function(){
    var e=document.getElementById('endless'), r=document.getElementById('rounds');
    e.checked=true; e.dispatchEvent(new Event('change')); var off=r.disabled;
    e.checked=false; e.dispatchEvent(new Event('change'));
    return '勾选后轮数禁用=' + off + ' ／ 取消后恢复=' + (r.disabled===false);
  })()`));
  /* 额外字上限必须跟着棋盘走：格数变了、hint 与 max 要一起变，超出的值要当场夹住。
     这里曾经写死成 289（17×17），5 路棋盘下会让玩家以为能填 289 个，实际只生效 25 个。 */
  console.log('额外字上限：' + await text(`(function(){
    var s=document.getElementById('size'), x=document.getElementById('extra'), h=document.getElementById('extraHint');
    function set(n){ s.value=n; s.dispatchEvent(new Event('input')); }
    var out=[];
    set(17); out.push('17路 '+h.textContent+'/max'+x.max);
    x.value='289'; set(5); out.push('降5路后 '+h.textContent+'/max'+x.max+'/值'+x.value);
    set(10); x.value='0'; out.push('复原 10路 '+h.textContent+'/max'+x.max);
    return out.join(' ／ ');
  })()`));
  /* 默认昵称应当是语料里的一位诗人，而不是写死的「赤营」 */
  console.log('默认昵称：' + await text(`(function(){
    var v=document.getElementById('nick').value, n=Array.from(v).length;
    return v + ' ／ 长度 ' + n + ' ／ 占位「' + document.getElementById('nick').placeholder + '」 ／ ' +
      (v && v !== '赤营' && v !== '青营' && n >= 2 && n <= 6 ? 'OK' : '!! 异常');
  })()`));
  /* 骰子图标：手写 SVG，不许退回 emoji；点一下要真的换人 */
  const nickBefore = await text(`document.getElementById('nick').value`);
  await text(`document.getElementById('btnReNick').click()`);
  await sleep(800);
  console.log('骰子重随：' + await text(`JSON.stringify((function(){
    var b=document.getElementById('btnReNick'), v=document.getElementById('nick').value;
    return {
      图标: b.querySelector('svg') ? 'SVG' : '!! 不是 SVG',
      无emoji: !/[\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF]/u.test(b.textContent),
      尺寸: Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height),
      原名: '${nickBefore}', 新名: v, 换成功: v !== '${nickBefore}'
    };
  })())`));
  await shot('game', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`);

  /* 记录滚到底：看「放弃本回合」的徽标与分隔线 */
  await send('Runtime.evaluate', { expression: `document.getElementById('logList').scrollTop = 99999` });
  await sleep(250);
  const lg = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'log-pass.png'), Buffer.from(lg.data, 'base64'));

  /* ---------- 导出截图（真实浏览器里跑 export.js） ---------- */
  await send('Runtime.evaluate', { expression: 'window.OLEXport && OLEXport.shot()' });
  const okShot = await poll(`!document.getElementById('shotOverlay').classList.contains('hidden')`, 20000);
  await sleep(700);
  console.log('导出截图：' + (okShot ? '已生成' : '!! 超时未出现预览') + ' ｜ ' + await text(`document.getElementById('shotMeta').textContent`));
  const sh = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'export-shot.png'), Buffer.from(sh.data, 'base64'));
  /* 顺手把原分辨率的 PNG 落盘（预览图缩放后看不清记录区的字，核对要用原图） */
  const shData = await send('Runtime.evaluate', {
    expression: `(async function(){
      var s = document.getElementById('shotImg').src || '';
      if(!s) return '';
      var b = await (await fetch(s)).blob();
      return await new Promise(function(res){
        var fr = new FileReader();
        fr.onload = function(){ res(String(fr.result).split(',')[1] || ''); };
        fr.readAsDataURL(b);
      });
    })()`,
    awaitPromise: true, returnByValue: true
  });
  const shB64 = shData.result && shData.result.value;
  if (shB64) fs.writeFileSync(path.join(OUT, 'export-shot-full.png'), Buffer.from(shB64, 'base64'));

  /* ---------- 导出 GIF（逐手回放，逐帧编码较慢，给足时间） ---------- */
  await send('Runtime.evaluate', { expression: 'OLEXport.close()' });
  await sleep(300);
  await send('Runtime.evaluate', { expression: 'OLEXport.gif()' });
  const okGif = await poll(`document.getElementById('shotKindTitle').textContent === '导出 GIF' && !document.getElementById('shotOverlay').classList.contains('hidden')`, 90000);
  await sleep(700);
  console.log('导出 GIF：' + (okGif ? '已生成' : '!! 超时未出现在预览') + ' ｜ ' + await text(`document.getElementById('shotMeta').textContent`));
  const gf = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'export-gif.png'), Buffer.from(gf.data, 'base64'));
  await send('Runtime.evaluate', { expression: 'OLEXport.close()' });

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await shot('mobile', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(sess)});}catch(e){}`);
  console.log('手机端首屏：' + await text(`JSON.stringify((function(){
    var b=document.getElementById('btnSubmit').getBoundingClientRect();
    var t=document.getElementById('poem').getBoundingClientRect();
    var c=document.getElementById('clock').getBoundingClientRect();
    return {屏高:innerHeight, 录入框底:Math.round(t.bottom), 时钟顶:Math.round(c.top),
            提交按钮底:Math.round(b.bottom), 首屏放得下:b.bottom<=innerHeight,
            文档高:document.scrollingElement.scrollHeight};
  })())`));
  /* A/B：把手机端压缩样式临时撤掉，量一下"旧布局"要把提交按钮推到多远 */
  console.log('对照（旧手机布局）：' + await text(`JSON.stringify((function(){
    var st=document.createElement('style');
    st.textContent='@media (max-width:760px){.scorelegend{display:flex!important}.dup{display:block!important}'+
      '.wrap{padding:20px!important}.boardwrap{padding:14px!important}.card .pad{padding:14px 16px!important}'+
      '.loglist{max-height:46vh!important}.team{padding:7px 13px!important;font-size:13px!important}'+
      '.clock{font-size:24px!important;padding:2px 10px!important}textarea{font-size:17px!important;min-height:64px!important}}';
    document.head.appendChild(st);
    var b=document.getElementById('btnSubmit').getBoundingClientRect();
    var r={提交按钮底:Math.round(b.bottom)};
    st.remove(); return r;
  })())`));
  await shot('mobile-lobby', `try{sessionStorage.removeItem('feihua-ol');}catch(e){}`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // 等待对手
  const solo = await api('/api/create', { nick: '独坐', size: 8, rounds: 15 });
  await shot('waiting', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: solo.roomId, seat: 'A', token: solo.token }))});}catch(e){}`);

  // 双方到齐、只有一方准备 —— 准备条的真实状态
  const rd = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20 });
  const rd2 = await api('/api/join', { roomId: rd.roomId, nick: '青岚' });
  await api('/api/room/' + rd.roomId + '/ready', { t: rd.token, ready: true });
  await shot('ready', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: rd.roomId, seat: 'A', token: rd.token }))});}catch(e){}`);
  console.log('准备条：' + await text(`JSON.stringify((function(){
    var b=document.getElementById('readyBar');
    return {显示:!b.classList.contains('hidden'),
      A:document.getElementById('readyA').textContent,
      B:document.getElementById('readyB').textContent,
      按钮:document.getElementById('btnReady').textContent,
      棋盘可见:document.getElementById('board').getBoundingClientRect().height>0};
  })())`));

  // 暂停态：A 点暂停，看暂停条与冻结的时钟
  await api('/api/room/' + rd.roomId + '/ready', { t: rd2.token, ready: true });
  await api('/api/room/' + rd.roomId + '/pause', { t: rd2.token });
  await shot('paused', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: rd.roomId, seat: 'A', token: rd.token }))});}catch(e){}`);
  console.log('暂停态：' + await text(`JSON.stringify((function(){
    return {显示:!document.getElementById('pauseBar').classList.contains('hidden'),
      文案:document.getElementById('pauseText').textContent,
      暂停按钮:document.getElementById('btnPause').textContent,
      时钟:document.getElementById('clock').textContent};
  })())`));

  // 结算面板：5 路、1 轮，两手下完
  const r5 = await api('/api/create', { nick: '阿墨', size: 5, rounds: 1 });
  const j5 = await api('/api/join', { roomId: r5.roomId, nick: '青岚' });
  await api('/api/room/' + r5.roomId + '/ready', { t: r5.token, ready: true });
  await api('/api/room/' + r5.roomId + '/ready', { t: j5.token, ready: true });
  let s5 = await state(r5.roomId, r5.token);
  const u5 = new Set();
  for (let i = 0; i < 6 && s5.phase === 'playing'; i++) {
    const ln = pickLine(s5, u5, i + 11);
    if (!ln) break;
    u5.add(ln);
    await api('/api/room/' + r5.roomId + '/move', { t: s5.turn === 'A' ? r5.token : j5.token, text: ln });
    s5 = await state(r5.roomId, r5.token);
  }
  console.log('结算房间 phase =', s5.phase, s5.reason);
  await shot('end', `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify({ roomId: r5.roomId, seat: 'A', token: r5.token }))});}catch(e){}`);

  /* ---- 观众 / 换人 / 未收录裁决 ---- */
  const sessJs = (o) => `try{sessionStorage.setItem('feihua-ol', ${JSON.stringify(JSON.stringify(o))});}catch(e){}`;
  const vw = await api('/api/create', { nick: '阿墨', size: 10, rounds: 20 });
  const vw2 = await api('/api/join', { roomId: vw.roomId, nick: '青岚' });
  await api('/api/room/' + vw.roomId + '/ready', { t: vw.token, ready: true });
  await api('/api/room/' + vw.roomId + '/ready', { t: vw2.token, ready: true });
  let vs = await state(vw.roomId, vw.token);
  const vu = new Set();
  for (let i = 0; i < 6; i++) {
    const ln = pickLine(vs, vu, i + 21); if (!ln) break; vu.add(ln);
    await api('/api/room/' + vw.roomId + '/move', { t: vs.turn === 'A' ? vw.token : vw2.token, text: ln });
    vs = await state(vw.roomId, vw.token);
  }
  const watcher = await api('/api/join', { roomId: vw.roomId, nick: '看客' });
  await shot('spectator', sessJs({ roomId: vw.roomId, seat: null, token: watcher.token }));
  console.log('观众视角：' + await text(`JSON.stringify({
    观众条: !document.getElementById('watchBox').classList.contains('hidden'),
    提示: document.getElementById('watchHint').textContent,
    录入框隐藏: document.getElementById('poem').classList.contains('hidden'),
    提交按钮隐藏: document.getElementById('playRow').classList.contains('hidden'),
    下场按钮隐藏: document.getElementById('btnStand').classList.contains('hidden'),
    座位按钮: [...document.querySelectorAll('#watchBox button')].filter(b=>!b.classList.contains('hidden')).map(b=>b.textContent),
    提示语: document.getElementById('turnWho').textContent
  })`));

  /* 未收录句：变成待裁决，计时冻结 */
  const curTok = vs.turn === 'A' ? vw.token : vw2.token;
  const oppTok = vs.turn === 'A' ? vw2.token : vw.token;
  await api('/api/room/' + vw.roomId + '/move', { t: curTok, text: '魑魅魍魉饕餮' });
  await shot('dispute-judge', sessJs({ roomId: vw.roomId, seat: vs.turn === 'A' ? 'B' : 'A', token: oppTok }));
  console.log('裁决方视角：' + await text(`JSON.stringify({
    争议条: !document.getElementById('disputeBar').classList.contains('hidden'),
    文案: document.getElementById('disputeText').textContent,
    有效按钮: !document.getElementById('btnValid').classList.contains('hidden'),
    撤回按钮隐藏: document.getElementById('btnWithdraw').classList.contains('hidden'),
    时钟: document.getElementById('clock').textContent,
    时钟类: document.getElementById('clock').className
  })`));
  await shot('dispute-mine', sessJs({ roomId: vw.roomId, seat: vs.turn, token: curTok }));
  console.log('提交方视角：' + await text(`JSON.stringify({
    争议条: !document.getElementById('disputeBar').classList.contains('hidden'),
    只有撤回: document.getElementById('btnValid').classList.contains('hidden') && !document.getElementById('btnWithdraw').classList.contains('hidden'),
    计时文案: document.getElementById('turnWho').textContent
  })`));

  /* 观众看同一句争议：只读，不能出现任何裁决按钮 */
  await shot('dispute-watcher', sessJs({ roomId: vw.roomId, seat: null, token: watcher.token }));
  console.log('观众看争议：' + await text(`JSON.stringify({
    争议条: !document.getElementById('disputeBar').classList.contains('hidden'),
    有效按钮隐藏: document.getElementById('btnValid').classList.contains('hidden'),
    重填按钮隐藏: document.getElementById('btnRetry').classList.contains('hidden'),
    撤回按钮隐藏: document.getElementById('btnWithdraw').classList.contains('hidden'),
    操作区隐藏: document.getElementById('disputeBtns').classList.contains('hidden'),
    文案: document.getElementById('disputeText').textContent
  })`));

  /* 成员面板 / 事件面板 */
  await shot('room-members', sessJs({ roomId: vw.roomId, seat: vs.turn, token: curTok }));
  console.log('成员面板：' + await text(`JSON.stringify({
    数量: document.getElementById('memCount').textContent,
    行数: document.querySelectorAll('#memList li').length,
    行: [...document.querySelectorAll('#memList li')].map(li => li.textContent.replace(/\\s+/g,' ').trim()),
    有改名按钮: !!document.querySelector('#memList button[data-act="nick"]'),
    有移出按钮: !!document.querySelector('#memList button[data-act="kick"]')
  })`));
  console.log('事件面板：' + await text(`JSON.stringify({
    数量: document.getElementById('evCount').textContent,
    行数: document.querySelectorAll('#evList li').length,
    最新三条: [...document.querySelectorAll('#evList li')].slice(0,3).map(li => li.textContent.replace(/\\s+/g,' ').trim())
  })`));
  await text(`document.getElementById('tabEvents').click()`);
  await sleep(150);
  console.log('切到事件页签：' + await text(`JSON.stringify({
    成员列表隐藏: document.getElementById('memList').classList.contains('hidden'),
    事件列表可见: !document.getElementById('evList').classList.contains('hidden'),
    页签高亮: document.getElementById('tabEvents').classList.contains('on')
  })`));
  /* 单独截一张「事件页签」：注入会话的同时在加载后自动切过去 */
  await shot('room-events', sessJs({ roomId: vw.roomId, seat: vs.turn, token: curTok }) +
    `;window.addEventListener('load',function(){setTimeout(function(){var b=document.getElementById('tabEvents');if(b)b.click();},260);});`);

  /* 选手下场 → 缺人暂停 → 观众补位 */
  await api('/api/room/' + vw.roomId + '/stand', { t: vw.token });
  await shot('seat-empty', sessJs({ roomId: vw.roomId, seat: 'B', token: vw2.token }));
  console.log('缺人暂停：' + await text(`JSON.stringify({
    暂停条: !document.getElementById('pauseBar').classList.contains('hidden'),
    文案: document.getElementById('pauseText').textContent,
    继续按钮隐藏: document.getElementById('btnResume').classList.contains('hidden'),
    提示语: document.getElementById('turnWho').textContent
  })`));
  await api('/api/room/' + vw.roomId + '/seat', { t: watcher.token, seat: 'A' });
  await shot('seat-taken', sessJs({ roomId: vw.roomId, seat: 'A', token: watcher.token }));
  console.log('补位后：' + await text(`JSON.stringify({
    暂停条隐藏: document.getElementById('pauseBar').classList.contains('hidden'),
    你: document.querySelector('#teamA .nm').textContent,
    观众条隐藏: document.getElementById('watchBox').classList.contains('hidden')
  })`));

  /* ---------- 开局设置 / 实时预览 / 命中动画 / 裁判 ---------- */
  /* 设置面板只该在「正式开局前」出现：选手能改、观众只读。 */
  const st1 = await api('/api/create', { size: 12, rounds: 18, turnSeconds: 90, nick: '设甲' });
  const st2 = await api('/api/join', { roomId: st1.roomId, nick: '设乙' });
  const stW = await api('/api/join', { roomId: st1.roomId, nick: '设观' });
  await shot('setup-owner', sessJs({ roomId: st1.roomId, seat: 'A', token: st1.token }));
  console.log('设置面板（房主）：' + await text(`JSON.stringify({
    显示: !document.getElementById('setupBox').classList.contains('hidden'),
    尺寸: document.getElementById('cfgSize').value,
    轮数: document.getElementById('cfgRounds').value,
    每手: document.getElementById('cfgSeconds').value,
    可编辑: !document.getElementById('cfgSize').disabled,
    提示: document.getElementById('setupHint').textContent
  })`));
  await shot('setup-watcher', sessJs({ roomId: st1.roomId, seat: null, token: stW.token }));
  console.log('设置面板（观众只读）：' + await text(`JSON.stringify({
    显示: !document.getElementById('setupBox').classList.contains('hidden'),
    可编辑: !document.getElementById('cfgSize').disabled,
    应用按钮禁用: document.getElementById('btnApplyCfg').disabled,
    重抽按钮禁用: document.getElementById('btnRedraw').disabled,
    提示: document.getElementById('setupHint').textContent
  })`));

  /* 手机上的设置面板：四个数字框要能挤进 390px，且「应用设置」在首屏 */
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await shot('setup-mobile', sessJs({ roomId: st1.roomId, seat: 'A', token: st1.token }));
  console.log('设置面板（手机）：' + await text(`JSON.stringify({
    横向溢出: document.scrollingElement.scrollWidth - innerWidth,
    面板宽: Math.round(document.getElementById('setupBox').getBoundingClientRect().width),
    栅格列数: getComputedStyle(document.querySelector('.sgrid')).gridTemplateColumns.split(' ').length,
    应用按钮在首屏: document.getElementById('btnApplyCfg').getBoundingClientRect().bottom <= innerHeight,
    棋盘格数: document.getElementById('board').children.length
  })`));
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

  /* 改设置 + 重抽棋盘：服务端应重铺棋盘，并让双方重新准备 */
  await api('/api/room/' + st1.roomId + '/ready', { t: st1.token, ready: true });
  const before = await state(st1.roomId, st1.token);
  const cfged = await api('/api/room/' + st1.roomId + '/cfg', { t: st1.token, size: 9, extra: 12, rounds: 14 });
  const redrew = await api('/api/room/' + st1.roomId + '/redraw', { t: st1.token });
  const after = await state(st1.roomId, st1.token);
  console.log('改设置+重抽：' + JSON.stringify({
    cfg: cfged.ok, size: after.size, charsLen: after.chars.length, extra: after.cfg.extra,
    redraw: redrew.ok, 字变了: after.chars !== before.chars,
    准备被重置: after.ready.A === false && after.ready.B === false,
  }));

  /* 预览：输入一句 → 命中格刷成当前方的半透明墨色；清空 → 全部收回 */
  const pvA = await api('/api/create', { size: 10, nick: '探甲' });
  const pvB = await api('/api/join', { roomId: pvA.roomId, nick: '探乙' });
  await api('/api/room/' + pvA.roomId + '/ready', { t: pvA.token, ready: true });
  await api('/api/room/' + pvA.roomId + '/ready', { t: pvB.token, ready: true });
  await shot('preview', sessJs({ roomId: pvA.roomId, seat: 'A', token: pvA.token }));
  /* 把字数打进输入框后先拍一张 —— 预览色是这一刻才存在的，重载页面就没了 */
  const pvPick = await text(`(function(){
    var st=OL.state(), pick=[];
    for(var i=0;i<st.chars.length && pick.length<6;i++){ if(pick.indexOf(st.chars[i])<0) pick.push(st.chars[i]); }
    var t=document.getElementById('poem');
    t.value=pick.join(''); t.dispatchEvent(new Event('input'));
    return pick.join('');
  })()`);
  await sleep(350);
  const pvShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'preview-on.png'), Buffer.from(pvShot.data, 'base64'));
  console.log('实时预览：' + await text(`(function(){
    var nPv=document.querySelectorAll('.cell.pv-A').length;
    var nNew=document.querySelectorAll('.cell.pv-A.pv-new').length;
    var h=document.getElementById('pvHint');
    var hint=h.classList.contains('hidden')?'(隐藏)':h.textContent;
    var t=document.getElementById('poem');
    t.value=''; t.dispatchEvent(new Event('input'));
    var nClear=document.querySelectorAll('.cell.pv-A').length;
    return JSON.stringify({输入:'${pvPick}', 预览格:nPv, 新占:nNew, 提示:hint, 清空后:nClear});
  })()`));

  /* 命中动画：落一手之后，变化的格子要带 .flash（白描边），1.1 秒后自动褪 */
  const pvSt = await state(pvA.roomId, pvA.token);
  const pvLine = pickLine(pvSt, new Set(), 11);
  await api('/api/room/' + pvA.roomId + '/move', { t: pvA.token, text: pvLine });
  await sleep(450);
  const flShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'flash.png'), Buffer.from(flShot.data, 'base64'));
  const fl = await text(`JSON.stringify({
    闪格: document.querySelectorAll('#board .cell.flash').length,
    已落子: document.querySelectorAll('#board .cell.own-A').length > 0
  })`);
  await sleep(900);
  const fl2 = await text(`document.querySelectorAll('#board .cell.flash').length`);
  console.log('命中动画：落子后 ' + fl + ' ｜ 1.4 秒后剩 ' + fl2 + ' 格');

  /* 抢夺预览：这手已经落在盘上，轮到对方输入同一句 → 应显示虚线「抢夺」框 */
  await sleep(1200);
  await shot('preview-cap', sessJs({ roomId: pvA.roomId, seat: 'B', token: pvB.token }));
  await text(`(function(){ var t=document.getElementById('poem'); t.value='${pvLine}'; t.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(300);
  const capShot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'preview-cap-on.png'), Buffer.from(capShot.data, 'base64'));
  const capSv = await text(`JSON.stringify((function(){
    var st=OL.state(), t=document.getElementById('poem');
    if(st.turn !== 'B') return {跳过:'不是青的回合 turn=' + st.turn};
    var hit={cap:document.querySelectorAll('.cell.pv-B.pv-cap').length,
             hold:document.querySelectorAll('.cell.pv-B.pv-hold').length,
             fresh:document.querySelectorAll('.cell.pv-B.pv-new').length};
    var h=document.getElementById('pvHint');
    hit.提示=h.classList.contains('hidden')?'(隐藏)':h.textContent;
    t.value=''; t.dispatchEvent(new Event('input'));
    return hit;
  })())`);
  console.log('抢夺预览：' + capSv);

  /* 裁判：选手把观众标成裁判 → 该观众拿到暂停 / 撤销 / 结算 / 裁决权 */
  const refA = await api('/api/create', { size: 10, nick: '裁甲' });
  const refB = await api('/api/join', { roomId: refA.roomId, nick: '裁乙' });
  const refW = await api('/api/join', { roomId: refA.roomId, nick: '裁观' });
  const midW = (await state(refA.roomId, refA.token)).members.find((m) => m.nick === '裁观').mid;
  await api('/api/room/' + refA.roomId + '/ready', { t: refA.token, ready: true });
  await api('/api/room/' + refA.roomId + '/ready', { t: refB.token, ready: true });
  /* 先飞一手，撤销栈里才有东西 —— 否则「能撤销」永远是 false，测不出名堂 */
  const refLine = pickLine(await state(refA.roomId, refA.token), new Set(), 13);
  await api('/api/room/' + refA.roomId + '/move', { t: refA.token, text: refLine });
  const setRefR = await api('/api/room/' + refA.roomId + '/ref', { t: refA.token, mid: midW, on: true });
  await shot('referee', sessJs({ roomId: refA.roomId, seat: null, token: refW.token }));
  console.log('裁判视角：' + await text(`JSON.stringify({
    设裁判: ${setRefR.ok},
    裁判条: !document.getElementById('refBar').classList.contains('hidden'),
    文案: document.getElementById('refText').textContent,
    能撤销: !document.getElementById('btnUndo').disabled,
    能结算: !document.getElementById('btnFinish').disabled,
    能暂停: !document.getElementById('btnPause').disabled,
    不能出手: document.getElementById('btnSubmit').disabled && document.getElementById('poem').readOnly,
    成员标签: [...document.querySelectorAll('#memList .mtag')].map(x=>x.textContent).filter(t=>t==='裁判').length
  })`));
  /* 裁判暂停 → 选手那边应当看到「已暂停」 */
  const rp = await api('/api/room/' + refA.roomId + '/pause', { t: refW.token });
  const stAfterPause = await state(refA.roomId, refA.token);
  console.log('裁判暂停：' + JSON.stringify({
    ok: rp.ok, paused: !!stAfterPause.paused, byRef: !!stAfterPause.paused.byRef,
    byNick: stAfterPause.paused.byNick,
  }));
  await api('/api/room/' + refA.roomId + '/pause', { t: refW.token });
  /* 选手把裁判撤掉 → 立刻失去权限 */
  await api('/api/room/' + refA.roomId + '/ref', { t: refA.token, mid: midW, on: false });
  const off = await state(refA.roomId, refW.token);
  console.log('取消裁判：' + JSON.stringify({ youRef: off.youRef, canControl: off.canControl }));

  /* ================= 本轮：大厅改版 / 结算导出 GIF / 事件昵称着色 / 说词儿 ================= */

  /* ① 大厅：右栏是「当前房间」、左栏是「开一局」，列表不再自己滚（把整页撑长）
     必须先清掉 sessionStorage —— 否则上一个用例留下的身份会让页面直接回到牌桌 */
  await shot('lobby-v2', `try{sessionStorage.clear();}catch(e){}`);
  await sleep(600);
  console.log('大厅改版：' + await text(`JSON.stringify((function(){
    var lobby=document.getElementById('lobby');
    var list=document.getElementById('roomList');
    var roomCard=list.closest('.card').getBoundingClientRect();
    var makeCard=document.getElementById('btnCreate').closest('.card').getBoundingClientRect();
    return {
      列: getComputedStyle(lobby).gridTemplateColumns,
      标题s: [...lobby.querySelectorAll('.sec-title')].map(function(t){return t.textContent.replace(/\\s+/g,'').slice(0,6)}),
      房间卡在右: Math.round(roomCard.left) > Math.round(makeCard.left),
      列表不限高: list.scrollHeight <= list.clientHeight + 2,
      列表overflowY: getComputedStyle(list).overflowY,
      语料统计已移除: !document.getElementById('corpusStat') && !document.body.textContent.includes('万句'),
      反馈入口: !!document.getElementById('btnFbLobby'),
      房号入口: !!document.getElementById('joinCode') && !!document.getElementById('btnJoin')
    };
  })())`));

  /* ② 结算弹窗要有「导出 GIF」，且点了真的会生成（标题切换成「导出 GIF」） */
  await shot('end-gif', sessJs({ roomId: r5.roomId, seat: 'A', token: r5.token }));
  await sleep(500);
  const endBtns = await text(`JSON.stringify([...document.querySelectorAll('#endOverlay button')].map(b=>b.textContent))`);
  await text(`document.getElementById('btnEndGif').click()`);
  const gifSoon = await poll(`!document.getElementById('shotOverlay').classList.contains('hidden')`, 45000);
  await sleep(600);
  console.log('结算导出：' + JSON.stringify({
    按钮: JSON.parse(endBtns),
    GIF生成: gifSoon,
    预览标题: await text(`document.getElementById('shotKindTitle').textContent`),
  }));
  const gs = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'end-gif.png'), Buffer.from(gs.data, 'base64'));

  /* ③ 事件记录里昵称着色：选手赤/青、裁判棕色 */
  await api('/api/room/' + refA.roomId + '/ref', { t: refA.token, mid: midW, on: true });
  await shot('events-color', sessJs({ roomId: refA.roomId, seat: 'A', token: refA.token }));
  await text(`document.getElementById('tabEvents').click()`);
  await sleep(400);
  console.log('事件昵称着色：' + await text(`JSON.stringify((function(){
    var q=function(s){return document.querySelectorAll('#evList '+s).length};
    var col=function(s){var e=document.querySelector('#evList '+s);return e?getComputedStyle(e).color:'-'};
    return {
      赤位名: q('.ev-n-a'), 青位名: q('.ev-n-b'), 裁判名: q('.ev-n-ref'),
      赤色: col('.ev-n-a'), 青色: col('.ev-n-b'), 棕色: col('.ev-n-ref'),
      有色昵称次数: document.querySelectorAll('#evList .ev-n-a').length +
                    document.querySelectorAll('#evList .ev-n-b').length +
                    document.querySelectorAll('#evList .ev-n-ref').length
    };
  })())`));
  const ec = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'events-color.png'), Buffer.from(ec.data, 'base64'));

  /* ④ 「等 xx 说词儿」＋轮到自己时输入框不再显示「等对方」 */
  const tw = await api('/api/create', { size: 10, nick: '词儿甲' });
  const tw2 = await api('/api/join', { roomId: tw.roomId, nick: '词儿乙' });
  await api('/api/room/' + tw.roomId + '/ready', { t: tw.token, ready: true });
  await api('/api/room/' + tw.roomId + '/ready', { t: tw2.token, ready: true });
  await shot('turn-a', sessJs({ roomId: tw.roomId, seat: 'A', token: tw.token }));
  const whenMine = await text(`JSON.stringify({提示:document.getElementById('turnWho').textContent,占位:document.getElementById('poem').placeholder,可输入:!document.getElementById('poem').readOnly})`);
  await shot('turn-b', sessJs({ roomId: tw.roomId, seat: 'B', token: tw2.token }));
  const whenOther = await text(`JSON.stringify({提示:document.getElementById('turnWho').textContent,占位:document.getElementById('poem').placeholder,只读:document.getElementById('poem').readOnly})`);
  console.log('轮到谁说词儿：' + JSON.stringify({ 我方回合: JSON.parse(whenMine), 对方回合: JSON.parse(whenOther) }));

  if (errors.length) console.log('!! 页面报错：\n' + errors.join('\n'));
  else console.log('页面无 JS 报错');

  ws.close();
  chrome.kill();
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
