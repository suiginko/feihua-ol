'use strict';
/* 房间操作回归：三位房号 / 每步时间 / 撤销一步（需对方同意）/ 提前结算（需对方同意）。
 * 用法：先 node server.js，再 node tools/test_room_ops.js
 * 依赖 data/clauses.txt.gz 里的真实句子，确保「飞一句」能通过判定。 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const blob = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'data', 'clauses.txt.gz'))).toString('utf8');

let bad = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else { bad++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
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
  const d = await r.json();
  return d.state;
}

function linesFrom(p0, n) {
  const out = [];
  let p = p0;
  for (let i = 0; i < n; i++) {
    const e = blob.indexOf('\n', p);
    if (e < 0) break;
    out.push(blob.slice(p, e));
    p = e + 1;
  }
  return { list: out, next: p };
}

/* 找一句能落在空白格上的真句（命中 ≥2 格，判定更容易通过） */
function findLine(st, seed) {
  const need = new Set();
  for (let i = 0; i < st.chars.length; i++) if (st.board.charAt(i) === '0') need.add(st.chars.charAt(i));
  let p = 1000 + ((seed * 7919) % 20000000);
  for (let round = 0; round < 4000; round++) {
    const { list, next } = linesFrom(p, 60);
    for (const ln of list) {
      if (ln.length < 5 || ln.length > 14) continue;
      let hit = 0;
      for (const ch of ln) if (need.has(ch)) hit++;
      if (hit >= 2) return ln;
    }
    p = next;
    if (p >= blob.length) p = 0;
  }
  return null;
}

const owned = (st) => st.board.split('').filter((c) => c !== '0').length;

(async () => {
  /* ---------- 1. 三位房号 + 每步时间 ---------- */
  const created = await api('/api/create', { nick: '甲', size: 8, rounds: 30, turnSeconds: 45 });
  if (!created.ok) throw new Error('建房失败 ' + JSON.stringify(created));
  check('房号是三位纯数字', /^\d{3}$/.test(created.roomId), '实际 ' + created.roomId);
  check('自定义每步时间 45 秒被接受', created.state.cfg.turnSeconds === 45, '实际 ' + created.state.cfg.turnSeconds);

  const dflt = await api('/api/create', { nick: '测试', size: 6 });
  check('每步时间默认 120 秒', dflt.state.cfg.turnSeconds === 120, '实际 ' + dflt.state.cfg.turnSeconds);

  const clamp = await api('/api/create', { nick: '测试', size: 6, turnSeconds: 9999 });
  check('每步时间上限夹到 600 秒', clamp.state.cfg.turnSeconds === 600, '实际 ' + clamp.state.cfg.turnSeconds);

  const A = { roomId: created.roomId, token: created.token };
  const joined = await api('/api/join', { roomId: created.roomId, nick: '乙' });
  const B = { roomId: created.roomId, token: joined.token };
  let st = joined.state;

  /* ---------- 1.5 准备机制：都点了才开局 ---------- */
  check('两人到齐但未准备时不开局', st.phase === 'waiting', st.phase);
  const rA = await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  check('A 单独准备后仍未开局', rA.ok && !rA.started && rA.ready.A === true && rA.ready.B === false, JSON.stringify(rA.ready));
  const rB = await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  check('双方准备后开局', rB.ok && rB.started === true, JSON.stringify(rB).slice(0, 160));
  st = await peek(A.roomId, A.token);
  check('开局后 phase=playing', st.phase === 'playing', st.phase);
  check('开局后 ready 已重置', st.ready.A === false && st.ready.B === false, JSON.stringify(st.ready));

  const left = Math.round((st.deadline - st.serverNow) / 1000);
  check('倒计时按 45 秒走', Math.abs(left - 45) <= 2, '实际 ' + left + ' 秒');

  /* ---------- 1.6 暂停 / 继续 ---------- */
  const p1 = await api('/api/room/' + A.roomId + '/pause', { t: A.token });
  check('任一方可暂停', p1.ok && !!p1.paused, JSON.stringify(p1).slice(0, 120));
  st = await peek(A.roomId, B.token);
  check('对方能看到已暂停', !!st.paused && st.paused.by === 'A', JSON.stringify(st.paused));
  const frozen = Math.round(st.paused.left / 1000);
  check('暂停时剩余时间被冻结（约 45 秒）', Math.abs(frozen - 45) <= 2, '实际 ' + frozen);
  const blocked = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: findLine(st, 3) });
  check('暂停期间不能出手', !blocked.ok && blocked.code === 'paused', JSON.stringify(blocked).slice(0, 120));
  const p2 = await api('/api/room/' + A.roomId + '/pause', { t: B.token });
  check('对方也能点继续', p2.ok && p2.resumed === true && !p2.paused, JSON.stringify(p2).slice(0, 120));
  st = await peek(A.roomId, A.token);
  check('继续后倒计时恢复', Math.abs(Math.round((st.deadline - st.serverNow) / 1000) - 45) <= 2, '实际 ' + Math.round((st.deadline - st.serverNow) / 1000));

  /* ---------- 1.7 大厅房间列表 ---------- */
  const openRoom = await api('/api/create', { nick: '空房主', size: 6 });
  const rr = await (await fetch(BASE + '/api/rooms')).json();
  check('房间列表接口可用', rr.ok === true && Array.isArray(rr.rooms), JSON.stringify(rr).slice(0, 120));
  const mineRow = rr.rooms.find((x) => x.id === created.roomId);
  check('列表能查到正在对局的房间', !!mineRow, '共 ' + rr.rooms.length + ' 间');
  if (mineRow) {
    check('列表带房号/规格/进度', mineRow.size === 8 && mineRow.turnSeconds === 45 && mineRow.phase === 'playing',
      JSON.stringify(mineRow).slice(0, 160));
    check('对局中的房间不可加入', mineRow.joinable === false, String(mineRow.joinable));
    check('列表不泄露 token', !JSON.stringify(mineRow).includes(created.token) && !JSON.stringify(mineRow).includes(joined.token));
  }
  const openRow = rr.rooms.find((x) => x.id === openRoom.roomId);
  check('空房间标记为可加入', !!openRow && openRow.joinable === true && openRow.players.B === null,
    JSON.stringify(openRow || {}).slice(0, 140));
  /* 排序契约：正在打、且房里还有人的局必须排在最前（那是最容易被「看不到自己那局」
     的场景），其次是能坐进去的空位房，最后才是满员观战的。
     老版本只按 joinable 排、再截前 24 条，大厅攒下二十几间空等房之后，
     真正在进行的局就被挤出列表了 —— 这条断言就是为它写的。 */
  check('进行中的局排在最前', rr.rooms[0].phase === 'playing' && rr.rooms[0].live === true,
    '首行 ' + rr.rooms[0].id + ' ' + rr.rooms[0].phase + ' live=' + rr.rooms[0].live);
  const firstJoinable = rr.rooms.findIndex((x) => x.joinable);
  const lastLive = rr.rooms.map((x) => x.phase === 'playing' && x.live).lastIndexOf(true);
  check('可加入的房间紧随其后', firstJoinable > lastLive,
    '首个可加入在第 ' + firstJoinable + ' 行，最后一个进行中在第 ' + lastLive + ' 行');

  /* ---------- 2. 撤销：空栈不给撤 ---------- */
  const empty = await api('/api/room/' + A.roomId + '/undo', { t: A.token });
  check('还没出手时撤销被拒', !empty.ok && empty.code === 'empty', JSON.stringify(empty));

  /* ---------- 3. 飞一手 ---------- */
  const line = findLine(st, 3);
  const mv = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: line });
  check('A 飞花成功（' + line + '）', mv.ok === true, JSON.stringify(mv).slice(0, 120));
  st = await peek(A.roomId, A.token);
  const afterMove = owned(st);
  check('棋盘已上色', afterMove > 0, '上色格 ' + afterMove);
  check('记录 1 条', st.log.length === 1, '实际 ' + st.log.length);
  check('可以撤销（canUndo）', st.canUndo === true);

  /* ---------- 4. 撤销需要对方同意 ---------- */
  const req = await api('/api/room/' + A.roomId + '/undo', { t: A.token });
  check('A 发出撤销请求', req.ok && req.req.type === 'undo', JSON.stringify(req));
  st = await peek(B.roomId, B.token);
  check('B 能看到待确认请求', !!(st.req && st.req.type === 'undo' && st.req.by === 'A'), JSON.stringify(st.req));
  check('请求未确认前局面不变', owned(st) === afterMove, '上色格 ' + owned(st));

  const selfConsent = await api('/api/room/' + A.roomId + '/consent', { t: A.token, accept: true });
  check('发起方自己点同意＝取消请求', selfConsent.ok && selfConsent.cancelled === true, JSON.stringify(selfConsent));
  check('取消后回到无请求状态', (await peek(A.roomId, A.token)).req === null);

  await api('/api/room/' + A.roomId + '/undo', { t: A.token });
  const denied = await api('/api/room/' + A.roomId + '/consent', { t: B.token, accept: false });
  check('B 拒绝后请求清空', denied.ok && denied.denied === true, JSON.stringify(denied));
  st = await peek(A.roomId, A.token);
  check('拒绝后局面保持不变', owned(st) === afterMove && st.log.length === 1, '上色格 ' + owned(st));

  /* ---------- 5. 同意撤销 → 回到上一步 ---------- */
  await api('/api/room/' + A.roomId + '/undo', { t: B.token });
  const acc = await api('/api/room/' + A.roomId + '/consent', { t: A.token, accept: true });
  check('A 同意撤销', acc.ok && acc.undone === true, JSON.stringify(acc));
  st = await peek(A.roomId, A.token);
  check('撤销后棋盘回到空白', owned(st) === 0, '上色格 ' + owned(st));
  check('撤销后记录清空', st.log.length === 0, '实际 ' + st.log.length);
  check('撤销后轮到 A 且在对局中', st.turn === 'A' && st.phase === 'playing', st.turn + '/' + st.phase);
  check('撤销后 canUndo 变假', st.canUndo === false);

  /* ---------- 6. 提前结算需要对方同意 ---------- */
  const fin = await api('/api/room/' + A.roomId + '/finish', { t: A.token });
  check('A 发出提前结算请求', fin.ok && fin.req.type === 'finish', JSON.stringify(fin));
  check('结算前仍是 playing', (await peek(A.roomId, B.token)).phase === 'playing');
  const finNo = await api('/api/room/' + B.roomId + '/consent', { t: B.token, accept: false });
  check('B 可以拒绝提前结算', finNo.ok && finNo.denied === true, JSON.stringify(finNo));
  check('拒绝后仍在对局中', (await peek(A.roomId, A.token)).phase === 'playing');

  await api('/api/room/' + A.roomId + '/finish', { t: A.token });
  const finYes = await api('/api/room/' + A.roomId + '/consent', { t: B.token, accept: true });
  check('B 同意提前结算', finYes.ok && finYes.finished === true, JSON.stringify(finYes));
  st = await peek(A.roomId, A.token);
  check('结算后 phase=finished', st.phase === 'finished', st.phase);
  check('结算原因标记为提前结算', st.reason === '提前结算', st.reason);

  /* ---------- 7. 再来一局也要双方准备 ---------- */
  const rm = await api('/api/room/' + A.roomId + '/rematch', { t: B.token });
  check('再来一局只是摆好新棋盘', rm.ok && rm.waitingReady === true, JSON.stringify(rm));
  st = await peek(A.roomId, A.token);
  check('再来一局后回到 waiting', st.phase === 'waiting', st.phase);
  check('再来一局后准备状态清空', !st.ready.A && !st.ready.B, JSON.stringify(st.ready));
  check('再来一局后有新棋盘', st.chars.length > 0 && owned(st) === 0, st.chars.length + ' 格');
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  check('单方准备仍不开局', (await peek(A.roomId, A.token)).phase === 'waiting');
  await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  check('双方准备后新局开始', (await peek(A.roomId, A.token)).phase === 'playing');

  /* ---------- 8. 观众 / 席位互换 ---------- */
  const w1 = await api('/api/join', { roomId: A.roomId, nick: '看客' });
  check('坐满后加入＝观众', w1.ok && w1.role === 'spectator' && w1.seat === null, JSON.stringify(w1).slice(0, 120));
  const W = { roomId: A.roomId, token: w1.token };
  const ws = await peek(A.roomId, W.token);
  check('观众能拿到房间状态', ws && ws.id === A.roomId && ws.role === 'watcher', ws && ws.role);
  check('观众不计入选手席位', ws.you === null && ws.watchers === 1, 'you=' + ws.you + ' 观众=' + ws.watchers);

  const wMove = await api('/api/room/' + A.roomId + '/move', { t: W.token, text: '床前明月光' });
  check('观众不能出手', !wMove.ok, JSON.stringify(wMove).slice(0, 100));
  const wJudge = await api('/api/room/' + A.roomId + '/dispute', { t: W.token, accept: true });
  check('观众不能裁决', !wJudge.ok, JSON.stringify(wJudge).slice(0, 100));

  const standA = await api('/api/room/' + A.roomId + '/stand', { t: A.token });
  check('选手可以下场当观众', standA.ok && standA.seat === null, JSON.stringify(standA));
  st = await peek(A.roomId, B.token);
  check('下场后席位空出来', st.seats.A === null, JSON.stringify(st.seats));
  check('下场后自动冻结计时（缺人暂停）', !!st.paused && st.paused.why === 'seat-empty', JSON.stringify(st.paused));
  const afterStand = Math.round((st.deadline - st.serverNow) / 1000);
  await new Promise((r) => setTimeout(r, 1200));
  const stillSame = await peek(A.roomId, B.token);
  check('缺人暂停期间秒数不走', Math.abs(Math.round((stillSame.deadline - stillSame.serverNow) / 1000) - afterStand) <= 1,
    afterStand + ' → ' + Math.round((stillSame.deadline - stillSame.serverNow) / 1000));

  const bStand = await api('/api/room/' + A.roomId + '/stand', { t: B.token });
  check('另一方也能下场', bStand.ok, JSON.stringify(bStand));
  const bothEmpty = await peek(A.roomId, W.token);
  check('两人都下场后座位全空', bothEmpty.seats.A === null && bothEmpty.seats.B === null);
  check('下场的人计入观众席', bothEmpty.watchers === 3, '观众 ' + bothEmpty.watchers + '（原 1 + 下场 2）');

  const sitW = await api('/api/room/' + A.roomId + '/seat', { t: W.token, seat: 'A' });
  check('观众可以补上空位', sitW.ok && sitW.seat === 'A', JSON.stringify(sitW));
  st = await peek(A.roomId, W.token);
  check('补位后身份变选手', st.you === 'A' && st.role === 'player', st.you + '/' + st.role);
  check('仍缺一人，继续冻结', !!st.paused && st.paused.why === 'seat-empty', JSON.stringify(st.paused));
  const sitAgain = await api('/api/room/' + A.roomId + '/seat', { t: A.token, seat: 'A' });
  check('位子有人时不能再坐', !sitAgain.ok && sitAgain.code === 'taken', JSON.stringify(sitAgain));

  const sitA2 = await api('/api/room/' + A.roomId + '/seat', { t: A.token, seat: 'B' });
  check('原选手也能坐回另一个空位', sitA2.ok && sitA2.seat === 'B', JSON.stringify(sitA2));
  st = await peek(A.roomId, A.token);
  check('两人坐齐后自动继续', !st.paused && st.phase === 'playing', 'paused=' + JSON.stringify(st.paused));

  /* ---------- 9. 未收录句：暂停计时 + 对方裁决 ---------- */
  const seatNow = st.turn;                     /* 当前该谁出手 */
  const moverTok = seatNow === 'A' ? W.token : A.token;
  const judgeTok = seatNow === 'A' ? A.token : W.token;
  /* 造一句「棋盘上有字、但语料查不到」的句子，保证能判有效 */
  let blank = '';
  for (let i = 0; i < st.chars.length; i++) if (st.board.charAt(i) === '0') { blank = st.chars.charAt(i); break; }
  const fakeLine = blank + '魑魅魍魉';
  const dsp = await api('/api/room/' + A.roomId + '/move', { t: moverTok, text: fakeLine });
  check('未收录句进入待裁决', !dsp.ok && dsp.code === 'dispute' && dsp.pending === true, JSON.stringify(dsp).slice(0, 140));
  st = await peek(A.roomId, judgeTok);
  check('状态里带出争议内容', !!st.dispute && st.dispute.text === fakeLine, JSON.stringify(st.dispute || {}));
  const dLeft = Math.round((st.deadline - st.serverNow) / 1000);
  await new Promise((r) => setTimeout(r, 1200));
  const dLater = await peek(A.roomId, judgeTok);
  check('争议期间计时冻结', Math.abs(Math.round((dLater.deadline - dLater.serverNow) / 1000) - dLeft) <= 1,
    dLeft + ' → ' + Math.round((dLater.deadline - dLater.serverNow) / 1000));
  const dMove = await api('/api/room/' + A.roomId + '/move', { t: judgeTok, text: '床前明月光' });
  check('争议期间不能出手', !dMove.ok && dMove.code === 'dispute', JSON.stringify(dMove).slice(0, 100));
  const dPass = await api('/api/room/' + A.roomId + '/pass', { t: moverTok });
  check('争议期间不能放弃', !dPass.ok && dPass.code === 'dispute', JSON.stringify(dPass).slice(0, 100));

  const selfYes = await api('/api/room/' + A.roomId + '/dispute', { t: moverTok, accept: true });
  check('提交方不能自判有效（点＝撤回）', selfYes.ok && selfYes.cancelled === true, JSON.stringify(selfYes));
  st = await peek(A.roomId, judgeTok);
  check('撤回后回到无争议且轮到原提交方', !st.dispute && st.turn === seatNow, st.turn);

  /* 再来一次，由对方判「需重新提交」 */
  await api('/api/room/' + A.roomId + '/move', { t: moverTok, text: fakeLine });
  const retry = await api('/api/room/' + A.roomId + '/dispute', { t: judgeTok, accept: false });
  check('对方可判「需重新提交」', retry.ok && retry.rejected === true, JSON.stringify(retry));
  st = await peek(A.roomId, judgeTok);
  check('重填后仍由同一人出手', !st.dispute && st.turn === seatNow, st.turn);
  check('重填后计时恢复走表', st.deadline > st.serverNow + 1000, '剩余 ' + Math.round((st.deadline - st.serverNow) / 1000));

  /* 第三次，由对方判「有效」 */
  await api('/api/room/' + A.roomId + '/move', { t: moverTok, text: fakeLine });
  const okYes = await api('/api/room/' + A.roomId + '/dispute', { t: judgeTok, accept: true });
  check('对方可判「有效提交」', okYes.ok && okYes.accepted === true, JSON.stringify(okYes).slice(0, 160));
  st = await peek(A.roomId, judgeTok);
  const manual = (st.log || []).filter((e) => e.via === 'manual');
  check('裁定有效后按字面涂色入账', manual.length === 1 && manual[0].hits >= 1, 'manual 记录 ' + manual.length);
  check('对手裁定的记录标 ruler.ref=false', manual.length === 1 && !!manual[0].ruler && manual[0].ruler.ref === false,
    JSON.stringify(manual[0] && manual[0].ruler));
  check('裁定有效后轮到对方', st.turn !== seatNow, '现在轮到 ' + st.turn);

  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n结果：全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.message);
  process.exit(1);
});
