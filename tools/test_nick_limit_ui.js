'use strict';
/* 自定义昵称 24 小时只能改一次 —— 前端回归（jsdom，加载真实的 index.html + app.js）
 *
 *   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules node tools/test_nick_limit_ui.js
 *
 * 服务端那条（test_nick_limit.js）证明「规则对」，这条证明「玩家真的会收到提醒、真的绕不过去」：
 *   1) 改名框里有「随机」按钮；
 *   2) 自定义名字 → **弹站内确认框**并说清 24 小时（不再是浏览器 confirm），请求带 random:false + 持久 uid；
 *   3) 点「随机」抽到诗人名 → **不弹框**，请求带 random:true；
 *   4) 抽完之后手改一个字 → 标记作废，回到「自定义」路径（否则手改也能白嫖随机通道）；
 *   5) 额度已经用掉（nick-status 说 canRename:false）→ 一个改名请求都不发，直接劝住；
 *   6) uid 在本机是稳定的（同一浏览器多次改名用同一个 uid，否则「每人一次」无从谈起）。
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
  /* split/join 而不是 replace(str, str)：app.js 里有 '$&' 这类字面量 */
  const html = HTML.split(TAG).join('<script>' + APP + '</scr' + 'ipt>');
  return new JSDOM(html, { url: 'http://127.0.0.1:8787/', runScripts: 'dangerously', pretendToBeVisual: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHARS = Array.from({ length: 100 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');

function state(over) {
  return Object.assign({
    id: 'ABC12', phase: 'waiting', size: 10,
    chars: CHARS, board: '0'.repeat(100),
    cfg: { size: 10, extra: 0, rounds: 20, playerCount: 2, turnSeconds: 120, maxPoemLen: 17, kinds: { 诗: true } },
    turn: 'A', turnNo: 1, round: 1, rounds: 20,
    score: { a: 0, b: 0, c: 0, d: 0, n: 100 },
    log: [], events: [],
    seats: { A: { nick: '甲', online: true, mid: 'mA' }, B: { nick: '乙', online: true, mid: 'mB' } },
    you: 'A', role: 'player', youNick: '甲', youMid: 'mA',
    refs: [], youRef: false, canControl: true,
    cfgEditable: true, pool: { count: 0, preview: '', by: '' }, canPickCells: true,
    members: [
      { kind: 'player', seat: 'A', nick: '甲', mid: 'mA', online: true, ref: false, isYou: true },
      { kind: 'player', seat: 'B', nick: '乙', mid: 'mB', online: true, ref: false, isYou: false },
    ],
    watchers: [], watcherNicks: [], isPrivate: false, youHidden: false,
    deadline: 0, serverNow: Date.now(), reason: '', req: null, canUndo: false,
    ready: { A: false, B: false, C: false, D: false }, paused: null, dispute: null, poolInfo: null,
  }, over || {});
}

(async () => {
  const dom = boot();
  const w = dom.window;
  const $ = (id) => w.document.getElementById(id);

  const calls = [];          /* 所有请求 */
  const dialogs = [];        /* 浏览器 confirm 的实参 —— 现在应该永远是空的 */
  let statusReply = { ok: true, canRename: true, retryAt: 0, waitMs: 0, gapMs: 86400000, lastNick: '' };

  w.confirm = (msg) => { dialogs.push(String(msg)); return true; };
  /* 站内弹窗的三个出口 */
  const askOpen = () => !$('askOverlay').classList.contains('hidden');
  const askText = () => ($('askTitle').textContent || '') + '　' + ($('askBody').textContent || '');
  const askOk = () => $('askOk').click();
  const askCancel = () => $('askCancel').click();
  w.fetch = async (url, opt) => {
    const body = opt && opt.body ? JSON.parse(opt.body) : null;
    calls.push({ url: String(url), body: body, method: (opt && opt.method) || 'GET' });
    const u = String(url);
    let d = { ok: true };
    if (u.indexOf('/api/rand-name') >= 0) d = { ok: true, name: '李白' };
    else if (u.indexOf('/api/nick-status') >= 0) d = statusReply;
    else if (u.indexOf('/nick') >= 0) d = { ok: true, nick: (body && body.nick) || '', retryAt: Date.now() + 86400000, gapMs: 86400000 };
    return { ok: true, status: 200, json: async () => d };
  };

  function mount(over) {
    calls.length = 0;
    dialogs.length = 0;
    statusReply = { ok: true, canRename: true, retryAt: 0, waitMs: 0, gapMs: 86400000, lastNick: '' };
    w.eval('S = ' + JSON.stringify(state(over)) + ';');
    w.eval('ME = { roomId: "ABC12", token: "tk-1" };');
    w.eval('memSig = ""; editingNick = null; editingVal = ""; editingRandom = "";');
    w.eval('renderMembers();');
  }
  const nickCalls = () => calls.filter((c) => c.url.indexOf('/nick') >= 0 && c.url.indexOf('nick-status') < 0);
  const openEdit = () => {
    const btn = Array.from(w.document.querySelectorAll('#memList button[data-act="nick"]'))[0];
    if (!btn) throw new Error('找不到「改昵称」按钮');
    btn.click();
  };
  const typeName = (v) => {
    const inp = $('nickInput');
    inp.value = v;
    inp.dispatchEvent(new w.Event('input', { bubbles: true }));
  };
  const clickSave = () => {
    const b = w.document.querySelector('#memList button[data-act="nick-save"]');
    if (!b) throw new Error('找不到「保存」按钮');
    b.click();
  };

  try {
    /* ---------- 1) 改名框里的按钮 ---------- */
    console.log('--- 改名框 ---');
    mount();
    openEdit();
    check('点「改昵称」出现输入框', !!$('nickInput'));
    check('改名框里有「随机」按钮', !!w.document.querySelector('#memList button[data-act="nick-random"]'));
    check('改名框里有「保存」与「取消」',
      !!w.document.querySelector('#memList button[data-act="nick-save"]') &&
      !!w.document.querySelector('#memList button[data-act="nick-cancel"]'));
    check('「随机」按钮说明了不占额度',
      /额度/.test(w.document.querySelector('#memList button[data-act="nick-random"]').getAttribute('title') || ''));

    /* ---------- 2) 自定义昵称：提醒 + 用掉额度 ---------- */
    console.log('--- 自定义昵称 ---');
    typeName('张三');
    check('输入自定义名', w.eval('editingVal') === '张三', w.eval('editingVal'));
    check('自定义名不是随机标记', w.eval('editingRandom') === '', w.eval('editingRandom'));
    clickSave();
    await sleep(60);
    check('自定义改名弹了站内确认框', askOpen(), askOpen());
    check('没有再用浏览器 confirm', dialogs.length === 0, dialogs);
    check('提醒里说清楚 24 小时只能改一次', /24 小时/.test(askText()), askText());
    check('提醒里提到诗人名不占额度', /不占额度/.test(askText()), askText());
    check('没确认之前一个改名请求都不发', nickCalls().filter((c) => c.method === 'POST').length === 0);
    askOk();
    await sleep(60);
    check('确认后弹窗关闭', !askOpen());
    const nc1 = nickCalls().filter((c) => c.method === 'POST');
    check('确认后发出改名请求', nc1.length === 1, nc1.length);
    check('请求体 random:false（要占额度）', nc1[0] && nc1[0].body && nc1[0].body.random === false, nc1[0] && nc1[0].body);
    check('请求体带上了 uid', !!(nc1[0] && nc1[0].body && /^[A-Za-z0-9_-]{16,64}$/.test(nc1[0].body.uid)), nc1[0] && nc1[0].body);
    check('保存前查过额度（nick-status）', calls.some((c) => c.url.indexOf('/api/nick-status') >= 0));
    check('成功后提示了「24 小时只能改一次」', /24 小时/.test($('verdict').textContent || ''), $('verdict').textContent);

    /* ---------- 3) 取消确认框：一个请求都不发 ---------- */
    console.log('--- 取消确认 ---');
    mount();
    openEdit();
    typeName('李四');
    clickSave();
    await sleep(60);
    check('点保存先弹确认框', askOpen());
    askCancel();
    await sleep(60);
    check('点「取消」后没有发改名请求', nickCalls().filter((c) => c.method === 'POST').length === 0,
      nickCalls().filter((c) => c.method === 'POST').length);
    check('取消后名字没变（还在编辑态）', w.eval('editingVal') === '李四', w.eval('editingVal'));
    check('取消后弹窗关掉', !askOpen());

    /* ---------- 4) 随机诗人名：不弹框、不占额度 ---------- */
    console.log('--- 随机诗人名 ---');
    mount();
    openEdit();
    const rbtn = w.document.querySelector('#memList button[data-act="nick-random"]');
    rbtn.click();
    await sleep(80);
    check('点「随机」把诗人名填进了输入框', $('nickInput').value === '李白', $('nickInput').value);
    check('点「随机」后标记了来源', w.eval('editingRandom') === '李白', w.eval('editingRandom'));
    /* 点「随机」不重绘成员列表，所以保存按钮还是原来那个 */
    w.document.querySelector('#memList button[data-act="nick-save"]').click();
    await sleep(80);
    check('随机改名不弹确认框', !askOpen(), askOpen());
    check('随机改名不用浏览器 confirm', dialogs.length === 0, dialogs);
    const nc2 = nickCalls().filter((c) => c.method === 'POST');
    check('随机改名发出了请求', nc2.length >= 1, nc2.length);
    check('请求体 random:true（不占额度）', nc2.length && nc2[0].body.random === true, nc2[0] && nc2[0].body);
    check('随机改名也一样带 uid', nc2.length && !!nc2[0].body.uid, nc2[0] && nc2[0].body);
    check('成功后提示「不占额度」', /不占/.test($('verdict').textContent || ''), $('verdict').textContent);

    /* ---------- 5) 抽完手改：标记作废，回到自定义路径 ---------- */
    console.log('--- 抽完手改 ---');
    mount();
    openEdit();
    w.document.querySelector('#memList button[data-act="nick-random"]').click();
    await sleep(80);
    typeName('李白白');
    check('手改之后随机标记作废', w.eval('editingRandom') === '', w.eval('editingRandom'));
    clickSave();
    await sleep(80);
    check('手改后保存会重新弹确认框', askOpen(), askOpen());
    askOk();
    await sleep(60);
    const nc3 = nickCalls().filter((c) => c.method === 'POST');
    check('手改后请求体 random:false', nc3.length && nc3[0].body.random === false, nc3[0] && nc3[0].body);

    /* ---------- 6) 额度已用掉：提前劝住，不发请求 ---------- */
    console.log('--- 额度已用掉 ---');
    mount();
    statusReply = {
      ok: true, canRename: false, retryAt: Date.now() + 5 * 3600 * 1000,
      waitMs: 5 * 3600 * 1000, gapMs: 86400000, lastNick: '乙',
    };
    openEdit();
    typeName('王五');
    clickSave();
    await sleep(80);
    check('额度用掉时一个改名请求都不发', nickCalls().filter((c) => c.method === 'POST').length === 0,
      nickCalls().filter((c) => c.method === 'POST').length);
    check('额度用掉时弹站内提示框（不是一闪而过的 toast）', askOpen(), askOpen());
    check('提示里说清楚还要等多久', /还要等/.test(askText()), askText());
    check('提示里给出「抽诗人」这个不占额度的出口', /诗人名不占额度/.test(askText()), askText());
    askOk();
    await sleep(40);
    check('提示框点「知道了」能关掉', !askOpen());

    /* ---------- 7) uid 稳定 ---------- */
    console.log('--- uid ---');
    const u1 = w.eval('getUid()');
    const u2 = w.eval('getUid()');
    check('uid 是持久串（两次一致）', u1 === u2 && u1.length >= 16, [u1, u2]);
    check('uid 存进了 localStorage', w.localStorage.getItem('feihua-uid') === u1, w.localStorage.getItem('feihua-uid'));

    /* ---------- 8) 同名保存不算改：不消耗也不打扰 ---------- */
    console.log('--- 同名 ---');
    mount();
    openEdit();
    typeName('甲');
    clickSave();
    await sleep(60);
    check('改成同名不弹确认框', dialogs.length === 0, dialogs);
    check('改成同名不发改名请求', nickCalls().filter((c) => c.method === 'POST').length === 0,
      nickCalls().filter((c) => c.method === 'POST').length);
    check('改成同名提示「没有变化」', /没有变化/.test($('verdict').textContent || ''), $('verdict').textContent);
  } catch (e) {
    fail++;
    console.log('FAIL 测试异常：' + (e && e.message));
    console.log(e && e.stack);
  }

  console.log('');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  process.exit(fail ? 1 : 0);
})();
