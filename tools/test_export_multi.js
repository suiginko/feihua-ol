'use strict';
/* 导出（战报截图 / 逐手 GIF）的多人模式配色回归。
 *
 * 背景（2026-10-22）：多人模式上线后，export.js 里大量「只认赤 / 青」的硬编码没跟着改，
 * 于是三人局的金营、四人局的翠营在导出图里全都变成了青营的蓝色，比分/图例/记录列也只剩两列：
 *   · drawShotCell / GIF 信息条：`team === "A" ? inkA : inkB` —— 金翠一律蓝
 *   · gifCounts()：只数 A、B，金翠的格子被算进「未涂色」
 *   · 结算侧栏 / 面积条 / 图例 / 记录表 / 胜负条：写死两营
 * 本测试用 jsdom 加载真实 index.html + export.js，把 canvas 换成一个「记录每次绘制」的桩，
 * 直接断言「金营的颜色画在哪儿、青营的蓝色有没有跑到金营的列里」。
 *
 *   node tools/test_export_multi.js   （需要 NODE_PATH 指向带 jsdom 的目录）
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const EXPORT = fs.readFileSync(path.join(ROOT, 'public', 'export.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

/* ---------- 会记账的 2D 上下文桩 ---------- */
function makeCtx() {
  const ops = [];
  let fontPx = 12;
  /* 记录当前路径的包围盒：export.js 的圆角矩形是 moveTo + arcTo 拼的，
     真正落色在 fill()，所以要把路径边界攒下来，fill() 时一起记进 ops。 */
  let path = null;
  const touch = (x, y) => {
    if (!path) path = { x0: x, y0: y, x1: x, y1: y };
    if (x < path.x0) path.x0 = x;
    if (y < path.y0) path.y0 = y;
    if (x > path.x1) path.x1 = x;
    if (y > path.y1) path.y1 = y;
  };
  const ctx = {
    ops,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    scale() {},
    setTransform() {},
    save() {},
    restore() {},
    beginPath() { path = null; },
    closePath() {},
    moveTo(x, y) { touch(x, y); },
    lineTo(x, y) { touch(x, y); },
    arcTo(x1, y1, x2, y2) { touch(x1, y1); touch(x2, y2); },
    clip() {},
    stroke() {},
    strokeRect(x, y, w, h) { ops.push({ op: 'strokeRect', x, y, w, h, fill: ctx.strokeStyle }); },
    arc(x, y, r) { ops.push({ op: 'arc', x, y, r, fill: ctx.fillStyle }); },
    fill() {
      const b = path || { x0: 0, y0: 0, x1: 0, y1: 0 };
      ops.push({ op: 'fill', x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, fill: ctx.fillStyle });
    },
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h, fill: ctx.fillStyle }); },
    fillText(text, x, y) {
      ops.push({ op: 'fillText', text: String(text), x, y, fill: ctx.fillStyle, px: fontPx });
    },
    measureText(text) {
      /* 近似字宽：中文按 1em、西文按 0.56em。只用来定位，够用 */
      let w = 0;
      for (const ch of String(text)) w += (ch.charCodeAt(0) > 127 ? 1 : 0.56) * fontPx;
      return { width: w };
    },
    getImageData() { return { data: new Uint8ClampedArray(4) }; },
  };
  Object.defineProperty(ctx, 'font', {
    get() { return fontPx + 'px sans-serif'; },
    set(v) {
      const m = /(\d+(?:\.\d+)?)px/.exec(String(v));
      if (m) fontPx = parseFloat(m[1]);
    },
  });
  return ctx;
}

let STATE = null;
const STUB = `<script>
  window.fetch = function () { return new Promise(function () {}); };
  window.OL = { state: function () { return window.__STATE; }, tip: function () {} };
  window.__STATE = null;
  HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) this.__ctx = window.__makeCtx();
    return this.__ctx;
  };
</script>`;

function boot() {
  const TAG = '<script src="app.js"></script>';
  const ETAG = '<script src="export.js"></script>';
  let html = HTML;
  if (html.indexOf(ETAG) < 0) throw new Error('index.html 里找不到 ' + ETAG + '，本测试的内联方式需要同步更新');
  /* 去掉 app.js（本测试只关心导出模块），并把 export.js 内联进来 */
  html = html.split(TAG).join('');
  html = html.split(ETAG).join(STUB + '<script>' + EXPORT + '</scr' + 'ipt>');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8787/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  dom.window.__makeCtx = makeCtx;
  return dom;
}

/* ---------- 造状态 ---------- */
function boardString(owners) {
  return owners.map((o) => o || '0').join('');
}

/* 5×5=25 格：赤 5 / 青 6 / 金 9 / 空 5 —— 让金营涂得最多，胜负条必须写「金营获胜」 */
function state3() {
  const owners = [];
  for (let i = 0; i < 25; i++) {
    owners.push(i < 5 ? 'A' : i < 11 ? 'B' : i < 20 ? 'C' : null);
  }
  const chars = '春江潮水连海平海上明月共潮生滟滟随波千万里何处春江无月明';
  const line = (team, round, cells, text, byNick) => ({
    type: 'fly', team, round, line: text, cells,
    hits: cells.length, blank: cells.length, capture: 0, hold: 0,
    source: { title: '春江花月夜', author: '张若虚', dynasty: '唐' },
    byNick,
  });
  return {
    id: 'T3', phase: 'finished', size: 5, endless: false, rounds: 2, round: 2,
    chars: chars.slice(0, 25), board: boardString(owners),
    cfg: { size: 5, playerCount: 3, rounds: 2, turnSeconds: 120, kind: '诗' },
    seats: { A: { nick: '阿赤' }, B: { nick: '阿青' }, C: { nick: '阿金' } },
    score: { a: 5, b: 6, c: 9, d: 0, n: 5 },
    log: [
      line('A', 1, [0, 1, 2], '春江潮水连', '阿赤'),
      line('B', 1, [5, 6, 7], '海上明月共', '阿青'),
      line('C', 1, [11, 12, 13, 14], '滟滟随波千', '阿金'),
      line('A', 2, [3, 4], '海平明月生', '阿赤'),
      line('B', 2, [8, 9, 10], '何处春江无', '阿青'),
      line('C', 2, [15, 16, 17, 18, 19], '潮水连海平', '阿金'),
    ],
    turn: 'C', turnNo: 7, deadline: 0, paused: null, dispute: null, req: null,
    canControl: true, you: 'C', role: 'player', youRef: false, refs: [], members: [],
    events: [], ready: {}, reason: '棋盘已填满', serverNow: Date.now(), canUndo: true,
  };
}

/* 4×4=16 格：四营各占 3~5 格 */
function state4() {
  const owners = [];
  for (let i = 0; i < 16; i++) {
    owners.push(i < 4 ? 'A' : i < 8 ? 'B' : i < 12 ? 'C' : i < 15 ? 'D' : null);
  }
  const chars = '春江潮水连海平海上明月共潮生滟滟随波';
  const line = (team, cells, text, byNick) => ({
    type: 'fly', team, round: 1, line: text, cells,
    hits: cells.length, blank: cells.length, capture: 0, hold: 0,
    source: { title: '春江花月夜', author: '张若虚', dynasty: '唐' }, byNick,
  });
  return {
    id: 'T4', phase: 'playing', size: 4, endless: false, rounds: 3, round: 1,
    chars: chars.slice(0, 16), board: boardString(owners),
    cfg: { size: 4, playerCount: 4, rounds: 3, turnSeconds: 120, kind: '诗' },
    seats: { A: { nick: '赤甲' }, B: { nick: '青乙' }, C: { nick: '金丙' }, D: { nick: '翠丁' } },
    score: { a: 4, b: 4, c: 4, d: 3, n: 1 },
    log: [
      line('A', [0, 1], '春江', '赤甲'),
      line('B', [4, 5], '海上', '青乙'),
      line('C', [8, 9], '明月', '金丙'),
      line('D', [12, 13], '滦滟', '翠丁'),
    ],
    turn: 'A', turnNo: 5, deadline: 0, paused: null, dispute: null, req: null,
    canControl: true, you: 'A', role: 'player', youRef: false, refs: [], members: [],
    events: [], ready: {}, reason: '', serverNow: Date.now(), canUndo: true,
  };
}

/* ---------- 断言小工具 ---------- */
const inRegion = (o, x0, x1, y0) => o.x >= x0 - 2 && o.x <= x1 && o.y >= y0 - 24;
const filled = (ops, color, pred) => ops.filter((o) => o.fill === color && (!pred || pred(o)));

function shotOps(win, st) {
  win.__STATE = st;
  const cv = win.OLEXport.canvas();     /* 内部会 syncVM + buildShotCanvas */
  return { ops: cv.__ctx ? cv.__ctx.ops : [], m: win.OLEXport.__draw.metrics() };
}

function main() {
  const dom = boot();
  const win = dom.window;
  const D = win.OLEXport.__draw;
  const C = D.colors();
  check('导出模块加载成功', !!(win.OLEXport && D), Object.keys(win.OLEXport || {}));
  check('四种墨色互不相同（金/翠没有被并到青）',
    new Set([C.inkA, C.inkB, C.inkC, C.inkD]).size === 4, C);

  /* ---------- 三人局：战报截图 ---------- */
  const st3 = state3();
  const { ops, m } = shotOps(win, st3);
  check('三人局：记录表是 3 列', m.cols === 3, m.cols);
  check('三人局：画了东西', ops.length > 50, ops.length);

  const recTop = m.boardTop + m.BW + m.gap + 30;   /* 与 buildShotCanvas 里的 recTop+30 对齐 */
  const roundW = 60, colGap = 18;
  const colW = (m.W - m.PAD * 2 - roundW - colGap * 3) / 3;
  const xOf = (i) => m.PAD + roundW + i * (colW + colGap);

  /* 1) 表头「金营」必须是金色，而不是青色 */
  const headC = ops.filter((o) => o.op === 'fillText' && o.text === '金营' && o.y < recTop + 40);
  check('三人局：记录表头出现了「金营」', headC.length > 0, headC);
  check('三人局：「金营」表头用的是金色', headC.some((o) => o.fill === C.inkC), headC.map((o) => o.fill));

  /* 2) 金营整列里不能出现青营的蓝 */
  const colC = ops.filter((o) => inRegion(o, xOf(2), xOf(2) + colW, recTop + 40));
  const blueInC = filled(colC, C.inkB);
  check('三人局：金营列里没有青营的蓝色', blueInC.length === 0, blueInC.slice(0, 3));
  check('三人局：金营列里的数字是金色', filled(colC, C.inkC).length > 0, colC.map((o) => o.fill).slice(0, 6));

  /* 3) 青营自己的列仍然用蓝（别修好金营又把青营改坏） */
  const colB = ops.filter((o) => inRegion(o, xOf(1), xOf(1) + colW, recTop + 40));
  check('三人局：青营列仍然是蓝色', filled(colB, C.inkB).length > 0);
  check('三人局：青营列里没有金色', filled(colB, C.inkC).length === 0);

  /* 4) 结算侧栏：金营一行、面积条第三段、图例色块都要有金色 */
  const panelX = m.PAD + m.BW + 24;
  const panelOps = ops.filter((o) => o.x >= panelX - 1);
  const near = (v, want) => Math.abs(v - want) <= 4;
  check('三人局：侧栏有金营的色块（15×15）',
    panelOps.some((o) => o.op === 'fill' && o.fill === C.inkC && near(o.w, 15) && near(o.h, 15)),
    panelOps.filter((o) => o.op === 'fill' && o.fill === C.inkC).slice(0, 4));
  check('三人局：面积条有金营的一段',
    panelOps.some((o) => o.op === 'fillRect' && o.fill === C.inkC && Math.round(o.h) === 14));
  check('三人局：侧栏下方冗余图例（22×22）已移除',
    !panelOps.some((o) => o.op === 'fill' && near(o.w, 22)),
    panelOps.filter((o) => o.op === 'fill' && near(o.w, 22)).map((o) => o.fill));

  /* 5) 胜负条：金营涂得最多，必须写「金营获胜」且用金色 */
  const banner = ops.filter((o) => o.op === 'fillText' && o.text.indexOf('获胜') >= 0);
  check('三人局：胜负条写的是金营获胜', banner.length > 0 && banner[0].text.indexOf('金营获胜') === 0,
    banner.map((o) => o.text));
  check('三人局：胜负条用金色', banner.some((o) => o.fill === C.inkC), banner.map((o) => o.fill));
  check('三人局：比分写了三营的数字', banner.length > 0 && banner[0].text === '金营获胜 ｜ 5 : 6 : 9',
    banner.map((o) => o.text));

  /* ---------- 三人局：GIF 信息条 ---------- */
  const gifOps = [];
  const frames = D.gifHistory();
  const mG = D.gifMetrics();
  const GC = D.gifColors();
  const idxC = frames.findIndex((f) => f.rec && f.rec.team === 'C');
  check('三人局：回放里能找到金营的一手', idxC > 0, idxC);
  if (idxC > 0) {
    const ctx = makeCtx();
    D.gifFrame(ctx, mG, frames[idxC], idxC, frames.length - 1, GC);
    const dot = ctx.ops.filter((o) => o.op === 'arc');
    check('GIF：金营那一手的圆点是金色', dot.some((o) => o.fill === GC.inkC), dot.map((o) => o.fill));
    const head = ctx.ops.filter((o) => o.op === 'fillText' && o.text.indexOf('金营') === 0);
    check('GIF：出手方写的是「金营」', head.length > 0, head.map((o) => o.text));
    check('GIF：出手方文字是金色', head.some((o) => o.fill === GC.inkC), head.map((o) => o.fill));
    check('GIF：信息条里没有把金营画成蓝', !ctx.ops.some((o) => o.op === 'fillText' && o.text.indexOf('金营') === 0 && o.fill === GC.inkB));
    gifOps.push(...ctx.ops);
  }

  /* 比分区（信息条右上）：三营的数字都要画出来，而且各用各的颜色 */
  const scoreOps = gifOps.filter((o) => o.op === 'fillText' && /^\d+$/.test(o.text) &&
    Math.abs(o.y - (mG.stripTop + 27)) < 2);
  const scoreFills = new Set(scoreOps.map((o) => o.fill));
  check('GIF：比分区画出了三营的数字', scoreOps.length >= 3, scoreOps.map((o) => o.text).join(','));
  check('GIF：比分区同时用了赤 / 青 / 金三色',
    scoreFills.has(GC.inkA) && scoreFills.has(GC.inkB) && scoreFills.has(GC.inkC),
    [...scoreFills]);
  /* 用户 2026-10-22 要求：这一行只留数字，「赤 / 青 / 金」字样不要。
     注意不能整行断言「没有营名」——同一基线上出手方那行是「金营（昵称）· 第 3 轮」，
     所以只盯「单独一个营名」的短段（旧版正是画出 '赤 ' / ' 金' 这种）。 */
  const scoreRow = gifOps.filter((o) => o.op === 'fillText' && Math.abs(o.y - (mG.stripTop + 27)) < 2);
  check('GIF：比分区只剩数字与冒号，没有单独成段的营名',
    !scoreRow.some((o) => /^[赤青金翠]$/.test(String(o.text).trim())),
    scoreRow.map((o) => o.text));
  check('GIF：比分区不再出现「赤 6 : 6 青 : 6 金」这种带营名的写法',
    !scoreRow.some((o) => /[赤青金翠]\s*\d/.test(o.text) || /\d\s*[赤青金翠]/.test(o.text)),
    scoreRow.map((o) => o.text));

  /* 结算帧：未涂色只算真正空着的格子 */
  const g = D.gifCounts(['A', 'A', 'B', 'C', 'D', null]);
  check('gifCounts 认得金营', g.c === 1, g);
  check('gifCounts 认得翠营', g.d === 1, g);
  check('gifCounts 的未涂色只数空格', g.n === 1, g);

  /* ---------- 四人局 ---------- */
  const st4 = state4();
  const r4 = shotOps(win, st4);
  check('四人局：记录表是 4 列', r4.m.cols === 4, r4.m.cols);
  const colW4 = (r4.m.W - r4.m.PAD * 2 - 60 - 18 * 4) / 4;
  const x4 = (i) => r4.m.PAD + 60 + i * (colW4 + 18);
  const headD = r4.ops.filter((o) => o.op === 'fillText' && o.text === '翠营');
  check('四人局：记录表头出现了「翠营」', headD.length > 0, headD.map((o) => o.text));
  check('四人局：「翠营」表头用的是翠色', headD.some((o) => o.fill === C.inkD), headD.map((o) => o.fill));
  const recTop4 = r4.m.boardTop + r4.m.BW + r4.m.gap + 30;
  const colD = r4.ops.filter((o) => inRegion(o, x4(3), x4(3) + colW4, recTop4 + 40));
  check('四人局：翠营列里没有青营的蓝色', filled(colD, C.inkB).length === 0, filled(colD, C.inkB).slice(0, 3));
  check('四人局：翠营列里的数字是翠色', filled(colD, C.inkD).length > 0, colD.map((o) => o.fill).slice(0, 6));

  /* ---------- 双人局：不该被改坏 ---------- */
  const st2 = state3();
  st2.cfg.playerCount = 2;
  st2.seats = { A: { nick: '阿赤' }, B: { nick: '阿青' } };
  st2.log = st2.log.filter((e) => e.team !== 'C');
  st2.board = st2.board.split('').map((o) => (o === 'C' ? '0' : o)).join('');
  const r2 = shotOps(win, st2);
  check('双人局：记录表仍是 2 列', r2.m.cols === 2, r2.m.cols);
  const head2 = r2.ops.filter((o) => o.op === 'fillText' && (o.text === '赤营' || o.text === '青营'));
  check('双人局：表头就是赤营 / 青营', head2.length >= 2, head2.map((o) => o.text));
  check('双人局：没有金营翠营混进来',
    !r2.ops.some((o) => o.op === 'fillText' && (o.text === '金营' || o.text === '翠营')),
    r2.ops.filter((o) => o.text === '金营' || o.text === '翠营').slice(0, 3));

  /* ---------- 单人局：只画赤营，不出现青营 ---------- */
  const st1 = state3();
  st1.cfg.playerCount = 1;
  st1.phase = 'finished';
  st1.seats = { A: { nick: '独行' } };
  st1.log = st1.log.filter((e) => e.team === 'A');
  st1.board = st1.board.split('').map((o) => (o === 'B' || o === 'C' ? 'A' : o)).join('');
  const r1 = shotOps(win, st1);
  check('单人局：记录表只有 1 列', r1.m.cols === 1, r1.m.cols);
  check('单人局：没有金营翠营混进来',
    !r1.ops.some((o) => typeof o.text === 'string' && (o.text === '金营' || o.text === '翠营')),
    r1.ops.filter((o) => typeof o.text === 'string').map((o) => o.text).slice(0, 10));
  check('单人局：胜负条写「赤营」而不是「赤营获胜」',
    r1.ops.some((o) => o.op === 'fillText' && typeof o.text === 'string' && o.text.indexOf('赤营 ｜') === 0),
    r1.ops.filter((o) => o.op === 'fillText' && typeof o.text === 'string' && o.text.indexOf('赤营') === 0).map((o) => o.text));

  console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
  try { win.close(); } catch (_) {}
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
}

try {
  main();
} catch (e) {
  console.error('ERR', e);
  process.exit(1);
}
