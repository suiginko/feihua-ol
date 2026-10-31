'use strict';
/* 测试新功能：
 * 1) 数据库里有但触发限制、经对手裁定有效的提交，记录中按正常诗词来源标注
 * 2) 自由提交模式（freeSubmit: true）：多人对局完全关闭字数与联句限制
 * 3) 游戏中“对方”文案修改为“对手”
 * 4) 金营/翠营抢夺下划线样式
 * 5) 倒计时读秒黑灰色
 * 6) 导出时间展示结束时间与对局时长
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
  /* 1. 测试常规双人房：超限进入争议，裁定有效后保留诗词来源 */
  const r1 = await api('/api/create', { size: 10, rounds: 20, nick: '甲', limitCouplet: true });
  const b1 = await api('/api/join', { roomId: r1.roomId, nick: '乙' });
  await api('/api/room/' + r1.roomId + '/ready', { t: r1.token, ready: true });
  await api('/api/room/' + r1.roomId + '/ready', { t: b1.token, ready: true });
  let st1 = await peek(r1.roomId, r1.token);

  // 找一句诗：春眠不觉晓处处闻啼鸟夜来风雨声花落知多少 (孟浩然《春晓》四句，在库里必然存在)
  // 如果包含了棋盘上的字：
  const poem4 = '春眠不觉晓处处闻啼鸟夜来风雨声花落知多少';
  const moverTok = st1.turn === 'A' ? r1.token : b1.token;
  const oppTok = st1.turn === 'A' ? b1.token : r1.token;

  // 确保棋盘上有这句的字
  let hasHit = false;
  for (let ch of poem4) {
    if (st1.chars.includes(ch)) { hasHit = true; break; }
  }

  // 提交四句律绝诗，会触发 too_many_clauses
  const moveRes = await api('/api/room/' + r1.roomId + '/move', { t: moverTok, text: poem4 });
  if (hasHit) {
    check('四句律绝提交触发争议', moveRes.code === 'dispute', moveRes);
    // 对手判有效
    const dispRes = await api('/api/room/' + r1.roomId + '/dispute', { t: oppTok, accept: true });
    check('对手裁定有效', dispRes.ok && dispRes.accepted === true, dispRes);

    st1 = await peek(r1.roomId, r1.token);
    const lastFly = st1.log[st1.log.length - 1];
    check('落子入账', !!lastFly && lastFly.type === 'fly', lastFly);
    check('出处source不为null', !!lastFly.source, lastFly.source);
    check('出处包含春晓', lastFly.source && lastFly.source.title.includes('春晓'), lastFly.source);
  } else {
    console.log('SKIP  当前棋盘无春晓汉字，跳过超限诗出处测试');
  }

  /* 2. 测试自由提交模式（freeSubmit: true） */
  const r2 = await api('/api/create', { size: 10, rounds: 20, nick: '自由甲', freeSubmit: true });
  check('建房配置包含 freeSubmit', r2.state && r2.state.cfg && r2.state.cfg.freeSubmit === true, r2.state && r2.state.cfg);
  const b2 = await api('/api/join', { roomId: r2.roomId, nick: '自由乙' });
  await api('/api/room/' + r2.roomId + '/ready', { t: r2.token, ready: true });
  await api('/api/room/' + r2.roomId + '/ready', { t: b2.token, ready: true });
  let st2 = await peek(r2.roomId, r2.token);

  if (hasHit) {
    const moverTok2 = st2.turn === 'A' ? r2.token : b2.token;
    // 自由模式下提交四句诗，不需要裁决，直接落子！
    const moveRes2 = await api('/api/room/' + r2.roomId + '/move', { t: moverTok2, text: poem4 });
    check('自由提交模式下四句诗直接成功（无需裁决）', moveRes2.ok === true && moveRes2.entry, moveRes2);
    st2 = await peek(r2.roomId, r2.token);
    const lastFly2 = st2.log[st2.log.length - 1];
    check('自由提交模式记录正常入账', !!lastFly2 && lastFly2.raw === poem4);
    check('自由提交模式记录出处正常', !!lastFly2.source && lastFly2.source.title.includes('春晓'));

    // 自由提交模式下，提交未收录的假诗也自动放行通过（via=free），无需对手裁决
    const moverTok3 = st2.turn === 'A' ? r2.token : b2.token;
    let blankCh = '';
    for (let i = 0; i < st2.chars.length; i++) {
      if (st2.board.charAt(i) === '0') { blankCh = st2.chars.charAt(i); break; }
    }
    const freeFake = blankCh + '自由模式未收录测试句';
    const moveRes3 = await api('/api/room/' + r2.roomId + '/move', { t: moverTok3, text: freeFake });
    check('自由提交模式下未收录诗句直接自动通过（via=free）', moveRes3.ok === true && moveRes3.entry && moveRes3.entry.via === 'free', moveRes3);
    st2 = await peek(r2.roomId, r2.token);
    check('自由提交模式无争议挂起', !st2.dispute);
  }

  /* 3. 验证 publicState 包含 startedAt 和 finishedAt */
  check('publicState 包含 startedAt', typeof st2.startedAt === 'number' && st2.startedAt > 0, st2.startedAt);
  // 提前结算
  const moverTokFin = st2.turn === 'A' ? r2.token : b2.token;
  const oppTokFin = st2.turn === 'A' ? b2.token : r2.token;
  await api('/api/room/' + r2.roomId + '/finish', { t: moverTokFin });
  await api('/api/room/' + r2.roomId + '/consent', { t: oppTokFin, accept: true });
  st2 = await peek(r2.roomId, r2.token);
  check('对局结束后 phase 为 finished', st2.phase === 'finished', st2.phase);
  check('publicState 包含 finishedAt', typeof st2.finishedAt === 'number' && st2.finishedAt >= st2.startedAt, st2.finishedAt);

  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n结果：全部通过');
  process.exitCode = bad ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e.stack || e.message);
  process.exitCode = 1;
});
