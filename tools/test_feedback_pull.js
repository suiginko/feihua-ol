'use strict';
/* 反馈取件 —— 回归测试。
 *
 *   node tools/test_feedback_pull.js
 *
 * 被测的东西：玩家提交的反馈能不能被站点外的定时任务「只取一次、绝不漏」地拉走。
 * 这条链路是「反馈转发到开发者邮箱」的全部基础，站点本身不发信 ——
 * 收件地址一旦写进任何会被下发的文件就等于公开了。
 *
 * 覆盖：
 *   1) 每条反馈带自己的 fid，两次提交的 fid 不同；
 *   2) GET 不带 since → 现有的都给你；
 *   3) GET 带 since → 只给比它新的（增量）；
 *   4) since 是个根本不存在的值 → foundSince=false，返回全部（宁可重复不可漏）；
 *   5) 口令不对 → 403；
 *   6) 端到端跑真脚本 tools/pull_feedback.js：
 *      peek 拿到 n 条并留下 pending → commit 后变 0 → 再提交一条又只出来 1 条；
 *   7) 发信失败不丢：peek 之后不 commit，再 peek 还能拿到同一批；
 *   8) 拉取失败（服务连不上）时脚本第一行必须是 NEW_FEEDBACK=-1，不能是 0。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const KEY = 'test-key-123';
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

let PORT = 0;
let BASE = '';
let child = null;
let seenDir = '';

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
      if (r.ok) return true;
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

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
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

/* 跑一次真脚本，返回 {code, out, err}。OUT 第一行是机器读的，别的都是人读的。 */
function pull(args, base) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'pull_feedback.js')].concat(args || []), {
    env: Object.assign({}, process.env, {
      BASE: base || BASE,
      KEY,
      SEEN_DIR: seenDir,
      /* 这台机器设了 http_proxy 却没设 no_proxy，Node 的 fetch 不走它，
         但万一以后走了，localhost 也得能通 */
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }),
    encoding: 'utf8',
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function firstLine(out) {
  return String(out).split('\n')[0].trim();
}

async function send(text, extra) {
  return api('/api/feedback', Object.assign({ text, nick: '甲', roomId: '007' }, extra || {}));
}

async function main() {
  for (let p = 8830; p <= 8850; p++) { if (await portFree(p)) { PORT = p; break; } }
  if (!PORT) throw new Error('找不到空闲端口');
  const dataDir = tmpDir('test-feedback-pull-' + PORT);
  seenDir = path.join(dataDir, 'seen');
  BASE = 'http://127.0.0.1:' + PORT;

  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      DATA_DIR: dataDir,
      ADMIN_KEY: KEY,
      SWEEP_MS: '500',
      FEEDBACK_GAP_MS: '0',    /* 同 IP 30 秒一条的限制在测试里没法等，关掉 */
    }),
    stdio: 'ignore',
  });
  if (!(await waitUp(30000))) throw new Error('实例没起来（端口 ' + PORT + '）');

  /* ---------- 1) fid ---------- */
  const a = await send('第一条：棋盘右上角点不动');
  check('提交成功', a.d && a.d.ok === true, a.d);
  check('回复里带了 fid', !!(a.d && a.d.fid), a.d);
  const b = await send('第二条：观战看不到比分');
  check('两次提交的 fid 不同', !!(a.d.fid && b.d.fid && a.d.fid !== b.d.fid), [a.d.fid, b.d.fid]);

  /* ---------- 2) 不带 since ---------- */
  let g = await get('/api/feedback?key=' + encodeURIComponent(KEY));
  check('不带 since 时把现有的都给出来', g.d.ok && g.d.list.length === 2, g.d.list && g.d.list.length);
  check('最新的一条排在最前', g.d.list[0].fid === b.d.fid, g.d.list[0] && g.d.list[0].fid);
  check('反馈里没有出现任何邮箱字段（收件地址不落在这里）',
    !('to' in g.d.list[0]) && !('email' in g.d.list[0]), Object.keys(g.d.list[0] || {}));

  /* ---------- 3) 带 since ---------- */
  g = await get('/api/feedback?key=' + encodeURIComponent(KEY) + '&since=' + encodeURIComponent(a.d.fid));
  check('带 since 时只给比它新的', g.d.ok && g.d.list.length === 1 && g.d.list[0].fid === b.d.fid,
    g.d.list && g.d.list.map((x) => x.fid));
  check('foundSince=true', g.d.foundSince === true, g.d);

  /* ---------- 4) since 不存在 ---------- */
  g = await get('/api/feedback?key=' + encodeURIComponent(KEY) + '&since=nope-000000');
  check('since 对不上时不装懂：foundSince=false', g.d.foundSince === false, g.d.foundSince);
  check('since 对不上时返回全部（宁可重复不可漏）', g.d.list.length === 2, g.d.list.length);

  /* ---------- 5) 口令 ---------- */
  g = await get('/api/feedback?key=wrong');
  check('口令不对 → 403', g.status === 403, g.status);

  /* ---------- 6) 端到端：peek → commit ---------- */
  let r = pull(['--peek']);
  check('peek 第一行是成员数', firstLine(r.out) === 'NEW_FEEDBACK=2', firstLine(r.out));
  check('peek 正文里有反馈原文', r.out.indexOf('棋盘右上角点不动') >= 0, r.out.slice(0, 120));
  check('peek 后 pending 有 2 条', (function () {
    try { return JSON.parse(fs.readFileSync(path.join(seenDir, 'feedback-pending.json'), 'utf8')).ids.length === 2; }
    catch (_) { return false; }
  })());

  /* ---------- 7) 不 commit 就再 peek：还拿得到（发信失败不丢） ---------- */
  r = pull(['--peek']);
  check('没 commit 时再 peek 还是这 2 条', firstLine(r.out) === 'NEW_FEEDBACK=2', firstLine(r.out));

  r = pull(['--commit']);
  check('commit 第一行是 0', firstLine(r.out) === 'NEW_FEEDBACK=0', firstLine(r.out));
  r = pull(['--peek']);
  check('commit 之后再 peek 是 0 条', firstLine(r.out) === 'NEW_FEEDBACK=0', firstLine(r.out));

  /* ---------- 8) 新的一条只出来一条 ---------- */
  const c = await send('第三条：导出图片按钮没反应');
  r = pull(['--peek']);
  check('新提交后 peek 只有 1 条', firstLine(r.out) === 'NEW_FEEDBACK=1', firstLine(r.out));
  check('这几条确实是新的那条', r.out.indexOf('导出图片按钮没反应') >= 0 && r.out.indexOf('棋盘右上角点不动') < 0, r.out.slice(0, 160));
  check('取到的 fid 与服务端返回的一致',
    JSON.parse(fs.readFileSync(path.join(seenDir, 'feedback-pending.json'), 'utf8')).ids[0] === c.d.fid);

  /* ---------- 9) 拉不到时不能谎报 0 ---------- */
  r = pull([], 'http://127.0.0.1:1');
  check('连不上时第一行是 -1（不能当成「没有新反馈」）', firstLine(r.out) === 'NEW_FEEDBACK=-1', firstLine(r.out));
  check('连不上时退出码非 0', r.code !== 0, r.code);

  /* ---------- 10) 老记录没有 fid 也不能重复取 ---------- */
  /* 手工塞一条「加 fid 之前」格式的记录，再跑一次取件，确认它只出现一次 */
  const fbFile = path.join(dataDir, 'feedback.jsonl');
  fs.appendFileSync(fbFile, JSON.stringify({ at: Date.now(), text: '没有 fid 的老记录', nick: '丙' }) + '\n');
  r = pull(['--peek']);
  check('没有 fid 的老记录也能取到', firstLine(r.out) === 'NEW_FEEDBACK=2', firstLine(r.out));
  r = pull(['--commit']);
  check('commit 成功', firstLine(r.out) === 'NEW_FEEDBACK=0', firstLine(r.out));
  r = pull(['--peek']);
  check('没有 fid 的老记录不会重复取', firstLine(r.out) === 'NEW_FEEDBACK=0', firstLine(r.out));

  console.log('\n「反馈取件」' + pass + ' 过 / ' + fail + ' 败');
}

main().then(() => {
  killChild();
  process.exitCode = fail ? 1 : 0;
}).catch((e) => {
  killChild();
  console.error('炸了：' + (e && e.stack || e));
  process.exitCode = 1;
});
