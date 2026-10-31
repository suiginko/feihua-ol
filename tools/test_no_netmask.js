'use strict';
/* 断线遮罩已移除的回归：2026-10-24 用户明确要求「不论原因，都去掉这个弹窗」
 * （SSE 偶尔抖动时遮罩 1.2 秒就浮出、重连成功又立刻收起，一天里频繁闪几次更影响体验）。
 *
 * 这个测试守两件事，看上去矛盾、其实是一对：
 *   ① 遮罩的 DOM / 样式 / 显示逻辑**不许回来**（否则体验问题复发）；
 *   ② 断线时的**重连与房间探测必须还在**（这是真功能，删了会导致掉线后永远回不去）。
 * 所以断言既有「不存在」，也有「必须存在」。 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let bad = 0;
const check = (name, ok, extra) => {
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra != null && !ok ? '  → ' + JSON.stringify(extra) : ''));
};

const TAG = '<script src="app.js"></script>';
const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
const dom = new JSDOM(html, {
  url: 'https://feihua-splatoon.app.workbuddy.host/?sharecode=MZA5YPLHV3',
  runScripts: 'dangerously', pretendToBeVisual: true,
});
const w = dom.window;
const d = w.document;

/* ---- ① 遮罩不许回来 ---- */
check('页面里没有 #netMask 节点', d.getElementById('netMask') === null);
check('页面源码里没有「连接中断」文案', HTML.indexOf('连接中断') < 0);
check('页面源码里没有 netspin / netacts 样式残留', HTML.indexOf('netspin') < 0 && HTML.indexOf('netacts') < 0);
check('app.js 里没有 setNetKind 函数', APP.indexOf('setNetKind') < 0);
check('app.js 里没有对 $(\'netMask\') 的操作', APP.indexOf("$('netMask')") < 0);
check('app.js 里没有 netTitle / netText / netSpin 的引用',
  APP.indexOf("'netTitle'") < 0 && APP.indexOf("'netText'") < 0 && APP.indexOf("'netSpin'") < 0);
check('页面加载后没有任何「网络相关」浮层处于显示状态',
  Array.prototype.slice.call(d.querySelectorAll('.overlay'))
    .filter((o) => !o.classList.contains('hidden'))
    .filter((o) => /net/i.test(o.id || '')).length === 0);

/* ---- ② 重连与探测必须还在 ---- */
check('armNetMask 仍然存在（断线后启动重连探测）', typeof w.armNetMask === 'function');
check('probeRoom 仍然存在（判断本局是否已在服务端结束）', typeof w.probeRoom === 'function');
check('hideNetMask 仍然存在（重连成功后收尾）', typeof w.hideNetMask === 'function');
/* 「房间没了」的提示是 toast，不是遮罩 —— 这条是那个分支还在的证据 */
check('房间失效时的 toast 文案还在', APP.indexOf('本局在服务端已结束') >= 0);
/* 断线重连的退避与重建 SSE 也不能顺带删掉 */
check('SSE 断开后会重连（connect 与退避仍在）', APP.indexOf('Math.pow(1.6, netRetry++)') >= 0);

w.close();
console.log(bad ? '\n结果：' + bad + ' 项失败' : '\n结果：全部通过');
process.exit(bad ? 1 : 0);
