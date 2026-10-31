/* 离开 / 重进 现场取证：把玩家退出房间的每条路径都跑一遍，打印服务端真实状态。
 *
 *   node tools/probe_leave.js                 自起临时实例（8799-8820）跑完关掉
 *   node tools/probe_leave.js --use=http://127.0.0.1:8787
 *
 * 这不是回归测试（先取证、后写断言）。输出里带 !! 的行就是可疑现象。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const useArg = process.argv.find((a) => a.startsWith('--use='));

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function pickPort() {
  for (let p = 8799; p <= 8820; p++) if (await portFree(p)) return p;
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 最小 SSE 客户端：记录最后一份 state ---------- */
class Link {
  constructor(base, roomId, token) {
    this.name = '';
    this.state = null;
    this.closed = false;
    this.base = base;
    this.url = base + '/api/room/' + roomId + '/events?t=' + encodeURIComponent(token);
  }
  async open() {
    this.ctrl = new AbortController();
    const r = await fetch(this.url, { signal: this.ctrl.signal, headers: { Accept: 'text/event-stream' } });
    this.status = r.status;
    if (!r.ok) return this;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    this.reader = reader;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const msg = JSON.parse(line.slice(6));
                if (msg.type === 'state') this.state = msg.state;
              } catch (_) {}
            }
          }
        }
      } catch (_) { /* aborted */ }
    })();
    return this;
  }
  close() {
    this.closed = true;
    try { this.ctrl.abort(); } catch (_) {}
    /* cancel() 返回 Promise，abort 之后它会以 AbortError 拒绝 —— 不接住就是未捕获拒绝 */
    try { this.reader && this.reader.cancel().catch(() => {}); } catch (_) {}
  }
  /* 自己在这份 state 里长什么样 */
  get me() {
    const st = this.state;
    if (!st) return null;
    return { role: st.role, you: st.you, nick: st.youNick, mid: st.youMid, members: (st.members || []).map((m) => m.nick + (m.seat ? '@' + m.seat : m.kind === 'watcher' ? '@watch' : '@空')) };
  }
}

async function post(base, url, body) {
  const r = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function getJSON(base, url) {
  const r = await fetch(base + url, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function roomRow(base, id) {
  const { d } = await getJSON(base, '/api/rooms');
  return (d.rooms || []).find((x) => x.id === id) || null;
}
function show(tag, row) {
  if (!row) { console.log(tag + ' → 房间已不存在'); return; }
  const p = row.players || {};
  const brief = (x) => (x ? x : '（空位）');
  console.log(tag + ' → ' + row.id + '  ' + brief(p.A) + ' vs ' + brief(p.B) +
    '  phase=' + row.phase + '  watchers=' + (row.watchers || 0) +
    '  hostOnline=' + row.hostOnline);
}

(async () => {
  let base = null, child = null;
  if (useArg) {
    base = useArg.slice('--use='.length).replace(/\/+$/, '');
  } else {
    const port = await pickPort();
    if (!port) { console.error('!! 找不到空端口'); process.exit(1); }
    base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        DATA_DIR: require('./_tmpdir')('probe-leave'),   /* 别写进项目的 data/ */
      }),
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/api/rooms')).ok) break; } catch (_) {}
      await sleep(300);
    }
  }
  console.log('BASE = ' + base + '\n');

  const stamp = String(Date.now()).slice(-4);
  const A = '甲' + stamp, B = '乙' + stamp;

  /* ========== 场景 1：两人房，选手主动离开 ========== */
  console.log('=== 场景 1：甲乙两人，乙点「离开房间」 ===');
  const c = await post(base, '/api/create', { nick: A, size: 8, rounds: 10 });
  const id = c.d.roomId;
  const la = await new Link(base, id, c.d.token).open();
  console.log('甲建了房 ' + id + '，SSE=' + la.status);
  await sleep(200);

  const j = await post(base, '/api/join', { roomId: id, nick: B });
  const lb = await new Link(base, id, j.d.token).open();
  console.log('乙加入：seat=' + j.d.seat + '，SSE=' + lb.status);
  await sleep(300);
  show('  离开前', await roomRow(base, id));
  console.log('  甲看到：' + JSON.stringify(la.me));

  /* 前端实际顺序：先关 SSE，再 POST /leave */
  lb.close();
  await sleep(100);
  const lv = await post(base, '/api/room/' + id + '/leave', { t: j.d.token });
  console.log('  /leave → ' + lv.status + ' ' + JSON.stringify(lv.d));
  await sleep(600);
  show('  离开后', await roomRow(base, id));
  console.log('  甲看到：' + JSON.stringify(la.me));

  /* ========== 场景 2：立刻用同昵称重进 ========== */
  console.log('\n=== 场景 2：乙立刻用同昵称重进 ===');
  const j2 = await post(base, '/api/join', { roomId: id, nick: B });
  console.log('  重进 → status=' + j2.status + ' seat=' + j2.d.seat + ' reclaimed=' + !!j2.d.reclaimed + ' role=' + j2.d.role);
  show('  重进后', await roomRow(base, id));
  if (j2.status === 200) {
    const lb2 = await new Link(base, id, j2.d.token).open();
    await sleep(200);
    console.log('  乙看到：' + JSON.stringify(lb2.me));
    lb2.close();
  }

  /* ========== 场景 3：只关页面（不调 /leave），随后重进 ========== */
  console.log('\n=== 场景 3：乙直接关掉页面（不调 /leave），再重进 ===');
  if (j2.status === 200) {
    /* 关掉 SSE＝关页面；服务端在 close 里标 offline */
    await sleep(400);
    const j3 = await post(base, '/api/join', { roomId: id, nick: B });
    console.log('  重进 → status=' + j3.status + ' seat=' + j3.d.seat + ' reclaimed=' + !!j3.d.reclaimed + ' role=' + j3.d.role);
    show('  重进后', await roomRow(base, id));
    console.log('  甲看到：' + JSON.stringify(la.me));
    if (j3.status === 200 && j3.d.token) await post(base, '/api/room/' + id + '/leave', { t: j3.d.token });
  }

  /* ========== 场景 4：乙作为观众加入后离开 ========== */
  console.log('\n=== 场景 4：观众进进出出 ===');
  const w1 = await post(base, '/api/join', { roomId: id, nick: '丙' + stamp });
  const lw = await new Link(base, id, w1.d.token).open();
  await sleep(200);
  console.log('  丙以 ' + w1.d.role + ' 进来，watchers=' + ((await roomRow(base, id)) || {}).watchers);
  lw.close();
  await post(base, '/api/room/' + id + '/leave', { t: w1.d.token });
  await sleep(400);
  console.log('  丙离开后 watchers=' + ((await roomRow(base, id)) || {}).watchers);

  /* ========== 场景 5：最后一个人离开 → 房间该消失 ========== */
  console.log('\n=== 场景 5：所有人都离开，房间该在 10 秒清扫内消失 ===');
  await post(base, '/api/room/' + id + '/leave', { t: c.d.token });
  la.close();
  await sleep(500);
  show('  离开后立刻', await roomRow(base, id));
  for (const t of [1, 3, 6, 11, 16]) {
    await sleep(t === 1 ? 1000 : (t - (t === 3 ? 1 : t === 6 ? 3 : t === 11 ? 6 : 11)) * 1000);
    show('  ' + t + 's', await roomRow(base, id));
  }

  /* ========== 场景 6：单人建房后立刻离开 ========== */
  console.log('\n=== 场景 6：单人建房 → 立刻离开 → 房间是否消失 ===');
  const c2 = await post(base, '/api/create', { nick: '丁' + stamp, size: 8, rounds: 10 });
  const l2 = await new Link(base, c2.d.roomId, c2.d.token).open();
  await sleep(200);
  show('  建房后', await roomRow(base, c2.d.roomId));
  l2.close();
  await post(base, '/api/room/' + c2.d.roomId + '/leave', { t: c2.d.token });
  for (const t of [1, 11]) {
    await sleep(t === 1 ? 1000 : 10000);
    show('  ' + t + 's', await roomRow(base, c2.d.roomId));
  }

  /* ========== 场景 7：房主离开、对手留下，房间必须活着 ========== */
  console.log('\n=== 场景 7：房主离开，对手还在房里等 ===');
  const c3 = await post(base, '/api/create', { nick: '戊' + stamp, size: 8, rounds: 10 });
  const id3 = c3.d.roomId;
  const l3 = await new Link(base, id3, c3.d.token).open();
  const jx = await post(base, '/api/join', { roomId: id3, nick: '己' + stamp });
  const lx = await new Link(base, id3, jx.d.token).open();
  await sleep(300);
  l3.close();
  await post(base, '/api/room/' + id3 + '/leave', { t: c3.d.token });
  await sleep(600);
  show('  房主离开后', await roomRow(base, id3));
  console.log('  己看到：' + JSON.stringify(lx.me));
  /* 己还想把房主的位置坐回来？ */
  const seatBack = await post(base, '/api/room/' + id3 + '/seat', { t: jx.d.token, seat: 'A' });
  console.log('  己补位到赤营 → ' + JSON.stringify(seatBack.d));
  show('  补位后', await roomRow(base, id3));
  lx.close();

  console.log('\n（结束）');
  if (child) { try { child.kill(); } catch (_) {} }
  /* 不要用 process.exit()：Windows 上管道/文件里的 stdout 是异步写的，
     立刻退出会把还没落盘的输出整段吞掉（看起来就是「跑完了但一个字都没有」）。 */
  process.exitCode = 0;
})().catch((e) => {
  console.error('probe 自身异常：' + (e && e.stack));
  process.exitCode = 1;
});
