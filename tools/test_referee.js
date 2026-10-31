'use strict';
/* 裁判与开局设置回归。
 * 用法：先 node server.js，再 node tools/test_referee.js
 *
 * 覆盖：谁能当裁判、裁判能做什么（暂停/恢复/撤销/结算/裁决/同意请求/改设置/重抽）、
 *       开局后规则锁死、取消裁判后立刻失去权限、裁判不能替选手出手。 */

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

/* 落子必须真能落在棋盘上：棋盘是随机铺的，写死「床前明月光」时这局正好没这几个字就会假失败。
   所以从语料里挑一句「含棋盘上某个空格字」的真句。 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const BLOB = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'clauses.txt.gz'))).toString('utf8');

function pickLine(state, seed) {
  const need = new Set();
  for (let i = 0; i < state.chars.length; i++) {
    if (state.board.charAt(i) === '0') need.add(state.chars.charAt(i));
  }
  let p = 3000 + ((seed * 7919) % 20000000);
  for (let i = 0; i < 4000; i++) {
    const e = BLOB.indexOf('\n', p);
    if (e < 0) { p = 0; continue; }
    const ln = BLOB.slice(p, e);
    p = e + 1;
    if (ln.length < 5 || ln.length > 12) continue;
    let hit = 0;
    for (const ch of ln) if (need.has(ch)) hit++;
    if (hit >= 2) return ln;
  }
  return null;
}

let bad = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else {
    bad++;
    let d = '';
    if (detail !== undefined) {
      try { d = typeof detail === 'string' ? detail : JSON.stringify(detail); } catch (_) { d = String(detail); }
    }
    console.log('FAIL  ' + name + (d ? '  → ' + d.slice(0, 200) : ''));
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

(async () => {
  const A = await api('/api/create', { size: 10, rounds: 20, nick: '甲' });
  const B = await api('/api/join', { roomId: A.roomId, nick: '乙' });
  const W = await api('/api/join', { roomId: A.roomId, nick: '裁' });
  const W2 = await api('/api/join', { roomId: A.roomId, nick: '副裁' });
  const G = await api('/api/join', { roomId: A.roomId, nick: '路人' });
  let st = await peek(A.roomId, A.token);
  const midW = midOf(st, '裁');
  const midW2 = midOf(st, '副裁');

  /* ---------- 谁是裁判 ---------- */
  check('观众进房默认不是裁判', !midOf(st, '裁') || st.members.find((m) => m.nick === '裁').ref === false);
  const selfRef = await api('/api/room/' + A.roomId + '/ref', { t: W.token, mid: midW, on: true });
  check('观众不能自封裁判', !selfRef.ok, selfRef);
  const refPlayer = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midOf(st, '乙'), on: true });
  check('选手不能被标成裁判', !refPlayer.ok && refPlayer.code === 'is-player', refPlayer);
  const okRef = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midW, on: true });
  check('选手可把观众设为裁判', okRef.ok, okRef);
  st = await peek(A.roomId, W.token);
  check('裁判看到 youRef / canControl', st.youRef === true && st.canControl === true);
  check('成员面板标记裁判', st.members.find((m) => m.nick === '裁').ref === true);
  /* 多个裁判（副裁）；「路人」保持普通观众，后面用来验证权限边界 */
  await api('/api/room/' + A.roomId + '/ref', { t: B.token, mid: midW2, on: true });
  st = await peek(A.roomId, A.token);
  check('可以同时有多个裁判', st.refs.length === 2, st.refs);

  /* ---------- 开局设置 ---------- */
  const chars0 = st.chars;
  const c1 = await api('/api/room/' + A.roomId + '/cfg', { t: W.token, size: 8, extra: 6, rounds: 12, turnSeconds: 60 });
  check('裁判可改设置', c1.ok && c1.cfg.size === 8 && c1.cfg.turnSeconds === 60, c1);
  st = await peek(A.roomId, A.token);
  check('改尺寸后棋盘重铺', st.size === 8 && st.chars.length === 64, { size: st.size, len: st.chars.length });
  const c2 = await api('/api/room/' + A.roomId + '/redraw', { t: W.token });
  st = await peek(A.roomId, A.token);
  check('裁判可重抽棋盘', c2.ok && st.chars !== chars0 && st.chars.length === 64);
  const c3 = await api('/api/room/' + A.roomId + '/cfg', { t: G.token, size: 12 });
  check('普通观众不能改设置', !c3.ok && c3.code === 'not-allowed', JSON.stringify(c3));
  const c3b = await api('/api/room/' + A.roomId + '/redraw', { t: G.token });
  check('普通观众不能重抽棋盘', !c3b.ok && c3b.code === 'not-allowed', JSON.stringify(c3b));

  /* 准备之后改规则 → 双方准备被清掉（规则变了，旧的确认不算数） */
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  st = await peek(A.roomId, A.token);
  check('准备状态已记录', st.ready.A === true);
  const c4 = await api('/api/room/' + A.roomId + '/cfg', { t: W.token, endless: true });
  st = await peek(A.roomId, A.token);
  check('改设置会重置双方准备', c4.ok && st.ready.A === false && st.ready.B === false);
  check('战至最后一刻可切换', c4.cfg.endless === true, c4.cfg);
  await api('/api/room/' + A.roomId + '/redraw', { t: A.token });
  st = await peek(A.roomId, A.token);
  check('重抽棋盘也重置准备', st.ready.A === false);
  await api('/api/room/' + A.roomId + '/cfg', { t: A.token, endless: false });

  /* ---------- 开局后 ---------- */
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  const rs = await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  check('双方准备后开局', rs.started === true);
  const c5 = await api('/api/room/' + A.roomId + '/cfg', { t: A.token, size: 12 });
  check('开局后规则锁死', !c5.ok && c5.code === 'phase', c5);
  const r5 = await api('/api/room/' + A.roomId + '/redraw', { t: W.token });
  check('开局后不能重抽棋盘', !r5.ok && r5.code === 'phase', r5);

  /* 裁判不能出手 */
  const mvRef = await api('/api/room/' + A.roomId + '/move', { t: W.token, text: '床前明月光' });
  check('裁判不能替选手出手', !mvRef.ok, mvRef);
  const seatRef = await api('/api/room/' + A.roomId + '/ready', { t: W.token, ready: true });
  check('裁判不能点准备', !seatRef.ok, seatRef);

  /* ---------- 暂停 / 恢复 ---------- */
  const p1 = await api('/api/room/' + A.roomId + '/pause', { t: W.token });
  st = await peek(A.roomId, B.token);
  check('裁判可暂停（选手能看到）', p1.ok && st.paused && st.paused.byRef === true && st.paused.byNick === '裁');
  const p2 = await api('/api/room/' + A.roomId + '/pause', { t: W.token });
  check('裁判可恢复', p2.ok && p2.resumed, p2);
  const p3 = await api('/api/room/' + A.roomId + '/pause', { t: G.token });
  check('普通观众不能暂停', !p3.ok, p3);

  /* ---------- 裁决未收录句 ---------- */
  const chRef = st.chars ? st.chars.charAt(0) : '春';
  const mv = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: chRef + '魑魅魍魉饕餮' });
  check('未收录句进入待裁决', mv.code === 'dispute', mv);
  const dj = await api('/api/room/' + A.roomId + '/dispute', { t: W.token, accept: false });
  check('裁判可裁决（判重填）', dj.ok && dj.rejected, dj);
  /* 提交方本人仍然只能撤回，裁判不享受这条分支 */
  await api('/api/room/' + A.roomId + '/move', { t: A.token, text: chRef + '魑魅魍魉饕餮' });
  const self = await api('/api/room/' + A.roomId + '/dispute', { t: A.token, accept: true });
  check('提交方自己点＝撤回而不是判有效', self.ok && self.cancelled, self);

  /* ---------- 撤销 / 结算 ---------- */
  const stNow = await peek(A.roomId, A.token);
  const line = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: pickLine(stNow, 5) });
  check('选手正常落一手', line.ok, line);
  const u1 = await api('/api/room/' + A.roomId + '/undo', { t: W.token });
  check('裁判撤销直接生效（不生成请求）', u1.ok && u1.byRef && u1.undone, u1);
  st = await peek(A.roomId, A.token);
  check('撤销后请求栏为空', !st.req);

  const f1 = await api('/api/room/' + A.roomId + '/finish', { t: B.token });
  check('选手提前结算＝发请求', f1.ok && !!f1.req, f1);
  const ag = await api('/api/room/' + A.roomId + '/consent', { t: W.token, accept: true });
  check('裁判可代批选手的请求', ag.ok && ag.finished, ag);
  st = await peek(A.roomId, A.token);
  check('结算后 phase=finished', st.phase === 'finished');
  const rm = await api('/api/room/' + A.roomId + '/rematch', { t: W.token });
  check('裁判可开新局', rm.ok, rm);
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  const f2 = await api('/api/room/' + A.roomId + '/finish', { t: W.token });
  st = await peek(A.roomId, A.token);
  check('裁判直接结算（不生成请求）', f2.ok && f2.byRef && f2.finished && st.phase === 'finished', f2);

  /* ---------- 取消裁判 ---------- */
  const un = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midW, on: false });
  check('可取消裁判', un.ok, un);
  st = await peek(A.roomId, W.token);
  check('取消后立刻失去权限', st.youRef === false && st.canControl === false);
  const afterPause = await api('/api/room/' + A.roomId + '/pause', { t: W.token });
  check('取消后不能再暂停', !afterPause.ok, afterPause);

  console.log('\n结果：' + (bad ? bad + ' 项失败' : '全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
