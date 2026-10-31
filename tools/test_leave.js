/* 离开房间 / 掉线 / 重进 —— 回归测试。
 *
 *   node tools/test_leave.js
 *
 * 自带一套短超时的临时实例（心跳 2.5 秒判死、清扫 0.4 秒），所以不用等几分钟。
 * 覆盖三类真实事故：
 *   1) 走了却还挂在房间里（席位不让、成员列表里还有自己）
 *   2) 人走了房间却永远不消失（半开的观众连接把空房间钉住）
 *   3) 房里只剩一个空位时大厅不给「加入」，离开的人回不去
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let BASE = '';
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra ? '  「' + extra + '」' : '')); }
}

async function api(url, body) {
  const r = await fetch(BASE + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return d;
}
async function get(url) {
  const r = await fetch(BASE + url, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function roomRow(id) {
  const { d } = await get('/api/rooms');
  return (d.rooms || []).find((x) => x.id === id) || null;
}
async function state(roomId, t) {
  const { d } = await get('/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t));
  return d.state || null;
}

/* 裸 TCP 的 SSE：可以「连着但不再响应」—— 模拟手机断网后的半开连接 */
function halfOpenSse(roomId, token) {
  const port = Number(BASE.split(':').pop());
  const host = BASE.replace(/^https?:\/\//, '').split(':')[0];
  const sock = net.connect(port, host, () => {
    sock.write('GET /api/room/' + roomId + '/events?t=' + encodeURIComponent(token) + ' HTTP/1.1\r\n' +
      'Host: ' + host + ':' + port + '\r\nAccept: text/event-stream\r\n\r\n');
  });
  sock.on('error', () => {});
  return sock;
}

const BEAT = (roomId, t) => api('/api/room/' + roomId + '/beat', { t });

/* 一直在线的人：像真实页面那样持续报心跳，返回一个停止函数 */
function beatLoop(roomId, t, ms) {
  const every = ms || 400;
  let stop = false;
  (async () => {
    while (!stop) { try { await BEAT(roomId, t); } catch (_) {} await sleep(every); }
  })();
  return () => { stop = true; };
}

/* 临时实例：失败时也要能杀掉，否则进程会一直挂着 */
let child = null;
function killChild() { try { if (child) child.kill(); } catch (_) {} child = null; }

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

(async () => {
  let port = null;
  for (let p = 8830; p <= 8860; p++) if (await portFree(p)) { port = p; break; }
  if (!port) { console.error('!! 8830–8860 没有空端口'); process.exitCode = 1; return; }
  BASE = 'http://127.0.0.1:' + port;

  const childSpawn = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: require('./_tmpdir')('leave'),   /* 别把测试的房间写进项目的 data/ */
      ALIVE_MS: '2500',          /* 心跳停 2.5 秒即判离线 */
      SWEEP_MS: '400',
      WATCH_AWAY_MS: '2500',
      SEAT_AWAY_MS: '6000',
      RECALL_MS: '1500',         /* 「刷新」的接回窗口 */
    }),
    stdio: 'ignore',
  });
  child = childSpawn;
  const cleanup = () => killChild();
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exitCode = 130; });

  let up = false;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/api/rooms')).ok) { up = true; break; } } catch (_) {}
    await sleep(300);
  }
  if (!up) { console.error('!! 临时实例没起来：' + BASE); process.exitCode = 1; return; }
  console.log('BASE = ' + BASE + '\n');

  const id4 = String(Date.now()).slice(-4);

  /* ================= 1. 主动离开：当场生效，房间当场上消失 ================= */
  console.log('--- 1. 主动离开房间 ---');
  const nA = '甲' + id4, nB = '乙' + id4;
  const c1 = await api('/api/create', { nick: nA, size: 8, rounds: 10 });
  const rid1 = c1.roomId;
  const j1 = await api('/api/join', { roomId: rid1, nick: nB });
  const s1a = halfOpenSse(rid1, c1.token);
  const s1b = halfOpenSse(rid1, j1.token);
  await sleep(300);

  const lv1 = await api('/api/room/' + rid1 + '/leave', { t: j1.token });
  check('选手离开返回 ok', lv1.ok === true, JSON.stringify(lv1));
  const row1 = await roomRow(rid1);
  check('离开后大厅里立刻没有这个人', !!row1 && row1.players.B === null,
    JSON.stringify(row1 && row1.players));
  check('离开后席位是空的（不是离线占着）', !!row1 && row1.players.B === null);
  check('离开的 token 立刻失效', (await get('/api/room/' + rid1 + '/peek?t=' + j1.token)).status === 401);

  /* 最后一个人也走 → 房间必须当场消失，而不是等清扫（以前最多挂 10 秒） */
  await api('/api/room/' + rid1 + '/leave', { t: c1.token });
  check('最后一人离开后房间立刻消失', (await roomRow(rid1)) === null);
  check('房间消失后 peek 返回 404', (await get('/api/room/' + rid1 + '/peek?t=' + c1.token)).status === 404);
  s1a.destroy(); s1b.destroy();

  /* ================= 2. 只剩一个空位时，大厅要给「加入」 ================= */
  console.log('\n--- 2. 房里只有一个人等着，另一个位子空着 ---');
  const c2 = await api('/api/create', { nick: '丙' + id4, size: 8, rounds: 10 });
  const rid2 = c2.roomId;
  const j2 = await api('/api/join', { roomId: rid2, nick: '丁' + id4 });
  const s2a = halfOpenSse(rid2, c2.token);
  const s2b = halfOpenSse(rid2, j2.token);
  await BEAT(rid2, c2.token); await BEAT(rid2, j2.token);
  await sleep(250);

  await api('/api/room/' + rid2 + '/leave', { t: c2.token });   /* 房主走，赤营空出来 */
  const row2 = await roomRow(rid2);
  check('赤营空着时大厅显示「加入」', !!row2 && row2.joinable === true,
    JSON.stringify(row2 && { A: row2.players.A, B: row2.players.B, joinable: row2.joinable }));
  check('留下的那个人还在青营', !!row2 && !!row2.players.B);

  const back2 = await api('/api/join', { roomId: rid2, nick: '丙' + id4 });
  check('离开的人能用同昵称坐回赤营', back2.ok === true && back2.seat === 'A' && back2.role === 'player',
    JSON.stringify({ seat: back2.seat, role: back2.role }));
  const st2 = await state(rid2, j2.token);
  check('留下的那个人看到赤营又有人了', !!st2 && !!st2.seats.A && st2.seats.A.nick === '丙' + id4);
  check('回来的人立刻算在线', !!st2 && st2.seats.A.online === true);
  s2a.destroy(); s2b.destroy();
  await api('/api/room/' + rid2 + '/leave', { t: j2.token });
  await api('/api/room/' + rid2 + '/leave', { t: back2.token });

  /* ================= 3. 半开连接：人走了要认出来，回来要接得回席位 ================= */
  console.log('\n--- 3. 断了网（连接没断、心跳停了） ---');
  const c3 = await api('/api/create', { nick: '戊' + id4, size: 8, rounds: 10 });
  const rid3 = c3.roomId;
  const j3 = await api('/api/join', { roomId: rid3, nick: '己' + id4 });
  const s3a = halfOpenSse(rid3, c3.token);
  const s3b = halfOpenSse(rid3, j3.token);
  const stop3a = beatLoop(rid3, c3.token);
  const stop3b = beatLoop(rid3, j3.token);
  await sleep(300);
  check('两人都算在线', (await state(rid3, j3.token)).seats.A.online === true);

  /* 戊（房主）断网：连接还开着，但心跳停了；己仍在正常在线 */
  stop3a();
  await sleep(3400);
  const st3 = await state(rid3, j3.token);
  check('心跳停了 → 服务端认定他已离线', !!st3 && st3.seats.A.online === false,
    JSON.stringify(st3 && st3.seats.A));

  const back3 = await api('/api/join', { roomId: rid3, nick: '戊' + id4 });
  check('同昵称回来能接回原来的席位', back3.ok === true && back3.reclaimed === true && back3.seat === 'A',
    JSON.stringify({ seat: back3.seat, reclaimed: back3.reclaimed, role: back3.role }));
  const st3b = await state(rid3, back3.token);
  const sameNick = (st3b.members || []).filter((m) => m.nick === '戊' + id4);
  check('成员列表里只有一条自己', sameNick.length === 1, sameNick.map((m) => m.kind).join(','));
  check('自己不再是「以观众身份旁观自己」', st3b.role === 'player' && sameNick[0].isYou === true);
  stop3b();
  s3a.destroy(); s3b.destroy();
  await api('/api/room/' + rid3 + '/leave', { t: back3.token });
  await api('/api/room/' + rid3 + '/leave', { t: j3.token });

  /* ================= 4. 幽灵观众不能把空房间钉住 ================= */
  console.log('\n--- 4. 两位选手都走了，只剩一个断了网的观众 ---');
  const c4 = await api('/api/create', { nick: '庚' + id4, size: 8, rounds: 10 });
  const rid4 = c4.roomId;
  const j4 = await api('/api/join', { roomId: rid4, nick: '辛' + id4 });
  const w4 = await api('/api/join', { roomId: rid4, nick: '壬' + id4 });
  check('第三人以观众身份进来', w4.role === 'spectator' && w4.state.members.some((m) => m.kind === 'watcher'));
  const s4a = halfOpenSse(rid4, c4.token);
  const s4b = halfOpenSse(rid4, j4.token);
  const s4w = halfOpenSse(rid4, w4.token);
  await BEAT(rid4, c4.token); await BEAT(rid4, j4.token); await BEAT(rid4, w4.token);
  await sleep(300);

  await api('/api/room/' + rid4 + '/leave', { t: c4.token });
  await api('/api/room/' + rid4 + '/leave', { t: j4.token });
  const row4a = await roomRow(rid4);
  check('两位选手走后房间还在（观众还在）', !!row4a && row4a.watchers === 1,
    JSON.stringify(row4a && { w: row4a.watchers }));
  /* 观众也断网：连接留着，心跳停 */
  await sleep(3600);
  check('幽灵观众不会把空房间永远钉住', (await roomRow(rid4)) === null);
  check('房间被收掉后 peek 返回 404', (await get('/api/room/' + rid4 + '/peek?t=' + w4.token)).status === 404);
  s4a.destroy(); s4b.destroy(); s4w.destroy();

  /* ================= 5. 对局中途：空位不给陌生人，只还给原主 ================= */
  console.log('\n--- 5. 对局进行中，一方走人 ---');
  const c5 = await api('/api/create', { nick: '癸' + id4, size: 8, rounds: 10 });
  const rid5 = c5.roomId;
  const j5 = await api('/api/join', { roomId: rid5, nick: '子' + id4 });
  const s5a = halfOpenSse(rid5, c5.token);
  const s5b = halfOpenSse(rid5, j5.token);
  const stop5a = beatLoop(rid5, c5.token);
  const stop5b = beatLoop(rid5, j5.token);
  await api('/api/room/' + rid5 + '/ready', { t: c5.token, ready: true });
  await api('/api/room/' + rid5 + '/ready', { t: j5.token, ready: true });
  const st5 = await state(rid5, j5.token);
  check('双方准备后开局', st5.phase === 'playing', st5.phase);

  await api('/api/room/' + rid5 + '/leave', { t: c5.token });
  const row5 = await roomRow(rid5);
  check('开局后大厅不再给「加入」', !!row5 && row5.joinable === false);
  const stranger = await api('/api/join', { roomId: rid5, nick: '丑' + id4 });
  check('陌生人进不来这个空位（只能观战）', stranger.role === 'spectator' && stranger.seat === null,
    JSON.stringify({ role: stranger.role, seat: stranger.seat }));
  const owner = await api('/api/join', { roomId: rid5, nick: '癸' + id4 });
  check('原来那个人能直接坐回空位', owner.role === 'player' && owner.seat === 'A',
    JSON.stringify({ role: owner.role, seat: owner.seat }));
  stop5a(); stop5b();
  s5a.destroy(); s5b.destroy();

  /* ================= 6. 在线的人不能被同名顶掉 ================= */
  console.log('\n--- 6. 同名但原主还在线 ---');
  const c6 = await api('/api/create', { nick: '寅' + id4, size: 8, rounds: 10 });
  const rid6 = c6.roomId;
  const s6a = halfOpenSse(rid6, c6.token);
  const stop6a = beatLoop(rid6, c6.token);
  /* 先把青营占满，才不会因为「有空位」被当新选手坐进去 */
  const fill6 = await api('/api/join', { roomId: rid6, nick: '卯' + id4 });
  check('第二个人坐上青营', fill6.role === 'player' && fill6.seat === 'B', JSON.stringify(fill6.seat));
  await sleep(400);
  const dup = await api('/api/join', { roomId: rid6, nick: '寅' + id4 });
  check('原主还在心跳 → 不接管席位（只能观战）', dup.role === 'spectator' && !dup.reclaimed,
    JSON.stringify({ role: dup.role, reclaimed: !!dup.reclaimed }));
  stop6a();
  s6a.destroy();
  await api('/api/room/' + rid6 + '/leave', { t: c6.token });

  /* ================= 7. 心跳接口本身 ================= */
  console.log('\n--- 7. 心跳接口 ---');
  const c7 = await api('/api/create', { nick: '卯' + id4, size: 8, rounds: 10 });
  const b1 = await api('/api/room/' + c7.roomId + '/beat', { t: c7.token });
  check('有效 token 的心跳返回 ok', b1.ok === true);
  const b2 = await api('/api/room/' + c7.roomId + '/beat', { t: 'nope' });
  check('无效 token 的心跳被拒', b2.ok !== true);
  const b3 = await api('/api/room/999/beat', { t: c7.token });
  check('不存在的房间心跳返回 404', b3.ok !== true);
  await api('/api/room/' + c7.roomId + '/leave', { t: c7.token });

  /* ================= 8. 关掉页面时那一发「晚到的心跳」不能把人叫回来 ================= */
  console.log('\n--- 8. 关页面 + 晚到的心跳 ---');
  const c8 = await api('/api/create', { nick: '巳' + id4, size: 8, rounds: 10 });
  const rid8 = c8.roomId;
  const j8 = await api('/api/join', { roomId: rid8, nick: '午' + id4 });
  const s8 = halfOpenSse(rid8, c8.token);
  await BEAT(rid8, c8.token);          /* 这是个会报心跳的页面 */
  await sleep(250);
  s8.destroy();                        /* 关掉页面：连接先断 */
  await sleep(500);
  /* 页面卸载时用 keepalive 发出的心跳，可能在 close 之后才到服务端 */
  await BEAT(rid8, c8.token);
  await sleep(200);
  const st8 = await state(rid8, j8.token);
  check('晚到的心跳不会让人「复活」', !!st8 && st8.seats.A.online === false,
    JSON.stringify(st8 && st8.seats.A));
  const back8 = await api('/api/join', { roomId: rid8, nick: '巳' + id4 });
  check('关页面后同昵称重进能接回席位', back8.reclaimed === true && back8.seat === 'A',
    JSON.stringify({ seat: back8.seat, reclaimed: !!back8.reclaimed, role: back8.role }));
  const st8b = await state(rid8, back8.token);
  const dup8 = (st8b.members || []).filter((m) => m.nick === '巳' + id4);
  check('成员列表里不会出现「自己 + 观众的自己」', dup8.length === 1, dup8.map((m) => m.kind).join(','));
  await api('/api/room/' + rid8 + '/leave', { t: back8.token });
  await api('/api/room/' + rid8 + '/leave', { t: j8.token });

  /* ================= 9. 刷新页面：安静离开 + 同一个 token 接回原席位 ================= */
  console.log('\n--- 9. 刷新页面 ---');
  const c9 = await api('/api/create', { nick: '未' + id4, size: 8, rounds: 10 });
  const rid9 = c9.roomId;
  const j9 = await api('/api/join', { roomId: rid9, nick: '申' + id4 });
  const s9a = halfOpenSse(rid9, c9.token);
  const s9b = halfOpenSse(rid9, j9.token);
  const stop9 = beatLoop(rid9, c9.token);
  await sleep(300);

  /* 页面卸载：客户端用 sendBeacon 发的就是这一发（quiet） */
  const quiet = await api('/api/room/' + rid9 + '/leave', { t: c9.token, quiet: 1 });
  check('安静离开返回 ok', quiet.ok === true, JSON.stringify(quiet));
  const afterQuiet = await state(rid9, j9.token);
  check('安静离开后席位确实空出来了', !!afterQuiet && afterQuiet.seats.A === null);

  /* 重新加载：init 的第一次 peek 用同一个 token */
  const back9 = await get('/api/room/' + rid9 + '/peek?t=' + encodeURIComponent(c9.token));
  check('刷新后同一个 token 能接回原席位', back9.status === 200 && back9.d.ok === true &&
    back9.d.state.you === 'A', 'HTTP ' + back9.status + ' you=' + (back9.d.state && back9.d.state.you));
  check('接回来的还是原来那个人（mid 不变）', !!back9.d.state && /^m/.test(back9.d.state.youMid || ''));

  /* 事件流里不该留下「离开 / 下场」这种噪音 */
  const ev9 = (back9.d.state.events || []).map((e) => e.type);
  check('刷新不会在事件流里留下离开记录', !ev9.includes('leave') && !ev9.includes('stand'), ev9.join(','));

  /* 超过接回窗口后，同一个 token 就真的失效了 */
  stop9();
  await api('/api/room/' + rid9 + '/leave', { t: c9.token, quiet: 1 });
  await sleep(1800);
  const late = await get('/api/room/' + rid9 + '/peek?t=' + encodeURIComponent(c9.token));
  check('超出窗口后旧 token 失效（不会长期留后门）', late.status === 401, 'HTTP ' + late.status);
  /* 单人房刷新：房间不能因为「暂时空了一下」就被收掉 */
  const c10 = await api('/api/create', { nick: '酉' + id4, size: 8, rounds: 10 });
  const s10 = halfOpenSse(c10.roomId, c10.token);
  await sleep(300);
  await api('/api/room/' + c10.roomId + '/leave', { t: c10.token, quiet: 1 });
  const soloRow = await roomRow(c10.roomId);
  check('单人房在刷新窗口内不会被收掉', !!soloRow, soloRow ? 'ok' : '房间没了');
  const soloBack = await get('/api/room/' + c10.roomId + '/peek?t=' + encodeURIComponent(c10.token));
  check('单人房刷新后能接回席位', soloBack.status === 200 && soloBack.d.state.you === 'A',
    'HTTP ' + soloBack.status);
  s10.destroy();
  await api('/api/room/' + c10.roomId + '/leave', { t: c10.token });
  check('真正离开后单人房立刻消失', (await roomRow(c10.roomId)) === null);

  s9a.destroy(); s9b.destroy();
  await api('/api/room/' + rid9 + '/leave', { t: j9.token });

  console.log('\n通过 ' + pass + ' / ' + (pass + fail));
  cleanup();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试自身异常：' + (e && e.stack));
  killChild();
  process.exitCode = 1;
});
