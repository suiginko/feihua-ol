'use strict';
/* 把线上「已结束的对局」存档导出到本地：一份完整 JSON + 一份 CSV 汇总。
 *
 *   node tools/export_records.js                        # 默认导出到 exports/
 *   BASE=http://127.0.0.1:8787 node tools/export_records.js
 *   node tools/export_records.js --out exports/foo      # 指定输出前缀
 *
 * 为什么要逐局再拉一次详情：/api/records 的列表只给摘要（turns 是数字，
 * events 是条数），每一手的 log 与事件流水只在单局详情里。
 *
 * 定位一局用 rid（= 房号 + '@' + 结束时刻）。房号会复用，光用 id 只能拿到
 * 该房号最新的一局，其余拿不到 —— 所以这里优先用 rid，老版本服务端没有 rid
 * 时退回 id，并在结尾报告「有几局只能拿到摘要」。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = String(process.env.BASE || 'https://feihua-splatoon.app.workbuddy.host').replace(/\/+$/, '');
const SC = process.env.SHARECODE || 'MZA5YPLHV3';
const KEY = process.env.ADMIN_KEY || (() => {
  try { return fs.readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim(); } catch (_) { return ''; }
})();

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out') >= 0 ? argv[argv.indexOf('--out') + 1] : '';
const stamp = new Date().toISOString().slice(0, 10);
const PREFIX = outArg || path.join(ROOT, 'exports', 'records-' + stamp);

function api(p) {
  const u = BASE + p + (p.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(KEY) + '&sharecode=' + SC;
  return fetch(u, { signal: AbortSignal.timeout(30000) }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + p);
    return r.json();
  });
}

const pad = (n) => String(n).padStart(2, '0');
const ts = (ms) => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};
const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

(async () => {
  if (!KEY) { console.error('没有 admin.key，也没设 ADMIN_KEY。'); process.exitCode = 1; return; }

  const list = (await api('/api/records')).list || [];
  if (!list.length) { console.log('线上没有已结束的对局。'); return; }
  console.log('列表摘要 ' + list.length + ' 条');

  /* 逐局拉详情。新服务端每条都有 rid；老服务端只能按 id 拉到最新一局。 */
  const details = new Map();      /* rid(或 id) -> record */
  const seenId = new Set();
  let miss = 0;
  for (const s of list) {
    const rid = s.rid || (s.id + '@' + s.at);
    if (details.has(rid)) continue;
    if (!s.rid && seenId.has(s.id)) { miss++; continue; }   /* 老服务端：同房号第二局起拿不到 */
    seenId.add(s.id);
    try {
      const d = await api('/api/records?' + (s.rid ? 'rid=' + encodeURIComponent(s.rid) : 'id=' + encodeURIComponent(s.id)));
      if (d.ok && d.record) details.set(rid, d.record);
      else miss++;
    } catch (e) {
      console.error('  ' + rid + ' 拉取失败：' + e.message);
      miss++;
    }
  }
  console.log('拿到完整详情 ' + details.size + ' 局' + (miss ? '，另有 ' + miss + ' 局只有摘要' : ''));

  /* 完整 JSON：摘要 + 详情（详情里有 log/events） */
  const full = {
    exportedAt: Date.now(),
    base: BASE,
    total: list.length,
    withDetail: details.size,
    summary: list,
    records: Array.from(details.values()),
  };
  fs.mkdirSync(path.dirname(PREFIX), { recursive: true });
  fs.writeFileSync(PREFIX + '.json', JSON.stringify(full, null, 1));

  /* CSV 汇总：给 Excel 看的，带 BOM 免得中文乱码。
     四个营地都要列 —— 只写赤青的话，三人四人局的成绩在表里直接消失。
     老存档没有 C/D，留空即可。 */
  const head = ['房号', '开始', '结束', '耗时(分)', '结束原因', '赤营', '青营', '金营', '翠营',
    '赤分', '青分', '金分', '翠分', '总数', '飞行手数', '棋盘', '轮数', '每手秒数', '诗词赋文', '允许重字', '有完整明细'];
  const nm = (x, s) => (x.players && x.players[s] && x.players[s].nick) || '';
  const sc = (x, s) => (x.score && typeof x.score[s] === 'number' ? x.score[s] : '');
  const rows = list.map((x) => {
    const rid = x.rid || (x.id + '@' + x.at);
    const c = x.cfg || {};
    const k = c.kinds || {};
    const kinds = ['诗', '词', '曲', '赋', '文'].filter((n) => k[n]).join('');
    return [
      x.id, ts(x.createdAt), ts(x.at),
      x.createdAt ? Math.round((x.at - x.createdAt) / 60000) : '',
      x.reason || '',
      nm(x, 'A'), nm(x, 'B'), nm(x, 'C'), nm(x, 'D'),
      sc(x, 'a'), sc(x, 'b'), sc(x, 'c'), sc(x, 'd'), x.score ? x.score.n : '',
      x.turns, c.size ? c.size + '×' + c.size : '', c.rounds, c.turnSeconds,
      kinds, c.allowDup ? '是' : '否', details.has(rid) ? '是' : '否',
    ].map(csvCell).join(',');
  });
  fs.writeFileSync(PREFIX + '.csv', '\ufeff' + head.join(',') + '\n' + rows.join('\n') + '\n');

  console.log('已写出：');
  console.log('  ' + PREFIX + '.json   （' + Math.round(fs.statSync(PREFIX + '.json').size / 1024) + ' KB，含每一手）');
  console.log('  ' + PREFIX + '.csv    （' + Math.round(fs.statSync(PREFIX + '.csv').size / 1024) + ' KB，汇总表）');
  if (miss) {
    console.log('');
    console.log('注意：有 ' + miss + ' 局只拿到摘要。原因是这一版服务端的存档接口用「房号」定位，');
    console.log('同一房号打过多次时只能取到最新那局。新版本已加 rid（房号@结束时刻），部署后可导出全部。');
  }
})();
