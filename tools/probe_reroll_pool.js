'use strict';
/* 单格重随到底按哪个字库抽？ —— 实测探针（不是回归测试，结论看输出表格）
 *
 *   node tools/probe_reroll_pool.js
 *
 * 要回答的问题：点单个格子换字时，抽签范围是
 *   ① 当局设置决定的吗（常用字 / 低频字名额 / 自定义字库）
 *   ② 还是一个写死的混合池
 *
 * 三个场景各抽一批，直接数「换出来的字属于哪一类」：
 *   A. extra=0（全部常用字）→ 正确的实现应该 0% 低频字
 *   B. extra=17            → 常用的格换出常用、低频的格换出低频（保持盘面配比）
 *   C. 有自定义字库        → 应该 100% 出自字库
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
const cls = (ch) => (P.has(ch) ? '常用' : (E.has(ch) ? '低频' : '字库'));
/* 有自定义字库时，字库字优先归类 —— 天/地/玄 这类字同时在常用字表里，
   不先认字库就会把「字库里的 68 个字」数成零。 */
function clsWith(poolSet, ch) {
  if (poolSet && poolSet.has(ch)) return '字库';
  return cls(ch);
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
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0') + '%';

/* 千字文：短的一段 68 个不同的字（比 81 格的棋盘还少），长的一段 150 字上下（比棋盘多） */
const POOLTEXT = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡';
const POOLTEXT_BIG = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐吊民伐罪周发殷汤坐朝问道垂拱平章爱育黎首臣伏戎羌遐迩一体率宾归王鸣凤在竹白驹食场化被草木赖及万方';

(async () => {
  try {
    for (let p = 8930; p <= 8960; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    BASE = 'http://127.0.0.1:' + PORT;
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: tmpDir('probe-reroll-' + PORT), SWEEP_MS: '300',
      }),
      stdio: 'ignore',
    });
    if (!(await waitUp(40000))) throw new Error('实例没起来');
    await sleep(200);

    /* ---------- A. extra=0 ---------- */
    console.log('\n=== A. 低频字 0（棋面全是常用字）· 重随同一格 120 次 ===');
    const a = await post('/api/create', { nick: '甲', size: 9, extra: 0, playerCount: 2 });
    const ra = a.d.roomId, ta = a.d.token;
    let sa = await peek(ra, ta);
    const cnt0 = (s) => {
      const c = { 常用: 0, 低频: 0, 字库: 0 };
      for (const ch of s.chars) c[cls(ch)]++;
      return c;
    };
    console.log('开局盘面：' + JSON.stringify(cnt0(sa)) + '（应为 81 常用 / 0 低频）');

    const tallyA = { 常用: 0, 低频: 0, 字库: 0 };
    const samplesA = [];
    for (let i = 0; i < 120; i++) {
      const r = await post('/api/room/' + ra + '/reroll', { t: ta, index: 0 });
      if (!r.d.ok) { console.log('换字失败：' + JSON.stringify(r.d)); break; }
      tallyA[cls(r.d.ch)]++;
      if (samplesA.length < 12) samplesA.push(r.d.ch);
    }
    sa = await peek(ra, ta);
    console.log('换出 120 个字的分类：' + JSON.stringify(tallyA) + ' → 低频字占 ' + pct(tallyA.低频, 120));
    console.log('样本：' + samplesA.join(''));
    console.log('换算到 81 格：每点一次有 ' + pct(tallyA.低频, 120) + ' 的概率把一个常用字格变成低频字格');
    console.log('换完后盘面：' + JSON.stringify(cnt0(sa)));

    /* ---------- B. extra=17 ---------- */
    console.log('\n=== B. 低频字 17（9×9=81 格）· 分别重随「常用格」「低频格」各 60 次 ===');
    const b = await post('/api/create', { nick: '乙', size: 9, extra: 17, playerCount: 2 });
    const rb = b.d.roomId, tb = b.d.token;
    let sb = await peek(rb, tb);
    console.log('开局盘面：' + JSON.stringify(cnt0(sb)));

    async function rollOnes(targetCls, times, label) {
      const out = { 常用: 0, 低频: 0, 字库: 0, 没找到: 0, 失败: 0 };
      for (let i = 0; i < times; i++) {
        const st = await peek(rb, tb);
        const idx = st.chars.split('').findIndex((ch) => cls(ch) === targetCls);
        if (idx < 0) { out.没找到++; continue; }
        const r = await post('/api/room/' + rb + '/reroll', { t: tb, index: idx });
        if (!r.d.ok) { out.失败++; continue; }
        out[cls(r.d.ch)]++;
      }
      console.log(label + '：' + JSON.stringify(out));
      return out;
    }
    const b1 = await rollOnes('常用', 60, '点一个「常用字」格 60 次后，新字分类');
    const b2 = await rollOnes('低频', 60, '点一个「低频字」格 60 次后，新字分类');
    const sbEnd = await peek(rb, tb);
    console.log('换完后盘面：' + JSON.stringify(cnt0(sbEnd)) + '（配额 17，目标 17 低频）');

    /* ---------- C1. 自定义字库有富余（字库比棋盘大） ---------- */
    const bigN = new Set(POOLTEXT_BIG).size;
    console.log('\n=== C1. 自定义字库 ' + bigN + ' 字 > 棋盘 81 格（还有余量）· 点「字库字」的格子 80 次 ===');
    const c = await post('/api/create', { nick: '丙', size: 9, extra: 0, playerCount: 2 });
    const rc = c.d.roomId, tc = c.d.token;
    const setRes = await post('/api/room/' + rc + '/pool', { t: tc, text: POOLTEXT_BIG });
    const poolSet = new Set(POOLTEXT_BIG);
    let sc = await peek(rc, tc);
    const cntC = (s) => {
      const o = { 常用: 0, 低频: 0, 字库: 0 };
      for (const ch of s.chars) o[clsWith(poolSet, ch)]++;
      return o;
    };
    console.log('设库结果：' + JSON.stringify(setRes.d.pool) + '；盘面：' + JSON.stringify(cntC(sc)));
    const tallyC = { 常用: 0, 低频: 0, 字库: 0 };
    let sameC = 0;
    const samplesC = [];
    for (let i = 0; i < 80; i++) {
      const st = await peek(rc, tc);
      /* 专点「字库字」所在的格：撤掉它之后应该还能从字库里补一个没上盘的字回来 */
      const idx = st.chars.split('').findIndex((ch) => poolSet.has(ch));
      if (idx < 0) break;
      const was = st.chars.charAt(idx);
      const r = await post('/api/room/' + rc + '/reroll', { t: tc, index: idx });
      if (!r.d.ok) { console.log('换字失败：' + JSON.stringify(r.d)); break; }
      if (r.d.ch === was) sameC++;
      tallyC[clsWith(poolSet, r.d.ch)]++;
      if (samplesC.length < 12) samplesC.push(r.d.ch);
    }
    sc = await peek(rc, tc);
    console.log('换出分类：' + JSON.stringify(tallyC) + '；换了个寂寞（新字=旧字）' + sameC + ' 次');
    console.log('样本：' + samplesC.join(''));
    console.log('换完后盘面：' + JSON.stringify(cntC(sc)) + '（字库字应保持 81 个上盘）');

    /* ---------- C2. 字库刚好铺满 / 不足：没有余量可换 ---------- */
    const smallSet = new Set(POOLTEXT);
    console.log('\n=== C2. 自定义字库 ' + smallSet.size + ' 字 < 棋盘 81 格（字库字已全部上盘）· 点字库格 40 次 ===');
    const d = await post('/api/create', { nick: '丁', size: 9, extra: 0, playerCount: 2 });
    const rd = d.d.roomId, td = d.d.token;
    await post('/api/room/' + rd + '/pool', { t: td, text: POOLTEXT });
    let sd = await peek(rd, td);
    const cntD = (s) => {
      const o = { 常用: 0, 低频: 0, 字库: 0 };
      for (const ch of s.chars) o[clsWith(smallSet, ch)]++;
      return o;
    };
    console.log('盘面：' + JSON.stringify(cntD(sd)));
    const tallyD = { 常用: 0, 低频: 0, 字库: 0, 拒绝: 0 };
    let sameD = 0;
    for (let i = 0; i < 40; i++) {
      const st = await peek(rd, td);
      const idx = st.chars.split('').findIndex((ch) => smallSet.has(ch));
      if (idx < 0) break;
      const was = st.chars.charAt(idx);
      const r = await post('/api/room/' + rd + '/reroll', { t: td, index: idx });
      if (!r.d.ok) { tallyD.拒绝++; continue; }
      if (r.d.ch === was) sameD++;
      tallyD[clsWith(smallSet, r.d.ch)]++;
    }
    sd = await peek(rd, td);
    console.log('换出分类：' + JSON.stringify(tallyD) + '；换了个寂寞（新字=旧字）' + sameD + ' 次');
    console.log('换完后盘面：' + JSON.stringify(cntD(sd)) + '（字库字应仍是 ' + smallSet.size + ' 个）');

    console.log('\n=== 结论速览 ===');
    console.log('A extra=0 换出低频字：' + pct(tallyA.低频, 120) + '（应为 0%）');
    console.log('B 常用格→低频字：' + pct(b1.低频, b1.常用 + b1.低频) + '（应为 0%）');
    console.log('B 低频格→常用字：' + pct(b2.常用, b2.常用 + b2.低频) + '（应为 0%）');
    console.log('B 换完后低频格数：' + cnt0(sbEnd).低频 + '（目标 17，允许 ±0）');
    console.log('C1 字库外的字上盘：' + pct(tallyC.常用 + tallyC.低频, tallyC.常用 + tallyC.低频 + tallyC.字库) + '（应为 0%）');
    console.log('C2 字库外的字上盘：' + pct(tallyD.常用 + tallyD.低频, tallyD.常用 + tallyD.低频 + tallyD.字库) + '（应为 0%）');
    console.log('');
    try { child.kill(); } catch (_) {}
    process.exit(0);
  } catch (e) {
    console.log('异常：' + (e && e.stack || e));
    try { child && child.kill(); } catch (_) {}
    process.exit(1);
  }
})();
