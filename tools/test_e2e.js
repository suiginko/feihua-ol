'use strict';
/* 端到端：起两个客户端，把一局真的打完，检查
   1) 轮流出手   2) 判定拦截   3) 涂色/抢夺统计   4) 结算
   用法：先 node server.js，再 node tools/test_e2e.js             */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const blob = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'clauses.txt.gz'))).toString('utf8');

function lines(from, count) {
  const out = [];
  let p = from;
  for (let i = 0; i < count; i++) {
    const e = blob.indexOf('\n', p);
    if (e < 0) break;
    out.push(blob.slice(p, e));
    p = e + 1;
  }
  return { list: out, next: p };
}

async function getState(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  const d = await r.json();
  return d.state;
}

async function api(name, body, url) {
  const r = await fetch(url || BASE + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}

function findLineFor(state, used, seed) {
  const need = new Set();
  for (let i = 0; i < state.chars.length; i++) {
    if (state.board.charAt(i) === '0') need.add(state.chars.charAt(i));
  }
  let p = 1000 + ((seed * 7919) % 20000000);
  for (let round = 0; round < 4000; round++) {
    const { list, next } = lines(p, 60);
    for (const ln of list) {
      if (ln.length < 5 || ln.length > 14) continue;
      if (used.has(ln)) continue;
      let hit = 0;
      for (const ch of ln) if (need.has(ch)) hit++;
      if (hit >= 2) return ln;
    }
    p = next;
    if (p >= blob.length) p = 0;
  }
  return null;
}

(async () => {
  const created = await api('/api/create', { nick: '甲', size: 8, rounds: 30 });
  if (!created.ok) throw new Error('建房失败 ' + JSON.stringify(created));
  const A = { roomId: created.roomId, token: created.token, seat: 'A' };
  const joined = await api('/api/join', { roomId: created.roomId, nick: '乙' });
  if (!joined.ok) throw new Error('加入失败 ' + JSON.stringify(joined));
  const B = { roomId: created.roomId, token: joined.token, seat: 'B' };

  let st = joined.state;
  console.log('房间 %s 开好，棋盘 %d 格，轮到 %s', st.id, st.chars.length, st.turn);
  if (st.phase !== 'waiting') throw new Error('两人到齐但都没准备，应保持 waiting，实际 ' + st.phase);

  // 双方各点一次「准备好了」才开局
  const rA = await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  const rB = await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  if (!rA.ok || !rB.ok) throw new Error('准备请求失败 ' + JSON.stringify([rA, rB]));
  if (!rB.started) throw new Error('双方准备后应开局，实际 started=' + rB.started);
  st = await getState(A.roomId, A.token);
  if (st.phase !== 'playing') throw new Error('双方准备后应进入 playing，实际 ' + st.phase);

  // 1) 不该轮到你时出手
  const early = await api('/api/room/' + A.roomId + '/move', { t: B.token, text: '床前明月光' });
  console.log('越位出手 →', early.ok ? '!! 竟然通过了' : '被拒：' + early.reason);
  if (early.ok) throw new Error('越位出手未被拒绝');

  // 2) 伪造句：包含棋盘上的未涂色格但语料查不到，冻结计时交给对方裁决
  const me = A;
  const fakeLine = st.chars.charAt(0) + '编造假诗未收录测试句';
  const fake = await api('/api/room/' + me.roomId + '/move', { t: me.token, text: fakeLine });
  console.log('伪造句 →', fake.ok ? '!! 竟然通过了' : (fake.code === 'dispute' ? '挂起待裁决：' + fake.reason : '被拒：' + fake.reason));
  if (fake.ok || fake.code !== 'dispute') throw new Error('伪造句应进入待裁决，实际 ' + JSON.stringify(fake).slice(0, 120));
  let ds = await getState(A.roomId, A.token);
  if (ds.dispute == null) throw new Error('未见 dispute 状态');
  // 争议期间不能出手，也不能放弃
  const blocked = await api('/api/room/' + me.roomId + '/move', { t: me.token, text: '床前明月光' });
  if (blocked.ok || blocked.code !== 'dispute') throw new Error('争议期间还能出手！');
  // 提交方自己点 = 撤回
  const selfDecide = await api('/api/room/' + me.roomId + '/dispute', { t: me.token, accept: true });
  console.log('提交方自行裁决 →', selfDecide.cancelled ? '被当成撤回（正确）' : '!! 竟然能自己判有效');
  if (!selfDecide.cancelled) throw new Error('提交方不该能自己判有效');

  // 再来一次，由对方判「需重新提交」
  await api('/api/room/' + me.roomId + '/move', { t: me.token, text: fakeLine });
  const deny = await api('/api/room/' + me.roomId + '/dispute', { t: B.token, accept: false });
  if (!deny.rejected) throw new Error('对方判重填失败 ' + JSON.stringify(deny));
  st = await getState(A.roomId, A.token);
  if (st.turn !== 'A' || st.dispute) throw new Error('重填后应仍轮到 A 且无争议，实际 ' + st.turn);
  const leftAfter = Math.round((st.deadline - st.serverNow) / 1000);
  console.log('裁决后计时恢复：剩余 %d 秒（应接近整轮）', leftAfter);

  // 第三次由对方判「有效」，按字面涂色入账
  await api('/api/room/' + me.roomId + '/move', { t: me.token, text: fakeLine });
  const yes = await api('/api/room/' + me.roomId + '/dispute', { t: B.token, accept: true });
  if (yes.ok && !yes.accepted) throw new Error('对方判有效失败 ' + JSON.stringify(yes));
  st = await getState(A.roomId, A.token);
  const manual = st.log.filter((e) => e.via === 'manual');
  console.log('裁定有效 → %s', yes.ok ? ('已入账 ' + (manual.length ? '（via=manual）' : '!! 没找到 manual 记录')) : ('判不了：' + yes.reason));
  if (yes.ok && !manual.length) throw new Error('裁定有效却没入账');
  if (!yes.ok) {
    /* 假句里可能一个字都不在棋盘上：此时应拒判并保留争议，再撤回 */
    console.log('  （该句没有棋盘上的字，无法裁为有效，符合预期）');
    await api('/api/room/' + me.roomId + '/dispute', { t: A.token, accept: false });
  }

  const used = new Set();
  let moves = 0, rejected = 0, last = null;
  const seen = { A: 0, B: 0 };

  for (let i = 0; i < 400; i++) {
    const who = st.turn === 'A' ? A : B;
    const line = findLineFor(st, used, i + 1);
    /* 残局只剩几个生僻字时可能真的找不到句子：正常打法就是放弃这一手 */
    if (!line) {
      await api('/api/room/' + who.roomId + '/pass', { t: who.token });
      st = await getState(who.roomId, who.token);
      if (st.phase === 'finished') break;
      continue;
    }
    const res = await api('/api/room/' + who.roomId + '/move', { t: who.token, text: line });
    if (!res.ok) {
      rejected++;
      if (rejected < 4) console.log('  拒绝 %s：%s（%s）', line, res.reason, res.code);
      used.add(line);
      if (rejected > 60) throw new Error('拒绝太多，判定可能有系统性问题');
      continue;
    }
    used.add(line);
    moves++;
    seen[who.seat]++;
    st = await getState(who.roomId, who.token);
    last = res.entry;
    if (moves <= 3) {
      console.log('  %s 出「%s」→ 命中 %d（新占 %d 抢夺 %d）· 出自《%s》%s',
        who.seat, line, last.hits, last.blank, last.capture,
        last.source ? last.source.title : '?', last.source ? last.source.author : '');
    }
    if (st.phase === 'finished') break;
  }

  console.log('\n结束：%d 手（拒绝 %d 次）· 比分 %d:%d · 未涂色 %d · 原因「%s」',
    moves, rejected, st.score.a, st.score.b, st.score.n, st.reason);
  console.log('轮流检查：赤 %d 手 / 青 %d 手，差 %d', seen.A, seen.B, Math.abs(seen.A - seen.B));

  let bad = 0;
  if (Math.abs(seen.A - seen.B) > 1) { console.log('!! 轮次不均衡'); bad++; }
  if (st.score.a + st.score.b + st.score.n !== st.chars.length) { console.log('!! 格子总数对不上'); bad++; }
  if (st.phase !== 'finished') { console.log('!! 未结算'); bad++; }
  console.log(bad ? '\n失败 ' + bad + ' 项' : '\n全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('异常：', e.message); process.exit(1); });
