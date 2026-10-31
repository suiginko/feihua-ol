'use strict';
/* 断掉的 SSE 连接不能再写 —— 回归测试。
 *
 *   node tools/test_sse_dead.js
 *
 * 线上两次（2026-10-22 23:48、10-23 16:08）刷出一串
 *   `Error [ERR_STREAM_WRITE_AFTER_END]: write after end`
 * 栈都落在 `Timeout._onTimeout` → 广播/心跳对已经结束的响应调用 res.write()。
 *
 * 关键点：**这个错误是异步抛的**（内部走 nextTick 触发 'error' 事件），
 * 包在 try/catch 里根本接不住 —— 只能写之前先看 `writableEnded / destroyed`，
 * 顺手把死连接从 clients 里摘掉。
 *
 * 分两层验：
 *   ① 确定性：`/api/_test_sse_write`（TEST_HOOKS=1）直接喂 ended / destroyed / 不可写的假 res，
 *      保护没了我立刻红 —— 这一层是真回归锁；
 *   ② 场景化：掐断连接、连开 8 条死连接再连打 30 次广播，进程不许崩、别人不许受影响。
 *      （注意：正常断开时服务端的 close 回调会先把连接摘掉，所以这一层在「保护被删掉」的情况下
 *       也可能通过 —— 它锁的是「断线风暴不连累别人」，不是那个竞态本身。）
 */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

let PORT = 0, BASE = '', child = null, dataDir = '';
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
    try {
      const r = await fetch(BASE + '/api/stats', { cache: 'no-store' });
      if (r.ok) { const d = await r.json(); if (d && d.pid === child.pid) return true; }
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}
function killChild() {
  if (!child) return;
  try { child.kill(); } catch (_) {}
  child = null;
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const KEY = require('fs').readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim();
const crashes = async () => ((await get('/api/boot?key=' + KEY)).d.crashes || []).length;

/* 开一条 SSE 连接，返回 { abort, gotFrame() } */
function openSSE(roomId, t) {
  const ctl = new AbortController();
  let frames = 0;
  const p = fetch(BASE + '/api/room/' + roomId + '/events?t=' + encodeURIComponent(t), { signal: ctl.signal })
    .then(async (res) => {
      const rd = res.body.getReader();
      for (;;) {
        const { done } = await rd.read();
        if (done) break;
        frames++;
      }
    })
    .catch(() => {});
  return { abort: () => { try { ctl.abort(); } catch (_) {} }, frames: () => frames, done: p };
}

(async () => {
  try {
    for (let p = 8970; p <= 8999; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    BASE = 'http://127.0.0.1:' + PORT;
    dataDir = tmpDir('test-sse-dead-' + PORT);
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: dataDir, SWEEP_MS: '600000', TEST_HOOKS: '1',
      }),
      stdio: 'ignore',
    });
    if (!(await waitUp(40000))) throw new Error('实例没起来');
    await sleep(200);

    /* ---------- 0) 确定性：写死了的响应一律不写 ---------- */
    const hook = await post('/api/_test_sse_write', {});
    check('对 writableEnded 的响应不写', hook.d.ended === false, hook.d);
    check('对 destroyed 的响应不写', hook.d.destroyed === false, hook.d);
    check('对 writable:false 的响应不写', hook.d.halfClosed === false, hook.d);
    check('传 null 也不炸', hook.d.nullish === false, hook.d);
    check('正常的连接照写（保护不能做成「一律不写」）', hook.d.alive === true, hook.d);

    const cr = await post('/api/create', { nick: '甲', size: 6, extra: 0, playerCount: 2 });
    const roomId = cr.d.roomId, tA = cr.d.token;
    const jB = await post('/api/join', { roomId: roomId, nick: '乙' });
    const tB = jB.d.token;
    check('房间与两名选手就绪', !!roomId && !!tA && !!tB, [roomId, !!tA, !!tB]);

    const before = await crashes();

    /* ---------- 1) 掐断连接后继续广播：不许冒出 write after end ---------- */
    const dead = openSSE(roomId, tA);
    await sleep(500);
    check('死连接确实收到过帧', dead.frames() > 0, dead.frames());
    dead.abort();
    await sleep(300);

    for (let i = 0; i < 12; i++) {
      await post('/api/room/' + roomId + '/beat', { t: tB });
      await sleep(30);
    }
    await sleep(400);
    const after = await crashes();
    check('断线后广播没有制造新的崩溃记录', after === before, [before, after]);

    const st = await get('/api/stats');
    check('进程还活着（/api/stats 仍然 200）', st.status === 200 && st.d.pid === child.pid, st.status);

    /* ---------- 2) 死连接被摘掉：活着的那个还能收到推送 ---------- */
    const live = openSSE(roomId, tB);
    await sleep(600);
    const framesBefore = live.frames();
    await post('/api/room/' + roomId + '/ready', { t: tB, ready: true });
    await sleep(500);
    check('另一个人的连接照常收到推送', live.frames() > framesBefore, [framesBefore, live.frames()]);
    live.abort();
    await sleep(200);

    /* ---------- 3) 一堆死连接 + 一堆广播：进程不许被拖死 ---------- */
    const zombies = [];
    for (let i = 0; i < 8; i++) { zombies.push(openSSE(roomId, tB)); }
    await sleep(700);
    for (const z of zombies) z.abort();
    await sleep(300);
    const before2 = await crashes();
    for (let i = 0; i < 30; i++) {
      await post('/api/room/' + roomId + '/beat', { t: tB });
      await sleep(20);
    }
    await sleep(400);
    check('8 条死连接连打 30 次广播，也没有新崩溃', (await crashes()) === before2, [before2, await crashes()]);
    const st2 = await get('/api/stats');
    check('之后服务仍然正常', st2.status === 200 && st2.d.rooms >= 1, [st2.status, st2.d.rooms]);

    /* ---------- 4) 内存观测字段在（这次 504 事故的取证入口） ---------- */
    check('stats 回 heapLimit', Number(st2.d.heapLimit) > 0, st2.d.heapLimit);
    check('stats 回 rssPeak', Number(st2.d.rssPeak) >= Number(st2.d.rss) - 5, [st2.d.rss, st2.d.rssPeak]);

    console.log('');
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    killChild();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('异常：' + (e && e.stack || e));
    killChild();
    process.exit(1);
  }
})();
