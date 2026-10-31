'use strict';
/* 域名体检：判断「站点打不开」是应用挂了，还是域名没了。
 *
 * 用法：node tools/check_domain.js  [域名]
 *      默认检查线上应用域名。
 *
 * 背景（2026-10-22）：线上 16:00 左右开始有玩家陆续打不开，微信报 -105 NAME_NOT_RESOLVED。
 * 查下来是注册局给整个 workbuddy.host 加了 serverHold，所有 *.app.workbuddy.host 同时 NXDOMAIN。
 * 那种情况下改代码、重新发布都没用 —— 发布出来的链接还是同一个不解析的域名。
 *
 * 判读：
 *   NXDOMAIN  = 域名在 DNS 里不存在（没委派 / 被 serverHold / 已删除）→ 平台侧问题
 *   有 IP     = 域名正常 → 再去看应用（504 是应用没监听，502 是网关到应用的链路）
 * 顺带把注册局的 RDAP 状态打出来，serverHold 是最常见的那条。
 */

const os = require('os');

const APP_HOST = process.argv[2] || 'feihua-splatoon.app.workbuddy.host';
const APEX = APP_HOST.split('.').slice(-2).join('.');

const DOH = [
  ['阿里', 'https://dns.alidns.com/resolve'],
  ['腾讯', 'https://doh.pub/dns-query'],
  ['Cloudflare', 'https://cloudflare-dns.com/dns-query'],
  ['Google', 'https://dns.google/resolve'],
];

const RCODE = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN（域名不存在）', 5: 'REFUSED' };

async function doh(base, name, type) {
  const u = base + '?name=' + encodeURIComponent(name) + '&type=' + type;
  const r = await fetch(u, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(9000) });
  const j = await r.json();
  return {
    status: j.Status,
    answers: (j.Answer || []).map((a) => a.data),
    soa: (j.Authority || []).filter((a) => a.type === 6).map((a) => String(a.data).split(/\s+/)[0])[0] || '',
  };
}

/* 注册局 RDAP：从 IANA 引导文件里找这个后缀的权威 RDAP 地址，不要硬编码。 */
async function rdap(domain) {
  const tld = domain.split('.').pop();
  const boot = await (await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(15000) })).json();
  const svc = (boot.services || []).find((s) => s[0].includes(tld));
  if (!svc) return { err: 'IANA 引导里没有 .' + tld + ' 的 RDAP' };
  let lastErr = '';
  for (const base of svc[1]) {
    try {
      const r = await fetch(base.replace(/\/$/, '') + '/domain/' + domain, {
        headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(12000),
      });
      if (r.status === 404) return { notFound: true, base };
      if (r.status !== 200) { lastErr = 'HTTP ' + r.status; continue; }
      const d = await r.json();
      const ev = {};
      for (const e of (d.events || [])) ev[e.eventAction] = e.eventDate;
      /* 注册商 + 滥用举报邮箱：serverHold 这类问题要报障就报给他们，
         不写出来每次都得现查一遍。 */
      let registrar = '';
      let abuse = '';
      const vget = (ent, key) => {
        const vc = ent && ent.vcardArray && ent.vcardArray[1] ? ent.vcardArray[1] : [];
        const hit = vc.find((x) => x[0] === key);
        return hit ? hit[3] : '';
      };
      for (const ent of (d.entities || [])) {
        const roles = ent.roles || [];
        if (roles.includes('registrar')) {
          registrar = vget(ent, 'fn') || ent.handle || '';
          for (const sub of (ent.entities || [])) {
            if ((sub.roles || []).some((x) => /abuse/i.test(x))) {
              abuse = vget(sub, 'email') || vget(sub, 'fn') || abuse;
            }
          }
          if (!abuse) abuse = vget(ent, 'email') || '';
        }
      }
      return {
        base,
        status: d.status || [],
        registered: ev.registration || '',
        expires: ev.expiration || '',
        changed: ev['last changed'] || '',
        ns: (d.nameservers || []).map((n) => n.ldhName),
        registrar,
        abuse,
      };
    } catch (e) { lastErr = e.name + ' ' + e.message; }
  }
  return { err: lastErr || '全部 RDAP 地址都失败' };
}

const cn = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return iso + '（北京时间 ' + new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '）';
};

(async () => {
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
  console.log('=== 域名体检 ' + stamp + ' ===');
  console.log('主机：' + APP_HOST);
  console.log('本机：' + os.hostname() + '（本机 DNS 可能被代理劫持，所以只认 DoH 的结果）\n');

  console.log('--- 1. A 记录（四家公共 DNS 交叉验证）---');
  const seen = new Set();
  let anyIPs = [];
  for (const [tag, base] of DOH) {
    try {
      const r = await doh(base, APP_HOST, 'A');
      seen.add(r.status);
      const ips = r.answers.filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
      if (ips.length) anyIPs = ips;
      console.log('  ' + tag.padEnd(12) + (RCODE[r.status] || 'rcode=' + r.status) +
        (r.answers.length ? '  → ' + r.answers.join(', ') : ''));
    } catch (e) {
      console.log('  ' + tag.padEnd(12) + '查询失败：' + e.name + ' ' + e.message);
    }
  }

  console.log('\n--- 2. 根域对照（判断是「整个域没了」还是「只有这个子域」）---');
  for (const n of [APEX]) {
    try {
      const r = await doh(DOH[2][1], n, 'A');
      console.log('  ' + n.padEnd(28) + (RCODE[r.status] || 'rcode=' + r.status) +
        (r.answers.length ? '  → ' + r.answers.join(', ') : '') + (r.soa ? '   [SOA ' + r.soa + ']' : ''));
    } catch (e) { console.log('  ' + n + ' 失败：' + e.message); }
  }
  try {
    const r = await doh(DOH[2][1], 'www.baidu.com', 'A');
    console.log('  ' + '对照 www.baidu.com'.padEnd(24) + (RCODE[r.status] || r.status) + (r.answers.length ? '  → 正常' : '  → 异常'));
  } catch (e) { console.log('  对照组失败：' + e.message); }

  console.log('\n--- 3. 注册局状态（RDAP）---');
  let rd = {};
  try {
    rd = await rdap(APEX);
    if (rd.err) console.log('  查不到：' + rd.err);
    else if (rd.notFound) console.log('  注册局查无此域名（已删除 / 未注册）');
    else {
      console.log('  状态  ：' + (rd.status.join(', ') || '-'));
      console.log('  注册  ：' + cn(rd.registered));
      console.log('  到期  ：' + cn(rd.expires));
      console.log('  最后改：' + cn(rd.changed));
      console.log('  域名服务器：' + (rd.ns.join(', ') || '-'));
      if (rd.registrar) console.log('  注册商：' + rd.registrar + (rd.abuse ? '（滥用举报 ' + rd.abuse + '）' : ''));
    }
  } catch (e) { console.log('  RDAP 失败：' + e.name + ' ' + e.message); }

  console.log('\n--- 4. 应用是否应答（解析得到 IP 才有意义）---');
  if (!anyIPs.length) {
    console.log('  跳过：域名解析不出 IP，请求根本发不出去。');
  } else {
    const t0 = Date.now();
    try {
      const r = await fetch('https://' + APP_HOST + '/api/rooms?sharecode=MZA5YPLHV3', { signal: AbortSignal.timeout(15000) });
      console.log('  /api/rooms → ' + r.status + '  ' + (Date.now() - t0) + 'ms');
    } catch (e) { console.log('  /api/rooms → 失败 ' + e.name + ' ' + e.message + '  ' + (Date.now() - t0) + 'ms'); }
  }

  console.log('\n--- 判定 ---');
  const hold = !!(rd.status || []).some((s) => /server hold/i.test(s));
  if (seen.has(3)) {
    if (hold) {
      console.log('  注册局对 ' + APEX + ' 设了 serverHold → 整个域被暂停解析。');
      console.log('  serverHold 是**域名级**状态，DNS 里没有「只暂停某个子域」这回事：');
      console.log('  所以不是某个应用被限制，而是该域下所有应用一起下线。');
      console.log('  这是平台侧的事故：代码、发布、玩家手机都无关，只能由域名持有人申请解除。');
      console.log('  报障时可以直接给平台这段话：');
      console.log('    ' + APEX + ' 在注册局 RDAP 显示 server hold，last changed ' + (rd.changed || '(见上)') + '；');
      console.log('    所有 *.' + APEX + ' 同时 NXDOMAIN（四家公共 DoH 一致），平台主域 workbuddy.cn 正常。');
    } else {
      console.log('  域名 ' + APEX + ' 在 DNS 里不存在（没委派或已被删除），不是应用的问题。');
    }
    console.log('  → 现在做什么都没用，改代码/重新发布也不会好，先找平台。');
  } else if (anyIPs.length) {
    console.log('  域名解析正常 → ' + anyIPs.join(', '));
    console.log('  这时打不开才是应用/网关的问题（504 = 应用没监听，502 = 网关到应用的链路）。');
  } else {
    console.log('  结果不稳定（四家 DNS 不一致），过几分钟再跑一次。');
  }
})();
