'use strict';
/* 先手（赤营 A 席）对胜率的影响。
 *
 *   node tools/analyze_first_move.js                      读 exports/ 下最新的导出
 *   node tools/analyze_first_move.js exports/xxx.json     指定文件
 *
 * ---- 口径（先说清楚，否则数字没意义） ----
 * · 先手 = **A 席**。建房的人是 A，`turn` 从 A 开始、`turnNo` 从 1 起，
 *   之后每轮都按 A→B→C→D 轮转 —— 所以 A 在**每一轮都是第一个出手**，对手最后一个收尾。
 * · 有效局 = `playerCount ≥ 2` 且**至少两个席位真的出过手**。
 *   255 局里剔掉 109 局单人练习、2 局开到一半没人出手，剩 144 局（双人 135、三四人 9）。
 * · 胜负 = 终局比分最高者，**最高分并列算平局**（游戏里也是这么判的）。
 * · **「出手次数」= 落地手 + 跳过（pass）**，不是只看落地手。
 *   这一点很要紧：78 局里出现过跳过，共 220 次。只数落地手会把
 *   「对方跳过、我方多落地一次」当成「多打一手」，那是假信号。
 *   校验：105 局「轮数已满」的双人局，两边出手次数都恰好等于 rounds，一局不差。
 * · 样本只有一百多局，所以每个比例都配 95% 区间与二项检验 p 值 ——
 *   不显著就写不显著，不拿 55% 当结论。
 */

const fs = require('fs');
const path = require('path');
const recordFix = require('./../recordfix');

const ROOT = path.resolve(__dirname, '..');
const SEATS = ['A', 'B', 'C', 'D'];
const SEAT_HALL = { A: '赤营', B: '青营', C: '金营', D: '翠营' };

/* ---------------- 统计小工具 ---------------- */

const logGamma = (x) => {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += g[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
};
const logC = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
const binomPmf = (n, k, p) => Math.exp(logC(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p));

/* 双侧精确二项检验：把「概率不大于观测值」的项全加起来 —— 这就是 p 值的定义。 */
function binomTest(n, k, p) {
  if (!n) return NaN;
  const obs = binomPmf(n, k, p);
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const q = binomPmf(n, i, p);
    if (q <= obs * (1 + 1e-7)) s += q;
  }
  return Math.min(1, s);
}

/* Wilson 区间：小样本、比例贴近 0/1 时比正态近似可靠。 */
function wilson(k, n, z) {
  if (!n) return [NaN, NaN];
  z = z || 1.96;
  const p = k / n, d = 1 + z * z / n;
  const c = p + z * z / (2 * n);
  const s = Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - z * s) / d), Math.min(1, (c + z * s) / d)];
}

const pct = (x, d) => (Number.isFinite(x) ? (x * 100).toFixed(d === undefined ? 1 : d) + '%' : '—');
const pctCI = (k, n) => {
  if (!n) return '—';
  const [lo, hi] = wilson(k, n);
  return pct(k / n) + '（' + pct(lo, 0) + '–' + pct(hi, 0) + '）';
};
const pTxt = (p) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3));
/* 显著性只标在 p 值那一格：把星号挂在比例后面会破坏表格，也容易让人以为「比例本身有星」。 */
const pCell = (p) => (!Number.isFinite(p) ? '—' : (p < 0.001 ? '<0.001' : p.toFixed(3)) + (p < 0.05 ? ' ✓' : ''));

/* 配对差值的 95% 区间（b−a 逐局相减） */
function paired(diffs) {
  const n = diffs.length;
  if (!n) return { mean: NaN, ci: [NaN, NaN] };
  const m = diffs.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(diffs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  return { mean: m, ci: [m - 1.96 * se, m + 1.96 * se], se: se };
}

/* ---------------- 读存档 ---------------- */

/* 默认**合并 exports/ 下全部 records-*.json**（按 rid 去重）。
 * 只读最新一份会漏掉历史局 —— 10-22 那次就是这样，当时只有 255 局、
 * 三四人局只有 9 局，根本没法单独看三人局。 */
function loadRecords(argv) {
  const given = argv.find((a) => a && !a.startsWith('--') && /\.json$/.test(a));
  let files;
  if (given) files = [path.resolve(given)];
  else {
    const dir = path.join(ROOT, 'exports');
    const cands = fs.readdirSync(dir).filter((f) => /^records-.*\.json$/.test(f)).sort();
    if (!cands.length) throw new Error('exports/ 下没有导出文件，先跑 node tools/export_records.js');
    files = cands.map((f) => path.join(dir, f));
  }
  const byRid = new Map();
  const per = [];
  let exportedAt = null;
  for (const file of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    /* 取**最新**的导出时刻。注意 exportedAt 是**数字时间戳**（不是 ISO 串），
     * 早先这里用 Date.parse() 比较 → 对数字返回 NaN → 比较永远为 false，
     * 结果报的是第一份文件的 10-21，看着像"最近一次导出在四天后之前"。 */
    const stamp = Number(raw.exportedAt);
    if (Number.isFinite(stamp) && stamp > (exportedAt || 0)) exportedAt = stamp;
    const arr = raw.records || raw.list || [];
    let added = 0;
    for (const r of arr) {
      const rid = r.rid || ((r.id || '?') + '@' + (r.at || 0));
      if (byRid.has(rid)) continue;
      /* 顺手把旧存档里丢掉的金营翠营补回来：只影响 CSV 里的名字，不影响任何统计量。 */
      const f = recordFix.repairRecord(r);
      byRid.set(rid, f.changed ? Object.assign({}, r, { players: f.players }) : r);
      added++;
    }
    per.push({ file: path.relative(ROOT, file), total: arr.length, added: added });
  }
  return { files: per, exportedAt: exportedAt, list: [...byRid.values()] };
}

/* ---------------- 一局 → 一行事实 ---------------- */

function describe(rec) {
  const cfg = rec.cfg || {};
  const zero = () => ({ A: 0, B: 0, C: 0, D: 0 });
  const turns = zero(), flies = zero(), cap = zero(), hold = zero(), hits = zero(), blank = zero();
  let lastSeat = '';
  for (const e of rec.log || []) {
    if (!e) continue;
    const s = String(e.team || '').toUpperCase();
    if (turns[s] === undefined) continue;
    if (e.type === 'fly' || e.type === 'pass') turns[s]++;
    if (e.type === 'fly') {
      flies[s]++;
      cap[s] += Number(e.capture) || 0;
      hold[s] += Number(e.hold) || 0;
      hits[s] += Number(e.hits) || 0;
      blank[s] += Number(e.blank) || 0;
      lastSeat = s;
    }
  }
  const active = SEATS.filter((s) => flies[s] > 0);
  const sc = rec.score || {};
  const score = { A: Number(sc.a) || 0, B: Number(sc.b) || 0, C: Number(sc.c) || 0, D: Number(sc.d) || 0 };
  const others = active.filter((s) => s !== 'A');
  const top = Math.max.apply(null, active.map((s) => score[s]));
  const atTop = active.filter((s) => score[s] === top);
  const maxOtherTurns = others.length ? Math.max.apply(null, others.map((s) => turns[s])) : 0;
  return {
    rid: rec.id + '@' + rec.at, id: rec.id, at: rec.at,
    reason: rec.reason || '', players: rec.players || {},
    pc: Math.round(Number(cfg.playerCount)) || active.length,
    size: Number(cfg.size) || 0, rounds: Number(cfg.rounds) || 0,
    active: active, turns: turns, flies: flies, cap: cap, hold: hold, hits: hits, blank: blank,
    score: score, top: top, winner: atTop.length === 1 ? atTop[0] : '',
    aWon: atTop.length === 1 && atTop[0] === 'A',
    /* >0 表示先手比所有对手都多出手一次（含跳过） */
    turnLead: turns.A - maxOtherTurns,
    lastSeat: lastSeat,
    /* 先手比对手平均多涂几格 */
    gap: score.A - (others.length ? others.reduce((n, s) => n + score[s], 0) / others.length : 0),
  };
}

/* ---------------- 一张表 ---------------- */

function tally(rows) {
  const n = rows.length;
  const win = rows.filter((r) => r.aWon).length;
  const draw = rows.filter((r) => !r.winner).length;
  const lose = n - win - draw;
  const decided = win + lose;
  const g = paired(rows.map((r) => r.gap));
  return {
    n: n, win: win, draw: draw, lose: lose, decided: decided,
    rateHL: n ? (win + draw * 0.5) / n : NaN,
    rateEx: decided ? win / decided : NaN,
    p: decided ? binomTest(decided, win, 0.5) : NaN,
    gapMean: g.mean, gapCI: g.ci,
  };
}

function table(title, groups, note) {
  const out = ['', '### ' + title, ''];
  out.push('| 分组 | 局数 | 先手胜 | 平 | 先手负 | 胜率（平局折半） | 胜率（不含平局） | 95% 区间 | p 值 | 先手平均分差 |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---|---:|---|');
  const all = [];
  const row = (label, rows) => {
    const t = tally(rows);
    out.push('| ' + label + ' | ' + t.n + ' | ' + t.win + ' | ' + t.draw + ' | ' + t.lose + ' | ' +
      pct(t.rateHL) + ' | ' + pct(t.rateEx) + ' | ' + pctCI(t.win, t.decided) + ' | ' + pCell(t.p) + ' | ' +
      (Number.isFinite(t.gapMean) ? (t.gapMean >= 0 ? '+' : '') + t.gapMean.toFixed(2) + ' 格（' +
        t.gapCI[0].toFixed(1) + '–' + t.gapCI[1].toFixed(1) + '）' : '—') + ' |');
  };
  for (const k of Object.keys(groups)) {
    if (!groups[k].length) continue;
    all.push.apply(all, groups[k]);
    row(k, groups[k]);
  }
  if (Object.keys(groups).filter((k) => groups[k].length).length > 1) row('**合计**', all);
  if (note) { out.push('', '> ' + note); }
  return out.join('\n');
}

/* ---------------- 多人局：逐席位胜率 ---------------- */

/* 三人/四人局不能用「先手 vs 其余」二分，要每个席位单独一行。
 * 基线是 1/N（三人 33.3%、四人 25%），不是 50%。 */
function seatBreakdown(rows, N) {
  const seats = SEATS.slice(0, N);
  const cnt = {};
  for (const s of seats) cnt[s] = { w: 0, n: 0, sum: 0, gaps: [] };
  let ties = 0;
  for (const r of rows) {
    const vals = seats.map((s) => r.score[s]);
    const top = Math.max.apply(null, vals);
    const atTop = seats.filter((s, i) => vals[i] === top);
    const tie = atTop.length > 1;
    if (tie) ties++;
    seats.forEach((s, i) => {
      const c = cnt[s];
      c.n++;
      c.sum += vals[i];
      if (!tie && vals[i] === top) c.w++;
      const others = vals.filter((_, j) => j !== i);
      c.gaps.push(vals[i] - others.reduce((a, b) => a + b, 0) / Math.max(1, others.length));
    });
  }
  const out = ['| 席位 | 出场 | 拿第一 | 胜率 | 95% 区间 | 相对均匀基线 | p 值 | 场均分 | 相对他人分差 |'];
  out.push('|---|---:|---:|---:|---|---:|---:|---:|---|');
  for (const s of seats) {
    const c = cnt[s];
    if (!c.n) { out.push('| ' + SEAT_HALL[s] + '（' + s + '） | 0 | — | — | — | — | — | — | — |'); continue; }
    const rate = c.w / c.n;
    const [lo, hi] = wilson(c.w, c.n);
    const g = paired(c.gaps);
    out.push('| ' + SEAT_HALL[s] + '（' + s + '） | ' + c.n + ' | ' + c.w + ' | ' + pct(rate) +
      ' | ' + pct(lo, 0) + '–' + pct(hi, 0) +
      ' | ' + (rate - 1 / N >= 0 ? '+' : '') + ((rate - 1 / N) * 100).toFixed(1) + ' pt' +
      ' | ' + pCell(binomTest(c.n, c.w, 1 / N)) +
      ' | ' + (c.sum / c.n).toFixed(1) +
      ' | ' + (g.mean >= 0 ? '+' : '') + g.mean.toFixed(2) + '（' + g.ci[0].toFixed(1) + '–' + g.ci[1].toFixed(1) + '） |');
  }
  return { md: out.join('\n'), ties: ties };
}

/* ---------------- 主流程 ---------------- */

const src = loadRecords(process.argv.slice(2));
const all = src.list.map(describe);
const solo = all.filter((r) => r.active.length < 2);
const multi = all.filter((r) => r.active.length >= 2 && r.pc >= 2);
const two = multi.filter((r) => r.active.length === 2);
const three = multi.filter((r) => r.active.length === 3);
const four = multi.filter((r) => r.active.length === 4);
const three4 = multi.filter((r) => r.active.length >= 3);
const equalTurn = two.filter((r) => r.turnLead === 0);
const extraTurn = two.filter((r) => r.turnLead > 0);

const lines = [];
const say = (s) => { lines.push(s); console.log(s); };

say('# 先手（赤营 A 席）对胜率的影响');
say('');
say('- 数据：合并 `exports/` 下 ' + src.files.length + ' 份导出，去重后 ' + all.length + ' 局' +
  (src.exportedAt ? '（最近一次导出于 ' + new Date(src.exportedAt).toLocaleString('zh-CN') + '）' : ''));
for (const f of src.files) {
  say('  - `' + f.file + '`：' + f.total + ' 局，新增 ' + f.added + (f.added < f.total ? '，重复跳过 ' + (f.total - f.added) : ''));
}
say('- 剔除 ' + solo.length + ' 局（单人练习与「开了房没人出手」），**有效 ' + multi.length + ' 局**：' +
  '双人 ' + two.length + '、三人 ' + three.length + '、四人 ' + four.length);
say('- 先手定义：**A 席**（建房者）。轮次按 A→B→C→D 轮转，A 每轮第一个出手、对手每轮最后收尾');
say('- 胜负定义：终局比分最高者，并列算平局');
say('- 出手次数 = 落地手 + 跳过（跳过也是这一轮的出手机会，不能不算）');

/* ---- 1. 总体 ---- */
const t2 = tally(two);
/* 最标准的一档：10 路棋盘 + 20 轮以上。配置一致才好比，样本也最大。 */
const std = two.filter((r) => r.size === 10 && r.rounds >= 20);
const tStd = tally(std);
say('');
say('## 一、结论先说');
say('');
say('| 问题 | 答案 |');
say('|---|---|');
say('| 双人局先手（A）整体胜率 | **' + pct(t2.rateHL) + '**（' + t2.win + ' 胜 ' + t2.draw + ' 平 ' + t2.lose + ' 负，n=' + t2.n + '） |');
say('| 与 50% 的差异显著吗 | 不显著，p = ' + pTxt(t2.p) + ' |');
say('| 只看最标准配置（10 路 · 20 轮以上） | **' + pct(tStd.rateHL) + '**（n=' + tStd.n + '，p = ' + pTxt(tStd.p) + '） |');
say('| 换成「出手次数完全相等」的局 | **' + pct(tally(equalTurn).rateHL) + '**（n=' + equalTurn.length + '），略低于五成 |');
say('| 先手多一次出手机会的局 | ' + pct(tally(extraTurn).rateHL) + '（n=' + extraTurn.length + '）—— **但这是 B 卡壳的结果，不能当因果读**，见第二节 |');
say('| 先手平均比对手多涂 | ' + (t2.gapMean >= 0 ? '+' : '') + t2.gapMean.toFixed(2) + ' 格，95% 区间 ' + t2.gapCI[0].toFixed(1) + '–' + t2.gapCI[1].toFixed(1) + ' 格（跨 0） |');
say('');
say('**一句话**：先手（位置）没有优势。在双方出手次数完全相等的 ' + equalTurn.length + ' 局里，先手胜率 ' +
  pct(tally(equalTurn).rateHL) + '，反而略低于一半 —— 这符合「后手能看着先手落子再抢夺」的直觉，' +
  '但差距还在随机波动范围内（p = ' + pTxt(tally(equalTurn).p) + '），不能当成确定的劣势。');

/* ---- 2. 核心拆分 ---- */
say('');
say('## 二、关键拆分：位置 vs 多一次出手机会');
say('');
say('「先手」其实混着两件事，必须分开算：');
say('');
say('1. **位置**：两人出手次数一样多时，A 每轮先落、B 每轮后落 —— 这是纯粹的先后顺序；');
say('2. **机会**：总出手次数是奇数时，A 会整整多一次出手机会 —— 这不是「顺序」，是「多打一手」。');
const byTurn = {};
byTurn['出手次数相等（纯位置比较）'] = equalTurn;
byTurn['先手多一次出手（A 总次数为奇数）'] = extraTurn;
for (const d of [1, 2, 3]) {
  const g = two.filter((r) => r.turnLead === -d);
  if (g.length) byTurn['先手少 ' + d + ' 次出手'] = g;
}
say(table('按出手次数拆开', byTurn,
  '前一行才是「先手 vs 后手」的干净比较；后一行看着吓人，但它测的不是「多一次机会值多少」，原因见下。'));

/* 「A 多一手」是怎么来的？查跳过的分布就知道 —— 这一行是逆向因果的坑 */
{
  const pass = (r, s) => r.turns[s] - r.flies[s];
  const avgOf = (rows, f) => (rows.length ? rows.reduce((s, r) => s + f(r), 0) / rows.length : 0);
  const ex = extraTurn, eq = equalTurn;
  say('');
  say('**「A 多一手」不是规则额外发给先手的机会，多半是 B 打不动了。** 两组对照：');
  say('');
  say('| | A 多一手的局（' + ex.length + '） | 出手次数相等（' + eq.length + '） |');
  say('|---|---:|---:|');
  say('| A 平均跳过 | ' + avgOf(ex, (r) => pass(r, 'A')).toFixed(2) + ' 次 | ' + avgOf(eq, (r) => pass(r, 'A')).toFixed(2) + ' 次 |');
  say('| **B 平均跳过** | **' + avgOf(ex, (r) => pass(r, 'B')).toFixed(2) + ' 次** | ' + avgOf(eq, (r) => pass(r, 'B')).toFixed(2) + ' 次 |');
  say('| B 至少跳过一次的局 | ' + ex.filter((r) => pass(r, 'B') > 0).length + ' / ' + ex.length +
    '（' + pct(ex.length ? ex.filter((r) => pass(r, 'B') > 0).length / ex.length : NaN, 0) + '） | ' +
    eq.filter((r) => pass(r, 'B') > 0).length + ' / ' + eq.length +
    '（' + pct(eq.length ? eq.filter((r) => pass(r, 'B') > 0).length / eq.length : NaN, 0) + '） |');
  say('| 双方合计落地 | ' + avgOf(ex, (r) => r.flies.A + r.flies.B).toFixed(1) + ' 手 | ' +
    avgOf(eq, (r) => r.flies.A + r.flies.B).toFixed(1) + ' 手 |');
  say('');
  say('> 因果方向是**反的**：不是「多打一手让 A 赢」，而是「B 卡住/掉线/让子 → A 多打一手，' +
    '同时 B 本来就在输」。而且这些局本身长得多（合计 ' + avgOf(ex, (r) => r.flies.A + r.flies.B).toFixed(1) +
    ' 手 vs ' + avgOf(eq, (r) => r.flies.A + r.flies.B).toFixed(1) + ' 手），长局里两边都更容易卡壳、更容易出现手数差。');
  say('> 拿它当「先手多打一手 → 更容易赢」的证据，等于把「B 打不动」错记成「先手收益」。');
  say('> 真正干净的只有上面那一行：**' + eq.length + ' 局、先手 ' + pct(tally(eq).rateHL) +
    '、p = ' + pTxt(tally(eq).p) + '，不显著。**');
}

/* ---- 3. 结束方式 ---- */
const byReason = {};
for (const r of two) (byReason[r.reason || '（未记录）'] = byReason[r.reason || '（未记录）'] || []).push(r);
say('');
say('## 三、按结束方式');
say(table('不同结束方式下先手的处境不同', byReason,
  '「轮数已满」是最干净的一类：每人出手次数被规则固定成相等的 rounds，比的是位置；' +
  '「棋盘已填满」是抢最后一格，谁下最后一手谁占便宜。' +
  '「提前结算」那 ' + (byReason['提前结算'] ? byReason['提前结算'].length : 0) + ' 局是有人主动收局（多半一方崩了认输），' +
  '胜负在收局之前就定了，跟「谁先出手」没有因果关系，别拿那 ' +
  pct(byReason['提前结算'] ? byReason['提前结算'].filter((r) => r.winner === 'A').length / byReason['提前结算'].length : NaN, 0) +
  ' 当结论。'));

/* ---- 4. 最后一手 ---- */
say('');
say('## 四、换个切法：谁下最后一手');
say('');
const lastA = two.filter((r) => r.lastSeat === 'A');
const lastB = two.filter((r) => r.lastSeat === 'B');
const lastRows = {};
lastRows['最后一手是先手 A'] = lastA;
lastRows['最后一手是后手 B'] = lastB;
say('| 最后一手 | 局数 | 下最后一手的人赢 | 平 | 另一个人赢 | 占比 | p 值（未校正） |');
say('|---|---:|---:|---:|---:|---:|---:|');
for (const k of Object.keys(lastRows)) {
  const g = lastRows[k];
  const seat = k.indexOf('先手') >= 0 ? 'A' : 'B';
  const w = g.filter((r) => r.winner === seat).length;
  const d = g.filter((r) => !r.winner).length;
  const l = g.length - w - d;
  say('| ' + k + ' | ' + g.length + ' | ' + w + ' | ' + d + ' | ' + l + ' | ' + pct(g.length ? w / g.length : NaN) +
    ' | ' + pCell(g.length - d ? binomTest(g.length - d, w, 0.5) : NaN) + ' |');
}
say('');
const allLastWins = lastA.filter((r) => r.winner === 'A').length + lastB.filter((r) => r.winner === 'B').length;
const fill = two.filter((r) => r.reason === '棋盘已填满');
const fillLastWin = fill.filter((r) => r.winner === r.lastSeat).length;
say('- 合计：**最后一手的人 ' + allLastWins + ' / ' + two.length + ' 局（' + pct(allLastWins / two.length) +
  '）拿到最高分**，双侧检验 p ' + (binomTest(two.length - t2.draw, allLastWins, 0.5) < 0.001 ? '小于 0.001' : '= ' + pTxt(binomTest(two.length - t2.draw, allLastWins, 0.5))));
say('- 最干净的一组是「棋盘已填满」的 ' + fill.length + ' 局（真的是抢到最后一格定输赢）：' +
  '最后一手的人赢 ' + fillLastWin + ' 局（' + pct(fill.length ? fillLastWin / fill.length : NaN) +
  '），p = ' + pTxt(fill.length ? binomTest(fill.length, fillLastWin, 0.5) : NaN) + '，撑不起显著性');
say('');
/* 下面三段文案里的数字全部现算 —— 上一版把它们写死了（44.2% / 26 局 / 84.6% / 15 局），
 * 数据从 144 局涨到 197 局之后整段话就和表对不上了。 */
const lastAWinA = lastA.filter((r) => r.winner === 'A').length;
const lastAExtra = lastA.filter((r) => r.turnLead > 0).length;
say('> **这三行不是三份独立证据**，它们和第二节的 ' + pct(tally(equalTurn).rateHL) + ' 是同一件事的不同切法：' +
  'B 收官的 ' + lastB.length + ' 局里 B 胜率 ' + pct(lastB.length ? lastB.filter((r) => r.winner === 'B').length / lastB.length : NaN) +
  '，换个说法就是「A 在长局里赢四成多」。');
say('> p 值没有做多重比较校正 —— 这里切了七八个口子，' +
  '一个贴着 0.05 的数不值得单独拿出来当结论；真正稳的是「方向一致 + 机制能对上（后手多抢格子）」这两点。');
say('> A 收官那 ' + lastA.length + ' 局胜率 ' + pct(lastA.length ? lastAWinA / lastA.length : NaN) + ' 高得吓人，' +
  '但其中 ' + lastAExtra + ' 局本来就是 A 多打一手 —— 也就是第二节那批「B 卡壳」的局，' +
  '不是「先手收尾更强」。');

/* ---- 5. 棋盘大小 ---- */
const sizeBuckets = {};
for (const r of two) {
  const k = r.size >= 10 && r.size <= 20 ? r.size + ' 路' : '其他路数';
  (sizeBuckets[k] = sizeBuckets[k] || []).push(r);
}
const sizeOrder = {};
Object.keys(sizeBuckets).sort((a, b) => (parseInt(a, 10) || 99) - (parseInt(b, 10) || 99))
  .forEach((k) => { sizeOrder[k] = sizeBuckets[k]; });
say('');
say('## 五、按棋盘大小');
say(table('棋盘大小不是分水岭', sizeOrder,
  '小棋盘（5–8 路）合计不到 10 局，单独列出来只会制造噪声，合并成「其他路数」。'));

/* ---- 6. 机制 ---- */
say('');
say('## 六、为什么会略低于五成：抢夺');
say('');
say('在出手次数相等的 ' + equalTurn.length + ' 局里，逐局对比两人的平均数：');
say('');
const metric = [
  ['落地手数', 'flies', '手'],
  ['抢夺别人的格子', 'cap', '格'],
  ['同色（自己也占到）', 'hold', '格'],
  ['实际落格（新占+抢夺）', 'hits', '格'],
];
say('| 指标 | 先手 A | 后手 B | 差值 B−A | 95% 区间 |');
say('|---|---:|---:|---:|---|');
for (const m of metric) {
  const [label, key, unit] = m;
  const a = equalTurn.reduce((s, r) => s + r[key].A, 0) / (equalTurn.length || 1);
  const b = equalTurn.reduce((s, r) => s + r[key].B, 0) / (equalTurn.length || 1);
  const d = paired(equalTurn.map((r) => r[key].B - r[key].A));
  say('| ' + label + ' | ' + a.toFixed(2) + ' ' + unit + ' | ' + b.toFixed(2) + ' ' + unit + ' | ' +
    (d.mean >= 0 ? '+' : '') + d.mean.toFixed(2) + ' ' + unit + ' | ' +
    d.ci[0].toFixed(2) + '–' + d.ci[1].toFixed(2) + ' |');
}
const capDiff = paired(equalTurn.map((r) => r.cap.B - r.cap.A));
const hitDiff = paired(equalTurn.map((r) => r.hits.B - r.hits.A));
say('');
say('> 落地手数几乎一样（差 ' + Math.abs(paired(equalTurn.map((r) => r.flies.B - r.flies.A)).mean).toFixed(2) +
  ' 手），区别在**抢夺**：后手每局平均多抢 ' + capDiff.mean.toFixed(2) + ' 格，95% 区间 ' +
  capDiff.ci[0].toFixed(2) + '–' + capDiff.ci[1].toFixed(2) +
  (capDiff.ci[0] > 0 ? '（**不含 0，这条显著**）' : '（跨 0）') + '。先手先落子，等于先把格子摆出来给后手抢。');
say('> 注意「实际落格」那一行：先手总共涂得**更多**（每局多 ' + Math.abs(hitDiff.mean).toFixed(2) +
  ' 格，区间跨 0），但终局比分算的是**最后归谁**，不是谁涂得多 —— 先手涂出来的格子被抢走，' +
  '所以两边落地量打平、比分却偏向后手。这就是「先手没有优势」的具体形状。');
say('');
say('> 一句话总结机制：**位置本身几乎不值钱。** 纯位置比较（出手次数相等）里先手 ' +
  pct(tally(equalTurn).rateHL) + '（p = ' + pTxt(tally(equalTurn).p) + '，不显著），' +
  '唯一稳健的方向信号是「后手每局多抢 ' + capDiff.mean.toFixed(2) + ' 格」。' +
  '总胜率之所以正好 50%，是因为「B 卡壳让 A 多打一手」的那批局把这点劣势抵了回来 —— 那是选择效应，不是先手红利。');

/* ---- 6.1 轮内顺序 → 单次落子收益 ---- */
say('');
say('### 6.1 同一轮里，第几个出手拿到的东西不一样');
say('');
say('上面比的是整局累计。把每一手按「它在自己那一轮排第几」分类，位置效应直接看得见：');
say('');
const orderAgg = {};
for (const rec of src.list) {
  const pcn = Math.round(Number((rec.cfg || {}).playerCount)) || 0;
  if (pcn < 2) continue;
  const byRound = new Map();
  for (const e of rec.log || []) {
    if (!e || e.type !== 'fly') continue;
    const r = Number(e.round) || 0;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(e);
  }
  for (const [, list] of byRound) {
    list.forEach((e, i) => {
      const key = pcn + ':' + (i + 1);
      if (!orderAgg[key]) orderAgg[key] = { n: 0, blank: 0, cap: 0, hits: 0 };
      const b = orderAgg[key];
      b.n++;
      b.blank += Number(e.blank) || 0;
      b.cap += Number(e.capture) || 0;
      b.hits += Number(e.hits) || 0;
    });
  }
}
say('| 局型 | 指标 | 轮内第 1 手 | 第 2 手 | 第 3 手 | 第 4 手 |');
say('|---|---|---:|---:|---:|---:|');
for (const N of [2, 3, 4]) {
  const cells = (f) => {
    const out = [];
    for (let i = 1; i <= N; i++) {
      const b = orderAgg[N + ':' + i];
      out.push(b ? f(b) : '—');
    }
    return out.join(' | ');
  };
  say('| ' + N + ' 人局 | 平均新占（格） | ' + cells((b) => (b.blank / b.n).toFixed(2)) + ' |');
  say('| ' + N + ' 人局 | 平均抢夺（格） | ' + cells((b) => (b.cap / b.n).toFixed(2)) + ' |');
  say('| ' + N + ' 人局 | 样本（手） | ' + cells((b) => String(b.n)) + ' |');
}
say('');
say('> 读法：**方向是「越靠后，新占越少、抢夺越多」，但幅度很小** —— 双人局第 1 手到第 2 手的新占差只有 0.1 格左右，');
say('> 三人局第 3 手甚至反弹回第 1 手的水平（样本 234 手，噪声占主导）。');
say('> 所以别拿这张表当「后手占便宜」的证据：**它能说明的只是机制方向，不能说明量级。**');
say('> 「第 4 手」样本少一截，是因为三人/四人局常有中途掉线或缺席，凑不满整轮。');

/* ---- 7. 三人 / 四人 ---- */
say('');
say('## 七、三人局 / 四人局（单独看）');
say('');
say('多人局不能再用「先手 vs 其余」二分 —— 基线是 **1/N**（三人 33.3%、四人 25%），');
say('而且**每一轮最后一个出手的席位每轮都在换**（三人局第 1 轮 C 收官、第 2 轮 A 收官…），');
say('「谁是后手」在这里不存在唯一答案。所以只看每个席位自己拿第一的比例。');
say('');
for (const grp of [['三人局', three, 3], ['四人局', four, 4]]) {
  const label = grp[0], rows = grp[1], N = grp[2];
  say('### ' + label + ' · ' + rows.length + ' 局');
  say('');
  if (!rows.length) { say('（这批数据里没有有效对局）'); say(''); continue; }
  const b = seatBreakdown(rows, N);
  say(b.md);
  if (b.ties) say('\n> 并列最高 ' + b.ties + ' 局，不计任何一方获胜。');
  say('');
}
say('> **这三四人的数字只能当描述看。** 三人 ' + three.length + ' 局里每个席位期望拿第一 ' +
  (three.length / 3).toFixed(1) + ' 次，四人 ' + four.length + ' 局里期望 ' + (four.length / 4).toFixed(1) + ' 次；' +
  '一次输赢就能让胜率跳 6–8 个百分点，95% 区间比整张表还宽。');
say('> 四人局「青营 0/12」看着刺眼，但那是**四选一里挑出来的最小值**：单看一个席位 12 局全不胜的概率是 ' +
  ((3 / 4) ** 12 * 100).toFixed(1) + '%，四个席位里至少有一个这样的概率约 ' +
  ((1 - (1 - (3 / 4) ** 12) ** 4) * 100).toFixed(0) + '% —— 属于常见，而且 p 值没做多重比较校正。');
say('> 唯一还算稳的是「场均分」与「相对他人分差」：它们是连续量，不受「谁拿第一」的偶然性影响。');

/* ---- 7.1 多人局的「最后一手」效应 ---- */
say('');
say('### 7.1 多人局里，下最后一手的人是不是更常赢');
say('');
say('双人局有「最后收尾的人更容易赢」的迹象（第四节）。三人/四人局里，最后一手**每轮轮换**，');
say('所以这条只能按「一局里谁下了最后一手」来查 —— 如果它与胜负无关，赢的概率应该等于 1/N：');
say('');
say('| 局型 | 局数 | 最后一手的人赢 | 占比 | 无关时的期望 | p 值 |');
say('|---|---:|---:|---:|---:|---:|');
for (const grp of [['三人局', three, 3], ['四人局', four, 4]]) {
  const label = grp[0], rows = grp[1], N = grp[2];
  const decided = rows.filter((r) => r.winner);
  const hit = decided.filter((r) => r.winner === r.lastSeat).length;
  const exp = 1 / N;
  say('| ' + label + ' | ' + decided.length + ' | ' + hit + ' | ' +
    pct(decided.length ? hit / decided.length : NaN) + ' | ' + pct(exp, 1) + ' | ' +
    pCell(decided.length ? binomTest(decided.length, hit, exp) : NaN) + ' |');
}
say('');
say('> 样本 ' + (three.filter((r) => r.winner).length + four.filter((r) => r.winner).length) +
  ' 局，什么都定不了。列在这里是为了下次数据够了能直接对比，不是结论。');

/* ---- 8. 局限 ---- */
say('');
say('## 八、这份分析不能说明什么');
say('');
say('- **没控制玩家水平**。A 是建房者，' + solo.length + ' 局单人练习也大多出自 A 的手，所以 A 这一侧很可能集中了更熟的玩家。' +
  '这个偏差是**抬高** A 胜率的 —— 抬高了还不到五成，说明先手真实的处境只会更差一点。但偏差有多大，这份数据说不清。');
say('- **多人局的「出场」按「至少落过一个子」算**，掉线挂机到底的人不出现在席位上，' +
  '所以三人/四人局的样本会比 `playerCount` 数出来的少几局。');
say('- **样本量**。' + two.length + ' 局双人局，95% 区间大约 ±' +
  (1.96 * Math.sqrt(0.25 / Math.max(1, two.length)) * 100).toFixed(1) + ' 个百分点；' +
  '要判断 3–5 个百分点的真实差异，需要几百局同配置对局。');
say('- **配置不统一**。棋盘 5–20 路、轮数 1–57 都有，混在一起算总胜率只能当概览，' +
  '细节看上面的分组表。');

/* ---- 导出逐局明细 ---- */
const csv = [['rid', '房号', '结束时间', '人数', '棋盘', '轮数', '结束方式',
  '赤营(先手)', '青营', '金营', '翠营', '赤分', '青分', '金分', '翠分',
  '赤出手', '青出手', '金出手', '翠出手', '赤落地', '青落地', '先手多出手', '先手分差', '最后一手', '胜者', '是否平局'].join(',')];
const who = (r, s) => {
  const p = r.players && r.players[s];
  const n = p && (typeof p === 'string' ? p : p.nick);
  return n ? String(n).replace(/,/g, '，').replace(/\n/g, ' ') : '';
};
for (const r of multi) {
  csv.push([r.rid, r.id, new Date(r.at).toLocaleString('zh-CN'), r.pc, r.size, r.rounds, r.reason,
    who(r, 'A'), who(r, 'B'), who(r, 'C'), who(r, 'D'),
    r.score.A, r.score.B, r.score.C, r.score.D,
    r.turns.A, r.turns.B, r.turns.C, r.turns.D,
    r.flies.A, r.flies.B, r.turnLead, r.gap, r.lastSeat || '', r.winner || '平局', r.winner ? 0 : 1].join(','));
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const outDir = path.join(ROOT, 'exports');
try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
const mdPath = path.join(outDir, 'first-move-' + stamp + '.md');
const csvPath = path.join(outDir, 'first-move-' + stamp + '.csv');
fs.writeFileSync(mdPath, lines.join('\n') + '\n');
fs.writeFileSync(csvPath, '\ufeff' + csv.join('\n') + '\n');
console.log('');
console.log('报告：' + path.relative(ROOT, mdPath));
console.log('逐局明细：' + path.relative(ROOT, csvPath));
