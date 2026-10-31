'use strict';
/* 反向评测：从诗泉随机取诗，看本地判诗能不能覆盖
 * —— 量化「把外部接口并进来」到底能补多少召回 */
const https = require('https');
const j = require('../judge');

const N = Number(process.argv[2] || 25);

function getJson(path) {
  return new Promise((resolve) => {
    const req = https.get({ host: 'r.jina.ai', path: '/https://poetry.palemoky.com' + path, timeout: 45000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        const m = b.match(/\{[\s\S]*\}$/m);
        try { resolve(JSON.parse((m ? m[0] : b).trim())); } catch (e) { resolve({ _err: 'NO_JSON' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ _err: 'TIMEOUT' }); });
    req.on('error', (e) => resolve({ _err: e.code }));
  });
}

(async () => {
  j.load();
  let total = 0, miss = 0, poems = 0, errs = 0;
  const missList = [];
  for (let i = 0; i < N; i++) {
    const o = await getJson('/api/poems/random');
    const p = o && o.data;
    if (!p || !p.content) { errs++; continue; }
    poems++;
    for (const rawLine of p.content) {
      for (const clause of String(rawLine).split(/[，。！？；、,.!?;:：「」『』（）()]/)) {
        const s = clause.replace(/[^\u4e00-\u9fa5]/g, '');
        if (s.length < 5) continue;
        total++;
        if (!j.judge(s).ok) { miss++; if (missList.length < 12) missList.push(s + '  ——' + p.author.name + '《' + p.title + '》'); }
      }
    }
    await new Promise((s) => setTimeout(s, 600));
  }
  console.log(`随机取 ${poems} 首（失败 ${errs}），切出 ${total} 个 5 字以上分句`);
  console.log(`本地判否 ${miss} 条 = ${(miss / total * 100).toFixed(1)}%  → 本地召回 ${(100 - miss / total * 100).toFixed(1)}%`);
  console.log('\n本地判否样例：');
  for (const m of missList) console.log('  ' + m);
})();
