'use strict';
/* 崩溃兜底 —— 回归测试
 *
 *   node tools/test_crash.js
 *
 * 背景（2026-10-22）：早上 10:08 线上进程死了，容器没有被重新拉起，
 * 网关只能「等 30 秒 → 504」，整站断了三个小时。`boot.log` 里一条新记录都没有，
 * console 输出又拿不到 —— 等于什么都没留下。这个脚本锁三件事：
 *
 *   1) 未捕获异常 / 未处理拒绝 **不再让进程退出**（默认行为），而且栈会落进 crash.log，
 *      `/api/boot` 的 crashes 能读到；
 *   2) 畸形请求（`new URL()` 会同步抛的那类）只影响那一个请求，进程照常服务、
 *      房间状态也不会丢；
 *   3) `/api/_test_throw` 这个测试钩子只在 TEST_HOOKS=1 时存在，线上不该有它。
 */

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'crash-test-key';
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? ''
      : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

function portFree(port) {
  return new Promise((res) => {
    const probe = net.connect({ port, host: '127.0.0.1' });
    probe.once('connect', () => { probe.destroy(); res(false); });
    probe.once('error', () => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(port, '127.0.0.1');
    });
  });
}

async function freePort(from, to) {
  for (let p = from; p <= to; p++) if (await portFree(p)) return p;
  throw new Error('找不到空闲端口');
}

async function boot(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port), ADMIN_KEY: KEY, SWEEP_MS: '500' }, env || {}),
    stdio: 'ignore',
  });
  const base = 'http://127.0.0.1:' + port;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(base + '/api/stats', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d && d.pid === child.pid) return { child, base, pid: child.pid };
      }
    } catch (_) { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('实例没起来（端口 ' + port + '）');
}

function kill(child) { try { child.kill(); } catch (_) {} }

/* 裸 TCP：发一条 Node 的 HTTP 解析器能接受、但请求处理里会抛的请求。
   两个真实向量：
   ① Host 头带空格 → 'http://bad host' 是非法基准 URL，`new URL()` 同步抛；
   ② 路径里放不完整的百分号转义 → `serveStatic()` 里的 `decodeURIComponent` 抛 URIError。 */
function rawReq(port, head) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.write(head); });
    let buf = '';
    s.setTimeout(5000, () => { s.destroy(); resolve(buf); });
    s.on('data', (d) => { buf += d.toString(); });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
  });
}
const rawBadHost = (port) => rawReq(port, 'GET / HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n');
const rawBadEscape = (port) => rawReq(port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');

async function stats(base) {
  const r = await fetch(base + '/api/stats', { cache: 'no-store' });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}

(async () => {
  const dir = tmpDir('test-crash');
  const port = await freePort(8861, 8879);
  const { child, base, pid } = await boot(port, { DATA_DIR: dir, TEST_HOOKS: '1' });

  try {
    /* ---------- 1) stats 带上内存观测 ---------- */
    let st = await stats(base);
    check('/api/stats 正常', st.status === 200 && st.d.pid === pid, st.d);
    check('/api/stats 回报 rss（内存观测点）', typeof st.d.rss === 'number' && st.d.rss > 0, st.d.rss);
    check('/api/stats 回报 heapUsed', typeof st.d.heapUsed === 'number' && st.d.heapUsed > 0, st.d.heapUsed);

    /* ---------- 2) 先建一间房，后面用它验「状态没丢」 ---------- */
    const cr = await fetch(base + '/api/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nick: '崩溃测试房主' }),
    }).then((r) => r.json());
    check('测试房建成', cr.ok === true, cr.reason);
    const roomId = cr.roomId;

    /* ---------- 3) 未捕获异常：进程必须活着 ---------- */
    const t1 = await fetch(base + '/api/_test_throw', { method: 'POST' }).then((r) => r.json()).catch((e) => ({ err: e.message }));
    check('测试钩子可用（TEST_HOOKS=1）', t1.ok === true, t1);
    await sleep(600);                       /* 让那个 setTimeout 里的 throw 真的执行 */
    st = await stats(base);
    check('未捕获异常之后进程还活着（同一个 pid）', st.status === 200 && st.d.pid === pid, st.d);
    let boot = await fetch(base + '/api/boot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
    let crashes = boot.crashes || [];
    check('crash.log 里记下了这次未捕获异常', crashes.some((c) => c.kind === 'uncaught'), crashes.map((c) => c.kind));
    const c0 = crashes[crashes.length - 1] || {};
    check('记录里有错误信息', /测试用的未捕获异常/.test(c0.msg || ''), c0.msg);
    check('记录里有调用栈', /Error/.test(c0.stack || ''), (c0.stack || '').slice(0, 60));
    check('记录里带当时的内存与房间数', c0.rssMB > 0 && c0.rooms >= 1, { rssMB: c0.rssMB, rooms: c0.rooms });

    /* ---------- 4) 未处理的 Promise 拒绝：同样不死 ---------- */
    await fetch(base + '/api/_test_throw?mode=rejection', { method: 'POST' });
    await sleep(600);
    st = await stats(base);
    check('未处理的 Promise 拒绝之后进程还活着', st.status === 200 && st.d.pid === pid, st.d);
    boot = await fetch(base + '/api/boot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
    check('crash.log 里记下了这次拒绝', (boot.crashes || []).some((c) => c.kind === 'rejection'),
      (boot.crashes || []).map((c) => c.kind));

    /* ---------- 5) 畸形请求：只坏那一条 ---------- */
    const raw = await rawBadHost(port);
    check('畸形 Host 的请求收到了响应（不是进程消失）', /HTTP\/1\.[01]/.test(raw), raw.slice(0, 40));
    st = await stats(base);
    check('畸形请求之后进程还活着', st.status === 200 && st.d.pid === pid, st.d);
    boot = await fetch(base + '/api/boot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
    check('畸形请求被请求层的兜底接住了（kind=request）',
      (boot.crashes || []).some((c) => c.kind === 'request'),
      (boot.crashes || []).map((c) => c.kind));

    /* ---------- 5b) 另一个向量：静态路径里不完整的百分号转义 ---------- */
    const raw2 = await rawBadEscape(port);
    check('畸形转义的静态请求收到了响应', /HTTP\/1\.[01]/.test(raw2), raw2.slice(0, 40));
    st = await stats(base);
    check('畸形转义之后进程还活着', st.status === 200 && st.d.pid === pid, st.d);

    /* ---------- 6) 状态没丢：房间还在 ---------- */
    const rooms = await fetch(base + '/api/rooms').then((r) => r.json());
    check('崩溃之后房间还在（状态没被清空）', (rooms.rooms || []).some((r) => r.id === roomId),
      (rooms.rooms || []).map((r) => r.id));
    check('房间里的房主还在', ((rooms.rooms || []).find((r) => r.id === roomId) || {}).players.A === '崩溃测试房主');

    /* ---------- 7) 崩溃时的快照也落盘了 ---------- */
    const snap = await fetch(base + '/api/snapshot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
    check('崩溃时写过快照（flushSnapshot(crash)）', snap.exists === true && snap.bytes > 0, { exists: snap.exists, bytes: snap.bytes });
  } finally {
    kill(child);
  }

  /* ---------- 8) 线上不该有测试钩子 ---------- */
  const port2 = await freePort(8861, 8879);
  const b2 = await boot(port2, { DATA_DIR: tmpDir('test-crash-nohook') });
  try {
    const r = await fetch(b2.base + '/api/_test_throw', { method: 'POST' });
    check('不设 TEST_HOOKS 时 /api/_test_throw 不存在', r.status === 404, r.status);
  } finally {
    kill(b2.child);
  }

  /* ---------- 9) 快照里混进一间坏房：不该挡住启动，也不该连累好房 ---------- */
  const snapFile = path.join(dir, 'rooms.snap.json');
  let snapRaw = null;
  try { snapRaw = JSON.parse(fs.readFileSync(snapFile, 'utf8')); } catch (_) {}
  check('测试环境里确实写出了快照文件', !!(snapRaw && Array.isArray(snapRaw.rooms) && snapRaw.rooms.length),
    snapRaw && snapRaw.rooms && snapRaw.rooms.length);
  if (snapRaw) {
    const good = snapRaw.rooms.filter((r) => Array.isArray(r.board) && r.board.length);
    const bad = { id: 'ZZ9', createdAt: Date.now(), cfg: null, board: [], seats: { A: { nick: '坏房' } } };
    snapRaw.rooms = [good[0], bad].filter(Boolean);
    snapRaw.at = Date.now();                     /* 年龄必须是新的，否则会被「太旧」挡掉 */
    fs.writeFileSync(snapFile, JSON.stringify(snapRaw));
    const port3 = await freePort(8861, 8879);
    let b3 = null;
    try {
      b3 = await boot(port3, { DATA_DIR: dir });
      const st = await stats(b3.base);
      check('快照里有坏房时进程照样起来', st.status === 200, st.status);
      const boot3 = await fetch(b3.base + '/api/boot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
      const cb = boot3.currentBoot || {};
      /* skipped 不在 boot 记录里（那行只有 restored / restoreWhy），要看 /api/snapshot 的 lastRestore */
      const sn = await fetch(b3.base + '/api/snapshot?key=' + encodeURIComponent(KEY)).then((r) => r.json());
      const lr = sn.lastRestore || {};
      check('坏房被跳过、好房照常接回', cb.restored >= 1 && (lr.skipped || 0) >= 1,
        { restored: cb.restored, skipped: lr.skipped, why: cb.restoreWhy });
    } finally {
      if (b3) kill(b3.child);
      await sleep(150);
    }
  }

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.log('FAIL 测试自身崩了：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
