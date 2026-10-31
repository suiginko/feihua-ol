'use strict';
/* 邀请链接回归测试：验证站内生成的链接是否保留了访问参数（sharecode）。
 * 直接加载真实的 index.html + app.js，用 jsdom 渲染，再调用页面里的 roomLink/selfLink。 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function boot(url, seedShare) {
  /* 必须用 split/join 而不是 replace(str, str)：
     app.js 里有 '\\$&'（转义正则元字符），而 replace 的第二参数会把 $& 展开成
     「匹配到的整段」（也就是 <script src="app.js"></script>），直接打断字符串引号，
     jsdom 报 SyntaxError: Invalid or unexpected token —— 排查时极难一眼看出。 */
  const TAG = '<script src="app.js"></script>';
  if (HTML.indexOf(TAG) < 0) throw new Error('index.html 里找不到 ' + TAG + '，本测试的内联方式需要同步更新');
  const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
  const dom = new JSDOM(html, {
    url, runScripts: 'dangerously', pretendToBeVisual: true,
    /* app.js 是内联的、构造时立刻执行，所以「上一次记住的分享码」必须在解析前就写好 */
    beforeParse(w) {
      if (seedShare) { try { w.localStorage.setItem('feihua-sharecode', seedShare); } catch (_) {} }
    },
  });
  return dom;
}

const ONLINE = 'https://feihua-splatoon.app.workbuddy.host/';

const CASES = [
  {
    name: '带 sharecode 的线上页面（本次修复的主场景）',
    url: 'https://feihua-splatoon.app.workbuddy.host/?sharecode=MZA5YPLHV3',
    room: 'ABCD',
    roomWant: 'https://feihua-splatoon.app.workbuddy.host/?r=ABCD&sharecode=MZA5YPLHV3',
    selfWant: '/?sharecode=MZA5YPLHV3',
  },
  {
    name: '用户是点了邀请链接进来的（已有 r，要替换成新房号）',
    url: 'https://feihua-splatoon.app.workbuddy.host/?sharecode=MZA5YPLHV3&r=ZZZZ',
    room: 'W7K2',
    roomWant: 'https://feihua-splatoon.app.workbuddy.host/?r=W7K2&sharecode=MZA5YPLHV3',
    selfWant: '/?sharecode=MZA5YPLHV3',
  },
  {
    name: '旧域名 / 本地开发（没有 sharecode，不能凭空加参数）',
    url: 'http://localhost:8787/',
    room: 'ABCD',
    roomWant: 'http://localhost:8787/?r=ABCD',
    selfWant: '/',
  },
  /* ↓↓ 2026-10-24 新增：线上域名但地址栏里没有 sharecode，这是「分享的链接偶尔缺码」的根因 */
  {
    name: '线上域名、靠网关 cookie 进来（地址栏无 sharecode）→ 用以前记住的',
    url: ONLINE,
    seed: 'SEENBEFORE',
    room: 'ABCD',
    roomWant: ONLINE + '?r=ABCD&sharecode=SEENBEFORE',
    selfWant: '/?sharecode=SEENBEFORE',
  },
  {
    name: '线上域名、从没见过带码链接 → 回退到内置兜底，绝不生成裸链接',
    url: ONLINE,
    room: 'ABCD',
    roomWant: ONLINE + '?r=ABCD&sharecode=MZA5YPLHV3',
    selfWant: '/?sharecode=MZA5YPLHV3',
  },
  {
    name: '地址栏带码时优先用它，不被记忆值覆盖',
    url: 'https://feihua-splatoon.app.workbuddy.host/?sharecode=FRESH01',
    seed: 'STALEOLD',
    room: 'ABCD',
    roomWant: 'https://feihua-splatoon.app.workbuddy.host/?r=ABCD&sharecode=FRESH01',
    selfWant: '/?sharecode=FRESH01',
  },
];

let fail = 0;
for (const c of CASES) {
  const dom = boot(c.url, c.seed);
  const w = dom.window;
  let got = {};
  try {
    got.room = w.roomLink ? w.roomLink(c.room) : '(函数不存在)';
    got.self = w.selfLink ? w.selfLink() : '(函数不存在)';
  } catch (e) {
    got.room = 'ERR ' + e.message;
    got.self = 'ERR ' + e.message;
  }
  const okRoom = got.room === c.roomWant;
  const okSelf = got.self === c.selfWant;
  if (!okRoom || !okSelf) fail++;
  console.log((okRoom && okSelf ? 'PASS  ' : 'FAIL  ') + c.name);
  if (!okRoom) console.log('       邀请链接 期望 ' + c.roomWant + '\n                 实际 ' + got.room);
  if (!okSelf) console.log('       返回大厅 期望 ' + c.selfWant + '\n                 实际 ' + got.self);
  w.close();
}

console.log(fail ? '\n结果：' + fail + ' 项失败' : '\n结果：全部通过');
process.exit(fail ? 1 : 0);
