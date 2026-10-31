'use strict';
/* 大厅改名的提醒弹窗 —— 前端回归（jsdom，加载真实的 index.html + app.js）
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules node tools/test_nick_lobby_ui.js
 *
 * 服务端那条（test_nick_lobby.js）证明规则对，这条证明**玩家在大厅真的会看到提醒**：
 *   1) 自定义名 + 当天还能改 → 弹「会占用今天唯一一次」的站内确认框；
 *   2) 冷却中 + 换自定义名 → 弹提示，主按钮是「抽一位诗人继续」，抽完自动用诗人名继续建房；
 *   3) 点「取消」→ 一个 /api/create 都不发；
 *   4) 诗人名 / 名字没变 → 不弹窗、直接进；
 *   5) 全程没有浏览器 confirm（原生弹窗要彻底退休）；
 *   6) 加入房间走同一套检查。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? ''
      : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

const TAG = '<script src="app.js"></script>';
function boot() {
  if (HTML.indexOf(TAG) < 0) throw new Error('index.html 里找不到 ' + TAG);
  const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
  return new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'dangerously', pretendToBeVisual: true });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dom = boot();
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);

  const calls = [];
  const dialogs = [];
  let statusReply = { ok: true, canRename: true, retryAt: 0, waitMs: 0, gapMs: 86400000, lastNick: '' };

  w.confirm = (msg) => { dialogs.push(String(msg)); return true; };
  w.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    const u = String(url);
    calls.push({ url: u, body, method: (opt && opt.method) || 'GET' });
    let d = { ok: true };
    if (u.indexOf('/api/rand-name') >= 0) d = { ok: true, name: '李白' };
    else if (u.indexOf('/api/nick-status') >= 0) d = statusReply;
    /* 建房故意回一个「非冷却」的失败：这里只关心请求有没有发出去、发的是什么，
       成功分支会进 enterGame，等于把整个对局界面拖进来，与本题无关。 */
    else if (u.indexOf('/api/create') >= 0) d = { ok: false, reason: '测试拦停' };
    else if (u.indexOf('/api/join') >= 0) d = { ok: false, reason: '测试拦停' };
    return { ok: true, status: 200, json: async () => d };
  };

  const askOpen = () => !$('askOverlay').classList.contains('hidden');
  const askText = () => ($('askTitle').textContent || '') + '　' + ($('askBody').textContent || '');
  const askOk = () => $('askOk').click();
  const askCancel = () => $('askCancel').click();
  const createCalls = () => calls.filter((c) => c.url.indexOf('/api/create') >= 0);
  const joinCalls = () => calls.filter((c) => c.url.indexOf('/api/join') >= 0);
  const reset = (reply) => {
    calls.length = 0;
    dialogs.length = 0;
    statusReply = reply;
    $('askOverlay').classList.add('hidden');
    $('nick').value = '';
    $('joinCode').value = '';
  };

  try {
    /* ---------- 1) 自定义名 + 还能改：先说清楚后果 ---------- */
    console.log('--- 自定义名（会占额度） ---');
    reset({ ok: true, canRename: true, retryAt: 0, waitMs: 0, gapMs: 86400000, lastNick: '',
      isCustom: true, isAuthorName: false, unchanged: false, willBlock: false, needsPay: true });
    $('nick').value = '张三';
    $('btnCreate').click();
    await sleep(80);
    check('建房前弹了站内确认框', askOpen(), askOpen());
    check('确认框里说清 24 小时', /24 小时/.test(askText()), askText());
    check('确认框里提到诗人名不占额度', /不占额度/.test(askText()), askText());
    check('没用浏览器 confirm', dialogs.length === 0, dialogs);
    check('没确认之前不发建房请求', createCalls().length === 0, createCalls().length);

    askCancel();
    await sleep(60);
    check('点「取消」后弹窗关掉', !askOpen());
    check('点「取消」后仍然不发建房请求', createCalls().length === 0, createCalls().length);

    $('btnCreate').click();
    await sleep(80);
    askOk();
    await sleep(80);
    const c1 = createCalls();
    check('确认后发出建房请求', c1.length === 1, c1.length);
    check('建房请求用的是这个自定义名', c1[0] && c1[0].body.nick === '张三', c1[0] && c1[0].body);
    check('建房请求带上了持久 uid', !!(c1[0] && c1[0].body.uid && /^[A-Za-z0-9_-]{16,64}$/.test(c1[0].body.uid)),
      c1[0] && c1[0].body);

    /* ---------- 2) 冷却中换自定义名：劝住 + 一键换诗人名 ---------- */
    console.log('--- 冷却中 ---');
    reset({ ok: true, canRename: false, retryAt: Date.now() + 5 * 3600 * 1000, waitMs: 5 * 3600 * 1000,
      gapMs: 86400000, lastNick: '甲先生',
      isCustom: true, isAuthorName: false, unchanged: false, willBlock: true, needsPay: false });
    $('nick').value = '王五';
    $('btnCreate').click();
    await sleep(80);
    check('冷却中建房弹提示框', askOpen(), askOpen());
    check('提示里说清还要等多久', /还要等/.test(askText()), askText());
    check('提示里带上上次用的名字', /甲先生/.test(askText()), askText());
    check('主按钮是「抽一位诗人继续」', /诗人/.test($('askOk').textContent || ''), $('askOk').textContent);
    check('冷却中不会直接发建房请求', createCalls().length === 0, createCalls().length);

    askOk();
    await sleep(120);
    check('点了之后抽到诗人名并填回输入框', $('nick').value === '李白', $('nick').value);
    const c2 = createCalls();
    check('然后用诗人名继续建房', c2.length === 1, c2.length);
    check('建房请求里的名字已经是诗人名', c2[0] && c2[0].body.nick === '李白', c2[0] && c2[0].body);

    /* ---------- 3) 诗人名：不打扰 ---------- */
    console.log('--- 诗人名 ---');
    reset({ ok: true, canRename: false, retryAt: Date.now() + 1000, waitMs: 1000, gapMs: 86400000,
      lastNick: '甲先生', isCustom: false, isAuthorName: true, unchanged: false, willBlock: false, needsPay: false });
    $('nick').value = '杜甫';
    $('btnCreate').click();
    await sleep(80);
    check('诗人名不弹窗', !askOpen());
    check('诗人名直接建房', createCalls().length === 1, createCalls().length);

    /* ---------- 4) 名字没变：不打扰 ---------- */
    console.log('--- 名字没变 ---');
    reset({ ok: true, canRename: false, retryAt: Date.now() + 1000, waitMs: 1000, gapMs: 86400000,
      lastNick: '张三', isCustom: true, isAuthorName: false, unchanged: true, willBlock: false, needsPay: false });
    $('nick').value = '张三';
    $('btnCreate').click();
    await sleep(80);
    check('同名不弹窗', !askOpen());
    check('同名直接建房', createCalls().length === 1, createCalls().length);

    /* ---------- 5) 加入房间走同一套 ---------- */
    console.log('--- 加入房间 ---');
    reset({ ok: true, canRename: false, retryAt: Date.now() + 5 * 3600 * 1000, waitMs: 5 * 3600 * 1000,
      gapMs: 86400000, lastNick: '甲先生',
      isCustom: true, isAuthorName: false, unchanged: false, willBlock: true, needsPay: false });
    $('nick').value = '李四';
    $('joinCode').value = '123';
    $('btnJoin').click();
    await sleep(80);
    check('冷却中加入房间也会弹提示', askOpen(), askOpen());
    check('冷却中没有发加入请求', joinCalls().length === 0, joinCalls().length);
    askCancel();
    await sleep(60);
    check('取消后仍然不发加入请求', joinCalls().length === 0, joinCalls().length);
    check('全程没有一次浏览器 confirm', dialogs.length === 0, dialogs);

    /* ---------- 6) 弹窗的键盘 / 遮罩出口 ---------- */
    console.log('--- 关闭方式 ---');
    reset({ ok: true, canRename: true, retryAt: 0, waitMs: 0, gapMs: 86400000, lastNick: '',
      isCustom: true, isAuthorName: false, unchanged: false, willBlock: false, needsPay: true });
    $('nick').value = '赵六';
    $('btnCreate').click();
    await sleep(80);
    check('又弹出来了', askOpen());
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(60);
    check('按 Esc 能关掉', !askOpen());
    check('按 Esc 关掉后不发请求', createCalls().length === 0, createCalls().length);
  } catch (e) {
    fail++;
    console.log('FAIL 测试异常：' + (e && e.message));
    console.log(e && e.stack);
  }

  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
