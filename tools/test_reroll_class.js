'use strict';
/* 单格重随的字库范围 —— 回归测试。
 *
 *   node tools/test_reroll_class.js
 *
 * 需求原话：「开局前点击单个格子进行对此格重新随机汉字」。
 * 没说出口但必须成立的一条：换出来的字要**跟着当局的字库设置**走，
 * 而不是随便从一个大混合池里抽。否则：
 *   · 低频字设 0 的房间，点几下格子就长出满盘生僻字（实测 90%+）；
 *   · 低频字设 17 的盘面，点 120 下之后变成 66 个低频字；
 *   · 有自定义字库的房间，点字库格会掺进系统字，「字库优先」被点没了。
 *
 * 所以这里锁三件事：
 *   ① 常用字格只能换出常用字、低频字格只能换出低频字；
 *   ② 字库字格只能换出字库里的字；
 *   ③ 换完之后盘面的「字库 / 常用 / 低频」配比与换之前完全一致；
 * 以及一个边界：那一类字真的换不动时（字库比棋盘小且已全部上盘）要**明确报错**，
 * 不能返回一个「换了等于没换」的成功。
 */
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const { POOL, EXTRA } = require('../data/chars.js');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P = new Set(POOL.split(''));
const E = new Set(EXTRA.split(''));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

let PORT = 0, BASE = '', child = null;
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
async function peek(roomId, t) {
  const r = await fetch(BASE + '/api/room/' + roomId + '/peek?t=' + encodeURIComponent(t), { cache: 'no-store' });
  const d = await r.json();
  return d.state || null;
}

/* 千字文：短段 68 字（比 8×8=64 格多、比 9×9=81 格少），长段 144 字（比 81 格多） */
const POOL_SHORT = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡';
const POOL_BIG = POOL_SHORT + '鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方';

function tally(chars, poolSet) {
  const o = { pool: 0, common: 0, rare: 0 };
  for (const ch of chars) {
    if (poolSet && poolSet.has(ch)) o.pool++;
    else if (P.has(ch)) o.common++;
    else if (E.has(ch)) o.rare++;
    else o.rare++;   /* 既不在常用也不在低频：只有字库会这样，上面已拦掉 */
  }
  return o;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  try {
    for (let p = 8960; p <= 8999; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    BASE = 'http://127.0.0.1:' + PORT;
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: tmpDir('test-reroll-class-' + PORT), SWEEP_MS: '300',
      }),
      stdio: 'ignore',
    });
    if (!(await waitUp(40000))) throw new Error('实例没起来');
    await sleep(200);

    /* ---------- 1. 低频字 0：换出来的必须是常用字 ---------- */
    console.log('--- 1. 低频字 0 ---');
    const a = await post('/api/create', { nick: '甲', size: 8, extra: 0, playerCount: 2 });
    const ra = a.d.roomId, ta = a.d.token;
    const sa0 = await peek(ra, ta);
    check('盘面 64 格全是常用字', tally(sa0.chars).common === 64 && tally(sa0.chars).rare === 0,
      tally(sa0.chars));

    let rareOut = 0, dupOut = 0, noopOut = 0, errOut = 0;
    for (let i = 0; i < 64; i++) {
      const st = await peek(ra, ta);
      const was = st.chars.charAt(i);
      const r = await post('/api/room/' + ra + '/reroll', { t: ta, index: i });
      if (!r.d.ok) { errOut++; continue; }
      if (E.has(r.d.ch)) rareOut++;
      if (r.d.ch === was) noopOut++;
      const after = (await peek(ra, ta)).chars;
      if (after.split('').some((ch, k) => k !== i && ch === r.d.ch)) dupOut++;
    }
    check('64 次换字全部成功', errOut === 0, errOut);
    check('换出来的 100% 是常用字（低频字 0 时一个生僻字都不许有）', rareOut === 0, rareOut + ' 个低频字');
    check('不会换出与旧字相同的字（点了必须有反应）', noopOut === 0, noopOut);
    check('不会与盘上其它格重字', dupOut === 0, dupOut);
    const sa1 = await peek(ra, ta);
    check('换完之后盘面仍然 64 常用 / 0 低频', same(tally(sa1.chars), { pool: 0, common: 64, rare: 0 }), tally(sa1.chars));

    /* ---------- 2. 低频字 17：配比不许被点乱 ---------- */
    console.log('--- 2. 低频字 17 ---');
    const b = await post('/api/create', { nick: '乙', size: 9, extra: 17, playerCount: 2 });
    const rb = b.d.roomId, tb = b.d.token;
    const sb0 = await peek(rb, tb);
    const t0 = tally(sb0.chars);
    check('开局 81 格里低频字正好 17 个', t0.rare === 17 && t0.common === 64, t0);

    /* 反复点「当前是常用字」的格，看新字会不会变成低频字 */
    let commonToRare = 0, commonRolls = 0;
    for (let i = 0; i < 40; i++) {
      const st = await peek(rb, tb);
      const idx = st.chars.split('').findIndex((ch) => P.has(ch));
      if (idx < 0) break;
      const r = await post('/api/room/' + rb + '/reroll', { t: tb, index: idx });
      if (!r.d.ok) break;
      commonRolls++;
      if (E.has(r.d.ch)) commonToRare++;
    }
    check('点常用字格 40 次', commonRolls === 40, commonRolls);
    check('常用字格换出的仍是常用字（不会冒出低频字）', commonToRare === 0, commonToRare);

    /* 反过来点「当前是低频字」的格 */
    let rareToCommon = 0, rareRolls = 0;
    for (let i = 0; i < 40; i++) {
      const st = await peek(rb, tb);
      const idx = st.chars.split('').findIndex((ch) => E.has(ch));
      if (idx < 0) break;
      const r = await post('/api/room/' + rb + '/reroll', { t: tb, index: idx });
      if (!r.d.ok) break;
      rareRolls++;
      if (P.has(r.d.ch)) rareToCommon++;
    }
    check('点低频字格 40 次', rareRolls === 40, rareRolls);
    check('低频字格换出的仍是低频字（不会掉成常用字）', rareToCommon === 0, rareToCommon);

    const sb1 = await peek(rb, tb);
    check('80 次换字后配比一点没变（64 常用 / 17 低频）', same(tally(sb1.chars), t0), [t0, tally(sb1.chars)]);

    /* ---------- 3. 自定义字库有余量：只在字库里换 ---------- */
    console.log('--- 3. 字库有余量 ---');
    const poolSet = new Set(POOL_BIG);
    const c = await post('/api/create', { nick: '丙', size: 9, extra: 17, playerCount: 2 });
    const rc = c.d.roomId, tc = c.d.token;
    await post('/api/room/' + rc + '/pool', { t: tc, text: POOL_BIG });
    const sc0 = await peek(rc, tc);
    check('字库 144 字铺满 81 格，一个系统字都没有', tally(sc0.chars, poolSet).pool === 81, tally(sc0.chars, poolSet));

    let outOfPool = 0, poolNoop = 0, poolDup = 0, poolErr = 0;
    for (let i = 0; i < 40; i++) {
      const st = await peek(rc, tc);
      const idx = st.chars.split('').findIndex((ch) => poolSet.has(ch));
      if (idx < 0) break;
      const was = st.chars.charAt(idx);
      const r = await post('/api/room/' + rc + '/reroll', { t: tc, index: idx });
      if (!r.d.ok) { poolErr++; continue; }
      if (!poolSet.has(r.d.ch)) outOfPool++;
      if (r.d.ch === was) poolNoop++;
      const after = (await peek(rc, tc)).chars;
      if (after.split('').some((ch, k) => k !== idx && ch === r.d.ch)) poolDup++;
    }
    check('40 次换字全部成功', poolErr === 0, poolErr);
    check('换出来的字 100% 出自自定义字库（不掺系统字）', outOfPool === 0, outOfPool);
    check('字库字格里不会换出旧字', poolNoop === 0, poolNoop);
    check('字库字格之间也不重字', poolDup === 0, poolDup);
    check('换完仍然 81 个字库字', tally((await peek(rc, tc)).chars, poolSet).pool === 81);

    /* ---------- 4. 字库不足且已全部上盘：明确报错，不假成功 ---------- */
    console.log('--- 4. 字库用尽 ---');
    const small = new Set(POOL_SHORT);
    const d = await post('/api/create', { nick: '丁', size: 9, extra: 0, playerCount: 2 });
    const rd = d.d.roomId, td = d.d.token;
    await post('/api/room/' + rd + '/pool', { t: td, text: POOL_SHORT });
    const sd0 = await peek(rd, td);
    check('字库 68 字比 81 格少，68 个全部上盘', tally(sd0.chars, small).pool === small.size, tally(sd0.chars, small));

    const poolIdx = sd0.chars.split('').findIndex((ch) => small.has(ch));
    const sysIdx = sd0.chars.split('').findIndex((ch) => !small.has(ch));
    const rollPool = await post('/api/room/' + rd + '/reroll', { t: td, index: poolIdx });
    check('字库已用尽时点字库格 → 明确报错（不给假成功）',
      rollPool.d.ok === false && rollPool.d.code === 'exhausted', rollPool.d);
    check('报错里说清楚是哪套字库', /自定义字库/.test(String(rollPool.d.reason || '')), rollPool.d.reason);
    const sd1 = await peek(rd, td);
    check('报错的这一下不能改动盘面', sd1.chars === sd0.chars);

    const rollSys = await post('/api/room/' + rd + '/reroll', { t: td, index: sysIdx });
    check('系统补的格子照样能换', rollSys.d.ok === true, rollSys.d);
    check('系统格换出来仍是系统字（不会假装是字库字）',
      !small.has(rollSys.d.ch) && (P.has(rollSys.d.ch) || E.has(rollSys.d.ch)), rollSys.d.ch);

    /* ---------- 5. 撤下字库后回到系统字库的分类 ---------- */
    console.log('--- 5. 撤下字库 ---');
    await post('/api/room/' + rd + '/pool', { t: td, text: '  ' });
    const se0 = await peek(rd, td);
    check('撤下后盘面回到 81 格系统字库', se0.pool.count === 0 && se0.chars.length === 81, se0.pool);
    const idx0 = 0;
    const was0 = se0.chars.charAt(idx0);
    const rollAfterClear = await post('/api/room/' + rd + '/reroll', { t: td, index: idx0 });
    check('撤下后还能换字', rollAfterClear.d.ok === true, rollAfterClear.d);
    check('新字跟着「旧字所属的那套字库」走',
      (P.has(was0) && P.has(rollAfterClear.d.ch)) || (E.has(was0) && E.has(rollAfterClear.d.ch)),
      [was0, rollAfterClear.d.ch]);

    /* ---------- 6. 低频字的权重没被破坏 ---------- */
    console.log('--- 6. 低频字权重 ---');
    const f = await post('/api/create', { nick: '戊', size: 6, extra: 36, playerCount: 2 });
    const rf = f.d.roomId, tf = f.d.token;
    const sf = await peek(rf, tf);
    check('6×6=36 格全是低频字（extras 吃满）', tally(sf.chars).rare === 36, tally(sf.chars));
    const rollRare = await post('/api/room/' + rf + '/reroll', { t: tf, index: 0 });
    check('低频规格的房间里换字仍然出低频字', rollRare.d.ok === true && E.has(rollRare.d.ch), rollRare.d);

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
