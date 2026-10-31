'use strict';
/* 存档阵营回填 —— 回归测试。
 *
 *   node tools/test_record_fix.js
 *
 * 被测的东西：**旧存档里丢掉的金营/翠营能被补回来，而且补不错、补多了也不改。**
 *
 * 背景：2026-10-22 之前 archiveGame() 只写 A/B 两个席位，多人局的金营翠营昵称
 * 在落盘那一刻就没了；审阅页的渲染（只认 A 和「青」）已于 6eb50c4 修好，
 * 但那几行**数据**确实是空的，只能按存档里的痕迹回填。
 *
 * 这里同时验收两件事：
 *   ① 纯函数 recordfix.js —— 该补的补、不该动的绝不动、跑两遍结果一样（幂等）；
 *   ② 接口 POST /api/records/repair —— 默认只算不写，apply=1 才落盘并留 .bak。
 *
 * 重点在「不误伤」：255 局里有 109 单人局、137 双人局，回填一旦认错席位，
 * 表现是「双人局的比分栏里突然多出个金营」，比原来的 bug 更显眼。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const fix = require(path.join(ROOT, 'recordfix.js'));
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

/* ---------------- 造存档 ---------------- */

function flyLog(team, nick, hits) {
  return {
    type: 'fly', team: team, round: 1, raw: 'x', norm: 'x', line: 'x',
    hits: hits || 3, blank: hits || 3, capture: 0, hold: 0,
    cells: [1, 2, 3], hitChars: {}, source: { title: 't', author: 'a' },
    via: 'exact', ruler: null, byNick: nick,
  };
}
function flyEv(seat, mid, nick) {
  return { at: 1, type: 'fly', text: nick + ' 飞出「x」', seat: seat, mid: mid };
}
function passLog(team) { return { type: 'pass', team: team, round: 1 }; }

function rec(opts) {
  const log = opts.log || [];
  const events = opts.events || [];
  return {
    id: opts.id || 'AAA11',
    at: opts.at || 1792670000000,
    createdAt: (opts.at || 1792670000000) - 600000,
    reason: opts.reason || '棋盘已填满',
    cfg: Object.assign({ size: 10, rounds: 20, playerCount: opts.playerCount || 2 }, opts.cfg || {}),
    players: opts.players || {},
    score: opts.score || { a: 10, b: 8, c: 0, d: 0, n: 0 },
    turns: log.filter((e) => e.type === 'fly').length,
    log: log,
    events: events,
  };
}

/* ---------------- 第一部分：纯函数 ---------------- */

console.log('--- recordfix.js ---');

/* 四人局：存档只有 A/B，C/D 全靠回填 */
const four = rec({
  playerCount: 4,
  players: { A: { nick: '丈育', mid: 'mA' }, B: { nick: 'CHW', mid: 'mB' } },
  log: [flyLog('A', '丈育'), flyLog('B', 'CHW'), flyLog('C', 'UTM'), flyLog('D', 'GUA'),
    flyLog('A', '丈育'), flyLog('B', 'CHW'), flyLog('C', 'UTM'), flyLog('D', 'GUA')],
  events: [flyEv('A', 'mA', '丈育'), flyEv('B', 'mB', 'CHW'), flyEv('C', 'mC', 'UTM'), flyEv('D', 'mD', 'GUA'),
    flyEv('A', 'mA', '丈育'), flyEv('B', 'mB', 'CHW'), flyEv('C', 'mC', 'UTM'), flyEv('D', 'mD', 'GUA')],
});
const r1 = fix.repairRecord(four);
check('四人局：C 补回昵称', r1.players.C && r1.players.C.nick === 'UTM', r1.players);
check('四人局：C 补回编号', r1.players.C && r1.players.C.mid === 'mC', r1.players);
check('四人局：D 补回昵称', r1.players.D && r1.players.D.nick === 'GUA', r1.players);
check('四人局：D 补回编号', r1.players.D && r1.players.D.mid === 'mD', r1.players);
check('四人局：A/B 原样不动', r1.players.A.mid === 'mA' && r1.players.B.nick === 'CHW', r1.players);
check('四人局：报告里说明了依据', r1.patches.some((p) => p.seat === 'C' && /最后一手/.test(p.why)), r1.patches);

/* 幂等：修完的再修一次，必须一条都不改 */
const again = fix.repairRecord(Object.assign({}, four, { players: r1.players }));
check('幂等：修过的记录再修 = 无改动', again.changed === false && again.patches.length === 0, again.patches);
check('幂等：修过的记录再修 = 不报冲突', again.conflicts.length === 0, again.conflicts);

/* 三人局：只该补 C，绝不能凭空造出 D */
const three = rec({
  id: 'BBB22',
  at: 1792670500000,
  playerCount: 3,
  players: { A: { nick: '咪咪', mid: 'mA' }, B: { nick: '太阳', mid: 'mB' } },
  log: [flyLog('A', '咪咪'), flyLog('B', '太阳'), flyLog('C', '雪糕')],
  events: [flyEv('A', 'mA', '咪咪'), flyEv('B', 'mB', '太阳'), flyEv('C', 'mC', '雪糕')],
});
const r3 = fix.repairRecord(three);
check('三人局：C 补回', r3.players.C && r3.players.C.nick === '雪糕', r3.players);
check('三人局：不凭空造出 D', !('D' in r3.players), r3.players);
check('三人局：只改 1 个席位', r3.patches.filter((p) => p.field === '*').length === 1, r3.patches);

/* 双人局：一个字段都不许动（137 局里最大的一类，误伤最显眼） */
const two = rec({
  playerCount: 2,
  players: { A: { nick: '甲', mid: 'mA' }, B: { nick: '乙', mid: 'mB' } },
  log: [flyLog('A', '甲'), flyLog('B', '乙')],
  events: [flyEv('A', 'mA', '甲'), flyEv('B', 'mB', '乙')],
});
const r2 = fix.repairRecord(two);
check('双人局：无改动', r2.changed === false, r2.patches);
check('双人局：players 不变', JSON.stringify(r2.players) === JSON.stringify(two.players), r2.players);

/* 老存档没写 playerCount：靠「log 里真的出现过几号席位」判断，仍然是双人局 */
const old = rec({
  players: { A: { nick: '甲', mid: 'mA' }, B: { nick: '乙', mid: 'mB' } },
  log: [flyLog('A', '甲'), flyLog('B', '乙')],
  events: [flyEv('A', 'mA', '甲'), flyEv('B', 'mB', '乙')],
});
old.cfg = { size: 10, rounds: 20 };   /* 确实没有 playerCount */
const ro = fix.repairRecord(old);
check('无 playerCount 的双人局：无改动', ro.changed === false, ro.patches);

/* 已有昵称但与最后一手不一致：不动，只报冲突（可能是改名，也可能是换人坐） */
const conflict = rec({
  playerCount: 3,
  players: { A: { nick: '甲', mid: 'mA' }, B: { nick: '乙', mid: 'mB' }, C: { nick: '别名', mid: 'mC2' } },
  log: [flyLog('A', '甲'), flyLog('B', '乙'), flyLog('C', '雪糕')],
  events: [flyEv('A', 'mA', '甲'), flyEv('B', 'mB', '乙'), flyEv('C', 'mC', '雪糕')],
});
const rc = fix.repairRecord(conflict);
check('已有昵称不被覆盖', rc.players.C.nick === '别名', rc.players.C);
check('昵称不一致记进 conflicts', rc.conflicts.some((c) => c.seat === 'C' && c.kept === '别名' && c.seen === '雪糕'), rc.conflicts);
check('已有昵称/编号时不算改动', rc.changed === false, rc.patches);

/* 事件比 log 少（老存档没记 fly 事件）：昵称照补，编号不能瞎配 */
const partial = rec({
  playerCount: 3,
  players: { A: { nick: '甲', mid: 'mA' }, B: { nick: '乙', mid: 'mB' } },
  log: [flyLog('A', '甲'), flyLog('B', '乙'), flyLog('C', '姚揆')],
  events: [flyEv('A', 'mA', '甲'), flyEv('B', 'mB', '乙')],   /* 缺 C 那一手 */
});
const rp = fix.repairRecord(partial);
check('事件不全：昵称仍补回', rp.players.C && rp.players.C.nick === '姚揆', rp.players);
check('事件不全：没有证据就不编编号', rp.players.C && rp.players.C.mid === '', rp.players);

/* 顺序错位（log 的 C 那一手对上了 events 的 D 那一手）：只能信昵称，编号不能张冠李戴 */
const skew = rec({
  playerCount: 4,
  players: { A: { nick: '甲', mid: 'mA' }, B: { nick: '乙', mid: 'mB' } },
  log: [flyLog('A', '甲'), flyLog('B', '乙'), flyLog('C', '丙'), flyLog('D', '丁')],
  events: [flyEv('A', 'mA', '甲'), flyEv('B', 'mB', '乙'), flyEv('D', 'mD', '丁')],   /* 少了 C，整体前移 */
});
const rs = fix.repairRecord(skew);
check('错位：C 昵称仍按 log 补', rs.players.C && rs.players.C.nick === '丙', rs.players);
check('错位：C 不会拿到 D 的编号', rs.players.C && rs.players.C.mid !== 'mD', rs.players.C);

/* 席位中途换人：取最后一手的人，与比分记在谁头上一致 */
const swap = rec({
  playerCount: 2,
  players: {},
  log: [flyLog('A', '先来'), flyLog('B', '乙'), flyLog('A', '后到')],
  events: [flyEv('A', 'mOld', '先来'), flyEv('B', 'mB', '乙'), flyEv('A', 'mNew', '后到')],
});
const rw = fix.repairRecord(swap);
check('换人：A 记最后一手的人', rw.players.A && rw.players.A.nick === '后到', rw.players.A);
check('换人：A 的编号同样是最后那位', rw.players.A && rw.players.A.mid === 'mNew', rw.players.A);

/* ---------------- 第二部分：整份 JSONL ---------------- */

console.log('--- repairText ---');
const good = JSON.stringify(two);
const bad = JSON.stringify(three);
const text = bad + '\n' + '\n' + 'not-json\n' + good + '\n';
const rt = fix.repairText(text);
check('坏行原样保留', rt.text.split('\n').includes('not-json'), rt.text.split('\n'));
check('空行原样保留', rt.text.split('\n').length === text.split('\n').length, rt.text.split('\n').length);
check('只有该修的那行被改', rt.fixed === 1, rt.fixed);
check('报告能定位到行号', rt.report.length === 1 && rt.report[0].line === 1, rt.report);
check('修完的内容能解析', (() => {
  try { const o = JSON.parse(rt.text.split('\n')[0]); return o.players.C.nick === '雪糕'; } catch (_) { return false; }
})());

/* 已经修过的整份文件再修一次 = 一个字节都不变 */
const rt2 = fix.repairText(rt.text);
check('整份文件幂等', rt2.fixed === 0 && rt2.text === rt.text, rt2.fixed);

/* ---------------- 第三部分：接口 ---------------- */

console.log('--- POST /api/records/repair ---');

const KEY = 'fix-key-456';
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
async function post(p) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d: d };
}

(async () => {
  try {
    for (let p = 8940; p <= 8960; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    dataDir = tmpDir('test-record-fix-' + PORT);
    BASE = 'http://127.0.0.1:' + PORT;

    const file = path.join(dataDir, 'records.jsonl');
    const rolled = path.join(dataDir, 'records.1.jsonl');
    const seeded = bad + '\n' + good + '\n';
    fs.writeFileSync(file, seeded);
    /* 滚动过的那一份里也放一条坏记录：回填要一起处理，不然「上个月的存档」永远错着 */
    fs.writeFileSync(rolled, JSON.stringify(three) + '\n');

    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: KEY, SWEEP_MS: '300' }),
      stdio: 'ignore',
    });
    if (!(await waitUp(30000))) throw new Error('实例没起来');
    await sleep(200);

    const wrong = await post('/api/records/repair?key=nope');
    check('口令不对 → 403', wrong.status === 403, wrong);

    const before = fs.readFileSync(file, 'utf8');
    const dry = await post('/api/records/repair?key=' + KEY);
    const dryMain = (dry.d.files || []).find((f) => f.file === 'records.jsonl') || {};
    check('预演：主档报告出 1 局', dry.d.ok === true && dryMain.fixed === 1, dryMain.fixed);
    check('预演：dry=true', dry.d.dry === true, dry.d.dry);
    check('预演：文件一个字节都没动', fs.readFileSync(file, 'utf8') === before, '文件被改了');
    check('预演：给了怎么真正写回的提示', /apply=1/.test(dry.d.hint || ''), dry.d.hint);
    check('预演：报告里能看到改成什么', JSON.stringify(dry.d.files[0].report).includes('雪糕'), dry.d.files[0].report);

    const app = await post('/api/records/repair?key=' + KEY + '&apply=1');
    check('写回：两处文件都被处理', app.d.fixed === 2, app.d.fixed);
    check('写回：records.jsonl 已写入', app.d.files.some((f) => f.file === 'records.jsonl' && f.written), app.d.files.map((f) => f.file + ':' + f.written));
    check('写回：滚动那份也写了', app.d.files.some((f) => f.file === 'records.1.jsonl' && f.written), app.d.files.map((f) => f.file));

    const after = fs.readFileSync(file, 'utf8');
    check('写回：金营落在盘上', after.includes('雪糕'), after.slice(0, 120));
    check('写回：双人局那行没被动过', after.includes(good), '双人局被改了');
    check('写回：留了备份', fs.existsSync(file + '.bak'), fs.readdirSync(dataDir));
    check('写回：备份是改之前的内容', fs.existsSync(file + '.bak') && fs.readFileSync(file + '.bak', 'utf8') === before, '备份内容不符');
    check('写回：不留下 .tmp', !fs.existsSync(file + '.tmp'), fs.readdirSync(dataDir));

    const again2 = await post('/api/records/repair?key=' + KEY + '&apply=1');
    check('再写一次：没有可改的了', again2.d.fixed === 0, again2.d.fixed);

    /* 审阅页读到的必须是修好的那份 */
    const list = await fetch(BASE + '/api/records?key=' + KEY, { cache: 'no-store' });
    const ld = await list.json();
    const hit = (ld.list || []).find((x) => x.id === 'BBB22' && x.at === three.at);
    check('审阅列表：金营昵称已经能看到', hit && hit.players && hit.players.C && hit.players.C.nick === '雪糕', hit && hit.players);
  } catch (e) {
    fail++;
    console.log('FAIL 测试过程抛错：' + (e && e.stack ? e.stack : e));
  } finally {
    killChild();
    await sleep(200);
  }

  console.log('');
  console.log(pass + ' 通过 / ' + fail + ' 失败');
  process.exitCode = fail ? 1 : 0;
})();
