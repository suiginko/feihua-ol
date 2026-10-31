'use strict';
/* 线上发布验证：新语料 + 跨小句判定是否真的生效。
 * 用法：node tools/online_check.js
 * 网关需要 sharecode cookie，不带就一律回首页 HTML —— 先访问一次拿 cookie。 */

const BASE = 'https://feihua-splatoon.app.workbuddy.host';
const SHARE = 'MZA5YPLHV3';

let COOKIE = '';

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
  try { return JSON.parse(txt); } catch (_) {
    return { ok: false, http: r.status, raw: txt.slice(0, 120) };
  }
}

async function newTable() {
  const c = await api('/api/create', { size: 17, nick: '验证甲' });
  const j = await api('/api/join', { roomId: c.roomId, nick: '验证乙' });
  await api('/api/room/' + c.roomId + '/ready', { t: c.token, ready: true });
  const s = await api('/api/room/' + c.roomId + '/ready', { t: j.token, ready: true });
  return { roomId: c.roomId, ta: c.token, tb: j.token, started: s.started, chars: c.state.chars };
}

const CASES = [
  '故国神游，多情应笑我，早生华发。',
  '百年里浑教是醉三万六千场。',
  '眼前直下三千字胸次全无一点尘。',
  '归去，也无风雨也无晴。',
  '欲把西湖比西子，淡妆浓抹总相宜。',
];

(async () => {
  await boot();
  let pass = 0;
  for (const q of CASES) {
    let done = null;
    for (let tryNo = 0; tryNo < 8 && !done; tryNo++) {
      const t = await newTable();
      if (!t.started) { console.log('开局失败', t); break; }
      const r = await api('/api/room/' + t.roomId + '/move', { t: t.ta, text: q });
      if (r.code === 'no_hit' || r.code === 'no_blank') { continue; }  // 盘面不配合，换一张盘
      done = { r, t };
      break;
    }
    if (!done) { console.log('SKIP  ' + q + '（盘面始终没有对应字）'); continue; }
    const { r } = done;
    const src = r.source ? r.source.author + '《' + r.source.title + '》' + (r.source.dynasty || '') : '';
    console.log((r.ok ? 'PASS  ' : 'FAIL  ') + q + '  [' + (r.code || r.via || '') + ']  ' + src + (r.reason ? '  ← ' + r.reason : ''));
    if (r.ok) pass++;
  }
  console.log('\n线上真句 ' + pass + '/' + CASES.length + ' 通过');

  /* 伪句：改字 / 自造 —— 必须不放行（not_found 会转成待裁决，不是直接通过） */
  const FAKE = ['故国神游，多情应笑吾，早生华发', '百年里浑教是醉三万六千零一场', '欲把西湖比西子淡妆浓抹总相疑'];
  for (const q of FAKE) {
    const t = await newTable();
    const r = await api('/api/room/' + t.roomId + '/move', { t: t.ta, text: q });
    const okish = !!r.ok;
    console.log((okish ? 'FAIL  ' : 'PASS  ') + '伪句 ' + q + '  [' + (r.code || '') + ']' + (r.pending ? ' 转裁决' : ''));
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
