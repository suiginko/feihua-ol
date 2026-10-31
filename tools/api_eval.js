'use strict';
/* 评测：诗泉（poetry.palemoky.com）/api/search 能否直接当判诗裁判用
 *
 * 目的：拿本地语料判诗（judge.js）当基准，逐句对比外部接口
 *   正样本 = 本地能判有效的真实诗句（随机抽样）
 *   负样本 = 同一句改一个字 / 打乱语序，且本地判无效
 * 指标：命中率(recall)、误放行率(false accept)、耗时、错误码
 */
const https = require('https');
const j = require('../judge');

const HOST = 'poetry.palemoky.com';
const LIMIT = Number(process.argv[2] || 100);
const CONC = 3;

function get(q) {
  const path = '/api/search?type=content&q=' + encodeURIComponent(q);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get({ host: HOST, path, timeout: 15000 }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let hit = false, n = 0, err = '';
        try {
          const o = JSON.parse(buf);
          if (o.error) err = o.error.code;
          else {
            n = (o.data || []).length;
            hit = (o.data || []).some((p) => {
              const txt = (p.content || []).join('\n');
              return txt.indexOf(q) >= 0;
            });
          }
        } catch (e) { err = 'BAD_JSON'; }
        resolve({ hit, n, err, ms: Date.now() - t0, status: res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ hit: false, n: 0, err: 'TIMEOUT', ms: Date.now() - t0, status: 0 }); });
    req.on('error', (e) => resolve({ hit: false, n: 0, err: 'NET:' + e.code, ms: Date.now() - t0, status: 0 }));
  });
}

async function pool(items, fn, conc) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

(async () => {
  const st = j.load();
  console.log(`本地语料：${st.lines} 句 / ${st.poems} 篇`);
  // 取本地句表（通过 judge 内部不可直接拿，这里用 blob 重读）
  const fs = require('fs'), zlib = require('zlib'), path = require('path');
  const blob = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../data/clauses.txt.gz'))).toString('utf8');
  const lines = blob.split('\n').filter((s) => s.length >= 5 && s.length <= 30);

  // 正样本：随机真实句（确保本地判 ok）
  const pos = [];
  const seen = new Set();
  while (pos.length < LIMIT && seen.size < lines.length) {
    const s = lines[Math.floor(Math.random() * lines.length)];
    if (seen.has(s)) continue;
    seen.add(s);
    const r = j.judge(s);
    if (r.ok) pos.push({ q: s, local: r.code });
  }

  // 负样本：改一字（保证本地拒）
  const neg = [];
  const CH = '风花雪月山水云天地人心秋春夜雨烟霜露松竹梅兰菊酒诗书剑舟灯'.split('');
  while (neg.length < LIMIT) {
    const s = lines[Math.floor(Math.random() * lines.length)];
    if (s.length < 5) continue;
    const i = Math.floor(Math.random() * s.length);
    const c = CH[Math.floor(Math.random() * CH.length)];
    if (s[i] === c) continue;
    const q = s.slice(0, i) + c + s.slice(i + 1);
    if (j.judge(q).ok) continue;          // 改完仍是真句，不当负样本
    neg.push({ q, base: s });
  }

  console.log(`正样本 ${pos.length} 条，负样本 ${neg.length} 条，并发 ${CONC}\n`);
  const t0 = Date.now();
  const rp = await pool(pos, (o) => get(o.q), CONC);
  const rn = await pool(neg, (o) => get(o.q), CONC);
  const ms = Date.now() - t0;

  const summarize = (label, rows) => {
    const total = rows.length;
    const hit = rows.filter((r) => r.hit).length;
    const errs = rows.filter((r) => r.err).length;
    const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length * 0.5)];
    const p95 = lat[Math.floor(lat.length * 0.95)];
    return { label, total, hit, errs, rate: (hit / total * 100).toFixed(1), p50, p95 };
  };

  const sp = summarize('本地判有效的真句 → 接口也命中', rp);
  const sn = summarize('本地判无效的改字句 → 接口误命中', rn);
  console.log('【正样本】' + sp.label);
  console.log(`  命中 ${sp.hit}/${sp.total} = ${sp.rate}%   出错 ${sp.errs}   延迟 p50 ${sp.p50}ms / p95 ${sp.p95}ms\n`);
  console.log('【负样本】' + sn.label);
  console.log(`  误命中 ${sn.hit}/${sn.total} = ${sn.rate}%（越低越好）   出错 ${sn.errs}   延迟 p50 ${sn.p50}ms / p95 ${sn.p95}ms\n`);
  console.log(`总耗时 ${(ms / 1000).toFixed(1)}s，平均 ${(ms / (pos.length + neg.length)).toFixed(0)}ms/次\n`);

  const miss = rp.map((r, i) => Object.assign({ q: pos[i].q }, r)).filter((r) => !r.hit).slice(0, 15);
  console.log('漏判样例（接口查不到的真句）：');
  for (const m of miss) {
  
    console.log(`  ${m.q}   [${m.err || m.n + ' 条无关结果'}]`);
  }
  const bad = neg.filter((r) => r.hit).slice(0, 15);
  console.log('\n误放样例（改字假句被接口认了）：');
  for (const b of bad) {
  
    console.log(`  ${b.q}`);
  }
  fs.writeFileSync(path.join(__dirname, '../.workbuddy/api_eval.json'), JSON.stringify({ pos, rp, neg, rn }, null, 1));
})();
