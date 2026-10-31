'use strict';
/* 存档的「定位」问题 —— 回归测试。
 *
 *   node tools/test_records.js
 *
 * 被测的东西：**同一个房号打过好几局时，每一局都要能单独取到。**
 *
 * 房号 000–999 是顺序发号、循环复用的，一天就能转一圈。原来的单局接口用
 * `find(r => r.id === wantId)` 定位，房号一复用就只返回该房号最新那一局 ——
 * 其余几局的每一手永远拿不到（导出时表现为「65 条存档只能取到 20 条详情」）。
 *
 * 所以这里造出「同一房号的两局」，逐条验收：
 *   1) 列表给每条一个 rid（房号@结束时刻），两局 rid 不同；
 *   2) 用 rid 能分别取到两局，at / 比分 / 时长各不相同；
 *   3) 老写法 ?id= 仍然可用（向后兼容），但只能给到其中一局；
 *   4) 不存在的 rid → 404，不能拿错局；
 *   5) 列表带 createdAt，导出时才能算耗时。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

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

let PORT = 0, BASE = '', dataDir = '', child = null;

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
      if (r.ok) {
        const d = await r.json();
        if (d && d.pid === child.pid) return true;
      }
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

async function boot() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: KEY,
      SWEEP_MS: '300', RECALL_MS: '200',
    }),
    stdio: 'ignore',
  });
  if (!(await waitUp(30000))) throw new Error('实例没起来（端口 ' + PORT + '）');
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

/* 打完一局：建房 → 加入 → 双方准备 → 甲方提请结算 → 乙方同意 → 两人离开（释放房号） */
async function playOneRound(nickA, nickB) {
  const c = await post('/api/create', { nick: nickA, size: 8, rounds: 10, turnSeconds: 60 });
  if (!c.d.ok) throw new Error('建房失败：' + JSON.stringify(c.d));
  const roomId = c.d.roomId, ta = c.d.token;
  const j = await post('/api/join', { roomId, nick: nickB });
  if (!j.d.ok) throw new Error('加入失败：' + JSON.stringify(j.d));
  const tb = j.d.token;

  await post('/api/room/' + roomId + '/ready', { t: ta, ready: true });
  const st = await post('/api/room/' + roomId + '/ready', { t: tb, ready: true });
  if (!st.d.started) throw new Error('没能开局：' + JSON.stringify(st.d));

  await post('/api/room/' + roomId + '/finish', { t: ta });
  const fin = await post('/api/room/' + roomId + '/consent', { t: tb, accept: true });
  if (!fin.d.finished) throw new Error('没能结算：' + JSON.stringify(fin.d));

  /* 主动离开（不带 quiet）：不留 recall，房间才会立刻被收走、房号回到池子里 */
  await post('/api/room/' + roomId + '/leave', { t: ta });
  await post('/api/room/' + roomId + '/leave', { t: tb });
  return roomId;
}

async function waitRoomGone(roomId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await get('/api/rooms');
    const hit = (r.d.rooms || []).some((x) => x.id === roomId);
    if (!hit) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  try {
    for (let p = 8900; p <= 8920; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    dataDir = tmpDir('test-records-' + PORT);
    BASE = 'http://127.0.0.1:' + PORT;
    await boot();

    /* ---------- 造两局，且必须是同一个房号 ---------- */
    const r1 = await playOneRound('甲', '乙');
    check('第一局打完并释放房号 ' + r1, await waitRoomGone(r1, 8000));
    await sleep(50);                       /* 让两次 at 一定不同 */
    const r2 = await playOneRound('丙', '丁');
    check('第二局拿到同一个房号 ' + r2 + '（房号复用，正是问题所在）', r2 === r1, [r1, r2]);
    check('第二局打完并释放', await waitRoomGone(r2, 8000));

    /* ---------- 列表：两条存档、两个不同的 rid ---------- */
    let l = await get('/api/records?key=' + encodeURIComponent(KEY));
    const two = (l.d.list || []).filter((x) => x.id === r1);
    check('列表里同一房号有两条存档', two.length === 2, two.length);
    check('两条都带 rid', two.length === 2 && two.every((x) => typeof x.rid === 'string' && x.rid.startsWith(r1 + '@')), two.map((x) => x.rid));
    check('两条 rid 不相同', two.length === 2 && two[0].rid !== two[1].rid, two.map((x) => x.rid));
    check('列表带 createdAt（导出算耗时要用）', two.length === 2 && two.every((x) => typeof x.createdAt === 'number'), two.map((x) => x.createdAt));
    check('列表仍然只给摘要，不带每一手', two.length === 2 && two.every((x) => x.log === undefined), two.length);

    /* ---------- 用 rid 各自取到各自那一局 ---------- */
    const d1 = await get('/api/records?key=' + encodeURIComponent(KEY) + '&rid=' + encodeURIComponent(two[0].rid));
    const d2 = await get('/api/records?key=' + encodeURIComponent(KEY) + '&rid=' + encodeURIComponent(two[1].rid));
    check('第一条 rid 取到完整记录', d1.status === 200 && d1.d.ok && !!d1.d.record, d1.status);
    check('第二条 rid 取到完整记录', d2.status === 200 && d2.d.ok && !!d2.d.record, d2.status);
    check('两局取到的结束时刻不同（说明真是两局）', d1.d.record.at !== d2.d.record.at, [d1.d.record.at, d2.d.record.at]);
    check('返回体里带 rid，方便核对', d1.d.rid === two[0].rid, d1.d.rid);
    check('详情里有事件流水', Array.isArray(d1.d.record.events) && d1.d.record.events.length > 0, (d1.d.record.events || []).length);
    check('详情里有每一手的 log 字段位', d1.d.record.log === undefined || Array.isArray(d1.d.record.log), typeof d1.d.record.log);

    /* ---------- 老写法 ?id= 还能用（但只给一局） ---------- */
    const byId = await get('/api/records?key=' + encodeURIComponent(KEY) + '&id=' + encodeURIComponent(r1));
    check('老写法 ?id= 仍然可用（向后兼容）', byId.status === 200 && byId.d.ok && byId.d.record.id === r1, byId.status);
    check('老写法只给到其中一局（这就是当初丢数据的现象）',
      byId.d.record.at === d1.d.record.at || byId.d.record.at === d2.d.record.at,
      byId.d.record.at);

    /* ---------- 不存在的 rid ---------- */
    const miss = await get('/api/records?key=' + encodeURIComponent(KEY) + '&rid=' + encodeURIComponent(r1 + '@1'));
    check('不存在的 rid → 404，不会错给一局', miss.status === 404, miss.status);

    /* ---------- 越权 ---------- */
    const noKey = await get('/api/records?rid=' + encodeURIComponent(two[0].rid));
    check('带 rid 但没有口令 → 403', noKey.status === 403, noKey.status);

    console.log('');
    console.log('「存档定位」' + pass + ' 过 / ' + fail + ' 败');
    process.exitCode = fail ? 1 : 0;
  } catch (e) {
    console.log('!! 中断：' + e.message);
    process.exitCode = 1;
  } finally {
    killChild();
  }
})();
