'use strict';
/* 取件：把线上「反馈」拉下来，只输出还没取过的那几条。
 *
 * 为什么要有这个东西
 *   反馈写在服务器容器的 data/feedback.jsonl 里，而站点本身**不发邮件** ——
 *   收件地址一旦写进任何会被下发的文件（public/ 下的一切）就等于公开了。
 *   所以把「发信」这一步挪到站点外面：WorkBuddy 侧的定时任务带上审阅口令来取一次，
 *   再由任务把结果转发到开发者邮箱。地址只活在任务配置里，不进代码、不进部署产物，
 *   拿到 admin.key 也只能看到反馈内容，看不到收件人。
 *
 * 用法
 *   node tools/pull_feedback.js             看新反馈，并记为已读（手动看的时候用）
 *   node tools/pull_feedback.js --peek      只看，把这几条的 fid 记进 pending，不记为已读
 *   node tools/pull_feedback.js --commit    把 pending 里的 fid 记为已读（发信成功之后调它）
 *   node tools/pull_feedback.js --all       忽略已读记录，把线上现有的全部打出来
 *   BASE=http://127.0.0.1:8787 node tools/pull_feedback.js
 *
 * 输出约定的第一行固定是 NEW_FEEDBACK=<n>（0 = 没有新的，-1 = 拉取失败），
 * 后面才是人类可读的正文 —— 自动化只需看第一行决定发不发信，失败的正文不会混进去。
 *
 * 为什么不是「取完就记已读」，而要拆成 peek / commit
 *   先记已读再发信，一旦发信失败这几条就永久漏掉了。所以默认流程是
 *   peek（拿到内容与 pending）→ 发信成功 → commit。中途断了，下次 peek 还会再取到同一批。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 已读记录放在 tools/.cache（.gitignore 里已忽略）。SEEN_DIR 只给测试用，
   免得跑一次测试就把真实的已读记录冲掉。 */
const CACHE = path.resolve(process.env.SEEN_DIR || path.join(__dirname, '.cache'));
const SEEN_FILE = path.join(CACHE, 'feedback-seen.json');
const PENDING_FILE = path.join(CACHE, 'feedback-pending.json');

const BASE = String(process.env.BASE || 'https://feihua-splatoon.app.workbuddy.host').replace(/\/+$/, '');
/* 线上那层网关认 sharecode：不带就**所有** /api 一律 403（连 /api/rooms 也是），
   带了才真正转到应用。它跟发布链接上那个 ?sharecode= 是同一个值，
   仓库里 online_check.js / test_share_link.js 早就写死了，不是新增的秘密。 */
const SHARE = String(process.env.SHARECODE !== undefined ? process.env.SHARECODE : 'MZA5YPLHV3').trim();
const argv = process.argv.slice(2);
const PEEK = argv.includes('--peek');
const COMMIT = argv.includes('--commit');
const ALL = argv.includes('--all');

function withShare(p) {
  const sep = p.indexOf('?') >= 0 ? '&' : '?';
  return BASE + p + (SHARE ? sep + 'sharecode=' + encodeURIComponent(SHARE) : '');
}

function readKey() {
  if (process.env.KEY) return process.env.KEY.trim();
  try { return fs.readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim(); } catch (_) { return ''; }
}

function loadIDs(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(o.ids) ? o.ids : [];
  } catch (_) { return []; }
}

function saveIDs(file, ids) {
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    /* 只留最近 2000 条，别让这张表无限长 */
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), ids: ids.slice(-2000) }, null, 0) + '\n');
  } catch (e) {
    console.error('[warn] 已读记录写不进去：' + e.message);
  }
}

/* 每条反馈的稳定身份。老记录（加 fid 之前写的）没有这个字段，退化成「时间 + 正文前 40 字」。 */
function idOf(rec) {
  if (rec.fid) return rec.fid;
  return 't' + (rec.at || 0) + '|' + String(rec.text || '').slice(0, 40);
}

function two(n) { return (n < 10 ? '0' : '') + n; }

function hms(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
    ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

function body(items) {
  const lines = [];
  lines.push('飞花斯普拉遁 · 玩家反馈 ' + items.length + ' 条（' + hms(Date.now()) + ' 取件）');
  lines.push('');
  items.forEach(function (x, i) {
    const who = [];
    if (x.nick) who.push(x.nick); else who.push('匿名');
    if (x.roomId) who.push('房间 ' + x.roomId);
    lines.push('[' + (i + 1) + '] ' + hms(x.at || 0) + ' · ' + who.join(' · '));
    if (x.contact) lines.push('    联系方式：' + x.contact);
    String(x.text || '').split('\n').forEach(function (ln) { lines.push('    ' + ln); });
    lines.push('');
  });
  return lines.join('\n').replace(/\n+$/, '');
}

async function main() {
  if (COMMIT) {
    const pend = loadIDs(PENDING_FILE);
    if (!pend.length) { console.log('NEW_FEEDBACK=0'); console.log('（pending 里没有待记的，无需操作）'); return; }
    const seen = loadIDs(SEEN_FILE);
    saveIDs(SEEN_FILE, seen.concat(pend));
    saveIDs(PENDING_FILE, []);
    console.log('NEW_FEEDBACK=0');
    console.log('已把 ' + pend.length + ' 条记为已读。');
    return;
  }

  const KEY = readKey();
  if (!KEY) { console.log('NEW_FEEDBACK=-1'); console.error('没有口令：admin.key 不存在，也没设 KEY 环境变量。'); process.exitCode = 1; return; }

  let d;
  try {
    const r = await fetch(withShare('/api/feedback?key=' + encodeURIComponent(KEY)), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404) {
      console.log('NEW_FEEDBACK=-1');
      console.error('线上这一版还没有反馈接口（404）。反馈功能是本地改动，要等发布后才有东西可取。');
      process.exitCode = 1;
      return;
    }
    if (r.status === 403) {
      /* 403 有两个完全不同的来源，别混着报：
         ① 网关没放行（sharecode 不对 / 没带）—— 这时连免口令的 /api/rooms 也 403；
         ② 是我们自己的口令不对 —— /api/rooms 正常 200。 */
      let gate = false;
      try {
        const probe = await fetch(withShare('/api/rooms'), { signal: AbortSignal.timeout(20000) });
        gate = probe.status === 403;
      } catch (_) { /* 探不动就按口令处理 */ }
      console.log('NEW_FEEDBACK=-1');
      console.error(gate
        ? '被网关拦了（403）：sharecode 不对或没带。当前用的是「' + (SHARE || '(空)') + '」，' +
          '跟发布链接 ?sharecode= 后面那串核对一下，或用 SHARECODE=… 覆盖。'
        : '口令不对（403）：admin.key 与线上不一致。');
      process.exitCode = 1;
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    d = await r.json();
  } catch (e) {
    console.log('NEW_FEEDBACK=-1');
    console.error('拉取失败：' + e.message);
    process.exitCode = 1;
    return;
  }

  const all = (d && d.list) || [];
  const seen = new Set(ALL ? [] : loadIDs(SEEN_FILE));
  const fresh = all.filter(function (x) { return !seen.has(idOf(x)); })
    .sort(function (a, b) { return (a.at || 0) - (b.at || 0); });   /* 由旧到新，读起来顺 */

  if (!fresh.length) {
    console.log('NEW_FEEDBACK=0');
    console.log('（没有新反馈）');
    return;
  }

  console.log('NEW_FEEDBACK=' + fresh.length);
  console.log(body(fresh));

  if (ALL) return;   /* --all 是查问题用的，不留任何痕迹，别把已读记录冲掉 */
  if (PEEK) {
    saveIDs(PENDING_FILE, fresh.map(idOf));
    console.error('[peek] 记下 ' + fresh.length + ' 条待确认；发信成功后调 --commit 再记为已读。');
  } else {
    saveIDs(SEEN_FILE, Array.from(seen).concat(fresh.map(idOf)));
    console.error('[已读] 记下 ' + fresh.length + ' 条，下次不会再取到。');
  }
}

main().catch(function (e) {
  console.log('NEW_FEEDBACK=-1');
  console.error('未预期的错误：' + (e && e.stack || e));
  process.exitCode = 1;
});
