'use strict';
/* 名句定向探针：本机 IP 已被 Cloudflare 限流封禁（403），改走 r.jina.ai 代理取数 */
const https = require('https');
const j = require('../judge');

const REAL = ['床前明月光', '举头望明月', '粉骨碎身浑不怕', '落霞与孤鹜齐飞', '关关雎鸠',
  '枯藤老树昏鸦', '白日依山尽', '春眠不觉晓', '停车坐爱枫林晚', '天生我材必有用',
  '海上生明月', '独钓寒江雪', '人比黄花瘦', '众里寻他千百度', '人生自古谁无死',
  '不是花中偏爱菊', '我劝天公重抖擞', '江山代有才人出', '一蓑烟雨任平生',
  '春风又绿江南岸', '明月几时有', '把酒问青天', '天涯何处无芳草'];
const FAKE = ['床前望明月', '春风又绿江北岸', '人生自古谁无生', '白日依山飞',
  '天生我材必有才', '落霞与孤鹜齐飞飞'];

function one(q) {
  const target = 'https://poetry.palemoky.com/api/search?type=content&q=' + encodeURIComponent(q);
  const path = '/https://poetry.palemoky.com/api/search?type=content&q=' + encodeURIComponent(q);
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get({ host: 'r.jina.ai', path, timeout: 45000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        const m = b.match(/\{[\s\S]*\}$/m);
        let err = '', n = 0, hit = false;
        try {
          const o = JSON.parse((m ? m[0] : b).trim());
          if (o.error) err = o.error.code + ':' + o.error.message;
          else {
            n = (o.data || []).length;
            hit = (o.data || []).some((p) => (p.content || []).join('\n').indexOf(q) >= 0);
          }
        } catch (e) { err = 'NO_JSON[' + res.statusCode + ']'; }
        resolve({ q, hit, n, err, ms: Date.now() - t0 });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ q, hit: false, n: 0, err: 'TIMEOUT', ms: Date.now() - t0 }); });
    req.on('error', (e) => resolve({ q, hit: false, n: 0, err: 'NET:' + e.code, ms: Date.now() - t0 }));
  });
}

(async () => {
  j.load();
  const rows = [];
  for (const q of REAL.concat(FAKE)) {
    const r = await one(q);
    const local = j.judge(q);
    r.localOk = local.ok;
    r.localVia = local.code;
    rows.push(r);
    console.log(`${r.hit ? 'HIT ' : 'MISS'} ${q.padEnd(9)} 接口${String(r.n).padStart(2)}条 ${r.err || ''} ${r.ms}ms  | 本地 ${local.ok ? 'OK/' + local.code : 'NO'}`);
    await new Promise((s) => setTimeout(s, 900));
  }
  const realRows = rows.slice(0, REAL.length);
  const fakeRows = rows.slice(REAL.length);
  const okReal = realRows.filter((r) => r.localOk).length;
  const hit = realRows.filter((r) => r.hit).length;
  const errs = rows.filter((r) => r.err).length;
  console.log(`\n名句 ${REAL.length} 条（本地全判有效）→ 接口命中 ${hit}，漏判 ${REAL.length - hit}，命中率 ${(hit / REAL.length * 100).toFixed(0)}%`);
  console.log(`伪句 ${FAKE.length} 条 → 接口误放行 ${fakeRows.filter((r) => r.hit).length}，出错 ${errs}`);
  require('fs').writeFileSync(__dirname + '/../.workbuddy/api_named.json', JSON.stringify(rows, null, 1));
})();
