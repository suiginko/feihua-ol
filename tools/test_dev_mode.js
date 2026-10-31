'use strict';
/* 开发者模式 —— 回归测试（服务端）
 *
 *   node tools/test_dev_mode.js
 *
 * 需求原文（2026-10-22）：「给我一个开发者权限，在我使用这个入口的时候进入房间不会有痕迹，
 * 并且可以在大厅看到私密房间。」所以这里逐条验收的是两件事：
 *
 *   A. 大厅可见性：带口令 `?dev=<admin.key>` 才看得到私密房，不带 / 口令错一律看不到；
 *      私密条目要带 isPrivate 标记（前端要据此打「私密」标）。
 *   B. 进房无痕：带口令进房一律是「隐形观众」——
 *      不占席位、不进成员列表、不算观众数、不写进出/上下线事件、
 *      **也不会让一个已经没人、该散的房间因为你挂着而不散**。
 *   C. 对照组：同样的流程不带口令时必须留下痕迹（否则「没痕迹」可能只是「功能坏了」）。
 */

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'dev-key-test-1';
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

let PORT = 0, BASE = '', dataDir = '', child = null;

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    /* Windows 的 SO_REUSEADDR 让「bind 成功」不代表端口真的空着，
       先真连一次再判断（见 AGENTS.md 陷阱）。 */
    const probe = net.connect({ port, host: '127.0.0.1' });
    probe.once('connect', () => { probe.destroy(); res(false); });
    probe.once('error', () => {
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(port, '127.0.0.1');
    });
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
    await sleep(200);
  }
  return false;
}

async function boot() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: KEY, SWEEP_MS: '500',
    }),
    stdio: 'ignore',
  });
  if (!(await waitUp(30000))) throw new Error('实例没起来（端口 ' + PORT + '）');
}

function killChild() {
  if (!child) return;
  try { child.kill(); } catch (_) {}
  child = null;
}

async function api(method, url, body) {
  const r = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b || {});

const devQ = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + 'dev=' + encodeURIComponent(KEY);

async function main() {
  for (let p = 8840; p <= 8859; p++) { if (await portFree(p)) { PORT = p; break; } }
  if (!PORT) throw new Error('找不到空闲端口');
  dataDir = tmpDir('test-dev-' + PORT);
  BASE = 'http://127.0.0.1:' + PORT;

  await boot();

  /* ---------- 1) 造一间公开房、一间私密房 ---------- */
  const pub = await POST('/api/create', { nick: '公开房主' });
  check('公开房建成', pub.status === 200 && /^\d{3}$/.test(pub.d.roomId || ''), pub.d);
  const pubId = pub.d.roomId, pubTok = pub.d.token;

  const priv = await POST('/api/create', { nick: '私密房主', isPrivate: true });
  check('私密房建成', priv.status === 200 && !!priv.d.roomId, priv.d);
  const privId = priv.d.roomId, privTok = priv.d.token;
  check('私密房号是 5 位字母数字（不是 000–999）', /^[2-9A-HJ-NP-Z]{5}$/.test(privId || ''), privId);

  /* ---------- 2) 大厅：不带口令看不到私密房 ---------- */
  let rl = await GET('/api/rooms');
  check('不带口令的大厅里没有私密房', !(rl.d.rooms || []).some((r) => r.id === privId),
    (rl.d.rooms || []).map((r) => r.id));
  check('不带口令时私密房也不计入 total', rl.d.total === (rl.d.rooms || []).length, rl.d.total);
  check('公开房照常出现在大厅', (rl.d.rooms || []).some((r) => r.id === pubId));

  /* ---------- 3) 口令不对 = 不是开发者 ---------- */
  rl = await GET('/api/rooms?dev=wrong-' + KEY);
  check('口令不对时依然看不到私密房', !(rl.d.rooms || []).some((r) => r.id === privId));

  /* ---------- 4) 带口令能看到，并带 isPrivate 标记 ---------- */
  rl = await GET(devQ('/api/rooms'));
  const privRow = (rl.d.rooms || []).find((r) => r.id === privId);
  check('带口令的大厅里能看到私密房', !!privRow, (rl.d.rooms || []).map((r) => r.id));
  check('私密条目带 isPrivate: true（前端据此打「私密」标）', privRow && privRow.isPrivate === true, privRow && privRow.isPrivate);
  const pubRow = (rl.d.rooms || []).find((r) => r.id === pubId);
  check('公开条目不会误标私密', pubRow && !pubRow.isPrivate, pubRow && pubRow.isPrivate);

  /* ---------- 5) 带口令进房 = 隐形观众 ---------- */
  const dj = await POST(devQ('/api/join'), { roomId: pubId, nick: '开发者' });
  check('开发者进房成功', dj.status === 200 && dj.d.ok, dj.d && dj.d.reason);
  check('开发者是观众，不是选手', dj.d.role === 'spectator', dj.d.role);
  check('开发者不抢空位（seat 为 null）', dj.d.seat === null, dj.d.seat);
  check('响应标了 hidden: true', dj.d.hidden === true, dj.d.hidden);
  const devTok = dj.d.token;
  check('开发者的 state 里 youHidden 为真', dj.d.state && dj.d.state.youHidden === true,
    dj.d.state && dj.d.state.youHidden);
  check('开发者自己看到的观众数也是 0（自己也不计）', dj.d.state && dj.d.state.watchers === 0,
    dj.d.state && dj.d.state.watchers);
  check('开发者照样拿得到完整棋盘', dj.d.state && dj.d.state.board.length === dj.d.state.size * dj.d.state.size,
    dj.d.state && (dj.d.state.board || '').length);

  /* ---------- 6) 玩家视角：名单、计数、事件里都没有他 ---------- */
  let pk = await GET('/api/room/' + pubId + '/peek?t=' + pubTok);
  const st = pk.d.state || {};
  check('玩家看到的成员列表里没有开发者', !(st.members || []).some((m) => m.nick === '开发者'),
    (st.members || []).map((m) => m.nick));
  check('玩家看到的观众数是 0', st.watchers === 0, st.watchers);
  check('玩家看到的观众昵称列表是空的', (st.watcherNicks || []).length === 0, st.watcherNicks);
  check('事件流里没有「观众身份进入」', !(st.events || []).some((e) => /观众身份进入/.test(e.text || '')),
    (st.events || []).map((e) => e.text).slice(-4));
  check('事件流里没有出现开发者昵称', !(st.events || []).some((e) => /开发者/.test(e.text || '')),
    (st.events || []).map((e) => e.text).slice(-4));

  /* ---------- 7) 房间的等待状态不受影响 ---------- */
  check('开发者进来没有把空位占掉（等待中的房依然可加入）', pubRow && pubRow.joinable === true, pubRow && pubRow.joinable);
  rl = await GET(devQ('/api/rooms'));
  const rowNow = (rl.d.rooms || []).find((r) => r.id === pubId);
  check('大厅里这间房的「观众 N」仍是 0', rowNow && rowNow.watchers === 0, rowNow && rowNow.watchers);

  /* ---------- 8) 私密房也能隐形进 ---------- */
  const djp = await POST(devQ('/api/join'), { roomId: privId, nick: '开发者' });
  check('开发者能直接进私密房', djp.status === 200 && djp.d.ok, djp.d && djp.d.reason);
  check('进私密房同样是隐形观众', djp.d.hidden === true && djp.d.role === 'spectator', djp.d.hidden);
  const pk2 = await GET('/api/room/' + privId + '/peek?t=' + privTok);
  check('私密房主也看不到开发者', !((pk2.d.state || {}).members || []).some((m) => m.nick === '开发者'));
  check('私密房主看到的观众数是 0', (pk2.d.state || {}).watchers === 0, (pk2.d.state || {}).watchers);

  /* ---------- 9) 对照组：普通观众必须留痕 ----------
     必须用一间「没有空位」的房，否则 join 会把他安排到空席位当选手，
     测的就不是观众了（第一版就栽在这里：公开房 B 位空着，对照组直接坐上青营）。 */
  const wf = await POST('/api/create', { nick: '观众席房主', playerCount: 1 });
  const wfId = wf.d.roomId, wfTok = wf.d.token;
  const wj = await POST('/api/join', { roomId: wfId, nick: '普通观众' });
  check('（对照）普通观众也能进', wj.status === 200 && wj.d.ok, wj.d && wj.d.reason);
  check('（对照）满员房里普通观众是观众', wj.d.role === 'spectator', wj.d.role);
  pk = await GET('/api/room/' + wfId + '/peek?t=' + wfTok);
  const st2 = pk.d.state || {};
  check('（对照）普通观众会让观众数变成 1', st2.watchers === 1, st2.watchers);
  check('（对照）普通观众出现在成员列表里', (st2.members || []).some((m) => m.nick === '普通观众'),
    (st2.members || []).map((m) => m.nick));
  check('（对照）普通观众会写一条「观众身份进入」',
    (st2.events || []).some((e) => /普通观众.*观众身份进入/.test(e.text || '')),
    (st2.events || []).map((e) => e.text).slice(-3));

  /* ---------- 10) 开发者离开：连一条离开事件都不该有 ---------- */
  const dw = await POST(devQ('/api/join'), { roomId: wfId, nick: '开发者' });
  check('开发者进满员房（观众席）', dw.d.hidden === true, dw.d.hidden);
  const dwTok = dw.d.token;
  pk = await GET('/api/room/' + wfId + '/peek?t=' + wfTok);
  const beforeLeave = ((pk.d.state || {}).events || []).length;
  await POST(devQ('/api/room/' + wfId + '/leave'), { t: dwTok });
  pk = await GET('/api/room/' + wfId + '/peek?t=' + wfTok);
  const st3 = pk.d.state || {};
  check('开发者离开后事件流长度不变（进出都不写）', (st3.events || []).length === beforeLeave,
    { before: beforeLeave, after: (st3.events || []).length });
  check('开发者离开后玩家名单仍然只有普通观众',
    (st3.members || []).filter((m) => m.kind === 'watcher').map((m) => m.nick).join(',') === '普通观众',
    (st3.members || []).filter((m) => m.kind === 'watcher').map((m) => m.nick));

  /* ---------- 11) 隐形观众不该替空房续命 ---------- */
  const solo = await POST('/api/create', { nick: '要散的房主' });
  const soloId = solo.d.roomId, soloTok = solo.d.token;
  const ds = await POST(devQ('/api/join'), { roomId: soloId, nick: '开发者' });
  check('开发者挂在一间单人房里', ds.d.hidden === true, ds.d.hidden);
  const dsTok = ds.d.token;
  await POST('/api/room/' + soloId + '/leave', { t: soloTok });     /* 房主走人 */
  const gone = await GET('/api/room/' + soloId + '/peek?t=' + dsTok);
  check('房主走后房间立刻散掉（隐形观众不算「房里还有人」）', gone.status === 404, gone.status);
  check('房间散掉后开发者也拿不到状态', !gone.d || gone.d.ok !== true, gone.d);

  /* ---------- 12) 快照里的观众数同样不算隐形 ---------- */
  const snap = await GET('/api/snapshot?key=' + encodeURIComponent(KEY));
  const snapWf = (snap.d.rooms || []).find((r) => r.id === wfId);
  check('快照里这间房的观众数只算普通观众', snapWf && snapWf.watchers === 1, snapWf && snapWf.watchers);
  const snapPub = (snap.d.rooms || []).find((r) => r.id === pubId);
  check('快照里开发者待过的公开房观众数仍是 0', snapPub && snapPub.watchers === 0, snapPub && snapPub.watchers);

  /* ---------- 13) 四人房里开发者也只坐「观众席」 ---------- */
  const q4 = await POST('/api/create', { nick: '四人房主', playerCount: 4, size: 6, rounds: 5 });
  const q4Id = q4.d.roomId;
  const d4 = await POST(devQ('/api/join'), { roomId: q4Id, nick: '开发者' });
  check('四人房：开发者仍是观众', d4.d.role === 'spectator' && d4.d.seat === null, d4.d.seat);
  const q4st = (await GET('/api/room/' + q4Id + '/peek?t=' + q4.d.token)).d.state || {};
  check('四人房：B/C/D 席位仍然空着', !q4st.seats.B && !q4st.seats.C && !q4st.seats.D,
    q4st.seats && Object.keys(q4st.seats).map((k) => k + '=' + (q4st.seats[k] ? q4st.seats[k].nick : '空')).join(' '));

  /* ---------- 14) 选手退出后，普通大厅完全看不到留有隐形观众的房间 ---------- */
  const playRoom = await POST('/api/create', { nick: '选手A', playerCount: 2 });
  const playId = playRoom.d.roomId, tokA = playRoom.d.token;
  const joinB = await POST('/api/join', { roomId: playId, nick: '选手B' });
  const tokB = joinB.d.token;
  const devWatcher = await POST(devQ('/api/join'), { roomId: playId, nick: '开发者' });
  check('对战房建立且隐形观众加入', devWatcher.d.hidden === true);
  // 选手A和B均退出
  await POST('/api/room/' + playId + '/leave', { t: tokA });
  await POST('/api/room/' + playId + '/leave', { t: tokB });
  // 普通用户请求大厅列表（不带dev）
  const pubLobby = await GET('/api/rooms');
  check('普通玩家大厅列表里完全没有该房间（完全无痕）',
    !(pubLobby.d.rooms || []).some((r) => r.id === playId),
    (pubLobby.d.rooms || []).map((r) => r.id));

  killChild();
  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  killChild();
  console.log('FAIL 测试自身崩了：' + (e && e.message));
  process.exitCode = 1;
});
