'use strict';
/* 自定义字库 + 单格重随 —— 回归测试。
 *
 *   node tools/test_custom_pool.js
 *
 * 验收两条需求：
 *   ① 开局前能粘一段文本当字库，**棋盘优先用里面的汉字，不够才由系统字库补**；
 *   ② 开局前**点单个格子能重随那一格的汉字**。
 *
 * 这里最要紧的不是「能用」，而是边界：
 *   · 字库的字必须**全部**上盘（挂一漏万就等于没生效）；
 *   · 系统补的部分**不能**再出现字库里的字（否则「优先」就变成了「掺着用」）；
 *   · 一格一个字，**不能重字**（重字会让「这句命中哪一格」变含糊）；
 *   · 繁体必须转简体 —— 否则玩家敲简体永远涂不上那些格，功能看起来是坏的；
 *   · 开局后一律锁死；观众一律无权。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

const HAN = /[\u3400-\u4DBF\u4E00-\u9FA5\u3007]/;
function uniqHan(text) {
  const out = [];
  const seen = new Set();
  for (const ch of String(text)) {
    if (!HAN.test(ch)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

let PORT = 0, BASE = '', dataDir = '', child = null;
function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}
async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/stats', { cache: 'no-store' });
      if (r.ok) { const d = await r.json(); if (d && d.pid === child.pid) return true; }
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}
function killChild() {
  if (!child) return;
  try { child.kill(); } catch (_) {}
  child = null;
}
async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function peek(roomId, t) {
  const r = await get('/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t));
  return r.d.state || null;
}

/* 千字文开头一段：150 字上下、重字极少，用来测「字库比棋盘还大」 */
const QIANZI = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方';

(async () => {
  try {
    for (let p = 8970; p <= 8995; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    BASE = 'http://127.0.0.1:' + PORT;
    dataDir = tmpDir('test-custom-pool-' + PORT);

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, SWEEP_MS: '300' }),
      stdio: 'ignore',
    });
    if (!(await waitUp(40000))) throw new Error('实例没起来');
    await sleep(200);

    /* ---------- 1. 默认状态：没有字库，棋盘照旧 ---------- */
    console.log('--- 默认状态 ---');
    const cr = await post('/api/create', { nick: '字库主', size: 10, extra: 0, playerCount: 2 });
    const roomId = cr.d.roomId;
    const tA = cr.d.token;
    check('建房成功', cr.d.ok === true && !!roomId, cr.d);
    check('默认没有自定义字库', cr.d.state.pool && cr.d.state.pool.count === 0, cr.d.state.pool);
    check('默认棋盘 10×10=100 格', cr.d.state.chars.length === 100, cr.d.state.chars.length);
    check('默认棋盘一格一字不重复', new Set(cr.d.state.chars.split('')).size === 100);
    check('选手开局前可以点格子', cr.d.state.canPickCells === true);

    /* ---------- 2. 设字库：字库的字全部上盘，剩余由系统补 ---------- */
    console.log('--- 设字库 ---');
    const TEXT = '东风不来，三月的柳絮不飞。你的心如小小的寂寞的城。';
    const want = uniqHan(TEXT);
    check('测试文本去重后在 10–99 字之间（小于棋盘，才测得到「系统补全」）',
      want.length >= 10 && want.length < 100, want.length);

    const set1 = await post('/api/room/' + roomId + '/pool', { t: tA, text: TEXT });
    check('设字库成功', set1.d.ok === true, set1.d);
    check('字库字数 = 去重后的汉字数', set1.d.pool && set1.d.pool.count === want.length,
      set1.d.pool && [set1.d.pool.count, want.length]);

    let st = await peek(roomId, tA);
    let chars = st.chars.split('');
    const poolSet = new Set(want);
    const fromPool = chars.filter((ch) => poolSet.has(ch));
    check('棋盘格数没变', chars.length === 100, chars.length);
    check('字库里的字一个不少全上盘', want.every((ch) => chars.includes(ch)),
      want.filter((ch) => !chars.includes(ch)));
    check('字库恰好占了这么多格（没有多余重复）', fromPool.length === want.length, fromPool.length);
    check('剩下的 ' + (100 - want.length) + ' 格由系统字库补',
      chars.filter((ch) => !poolSet.has(ch)).length === 100 - want.length,
      chars.filter((ch) => !poolSet.has(ch)).length);
    check('补完仍然一格一字不重复', new Set(chars).size === 100, new Set(chars).size);
    check('状态里读得到字库统计', st.pool.count === want.length, st.pool);

    /* ---------- 3. 繁体 / 标点 / 字母数字 ---------- */
    console.log('--- 归一化 ---');
    const set2 = await post('/api/room/' + roomId + '/pool', { t: tA, text: '東風夜放花千樹 123 ABC，。！' });
    check('繁体文本被接受', set2.d.ok === true, set2.d);
    st = await peek(roomId, tA);
    chars = st.chars.split('');
    check('繁体转成了简体（东/风/树 上盘）',
      ['东', '风', '树'].every((ch) => chars.includes(ch)), chars.join(''));
    check('非汉字被忽略（没有数字或字母上盘）',
      chars.every((ch) => HAN.test(ch)), chars.filter((ch) => !HAN.test(ch)));
    check('字库只算了 7 个字（東風夜放花千樹）', st.pool.count === 7, st.pool.count);

    /* ---------- 4. 字库比棋盘大：只取需要的 ---------- */
    console.log('--- 字库大于棋盘 ---');
    const qz = uniqHan(QIANZI);
    check('千字文那段去重后超过 100 字', qz.length > 100, qz.length);
    const set3 = await post('/api/room/' + roomId + '/pool', { t: tA, text: QIANZI });
    check('大篇字库被接受', set3.d.ok === true, set3.d);
    check('字库统计按去重后算', set3.d.pool.count === qz.length, [set3.d.pool.count, qz.length]);
    st = await peek(roomId, tA);
    chars = st.chars.split('');
    check('棋盘只有 100 格', chars.length === 100);
    check('100 格全部出自字库', chars.every((ch) => qz.includes(ch)));
    check('仍然不重复', new Set(chars).size === 100);

    /* ---------- 5. 落盘：字库要进房间快照 ---------- */
    console.log('--- 快照 ---');
    let snapOk = false;
    for (let i = 0; i < 12 && !snapOk; i++) {
      await sleep(500);
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'rooms.snap.json'), 'utf8'));
        const sr = (snap.rooms || []).find((x) => x.id === roomId);
        if (sr && sr.pool && Array.isArray(sr.pool.chars) && sr.pool.chars.length === qz.length) snapOk = true;
      } catch (_) { /* 还没写出来 */ }
    }
    check('字库进了房间快照（发布重启后不会丢）', snapOk);

    /* ---------- 6. 单格重随 ---------- */
    console.log('--- 单格重随 ---');
    const before = (await peek(roomId, tA)).chars;
    const rr = await post('/api/room/' + roomId + '/reroll', { t: tA, index: 3 });
    check('换字成功', rr.d.ok === true, rr.d);
    const after = (await peek(roomId, tA)).chars;
    check('只有第 4 格变了（前后各半段完全一致）',
      after.slice(0, 3) === before.slice(0, 3) && after.slice(4) === before.slice(4),
      [before.charAt(3), after.charAt(3)]);
    check('新字与盘上其它格不重复',
      !after.split('').some((ch, i) => i !== 3 && ch === rr.d.ch), rr.d.ch);
    check('换出来的字优先来自字库', qz.includes(rr.d.ch), rr.d.ch);
    check('格子总数没变', after.length === 100);

    const rrBad = await post('/api/room/' + roomId + '/reroll', { t: tA, index: 999 });
    check('越界格子编号被拒', rrBad.d.ok === false && rrBad.d.code === 'index', rrBad.d);

    /* ---------- 7. 观众无权 ---------- */
    console.log('--- 权限 ---');
    const jB = await post('/api/join', { roomId: roomId, nick: '乙' });
    const jW = await post('/api/join', { roomId: roomId, nick: '路过观众' });
    check('第三个人进来是观众', jW.d.ok === true && jW.d.role !== 'player', jW.d.role);
    const wPool = await post('/api/room/' + roomId + '/pool', { t: jW.d.token, text: '春江花月夜' });
    check('观众不能设字库', wPool.d.ok === false && wPool.d.code === 'not-allowed', wPool.d);
    const wRoll = await post('/api/room/' + roomId + '/reroll', { t: jW.d.token, index: 0 });
    check('观众不能换字', wRoll.d.ok === false && wRoll.d.code === 'not-allowed', wRoll.d);
    const wSt = await peek(roomId, jW.d.token);
    check('观众状态里 canPickCells 为 false', wSt.canPickCells === false);

    /* ---------- 8. 撤下 / 非法文本 ---------- */
    console.log('--- 撤下与非法输入 ---');
    const noHan = await post('/api/room/' + roomId + '/pool', { t: tA, text: 'abc 123 !!!' });
    check('没有汉字的文本被拒', noHan.d.ok === false && noHan.d.code === 'no-hanzi', noHan.d);
    st = await peek(roomId, tA);
    check('被拒时原有的字库原封不动', st.pool.count === qz.length, st.pool.count);

    const clr = await post('/api/room/' + roomId + '/pool', { t: tA, text: '   ' });
    check('留空保存 = 撤下字库', clr.d.ok === true && clr.d.pool.count === 0, clr.d);
    st = await peek(roomId, tA);
    check('撤下后状态里也没有字库了', st.pool.count === 0, st.pool);
    check('撤下后棋盘回到系统字库（100 格照旧）', st.chars.length === 100);

    /* ---------- 9. 事件流水 ---------- */
    console.log('--- 事件流水 ---');
    st = await peek(roomId, tA);
    const evs = (st.events || []).filter((e) => e.type === 'pool' || e.type === 'reroll');
    check('设字库与换字都记进了事件流', evs.length >= 4, evs.length);
    check('撤下也有记录', evs.some((e) => /撤下/.test(e.text)));
    check('换字记录里有格子与前后两个字', evs.some((e) => /换了第 4 格/.test(e.text)), evs.map((e) => e.text).slice(-3));

    /* ---------- 10. 开局后锁死 ---------- */
    console.log('--- 开局后 ---');
    await post('/api/room/' + roomId + '/ready', { t: tA, ready: true });
    await post('/api/room/' + roomId + '/ready', { t: jB.d.token, ready: true });
    st = await peek(roomId, tA);
    check('双方准备后进入对局', st.phase === 'playing', st.phase);
    const latePool = await post('/api/room/' + roomId + '/pool', { t: tA, text: '春江花月夜' });
    check('开局后不能再设字库', latePool.d.ok === false && latePool.d.code === 'phase', latePool.d);
    const lateRoll = await post('/api/room/' + roomId + '/reroll', { t: tA, index: 0 });
    check('开局后不能再换字', lateRoll.d.ok === false && lateRoll.d.code === 'phase', lateRoll.d);
    const lateSt = await peek(roomId, tA);
    check('开局后 canPickCells 为 false', lateSt.canPickCells === false);

    console.log('');
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    killChild();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('异常：' + (e && e.stack || e));
    killChild();
    process.exit(1);
  }
})();
