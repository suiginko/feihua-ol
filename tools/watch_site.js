'use strict';
/* 站点探活：一条命令判断「现在到底是不是挂了」，挂在哪一层。
 *
 *   node tools/watch_site.js                 # 人看：打印诊断 + 退出码 0/1
 *   node tools/watch_site.js --json          # 给定时任务/告警用：只输出一行 JSON
 *   node tools/watch_site.js --rounds=3 --gap=8000
 *
 * 2026-10-23 的教训：整站 504 挂了 54 分钟，最后是玩家来反馈才知道的。
 * 这个脚本就是为了让「挂」这件事在 5 分钟内自己喊出来，而不是等人来问。
 *
 * 判读规则（与 AGENTS.md 陷阱 23 / 36 一致）：
 *   · 504 + 启动记录没有新增 → 进程没监听（OOM / 崩了），**只能重新发布**
 *   · 504/525 + 解析不到       → 域名或网关问题，改代码没用
 *   · 200 但 rssPeak 逼近 heapLimit → 快被 OOM，趁还活着先处理
 *
 * 退出码：0 = 正常；1 = 挂了；2 = 能连上但内存/启动异常（亚健康）。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const BASE = (process.env.BASE || 'https://feihua-splatoon.app.workbuddy.host').replace(/\/+$/, '');
const SHARECODE = process.env.SHARECODE || 'MZA5YPLHV3';
const arg = (name, def) => {
  const hit = (process.argv || []).find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const ROUNDS = Math.max(1, Number(arg('rounds', 2)) || 2);
const GAP = Math.max(0, Number(arg('gap', 6000)) || 0);
const JSON_OUT = process.argv.includes('--json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function adminKey() {
  try { return fs.readFileSync(path.join(ROOT, 'admin.key'), 'utf8').trim(); } catch (_) { return ''; }
}

async function fetchJson(p, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, ms);
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, { cache: 'no-store', signal: ctl.signal });
    const text = await r.text();
    let d = null;
    try { d = JSON.parse(text); } catch (_) { d = null; }
    return { status: r.status, ms: Date.now() - t0, body: d, text: text.slice(0, 200) };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message) };
  } finally {
    clearTimeout(timer);
  }
}

/* 从网关的错误体里认出是哪一类：504 = 应用没监听；525/524 = 边缘节点问题 */
function classify(res) {
  if (res.status === 0) return { state: 'down', why: '连不上（' + (res.error || '未知') + '）' };
  if (res.status === 200) return { state: 'up', why: '' };
  const msg = (res.body && res.body.msg) || res.text || '';
  if (/not ready after/i.test(msg)) return { state: 'down', why: '504 应用没监听（进程没起来，等平台重启没用，直接重新发布）' };
  if (res.status === 525 || res.status === 524) return { state: 'down', why: res.status + ' 边缘节点/回源问题（先看域名与解析）' };
  if (res.status === 403) return { state: 'gate', why: '403 网关没带 sharecode（不是故障）' };
  return { state: 'bad', why: 'HTTP ' + res.status };
}

(async () => {
  const probes = [];
  let lastStats = null;
  for (let i = 0; i < ROUNDS; i++) {
    const r = await fetchJson('/api/stats?' + 'sharecode=' + SHARECODE, 12000);
    const c = classify(r);
    probes.push({ status: r.status, ms: r.ms, state: c.state, why: c.why });
    if (c.state === 'up' && r.body) lastStats = r.body;
    if (i < ROUNDS - 1) await sleep(GAP);
  }

  const upCount = probes.filter((p) => p.state === 'up').length;
  const downCount = probes.filter((p) => p.state === 'down').length;
  const state = downCount === probes.length ? 'down' : (upCount === probes.length ? 'up' : 'flaky');

  /* 活着的时候顺手看一眼内存与启动记录 —— 亚健康的信号比「已经挂了」更值钱 */
  let health = null;
  if (state === 'up' && lastStats) {
    const rss = Number(lastStats.rss) || 0;
    const peak = Number(lastStats.rssPeak) || 0;
    const limit = Number(lastStats.heapLimit) || 0;
    const maxOld = Number(lastStats.maxOldSpace) || 0;
    /* 判据不是「峰值贴近 heapLimit」—— 有上限时 V8 本来就在上限附近回收，那是正常状态（实测峰值 673/688）。
       真正危险的是两种：① 上限压根没生效（maxOldSpace=0），rss 会无约束地漂；② 峰值已经越过 900MB，
       离容器那 1GB 只剩一口气。 */
    const memWarn = peak > 900 || (!maxOld && peak > 700);
    health = {
      rss, rssPeak: peak, heapLimit: limit, maxOldSpace: maxOld,
      rooms: lastStats.rooms, uptime: lastStats.uptime,
      heapCapWarn: !maxOld,
      memWarn,
    };
  }

  const code = state === 'down' ? 1 : ((health && (health.memWarn || health.heapCapWarn)) ? 2 : 0);

  if (JSON_OUT) {
    console.log(JSON.stringify({
      base: BASE, at: new Date().toISOString(), state, code,
      ok: upCount, total: probes.length, probes, health,
      verdict: state === 'down' ? '站点挂了' : (state === 'flaky' ? '时好时坏' : '正常'),
    }));
    process.exit(code);
    return;
  }

  console.log('探测 ' + BASE + '  共 ' + probes.length + ' 轮');
  probes.forEach((p, i) => {
    console.log('  [' + (i + 1) + '] HTTP ' + (p.status || '---') + '  ' + p.ms + 'ms  ' +
      (p.state === 'up' ? '正常' : p.why));
  });
  if (health) {
    console.log('');
    console.log('内存：rss ' + health.rss + 'MB / 峰值 ' + health.rssPeak + 'MB / V8 上限 ' + health.heapLimit + 'MB');
    console.log('房间 ' + health.rooms + ' 间，已运行 ' + Math.round(health.uptime / 60) + ' 分钟');
    if (health.heapCapWarn) console.log('⚠️ maxOldSpace 为 0 —— 启动参数没生效，rss 会一路漂到 1GB 再被 OOM');
    if (health.memWarn) console.log('⚠️ 峰值已经贴近上限 —— 下一次加载峰值就可能被 OOM，尽早处理');
  }
  console.log('');
  if (state === 'down') {
    console.log('结论：挂了。504「not ready」+ 启动记录无新增 = 进程没监听，重新发布是唯一有效手段。');
  } else if (state === 'flaky') {
    console.log('结论：时好时坏 —— 多半在重启/回源抖动，观察 1–2 分钟再判。');
  } else if (code === 2) {
    console.log('结论：能玩，但内存已经不安全（见上面的 ⚠️）。');
  } else {
    console.log('结论：正常。');
  }
  process.exit(code);
})();
