'use strict';
/* 飞花记录滚动定位回归：
 * 用户在浏览历史记录（向下滚动）时，新提交绝不能强制把用户拉回顶部。
 *
 * 覆盖六条口径：
 * 1. 初次渲染进房：scrollTop 置 0（在顶部）
 * 2. 停留在顶部时新提交到来：scrollTop 保持 0（自然展示最新一手）
 * 3. 用户向下滑动浏览历史（scrollTop > 15）：新提交到来绝不拉回顶部，且补偿新增高度差，保持视口稳定
 * 4. 状态更新但记录内容未变：不触碰 DOM，保持用户当前滚动位置不变
 * 5. 用户自己滑回顶部（scrollTop <= 15）：后续新提交自动展示在最顶部
 * 6. 换房间 / 对局重开：scrollTop 复位到 0
 */

const fs = require('fs');
const path = require('path');

let jsdom = null;
try { jsdom = require('jsdom'); } catch (_) {
  try {
    jsdom = require('C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules/jsdom');
  } catch (_) {
    jsdom = null;
  }
}

if (!jsdom) {
  console.log('跳过 test_log_scroll（未找到 jsdom）');
  process.exitCode = 0;
  return;
}

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

const TAG = '<script src="app.js"></script>';
const STUB = '<script>window.fetch=function(){return new Promise(function(){});};' +
  'window.EventSource=function(){this.readyState=0;};' +
  'window.EventSource.prototype.close=function(){};' +
  'window.EventSource.prototype.addEventListener=function(){};</script>';

const PAGE = HTML.split(TAG).join(STUB + '<script>' + APP + '</scr' + 'ipt>');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log('PASS ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

function run() {
  const dom = new jsdom.JSDOM(PAGE, {
    url: 'http://127.0.0.1:8787/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const pane = win.document.getElementById('logList');
  check('logList 元素存在', !!pane);

  // 模拟真实浏览器中 pane 的 scrollHeight 与 scrollTop：每条记录高度约 60px
  let currentScrollTop = 0;
  Object.defineProperty(pane, 'scrollHeight', {
    get: () => pane.children.length * 60,
    configurable: true,
  });
  Object.defineProperty(pane, 'scrollTop', {
    get: () => currentScrollTop,
    set: (val) => { currentScrollTop = val; },
    configurable: true,
  });

  // 1. 初次进入房间并渲染带有 4 条记录的状态 (4 * 60 = 240px)
  const mockState1 = {
    id: '100',
    size: 9,
    turn: 'A',
    score: { a: 2, b: 2, c: 0, d: 0, n: 77 },
    seats: { A: { nick: '选手A' }, B: { nick: '选手B' } },
    members: [],
    events: [],
    log: [
      { type: 'fly', team: 'A', round: 1, hits: 2, blank: 2, capture: 0, hold: 0, line: '床前明月光' },
      { type: 'fly', team: 'B', round: 1, hits: 2, blank: 1, capture: 1, hold: 0, line: '疑是地上霜' },
      { type: 'fly', team: 'A', round: 2, hits: 1, blank: 1, capture: 0, hold: 1, line: '举头望明月' },
      { type: 'fly', team: 'B', round: 2, hits: 1, blank: 0, capture: 1, hold: 0, line: '低头思故乡' },
    ],
  };

  win.applyState(mockState1);

  check('初次进入房间，scrollTop 为 0', currentScrollTop === 0);
  check('渲染出 4 条记录', pane.children.length === 4);

  // 2. 用户留在顶部（currentScrollTop === 0），新提交到来 (变为 5 条)
  const mockState2 = {
    ...mockState1,
    log: [
      ...mockState1.log,
      { type: 'fly', team: 'A', round: 3, hits: 2, blank: 1, capture: 1, hold: 1, line: '白日依山尽' },
    ],
  };
  win.applyState(mockState2);

  check('用户在顶部时新提交到来，scrollTop 维持在 0', currentScrollTop === 0);
  check('记录变为 5 条', pane.children.length === 5);

  // 3. 用户向下滑动浏览历史记录（设置 scrollTop = 120）
  currentScrollTop = 120;
  // 3.1 状态更新但飞花记录未变（如倒计时、心跳、准备等）
  win.applyState(mockState2);
  check('记录未变时状态刷新，用户浏览位置 120 不变且不拉回顶部', currentScrollTop === 120);

  // 3.2 对手提交了新诗句！新增 1 条（从 5 条变为 6 条，新增 60px）
  const mockState3 = {
    ...mockState2,
    log: [
      ...mockState2.log,
      { type: 'fly', team: 'B', round: 3, hits: 2, blank: 2, capture: 0, hold: 1, line: '黄河入海流' },
    ],
  };
  win.applyState(mockState3);

  check('用户浏览历史时新提交到来，绝不拉回顶部（scrollTop > 0）', currentScrollTop > 0);
  check('用户当前浏览视口稳定：scrollTop 补偿了顶部新增高度（120 + 60 = 180）', currentScrollTop === 180);
  check('记录变为 6 条', pane.children.length === 6);

  // 4. 用户浏览完，自己手动滑回顶部（currentScrollTop = 5 <= 15）
  currentScrollTop = 5;
  // 此时新提交到来（从 6 条变为 7 条）
  const mockState4 = {
    ...mockState3,
    log: [
      ...mockState3.log,
      { type: 'fly', team: 'A', round: 4, hits: 1, blank: 1, capture: 0, hold: 1, line: '欲穷千里目' },
    ],
  };
  win.applyState(mockState4);

  check('用户滑回顶部后新提交到来，自动平滑归顶 0 展示最新一手', currentScrollTop === 0);

  // 5. 换房间（room id 变成 200）
  currentScrollTop = 150;
  const mockStateRoom2 = {
    id: '200',
    size: 9,
    turn: 'A',
    score: { a: 1, b: 0, c: 0, d: 0, n: 80 },
    seats: { A: { nick: '选手A' } },
    members: [],
    events: [],
    log: [
      { type: 'fly', team: 'A', round: 1, hits: 1, blank: 1, capture: 0, hold: 0, line: '大江东去' },
    ],
  };
  win.applyState(mockStateRoom2);

  check('进入新房间，scrollTop 自动重置到 0', currentScrollTop === 0);

  // 校验渲染是否有任何未捕获报错
  const errors = win.__renderErrors || [];
  check('整个过程中 window.__renderErrors 为空', errors.length === 0, errors);

  dom.window.close();
  process.exitCode = fail > 0 ? 1 : 0;
}

run();
