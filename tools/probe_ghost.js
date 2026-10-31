/* 幽灵成员取证：模拟「人走了但连接没断」（手机切网 / 页面被杀 / 断网），
 * 以及「房间只剩一个空位」时大厅给不给「加入」。
 *
 *   node tools/probe_ghost.js --use=http://127.0.0.1:8787
 *
 * 关键手法：用裸 TCP 发一条 SSE 请求后**不关闭、也不读**，服务端那条连接一直活着，
 * online 永远不会被 close 事件翻成 false —— 这正是真机上「玩家已经走了」的样子。
 */
'use strict';

const net = require('net');

const BASE = (process.argv.find((a) => a.startsWith('--use=')) || '').slice(6).replace(/\/+$/, '') || 'http://127.0.0.1:8787';
const HOST = BASE.replace(/^https?:\/\//, '').split(':')[0];
const PORT = Number(BASE.split(':').pop()) || 80;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let d = {}; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function rowOf(id) {
  const r = await fetch(BASE + '/api/rooms', { cache: 'no-store' });
  const d = await r.json();
  return (d.rooms || []).find((x) => x.id === id) || null;
}
function show(tag, row) {
  if (!row) return console.log(tag + ' → 房间已不存在');
  console.log(tag + ' → ' + row.id + '  ' + (row.players.A || '（空位）') + ' vs ' + (row.players.B || '（空位）') +
    '  按钮=' + (row.joinable ? '加入' : '观战') + '  watchers=' + row.watchers +
    '  hostOnline=' + row.hostOnline + '  phase=' + row.phase);
}

/* 半开 SSE：发完请求就不管了，就像手机断网后的那条连接 */
function halfOpenSSE(roomId, token, tag) {
  const sock = net.connect(PORT, HOST, () => {
    sock.write('GET /api/room/' + roomId + '/events?t=' + token + ' HTTP/1.1\r\n' +
      'Host: ' + HOST + ':' + PORT + '\r\nAccept: text/event-stream\r\n\r\n');
  });
  sock.on('error', () => {});
  sock.tag = tag;
  return sock;
}

(async () => {
  const stamp = String(Date.now()).slice(-4);
  console.log('BASE = ' + BASE + '\n');

  /* ---------- A. 房主「走了但连接没断」，同昵称回来会怎样 ---------- */
  console.log('=== A. 房主断了网（连接半开），本人用同昵称回来 ===');
  const nickA = '庚' + stamp;
  const c = await post('/api/create', { nick: nickA, size: 8, rounds: 10 });
  const id = c.d.roomId;
  const ghost = halfOpenSSE(id, c.d.token, 'host');
  await sleep(600);
  show('  房主连上后', await rowOf(id));

  /* 别人先占掉青营，把房间坐满 —— 这样「回来的人」只能当观众 */
  const nickB = '辛' + stamp;
  const j = await post('/api/join', { roomId: id, nick: nickB });
  console.log('  ' + nickB + ' 加入 → seat=' + j.d.seat);
  await sleep(400);

  /* 房主本人回来了（新 token、同昵称） */
  const back = await post('/api/join', { roomId: id, nick: nickA });
  console.log('  房主同昵称回来 → status=' + back.status + ' role=' + back.d.role +
    ' seat=' + back.d.seat + ' reclaimed=' + !!back.d.reclaimed);
  if (back.status === 200) {
    const st = back.d.state;
    const meInList = (st.members || []).filter((m) => m.nick === nickA);
    console.log('  他看到的成员列表：' + JSON.stringify(meInList.map((m) => m.nick + (m.seat ? '@' + m.seat : '@观众') + (m.isYou ? '(这是我)' : ''))));
    if (meInList.length && back.d.role !== 'player') {
      console.log('  !! 他已经"离开"了，却仍然看到自己坐在' + (meInList[0].seat || '观众席') + '，而且自己只能以' + back.d.role + '身份旁观');
    }
  }

  /* 房主那条幽灵连接一直挂着 → 席位永远不释放 */
  console.log('  10 秒后再看：');
  await sleep(10000);
  show('   ', await rowOf(id));

  /* ---------- B. 观众幽灵把空房间钉住 ---------- */
  console.log('\n=== B. 观众走了（连接半开），房间还能不能消失 ===');
  const c2 = await post('/api/create', { nick: '壬' + stamp, size: 8, rounds: 10 });
  const id2 = c2.d.roomId;
  const w = await post('/api/join', { roomId: id2, nick: '癸' + stamp });   /* 空位会坐下，所以先占满 */
  const c3 = await post('/api/create', { nick: '子' + stamp, size: 8, rounds: 10 });
  const id3 = c3.d.roomId;
  const host3 = halfOpenSSE(id3, c3.d.token, 'host3');
  const wj = await post('/api/join', { roomId: id3, nick: '丑' + stamp });   /* 坐 B */
  await sleep(300);
  const wj2 = await post('/api/join', { roomId: id3, nick: '寅' + stamp }); /* 坐满了 → 观众 */
  console.log('  第三个身份 → role=' + wj2.d.role);
  const ghostW = halfOpenSSE(id3, wj2.d.token, 'watcher');
  await sleep(500);
  show('  三个人都在', await rowOf(id3));

  /* 两位选手都正常离开，只剩那个半开的观众 */
  await post('/api/room/' + id3 + '/leave', { t: c3.d.token });
  await post('/api/room/' + id3 + '/leave', { t: wj.d.token });
  await sleep(800);
  show('  两位选手都走了', await rowOf(id3));
  console.log('  等 20 秒（观众掉线清理阈值是 120 秒，但这条连接没断，goneSince 永远返回 0）：');
  await sleep(20000);
  show('  20 秒后', await rowOf(id3));
  console.log('  !! 房间本该在选手都走光后消失，只要还有一条半开的观众连接就会一直留在列表里');

  /* ---------- C. 只剩赤营空着时，大厅给不给「加入」 ---------- */
  console.log('\n=== C. 房里只有青营有人等着，赤营空着 ===');
  const c4 = await post('/api/create', { nick: '卯' + stamp, size: 8, rounds: 10 });
  const id4 = c4.d.roomId;
  const p4 = await post('/api/join', { roomId: id4, nick: '辰' + stamp });  /* 坐 B */
  await post('/api/room/' + id4 + '/leave', { t: c4.d.token });             /* 房主走了，赤营空出来 */
  await sleep(400);
  const r4 = await rowOf(id4);
  show('  现状', r4);
  if (r4 && r4.players.A === null && r4.players.B && !r4.joinable) {
    console.log('  !! 赤营明明空着，大厅却只给「观战」—— 离开的人回不去，新人想加入也只能围观');
  }

  ghost.destroy(); host3.destroy(); ghostW.destroy();
  await sleep(300);
  console.log('\n（结束）');
  process.exitCode = 0;
})().catch((e) => {
  console.error('probe 自身异常：' + (e && e.stack));
  process.exitCode = 1;
});
