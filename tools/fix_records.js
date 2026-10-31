'use strict';
/* 修复旧存档里被记成空白的金营 / 翠营。
 *
 *   node tools/fix_records.js exports/records-2026-10-22.json
 *       本地修一份导出：生成 records-...-fixed.json 与 .csv，并打印逐局改动。
 *
 *   node tools/fix_records.js --remote            线上**预演**（只算不写，打印报告）
 *   node tools/fix_records.js --remote --apply    先打预演报告，再写回线上（自动留 .bak）
 *
 * 修的是哪一层：2026-10-22 之前 archiveGame() 只写 A/B 两个席位，多人局的金营翠营昵称
 * 在落盘那一刻就没了。审阅页的渲染已经修好（提交 6eb50c4），但那几行**数据**确实是空的。
 * 这里按存档里的痕迹回填 —— 证据与判据见 recordfix.js 开头的说明。
 *
 * 线上那一份只能靠服务端的 POST /api/records/repair 改（容器磁盘拿不到），
 * 所以本地这份「修好的导出」只用于核对与长期留存，不会自动同步回线上。
 */
const fs = require('fs');
const path = require('path');
const recordFix = require('../recordfix');

const ROOT = path.resolve(__dirname, '..');
const BASE = String(process.env.BASE || 'https://feihua-splatoon.app.workbuddy.host').replace(/\/+$/, '');
const SC = process.env.SHARECODE || 'MZA5YPLHV3';
const KEY = process.env.ADMIN_KEY || (() => {
  try { return fs.readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim(); } catch (_) { return ''; }
})();

const argv = process.argv.slice(2);
const remote = argv.includes('--remote');
const apply = argv.includes('--apply');
const given = argv.find((a) => a && !a.startsWith('--'));

const pad = (n) => String(n).padStart(2, '0');
const ts = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};
const SEATS = ['A', 'B', 'C', 'D'];
const who = (r, s) => {
  const p = r.players && r.players[s];
  const n = p && (typeof p === 'string' ? p : p.nick);
  return n || '';
};

function printReport(rows) {
  if (!rows.length) { console.log('没有需要修的记录。'); return; }
  for (const x of rows) {
    console.log('=== ' + (x.id || '?') + '  ' + ts(x.at) + '  人数 ' + x.need);
    for (const p of x.patches || []) {
      console.log('   + ' + p.seat + '.' + p.field + '  "' + (p.from == null ? '(缺)' : p.from) + '" → "' + p.to + '"　依据：' + p.why);
    }
    for (const c of x.conflicts || []) {
      console.log('   ! ' + c.seat + '.' + c.field + '  保留 "' + c.kept + '"，该席最后一手是 "' + c.seen + '"　' + c.why);
    }
  }
}

/* ---------------- 线上 ---------------- */

async function remoteRun() {
  if (!KEY) { console.error('没有 admin.key，也没设 ADMIN_KEY。'); process.exitCode = 1; return; }
  const url = (q) => BASE + '/api/records/repair?key=' + encodeURIComponent(KEY) + '&sharecode=' + SC + q;
  const call = (q) => fetch(url(q), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(60000),
  }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));

  const dry = await call('');
  if (!dry.d.ok) { console.error('预演失败：HTTP ' + dry.status + ' ' + JSON.stringify(dry.d)); process.exitCode = 1; return; }
  console.log('线上预演：' + dry.d.fixed + ' 局需要修');
  for (const f of dry.d.files || []) {
    console.log('  ' + f.file + '：共 ' + f.total + ' 行，需修 ' + f.fixed + ' 局' + (f.reportTruncated ? '（报告已截断）' : ''));
    printReport(f.report || []);
  }
  if (!apply) { console.log('\n这是预演，线上档案没动。加 --apply 才写回。'); return; }
  if (!dry.d.fixed) { console.log('\n没有要写的东西。'); return; }

  const done = await call('&apply=1');
  if (!done.d.ok) { console.error('写回失败：HTTP ' + done.status + ' ' + JSON.stringify(done.d)); process.exitCode = 1; return; }
  console.log('\n已写回 ' + done.d.fixed + ' 局：' + (done.d.files || []).map((f) =>
    f.file + (f.written ? '（备份 ' + (f.backup || '-') + '）' : f.error ? '（失败：' + f.error + '）' : '（无需改动）')).join('，'));
}

/* ---------------- 本地 ---------------- */

function localRun(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = raw.records || raw;
  const out = [];
  const rows = [];
  let fixed = 0;
  for (const r of list) {
    const res = recordFix.repairRecord(r);
    const rec = res.changed ? Object.assign({}, r, { players: res.players }) : r;
    out.push(rec);
    if (res.changed || res.conflicts.length) {
      rows.push({ id: r.id, at: r.at, need: res.need, patches: res.patches, conflicts: res.conflicts });
      if (res.changed) fixed++;
    }
  }
  console.log('共 ' + list.length + ' 局，需修复 ' + fixed + ' 局' + (rows.length > fixed ? '，另有 ' + (rows.length - fixed) + ' 局只报冲突未改' : ''));
  console.log('');
  printReport(rows);

  const base = path.resolve(file).replace(/\.json$/, '');
  const jsonOut = base + '-fixed.json';
  const csvOut = base + '-fixed.csv';
  if (Array.isArray(raw)) fs.writeFileSync(jsonOut, JSON.stringify(out, null, 1));
  else fs.writeFileSync(jsonOut, JSON.stringify(Object.assign({}, raw, {
    records: out, repairedAt: Date.now(), repairedNote: '金营/翠营按 log 的 byNick 与 events 的 seat+mid 回填',
  }), null, 1));

  const head = ['房号', '结束时间', '人数', '结束方式', '赤营', '青营', '金营', '翠营',
    '赤分', '青分', '金分', '翠分', '手数', '棋盘', '轮数'];
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [head.join(',')];
  for (const r of out) {
    const c = r.cfg || {}, s = r.score || {};
    lines.push([r.id, ts(r.at), c.playerCount || '', r.reason || '',
      who(r, 'A'), who(r, 'B'), who(r, 'C'), who(r, 'D'),
      s.a === undefined ? '' : s.a, s.b === undefined ? '' : s.b,
      s.c === undefined ? '' : s.c, s.d === undefined ? '' : s.d,
      r.turns || 0, c.size || '', c.rounds || ''].map(cell).join(','));
  }
  fs.writeFileSync(csvOut, '\ufeff' + lines.join('\n') + '\n');

  console.log('');
  console.log('修好的存档：' + path.relative(ROOT, jsonOut));
  console.log('汇总表：' + path.relative(ROOT, csvOut));
  if (fixed) {
    console.log('');
    console.log('注意：这只是本地副本。线上那一份要等新版上线后跑：');
    console.log('  node tools/fix_records.js --remote            # 预演');
    console.log('  node tools/fix_records.js --remote --apply    # 写回');
  }
}

(async () => {
  if (remote) return remoteRun();
  if (!given) {
    console.error('用法：node tools/fix_records.js <导出.json>  或  node tools/fix_records.js --remote [--apply]');
    process.exitCode = 1;
    return;
  }
  localRun(given);
})();
