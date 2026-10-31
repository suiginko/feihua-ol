'use strict';
/* 大厅改名（建房 / 加入）也要受「自定义昵称 24 小时一次」约束 —— 服务端回归。
 *
 *   node tools/test_nick_lobby.js
 *
 * 起因：额度只做在房间里的「改名」按钮上，玩家在大厅输入框改个名再建房 / 加入，
 * 既没有任何提醒、也不消耗额度 —— 于是「每人 24 小时一次」这条规则被绕过了一半。
 *
 * 这里锁的几件事：
 *   ① 建房带自定义名 → 记账；同一个 uid 换一个自定义名 → 被拒（code: cooldown），且**不会建出房间**；
 *   ② 同一个名字再来 → 放行（不是重新改名，不该再扣一次）；
 *   ③ 诗人名 / 不带 uid / uid 不合规 → 放行（进房这一步不用 IP 兜底，避免一家人互相锁住）；
 *   ④ 加入房间这条路与建房同规则，观众也一视同仁；
 *   ⑤ 额度只在**真的进了房间**之后才记账：被观众席上限挡回去的那次不许白扣。
 */
const { spawn } = require('child_process');
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
async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
const uidOf = (ch) => 'u' + String(ch).repeat(32);
const roomCount = async () => {
  const s = await get('/api/stats');
  return Number(s.d.rooms) || 0;
};

(async () => {
  try {
    for (let p = 8910; p <= 8960; p++) { if (await portFree(p)) { PORT = p; break; } }
    if (!PORT) throw new Error('找不到空闲端口');
    BASE = 'http://127.0.0.1:' + PORT;
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT), DATA_DIR: tmpDir('test-nick-lobby-' + PORT), SWEEP_MS: '600000',
      }),
      stdio: 'ignore',
    });
    if (!(await waitUp(40000))) throw new Error('实例没起来');
    await sleep(150);

    const uidA = uidOf('a');

    /* ---------- 1. 建房带自定义名：记账 ---------- */
    console.log('--- 建房：自定义名 ---');
    const st0 = await get('/api/nick-status?uid=' + uidA + '&nick=' + encodeURIComponent('甲先生'));
    check('新 uid 第一次用自定义名：不拦', st0.d.canRename === true && st0.d.willBlock === false, st0.d);
    check('新 uid 第一次用自定义名：会消耗额度（needsPay）', st0.d.needsPay === true, st0.d);
    check('服务端认得这是自定义名', st0.d.isCustom === true && st0.d.isAuthorName === false, st0.d);

    const cr1 = await post('/api/create', { nick: '甲先生', size: 6, extra: 0, playerCount: 2, uid: uidA });
    check('第一次建房成功', cr1.d.ok === true && !!cr1.d.roomId, cr1.d);
    const roomA = cr1.d.roomId;

    const st1 = await get('/api/nick-status?uid=' + uidA + '&nick=' + encodeURIComponent('乙先生'));
    check('建完房额度就用掉了（canRename:false）', st1.d.canRename === false, st1.d);
    check('额度里记的是刚才那个名字', st1.d.lastNick === '甲先生', st1.d);
    check('再换一个自定义名会被判 willBlock', st1.d.willBlock === true, st1.d);

    /* ---------- 2. 同一个名字再来：不拦、不再扣 ---------- */
    console.log('--- 同名的再次进入 ---');
    const st2 = await get('/api/nick-status?uid=' + uidA + '&nick=' + encodeURIComponent('甲先生'));
    check('同一个名字不算「改」：不拦', st2.d.willBlock === false, st2.d);
    check('同一个名字：unchanged 为真', st2.d.unchanged === true, st2.d);
    const crSame = await post('/api/create', { nick: '甲先生', size: 6, extra: 0, playerCount: 2, uid: uidA });
    check('用同一个名字再建一间房：放行', crSame.d.ok === true, crSame.d);

    /* ---------- 3. 换自定义名建房：拦住，而且不建房 ---------- */
    console.log('--- 冷却中换名建房 ---');
    const before = await roomCount();
    const crBad = await post('/api/create', { nick: '乙先生', size: 6, extra: 0, playerCount: 2, uid: uidA });
    check('冷却中换自定义名建房：被拒', crBad.d.ok === false && crBad.d.code === 'cooldown', crBad.d);
    check('拒绝理由说清 24 小时', /24 小时/.test(String(crBad.d.reason || '')), crBad.d.reason);
    check('拒绝理由带上上次用的名字', /甲先生/.test(String(crBad.d.reason || '')), crBad.d.reason);
    check('拒绝理由给出「换一位诗人」这个出口', /诗人/.test(String(crBad.d.reason || '')), crBad.d.reason);
    check('被拒时返回剩余时间（waitMs）', Number(crBad.d.waitMs) > 0 && Number(crBad.d.retryAt) > Date.now(), crBad.d);
    const after = await roomCount();
    check('被拒时一间房都没建出来', after === before, [before, after]);

    /* ---------- 4. 诗人名不占额度 ---------- */
    console.log('--- 诗人名 ---');
    const rn = await get('/api/rand-name');
    const author = rn.d.name;
    check('拿到一位诗人名', !!author, author);
    const st3 = await get('/api/nick-status?uid=' + uidA + '&nick=' + encodeURIComponent(author));
    check('诗人名被判为 isAuthorName', st3.d.isAuthorName === true && st3.d.isCustom === false, st3.d);
    check('诗人名不会被拦', st3.d.willBlock === false, st3.d);
    const crAuthor = await post('/api/create', { nick: author, size: 6, extra: 0, playerCount: 2, uid: uidA });
    check('冷却中换诗人名建房：放行', crAuthor.d.ok === true, crAuthor.d);
    const st4 = await get('/api/nick-status?uid=' + uidA);
    check('诗人名没有覆盖掉上次的自定义名记录', st4.d.lastNick === '甲先生', st4.d);

    /* ---------- 5. 加入房间这条路 ---------- */
    console.log('--- 加入房间 ---');
    const uidB = uidOf('b');
    const crB = await post('/api/create', { nick: '房主乙', size: 6, extra: 0, playerCount: 2, uid: uidB });
    const roomB = crB.d.roomId;
    check('另一个人建好一间房', crB.d.ok === true && !!roomB, crB.d);

    const jBad = await post('/api/join', { roomId: roomB, nick: '丙先生', uid: uidA });
    check('冷却中换自定义名加入：被拒', jBad.d.ok === false && jBad.d.code === 'cooldown', jBad.d);
    const jSame = await post('/api/join', { roomId: roomB, nick: '甲先生', uid: uidA });
    check('用记录里的名字加入：放行', jSame.d.ok === true, jSame.d);
    check('用记录里的名字加入坐上了席位', jSame.d.role === 'player', jSame.d.role);

    /* 房间 A 仍在 waiting，可以用观众身份试 */
    const jWatch = await post('/api/join', { roomId: roomA, nick: '丁先生', uid: uidA });
    check('观众身份同样受额度约束', jWatch.d.ok === false && jWatch.d.code === 'cooldown', jWatch.d);

    /* ---------- 6. 没有 uid：进房这一步不按 IP 兜底 ---------- */
    console.log('--- 没有 uid（老页面） ---');
    const n1 = await post('/api/create', { nick: '戊先生', size: 6, extra: 0, playerCount: 2 });
    const n2 = await post('/api/create', { nick: '己先生', size: 6, extra: 0, playerCount: 2 });
    check('不带 uid：第一间放行', n1.d.ok === true, n1.d);
    check('不带 uid：换名再建一间也放行（不拿 IP 互锁）', n2.d.ok === true, n2.d);
    const n3 = await post('/api/create', { nick: '庚先生', size: 6, extra: 0, playerCount: 2, uid: 'short' });
    check('uid 不合规：按老页面放行', n3.d.ok === true, n3.d);

    /* ---------- 7. 被观众席上限挡回去时不许白扣 ---------- */
    console.log('--- 没进成不扣额度 ---');
    const uidC = uidOf('c');
    const solo = await post('/api/create', { nick: '单人房主', size: 5, extra: 0, playerCount: 1, uid: uidC });
    const roomS = solo.d.roomId;
    check('单人房建好（席位上只有房主）', solo.d.ok === true, solo.d);
    /* 单人房坐不下别人，后来的都是观众；坐满 30 个观众再试 */
    for (let i = 0; i < 30; i++) {
      await post('/api/join', { roomId: roomS, nick: '观众' + i });
    }
    const uidD = uidOf('d');
    const jFull = await post('/api/join', { roomId: roomS, nick: '辛先生', uid: uidD });
    check('观众席满了：这次加入失败', jFull.d.ok === false && jFull.status === 409, [jFull.status, jFull.d]);
    const stD = await get('/api/nick-status?uid=' + uidD + '&nick=' + encodeURIComponent('辛先生'));
    check('没进成的那次没有扣掉额度', stD.d.canRename === true && stD.d.needsPay === true, stD.d);

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
