'use strict';
/* 本轮收尾项的服务端回归：
 *   ① 飞花记录 / 事件里的诗句统一「空格分隔」（命中带底本标点、未收录是一串，都要抹平）
 *   ② 同一个人反复进出房间不再堆出同名幽灵（mid 保持，裁判身份跟着走）
 *   ③ 大厅列表：进行中的局排最前，不被一堆空等房挤掉
 * 用法：node server.js 之后 node tools/test_polish.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let bad = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else { bad++; console.log('FAIL  ' + name + (detail === undefined ? '' : '  → ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 200))); }
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  try { return await r.json(); } catch (_) { return {}; }
}
async function peek(roomId, t) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t));
  if (r.status !== 200) return null;
  return (await r.json()).state;
}
const midOf = (st, nick) => ((st.members || []).find((m) => m.nick === nick) || {}).mid;

/* 展示串里不该再出现中文标点；多分句的要有空格 */
const PUNCT = /[，。！？；：、,.!?;:…]/;

(async () => {
  /* ---------- ① 空格分隔 ---------- */
  const a = await api('/api/create', { size: 12, nick: '空格甲' });
  const b = await api('/api/join', { roomId: a.roomId, nick: '空格乙' });
  await api('/api/room/' + a.roomId + '/ready', { t: a.token, ready: true });
  await api('/api/room/' + a.roomId + '/ready', { t: b.token, ready: true });

  const st0 = await peek(a.roomId, a.token);
  const hitCandidates = [
    '莫道不销魂，帘卷西风，人比黄花瘦',
    '东风夜放花千树，更吹落，星如雨',
    '故国神游，多情应笑我，早生华发',
    '十年生死两茫茫，不思量，自难忘'
  ];
  let hitText = hitCandidates[0];
  for (const c of hitCandidates) {
    const raw = c.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i < st0.chars.length; i++) {
      if (st0.board.charAt(i) === '0' && raw.includes(st0.chars.charAt(i))) {
        hitText = c;
        break;
      }
    }
  }
  const mv = await api('/api/room/' + a.roomId + '/move', { t: a.token, text: hitText });
  check('命中句仍判有效', mv.ok === true, mv.code);
  const line = (mv.entry && mv.entry.line) || '';
  check('命中记录的展示串不含标点', !PUNCT.test(line), line);
  check('命中记录的展示串用空格分句', line.split(' ').length >= 3, line);

  const missText = '合抱之木，生于毫末；九层之台，起于累土；千里之行，始于足下';
  const mv2 = await api('/api/room/' + a.roomId + '/move', { t: b.token, text: missText });
  check('未收录句进入待裁决', mv2.code === 'dispute', mv2.code);
  let st = await peek(a.roomId, a.token);
  const disp = (st.dispute && st.dispute.disp) || '';
  check('未收录句也给出空格分隔的展示串', disp.split(' ').length >= 6 && !PUNCT.test(disp), disp);

  /* 裁定有效后入账，记录里同样是空格分隔 */
  await api('/api/room/' + a.roomId + '/dispute', { t: a.token, accept: true });
  st = await peek(a.roomId, a.token);
  const manual = (st.log || []).filter((e) => e.via === 'manual').pop();
  check('裁定有效的记录同样用空格分隔', !!manual && !PUNCT.test(manual.line) && manual.line.split(' ').length >= 6,
    manual && manual.line);

  const evs = st.events.filter((e) => e.type === 'fly' || e.type === 'dispute' || e.type === 'dispute-accept');
  /* 只检查「」里引用的诗句 —— 事件正文本身的逗号（「判…有效，按字面涂色」）不算 */
  const quoted = evs.map((e) => (e.text.match(/「[^」]*」/g) || []).join('')).join('');
  check('事件里引用的诗句也抹掉了标点', !!quoted && !PUNCT.test(quoted), quoted.slice(0, 140));

  /* ---------- ② 同名观众不再重复 ---------- */
  const c = await api('/api/create', { size: 10, nick: '房主' });
  await api('/api/join', { roomId: c.roomId, nick: '对手' });
  const w1 = await api('/api/join', { roomId: c.roomId, nick: '沈传师' });
  const mid1 = midOf(await peek(c.roomId, w1.token), '沈传师');
  await api('/api/room/' + c.roomId + '/ref', { t: c.token, mid: mid1, on: true });
  const w2 = await api('/api/join', { roomId: c.roomId, nick: '沈传师' });
  const w3 = await api('/api/join', { roomId: c.roomId, nick: '沈传师' });
  st = await peek(c.roomId, w3.token);
  const same = st.members.filter((m) => m.nick === '沈传师');
  check('同名观众只留一条', same.length === 1, same.map((m) => m.mid));
  check('重进后 mid 不变', same[0] && same[0].mid === mid1, mid1 + ' → ' + (same[0] && same[0].mid));
  check('裁判身份跟着 mid 保住', same[0] && same[0].ref === true);
  check('旧 token 已失效', (await peek(c.roomId, w1.token)) === null);
  check('重进应答标记 resumed（前端据此提示「已接回」）', w2.resumed === true || w3.resumed === true,
    { w2: w2.resumed, w3: w3.resumed });

  /* ---------- ③ 大厅排序：进行中的局不被空等房挤掉 ---------- */
  const live = await api('/api/create', { size: 10, nick: '打着的房' });
  const liveB = await api('/api/join', { roomId: live.roomId, nick: '打着的对手' });
  await api('/api/room/' + live.roomId + '/ready', { t: live.token, ready: true });
  await api('/api/room/' + live.roomId + '/ready', { t: liveB.token, ready: true });
  const junk = [];
  for (let i = 0; i < 30; i++) junk.push((await api('/api/create', { size: 10, nick: '空等' + (i + 1) })).roomId);
  const list = await (await fetch(BASE + '/api/rooms')).json();
  check('进行中的局出现在列表里', list.rooms.some((r) => r.id === live.roomId),
    '共 ' + list.total + ' 间 / 返回 ' + list.rooms.length + ' 条');
  check('进行中的局排在第一档', list.rooms[0].phase === 'playing', list.rooms[0].phase);
  const firstJoinable = list.rooms.findIndex((r) => r.joinable);
  const lastLive = list.rooms.map((r) => r.phase === 'playing' && r.live).lastIndexOf(true);
  check('可加入的排在所有进行中之后', firstJoinable > lastLive, { firstJoinable, lastLive });
  check('列表容量足够（> 原来的 24 条上限）', list.rooms.length > 24 || list.total <= 24, list.rooms.length);

  /* 空壳房（人全走了）应被清扫掉 —— 服务端 10 秒一轮，这里等一轮半 */
  const empty = await api('/api/create', { size: 5, nick: '马上就走' });
  await api('/api/room/' + empty.roomId + '/leave', { t: empty.token });
  await new Promise((r) => setTimeout(r, 12000));
  const after = await (await fetch(BASE + '/api/rooms')).json();
  check('人去楼空的房间被清掉', !after.rooms.some((r) => r.id === empty.roomId),
    'total ' + after.total);

  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过'));
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
