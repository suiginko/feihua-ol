'use strict';
/* 审阅页 · 多人存档回归（服务端 + jsdom）
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules node tools/test_admin_multi.js
 *
 * 修的是 2026-10-22 报上来的 bug：四人局打完，审阅页「飞花记录」里金营翠营的每一手都标成「青」，
 * 「双方」「比分」也只显示两家。
 *
 * 问题有两层，所以两边都要测：
 *   1) 服务端 archiveGame() 只写了 players.A / players.B —— 金营翠营的昵称在**落盘那一刻**就丢了，
 *      前端再怎么改也补不回来；
 *   2) admin.html 写的是 `team === 'A' ? '赤' : '青'` —— 就算数据是全的，也会显示成青营。
 *
 * 两个反向验证也一起做：
 *   - 老存档（没有 cfg.playerCount、只有 A/B）必须仍然按双人局显示，不能被「四人」撑出空营地；
 *   - 认不出席位（team 缺失）必须显示「未知」，绝不能默认成青营。
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
    console.log('FAIL ' + name + (extra === undefined ? ''
      : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

/* ================= 1. 服务端：四人局存档必须存全 A–D ================= */

let PORT = 0;
let BASE = '';
let dataDir = '';
let child = null;

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
      const r = await fetch(BASE + '/api/rooms');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(80);
  }
  return false;
}

async function boot() {
  dataDir = tmpDir('admin-multi');
  for (let p = 8821; p < 8900; p++) {
    if (await portFree(p)) { PORT = p; break; }
  }
  if (!PORT) throw new Error('找不到空端口');
  BASE = 'http://127.0.0.1:' + PORT;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (c) => {
    const s = c.toString();
    if (!s.includes('[snap]') && !s.includes('ExperimentalWarning')) process.stderr.write(s);
  });
  if (!(await waitUp(15000))) throw new Error('服务启动超时');
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function get(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function peekState(roomId, token) {
  const r = await get('/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return r.data.state || null;
}

const KEY = fs.readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim();

async function serverPart() {
  await boot();

  /* 四人房：A 是房主，再拉三个人坐下。 */
  const r = await post('/api/create', { nick: '赤方主', playerCount: 4, size: 7, rounds: 2 });
  check('四人房创建成功', r.data.ok === true, JSON.stringify(r.data).slice(0, 120));
  const roomId = r.data.roomId;
  const toks = { A: r.data.token };

  for (const [seat, nick] of [['B', '青方客'], ['C', '金方客'], ['D', '翠方客']]) {
    const j = await post('/api/join', { roomId, nick });
    check('第 ' + seat + ' 位坐进 ' + seat + ' 席', j.data.seat === seat, j.data.seat);
    toks[seat] = j.data.token;
  }

  for (const s of ['A', 'B', 'C', 'D']) {
    await post('/api/room/' + roomId + '/ready', { t: toks[s], ready: true });
  }
  const st0 = await peekState(roomId, toks.A);
  check('四人全部准备后开局', st0 && st0.phase === 'playing', st0 && st0.phase);

  /* 一路「放弃」把轮数耗完：不碰语料，也能让 log 里出现 A/B/C/D 四个席位。
     （放弃同样进 log，团队标记就是当时的出手席位） */
  let ended = false;
  for (let i = 0; i < 130; i++) {
    const st = await peekState(roomId, toks.A);
    if (!st) break;
    if (st.phase === 'finished') { ended = true; break; }
    if (st.phase !== 'playing') break;
    const t = toks[st.turn];
    if (!t) break;
    await post('/api/room/' + roomId + '/pass', { t });
  }
  check('轮数耗完后对局结束', ended, ended ? '' : '未在预期步数内结束');

  const rec = await get('/api/records?key=' + encodeURIComponent(KEY) + '&id=' + roomId);
  const x = rec.data && rec.data.record;
  check('能取到这一局的存档', !!x, JSON.stringify(rec.data).slice(0, 120));
  if (!x) return;

  /* 核心断言：四个营地的昵称一个都不能少。改之前这里 C/D 是 undefined。 */
  check('存档里有 A 席昵称', x.players && x.players.A && x.players.A.nick === '赤方主', x.players && x.players.A);
  check('存档里有 B 席昵称', x.players && x.players.B && x.players.B.nick === '青方客', x.players && x.players.B);
  check('存档里有 C 席昵称（金营）', x.players && x.players.C && x.players.C.nick === '金方客', x.players && x.players.C);
  check('存档里有 D 席昵称（翠营）', x.players && x.players.D && x.players.D.nick === '翠方客', x.players && x.players.D);
  check('C 席带 mid', !!(x.players && x.players.C && x.players.C.mid), x.players && x.players.C);

  const sc = x.score || {};
  check('比分有 a/b/c/d 四个字段',
    ['a', 'b', 'c', 'd', 'n'].every((k) => typeof sc[k] === 'number'), sc);

  const teams = {};
  for (const e of (x.log || [])) teams[String(e.team || '').toUpperCase()] = (teams[String(e.team || '').toUpperCase()] || 0) + 1;
  check('日志里出现 C 席（金营）的记录', (teams.C || 0) > 0, JSON.stringify(teams));
  check('日志里出现 D 席（翠营）的记录', (teams.D || 0) > 0, JSON.stringify(teams));

  /* 房间快照接口也要带全：审阅页「房间快照」那一栏靠它。 */
  const sd = await get('/api/snapshot?key=' + encodeURIComponent(KEY));
  check('快照接口可用', sd.data && sd.data.ok === true);
}

/* ================= 2. 前端：jsdom 加载真实的 admin.html ================= */

const ADMIN_HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');

function mkRec(over) {
  return Object.assign({
    id: '042', rid: '042@1', at: Date.now(), createdAt: Date.now() - 600000,
    reason: '轮数已满',
    cfg: {
      size: 10, extra: 0, rounds: 20, endless: false, playerCount: 4,
      kinds: { 诗: true, 词: true, 曲: true, 赋: true, 文: true }, turnSeconds: 60,
    },
    players: {
      A: { nick: '赤选手', mid: 'mA' }, B: { nick: '青选手', mid: 'mB' },
      C: { nick: '金选手', mid: 'mC' }, D: { nick: '翠选手', mid: 'mD' },
    },
    score: { a: 11, b: 22, c: 33, d: 44, n: 5 },
    turns: 5,
    log: [
      { type: 'fly', team: 'A', round: 1, line: '甲句', hits: 3, blank: 2, capture: 1, hold: 0 },
      { type: 'fly', team: 'B', round: 1, line: '乙句', hits: 3, blank: 2, capture: 1, hold: 0 },
      { type: 'fly', team: 'C', round: 1, line: '丙句', hits: 3, blank: 2, capture: 1, hold: 0 },
      { type: 'fly', team: 'D', round: 1, line: '丁句', hits: 3, blank: 2, capture: 1, hold: 0 },
      { type: 'pass', team: 'C', round: 2, why: '主动放弃' },
      { type: 'fly', team: '', round: 2, line: '认不出席位的句' },
    ],
    events: [],
  }, over || {});
}

async function bootAdmin(records) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(ADMIN_HTML, {
    url: 'http://127.0.0.1:8787/admin?key=' + encodeURIComponent(KEY),
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(w) {
      /* 真实页面一进来就 loadRecords()，所以 fetch 必须在这里就位。
         顺带把 scrollIntoView 补上 —— jsdom 没实现它，不补的话
         showDetail 末尾那一行会抛异常，被它自己的 catch 吞成「读取失败」。 */
      w.Element.prototype.scrollIntoView = function () {};
      w.fetch = async function (u) {
        const url = String(u);
        if (url.indexOf('/api/records?') === 0) {
          const m = /[?&]rid=([^&]+)/.exec(url);
          if (m) {
            const rid = decodeURIComponent(m[1]);
            const rec = records.find((x) => x.rid === rid) || records[0];
            return { ok: true, json: async () => ({ ok: true, record: rec }) };
          }
          return { ok: true, json: async () => ({ ok: true, list: records, max: 300 }) };
        }
        return { ok: true, json: async () => ({ ok: true }) };
      };
    },
  });
  await sleep(60);
  return dom;
}

function texts(w, sel) {
  return Array.prototype.map.call(w.document.querySelectorAll(sel), (el) => el.textContent.trim());
}

async function uiPart() {
  /* ---- 四人局 ---- */
  const rec4 = mkRec();
  const dom4 = await bootAdmin([rec4]);
  const w4 = dom4.window;

  const listHtml = w4.document.getElementById('recList').innerHTML;
  check('列表里出现金营', /金营/.test(listHtml), listHtml.slice(0, 200));
  check('列表里出现翠营', /翠营/.test(listHtml), listHtml.slice(0, 200));
  check('列表里有金营选手昵称', /金选手/.test(listHtml));
  check('列表里有翠营选手昵称', /翠选手/.test(listHtml));
  check('四人局比分按席位顺序列出（不再只有 a : b）',
    /11 · 22 · 33 · 44/.test(listHtml), listHtml.match(/<td class="mono"[^>]*>[^<]*<\/td>/g));
  check('比分列的 title 写明是哪个营地',
    /title="赤营 11 · 青营 22 · 金营 33 · 翠营 44"/.test(listHtml), listHtml.match(/title="[^"]*"/g));
  check('四人局的「双方」用 · 串联而不是 vs', !/vs/.test(listHtml), listHtml.match(/<td>[^<]*<span class="si">/g));

  /* 点「详情」，看飞花记录的营地标签 */
  const btn = w4.document.querySelector('button[data-rid]');
  check('列表里有「详情」按钮', !!btn);
  if (btn) {
    btn.dispatchEvent(new w4.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    const det = w4.document.getElementById('detail');
    const pills = texts(w4, '#detail .logline .pill');

    check('详情渲染出来了', /飞花记录/.test(det.innerHTML), det.innerHTML.slice(0, 120));
    check('飞花记录的营地标签依次是 赤/青/金/翠/金/未知',
      pills.length === 6 && pills[0] === '赤' && pills[1] === '青' && pills[2] === '金' &&
      pills[3] === '翠' && pills[4] === '金' && pills[5] === '未知',
      JSON.stringify(pills));
    /* 反向验证：C 席那一手绝不能显示成青营。改回 `team === 'A' ? '赤' : '青'` 时这条会红。 */
    check('金营那一手没有被记成青营', pills[2] !== '青' && pills[4] !== '青', JSON.stringify(pills));
    check('认不出席位时显示「未知」而不是冒充青营', pills[5] === '未知', JSON.stringify(pills));

    check('详情比分写明四个营地',
      /赤 11 · 青 22 · 金 33 · 翠 44 · 未涂色 5/.test(det.innerHTML),
      det.innerHTML.match(/赤 11[^<]*/));
    check('详情「双方」列全四个人', /赤选手[\s\S]*青选手[\s\S]*金选手[\s\S]*翠选手/.test(det.innerHTML));
  }

  /* ---- 老存档（只有 A/B，没有 playerCount）：必须还是双人局的样子 ---- */
  const rec2 = mkRec({
    id: '007', rid: '007@1', players: { A: { nick: '老赤' }, B: { nick: '老青' } },
    score: { a: 47, b: 50, c: 0, d: 0, n: 0 },
    cfg: { size: 10, extra: 0, rounds: 20, endless: false, kinds: { 诗: true }, turnSeconds: 120 },
    log: [{ type: 'fly', team: 'A', round: 1, line: '老句', hits: 1, blank: 1, capture: 0, hold: 0 }],
  });
  delete rec2.cfg.playerCount;
  const dom2 = await bootAdmin([rec2]);
  const w2 = dom2.window;
  const h2 = w2.document.getElementById('recList').innerHTML;
  check('老存档按双人局显示（47 : 50）', /47 : 50/.test(h2), h2.replace(/<[^>]+>/g, ' ').slice(0, 200));
  check('老存档不会被撑出金营/翠营', !/金营|翠营/.test(h2));
  check('老存档的双方仍然是「vs」', /vs/.test(h2));

  const btn2 = w2.document.querySelector('button[data-rid]');
  if (btn2) {
    btn2.dispatchEvent(new w2.MouseEvent('click', { bubbles: true }));
    await sleep(60);
    const d2 = w2.document.getElementById('detail').innerHTML;
    check('老存档详情比分保持「赤 47 : 50 青」写法', /赤 47 : 50 青 · 未涂色 0/.test(d2), d2.match(/赤 47[^<]*/));
  }
}

/* ================= 跑 ================= */

(async () => {
  try {
    await serverPart();
    await uiPart();
  } catch (e) {
    fail++;
    console.log('FAIL 测试自身异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    if (child) { try { child.kill(); } catch (_) {} }
  }
  console.log('');
  console.log('通过 ' + pass + ' / ' + (pass + fail) + (fail ? '　（有 ' + fail + ' 条失败）' : ''));
  process.exitCode = fail ? 1 : 0;
})();
