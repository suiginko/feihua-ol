'use strict';
/* 公告栏 —— 回归测试。
 *
 *   node tools/test_notice.js
 *
 * 被测的东西只有一句话：**改一句公告不该重新发布一次应用。**
 * 所以公告必须活在磁盘上、运行期可改，而不是写死在前端模板里。这里逐条验收：
 *   1) 默认没有公告（GET 回 null），大厅那边也就什么都不显示；
 *   2) 写公告要口令，没口令 403；
 *   3) 写完立刻能公开读到（GET 不需要口令），正文 / 样式 / 时间都对；
 *   4) 超过 300 字被截断，kind 只认 warn 一个值，别的都退回 info；
 *   5) 留空保存 = 撤下，之后 GET 回到 null；
 *   6) 换行保留、行尾空白去掉 —— 公告是给人看的，排版别被吃掉；
 *   7) 重启进程后公告还在（这是「不重新发布也能改」的前提：它得存在磁盘上）；
 *   8) notice.json 被人写坏了，服务照常起、GET 回 null，而且能重新写回去。
 */
const { spawn } = require('child_process');
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
      const r = await fetch(BASE + '/api/stats', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d && d.pid === child.pid) return true;   /* 别把上一次的实例当成这次的 */
      }
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

async function boot() {
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, ADMIN_KEY: KEY, SWEEP_MS: '500',
    }),
    stdio: 'ignore',
  });
  if (!(await waitUp(30000))) throw new Error('实例没起来（端口 ' + PORT + '）');
}

async function getNotice() {
  const r = await fetch(BASE + '/api/notice', { cache: 'no-store' });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

async function postNotice(body, key) {
  const r = await fetch(BASE + '/api/notice' + (key === null ? '' : '?key=' + encodeURIComponent(key)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let d = {};
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

async function main() {
  for (let p = 8860; p <= 8880; p++) { if (await portFree(p)) { PORT = p; break; } }
  if (!PORT) throw new Error('找不到空闲端口');
  dataDir = tmpDir('test-notice-' + PORT);
  BASE = 'http://127.0.0.1:' + PORT;

  await boot();

  /* ---------- 1) 默认没有 ---------- */
  let g = await getNotice();
  check('默认没有公告时 GET 回 null', g.status === 200 && g.d.ok === true && g.d.notice === null, g.d);
  check('「没有公告」不需要口令也能问', g.status === 200, g.status);

  /* ---------- 2) 写要口令 ---------- */
  let p = await postNotice({ text: '今晚会更新' }, null);
  check('不带口令 → 403', p.status === 403, p.status);
  p = await postNotice({ text: '今晚会更新' }, 'wrong-key');
  check('口令不对 → 403', p.status === 403, p.status);
  g = await getNotice();
  check('被拒的写入没有生效', g.d.notice === null, g.d.notice);

  /* ---------- 3) 写进去 ---------- */
  p = await postNotice({ text: '今晚 23:00 左右会更新一版。', kind: 'warn' }, KEY);
  check('带口令写入成功', p.status === 200 && p.d.ok && !!p.d.notice, p.d);
  check('kind 存成 warn', p.d.notice && p.d.notice.kind === 'warn', p.d.notice);
  check('带了保存时间', !!(p.d.notice && p.d.notice.at > 0), p.d.notice);

  g = await getNotice();
  check('公开 GET 立刻能读到', g.d.notice && g.d.notice.text === '今晚 23:00 左右会更新一版。', g.d.notice);
  check('公开 GET 的 kind 也对', g.d.notice && g.d.notice.kind === 'warn', g.d.notice);

  /* ---------- 4) 边界 ---------- */
  p = await postNotice({ text: '一'.repeat(400), kind: 'info' }, KEY);
  check('超过 300 字被截断', p.d.notice && p.d.notice.text.length === 300, p.d.notice && p.d.notice.text.length);
  check('kind 只认 warn，别的一律 info', p.d.notice && p.d.notice.kind === 'info', p.d.notice && p.d.notice.kind);

  p = await postNotice({ text: '第一行\n第二行\n', kind: 'weird' }, KEY);
  g = await getNotice();
  check('换行保留', g.d.notice && g.d.notice.text.indexOf('\n') > 0, g.d.notice && g.d.notice.text);
  check('行尾空白被去掉', g.d.notice && g.d.notice.text.slice(-2) === '二行', g.d.notice && JSON.stringify(g.d.notice.text));
  check('乱写的 kind 退回 info', g.d.notice && g.d.notice.kind === 'info', g.d.notice && g.d.notice.kind);

  /* ---------- 5) 撤下 ---------- */
  p = await postNotice({ text: '   ' }, KEY);
  check('留空保存 = 撤下（回 notice:null）', p.d.ok === true && p.d.notice === null, p.d);
  g = await getNotice();
  check('撤下之后 GET 回到 null', g.d.notice === null, g.d.notice);

  /* ---------- 6) 重启后还在 ---------- */
  await postNotice({ text: '重启也要还在', kind: 'info' }, KEY);
  const before = (await getNotice()).d.notice;
  killChild();
  await sleep(600);
  await boot();
  const after = (await getNotice()).d.notice;
  check('重启进程后公告还在', !!after && after.text === '重启也要还在', after);
  check('重启后保存时间不变', !!after && after.at === before.at, after && after.at);

  /* ---------- 7) 文件写坏了也不能崩 ---------- */
  killChild();
  await sleep(600);
  fs.writeFileSync(path.join(dataDir, 'notice.json'), '{ 这不是 JSON ');
  await boot();
  g = await getNotice();
  check('notice.json 坏了：GET 回 null 而不是 500', g.status === 200 && g.d.notice === null, g.d);
  p = await postNotice({ text: '坏了也能写回去' }, KEY);
  check('文件坏了之后仍然能重新写入', p.d.ok === true && p.d.notice && p.d.notice.text === '坏了也能写回去', p.d);
  g = await getNotice();
  check('重写之后能正常读到', g.d.notice && g.d.notice.text === '坏了也能写回去', g.d.notice);

  console.log('\n「公告栏」' + pass + ' 过 / ' + fail + ' 败');
}

main().then(() => {
  killChild();
  process.exitCode = fail ? 1 : 0;
}).catch((e) => {
  killChild();
  console.error('炸了：' + (e && e.stack || e));
  process.exitCode = 1;
});
