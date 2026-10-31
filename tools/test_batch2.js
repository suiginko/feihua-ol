'use strict';
/* 本批改动的回归：房号顺序分配 / 房间上限 / 大厅规则摘要 / 对局存档 / 反馈。
 * 用法：起一个干净的实例、并且**最后**跑它（末尾那段会把 1000 个房号全占满）
 *   PORT=8799 node server.js
 *   BASE=http://127.0.0.1:8799 node tools/test_batch2.js
 * 房号断言不写死 000：改成「新房 = 当前最小的空号」，这样实例上已经有人开过房也不会假失败。
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:8799';
const KEY = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'admin.key'), 'utf8').trim(); } catch (_) { return ''; }
})();

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
async function get(p) {
  const r = await fetch(BASE + p);
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (_) {}
  return { status: r.status, json, txt, type: r.headers.get('content-type') || '' };
}

(async () => {
  /* ---------- 1. 房号：顺序分配、连续、三位 ----------
     不要靠「/api/rooms 反推出最小空号」再断言 —— 那个列表有上限（60 条）且按
     「进行中优先」排序，房号一多就推导错，会误报成「分配错了」。这里只验
     真正稳定的契约：新号三位、连建三间连号、不和已有房号撞车。 */
  const before = new Set(((await get('/api/rooms')).json.rooms || []).map((r) => r.id));

  const a = await api('/api/create', { nick: '甲', size: 8, rounds: 10 });
  const b = await api('/api/create', { nick: '乙', size: 8, rounds: 10 });
  const c = await api('/api/create', { nick: '丙', size: 8, rounds: 10 });
  if (!a.ok || !b.ok || !c.ok) {
    console.error('!! 建房失败：' + JSON.stringify((!a.ok ? a : (!b.ok ? b : c))));
    console.error('   若提示「房间已满」，说明这个实例的 1000 个房号已被占满，重启实例后再跑本测试。');
    process.exit(1);
  }
  const R0 = a.roomId;
  const n0 = Number(R0);
  check('房号始终是三位字符', [a, b, c].every((x) => /^\d{3}$/.test(x.roomId)), [a.roomId, b.roomId, c.roomId].join(','));
  check('连建三间是连续房号（顺序分配）', Number(b.roomId) === n0 + 1 && Number(c.roomId) === n0 + 2,
    R0 + ' → ' + b.roomId + ' → ' + c.roomId);
  check('房号落在 000–999 之内', n0 >= 0 && Number(c.roomId) <= 999, R0 + '…' + c.roomId);
  check('新房号没有和已有房号撞车', ![R0, b.roomId, c.roomId].some((id) => before.has(id)));

  /* 前导零房号也能正常加入（不能被当成空值 / 数字） */
  const join0 = await api('/api/join', { roomId: R0, nick: '对手' });
  check('房号 ' + R0 + ' 可正常加入', join0.ok && join0.state && join0.state.id === R0, join0.reason || join0.seat);

  /* ---------- 2. 大厅条目带文体与额外字 ---------- */
  const rooms = await get('/api/rooms');
  const r0 = (rooms.json.rooms || []).find((x) => x.id === R0);
  check('房间条目带 kinds', !!r0 && typeof r0.kinds === 'string' && r0.kinds.length >= 1, r0 && r0.kinds);
  check('房间条目带 extra', !!r0 && typeof r0.extra === 'number', r0 && r0.extra);
  check('默认文体是诗词曲赋全部启用', !!r0 && r0.kinds.includes('诗') && r0.kinds.includes('词'), r0 && r0.kinds);

  /* ---------- 3. 打完一局 → 存档 ---------- */
  const A = { roomId: a.roomId, token: a.token };
  const B = { roomId: a.roomId, token: join0.token };
  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  const started = await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  check('双方准备后开局', started.ok && started.started === true, started.reason);
  /* 交给对方同意提前结算，走完整的 finish 路径 */
  await api('/api/room/' + A.roomId + '/finish', { t: A.token });
  const agreed = await api('/api/room/' + A.roomId + '/consent', { t: B.token, accept: true });
  check('提前结算生效', agreed.ok && agreed.finished === true, agreed.reason);

  const noKey = await get('/api/records');
  check('存档接口无口令返回 403', noKey.status === 403, noKey.status);
  const badKey = await get('/api/records?key=wrong');
  check('存档接口错口令返回 403', badKey.status === 403, badKey.status);

  const list = await get('/api/records?key=' + encodeURIComponent(KEY));
  const rec = (list.json.list || []).find((x) => x.id === R0);
  check('存档列表里有这一局', !!rec, (list.json.list || []).length);
  check('存档带比分与结束原因', !!rec && typeof rec.score.a === 'number' && rec.reason === '提前结算', rec && rec.reason);
  check('存档列表不含完整记录（只给摘要）', !!rec && rec.log === undefined);

  const one = await get('/api/records?key=' + encodeURIComponent(KEY) + '&id=' + R0);
  check('可按下房号取单局详情', one.json.ok && one.json.record.id === R0);
  check('详情里有完整事件流水', one.json.ok && Array.isArray(one.json.record.events) && one.json.record.events.length > 3,
    one.json.ok && one.json.record.events.length);
  check('详情保留了对局配置', one.json.ok && one.json.record.cfg.size === 8);

  /* ---------- 4. 反馈 ---------- */
  const post = async (body) => {
    const r = await fetch(BASE + '/api/feedback', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  const short = await post({ text: ' ' });
  check('空反馈被拒', short.status === 400 && !short.json.ok, short.status);
  const fb1 = await post({ text: '第三手之后计时器不动了', nick: '甲', roomId: R0, contact: 'a@b.c' });
  check('反馈提交成功', fb1.status === 200 && fb1.json.ok, fb1.json);
  const fb2 = await post({ text: '马上再发一条' });
  check('同 IP 30 秒内被限频', fb2.status === 429 && !fb2.json.ok, fb2.status);
  const fbList = await get('/api/feedback?key=' + encodeURIComponent(KEY));
  const hit = (fbList.json.list || []).find((f) => /计时器/.test(f.text));
  check('审阅页能读到反馈', !!hit && hit.nick === '甲' && hit.roomId === R0, (fbList.json.list || []).length);
  check('反馈里记了联系方式', !!hit && hit.contact === 'a@b.c', hit && hit.contact);

  /* ---------- 5. 审阅页 ---------- */
  const page = await get('/admin?key=' + encodeURIComponent(KEY));
  check('口令正确时能拿到审阅页', page.status === 200 && /text\/html/.test(page.type) && /审阅/.test(page.txt), page.status);
  const pageBad = await get('/admin?key=nope');
  check('口令错误时连页面都不给', pageBad.status === 403, pageBad.status);

  /* ---------- 6. 房间上限 1000 ---------- */
  let created = 0, full = null;
  for (let i = 0; i < 1002; i++) {
    const r = await api('/api/create', { nick: '批量', size: 5, rounds: 1 });
    if (r.ok) created++;
    else { full = r; break; }
  }
  check('最多只开 1000 间房', created <= 1000, '实际 ' + created);
  check('满员时给出明确提示而不是崩', !!full && /房间已满/.test(full.reason || ''), full && full.reason);

  console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n结果：全部通过');
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e.message);
  process.exit(1);
});
