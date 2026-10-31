'use strict';
/* 成员 / 身份 / 事件 回归测试
 *
 * 覆盖五件事：
 *   1. 身份不被广播冲掉（曾经 broadcast 传 c.seat 而不是 c.token，所有人被推成 guest）
 *   2. 裁决权限：只有对手席位能判，观众与提交方都不行
 *   3. 改昵称（选手 / 观众都行，mid 不变）
 *   4. 离开房间：席位释放、观众移除
 *   5. 掉线处理：离线标记、移出离线成员、同名重进接回席位
 *
 * 用法：先 node server.js，再 BASE=http://127.0.0.1:xxxx node tools/test_members.js
 * 为了不等定时器，本测试只验证「手动移出」与「同名接管」；自动清扫靠 60/180 秒定时器，
 * 那部分用 goneSince 的单元判定保证（见文末）。
 */

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';

/* 每个「人」的持久身份：自定义昵称 24 小时只能改一次，按 uid 记账。
   这个测试要改好几次名，请求里不带 uid 就会退回按 IP 记账 —— 同一台机器上
   几个人的改名会互相拖累，看起来像「改名功能坏了」。
   每次运行换一批 uid：同一个实例上连跑两遍，上一遍的额度才不会把这一遍锁死。 */
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const uid = (tag) => ('u' + RUN + tag).padEnd(20, 'x');
const UID_A = uid('a');
const UID_B = uid('b');
const UID_W = uid('w');

let bad = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else { bad++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return r.json();
}
async function raw(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json() };
}
async function state(roomId, token) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  if (r.status !== 200) return null;
  return (await r.json()).state;
}

/* 连一条 SSE，收集推送过来的 state；返回 {frames, close} */
function sse(roomId, token) {
  const frames = [];
  const req = http.get(BASE + '/api/room/' + roomId + '/events?t=' + encodeURIComponent(token), (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((x) => x.startsWith('data: '));
        if (!line) continue;
        try {
          const m = JSON.parse(line.slice(6));
          if (m.type === 'state') frames.push(m.state);
        } catch (_) {}
      }
    });
  });
  req.on('error', () => {});
  return { frames, close: () => req.destroy() };
}

(async () => {
  /* ---------- 开局：两人 + 一个观众 ---------- */
  const mk = await api('/api/create', { nick: '阿墨', size: 8, rounds: 10 });
  const rid = mk.roomId, ta = mk.token;
  const jb = await api('/api/join', { roomId: rid, nick: '青岚' });
  const tb = jb.token;
  const jw = await api('/api/join', { roomId: rid, nick: '看客' });
  const tw = jw.token;
  check('第三人以观众身份进入', jw.role === 'spectator' && jw.seat === null);
  check('成员列表含 2 选手 + 1 观众', jw.state.members.filter((m) => m.kind !== 'empty').length === 3);
  check('空位在成员列表里占一行', jw.state.members.some((m) => m.kind === 'empty') === false,
    '坐满时应无空位行');

  /* ---------- 1. 广播不能把身份冲掉 ---------- */
  const sa = sse(rid, ta);
  const sb = sse(rid, tb);
  await sleep(250);
  /* 每个「人」带自己的 uid：自定义昵称有 24 小时一次的额度，不带 uid 会退回按 IP 记账，
     同一台机器上跑几段测试就互相拖累了（这个坑真撞过，见 AGENTS.md）。 */
  await api('/api/room/' + rid + '/nick', { t: tb, nick: '青岚子', uid: UID_B });   // 触发一次广播
  await sleep(350);

  const lastA = sa.frames[sa.frames.length - 1];
  const lastB = sb.frames[sb.frames.length - 1];
  check('A 的推送里 role 仍是 player', lastA && lastA.role === 'player', lastA && lastA.role);
  check('A 的推送里 you 仍是 A', lastA && lastA.you === 'A', lastA && lastA.you);
  check('B 的推送里 role 仍是 player', lastB && lastB.role === 'player', lastB && lastB.role);
  check('B 的推送里 you 仍是 B', lastB && lastB.you === 'B', lastB && lastB.you);
  check('观众的推送里 role 是 watcher', (await state(rid, tw)).role === 'watcher');
  sa.close(); sb.close();

  /* ---------- 2. 裁决权限 ---------- */
  await api('/api/room/' + rid + '/ready', { t: ta, ready: true });
  await api('/api/room/' + rid + '/ready', { t: tb, ready: true });
  let s = await state(rid, ta);
  check('双方准备后开局', s.phase === 'playing', s.phase);

  const curTok = s.turn === 'A' ? ta : tb;
  const oppTok = s.turn === 'A' ? tb : ta;
  const ch0 = s.chars ? s.chars.charAt(0) : '春';
  await api('/api/room/' + rid + '/move', { t: curTok, text: ch0 + '魑魅魍魉饕餮' });
  s = await state(rid, oppTok);
  check('未收录句进入待裁决', !!s.dispute);

  const w1 = await raw('/api/room/' + rid + '/dispute', { t: tw, accept: true });
  check('观众裁决被拒（403）', w1.status === 403, 'HTTP ' + w1.status);
  const w2 = await raw('/api/room/' + rid + '/dispute', { t: '', accept: true });
  check('无 token 裁决被拒', w2.status === 403 || w2.status === 401, 'HTTP ' + w2.status);

  const sCur = await state(rid, curTok);
  check('提交方的 you 指向自己', sCur.you === sCur.dispute.by);
  check('对手的 you 不等于提交方', (await state(rid, oppTok)).you !== s.dispute.by);

  /* 提交方点「有效」＝撤回（不是真的判有效） */
  const cancel = await api('/api/room/' + rid + '/dispute', { t: curTok, accept: true });
  check('提交方点有效被当作撤回', cancel.cancelled === true);
  check('撤回后争议清空', !(await state(rid, ta)).dispute);

  /* ---------- 3. 改昵称 ---------- */
  const rn = await api('/api/room/' + rid + '/nick', { t: ta, nick: '墨白', uid: UID_A });
  check('选手改昵称成功', rn.ok && rn.nick === '墨白', rn);
  s = await state(rid, tb);
  check('对手看到新昵称', s.seats.A.nick === '墨白');
  const rw = await api('/api/room/' + rid + '/nick', { t: tw, nick: '围观君', uid: UID_W });
  check('观众也能改昵称', rw.ok && rw.nick === '围观君', rw);
  const same = await api('/api/room/' + rid + '/nick', { t: ta, nick: '墨白', uid: UID_A });
  check('改成同一个名字标记 unchanged', same.ok && same.unchanged === true);
  const empty = await api('/api/room/' + rid + '/nick', { t: ta, nick: '   ', uid: UID_A });
  check('空昵称被拒', empty.ok === false);
  check('改名后 mid 不变', (await state(rid, ta)).youMid === mk.state.youMid);

  /* ---------- 4. 移出成员 ---------- */
  /* 观众还在线上（刚连过 state）→ 不能踢 */
  s = await state(rid, ta);
  const midW = s.members.find((m) => m.nick === '围观君').mid;
  const kickOnline = await api('/api/room/' + rid + '/kick', { t: ta, mid: midW });
  check('在线成员不能被移出', kickOnline.ok === false && kickOnline.code === 'online', JSON.stringify(kickOnline));

  const kickSelf = await api('/api/room/' + rid + '/kick', { t: ta, mid: s.members.find((m) => m.seat === 'A').mid });
  check('不能移出自己', kickSelf.ok === false && kickSelf.code === 'self');

  const kickByWatcher = await raw('/api/room/' + rid + '/kick', { t: tw, mid: s.members.find((m) => m.seat === 'A').mid });
  check('观众不能移出别人', kickByWatcher.data.ok === false && kickByWatcher.data.code === 'not-player');

  /* ---------- 5. 离开房间 ---------- */
  const lv = await api('/api/room/' + rid + '/leave', { t: tw });
  check('观众离开成功', lv.ok === true);
  const gone = await fetch(BASE + '/api/room/' + rid + '/peek?t=' + encodeURIComponent(tw));
  check('离开后 token 失效', gone.status === 401, 'HTTP ' + gone.status);

  /* 选手离开 → 席位空出、计时冻结 */
  const lvA = await api('/api/room/' + rid + '/leave', { t: ta });
  check('选手离开成功', lvA.ok === true);
  s = await state(rid, tb);
  check('选手离开后赤位空出', s.seats.A === null);
  check('缺人时计时冻结', !!s.paused && s.paused.why === 'seat-empty', JSON.stringify(s.paused));

  /* ---------- 6. 两种「重新进来」 ---------- */
  /* 6a 主动离开 → 席位彻底空出，同名重进直接坐回赤位 */
  const back = await api('/api/join', { roomId: rid, nick: '墨白' });
  check('主动离开后同名重进坐回赤位', back.seat === 'A' && back.role === 'player', JSON.stringify(back.seat));
  check('重进后换发新 token', back.token !== ta);
  check('旧 token 已失效', (await fetch(BASE + '/api/room/' + rid + '/peek?t=' + encodeURIComponent(ta))).status === 401);
  s = await state(rid, back.token);
  check('重进后 you 指向赤位', s.you === 'A');
  check('重进后计时自动续上', !s.paused);

  /* 6b 关掉网页（席位还占着、人已离线）→ 同名重进接管原席位，mid 不变 */
  const liveTok = back.token;
  const liveMid = s.youMid;
  const conn = sse(rid, liveTok);
  await sleep(220);
  conn.close();
  await sleep(320);
  s = await state(rid, tb);
  check('关网页后席位仍占着但标记离线', s.seats.A !== null && s.seats.A.online === false);

  const reclaim = await api('/api/join', { roomId: rid, nick: '墨白' });
  check('同名重进接管离线席位', reclaim.reclaimed === true && reclaim.seat === 'A', JSON.stringify({ s: reclaim.seat, r: reclaim.reclaimed }));
  check('接管后 mid 不变', reclaim.state.youMid === liveMid, liveMid + ' → ' + reclaim.state.youMid);
  check('接管后旧 token 失效', (await fetch(BASE + '/api/room/' + rid + '/peek?t=' + encodeURIComponent(liveTok))).status === 401);

  /* 在线的人不会被同名顶替 */
  const dup = await api('/api/join', { roomId: rid, nick: '墨白' });
  check('同名但原主在线时不接管', dup.role === 'spectator' && !dup.reclaimed, dup.role);

  /* ---------- 7. 事件流水 ---------- */
  s = await state(rid, reclaim.token);
  const types = s.events.map((e) => e.type);
  const need = ['create', 'join', 'watch', 'nick', 'ready', 'start', 'dispute', 'dispute-reject', 'leave', 'online'];
  for (const t of need) {
    check('事件流水包含 ' + t, types.includes(t), types.join(','));
  }
  check('事件都带时间戳', s.events.every((e) => typeof e.at === 'number' && e.at > 0));
  check('事件都带文本', s.events.every((e) => typeof e.text === 'string' && e.text.length > 0));
  const evNick = s.events.find((e) => e.type === 'nick' && /墨白/.test(e.text));
  check('改名事件记录了旧名与新名', !!evNick && /改名/.test(evNick.text), evNick && evNick.text);
  check('事件按时间递增', s.events.every((e, i, arr) => i === 0 || arr[i - 1].at <= e.at));

  /* 撤销一步不应抹掉事件流水（它是审计日志，不是棋盘状态） */
  const before = s.events.length;
  await api('/api/room/' + rid + '/undo', { t: reclaim.token });
  await sleep(100);
  s = await state(rid, reclaim.token);
  check('撤销请求不清空事件', s.events.length >= before, before + ' → ' + s.events.length);

  /* ---------- 8. 默认昵称取自语料作者（不再是写死的「赤营」「青营」「观众」） ---------- */
  const AUTHOR = /^[\u3400-\u4DBF\u4E00-\u9FA5\u3007]{2,6}$/;
  const rnPick = await fetch(BASE + '/api/rand-name').then((r) => r.json());
  check('/api/rand-name 给出作者名', AUTHOR.test(rnPick.name || ''), rnPick.name);
  const bare = await api('/api/create', { size: 5 });
  check('建房不填昵称 → 用作者名', AUTHOR.test(bare.state.seats.A.nick), bare.state.seats.A.nick);
  const bareB = await api('/api/join', { roomId: bare.roomId });
  check('加入不填昵称 → 用作者名', AUTHOR.test(bareB.state.seats.B.nick), bareB.state.seats.B.nick);
  const bareC = await api('/api/join', { roomId: bare.roomId });
  const meC = bareC.state.members.find((m) => m.isYou);
  check('观众不填昵称 → 用作者名', !!meC && AUTHOR.test(meC.nick), meC && meC.nick);
  check('默认名不再出现阵营名', !['赤营', '青营', '观众'].includes(bare.state.seats.A.nick));
  const named = await api('/api/create', { nick: '自取的名', size: 5 });
  check('填了昵称就照用', named.state.seats.A.nick === '自取的名', named.state.seats.A.nick);

  /* ---------- 9. 选手直接换到空闲席位 ---------- */
  const rTri = await api('/api/create', { nick: '席位流转者', playerCount: 3, size: 8 });
  const triId = rTri.roomId, triTokenA = rTri.token;
  check('三人房初始赤营就座', rTri.seat === 'A');

  // A 席直接换到 B 席
  const swB = await api('/api/room/' + triId + '/seat', { t: triTokenA, seat: 'B' });
  check('A 换到 B 席成功', swB.ok === true && swB.switched === true && swB.seat === 'B');
  const sAfterB = await state(triId, triTokenA);
  check('换座后 you 变为 B', sAfterB.you === 'B');
  check('换座后原 A 席为空', sAfterB.seats.A === null);
  check('换座后 B 席为该选手', sAfterB.seats.B && sAfterB.seats.B.nick === '席位流转者');

  // B 席再换到 C 席
  const swC = await api('/api/room/' + triId + '/seat', { t: triTokenA, seat: 'C' });
  check('B 换到 C 席成功', swC.ok === true && swC.switched === true && swC.seat === 'C');
  const sAfterC = await state(triId, triTokenA);
  check('换座后 you 变为 C', sAfterC.you === 'C');
  check('换座后原 B 席为空', sAfterC.seats.B === null);
  check('换座后 C 席为该选手', sAfterC.seats.C && sAfterC.seats.C.nick === '席位流转者');

  // 换到当前坐着的席位：unchanged
  const swSame = await api('/api/room/' + triId + '/seat', { t: triTokenA, seat: 'C' });
  check('换到当前席位标记 unchanged', swSame.ok === true && swSame.unchanged === true);

  // 另一选手加入坐上 B 席
  const jB = await api('/api/join', { roomId: triId, nick: '占座人' });
  check('占座人坐上 B 席', jB.seat === 'B');

  // C 席尝试换到已被占的 B 席：应拒绝
  const swTaken = await api('/api/room/' + triId + '/seat', { t: triTokenA, seat: 'B' });
  check('换到已有人席位被拒', swTaken.ok === false && swTaken.code === 'taken');

  console.log('\n结果：' + (bad ? bad + ' 项失败' : '全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); process.exit(1); });
