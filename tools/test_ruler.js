'use strict';
/* 裁定来源回归：同样一句「未收录但判有效」，对手判的和裁判判的必须分开标注。
 * 记录里靠 entry.ruler = { nick, ref } 区分：ref 为真＝裁判裁定，前端据此写
 * 「裁判 XX 裁定有效」而不是「对方裁定有效」。
 *
 * 用法：先 node server.js，再 node tools/test_ruler.js */

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let bad = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else {
    bad++;
    let d = '';
    if (detail !== undefined) {
      try { d = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch (_) { d = String(detail); }
    }
    console.log('FAIL  ' + name + (d ? '  → ' + d.slice(0, 220) : ''));
  }
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function peek(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return (await r.json()).state;
}
const midOf = (st, nick) => (st.members.find((m) => m.nick === nick) || {}).mid;
const lastManual = (st) => (st.log || []).filter((e) => e.via === 'manual').pop();

/* 造一句「棋盘上有字、语料里绝不会有」的句子：取一个空格上的字 + 一串生僻字 */
function fakeLine(st, tail) {
  let blank = '';
  for (let i = 0; i < st.chars.length; i++) if (st.board.charAt(i) === '0') { blank = st.chars.charAt(i); break; }
  return blank + tail;
}

(async () => {
  const A = await api('/api/create', { size: 8, rounds: 30, nick: '甲' });
  const B = await api('/api/join', { roomId: A.roomId, nick: '乙' });
  const W = await api('/api/join', { roomId: A.roomId, nick: '裁' });
  let st = await peek(A.roomId, A.token);

  const setRef = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midOf(st, '裁'), on: true });
  check('设观众为裁判', setRef.ok, setRef);

  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  const go = await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  check('双方准备后开局', go.ok && go.started === true, go);
  st = await peek(A.roomId, A.token);
  check('开局后 phase=playing', st.phase === 'playing', st.phase);

  const tokOf = (seat) => (seat === 'A' ? A.token : B.token);
  const nickOf = (seat) => (seat === 'A' ? '甲' : '乙');

  /* ---------- 1. 裁判裁定有效 ---------- */
  const s1 = st.turn;
  const l1 = fakeLine(st, '魑魅魍魉');
  const m1 = await api('/api/room/' + A.roomId + '/move', { t: tokOf(s1), text: l1 });
  check('未收录句进入待裁决', m1.code === 'dispute', m1);
  const d1 = await api('/api/room/' + A.roomId + '/dispute', { t: W.token, accept: true });
  check('裁判可判「有效」', d1.ok && d1.accepted === true, d1);
  st = await peek(A.roomId, A.token);
  const e1 = lastManual(st);
  check('记录入账且 via=manual', !!e1 && e1.team === s1, e1 && e1.team);
  check('裁判裁定的记录带 ruler.ref=true', !!e1 && !!e1.ruler && e1.ruler.ref === true, e1 && e1.ruler);
  check('裁判裁定的记录记下裁定人昵称', !!e1 && e1.ruler.nick === '裁', e1 && e1.ruler);
  const ev1 = (st.events || []).filter((e) => e.type === 'dispute-accept').pop();
  check('事件记录写明是裁判判的', !!ev1 && /裁/.test(ev1.text) && /有效/.test(ev1.text), ev1 && ev1.text);

  /* ---------- 2. 对手裁定有效（同一局，换一边） ---------- */
  const s2 = st.turn;
  check('裁定后轮到另一方', s2 !== s1, s1 + ' → ' + s2);
  const l2 = fakeLine(st, '饕餮狻猊');
  const m2 = await api('/api/room/' + A.roomId + '/move', { t: tokOf(s2), text: l2 });
  check('第二句同样进入待裁决', m2.code === 'dispute', m2);
  const d2 = await api('/api/room/' + A.roomId + '/dispute', { t: tokOf(s1), accept: true });
  check('对手可判「有效」', d2.ok && d2.accepted === true, d2);
  st = await peek(A.roomId, A.token);
  const e2 = lastManual(st);
  check('对手判定的记录带 ruler.ref=false', !!e2 && !!e2.ruler && e2.ruler.ref === false, e2 && e2.ruler);
  check('对手判定的记录记下对手昵称', !!e2 && e2.ruler.nick === nickOf(s1), e2 && e2.ruler);

  /* ---------- 3. 撤销裁判后不再有裁判身份 ---------- */
  const un = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midOf(st, '裁'), on: false });
  check('可撤销裁判', un.ok, un);
  st = await peek(A.roomId, W.token);
  check('撤销后 youRef 归零', st.youRef === false, st.youRef);

  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n结果：全部通过');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e.stack || e.message);
  process.exitCode = 1;
});
