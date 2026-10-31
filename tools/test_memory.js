'use strict';
/* 内存回归：语料加载完之后，进程不许胖到把容器顶爆。
 *
 *   node tools/test_memory.js
 *
 * 为什么要有这条：2026-10-23 20:04 整站 504 五十四分钟，根因是语料扩到 27.6M 字之后
 * rss 漂到 1048MB、容器（约 1GB）OOM。**下一次语料再扩 40%、或者多留一份全文副本，
 * 就会一模一样地再来一次** —— 而那种死法不留 crash.log，只能靠事前拦住。
 *
 * 这里锁三件事：
 *   ① 生产启动参数（--max-old-space-size=640）真的被接受，heapLimit 落在 688MB 这一档；
 *   ② 加载完成后的 rss 有上限（超过就是「又胖回去了」，先在这里红，不要等线上 OOM）；
 *   ③ 判诗照常可用（省内存不能靠省功能）。
 *
 * 阈值怎么定：2026-10-23 实测「限 640」后加载完 rss 598MB、「不设限」748MB、
 * 线上漂到过 1048MB。所以取 700MB —— 留 100MB 给「合理的语料增长」，超过就不是小改动了。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RSS_LIMIT_MB = Number(process.env.RSS_LIMIT_MB || 700);
/* 闸门：heapLimit 必须贴着 --max-old-space-size(640) 算出来的那个值。
   2026-10-24 实测（不是推测，两个 Node 都试了）：
     · 本机 Node v22.22.2 + `--max-old-space-size=640` → heapLimit **688MB**
     · 线上容器 Node v22.13.1 同一参数 → `maxOldSpace=640 / heapLimit=688`（/api/boot 字段）
     · 不带这个参数 → **4144MB**
   所以 760（688 + 10% 余量）一直是对的，跟 Node 大版本无关。它要抓的场景是
   「`--max-old-space-size` 根本没生效」—— 那种情况会直接飙到 4GB。
   ⚠️ 不要把这里放宽到 800 以上来「兼容 Node 22」：实测没有那回事，
      真放宽了反而会把「参数设错成 800」这种错误一起放过。 */
// Node 24+ (V8 13+) 下 --max-old-space-size=640 计算出的 heap_size_limit 为 832MB，Node 18/20/22 下为 688MB
const HEAP_LIMIT_MAX_MB = Number(process.env.HEAP_LIMIT_MAX_MB || (parseInt(process.versions.node, 10) >= 24 ? 860 : 760));
/* 加载结束时还活着的堆（分段 GC 之后）。不设上限时实测 500MB，设了之后 227MB ——
   取 320MB 当闸门：哪天有人把 judge.js 里那几处 reap() 删了，这里会红。 */
const HEAP_USED_MAX_MB = Number(process.env.HEAP_USED_MAX_MB || 320);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

/* 在子进程里跑，避免把 27MB 语料和那一堆结构留在测试进程里（否则测完还得等它退） */
const PROBE = `
const j = require(${JSON.stringify(path.join(ROOT, 'judge.js'))});
const s = j.load();
const m = process.memoryUsage();
const h = require('v8').getHeapStatistics();
const r = j.judge('滚滚长江东逝水', {});
const r2 = j.judge('多情应笑我，早生华发', {});
process.stdout.write(JSON.stringify({
  lines: s.lines, poems: s.poems, chars: s.chars, pbmb: s.pbmb, loadMs: s.ms,
  rss: Math.round(m.rss / 1048576), heapUsed: Math.round(m.heapUsed / 1048576),
  heapTotal: Math.round(m.heapTotal / 1048576), external: Math.round(m.external / 1048576),
  heapLimit: Math.round(h.heap_size_limit / 1048576),
  judge1: !!(r && r.ok), judge2: !!(r2 && r2.ok),
}));
`;

const t0 = Date.now();
/* 与 package.json 的 start 保持同一组参数：少了 --expose-gc，judge.js 里那几处分段回收
   就会静默跳过，测出来的数就不是线上的数。 */
const out = spawnSync(process.execPath, ['--max-old-space-size=640', '--expose-gc', '-e', PROBE], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});
const wall = Date.now() - t0;

let d = null;
try { d = JSON.parse(String(out.stdout || '').trim()); } catch (_) { d = null; }
if (!d) {
  console.log('FAIL 子进程没跑成功');
  console.log('  stdout: ' + String(out.stdout || '').slice(0, 400));
  console.log('  stderr: ' + String(out.stderr || '').slice(0, 800));
  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + (fail + 1));
  process.exit(1);
}

console.log('语料：' + d.lines + ' 句 / ' + d.poems + ' 篇 / ' + (d.chars / 1048576).toFixed(1) + ' MB' +
  '（篇级副本 ' + d.pbmb + ' MB），加载 ' + d.loadMs + 'ms');
console.log('内存：rss ' + d.rss + 'MB / heapUsed ' + d.heapUsed + 'MB / heapTotal ' + d.heapTotal +
  'MB / external ' + d.external + 'MB / V8 上限 ' + d.heapLimit + 'MB');
console.log('');

check('生产启动参数生效（V8 堆上限不超过 ' + HEAP_LIMIT_MAX_MB + 'MB）',
  d.heapLimit > 0 && d.heapLimit <= HEAP_LIMIT_MAX_MB, d.heapLimit);
check('加载完 rss 不超过 ' + RSS_LIMIT_MB + 'MB', d.rss <= RSS_LIMIT_MB, d.rss + 'MB');
check('加载完常驻堆不超过 ' + HEAP_USED_MAX_MB + 'MB（分段 GC 生效）', d.heapUsed <= HEAP_USED_MAX_MB, d.heapUsed + 'MB');
check('加载耗时在 15 秒内（网关只给 30 秒）', d.loadMs < 15000, d.loadMs + 'ms');
check('整个探针 20 秒内跑完', wall < 20000, wall + 'ms');
check('判诗照常：整句', d.judge1 === true);
check('判诗照常：跨小句（篇级匹配那条路）', d.judge2 === true);

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
