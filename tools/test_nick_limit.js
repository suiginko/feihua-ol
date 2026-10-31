'use strict';
/* 自定义昵称 24 小时只能改一次 —— 回归测试。
 *
 *   node tools/test_nick_limit.js
 *
 * 需求原话：
 *   「每个用户 24 小时内只能修改一次自定义昵称（从自定义改成自定义或者从随机改成自定义
 *     都会触发此限制），使用自定义时会收到提醒，但使用随机诗人昵称不会被限制。」
 *
 * 这里最要紧的是几条**边界**，写错任何一条都会让限制失效或者误伤：
 *   · 「随机」是客户端自称的 → 服务端必须核对名字真在诗人池里，否则标个 random 就能绕过；
 *   · 额度按**人**算、跨房间 → token / mid 换房间就变，只能靠前端持久 uid；
 *   · 拿不到 uid 的旧页面退回 IP，不能让限制形同虚设；
 *   · 名字没变（unchanged）不该消耗额度 —— 玩家点两下保存不该被锁一天；
 *   · 记账必须落盘，容器重启（= 每次发布）不能把人一键「赦免」；
 *   · 冷却中被拒绝时昵称保持原样，额度也不变 —— 不能「拒了还记账」。
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
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : -1);
const uidOf = (ch) => 'u' + String(ch).repeat(32);

/* 起一个实例。gapMs 传短值才能在同一次测试里跑到「冷却过期」那一支。 */
async function boot(port0, dir, gapMs) {
  /* 用局部变量找端口：PORT 是全局的，第二次 boot 若拿旧值判断，会误以为「已经找到了」 */
  let port = 0;
  for (let p = port0; p <= port0 + 30; p++) { if (await portFree(p)) { port = p; break; } }
  if (!port) throw new Error('找不到空闲端口');
  PORT = port;
  BASE = 'http://127.0.0.1:' + PORT;
  dataDir = dir;
  const env = Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, SWEEP_MS: '300' });
  if (gapMs) env.NICK_GAP_MS = String(gapMs);
  else delete env.NICK_GAP_MS;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  if (!(await waitUp(40000))) throw new Error('实例没起来');
  await sleep(150);
}

(async () => {
  const dir1 = tmpDir('test-nick-limit-a');
  const dir2 = tmpDir('test-nick-limit-b');
  try {
    /* ================= 阶段一：机制（冷却缩到 1.5 秒，跑得到过期） ================= */
    console.log('--- 阶段一：冷却期内拒绝、随机放行、过期恢复 ---');
    const GAP = 1500;
    await boot(8996, dir1, GAP);

    const uidA = uidOf('a');
    const cr = await post('/api/create', { nick: '甲先生', size: 7, extra: 0, playerCount: 2 });
    const roomA = cr.d.roomId, tA = cr.d.token;
    check('建房成功', cr.d.ok === true && !!roomA, cr.d);
    check('建房时取的昵称生效', cr.d.state.youNick === '甲先生', cr.d.state.youNick);

    /* 建房取名不是「修改昵称」：玩家第一次给自己起名字不该被锁 */
    let st = await get('/api/nick-status?uid=' + uidA);
    check('建房取名不消耗额度', st.d.ok === true && st.d.canRename === true, st.d);

    /* --- 改成同名：不该消耗 --- */
    let r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '甲先生', uid: uidA });
    check('改成同名返回 unchanged', r.d.ok === true && r.d.unchanged === true, r.d);
    st = await get('/api/nick-status?uid=' + uidA);
    check('改成同名不消耗额度', st.d.canRename === true, st.d);

    /* --- 第一次自定义改名：成功，并记下 24 小时（这里按 GAP 缩短） --- */
    const t0 = Date.now();
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '乙先生', uid: uidA });
    check('第一次自定义改名成功', r.d.ok === true && r.d.nick === '乙先生', r.d);
    check('自定义改名不是 random（要占额度）', r.d.random === false, r.d);
    check('返回了 retryAt（前端拿它显示几点能再改）',
      num(r.d.retryAt) > 0 && Math.abs(r.d.retryAt - (t0 + GAP)) < 1200, { retryAt: r.d.retryAt, gap: GAP });
    check('返回了 gapMs 供前端说人话', num(r.d.gapMs) === GAP, r.d.gapMs);

    st = await get('/api/nick-status?uid=' + uidA);
    check('改完之后额度用掉', st.d.canRename === false, st.d);
    check('status 里能看到上次用的名字', st.d.lastNick === '乙先生', st.d.lastNick);
    check('status 的剩余时间在 0 与 GAP 之间',
      num(st.d.waitMs) > 0 && num(st.d.waitMs) <= GAP, st.d.waitMs);

    /* --- 冷却期内再改自定义：拒绝，且昵称与额度都不动 --- */
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '丙先生', uid: uidA });
    check('冷却期内再改自定义被拒', r.d.ok === false && r.d.code === 'cooldown', r.d);
    check('拒绝文案说清楚「24 小时只能改一次」',
      typeof r.d.reason === 'string' && r.d.reason.indexOf('24 小时只能改一次') >= 0, r.d.reason);
    check('拒绝文案给出还要等多久', typeof r.d.reason === 'string' && r.d.reason.indexOf('还要等') >= 0, r.d.reason);
    check('拒绝文案提示可以改用随机名',
      typeof r.d.reason === 'string' && r.d.reason.indexOf('随机') >= 0, r.d.reason);

    const pk = await get('/api/room/' + roomA + '/peek?t=' + encodeURIComponent(tA));
    check('被拒之后昵称还是上一个（没改坏）', pk.d.state.youNick === '乙先生', pk.d.state.youNick);
    st = await get('/api/nick-status?uid=' + uidA);
    check('被拒之后额度没被二次消耗', num(st.d.waitMs) > 0 && num(st.d.waitMs) <= GAP, st.d.waitMs);

    /* --- 随机诗人名：不受限 --- */
    const an = (await get('/api/rand-name')).d.name;
    check('拿到了一个随机诗人名', typeof an === 'string' && an.length >= 2, an);
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: an, uid: uidA, random: true });
    check('冷却期内仍可改用随机诗人名', r.d.ok === true && r.d.nick === an, r.d);
    check('随机改名标记为 random', r.d.random === true, r.d);
    check('随机改名不返回 retryAt（不占额度）', num(r.d.retryAt) === 0, r.d.retryAt);
    st = await get('/api/nick-status?uid=' + uidA);
    check('随机改名没有续上冷却（剩余时间仍在缩短）',
      num(st.d.waitMs) <= GAP && st.d.lastNick === '乙先生', st.d);

    /* --- 冒充随机：名字不在诗人池里，必须按自定义处理 --- */
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '我自己起的名字', uid: uidA, random: true });
    check('自称 random 但名字不在诗人池 → 仍被额度拦住', r.d.ok === false && r.d.code === 'cooldown', r.d);
    const pk2 = await get('/api/room/' + roomA + '/peek?t=' + encodeURIComponent(tA));
    check('冒充失败后昵称还是随机诗人名', pk2.d.state.youNick === an, pk2.d.state.youNick);

    /* --- 冷却中改回「上次那个自定义名」：等于没产生新名字，放行且不重新计时 ---
       大厅那条路一直是这样（nickGate 里 lastNick 命中就放行），房内以前没跟上，
       会出现「大厅用同一个名字能进房、房里改回同一个名字却被拦」。 */
    const w0 = num((await get('/api/nick-status?uid=' + uidA)).d.waitMs);
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '乙先生', uid: uidA });
    check('冷却中改回上次那个自定义名：放行', r.d.ok === true && r.d.nick === '乙先生', r.d);
    st = await get('/api/nick-status?uid=' + uidA);
    check('改回旧名字不重新计时（剩余时间只会更短）', num(st.d.waitMs) <= w0 + 500,
      { before: w0, after: st.d.waitMs });
    check('改回旧名字后记账里还是那个名字', st.d.lastNick === '乙先生', st.d.lastNick);
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '丁先生', uid: uidA });
    check('但换「另一个」自定义名仍然被拦（额度没被绕过）', r.d.ok === false && r.d.code === 'cooldown', r.d);

    /* --- 额度是按人算的：换个 uid 不受影响 --- */
    const uidB = uidOf('b');
    const cr2 = await post('/api/create', { nick: '丁先生', size: 7, extra: 0, playerCount: 2 });
    const roomB = cr2.d.roomId, tB = cr2.d.token;
    r = await post('/api/room/' + roomB + '/nick', { t: tB, nick: '戊先生', uid: uidB });
    check('另一个用户照常能改自定义名', r.d.ok === true && r.d.nick === '戊先生', r.d);
    st = await get('/api/nick-status?uid=' + uidA);
    check('别人改名不影响我的冷却', st.d.canRename === false, st.d);

    /* --- 冷却过期：不需要重启，时间到了就能再改 --- */
    console.log('--- 冷却过期（等 ' + (GAP + 400) + 'ms）---');
    await sleep(GAP + 400);
    st = await get('/api/nick-status?uid=' + uidA);
    check('冷却到期后 canRename 恢复', st.d.canRename === true, st.d);
    check('冷却到期后仍认得上一次的名字', st.d.lastNick === '乙先生', st.d.lastNick);
    const stSame = await get('/api/nick-status?uid=' + uidA + '&nick=' + encodeURIComponent('乙先生'));
    check('冷却到期后，继续用同一个名字判定为 unchanged', stSame.d.unchanged === true, stSame.d);
    check('冷却到期后，继续用同一个名字不需要支付额度（needsPay: false）', stSame.d.needsPay === false, stSame.d);
    const crSameAfterGap = await post('/api/create', { nick: '乙先生', size: 6, extra: 0, playerCount: 2, uid: uidA });
    check('冷却到期后用老名字建房放行', crSameAfterGap.d.ok === true, crSameAfterGap.d);
    const stAfterSame = await get('/api/nick-status?uid=' + uidA);
    check('用老名字建房不消耗改名额度（canRename 仍为 true）', stAfterSame.d.canRename === true, stAfterSame.d);
    r = await post('/api/room/' + roomA + '/nick', { t: tA, nick: '己先生', uid: uidA });
    check('冷却到期后可以再自定义改名', r.d.ok === true && r.d.nick === '己先生', r.d);

    killChild();

    /* ================= 阶段二：落盘 + IP 兜底 + 跨房间（默认 24 小时） ================= */
    console.log('--- 阶段二：重启后限制仍在、跨房间共享额度、旧页面退回 IP ---');
    /* 干净的目录：阶段一用的是缩短后的 GAP，那些记录在 24 小时口径下会「还没过期」，
       混进来会把「不带 uid 的第一次改名」这条断言污染掉。 */
    await boot(9020, dir2, 0);     /* 不传 NICK_GAP_MS → 默认 24 小时 */

    const uidC = uidOf('c');
    const cr3 = await post('/api/create', { nick: '庚先生', size: 7, extra: 0, playerCount: 2 });
    const roomC = cr3.d.roomId, tC = cr3.d.token;
    r = await post('/api/room/' + roomC + '/nick', { t: tC, nick: '辛先生', uid: uidC });
    check('新实例上第一次自定义改名成功', r.d.ok === true, r.d);
    check('默认冷却就是 24 小时', num(r.d.gapMs) === 24 * 60 * 60 * 1000, r.d.gapMs);

    /* 换个房间：额度是「这个人」的，不是「这个房间」的 */
    const cr4 = await post('/api/create', { nick: '壬先生', size: 7, extra: 0, playerCount: 2 });
    const roomD = cr4.d.roomId, tD = cr4.d.token;
    r = await post('/api/room/' + roomD + '/nick', { t: tD, nick: '癸先生', uid: uidC });
    check('换一个房间还是同一个人的额度（跨房间共享）', r.d.ok === false && r.d.code === 'cooldown', r.d);

    /* 重启：记账必须还在盘上 */
    const onDisk = path.join(dataDir, 'nicklimit.json');
    check('nicklimit.json 已落盘', fs.existsSync(onDisk), onDisk);
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(onDisk, 'utf8')); } catch (_) { disk = {}; }
    check('盘上记的是「u:uid」这种键', !!disk['u:' + uidC], Object.keys(disk));
    check('盘上记了改成了什么名字', disk['u:' + uidC] && disk['u:' + uidC].nick === '辛先生', disk['u:' + uidC]);

    killChild();
    await boot(9040, dir2, 0);     /* 重启，磁盘同一份 */

    st = await get('/api/nick-status?uid=' + uidC);
    check('重启后额度仍然是「用掉了」（落盘生效）', st.d.canRename === false, st.d);
    const cr5 = await post('/api/create', { nick: '子先生', size: 7, extra: 0, playerCount: 2 });
    r = await post('/api/room/' + cr5.d.roomId + '/nick', { t: cr5.d.token, nick: '丑先生', uid: uidC });
    check('重启后自定义改名仍被拒', r.d.ok === false && r.d.code === 'cooldown', r.d);

    /* 旧页面（不带 uid）：退回 IP，不能让限制形同虚设 */
    console.log('--- 旧页面：没有 uid ---');
    const cr6 = await post('/api/create', { nick: '寅先生', size: 7, extra: 0, playerCount: 2 });
    const roomE = cr6.d.roomId, tE = cr6.d.token;
    r = await post('/api/room/' + roomE + '/nick', { t: tE, nick: '卯先生' });
    check('不带 uid 的第一次自定义改名还能过', r.d.ok === true, r.d);
    const cr7 = await post('/api/create', { nick: '辰先生', size: 7, extra: 0, playerCount: 2 });
    r = await post('/api/room/' + cr7.d.roomId + '/nick', { t: cr7.d.token, nick: '巳先生' });
    check('不带 uid 的第二次（同 IP）被拒', r.d.ok === false && r.d.code === 'cooldown', r.d);
    /* 带 uid 的人不该被这条 IP 记录连累 */
    const uidE = uidOf('e');
    r = await post('/api/room/' + cr7.d.roomId + '/nick', { t: cr7.d.token, nick: '午先生', uid: uidE });
    check('同一个 IP 下带 uid 的用户不受 IP 记录影响', r.d.ok === true, r.d);

    /* 观众也受限（改昵称不分选手观众） */
    const cr8 = await post('/api/create', { nick: '未先生', size: 7, extra: 0, playerCount: 1 });
    const roomF = cr8.d.roomId;
    const jn = await post('/api/join', { roomId: roomF, nick: '观众甲' });
    const tW = jn.d.token;
    const uidF = uidOf('f');
    r = await post('/api/room/' + roomF + '/nick', { t: tW, nick: '观众乙', uid: uidF });
    check('观众改自定义名同样受额度管（第一次成功）', r.d.ok === true, r.d);
    r = await post('/api/room/' + roomF + '/nick', { t: tW, nick: '观众丙', uid: uidF });
    check('观众第二次被拒', r.d.ok === false && r.d.code === 'cooldown', r.d);

    /* 空名字、无效身份：不能顺手消耗额度 */
    const uidG = uidOf('7');
    const cr9 = await post('/api/create', { nick: '酉先生', size: 7, extra: 0, playerCount: 2 });
    r = await post('/api/room/' + cr9.d.roomId + '/nick', { t: cr9.d.token, nick: '   ', uid: uidG });
    check('空昵称直接拒（不是 cooldown）', r.d.ok === false && r.d.code === 'empty', r.d);
    st = await get('/api/nick-status?uid=' + uidG);
    check('空昵称没消耗额度', st.d.canRename === true, st.d);
    r = await post('/api/room/' + cr9.d.roomId + '/nick', { t: 'TK-INVALID', nick: '戌先生', uid: uidG });
    /* 路由层先拦身份（401），走不到 renameMember 的 not-member —— 两条都是「没改」，都该零消耗 */
    check('无效身份被拒（401）', r.d.ok === false && r.status === 401, { status: r.status, d: r.d });
    st = await get('/api/nick-status?uid=' + uidG);
    check('无效身份没消耗额度', st.d.canRename === true, st.d);
  } catch (e) {
    fail++;
    console.log('FAIL 测试异常：' + (e && e.message));
    console.log(e && e.stack);
  } finally {
    killChild();
    try { fs.rmSync(dir1, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
