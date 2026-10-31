'use strict';
/* 测试专项：
 * 提交的文字中没有至少一个未被占领的格子（或未命中棋盘任何字），
 * 直接提示无法提交（no_blank / no_hit / dup），绝不触发争议，绝不导致对手判定！
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8799';

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

(async () => {
  // 1. 创建双人对局
  const A = await api('/api/create', { size: 8, rounds: 30, nick: '甲' });
  const B = await api('/api/join', { roomId: A.roomId, nick: '乙' });
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });

  let st = await peek(A.roomId, A.token);
  check('开局成功且轮到 A', st.phase === 'playing' && st.turn === 'A');

  // 生成一串棋盘上绝对不存在的生僻字（确保 hits === 0）
  const RARE_POOL = '魑魅魍魉饕餮狻猊獬豸貔貅麒麟囫囵龃龉齟齬';
  let nonBoardChars = '';
  for (const ch of RARE_POOL) {
    if (!st.chars.includes(ch)) {
      nonBoardChars += ch;
      if (nonBoardChars.length >= 6) break;
    }
  }
  check('获取棋盘外字串', nonBoardChars.length >= 4, nonBoardChars);

  // 场景 1：提交完全不包含棋盘文字的假句，直接提示 no_hit，绝不进入 dispute
  const noHitRes = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: nonBoardChars });
  check('未命中棋盘文字时返回 no_hit', !noHitRes.ok && noHitRes.code === 'no_hit', noHitRes);
  st = await peek(A.roomId, A.token);
  check('未命中棋盘文字绝不挂起争议', !st.dispute && st.turn === 'A', st.dispute);

  // 场景 2：找两个棋盘上的未涂色格子
  let targetChar1 = '';
  let targetChar2 = '';
  for (let i = 0; i < st.chars.length; i++) {
    if (st.board.charAt(i) === '0') {
      if (!targetChar1) targetChar1 = st.chars.charAt(i);
      else if (st.chars.charAt(i) !== targetChar1) {
        targetChar2 = st.chars.charAt(i);
        break;
      }
    }
  }
  check('找到棋盘上的空格子字 1', !!targetChar1, targetChar1);
  check('找到棋盘上的空格子字 2', !!targetChar2, targetChar2);

  // A 正常落子：用 targetChar1 + 棋盘外生僻字组成句子，只有 targetChar1 在棋盘上且未涂色
  const fakeDispute1 = targetChar1 + nonBoardChars.slice(0, 4);
  const mvDispute = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: fakeDispute1 });
  check('有空格子且未收录的假诗进入待裁决', mvDispute.code === 'dispute', mvDispute);
  const acceptRes = await api('/api/room/' + A.roomId + '/dispute', { t: B.token, accept: true });
  check('对手裁定有效', acceptRes.ok && acceptRes.accepted, acceptRes);

  st = await peek(A.roomId, B.token);
  check('裁决后轮到 B 出手', st.turn === 'B');

  // 现在 targetChar1 已经被 A 占领，不再是未涂色格（owner 是 A）
  // B 试图提交只包含 targetChar1、但没有任何未被占领格子的假诗（其余全为棋盘外生僻字）
  const noBlankFake = targetChar1 + nonBoardChars.slice(1, 5);
  const mvNoBlank = await api('/api/room/' + A.roomId + '/move', { t: B.token, text: noBlankFake });
  check('没有至少一个未占领格子时返回 no_blank', !mvNoBlank.ok && mvNoBlank.code === 'no_blank', mvNoBlank);
  check('no_blank 提示明确指出至少占用 1 个未涂色格', mvNoBlank.reason && mvNoBlank.reason.includes('至少要占用 1 个未涂色格'), mvNoBlank.reason);

  st = await peek(A.roomId, B.token);
  check('no_blank 绝不触发争议，绝不导致对手判定', !st.dispute && st.turn === 'B', st.dispute);

  // 场景 3：B 用包含未涂色格 targetChar2 正常落子成功
  const fakeDispute2 = targetChar2 + nonBoardChars.slice(0, 4);
  const mvDispute2 = await api('/api/room/' + A.roomId + '/move', { t: B.token, text: fakeDispute2 });
  check('B 包含空格子正常发起争议', mvDispute2.code === 'dispute', mvDispute2);
  const acceptRes2 = await api('/api/room/' + A.roomId + '/dispute', { t: A.token, accept: true });
  check('A 裁定有效', acceptRes2.ok && acceptRes2.accepted, acceptRes2);

  st = await peek(A.roomId, A.token);
  check('裁决后轮到 A 出手', st.turn === 'A');

  console.log('\n测试结论：' + (bad === 0 ? '全部通过' : '有失败项 bad=' + bad));
  process.exitCode = bad ? 1 : 0;
})();
