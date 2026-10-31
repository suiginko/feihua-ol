'use strict';
/* 线上发布验证（第二轮）：裁判 / 开局设置 / 重抽棋盘 / 裁决按钮语义 / 静态资源一致性。
 * 用法：node tools/online_check2.js
 * 网关需要 sharecode cookie，不带就一律回首页 HTML —— 先访问一次拿 cookie。 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'https://feihua-splatoon.app.workbuddy.host';
const SHARE = 'MZA5YPLHV3';
const ROOT = path.resolve(__dirname, '..');

let COOKIE = '';
let bad = 0;

function check(name, ok, detail) {
  if (ok) console.log('PASS  ' + name);
  else { bad++; console.log('FAIL  ' + name + (detail === undefined ? '' : '  → ' + String(JSON.stringify(detail)).slice(0, 200))); }
}

async function boot() {
  const r = await fetch(BASE + '/?sharecode=' + SHARE, { redirect: 'follow' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  COOKIE = sc.map((x) => x.split(';')[0]).join('; ');
  console.log('cookie →', COOKIE || '(空)');
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE },
    body: JSON.stringify(body || {}),
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (_) { return { ok: false, http: r.status, raw: txt.slice(0, 120) }; }
}

async function peek(roomId, t) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t), {
    headers: { Cookie: COOKIE },
  });
  const d = await r.json();
  return d.state;
}

function midOf(st, nick) {
  const m = (st.members || []).find((x) => x.nick === nick);
  return m ? m.mid : null;
}

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

(async () => {
  await boot();

  /* ---------- 1. 静态资源与本地一致 ---------- */
  for (const f of ['app.js', 'export.js', 'index.html']) {
    const local = md5(fs.readFileSync(path.join(ROOT, 'public', f)));
    const r = await fetch(BASE + '/' + f, { headers: { Cookie: COOKIE } });
    const remote = md5(Buffer.from(await r.arrayBuffer()));
    check('静态文件一致 ' + f, local === remote, { local, remote, http: r.status });
  }
  const html = await (await fetch(BASE + '/index.html', { headers: { Cookie: COOKIE } })).text();
  check('首页含实时预览提示节点 pvHint', html.includes('id="pvHint"'));
  check('首页含开局设置面板 setupBox', html.includes('id="setupBox"'));
  check('首页含裁判条 refBar', html.includes('id="refBar"'));

  /* ---------- 2. 线上语料统计 ---------- */
  const st0 = await (await fetch(BASE + '/api/stats', { headers: { Cookie: COOKIE } })).json();
  console.log('线上语料', JSON.stringify(st0.judge));
  check('线上语料未回退（3,288,184 句）', st0.judge && st0.judge.lines === 3288184, st0.judge);

  /* ---------- 3. 裁判 / 设置 / 重抽 ---------- */
  const A = await api('/api/create', { size: 10, rounds: 20, nick: '验甲' });
  const B = await api('/api/join', { roomId: A.roomId, nick: '验乙' });
  const W = await api('/api/join', { roomId: A.roomId, nick: '验裁' });
  const V = await api('/api/join', { roomId: A.roomId, nick: '验副' });   // 副裁
  const G = await api('/api/join', { roomId: A.roomId, nick: '验众' });   // 保持普通观众，验权限边界
  let st = await peek(A.roomId, A.token);
  const midW = midOf(st, '验裁');
  const midV = midOf(st, '验副');

  check('观众进房是 watcher', !!midW);
  const r0 = await api('/api/room/' + A.roomId + '/ref', { t: W.token, mid: midW, on: true });
  check('观众不能自封裁判', !r0.ok, r0);
  const r1 = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midW, on: true });
  check('选手可把观众设为裁判', r1.ok, r1);
  const r2 = await api('/api/room/' + A.roomId + '/ref', { t: B.token, mid: midV, on: true });
  check('可同时设多名裁判', r2.ok && (await peek(A.roomId, A.token)).refs.length === 2, r2);
  st = await peek(A.roomId, W.token);
  check('裁判视角 youRef / canControl', st.youRef === true && st.canControl === true, { youRef: st.youRef, can: st.canControl });
  check('成员列表带 ref 标签', (st.members || []).find((m) => m.nick === '验裁').ref === true);

  const c1 = await api('/api/room/' + A.roomId + '/cfg', { t: W.token, size: 8, extra: 6, rounds: 12, turnSeconds: 60 });
  check('裁判可改开局设置', c1.ok && c1.cfg.size === 8 && c1.cfg.turnSeconds === 60, c1);
  st = await peek(A.roomId, A.token);
  check('改路数后棋盘按新尺寸重铺', st.size === 8 && st.chars.length === 64, { size: st.size, len: st.chars.length });
  const before = st.chars;
  const c2 = await api('/api/room/' + A.roomId + '/redraw', { t: W.token });
  st = await peek(A.roomId, A.token);
  check('裁判可重抽棋盘', c2.ok && st.chars !== before && st.chars.length === 64);
  const c3 = await api('/api/room/' + A.roomId + '/cfg', { t: G.token, size: 12 });
  check('普通观众不能改设置', !c3.ok, c3);

  await api('/api/room/' + A.roomId + '/ready', { t: A.token, ready: true });
  await api('/api/room/' + A.roomId + '/ready', { t: B.token, ready: true });
  st = await peek(A.roomId, A.token);
  check('双方准备后开局', st.phase === 'playing', st.phase);
  const c4 = await api('/api/room/' + A.roomId + '/cfg', { t: A.token, size: 12 });
  check('开局后设置锁死', !c4.ok && c4.code === 'phase', c4);

  /* ---------- 4. 裁判掌流程 ---------- */
  const p1 = await api('/api/room/' + A.roomId + '/pause', { t: W.token });
  check('裁判可暂停', p1.ok && !!p1.paused, p1);
  const p2 = await api('/api/room/' + A.roomId + '/pause', { t: W.token });
  check('裁判可恢复', p2.ok && p2.resumed === true, p2);

  /* ---------- 5. 裁决按钮语义（服务端侧） ---------- */
  const mv = await api('/api/room/' + A.roomId + '/move', { t: A.token, text: '魑魅魍魉饕餮' });
  if (mv.code === 'dispute' || mv.pending) {
    st = await peek(A.roomId, A.token);
    check('争议挂起且冻结', !!st.dispute && st.dispute.by === 'A', st.dispute);
    const dj = await api('/api/room/' + A.roomId + '/dispute', { t: W.token, accept: false });
    check('裁判可裁决未收录句', dj.ok && dj.rejected === true, dj);
    st = await peek(A.roomId, A.token);
    check('裁决后争议清空（按钮该消失）', !st.dispute, st.dispute);
  } else {
    check('未收录句进入争议', false, mv);
  }

  const u1 = await api('/api/room/' + A.roomId + '/undo', { t: W.token });
  check('裁判撤销一步直接生效', u1.ok === true || u1.code === 'empty', u1);

  const f1 = await api('/api/room/' + A.roomId + '/finish', { t: B.token });
  check('选手提前结算＝发请求', f1.ok && !!f1.req, f1);
  const ag = await api('/api/room/' + A.roomId + '/consent', { t: W.token, accept: true });
  check('裁判可代批选手请求', ag.ok && ag.finished === true, ag);
  st = await peek(A.roomId, A.token);
  check('结算后 phase=finished', st.phase === 'finished', st.phase);

  const r3 = await api('/api/room/' + A.roomId + '/ref', { t: A.token, mid: midW, on: false });
  check('可取消裁判', r3.ok, r3);
  st = await peek(A.roomId, W.token);
  check('取消后立即失去权限', st.youRef === false && st.canControl === false, { youRef: st.youRef, can: st.canControl });

  /* ---------- 6. 清理（HTTP 离开，让房间尽快消失） ---------- */
  for (const t of [A.token, B.token, W.token, G.token]) {
    try { await api('/api/room/' + A.roomId + '/leave', { t }); } catch (_) {}
  }
  console.log('\n' + (bad ? bad + ' 项失败' : '全部通过') + '（测试房 id ' + A.roomId + '，发布后会再部署一次清空）');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
