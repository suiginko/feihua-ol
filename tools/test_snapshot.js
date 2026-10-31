'use strict';
/* 房间快照（发布保护）—— 回归测试。
 *
 *   node tools/test_snapshot.js
 *
 * 被测的东西只有一句话：发布新版本会重启容器，正在打的对局能不能活下来。
 * 做法是「进程退出前把房间落盘，新进程启动时接回来」，这里逐条验收：
 *   1) 优雅停机（SIGTERM 那条路径）落盘 → 重启后房号、棋盘、每一手、轮到谁、比分全一样；
 *   2) 只有一个人在等对手的房间也要接回来（不是只有对局中才值得救）；
 *   3) 停机期间本步超时了 → 变成「暂停」并重置计时，绝不按超时判负；
 *   4) 快照太旧 / 版本不符 / JSON 坏了 → 一律不恢复，而且服务照常起来（这台机器上不能崩）；
 *   5) 被 SIGKILL 硬杀（平台不给面子时）→ 靠周期快照也能接回来；
 *   6) 审阅接口 /api/snapshot 能把「存了没、恢复了几间」说清楚。
 *
 * 两个只在测试里出现的东西，都跟平台的真实行为有关：
 *   · SHUTDOWN_HOOK=1 开一个 /api/shutdown —— Windows 上 child.kill('SIGTERM') 走的是
 *     TerminateProcess，子进程根本收不到信号，没法本地验证「SIGTERM → 落盘」；
 *   · DATA_DIR 指到临时目录 —— 别把测试的房间写进项目自己的 data/。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'test-key-123';
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

let PORT = 0;
let BASE = '';
let child = null;

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return d;
}
async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function peekState(roomId, t) {
  const { status, d } = await get('/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t));
  return { status, state: d.state || null };
}
async function rowOf(id) {
  const { d } = await get('/api/rooms');
  return (d.rooms || []).find((x) => x.id === id) || null;
}

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
    try { if ((await fetch(BASE + '/api/rooms', { cache: 'no-store' })).ok) return true; } catch (_) {}
    await sleep(120);
  }
  return false;
}
async function waitDown(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await fetch(BASE + '/api/rooms', { cache: 'no-store' }); } catch (_) { return true; }
    await sleep(120);
  }
  return false;
}

/* 起一个实例。env 里的东西会盖掉默认值，用来构造「另一台机器」（不同 DATA_DIR）。 */
async function boot(dir, env) {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: dir,
      ADMIN_KEY: KEY,
      SHUTDOWN_HOOK: '1',
      SNAP_MS: '200',              /* 周期落盘快一点，测 SIGKILL 时不用干等 */
    }, env || {}),
    stdio: 'ignore',
  });
  if (!(await waitUp(30000))) throw new Error('实例没起来（端口 ' + PORT + '，数据目录 ' + dir + '）');
  /* 自证：回答我的必须是刚起的这个进程。Windows 的 SO_REUSEADDR 允许两个进程同时绑同一端口，
     「端口有人回答」不等于「我的进程起来了」—— 撞上遗留实例时，下面所有断言都会测到别人身上。 */
  let pid = 0;
  try { pid = (await (await fetch(BASE + '/api/stats', { cache: 'no-store' })).json()).pid || 0; } catch (_) {}
  if (pid !== child.pid) {
    throw new Error('端口 ' + PORT + ' 上回答的是 pid ' + pid + '，不是刚起的 ' + child.pid + '（换端口或先关掉那个实例）');
  }
}

/* 优雅停机：走服务端自己的 shutdown()（等同 Linux 上收到 SIGTERM）。 */
async function graceful() {
  try { await fetch(BASE + '/api/shutdown', { method: 'POST' }); } catch (_) {}
  const ok = await waitDown(15000);
  child = null;
  return ok;
}
/* 硬杀：平台不给时间的话就是这样，除了已经落盘的周期快照什么都留不下。 */
async function hardKill() {
  const c = child; child = null;
  if (!c) return true;
  try { c.kill('SIGKILL'); } catch (_) {}
  return waitDown(10000);
}

/* ---------- 落子：棋盘是随机铺的，得从语料里挑一句「含棋盘上某个空格字」的真句 ---------- */
const CORPUS = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'clauses.txt.gz'))).toString('utf8');
function pickLine(state, seed) {
  const need = new Set();
  for (let i = 0; i < state.chars.length; i++) {
    if (state.board.charAt(i) === '0') need.add(state.chars.charAt(i));
  }
  let p = 3000 + ((seed * 7919) % 20000000);
  for (let i = 0; i < 6000; i++) {
    if (p >= CORPUS.length) p = 0;
    const e = CORPUS.indexOf('\n', p);
    if (e < 0) { p = 0; continue; }
    const ln = CORPUS.slice(p, e);
    p = e + 1;
    if (ln.length < 5 || ln.length > 12) continue;
    let hit = 0;
    for (const ch of ln) if (need.has(ch)) hit++;
    if (hit >= 2) return ln;
  }
  return null;
}

/* 打一手真棋。返回 null 表示这一手没走成。 */
async function playOne(roomId, token, seed) {
  const st = (await peekState(roomId, token)).state;
  if (!st) return null;
  const line = pickLine(st, seed);
  if (!line) return null;
  const r = await api('/api/room/' + roomId + '/move', { t: token, text: line });
  return r && r.ok ? line : null;
}

const snapPath = (dir) => path.join(dir, 'rooms.snap.json');
function readSnap(dir) {
  try { return JSON.parse(fs.readFileSync(snapPath(dir), 'utf8')); } catch (_) { return null; }
}
function writeSnap(dir, obj) { fs.writeFileSync(snapPath(dir), JSON.stringify(obj)); }

(async () => {
  for (let p = 8870; p <= 8900; p++) if (await portFree(p)) { PORT = p; break; }
  if (!PORT) { console.error('!! 8870–8900 没有空端口'); process.exitCode = 1; return; }
  BASE = 'http://127.0.0.1:' + PORT;
  process.on('exit', () => { try { if (child) child.kill('SIGKILL'); } catch (_) {} });
  console.log('BASE = ' + BASE + '\n');

  const DIR_A = tmpDir('snap-a');
  const DIR_B = tmpDir('snap-b');
  const DIR_C = tmpDir('snap-c');
  const tag = String(Date.now()).slice(-4);

  /* ============ 1. 优雅停机 → 对局原样接回来 ============ */
  console.log('--- 1. 停机前落盘，重启后原样接回 ---');
  await boot(DIR_A);
  const c1 = await api('/api/create', { nick: '赤' + tag, size: 8, rounds: 30, turnSeconds: 120 });
  const rid = c1.roomId;
  const A = c1.token;
  const j1 = await api('/api/join', { roomId: rid, nick: '青' + tag });
  const B = j1.token;
  await api('/api/room/' + rid + '/ready', { t: A, ready: true });
  await api('/api/room/' + rid + '/ready', { t: B, ready: true });

  const m1 = await playOne(rid, A, 11);
  const m2 = m1 ? await playOne(rid, B, 23) : null;
  check('开局后走了两手真棋（前置条件）', !!m1 && !!m2, { m1, m2 });

  const before = (await peekState(rid, A)).state;
  const beforeB = (await peekState(rid, B)).state;
  check('停机前状态：phase=playing', before && before.phase === 'playing', before && before.phase);
  check('停机前状态：轮到赤营（走了两手）', before && before.turn === 'A', before && before.turn);

  const leftBefore = before.deadline - before.serverNow;

  const stopped = await graceful();
  check('优雅停机后进程真的退出了', stopped === true);

  const snap = readSnap(DIR_A);
  check('退出前把快照写到了盘上', !!snap, snapPath(DIR_A));
  check('快照里带着这一局', !!snap && (snap.rooms || []).some((r) => r.id === rid));
  check('快照带 schema 版本号', !!snap && typeof snap.schema === 'number' && snap.schema >= 1, snap && snap.schema);
  check('快照落盘原因是「收到信号」', !!snap && String(snap.why).indexOf('signal') === 0, snap && snap.why);

  await boot(DIR_A);
  const row = await rowOf(rid);
  check('重启后大厅里还有这一间房', !!row, row);
  check('重启后房号没变', !!row && row.id === rid);
  check('重启后仍在对局中', !!row && row.phase === 'playing', row && row.phase);
  check('重启后两人都还在席位上', !!row && row.players.A === '赤' + tag && row.players.B === '青' + tag, row && row.players);
  check('重启后比分没丢', !!row && row.score.a === before.score.a && row.score.b === before.score.b,
    { was: [before.score.a, before.score.b], now: row && [row.score.a, row.score.b] });

  const after = (await peekState(rid, A)).state;
  check('带原 token 问过去还是赤营', !!after && after.you === 'A', after && after.you);
  check('棋盘上的每一格归属一模一样', !!after && after.board === before.board);
  check('棋盘上的字一模一样（没有重抽）', !!after && after.chars === before.chars);
  check('手数没变', !!after && after.turnNo === before.turnNo, { was: before.turnNo, now: after && after.turnNo });
  check('飞花记录一手不少', !!after && (after.log || []).length === (before.log || []).length,
    { was: (before.log || []).length, now: after && (after.log || []).length });
  check('对手带自己的 token 问过去还是青营', (await peekState(rid, B)).state.you === 'B');
  check('恢复后两人在成员列表里都算在线（有重连宽限）',
    !!after && after.seats.A.online === true && after.seats.B.online === true,
    after && { A: after.seats.A && after.seats.A.online, B: after.seats.B && after.seats.B.online });

  const leftAfter = after.deadline - after.serverNow;
  check('本步剩余时间按墙钟重算，还是那么多（±4 秒）',
    Math.abs(leftAfter - leftBefore) < 4000, { was: Math.round(leftBefore / 1000), now: Math.round(leftAfter / 1000) });
  check('剩余时间不会超过一整步', leftAfter <= 121000, leftAfter);

  check('事件流里有「服务刚更新过」的交代',
    (after.events || []).some((e) => e.type === 'restore'));

  /* ============ 2. 只有一个人在等的房间也要救 ============ */
  console.log('\n--- 2. 单人等待中的房间 ---');
  const c2 = await api('/api/create', { nick: '独' + tag, size: 8, rounds: 10 });
  const rid2 = c2.roomId;
  check('新房间是 waiting', (await rowOf(rid2)).phase === 'waiting');
  await graceful();
  await boot(DIR_A);
  const row2 = await rowOf(rid2);
  check('等待中的房间也接回来了', !!row2, row2);
  const st2 = (await peekState(rid2, c2.token)).state;
  check('原房主还是赤营', !!st2 && st2.you === 'A', st2 && st2.you);
  check('对手位置仍然空着（没被谁顶上）', !!st2 && st2.seats.B === null);

  /* ============ 3. 停机期间本步超时 → 暂停，不判负 ============ */
  console.log('\n--- 3. 停机期间本步超时了 ---');
  await hardKill();
  const snap3 = readSnap(DIR_A);
  check('硬杀之后盘上仍有周期快照（前置条件）', !!snap3);
  let room3 = (snap3.rooms || []).find((r) => r.id === rid);
  check('周期快照里有那一局（前置条件）', !!room3);
  room3.deadline = Date.now() - 5000;        /* 假装这一步在停机期间就超时了 */
  snap3.at = Date.now();                     /* 但快照本身是新鲜的 */
  writeSnap(DIR_A, snap3);

  await boot(DIR_A);
  const st3 = (await peekState(rid, A)).state;
  check('超时之后不是判负，而是暂停', !!st3 && !!st3.paused, st3 && st3.paused);
  check('暂停原因是「服务更新」，前端能区分它和手动暂停', !!st3 && st3.paused.why === 'restore', st3 && st3.paused.why);
  check('时钟被重置成一整步（不是负的、也不是 1 秒）',
    !!st3 && st3.deadline - st3.serverNow > 60000, st3 && Math.round((st3.deadline - st3.serverNow) / 1000));
  check('对局还在，没有被判负结算', !!st3 && st3.phase === 'playing', st3 && st3.phase);

  /* ============ 4. 不敢恢复的三种情况：都不恢复，但服务必须照常起来 ============ */
  console.log('\n--- 4. 快照不敢用的几种情况 ---');
  await hardKill();

  /* 4a 太旧：2026-10-24 窗口从 15 分钟放宽到 6 小时，所以「太旧」的门槛也跟着挪到 7 小时 */
  const s4 = readSnap(DIR_A);
  s4.at = Date.now() - 7 * 60 * 60 * 1000;
  writeSnap(DIR_A, s4);
  await boot(DIR_A);
  check('超过 6 小时窗口的快照不恢复（房间不会「复活」）', (await rowOf(rid)) === null);
  let adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('什么时候都不恢复，审阅接口也说得出来', !!adm && adm.lastRestore && adm.lastRestore.ok === false,
    adm && adm.lastRestore);
  await hardKill();

  /* ====== 4a2 这次改动的全部意义：平台拖了 3 小时才拉起，对局也要能接回来 ======
     （10-24 03:03 那次平台拖了 10h23m，旧的 15 分钟窗口下 3 间房 restored=0 全丢） */
  const s4b = readSnap(DIR_A);
  s4b.at = Date.now() - 3 * 60 * 60 * 1000;              /* 快照写于 3 小时前 */
  s4b.rooms.forEach((r) => { if (r.id === rid) r.createdAt = s4b.at - 10 * 60 * 1000; });
  writeSnap(DIR_A, s4b);
  await boot(DIR_A);
  check('3 小时前的快照也能恢复（窗口已放宽到 6 小时）', (await rowOf(rid)) !== null);
  const rm4b = ((await get('/api/rooms')).d.rooms || []).find((x) => x.id === rid);
  check('接回来的房间剩余寿命与挂掉那一刻一致（停机时间不烧 ROOM_TTL）',
    !!rm4b && rm4b.age < 15 * 60, rm4b && rm4b.age);
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('恢复成功时审阅接口报 ok', !!adm && adm.lastRestore && adm.lastRestore.ok === true,
    adm && adm.lastRestore && adm.lastRestore.why);
  await hardKill();

  /* 4a3 快照时刻就已活满 2 小时（ROOM_TTL）的房间，仍然按规矩不恢复 —— 放宽窗口不等于放宽房间寿命 */
  const s4c = readSnap(DIR_A);
  s4c.at = Date.now() - 3 * 60 * 60 * 1000;
  s4c.rooms.forEach((r) => { if (r.id === rid) r.createdAt = s4c.at - 150 * 60 * 1000; });
  writeSnap(DIR_A, s4c);
  await boot(DIR_A);
  check('挂掉那一刻就已活过 2 小时的房间还是不恢复（ROOM_TTL 没被放宽）', (await rowOf(rid)) === null);
  await hardKill();

  /* 4a4 别处写的快照：窗口放宽到 6 小时后，本地漏删的 data/rooms.snap.json 会被随包传上线，
     盖过「发布前删快照」这条人肉纪律 —— 靠快照里的环境指纹挡住它。 */
  const s4d = readSnap(DIR_A);
  s4d.at = Date.now() - 3 * 60 * 60 * 1000;
  s4d.rooms.forEach((r) => { if (r.id === rid) r.createdAt = s4d.at - 10 * 60 * 1000; });
  s4d.dir = '/somewhere/else';
  writeSnap(DIR_A, s4d);
  await boot(DIR_A);
  check('别的环境写的快照不恢复（不会凭空多出幽灵房间）', (await rowOf(rid)) === null);
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('拒绝原因说清楚是「环境不符」', !!adm && /环境/.test(adm.lastRestore.why), adm && adm.lastRestore.why);
  await hardKill();

  /* 4b 版本不符 */
  const s5 = readSnap(DIR_A);
  s5.schema = 999;
  s5.at = Date.now();
  writeSnap(DIR_A, s5);
  await boot(DIR_A);
  check('版本不符的快照整份丢弃', (await rowOf(rid)) === null);
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('丢弃原因写的是版本不符', !!adm && /版本/.test(adm.lastRestore.why), adm && adm.lastRestore.why);
  await hardKill();

  /* 4c 文件损坏 */
  fs.writeFileSync(snapPath(DIR_A), '{"schema":1,"rooms":[{"id":');
  await boot(DIR_A);
  const broken = await get('/api/rooms');
  check('快照是坏 JSON 时，服务照样起来（没崩）', broken.status === 200, broken.status);
  check('坏快照不会恢复出半套房间', (broken.d.rooms || []).length === 0, broken.d.rooms);
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('审阅接口报的是「解析失败」', !!adm && /解析/.test(adm.lastRestore.why), adm && adm.lastRestore.why);

  /* ============ 5. 被硬杀（没机会落盘）也要靠周期快照活下来 ============ */
  console.log('\n--- 5. SIGKILL 硬杀 ---');
  const c6 = await api('/api/create', { nick: '硬' + tag, size: 8, rounds: 10 });
  const rid6 = c6.roomId;
  const j6 = await api('/api/join', { roomId: rid6, nick: '杀' + tag });
  await api('/api/room/' + rid6 + '/ready', { t: c6.token, ready: true });
  await api('/api/room/' + rid6 + '/ready', { t: j6.token, ready: true });
  const m6 = await playOne(rid6, c6.token, 37);
  check('硬杀前先走一手（前置条件）', !!m6, m6);
  const b6 = (await peekState(rid6, c6.token)).state;
  await sleep(600);                          /* 等一轮周期落盘 */
  await hardKill();

  const s6 = readSnap(DIR_A);
  const r6 = s6 && (s6.rooms || []).find((x) => x.id === rid6);
  check('硬杀后盘上还留着这一局（周期快照的功劳）', !!r6, r6 && r6.id);
  check('硬杀那一份不是「收到信号」写的，是定时写的', !!s6 && s6.why === 'timer', s6 && s6.why);

  await boot(DIR_A);
  const after6 = (await peekState(rid6, c6.token)).state;
  check('硬杀之后也能接回来', !!after6 && after6.phase === 'playing', after6 && after6.phase);
  check('硬杀之后那一手还在', !!after6 && after6.board === b6.board);

  /* ============ 6. 审阅接口 ============ */
  console.log('\n--- 6. 审阅接口 ---');
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('审阅接口能读到', !!adm && adm.ok === true);
  check('能看出「内存里几间、快照里几间」', !!adm && adm.inMemory === 1 && adm.inSnapshot === 1,
    adm && { mem: adm.inMemory, snap: adm.inSnapshot });
  check('能看出这一轮恢复了几间', !!adm && adm.lastRestore.rooms === 1, adm && adm.lastRestore);
  check('能看出房间的快照状态（恢复过的会标出来）', !!adm && adm.rooms[0].restored === true);
  check('没口令一律 403', (await get('/api/snapshot')).status === 403);

  await graceful();

  /* ============ 7. 空数据目录：什么都没写过 ============ */
  console.log('\n--- 7. 全新机器（没有快照） ---');
  await boot(DIR_C);
  adm = (await get('/api/snapshot?key=' + KEY)).d;
  check('没有快照不算错误，只是没东西可恢复', !!adm && adm.exists === false && adm.inMemory === 0);
  check('这种情况 reason 说清楚是「没有快照文件」',
    !!adm && adm.lastRestore.ok === true && /没有快照/.test(adm.lastRestore.why), adm && adm.lastRestore.why);
  await graceful();

  console.log('\n----------------------------------------');
  console.log(fail ? '结果：' + fail + ' 项失败（通过 ' + pass + '）' : '全部通过（' + pass + ' 项）');
  process.exitCode = fail ? 1 : 0;
})().catch(async (e) => {
  console.error('测试异常：' + (e && e.stack ? e.stack : e));
  try { if (child) child.kill('SIGKILL'); } catch (_) {}
  process.exitCode = 1;
});
