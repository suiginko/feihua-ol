'use strict';
/* 把 exports/ 下所有 records-*.json 合并成一份「诗句使用频次」分析，并可选生成 HTML 报告。
 *
 *   node tools/report_poem_usage.js                # 生成 exports/poem-usage.{csv,json,html}
 *   node tools/report_poem_usage.js --top 50
 *   node tools/report_poem_usage.js --no-rejudge   # 跳过「用当前语料重判 manual 句」这一步（快）
 *
 * 口径（写进报告，别只看数字）：
 *  - 只统计 log 里 type === 'fly'（真正落子成功）；pass（让子）、争议、撤回都不算。
 *  - 按 norm（去标点后的标准串）聚合。
 *  - **排除单人模式**：playerCount === 1。老存档没有该字段时，用非空席位数兜底。
 *  - 跨文件按 rid 去重。
 *  - 因为房间默认 allowDup=false，同一句在同一局不会重复 —— 所以「次数 ≈ 用到它的局数」，
 *    这不是巧合，是规则保证的。报告里据此把「次数」「局数」「人数」三个数一起给。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
const TOP = Number(argOf('--top', 40));
const DO_REJUDGE = argv.indexOf('--no-rejudge') < 0;
const OUT = path.join(ROOT, 'exports', 'poem-usage');

/* ---------- 读取与合并 ---------- */
function pickFiles() {
  const dir = path.join(ROOT, 'exports');
  return fs.readdirSync(dir)
    .filter((n) => /^records-.*\.json$/.test(n))
    .map((n) => path.join(dir, n))
    .sort();
}

function loadGames(files) {
  const byRid = new Map();
  const perFile = [];
  for (const file of files) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      perFile.push({ file: path.basename(file), err: String(e.message || e) });
      continue;
    }
    const arr = Array.isArray(doc) ? doc : (doc.records || doc.list || []);
    let added = 0, dup = 0;
    for (const r of arr) {
      const rid = r.rid || ((r.id || '?') + '@' + (r.at || r.finishedAt || r.startedAt || 0));
      if (byRid.has(rid)) { dup++; continue; }
      byRid.set(rid, r);
      added++;
    }
    perFile.push({ file: path.basename(file), total: arr.length, added, dup });
  }
  return { games: [...byRid.values()], perFile };
}

/* 人数：优先 cfg.playerCount，老存档用非空席位兜底 */
function playerCount(g) {
  const n = g.cfg && Number(g.cfg.playerCount);
  if (n > 0) return n;
  const p = g.players || {};
  return Object.keys(p).filter((k) => p[k] && (p[k].nick || p[k].mid)).length;
}

const flyOf = (g) => (g.log || []).filter((x) => x.type === 'fly' && x.norm);

/* ---------- 统计 ---------- */
function analyze(games) {
  const scope = { allGames: 0, allFly: 0, multiGames: 0, multiFly: 0, singleGames: 0, singleFly: 0, unknown: 0 };
  const pcDist = {};
  const byPc = {};
  const poems = new Map();
  const works = new Map();
  const authors = new Map();
  const kinds = new Map();
  const lens = {};
  const mids = new Set();
  const manualNorms = new Set();
  let manualHands = 0;
  const times = [];

  for (const g of games) {
    const flies = flyOf(g);
    scope.allGames++; scope.allFly += flies.length;
    const pc = playerCount(g);
    pcDist[pc] = (pcDist[pc] || 0) + 1;
    const t = g.finishedAt || g.at || g.startedAt || 0;
    if (t) times.push(t);
    if (!pc) { scope.unknown++; continue; }
    if (pc === 1) { scope.singleGames++; scope.singleFly += flies.length; continue; }
    scope.multiGames++; scope.multiFly += flies.length;
    byPc[pc] = byPc[pc] || { games: 0, fly: 0 };
    byPc[pc].games++; byPc[pc].fly += flies.length;
    for (const k of Object.keys(g.players || {})) {
      const p = g.players[k];
      if (p && p.mid) mids.add(p.mid);
    }

    for (const it of flies) {
      const key = it.norm;
      if (!poems.has(key)) {
        poems.set(key, { norm: key, line: it.line || '', count: 0, games: 0, players: new Set(), srcCount: new Map(), manual: 0 });
      }
      const p = poems.get(key);
      p.count++; p.games++;
      if (it.byNick) p.players.add(it.byNick);
      const s = it.source || {};
      /* manual = 走人工裁决放行。判诗里 manual 有两种：语料确实没收录（无出处），
         以及事后补录了出处的。这里只算前者 —— 那才是语料缺口的证据。 */
      if (it.via === 'manual' && !(s.title)) { p.manual++; manualNorms.add(key); manualHands++; }
      if (s.title) {
        const wt = s.title;
        works.set(wt + '|' + (s.author || ''), (works.get(wt + '|' + (s.author || '')) || 0) + 1);
        authors.set(s.author || '佚名', (authors.get(s.author || '佚名') || 0) + 1);
        kinds.set(s.kind || '?', (kinds.get(s.kind || '?') || 0) + 1);
        const L = key.length;
        const b = L <= 10 ? '≤10 字' : L <= 14 ? '11–14 字' : '15–17 字';
        lens[b] = (lens[b] || 0) + 1;
        const st = s.title + (s.author ? '·' + s.author : '');
        p.srcCount.set(st, (p.srcCount.get(st) || 0) + 1);
      }
    }
  }

  const list = [...poems.values()].map((p) => {
    const top = [...p.srcCount.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const [title, author] = top[0] ? top[0].split('·') : ['', ''];
    return {
      norm: p.norm, line: p.line, count: p.count, games: p.games, players: p.players.size,
      manual: p.manual, title, author, srcMain: top[0], srcMainCount: top[1],
    };
  }).sort((a, b) => b.count - a.count || b.players - a.players || a.norm.localeCompare(b.norm));

  return {
    scope, pcDist, byPc, list, works, authors, kinds, lens, mids, manualNorms, manualHands,
    timeRange: times.length ? [Math.min(...times), Math.max(...times)] : [0, 0],
  };
}

/* ---------- 用当前语料重判 manual 句 ---------- */
function rejudge(manualNorms) {
  const J = require(path.join(ROOT, 'judge.js'));
  const opts = { allowKinds: { 诗: true, 词: true, 曲: true, 赋: true, 文: false }, maxLen: 0, unlimitedLen: true };
  let ok = 0;
  const still = [];
  const fixed = [];
  for (const n of manualNorms) {
    let r;
    try { r = J.judge(n, opts); } catch (_) { r = { ok: false }; }
    if (r.ok) {
      const s = r.source || {};
      ok++;
      fixed.push({ norm: n, title: s.title, author: s.author, dynasty: s.dynasty || '' });
    } else still.push(n);
  }
  return { total: manualNorms.size, ok, still, fixed };
}

/* ---------- 语料版本（本地工作区 / 线上） ---------- */
function localCorpus() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'meta.json'), 'utf8'));
    return { clauses: Number(m.clauses) || 0, poems: Number(m.poems) || 0, built: m.built || '' };
  } catch (_) { return { clauses: 0, poems: 0, built: '' }; }
}

async function onlineCorpus() {
  try {
    const sc = 'MZA5YPLHV3';
    const r = await fetch('https://feihua-splatoon.app.workbuddy.host/api/stats?sharecode=' + sc,
      { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return { clauses: d.judge.lines, poems: d.judge.poems, built: '' };
  } catch (_) { return { clauses: 0, poems: 0, built: '' }; }
}

/* ---------- 输出 ---------- */
async function main() {
  const files = pickFiles();
  const { games, perFile } = loadGames(files);
  const A = analyze(games);
  const R = DO_REJUDGE ? rejudge(A.manualNorms) : null;
  const corpus = localCorpus();
  const corpusOnline = await onlineCorpus();

  /* CSV：完整排名 */
  const csvEsc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = ['rank,norm,count,games,players,manual,title,author,src_main,src_main_count,line'];
  A.list.forEach((p, i) => {
    csv.push([i + 1, p.norm, p.count, p.games, p.players, p.manual, p.title, p.author, p.srcMain, p.srcMainCount, p.line].map(csvEsc).join(','));
  });
  fs.writeFileSync(OUT + '.csv', '\uFEFF' + csv.join('\r\n') + '\r\n', 'utf8');

  const dist = {};
  for (const p of A.list) dist[Math.min(p.count, 10)] = (dist[Math.min(p.count, 10)] || 0) + 1;

  const summary = {
    generatedAt: new Date().toISOString(),
    timeRange: A.timeRange,
    corpus,
    corpusOnline,
    sources: perFile,
    scope: A.scope,
    playerCountDist: A.pcDist,
    byPlayerCount: A.byPc,
    uniquePoems: A.list.length,
    reusedPoems: A.list.filter((p) => p.count > 1).length,
    singletonPoems: A.list.filter((p) => p.count === 1).length,
    usageDistribution: dist,
    manual: { hands: A.manualHands, norms: A.manualNorms.size, rejudged: R ? { total: R.total, nowOk: R.ok, stillNo: R.still.length } : null },
    top: A.list.slice(0, TOP),
    topManual: [...A.list].filter((p) => p.manual > 0).sort((a, b) => b.manual - a.manual || b.count - a.count).slice(0, 10),
    topWorks: [...A.works.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topAuthors: [...A.authors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
    kinds: [...A.kinds.entries()].sort((a, b) => b[1] - a[1]),
    lengthBuckets: A.lens,
    distinctPlayers: A.mids.size,
  };
  fs.writeFileSync(OUT + '.json', JSON.stringify(summary, null, 1), 'utf8');

  /* HTML */
  fs.writeFileSync(OUT + '.html', renderHtml(summary, R), 'utf8');

  /* 控制台摘要 */
  console.log('== 数据来源 ==');
  for (const f of perFile) {
    console.log(f.err ? '  ' + f.file + ' 读取失败: ' + f.err
      : '  ' + f.file + '  官方 ' + f.total + ' 局，新增 ' + f.added + '，重复跳过 ' + f.dup);
  }
  console.log('== 合并 ==');
  console.log('  局数 ' + A.scope.allGames + '（多人 ' + A.scope.multiGames + ' / 单人 ' + A.scope.singleGames + '）');
  console.log('  fly 手数 ' + A.scope.allFly + '（多人 ' + A.scope.multiFly + ' 手，已用于排名）');
  console.log('  不同诗句 ' + A.list.length + '，只用过 1 次 ' + summary.singletonPoems + '，重复过 ' + summary.reusedPoems);
  if (R) console.log('  manual 句 ' + R.total + ' 中，用当前语料仍判中 ' + R.ok + '（' + (R.ok / R.total * 100).toFixed(1) + '%）');
  console.log('');
  console.log('== Top ' + TOP + ' ==');
  A.list.slice(0, TOP).forEach((p, i) => {
    console.log(String(i + 1).padStart(3), String(p.count).padStart(3) + '次', String(p.players).padStart(2) + '人', p.norm, '|', p.srcMain || '未收录（争议放行）');
  });
  console.log('');
  console.log('已写出：' + OUT + '.{csv,json,html}');
}

/* ---------- HTML 模板 ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 报告只讨论古代作品：语料定位是古诗词，摘句榜单里不出现近现代作品的句子
 *（这些句子在对局里合法，只是不属于本报告的统计主题）。 */
const SKIP_PREFIX = ['天若有情天亦老', '北国风光', '江山如此多娇', '数风流人物', '雄关漫道', '红军不怕'];
const skipNorm = (n) => SKIP_PREFIX.some((p) => n.startsWith(p));

function renderHtml(S, R) {
  const d = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
  const day = (ms) => new Date(ms).toLocaleDateString('zh-CN');
  const max = S.top[0] ? S.top[0].count : 1;
  const pct = (n, base) => (base ? (n / base * 100).toFixed(2) : '0.00');

  /* Top 表 */
  const topRows = S.top.map((p, i) => {
    const w = Math.max(2, (p.count / max) * 100);
    const medal = i < 3 ? ' top' + (i + 1) : '';
    const src = p.srcMain
      ? esc(p.srcMain) + (p.srcMainCount < p.count ? '<span class="sub">（另有 ' + (p.count - p.srcMainCount) + ' 手题名不同）</span>' : '')
      : '<span class="miss">语料未收 · 争议放行</span>';
    return `<tr class="r${medal}">
      <td class="num">${i + 1}</td>
      <td class="poem"><b>${esc(p.norm)}</b><div class="meter"><i style="width:${w}%"></i></div></td>
      <td class="num big">${p.count}</td>
      <td class="num mut">${p.players}</td>
      <td class="src">${src}</td>
    </tr>`;
  }).join('');

  /* 长尾分布（1..10+）：横向条形，长度按平方根缩放，否则 3441 与 28 没法同框 */
  const distKeys = Object.keys(S.usageDistribution).map(Number).sort((a, b) => a - b);
  const distMax = Math.max(...distKeys.map((k) => S.usageDistribution[k]));
  const sq = (v) => Math.sqrt(v / distMax) * 100;
  const distRows = distKeys.map((k) => {
    const v = S.usageDistribution[k];
    const label = k >= 10 ? '10 次以上' : '用 ' + k + ' 次';
    const cls = k >= 10 ? ' agg' : '';
    return `<div class="drow${cls}">
      <span class="dl">${label}</span>
      <span class="dtrack"><i style="width:${sq(v).toFixed(1)}%"></i></span>
      <span class="dv">${v}<em>句</em></span>
      <span class="dp">${pct(v, S.uniquePoems)}%</span>
    </div>`;
  }).join('');

  /* 作者 / 作品 / 文体 / 句长 */
  const totalFly = S.scope.multiFly;
  const sitedFly = S.kinds.reduce((a, [, v]) => a + v, 0);
  const authorRows = S.topAuthors.map(([a, v], i) => `<tr>
      <td class="num">${i + 1}</td><td>${esc(a)}</td>
      <td class="num">${v}</td><td class="num mut">${pct(v, totalFly)}%</td>
      <td class="barCell"><div class="meter"><i style="width:${(v / S.topAuthors[0][1]) * 100}%"></i></div></td>
    </tr>`).join('');
  const workRows = S.topWorks.map(([w, v], i) => {
    const [t, a] = w.split('|');
    return `<tr><td class="num">${i + 1}</td><td>${esc(t)}<span class="sub">${a ? ' ·' + esc(a) : ''}</span></td>
      <td class="num">${v}</td><td class="barCell"><div class="meter"><i style="width:${(v / S.topWorks[0][1]) * 100}%"></i></div></td></tr>`;
  }).join('');
  const kindRows = S.kinds.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td>
      <td class="num mut">${pct(v, sitedFly)}%</td>
      <td class="barCell"><div class="meter"><i style="width:${(v / S.kinds[0][1]) * 100}%"></i></div></td></tr>`).join('');
  const lensTotal = Object.values(S.lengthBuckets).reduce((a, b) => a + b, 0);
  const lensRows = Object.entries(S.lengthBuckets).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td>
      <td class="num mut">${pct(v, lensTotal)}%</td>
      <td class="barCell"><div class="meter"><i style="width:${(v / Math.max(...Object.values(S.lengthBuckets))) * 100}%"></i></div></td></tr>`).join('');

  /* 争议放行 */
  const manRows = S.topManual.filter((p) => !skipNorm(p.norm)).slice(0, 8).map((p) => `<tr>
      <td>${esc(p.norm)}</td><td class="num">${p.manual}</td><td class="num mut">${p.count}</td></tr>`).join('');
  const fixedRows = R ? R.fixed.filter((f) => f.dynasty !== '现代' && !skipNorm(f.norm)).slice(0, 10).map((f) => `<tr><td>${esc(f.norm)}</td><td class="mut">${esc(f.title || '')}${f.author ? ' ·' + esc(f.author) : ''}${f.dynasty ? '［' + esc(f.dynasty) + '］' : ''}</td></tr>`).join('') : '';
  const stillRows = R ? R.still.filter((n) => n.length <= 17 && !skipNorm(n)).slice(0, 8).map((n) => `<tr><td>${esc(n)}</td></tr>`).join('') : '';
  const stillLong = R ? R.still.filter((n) => n.length > 17).length : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>飞花斯普拉遁 · 诗句使用频次分析</title>
<style>
  :root{
    --ink-a:#C2352A; --ink-b:#1F79C4; --ink-c:#DE9B00; --ink-d:#18864B;
    --bg:#F4F6FA; --card:#FFFFFF; --text:#1F2937; --muted:#5B6B84; --line:#DCE3EE;
    --blank:#EDF1F7; --gold:#8A6A1F;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.72 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}
  .wrap{max-width:1080px;margin:0 auto;padding:36px 22px 80px}
  header{border-bottom:2px solid var(--text);padding-bottom:16px;margin-bottom:26px}
  h1{margin:0 0 6px;font-size:27px;letter-spacing:.06em;font-weight:700}
  .kicker{font-size:12px;letter-spacing:.22em;color:var(--muted);text-transform:uppercase}
  .lede{color:var(--muted);font-size:13px;margin-top:8px}
  h2{font-size:17px;margin:38px 0 12px;padding-left:11px;border-left:4px solid var(--ink-a);
    letter-spacing:.04em}
  h2 small{font-weight:400;font-size:12px;color:var(--muted);letter-spacing:0;margin-left:10px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0 4px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .card .k{font-size:11.5px;color:var(--muted);letter-spacing:.08em}
  .card .v{font-size:26px;font-weight:700;line-height:1.25;font-variant-numeric:tabular-nums}
  .card .u{font-size:11.5px;color:var(--muted);margin-top:2px}
  .card.a .v{color:var(--ink-a)} .card.b .v{color:var(--ink-b)}
  .card.c .v{color:var(--gold)} .card.d .v{color:var(--ink-d)}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);
    border-radius:10px;overflow:hidden;font-variant-numeric:tabular-nums}
  th{background:var(--blank);text-align:left;font-size:11.5px;letter-spacing:.08em;color:var(--muted);
    font-weight:600;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  .num{text-align:right;white-space:nowrap;width:1%;font-variant-numeric:tabular-nums}
  .big{font-size:15px;font-weight:700}
  .mut{color:var(--muted);font-size:12.5px}
  .sub{color:var(--muted);font-size:11.5px}
  .miss{color:var(--ink-a);font-size:12px}
  .poem b{font-size:14.5px;letter-spacing:.04em;font-weight:600}
  .src{font-size:12.5px;color:var(--muted);width:31%}
  .meter{height:5px;background:var(--blank);border-radius:3px;margin-top:5px;overflow:hidden;min-width:80px}
  .meter i{display:block;height:100%;background:linear-gradient(90deg,#8FA3BF,#1F79C4);border-radius:3px}
  tr.top1 .meter i{background:linear-gradient(90deg,#C2352A,#8E1F17)}
  tr.top2 .meter i{background:linear-gradient(90deg,#D08C36,#8A5A12)}
  tr.top3 .meter i{background:linear-gradient(90deg,#C9A94A,#7E6520)}
  tr.top1 td.num:first-child,tr.top2 td.num:first-child,tr.top3 td.num:first-child{font-weight:700;font-size:15px}
  .barCell{width:34%}
  .dist{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 16px}
  .drow{display:grid;grid-template-columns:90px 1fr 74px 56px;align-items:center;gap:12px;
    padding:5px 0;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
  .drow:last-child{border-bottom:0}
  .drow.agg .dl{font-weight:700}
  .dl{font-size:12.5px;color:var(--muted)}
  .drow.agg .dl{color:var(--text)}
  .dtrack{height:15px;background:var(--blank);border-radius:4px;overflow:hidden}
  .dtrack i{display:block;height:100%;background:linear-gradient(90deg,#8FA3BF,#1F79C4);border-radius:4px}
  .drow:first-child .dtrack i{background:linear-gradient(90deg,#C2352A,#8E1F17)}
  .drow.agg .dtrack i{background:linear-gradient(90deg,#D08C36,#8A6A1F)}
  .dv{text-align:right;font-size:13px;font-weight:600}
  .dv em{font-style:normal;font-size:10.5px;color:var(--muted);font-weight:400;margin-left:2px}
  .dp{text-align:right;font-size:11.5px;color:var(--muted)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:820px){.cols{grid-template-columns:1fr}.src{width:auto}}
  .note{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--ink-c);
    border-radius:0 10px 10px 0;padding:14px 18px;font-size:13px;color:var(--text);margin:16px 0}
  .note b{color:var(--gold)}
  .note.a{border-left-color:var(--ink-a)} .note.a b{color:var(--ink-a)}
  .note.b{border-left-color:var(--ink-b)} .note.b b{color:var(--ink-b)}
  ol.why{margin:8px 0 0;padding-left:22px;color:var(--muted);font-size:13px}
  ol.why li{margin:5px 0}
  code{background:var(--blank);padding:1px 5px;border-radius:4px;font-size:12.5px;
    font-family:ui-monospace,Consolas,monospace}
  footer{margin-top:44px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="kicker">飞花斯普拉遁 · 对局数据</div>
  <h1>哪些诗句被玩家用得最多</h1>
  <div class="lede">
    数据范围 ${day(S.timeRange[0])} – ${day(S.timeRange[1])}　·　
    合并 ${S.sources.length} 份导出、${S.scope.allGames} 局对局　·　
    <b>已排除单人模式</b>（${S.scope.singleGames} 局 / ${S.scope.singleFly} 手）
  </div>
</header>

<div class="cards">
  <div class="card a"><div class="k">多人对局</div><div class="v">${S.scope.multiGames}</div><div class="u">占全部 ${pct(S.scope.multiGames, S.scope.allGames)}%</div></div>
  <div class="card b"><div class="k">有效落子</div><div class="v">${S.scope.multiFly.toLocaleString()}</div><div class="u">手（平均每局 ${(S.scope.multiFly / S.scope.multiGames).toFixed(1)} 手）</div></div>
  <div class="card c"><div class="k">不同诗句</div><div class="v">${S.uniquePoems.toLocaleString()}</div><div class="u">其中 ${S.singletonPoems} 句只用过 1 次</div></div>
  <div class="card d"><div class="k">参与玩家</div><div class="v">${S.distinctPlayers}</div><div class="u">按设备指纹去重</div></div>
</div>

<div class="note b">
  <b>为什么没有「一句被用 500 次」这种事。</b>
  房间默认 <code>allowDup=false</code>，同一句在一局里只能出现一次 —— 所以「使用次数」实质等于
  「<b>有多少局用到了它</b>」，「次数 / 局数」两列必然相等。真正能区分冷热的第三个数是
  <b>独立玩家数</b>：同一句由 28 个不同的人各用一次，比一个人连用 28 局有意义得多。
</div>

<h2>使用次数排行<small>多人局 · 按标准化后的完整诗句聚合</small></h2>
<table>
  <thead><tr><th class="num">#</th><th>诗句</th><th class="num">次数</th><th class="num">人数</th><th>出处</th></tr></thead>
  <tbody>${topRows}</tbody>
</table>

<h2>长尾有多长<small>用过 N 次的诗句各有多少句 · 条形按平方根缩放</small></h2>
<div class="dist">${distRows}</div>
<div class="note">
  <b>头部极薄、尾部极长。</b>
   ${S.uniquePoems} 句里，${pct(S.reusedPoems, S.uniquePoems)}%（${S.reusedPoems} 句）被用过 ≥2 次，
   其余 ${pct(S.singletonPoems, S.uniquePoems)}%（${S.singletonPoems} 句）只用过一次。
   榜首那句 ${S.top[0].count} 手，也只占全部落子的 ${pct(S.top[0].count, S.scope.multiFly)}% ——
   玩家的选句几乎不重复，这正是「棋盘字池 + 轮流出题」想要的效果。
</div>

<h2>谁被引用得最多<small>按作者 / 作品 / 文体 / 句长　·　作者与作品占比以 ${S.scope.multiFly.toLocaleString()} 手为基数，文体与句长只统计有出处的 ${sitedFly.toLocaleString()} 手</small></h2>
<div class="cols">
  <table>
    <thead><tr><th class="num">#</th><th>作者</th><th class="num">手</th><th class="num">占比</th><th>　</th></tr></thead>
    <tbody>${authorRows}</tbody>
  </table>
  <table>
    <thead><tr><th class="num">#</th><th>作品</th><th class="num">手</th><th>　</th></tr></thead>
    <tbody>${workRows}</tbody>
  </table>
</div>

<div class="cols" style="margin-top:16px">
  <table>
    <thead><tr><th>文体</th><th class="num">手</th><th class="num">占比</th><th>　</th></tr></thead>
    <tbody>${kindRows}</tbody>
  </table>
  <table>
    <thead><tr><th>提交句长</th><th class="num">手</th><th class="num">占比</th><th>　</th></tr></thead>
    <tbody>${lensRows}</tbody>
  </table>
</div>

<h2>一个被数据暴露出来的问题<small>「未收录 → 争议 → 对手放行」的手</small></h2>
<div class="note a">
  ${S.manual.hands} 手（占 ${pct(S.manual.hands, S.scope.multiFly)}%）走的是<b>语料未收录、由对手人工裁定有效</b>的通道，
  涉及 ${S.manual.norms} 个不同句子。这些句子没有出处，<b>不进上面的排行</b> ——
  但它们是语料库缺口的直接证据。
  ${R ? `用当前语料重新判定这 ${R.total} 句：<b>${R.ok} 句已能判中（${pct(R.ok, R.total)}%）</b>，
  还剩 ${R.still.length} 句判不中，其中 ${stillLong} 句超过 17 字（整段抄录或长句体例，本就超出上限）。` : ''}
  <div class="sub" style="margin-top:6px">重判基准 = 本地工作区语料（${S.corpus.clauses.toLocaleString()} 句）；
  线上此刻是 ${S.corpusOnline.clauses.toLocaleString()} 句那一版，所以「已能判中」里有一部分是尚未发布的扩充带来的。</div>
</div>
<div class="cols">
  <div>
    <table>
      <thead><tr><th>争议放行最多的句子</th><th class="num">放行</th><th class="num">总用</th></tr></thead>
      <tbody>${manRows}</tbody>
    </table>
  </div>
  <div>
    <table>
      <thead><tr><th>其余句子（≤17 字、当前语料仍判不中，样本）</th></tr></thead>
      <tbody>${stillRows}</tbody>
    </table>
  </div>
</div>
${R && R.fixed.length ? `<h2>语料改进已经生效<small>当时语料未收、现在能直接判中的句子（示例取自古代作品）</small></h2>
<table>
  <thead><tr><th>句子</th><th>现在的出处</th></tr></thead>
  <tbody>${fixedRows}</tbody>
</table>
<div class="note">
  这些句子在 10-21 / 10-22 的对局里要走人工裁决，现在直接命中 —— 语料扩容与重分类是有效的。
  剩下的判不中句主要落在三类上，都<code>不是</code>语料缺失：
</div>
<ol class="why">
  <li><b>玩家记错字</b>：如「天生我才必有用」（应为「天生我<u>材</u>必有用」）。</li>
  <li><b>一次抄了整段</b>：如《陋室铭》「山不在高…草色入帘青」，远超 17 字上限，属规则限制而非未收录。</li>
  <li><b>成语 / 俗语 / 戏曲念白</b>：如「精诚所至金石为开」「良辰美景奈何天」，本来就不是「诗句」。</li>
</ol>` : ''}

<h2>统计口径</h2>
<table>
  <thead><tr><th>项</th><th>处理方式</th></tr></thead>
  <tbody>
    <tr><td>计入的手</td><td>只算 <code>log</code> 里 <code>type === 'fly'</code> 的落子；让子（pass）、争议、撤回不计</td></tr>
    <tr><td>聚合键</td><td>去标点后的标准串 <code>norm</code>，同一句的不同标点写法合并</td></tr>
    <tr><td>单人模式</td><td><code>cfg.playerCount === 1</code> 全部排除（${S.scope.singleGames} 局 / ${S.scope.singleFly} 手）；老存档缺该字段时按非空席位数兜底</td></tr>
    <tr><td>去重</td><td>跨文件按 <code>rid</code>（房号@结束时刻）去重，避免同一局被多份导出重复计入</td></tr>
    <tr><td>出处</td><td>取该句在手写记录里出现最多的 <code>source</code>；有异名时在括号里注明手数。<b>出处是当时判定的结果</b>，语料更新后可能变化（如「白日依山尽」老记录判为《登楼·朱斌》，当前语料判为《登鹳雀楼·王之涣》）</td></tr>
    <tr><td>语料版本</td><td>排行榜的出处是<b>每局当时的判定结果</b>；文末「现在能否判中」用<b>本地工作区语料</b>重判（${S.corpus.clauses.toLocaleString()} 句 / ${S.corpus.poems.toLocaleString()} 篇，${esc(S.corpus.built)} 构建），线上当前是 ${S.corpusOnline.clauses.toLocaleString()} 句那一版</td></tr>
  </tbody>
</table>

<footer>
  生成于 ${d(Date.now())}　·　数据来自 ${S.sources.length} 份导出：
  ${S.sources.filter((f) => !f.err).map((f) => esc(f.file)).join('、')}<br>
  复现：<code>node tools/report_poem_usage.js</code>　·　原始排行榜见 <code>exports/poem-usage.csv</code>
</footer>

</div>
</body>
</html>`;
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
