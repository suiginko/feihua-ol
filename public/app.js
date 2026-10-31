'use strict';
/* 客户端：只负责渲染服务器推来的状态，以及把「诗句原文」发上去。
   任何判定、涂色、轮次都由服务端决定 —— 前端不做规则计算。
   视觉与《飞花斯普拉遁-主持台》同一套：棋盘用 --cell-fs + nb-r/nb-b 透明格线，
   比分用 teams + scorebar + legend，判罚用 .msg，结算用 .final 三栏。 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------- 开发者模式 ----------
   入口：任意页面加 `?dev=<口令>`（就是 /admin 用的那个 admin.key）。打开一次后记住，
   之后本标签页所有请求都自动带上它。作用：
     ① 大厅里能看到私密房间（房号是 5 位随机码，看不到列表就根本点不进去）；
     ② 进房一律是「隐形观众」—— 不占席位、不进成员名单、不算观众数、不写进出事件。
   **口令不留在地址栏**：读出来立刻从 URL 抹掉并存进 sessionStorage。原因很实际 ——
   分享链接（roomLink / selfLink）默认把当前 query 原样带上，留着就等于把口令发给对手。 */
const DEV = (() => {
  let key = '';
  try {
    const q = new URLSearchParams(location.search);
    key = String(q.get('dev') || '').trim();
    if (key) {
      sessionStorage.setItem('feihua-dev', key);
      q.delete('dev');
      const s = q.toString();
      history.replaceState(null, '', location.pathname + (s ? '?' + s : ''));
    } else {
      key = String(sessionStorage.getItem('feihua-dev') || '').trim();
    }
  } catch (_) {}
  return {
    get on() { return !!key; },
    get key() { return key; },
    /* 只给站内 /api 请求用：带上 dev 才算开发者，别再往分享链接里塞 */
    url: (u) => (key ? u + (u.indexOf('?') >= 0 ? '&' : '?') + 'dev=' + encodeURIComponent(key) : u),
    /* 关闭：忘掉口令。当前页面里已经建立的「隐形观众」身份要重新进房才换得掉，
       所以按钮那边直接 reload 一次 —— 比在内存里改半天状态更可靠。 */
    off: () => {
      key = '';
      try { sessionStorage.removeItem('feihua-dev'); } catch (_) {}
    },
  };
})();

let S = null;                 // 最近一次服务端状态
let ME = null;                // {roomId, seat, token}：seat 为 null 表示在观众席
let ES = null;                // EventSource
let skew = 0;                 // 服务器时间 - 本地时间
let cellEls = [];
let boardN = 0;
let prevLogLen = 0;
let flashTimer = null;        // 本手命中格的白描边褪去定时器
let setupSig = '';            // 设置面板快照签名：没变就不覆盖用户正在输入的值
let setupDirty = false;       // 用户改过表单、还没点「应用设置」
const KINDS_UI = ['诗', '词', '曲', '赋', '文'];
/* 规则摘要：模式 + 文体 + 低频字。大厅房间条目和局内顶部行共用同一句话，避免两处说法不一致。 */
function ruleLabel(cfg) {
  const on = KINDS_UI.filter((k) => cfg && cfg.kinds && cfg.kinds[k]);
  const pCount = (cfg && cfg.playerCount) || 2;
  const pText = pCount === 1 ? '单人' : pCount === 3 ? '三人' : pCount === 4 ? '四人' : '双人';
  const lenText = (pCount === 1 || (cfg && cfg.freeSubmit)) ? ' · 不限字数' : (cfg && cfg.maxPoemLen && cfg.maxPoemLen !== 17 ? (' · 限 ' + cfg.maxPoemLen + ' 字') : '');
  const coupletText = (pCount === 1 || (cfg && cfg.freeSubmit)) ? '' : (cfg && cfg.limitCouplet === false ? ' · 不限诗联句' : '');
  const freeText = (pCount > 1 && cfg && cfg.freeSubmit) ? ' · 自由提交' : '';
  return pText + ' · ' + (on.join('') || '诗') + ' · ' + (cfg && cfg.extra ? '低频 ' + cfg.extra + ' 字' : '无低频字') + lenText + coupletText + freeText;
}
let waitDismissed = false;    // 房主把「邀请」浮层关掉后不再自动弹（对手进来才重置）
let endDismissed = false;     // 用户把结算浮层关掉后不再自动弹（新一局才重置）
let roomPoll = null;          // 大厅房间列表的轮询句柄

/* 断线保护（发布重启时用得上）：遮罩 + 探测 + 无限重连 */
let netTimer = null;          // 「断了一小会儿就不显示」的延迟句柄
let netProbe = null;          // 探测房间是否还在的定时器
let netRetry = 0;             // 手动重连的重试次数（退避用）
let netShown = false;         // 遮罩是否已经浮出来
let netGone = false;          // 房间确实没了（不是网络问题）

/* 导出模块（export.js）用的桥：读当前状态 + 复用同一条提示条。
   export.js 只依赖这四个东西，内部把主持台版那套 board/log 全局量还原出来。 */
window.OL = {
  state: () => S,
  tip: (text, kind) => verdict(kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'ok', text),
};

/* 本局每步时间（秒）：建房时自定义，默认 120 */
function turnSeconds() {
  const n = S && S.cfg ? Number(S.cfg.turnSeconds) : 0;
  return n > 0 ? n : 120;
}

/* ---------- 访问参数 ----------
   线上域名由网关加了 ?sharecode=... 门禁：不带这个参数直接 403「链接不完整」。
   所以站内生成的任何链接（邀请链接、返回大厅）都必须把当前页面的访问参数原样带上，
   否则对方第一次点开就进不来。本地/旧域名没有这个参数时，生成的就是原来的干净链接。

   ⚠️ 2026-10-24 补的坑：**不能只依赖 location.search**。
   网关在第一次带 ?sharecode= 访问后会种一个 HttpOnly cookie（__wb_rsc=<哈希>，30 天有效），
   之后玩家从书签 / 浏览器历史 / 直接输域名进来（地址栏里干干净净，靠 cookie 放行），
   这时他复制出来的邀请链接就没有 sharecode —— 对方点开必然 403。这就是「分享的链接
   偶尔缺 sharecode」的真正根因。HttpOnly 读不到、cookie 值还是哈希不是明文，所以只能：
   URL 里有 → 用掉并存下来；URL 里没有 → 用存过的；都没有且确实是线上域名 → 用内置兜底。 */
const SHARE_KEY = 'feihua-sharecode';
/* 线上网关的分享码。它不是每次发布都变，但平台侧重置后这里就会过期 ——
   tools/watch_site.js 带它探活，一旦返回 403 就说明该更新这里了。 */
const SHARE_FALLBACK = 'MZA5YPLHV3';

function isOnlineHost() {
  try { return /(^|\.)app\.workbuddy\.host$/.test(location.hostname); } catch (_) { return false; }
}

function sharecode() {
  try {
    const sc = String(new URLSearchParams(location.search).get('sharecode') || '').trim();
    if (sc) {
      try { localStorage.setItem(SHARE_KEY, sc); } catch (_) {}
      return sc;
    }
  } catch (_) {}
  try {
    const s = String(localStorage.getItem(SHARE_KEY) || '').trim();
    if (s) return s;
  } catch (_) {}
  return isOnlineHost() ? SHARE_FALLBACK : '';
}

function accessQuery(exceptKey) {
  const q = new URLSearchParams(location.search);
  q.delete('dev');            /* 开发者口令绝不进分享链接（DEV 已经把它从地址栏抹掉了，这里是第二道保险） */
  if (exceptKey) q.delete(exceptKey);
  if (!q.get('sharecode')) {
    const sc = sharecode();
    if (sc) q.set('sharecode', sc);
  }
  return q.toString();
}

function roomLink(roomId) {
  const q = accessQuery('r');
  return location.origin + '/?r=' + encodeURIComponent(roomId) + (q ? '&' + q : '');
}

function selfLink() {
  const q = accessQuery('r');
  return location.pathname + (q ? '?' + q : '');
}

/* ---------- 小工具 ---------- */
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- 局内询问框（替掉浏览器 confirm） ----------
 * 原生 confirm 的问题不只是丑：标题栏显示域名、按钮写「确定/取消」，跟站内其它弹窗
 * 完全是两套东西；手机上还会多一次「返回」的手势。所以改名这类需要「说清楚后果再问一次」
 * 的场景，统一走这里。
 *
 * 用法： const r = await askGame({ eyebrow, title, body, okText, cancelText });
 *   返回 'ok' | 'cancel'；同一时刻只允许一个，后到的会把前一个当成取消收掉。
 * body 支持 HTML（内容都是站内拼的固定文案，玩家输入的昵称一律先 esc 再传进来）。 */
let askDone = null;
function askGame(opt) {
  const o = opt || {};
  return new Promise((resolve) => {
    if (askDone) { const prev = askDone; askDone = null; prev('cancel'); }
    const ov = $('askOverlay');
    if (!ov) { resolve(window.confirm(o.title || '') ? 'ok' : 'cancel'); return; }
    $('askEyebrow').textContent = o.eyebrow || '提示';
    $('askTitle').textContent = o.title || '确认';
    $('askBody').innerHTML = o.body || '';
    $('askOk').textContent = o.okText || '确定';
    $('askCancel').textContent = o.cancelText || '取消';
    $('askCancel').classList.toggle('hidden', !!o.hideCancel);
    $('askOk').disabled = false;
    ov.classList.remove('hidden');
    askDone = (val) => {
      askDone = null;
      ov.classList.add('hidden');
      resolve(val);
    };
    setTimeout(() => { try { $('askOk').focus(); } catch (_) {} }, 30);
  });
}
function closeAsk(val) {
  const d = askDone;
  if (d) d(val);
}

function save() {
  if (ME) {
    sessionStorage.setItem('feihua-ol', JSON.stringify(ME));
    try {
      if (ME.roomId && ME.token) {
        localStorage.setItem('feihua-token-' + ME.roomId, ME.token);
      }
    } catch (_) {}
  } else {
    sessionStorage.removeItem('feihua-ol');
  }
}

function load() {
  try { return JSON.parse(sessionStorage.getItem('feihua-ol') || 'null'); } catch (_) { return null; }
}

async function post(url, body) {
  const r = await fetch(DEV.url(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

/* 「我要走了」这一发：普通请求失败就换 sendBeacon 再试一次。
   keepalive 让请求在页面导航/关闭后继续发完；sendBeacon 是最后一道保险。
   两者都失败也不拦着玩家离开 —— 服务端会在 75 秒心跳超时后自己发现人走了。 */
function leaveRequest(roomId, t) {
  const url = '/api/room/' + roomId + '/leave';
  const body = JSON.stringify({ t });
  const beacon = () => {
    try {
      if (navigator.sendBeacon) {
        return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      }
    } catch (_) {}
    return false;
  };
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).then((r) => r.ok).catch(beacon);
}

/* ---------- 数字输入框步进器（上调/下调） ----------
   移动端浏览器默认不显示微调箭头，且即使在桌面端原生箭头也很小、易误触。
   为所有数字输入框提供优雅的「− / +」步进按钮，支持点按和长按连续平滑增减，
   并自动联动 input / change 事件与上下限校验。 */
function stepNumberInput(input, dir) {
  if (!input || input.disabled || input.readOnly) return;
  if (input.type === 'text') return;

  const min = input.min !== '' ? Number(input.min) : -Infinity;
  const max = input.max !== '' ? Number(input.max) : Infinity;
  const step = Number(input.step) || 1;

  let val = Number(input.value);
  if (isNaN(val)) {
    val = min !== -Infinity ? min : 0;
  }
  let next = val + dir * step;
  if (min !== -Infinity) next = Math.max(min, next);
  if (max !== Infinity) next = Math.min(max, next);

  if (next !== val || input.value === '') {
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function syncNumStepButtons() {
  document.querySelectorAll('.nstep-btn').forEach((btn) => {
    const targetId = btn.getAttribute('data-step-for');
    const input = document.getElementById(targetId);
    if (!input) return;
    if (input.disabled || input.readOnly || input.type === 'text') {
      btn.disabled = true;
      return;
    }
    const dir = Number(btn.getAttribute('data-dir')) || 1;
    const min = input.min !== '' ? Number(input.min) : -Infinity;
    const max = input.max !== '' ? Number(input.max) : Infinity;
    const val = Number(input.value);
    if (dir < 0 && !isNaN(val) && val <= min) {
      btn.disabled = true;
    } else if (dir > 0 && !isNaN(val) && val >= max) {
      btn.disabled = true;
    } else {
      btn.disabled = false;
    }
  });
}

function bindAllNumSteppers() {
  document.querySelectorAll('.nstep-btn').forEach((btn) => {
    let timer = null, interval = null;
    const stop = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    };
    const stepOnce = () => {
      if (btn.disabled) return;
      const targetId = btn.getAttribute('data-step-for');
      const input = document.getElementById(targetId);
      const dir = Number(btn.getAttribute('data-dir')) || 1;
      stepNumberInput(input, dir);
      syncNumStepButtons();
    };

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || btn.disabled) return;
      stepOnce();
      stop();
      timer = setTimeout(() => {
        interval = setInterval(stepOnce, 80);
      }, 350);
    });
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

/* ---------- 大厅 ---------- */
function bindLobby() {
  /* 局内询问框：三个出口（确定 / 取消 / 点遮罩 / Esc）都归一到 closeAsk */
  $('askOk').addEventListener('click', () => closeAsk('ok'));
  $('askCancel').addEventListener('click', () => closeAsk('cancel'));
  $('askOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'askOverlay') closeAsk('cancel');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (askDone) {
      e.preventDefault();
      closeAsk('cancel');
      return;
    }
    if ($('endOverlay') && !$('endOverlay').classList.contains('hidden')) {
      e.preventDefault();
      closeEndModal();
      return;
    }
  });
  /* 「关闭开发者模式」：大厅提示条与房间里的观众条共用一个按钮 id，这里用事件委托接一次。
     只清口令还不够 —— 当前这间房里的隐形身份是服务端按 token 记着的，
     整页重载一次最干净（重载后没有 dev，再进房就是普通观众）。 */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || t.id !== 'btnDevOff') return;
    DEV.off();
    location.reload();
  });
  const sizeEl = $('size'), roundsEl = $('rounds'), extraEl = $('extra');
  const suggest = { 5: 8, 6: 10, 7: 12, 8: 15, 9: 17, 10: 20, 11: 23, 12: 26, 13: 29, 14: 33, 15: 37, 16: 41, 17: 45, 18: 49, 19: 53, 20: 57 };
  let auto = true;

  const updateExtraLimits = (n) => {
    const totalCells = n * n;
    const minExtra = Math.max(0, totalCells - 300);
    const maxExtra = totalCells;
    extraEl.min = String(minExtra);
    extraEl.max = String(maxExtra);
    $('extraHint').textContent = minExtra + '–' + maxExtra;
  };

  /* 用户在输入过程中（打字/退格）：绝对不改写 sizeEl.value，只做关联文案更新 */
  sizeEl.addEventListener('input', () => {
    const raw = sizeEl.value.trim();
    const num = Number(raw);
    if (!isNaN(num) && num >= 5 && num <= 20) {
      updateExtraLimits(num);
      if (auto) roundsEl.value = suggest[num] || Math.max(8, Math.round(num * num / 5));
    }
    syncNumStepButtons();
  });

  /* 尺寸失焦或值确定时：才夹到 [5, 20]，并保证 extra 在合法范围 */
  const clampSize = () => {
    const n = Math.max(5, Math.min(20, Math.round(Number(sizeEl.value)) || 10));
    sizeEl.value = n;
    updateExtraLimits(n);
    const totalCells = n * n;
    const minExtra = Math.max(0, totalCells - 300);
    const maxExtra = totalCells;
    const ev = Math.max(minExtra, Math.min(maxExtra, Math.round(Number(extraEl.value) || 0)));
    extraEl.value = ev;
    if (auto) roundsEl.value = suggest[n] || Math.max(8, Math.round(n * n / 5));
    syncNumStepButtons();
  };
  sizeEl.addEventListener('change', clampSize);
  sizeEl.addEventListener('blur', clampSize);

  /* 低频字：输入过程中不改写其 value，失焦时才夹逼 */
  const clampExtra = () => {
    const minExtra = Number(extraEl.min) || 0;
    const maxExtra = Number(extraEl.max) || 400;
    const ev = Math.max(minExtra, Math.min(maxExtra, Math.round(Number(extraEl.value) || 0)));
    extraEl.value = ev;
    syncNumStepButtons();
  };
  extraEl.addEventListener('input', syncNumStepButtons);
  extraEl.addEventListener('change', clampExtra);
  extraEl.addEventListener('blur', clampExtra);

  /* 轮数：输入时不改写，失焦时夹到 1–999 */
  const clampRounds = () => {
    if (roundsEl.disabled) return;
    const r = Math.max(1, Math.min(999, Math.round(Number(roundsEl.value)) || 20));
    roundsEl.value = r;
    syncNumStepButtons();
  };
  roundsEl.addEventListener('input', () => {
    auto = Number(roundsEl.value) === (suggest[Number(sizeEl.value)] || 0);
    syncNumStepButtons();
  });
  roundsEl.addEventListener('change', clampRounds);
  roundsEl.addEventListener('blur', clampRounds);

  clampSize();

  /* 模式切换：单人/双人/三人/四人 */
  const modeRadios = document.querySelectorAll('input[name="playerCount"]');
  const secEl = $('turnSeconds');
  const maxLenEl = $('maxPoemLen');
  const limitCoupletEl = $('limitCouplet');

  /* 每步时间与字数上限：单人模式时变灰；双人/三人/四人时恢复数字输入 */
  const syncModeFields = () => {
    const sel = document.querySelector('input[name="playerCount"]:checked');
    const isSolo = sel && Number(sel.value) === 1;
    if (isSolo) {
      if (secEl.type !== 'text') secEl.dataset.prevVal = secEl.value || '120';
      secEl.type = 'text';
      secEl.value = '∞';
      secEl.disabled = true;
      if ($('turnSecondsHint')) $('turnSecondsHint').textContent = '单人模式不限时';

      if (maxLenEl) {
        if (maxLenEl.type !== 'text') maxLenEl.dataset.prevVal = maxLenEl.value || '17';
        maxLenEl.type = 'text';
        maxLenEl.value = '∞';
        maxLenEl.disabled = true;
        if ($('maxPoemLenHint')) $('maxPoemLenHint').textContent = '单人模式不限字数';
      }
      if (limitCoupletEl) {
        limitCoupletEl.disabled = true;
        if ($('limitCoupletHint')) $('limitCoupletHint').textContent = '单人模式不限联句';
      }
      if ($('freeSubmit')) {
        $('freeSubmit').disabled = true;
        if ($('freeSubmitHint')) $('freeSubmitHint').textContent = '单人模式默认自由';
      }
    } else {
      secEl.type = 'number';
      secEl.disabled = false;
      secEl.value = secEl.dataset.prevVal || '120';
      if ($('turnSecondsHint')) $('turnSecondsHint').textContent = '秒 · 超时自动放弃';

      if (maxLenEl) {
        maxLenEl.type = 'number';
        maxLenEl.disabled = false;
        maxLenEl.value = maxLenEl.dataset.prevVal || '17';
        if ($('maxPoemLenHint')) $('maxPoemLenHint').textContent = '5–99 字';
      }
      if (limitCoupletEl) {
        limitCoupletEl.disabled = false;
        if ($('limitCoupletHint')) $('limitCoupletHint').textContent = '限制律绝单次提交';
      }
      if ($('freeSubmit')) {
        $('freeSubmit').disabled = false;
        if ($('freeSubmitHint')) $('freeSubmitHint').textContent = '像单人模式一样随意提交';
      }
    }
    syncNumStepButtons();
  };

  modeRadios.forEach((r) => {
    r.addEventListener('change', () => {
      document.querySelectorAll('#playerCountGroup .modepill').forEach((p) => p.classList.remove('checked'));
      const pill = r.closest('.modepill');
      if (pill) pill.classList.add('checked');
      const val = Number(r.value);
      if ($('roundsHint')) $('roundsHint').textContent = val === 1 ? '每轮一手' : '每轮各一手';
      syncModeFields();
    });
  });

  /* 骰子：顺手换一位诗人当名字 */
  $('btnReNick').addEventListener('click', rerollNick);

  /* 「战至最后一刻」＝不限轮数，与「轮数」互斥：勾上就把轮数输入框变灰 */
  const endlessEl = $('endless');
  const syncEndless = () => {
    roundsEl.disabled = endlessEl.checked;
    syncNumStepButtons();
  };
  endlessEl.addEventListener('change', syncEndless);
  syncEndless();

  /* 每步时间：失焦时夹到 15–600 秒 */
  const clampSec = () => {
    if (secEl.disabled || secEl.type === 'text') return;
    const n = Math.max(15, Math.min(600, Math.round(Number(secEl.value) || 120)));
    secEl.value = n;
    syncNumStepButtons();
  };
  secEl.addEventListener('input', syncNumStepButtons);
  secEl.addEventListener('change', clampSec);
  secEl.addEventListener('blur', clampSec);
  clampSec();

  /* 字数上限：失焦时夹到 5–99 字 */
  const clampMaxLen = () => {
    if (!maxLenEl || maxLenEl.disabled || maxLenEl.type === 'text') return;
    const n = Math.max(5, Math.min(99, Math.round(Number(maxLenEl.value) || 17)));
    maxLenEl.value = n;
    syncNumStepButtons();
  };
  if (maxLenEl) {
    maxLenEl.addEventListener('input', syncNumStepButtons);
    maxLenEl.addEventListener('change', clampMaxLen);
    maxLenEl.addEventListener('blur', clampMaxLen);
    clampMaxLen();
  }
  syncModeFields();

  $('btnCreate').addEventListener('click', async () => {
    /* 大厅里改的名字和房间里改的名字是同一件事：先过额度，过了才建 */
    if (!(await passNickGate())) return;
    const kinds = {};
    document.querySelectorAll('#kinds input').forEach((x) => { kinds[x.value] = x.checked; });
    const selMode = document.querySelector('input[name="playerCount"]:checked');
    const pCount = selMode ? Number(selMode.value) || 2 : 2;
    const body = {
      nick: $('nick').value.trim(),
      uid: getUid(),
      playerCount: pCount,
      size: Number(sizeEl.value),
      rounds: Number(roundsEl.value),
      extra: Number($('extra').value) || 0,
      endless: $('endless').checked,
      isPrivate: !!($('isPrivate') && $('isPrivate').checked),
      allowDup: false,
      turnSeconds: pCount === 1 ? 0 : (Number(secEl.value) || 120),
      maxPoemLen: pCount === 1 ? 0 : (maxLenEl ? (Number(maxLenEl.value) || 17) : 17),
      limitCouplet: pCount === 1 ? false : ($('limitCouplet') ? $('limitCouplet').checked : true),
      freeSubmit: pCount === 1 ? false : ($('freeSubmit') ? $('freeSubmit').checked : false),
      kinds,
    };
    $('btnCreate').disabled = true;
    const { data } = await post('/api/create', body);
    $('btnCreate').disabled = false;
    if (!data.ok) {
      /* 服务端也判了一次冷却（前端探测失败、或两个标签页同时操作时才会走到这里） */
      if (data.code === 'cooldown') {
        return askGame({
          eyebrow: '改名', title: '自定义昵称 24 小时只能改一次',
          body: nickCoolBody(data), okText: '知道了', hideCancel: true,
        });
      }
      return toast(data.reason || '创建失败');
    }
    ME = { roomId: data.roomId, seat: data.seat, token: data.token };
    save();
    /* 用服务端实际生效的昵称：名字留空时服务端会补一位随机作者，
       记空了下次还得重抽，不如记住真的用了哪个 */
    rememberNick((data.state && data.state.youNick) || body.nick);
    waitDismissed = false;
    enterGame(data.state);
    if (pCount > 1) {
      $('waitCode').textContent = data.roomId;
      $('shareUrl').value = roomLink(data.roomId);
      $('waitOverlay').classList.remove('hidden');
    }
  });

  $('btnJoin').addEventListener('click', join);
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

  /* 反馈：大厅和局内各有一个入口，共用同一个弹窗 */
  Array.prototype.forEach.call(document.querySelectorAll('.fb-open'), (b) => {
    b.addEventListener('click', openFeedback);
  });
  $('fbCancel').addEventListener('click', closeFeedback);
  $('fbSend').addEventListener('click', sendFeedback);
  $('fbOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'fbOverlay') closeFeedback();
  });

  /* 房间列表：点某一行的「加入」＝ 填入房号并进房 */
  $('roomList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-code]');
    if (!b || b.disabled) return;
    $('joinCode').value = b.getAttribute('data-code');
    join();
  });

  $('btnCopyLink').addEventListener('click', async () => {
    const v = $('shareUrl').value;
    try { await navigator.clipboard.writeText(v); toast('链接已复制'); }
    catch (_) { $('shareUrl').select(); document.execCommand('copy'); toast('链接已复制'); }
  });

  $('roomChip').addEventListener('click', async () => {
    if (!S) return;
    try { await navigator.clipboard.writeText(S.id); toast('房间号已复制'); } catch (_) {}
  });

  /* 导入本地进度恢复对局 */
    if ($('btnOpenCorpus')) $('btnOpenCorpus').addEventListener('click', () => openCorpusModal());
  if ($('btnOpenCorpus2')) $('btnOpenCorpus2').addEventListener('click', () => openCorpusModal());
  if ($('btnCloseCorpus')) $('btnCloseCorpus').addEventListener('click', closeCorpusModal);
  if ($('corpusOverlay')) {
    $('corpusOverlay').addEventListener('click', (e) => {
      if (e.target && e.target.id === 'corpusOverlay') closeCorpusModal();
    });
  }
  if ($('tabPoem')) $('tabPoem').addEventListener('click', () => switchCorpusTab('poem'));
  if ($('tabProbe')) $('tabProbe').addEventListener('click', () => switchCorpusTab('probe'));
  if ($('tabStats')) $('tabStats').addEventListener('click', () => switchCorpusTab('stats'));
  if ($('btnCorpusDoSearch')) $('btnCorpusDoSearch').addEventListener('click', doCorpusSearch);
  if ($('corpusQuery')) {
    $('corpusQuery').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doCorpusSearch(); }
    });
  }
  if ($('corpusChips')) {
    $('corpusChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.corpus-chip');
      if (chip && chip.dataset.val) {
        $('corpusQuery').value = chip.dataset.val;
        doCorpusSearch();
      }
    });
  }
  // 检测 URL 参数是否需要直接拉起语料查验窗口
  try {
    const sp = new URLSearchParams(location.search);
    if (sp.get('corpus') === '1' || sp.get('view') === 'corpus') {
      setTimeout(() => openCorpusModal(sp.get('q') || ''), 200);
    }
  } catch (_) {}
  
  $('btnOpenImport').addEventListener('click', openImportModal);
  $('btnCancelImport').addEventListener('click', closeImportModal);
  $('btnSelectImportFile').addEventListener('click', () => { $('importFileInput').click(); });
  $('importFileInput').addEventListener('change', handleImportFileSelect);
  $('btnConfirmImport').addEventListener('click', confirmImport);
  $('importOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'importOverlay') closeImportModal();
  });
}

async function join() {
  const code = $('joinCode').value.trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 5);
  if (code.length !== 3 && code.length !== 5) return toast('房号为 3 位数字或 5 位字母数字');
  /* 大厅改名要过同一套额度（会用掉额度先讲清楚，已经用过就当场劝住） */
  if (!(await passNickGate())) return;
  /* 昵称没填就沿用上次用过的名字：重进房间时靠它认回自己的席位 */
  let nick = $('nick').value.trim();
  if (!nick) {
    try { nick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
  }
  let prevToken = '';
  try {
    const saved = load();
    if (saved && saved.roomId === code && saved.token) prevToken = saved.token;
    if (!prevToken) prevToken = localStorage.getItem('feihua-token-' + code) || '';
  } catch (_) {}
  const { data } = await post('/api/join', { roomId: code, nick: nick || '', token: prevToken, uid: getUid() });
  if (!data.ok) {
    if (data.code === 'cooldown') {
      return askGame({
        eyebrow: '改名', title: '自定义昵称 24 小时只能改一次',
        body: nickCoolBody(data), okText: '知道了', hideCancel: true,
      });
    }
    return toast(data.reason || '加入失败');
  }
  ME = { roomId: data.roomId, seat: data.seat, role: data.role, token: data.token };
  save();
  rememberNick(data.state && data.state.youNick ? data.state.youNick : nick);
  enterGame(data.state);
  if (data.reclaimed) toast('已接回你原来的席位');
  else if (data.resumed) toast('已接回你原来的身份');
  else if (data.hidden) toast('开发者模式：已隐形进入房间');
  else if (data.role === 'spectator') toast('房间已满，你以观众身份进入');
}

/* 记住昵称（只在本地）：下次进来没填名字时用它，服务端凭同名+离线把席位还给你 */
function rememberNick(nick) {
  const n = String(nick || '').trim();
  if (!n) return;
  try { localStorage.setItem('feihua-nick', n); } catch (_) {}
  if (!$('nick').value.trim()) $('nick').value = n;
}

/* 向服务端要一位语料作者（前端没有作者表，也不该有） */
async function fetchRandomName() {
  const r = await fetch('/api/rand-name', { cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  return (d && d.name) || '';
}

/* 这个浏览器的长期身份 —— 只给「自定义昵称 24 小时只能改一次」用。
   token / mid 都是按房间发的，换个房间就是另一个人，没法跨房间计数；
   所以需要一个不随房间变的东西。localStorage 被清掉就换一个新的（届时限制也就重来一次），
   这是这套做法的固有弱点：它挡的是「反复改名」，不是防恶意用户。 */
function getUid() {
  try {
    let u = localStorage.getItem('feihua-uid') || '';
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(u)) {
      const hex = (n) => Math.random().toString(36).slice(2, 2 + n);
      u = 'u' + Date.now().toString(36) + hex(10) + hex(10);
      /* crypto.randomUUID 只在安全上下文有（https / localhost），
         用 http://192.168.x.x 打开本地服务时拿不到，所以上面那个兜底必须留着 */
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        u = 'u' + window.crypto.randomUUID().replace(/-/g, '');
      }
      localStorage.setItem('feihua-uid', u);
    }
    return u;
  } catch (_) { return ''; }
}

/* 自定义昵称的额度：还能改吗？还要等多久？ —— 保存前问一次，别等玩家写完才被拒。 */
async function fetchNickQuota() {
  try {
    const r = await fetch('/api/nick-status?uid=' + encodeURIComponent(getUid()), { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) return d;
  } catch (_) { /* 查不到就不拦：真正的判据在服务端，这里只负责提前提醒 */ }
  return null;
}

/* 大厅这条路（建房 / 加入）没有「点保存」这个时机，名字是随请求一起发出去的 ——
   所以在发请求之前先问一次服务端：这是诗人名还是自定义名、跟上次比变没变、今天还改不改得动。
   带上 nick 之后，服务端会直接给出 isCustom / unchanged / willBlock / needsPay 四个判断，
   前端不再自己猜规则（规则只有一处：nickGate）。 */
async function nickPrecheck(name) {
  const n = String(name || '').trim();
  if (!n) return null;
  try {
    const r = await fetch(DEV.url('/api/nick-status?uid=' + encodeURIComponent(getUid()) +
      '&nick=' + encodeURIComponent(n)), { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) return d;
  } catch (_) { /* 查不到就放行：服务端还有一道，别因为一次探测失败把人挡在门外 */ }
  return null;
}

/* 冷却弹窗的正文：两边（大厅 / 房间）措辞保持一致 */
function nickCoolBody(g) {
  const who = g && g.lastNick ? '上次改成了 <b>「' + esc(g.lastNick) + '」</b>' : '今天已经改过一次自定义昵称';
  const wait = g && g.waitMs ? '还要等 <b class="askwait">' + fmtWait(g.waitMs) + '</b> 才能再改' : '';
  return who + (wait ? '，' + wait : '') + '。<br>' +
    '想现在就换个名字，可以抽一位诗人当昵称 —— <b>诗人名不占额度</b>，随时能再换。';
}

/* 建房 / 加入之前过一遍额度。返回 true 才会真的发请求。
   会用掉额度 → 先说清楚后果；已经用过 → 当场劝住，并给出「抽诗人」这个不占额度的出口。 */
async function passNickGate() {
  const name = $('nick').value.trim();
  if (!name) return true;                 /* 留空 = 服务端随机补个诗人名，不占额度 */
  const g = await nickPrecheck(name);
  if (!g) return true;
  if (g.willBlock) {
    const r = await askGame({
      eyebrow: '改名',
      title: '自定义昵称 24 小时只能改一次',
      body: nickCoolBody(g),
      okText: '抽一位诗人继续',
      cancelText: '取消',
    });
    if (r !== 'ok') return false;
    const fresh = await fetchRandomName();
    if (!fresh) { toast('没抽到，再试一次'); return false; }
    $('nick').value = fresh;
    rememberNick(fresh);
    return true;
  }
  if (g.needsPay) {
    /* 名字没变（本地已记住的名字就是当前输入）：沿用旧名字不属于「改名」，不重复弹窗提醒 */
    let localNick = '';
    try { localNick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
    if (localNick && localNick === name) return true;
    const r = await askGame({
      eyebrow: '改名',
      title: '会占用今天唯一一次自定义改名机会',
      body: '把名字改成 <b>「' + esc(name) + '」</b> 之后，<b>24 小时内不能再改成别的自定义昵称</b>。' +
        '<br>想随时换名字，可以点右侧骰子抽一位诗人 —— 诗人名不占额度。',
      okText: '确定用这个名字',
      cancelText: '再想想',
    });
    return r === 'ok';
  }
  return true;                            /* 诗人名 / 名字没变 → 不打扰 */
}

/* 剩余时间说人话：跟服务端 fmtWait 保持同一口径 */
function fmtWait(ms) {
  const m = Math.max(1, Math.ceil(Number(ms || 0) / 60000));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60), mm = m % 60;
  return mm ? h + ' 小时 ' + mm + ' 分' : h + ' 小时';
}

/* 默认昵称：第一次来（没有记住的名字）时，向服务端要一位语料作者。
   只在输入框还空着时写入 —— 用户已经开始打字就不覆盖。
   取名逻辑放在服务端，前端拿不到语料表，也免得两边各随机一个。 */
async function fillRandomNick() {
  const el = $('nick');
  if (!el || el.value.trim()) return;
  try {
    const name = await fetchRandomName();
    if (name && !el.value.trim()) {
      el.value = name;
      rememberNick(name);   /* 抽到就记住，否则每次刷新都换一个人，看着像名字在闪 */
    }
  } catch (_) { /* 拿不到就留空，服务端建房时还会补一个 */ }
}

/* 骰子：手动重随默认昵称。用户自己改过名字也算数——点它就是明说要换。 */
async function rerollNick() {
  const btn = $('btnReNick'), el = $('nick');
  if (!btn || btn.disabled || !el) return;
  btn.disabled = true;
  btn.classList.remove('spin');
  void btn.offsetWidth;               /* 强制重排，让动画能连点连播 */
  btn.classList.add('spin');
  try {
    const name = await fetchRandomName();
    if (!name) { toast('没抽到，再试一次'); return; }
    el.value = name;
    rememberNick(name);
    toast('换成了「' + name + '」');
  } catch (_) {
    toast('网络不给力，再试一次');
  } finally {
    setTimeout(() => { btn.disabled = false; btn.classList.remove('spin'); }, 360);
  }
}

/* ---------- 大厅：当前房间列表 ----------
   列出所有还开着的房间（房号 / 双方昵称 / 规格 / 进度），能坐进去的直接给「加入」按钮。
   大厅可见时每 5 秒刷新一次，最多 24 条。 */
/* ---------- 公告栏 ----------
   内容存在服务器的 data/notice.json 里，审阅页可改 —— 所以「改一句话」不需要重新发布。
   公开接口、不用口令；30 秒一次（够快，也不至于把接口打热）。
   大厅常驻显示，局内仅在对局中新发布时弹出并带有 × 关闭按钮。 */
let noticePoll = null;
let noticeSig = '';
let latestNoticeAt = 0;
let gameEnterNoticeAt = 0;
let dismissedGameNoticeAt = 0;

async function loadNotice() {
  let d = null;
  try {
    const r = await fetch('/api/notice', { cache: 'no-store' });
    d = await r.json();
  } catch (_) { return; }
  const n = (d && d.notice) || null;
  if (n && n.at) latestNoticeAt = n.at;

  /* 大厅公告：没有公告时不留一条空带子，而是显示「暂无公告」的灰条（.empty） */
  const lobbyBox = $('notice');
  if (lobbyBox && !$('lobby').classList.contains('hidden')) {
    const sig = n ? (n.kind + '|' + n.text) : '~empty';
    if (sig !== noticeSig) {
      noticeSig = sig;
      /* 只用 textContent：公告是运营文案，绝不当 HTML 解析 */
      $('noticeTag').textContent = (n && n.kind === 'warn') ? '注意' : '公告';
      $('noticeText').textContent = n ? n.text : '暂无公告';
      lobbyBox.classList.toggle('warn', !!(n && n.kind === 'warn'));
      lobbyBox.classList.toggle('empty', !n);
    }
    lobbyBox.classList.remove('hidden');
  }

  /* 对局内新发公告：只对玩家在对局页面内且公告是进入后新发布的才展示 */
  const gBox = $('gameNotice');
  if (gBox) {
    const inGame = !$('game').classList.contains('hidden');
    const isNew = !!(n && n.text && n.at && n.at > gameEnterNoticeAt && n.at !== dismissedGameNoticeAt);
    if (inGame && isNew) {
      $('gameNoticeTag').textContent = (n.kind === 'warn') ? '注意' : '公告';
      $('gameNoticeText').textContent = n.text;
      gBox.classList.toggle('warn', n.kind === 'warn');
      gBox.classList.remove('hidden');
    } else if (!isNew || !inGame) {
      gBox.classList.add('hidden');
    }
  }
}

async function loadRooms() {
  const box = $('roomList');
  if (!box || $('lobby').classList.contains('hidden')) return;
  let d = null;
  try {
    const r = await fetch(DEV.url('/api/rooms'), { cache: 'no-store' });
    d = await r.json();
  } catch (_) { return; }
  const list = (d && d.rooms) || [];
  $('roomCount').textContent = list.length ? list.length + ' 间' : '暂无';
  /* 开发者提示条：只在带了口令时出现，顺带说明「进房是隐形的」，免得以为坏了 */
  const devNote = DEV.on
    ? '<li class="devnote"><span>开发者模式已开启：大厅会列出私密房间；进任何房间都是隐形观战（不占席位、不进成员名单、不写进出事件）。</span>' +
      '<button type="button" class="devoff" id="btnDevOff">关闭开发者模式</button></li>'
    : '';
  if (!list.length) {
    box.innerHTML = devNote + '<li class="empty">现在还没有开着的房间，左边开一局吧。</li>';
    return;
  }
  box.innerHTML = devNote + list.map((r) => {
    const pCount = r.playerCount || 2;
    const pText = pCount === 1 ? '单人' : pCount === 3 ? '三人' : pCount === 4 ? '四人' : '双人';
    const spec = pText + ' · ' + r.size + '×' + r.size + ' · ' +
      (r.endless ? '战至最后一刻' : r.rounds + ' 轮') + ' · ' + r.turnSeconds + ' 秒 · ' +
      esc(r.kinds || '诗') + ' · ' + (r.extra ? '低频 ' + r.extra + ' 字' : '无低频字');
    let score = '';
    if (r.phase === 'playing' && r.score) {
      if (pCount === 1) score = ' ｜ 赤 ' + (r.score.a || 0);
      else if (pCount === 2) score = ' ｜ 赤 ' + (r.score.a || 0) + ' : ' + (r.score.b || 0) + ' 青';
      else if (pCount === 3) score = ' ｜ 赤 ' + (r.score.a || 0) + ' : ' + (r.score.b || 0) + ' : ' + (r.score.c || 0);
      else score = ' ｜ 赤 ' + (r.score.a || 0) + ' : ' + (r.score.b || 0) + ' : ' + (r.score.c || 0) + ' : ' + (r.score.d || 0);
    }
    let state, cls;
    const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
    const allSeated = reqSeats.every((s) => r.players && r.players[s]);
    const allReady = reqSeats.every((s) => r.ready && r.ready[s]);
    if (r.phase === 'waiting') {
      cls = 'wait';
      if (pCount === 1) {
        state = r.ready && r.ready.A ? '准备完毕' : '等待准备';
      } else {
        state = !allSeated ? (r.hostOnline === false ? '房主离线' : '等待选手')
          : (allReady ? '准备完毕' : '等待全员准备');
      }
    } else if (r.paused) {
      cls = 'pause'; state = '已暂停';
    } else {
      cls = 'live'; state = '对局中 第 ' + r.round + (r.endless ? ' 轮' : ' / ' + r.rounds + ' 轮');
    }
    const seatWord = (n) => (n ? esc(n) : '<span class="empty-seat">空位</span>');
    const who = reqSeats.map((s) => seatWord(r.players && r.players[s])).join('<span class="vs">vs</span>');
    const label = r.joinable ? '加入' : '观战';
    const watchTag = r.watchers ? '<span class="rwatch">观众 ' + r.watchers + '</span>' : '';
    return '<li class="roomrow">' +
      '<span class="rcode' + (String(r.id || '').length > 3 ? ' wide' : '') + '">' + esc(r.id) + '</span>' +
      '<div class="rmain"><div class="rwho">' +
      (r.isPrivate ? '<span class="rpriv">私密</span>' : '') + who + '</div>' +
      '<div class="rspec">' + spec + score + watchTag + '</div></div>' +
      '<span class="rstate ' + cls + '">' + state + '</span>' +
      '<button' + (r.joinable ? ' class="primary"' : '') +
      ' data-code="' + esc(r.id) + '">' + label + '</button></li>';
  }).join('');
}

/* ---------- 反馈：写给开发者的话 ----------
   不要求登录、不强制留联系方式：玩家愿意说两句就已经很难得。
   服务端限长 1000 字、同 IP 30 秒一条，失败原因（太频繁 / 存不下）如实回显。 */
function openFeedback() {
  $('fbText').value = '';
  $('fbContact').value = '';
  $('fbOverlay').classList.remove('hidden');
  setTimeout(() => { try { $('fbText').focus(); } catch (_) {} }, 60);
}

function closeFeedback() {
  $('fbOverlay').classList.add('hidden');
}

async function sendFeedback() {
  const text = $('fbText').value.trim();
  if (text.length < 2) { toast('再多写两个字吧'); return; }
  const btn = $('fbSend');
  btn.disabled = true;
  try {
    const { data } = await post('/api/feedback', {
      text,
      contact: $('fbContact').value.trim(),
      nick: (S && S.youNick) || $('nick').value.trim(),
      roomId: (ME && ME.roomId) || '',
    });
    if (!data || !data.ok) { toast((data && data.reason) || '发送失败，稍后再试'); return; }
    closeFeedback();
    toast('已收到，谢谢！');
  } catch (_) {
    toast('网络不给力，稍后再试');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 心跳 ----------
   SSE 只能证明「这条连接开着」，证明不了「人还在」：手机切网、进程被杀、休眠时
   连接会变成半开（socket 还在，对端早没了），服务端收不到 close，就会一直以为你
   还在房间里 —— 席位不让、房间不消失、重进还看到自己坐在原地。
   所以每 20 秒报一次心跳，让服务端有依据判「人已经走了」（阈值 75 秒）。 */
const BEAT_MS = 20000;
let beatTimer = null;
let leftByUser = false;      /* 已经主动点过「离开房间」，卸载钩子不用再发一次 */

function beatOnce() {
  if (!ME) return;
  try {
    fetch('/api/room/' + ME.roomId + '/beat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: ME.token }),
      keepalive: true,          /* 页面正在卸载时也尽量把这一发送出去 */
    }).catch(() => {});
  } catch (_) {}
}

function startBeat() {
  stopBeat();
  if (!ME) return;
  beatOnce();
  beatTimer = setInterval(beatOnce, BEAT_MS);
}

function stopBeat() {
  if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
}

/* 后台标签页的定时器会被浏览器节流到一分钟一次，回到前台时立刻补一次 */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ME) beatOnce();
});

function enterGame(state) {
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('headInfo').classList.remove('hidden');
  leftByUser = false;
  gameEnterNoticeAt = latestNoticeAt || Date.now();
  dismissedGameNoticeAt = 0;
  if ($('gameNotice')) $('gameNotice').classList.add('hidden');
  endDismissed = false;
  applyState(state);
  connect();
  startBeat();
}

/* ---------- SSE ----------
   EventSource 自己会重连，但有三种情况它救不回来，页面会变成一块冻住的棋盘：
     · 服务端重启中：页面停在旧画面，没有任何提示，玩家以为对局被吞了；
     · 服务端回了 401（房间随重启一起没了）：EventSource 直接 CLOSED，不再重试；
     · 重连成功后玩家还在对旧画面发呆，不知道已经恢复了。
   所以这里自己管：断线超过 1.2 秒浮出遮罩、遮罩期间探房间还在不在、被判死就手动重建。 */
function connect() {
  if (!ME) return;
  if (ES) { try { ES.close(); } catch (_) {} ES = null; }
  ES = new EventSource('/api/room/' + ME.roomId + '/events?t=' + encodeURIComponent(ME.token));
  ES.onopen = () => { hideNetMask(); };
  ES.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'state') { hideNetMask(); applyState(msg.state); }
  };
  ES.onerror = () => {
    armNetMask();
    /* 0=CONNECTING（浏览器自己会重试）  1=OPEN  2=CLOSED（被拒绝，不会自己再试） */
    if (ES && ES.readyState === 2) {
      try { ES.close(); } catch (_) {}
      ES = null;
      const wait = Math.min(1000 * Math.pow(1.6, netRetry++), 8000);
      setTimeout(() => { if (ME && !netGone) connect(); }, wait);
    }
  };
}

/* 2026-10-24：断线遮罩已整体移除（用户明确要求）。
   原因：SSE 偶尔抖一下时，1.2 秒就浮出遮罩、重连成功后立刻收起，一天里频繁闪几次，
   比「什么都不显示」更影响体验。现在断线期间界面上不做任何提示。
   ⚠️ 但**重连与房间探测必须保留**：probeRoom 决定「本局是否已在服务端结束」，
   那个分支要 toast 提示玩家并允许留在缓存窗口。函数名沿用旧名（不改名是怕漏改调用点），
   实际上已不再操作任何 DOM。 */
function armNetMask() {
  if (netTimer || netShown || netGone) return;
  netTimer = setTimeout(() => { netTimer = null; showNetMask(); }, 1200);
}

function showNetMask() {
  if (!ME || netShown || netGone) return;
  netShown = true;
  if (netProbe) clearInterval(netProbe);
  netProbe = setInterval(probeRoom, 2500);
  probeRoom();
}

function hideNetMask() {
  if (netTimer) { clearTimeout(netTimer); netTimer = null; }
  if (netProbe) { clearInterval(netProbe); netProbe = null; }
  netRetry = 0;
  netShown = false;
}

/* 尝试使用客户端快照向服务端申请复活房间（容器云抹盘重启场景） */
async function tryReseedRoom(customState) {
  if (!ME || !ME.roomId) return false;
  let st = customState || S;
  if (!st) {
    try {
      const raw = sessionStorage.getItem('feihua-state-' + ME.roomId);
      if (raw) st = JSON.parse(raw);
    } catch (_) {}
  }
  if (!st || !st.board || !st.cfg) return false;
  let nick = '';
  try { nick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
  if (!nick && ME.seat && st.players && st.players[ME.seat]) {
    nick = st.players[ME.seat];
  }
  try {
    const res = await post('/api/reseed', {
      roomId: ME.roomId,
      token: ME.token,
      seat: ME.seat,
      nick: nick,
      state: st,
    });
    if (res.status === 200 && res.data && res.data.ok) {
      ME = {
        roomId: res.data.roomId,
        seat: res.data.seat,
        role: res.data.role,
        token: res.data.token,
      };
      save();
      netGone = false;
      hideNetMask();
      applyState(res.data.state);
      connect();
      startBeat();
      toast(res.data.reseeded ? '服务已重启，对局已自动复原，可以继续游戏！' : '已重新连接回到对局！');
      return true;
    }
  } catch (_) {}
  return false;
}

/* 遮罩期间探一次：房间还在就重新连 SSE；如果已不在，则关闭弹窗遮罩，让用户依靠缓存留在当前窗口 */
async function probeRoom() {
  if (!ME) return;
  try {
    const r = await fetch('/api/room/' + ME.roomId + '/peek?t=' + encodeURIComponent(ME.token), { cache: 'no-store' });
    if (r.status === 404) {
      const reseeded = await tryReseedRoom();
      if (reseeded) return;
      netGone = true;
      hideNetMask();
      toast('本局在服务端已结束，当前为离线缓存浏览状态');
      return;
    }
    if (r.status === 401) {
      let nick = '';
      try { nick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
      const jRes = await post('/api/join', { roomId: ME.roomId, nick, token: ME.token });
      if (jRes.status === 200 && jRes.data && jRes.data.ok) {
        ME = { roomId: jRes.data.roomId, seat: jRes.data.seat, role: jRes.data.role, token: jRes.data.token };
        save();
        applyState(jRes.data.state);
        connect();
        startBeat();
        return;
      }
      const reseeded = await tryReseedRoom();
      if (reseeded) return;
      netGone = true;
      hideNetMask();
      toast('本局在服务端已结束，当前为离线缓存浏览状态');
      return;
    }
    if (r.ok) {
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        if (!ES || ES.readyState === 2) connect();   /* 房间回来了（服务已重启完） */
      }
    }
  } catch (_) { /* 服务还没活过来，继续等 */ }
}

/* 回大厅：房间已经没了，不用再走 /leave（那条路只会 404），直接把本地身份清掉重载。
   2026-10-24 起唯一调用它的「回到大厅」按钮随断线遮罩一起移除，当前没有调用点；
   保留是因为它仍是「房间失效后彻底退干净」的完整实现，恢复遮罩或加新入口时可直接复用。 */
function backToLobby() {
  if (ES) { try { ES.close(); } catch (_) {} ES = null; }
  stopBeat();
  ME = null; save();
  hideNetMask();
  location.href = selfLink();
}

/* ---------- 渲染 ---------- */

/* 面板逐个渲染，互不连累。
   2026-10-22：renderDispute 里一个被误删的局部量（canControl）抛了 ReferenceError，
   于是它后面的成员 / 事件面板整段不再执行，而界面上只表现为「按钮不见了」，
   从现象完全看不出根因。现在每个面板各自兜住：一个挂了，其余照常刷新；
   错误记进 window.__renderErrors（有上限），既方便肉眼排查，也让回归测试能断言「一个都没挂」。 */
function renderAll() {
  const steps = [
    renderScore, renderBoard, renderTurn, renderLog, renderConsent, renderReady,
    renderSetup, renderPool, renderRef, renderPause, renderWatch, renderDispute,
    renderMembers, renderEvents, syncRoomTabs,
  ];
  for (const fn of steps) {
    try {
      fn();
    } catch (err) {
      const box = (window.__renderErrors || (window.__renderErrors = []));
      if (box.length < 50) box.push(fn.name + ': ' + String((err && err.message) || err));
      if (window.console && console.error) console.error('[render] ' + fn.name + ' 失败', err);
    }
  }
}

function applyState(st) {
  const first = !S || S.id !== st.id;
  S = st;
  try {
    sessionStorage.setItem('feihua-state-' + st.id, JSON.stringify(st));
  } catch (_) {}
  if (ME) { ME.seat = st.you || null; ME.role = st.role || 'guest'; }
  if (first) { prevLogLen = st.log.length; }

  /* 本手刚变化的格子：必须在 renderBoard 之前算好。
     早先这段放在 renderLog 里，而 renderLog 排在 renderBoard 之后 —— flash 要等到
     1.1 秒后那次清空重绘才加得上，等于永远不会闪。 */
  const lg = st.log || [];
  let flash = [];
  if (lg.length > prevLogLen) {
    const e = lg[lg.length - 1];
    if (e.type === 'fly' && e.cells) flash = e.cells.slice();
  }
  prevLogLen = lg.length;
  st._flash = flash;
  if (flash.length) {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (S) { S._flash = []; renderBoard(); } }, 1100);
  }

  skew = st.serverNow - Date.now();

  $('roomChip').textContent = st.id;
  $('roundNow').textContent = st.round;
  $('roundAll').textContent = st.endless ? '∞' : st.rounds;
  /* 「这局考什么文体、除棋盘外多了几个字」—— 大厅和局内都摆出来，省得开局后想不起规则 */
  $('cfgText').textContent = ruleLabel(st.cfg) + ' · ';
  $('phaseText').textContent =
    st.phase === 'waiting' ? '等待对手' : (st.phase === 'playing' ? '对局中' : '已结束');
  $('limitRule').textContent = turnSeconds();

  renderAll();

  // 浮层：只在「还没坐满」时自动弹；到齐后收起，改用操作台里的准备条；单人模式不弹
  const waiting = st.phase === 'waiting';
  const pCount = (st.cfg && st.cfg.playerCount) || 2;
  const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
  const full = reqSeats.every((s) => st.seats && st.seats[s]);
  if (full) waitDismissed = false;
  const showWait = waiting && !full && !waitDismissed && pCount > 1;
  $('waitOverlay').classList.toggle('hidden', !showWait);
  if (showWait) {
    $('waitCode').textContent = st.id;
    $('shareUrl').value = roomLink(st.id);
  }

  const ended = st.phase === 'finished';
  const endWasOpen = !$('endOverlay').classList.contains('hidden');
  if (!ended) {
    endDismissed = false;
    if (endWasOpen) $('endOverlay').classList.add('hidden');
  } else if (!endDismissed && !endWasOpen) {
    showEnd();
  }

  if (st.phase !== 'playing') syncClock();
}

function renderScore() {
  const c = S.score || { a: 0, b: 0, c: 0, d: 0, n: 0 };
  const total = Math.max(1, (c.a || 0) + (c.b || 0) + (c.c || 0) + (c.d || 0) + (c.n || 0));

  $('numA').textContent = c.a || 0;
  $('numB').textContent = c.b || 0;
  if ($('numC')) $('numC').textContent = c.c || 0;
  if ($('numD')) $('numD').textContent = c.d || 0;

  $('lgA').textContent = c.a || 0;
  $('lgB').textContent = c.b || 0;
  if ($('lgC')) $('lgC').textContent = c.c || 0;
  if ($('lgD')) $('lgD').textContent = c.d || 0;
  $('lgN').textContent = c.n || 0;
  $('lgTurns').textContent = (S.log || []).filter((e) => e.type === 'fly' || e.type === 'pass').length;

  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const seatDefs = [
    { id: 'A', name: '赤营', teamEl: $('teamA'), segEl: $('segA'), legEl: $('legendA'), val: c.a || 0 },
    { id: 'B', name: '青营', teamEl: $('teamB'), segEl: $('segB'), legEl: $('legendB'), val: c.b || 0 },
    { id: 'C', name: '金营', teamEl: $('teamC'), segEl: $('segC'), legEl: $('legendC'), val: c.c || 0 },
    { id: 'D', name: '翠营', teamEl: $('teamD'), segEl: $('segD'), legEl: $('legendD'), val: c.d || 0 },
  ];
  seatDefs.forEach((sd, idx) => {
    const active = idx < pCount;
    if (sd.teamEl) {
      sd.teamEl.classList.toggle('hidden', !active);
      if (active) {
        sd.teamEl.classList.toggle('active', S.phase === 'playing' && S.turn === sd.id);
        const nick = (S.seats && S.seats[sd.id] && S.seats[sd.id].nick) || (pCount === 1 ? '你' : '等待选手');
        sd.teamEl.querySelector('.nm').textContent = nick + (ME && ME.seat === sd.id ? '（你）' : '');
      }
    }
    if (sd.segEl) {
      sd.segEl.classList.toggle('hidden', !active);
      if (active) sd.segEl.style.width = (sd.val / total * 100) + '%';
    }
    if (sd.legEl) {
      sd.legEl.classList.toggle('hidden', !active);
    }
  });

  const wn = S.watchers || 0;
  $('lgWatch').classList.toggle('hidden', !wn);
  $('lgWatchN').textContent = wn;
  const names = (S.watcherNicks || []).map((w) => w.nick);
  $('lgWatch').title = names.length ? '观众：' + names.join('、') : '';
}

/* 出手前的实时预览：输入框有字即可在棋盘上预览命中（所有人包括观众均可键入预览）。
   返回 null 表示不预览。 */
function previewSet() {
  if (!S || S.phase !== 'playing') return null;
  const el = $('poem');
  const raw = el ? el.value : '';
  if (!raw) return null;
  const set = new Set();
  for (const ch of raw) if (/[\u3400-\u9fff]/.test(ch)) set.add(ch);
  return set.size ? set : null;
}

/* 预览命中统计：新占 / 抢夺 / 己方 —— 与落子后的计数口径一致 */
function previewHits(pv, team) {
  if (!pv) return null;
  const own = S.board || '', chars = S.chars || '';
  let fresh = 0, cap = 0, hold = 0;
  for (let i = 0; i < chars.length; i++) {
    if (!pv.has(chars.charAt(i))) continue;
    const o = own.charAt(i) || '0';
    if (o === '0') fresh++;
    else if (o === team) hold++;
    else cap++;
  }
  return { hits: fresh + cap + hold, fresh, cap, hold };
}

function renderBoard() {
  const n = S.size;
  const total = n * n;
  const chars = S.chars || '';
  const own = S.board || '';
  if (boardN !== n || cellEls.length !== total) {
    const b = $('board');
    b.innerHTML = '';
    b.style.gridTemplateColumns = 'repeat(' + n + ',1fr)';
    cellEls = [];
    for (let i = 0; i < total; i++) {
      const d = document.createElement('div');
      d.className = 'cell';
      d.dataset.i = String(i);      /* 点格子换字靠它定位：别用 indexOf，棋盘重建过一次就错位 */
      b.appendChild(d);
      cellEls.push(d);
    }
    boardN = n;
  }
  // 字号随格子实际宽度走（与主持台的 sizeCellFont 同一公式，上限 36）
  const b = $('board');
  const w = b.clientWidth || 0;
  if (w) b.style.setProperty('--cell-fs', Math.max(9, Math.min(36, Math.round((w / n) * 0.54))) + 'px');

  /* 预览：命中格按预览阵营（自己席位或当前出手方）的半透明墨色刷；同色令牌相邻时格线隐形，
     预览区因此也连成一片（和主持台 colorToken 的做法一致）。 */
  const pv = previewSet();
  const pvTeam = S.you || S.turn || 'A';
  const tokens = new Array(total);
  for (let i = 0; i < total; i++) {
    const o = own.charAt(i) || '0';
    if (pv && pv.has(chars.charAt(i))) {
      tokens[i] = o === pvTeam ? 'own' + o : ('pv' + pvTeam + (o === '0' ? 'N' : o));
    } else {
      tokens[i] = o === '0' ? 'blank' : 'own' + o;
    }
  }

  const flash = new Set(S._flash || []);
  /* 开局前、且是选手或裁判 → 格子可以点（点了换一个字） */
  const pickable = !!(S.phase === 'waiting' && S.canPickCells);
  for (let i = 0; i < total; i++) {
    const el = cellEls[i];
    const ch = chars.charAt(i) || '';
    const o = own.charAt(i) || '0';
    if (el.textContent !== ch) el.textContent = ch;

    // 同色相邻 → 对应那条格线透明，墨块连成一片（与主持台 nb-r/nb-b 一致）
    const row = Math.floor(i / n), col = i % n;
    const nbR = col === n - 1 || (tokens[i] !== 'blank' && tokens[i + 1] === tokens[i]);
    const nbB = row === n - 1 || (tokens[i] !== 'blank' && tokens[i + n] === tokens[i]);

    let cls = 'cell'
      + (['A', 'B', 'C', 'D'].includes(o) ? ' own-' + o : '')
      + (nbR ? ' nb-r' : '') + (nbB ? ' nb-b' : '')
      + (flash.has(i) ? ' flash' : '')
      + (pickable ? ' pickable' : '');
    if (pv && pv.has(ch)) {
      cls += ' pv-' + pvTeam;
      if (o === '0') cls += ' pv-new';
      else if (o !== pvTeam) cls += ' pv-cap';
      else cls += ' pv-hold';
    }
    if (el.className !== cls) el.className = cls;
  }

  /* 输入框下方那行「将命中 N 格」的小提示 */
  const hint = $('pvHint');
  if (hint) {
    const ph = previewHits(pv, pvTeam);
    if (!ph || !ph.hits) {
      hint.classList.add('hidden');
      hint.innerHTML = '';
    } else {
      const pcn = 'em-' + String(pvTeam || 'a').toLowerCase();
      hint.classList.remove('hidden');
      hint.innerHTML = '本句将命中 <b>' + ph.hits + '</b> 格 ｜ ' +
        '<em class="' + pcn + '">新占 ' + ph.fresh + '</em> · ' +
        '<em class="' + pcn + '">抢夺 ' + ph.cap + '</em> · ' +
        '己方 ' + ph.hold +
        (ph.fresh ? '' : '<span class="warn">（没有未涂色格，这句落不下去）</span>');
    }
  }
}

function renderTurn() {
  const pz = (S.paused && S.phase === 'playing') ? S.paused : null;
  const paused = !!pz;
  const isPlayer = !!S.you;                 /* 观众没有席位 */
  const dsp = S.dispute || null;
  const mine = isPlayer && S.phase === 'playing' && !paused && !dsp && S.turn === S.you;
  const seatNames = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
  const nick = (S.seats && S.seats[S.turn] && S.seats[S.turn].nick) || seatNames[S.turn] || '选手';

  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const sideDefs = [
    { id: 'A', el: $('sideTeamA') },
    { id: 'B', el: $('sideTeamB') },
    { id: 'C', el: $('sideTeamC') },
    { id: 'D', el: $('sideTeamD') },
  ];
  sideDefs.forEach((sd, idx) => {
    if (sd.el) {
      sd.el.classList.toggle('hidden', idx >= pCount);
      sd.el.classList.toggle('active', S.phase === 'playing' && S.turn === sd.id);
    }
  });

  let who;
  if (S.phase === 'playing') {
    if (dsp && pCount > 1) {
      const hasRef = !!(S.refs && S.refs.length);
      const targetWho = hasRef ? (pCount > 2 ? '其他选手或裁判' : '对手或裁判') : (pCount > 2 ? '其他选手' : '对手');
      const what = dsp.by === S.you ? '你提交的句子' : (dsp.kind === 'too_long' ? '超长句' : '未收录句');
      who = '已暂停计时 · 等' + targetWho + '裁决「' + esc(what) + '」';
    }
    else if (paused && pz.why === 'seat-empty') {
      who = '场上缺人 · 等观众补位';
      const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
      const free = reqSeats.filter((s) => !S.seats[s]).map((s) => seatNames[s].slice(0, 1)).join('、');
      who += free ? '（' + free + '位空着）' : '';
    }
    else if (paused) who = '已暂停 · 剩余 ' + Math.max(0, Math.round(pz.left / 1000)) + ' 秒';
    else if (!isPlayer) who = '你在观战 · 等 <b>' + esc(nick) + '</b> 说词儿';
    else who = mine ? (pCount === 1 ? '轮到你说词儿' : '轮到你说词儿 · 持' + (seatNames[S.you] ? seatNames[S.you].slice(0, 1) : '')) : '等 <b>' + esc(nick) + '</b> 说词儿';
  } else if (S.phase === 'waiting') {
    if (pCount === 1) {
      who = (S.ready && S.ready.A) ? '准备完毕，随时开局' : '等待准备';
    } else {
      const reqSeats = pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
      const allHere = reqSeats.every((s) => S.seats && S.seats[s]);
      who = allHere ? '等待全员准备' : '等待选手加入';
    }
  } else {
    who = '对局结束';
  }
  if (S.role === 'spectator' && S.phase === 'waiting') who = '观战中 · ' + who;
  $('turnWho').innerHTML = who;

  const poem = $('poem');
  poem.readOnly = false;
  poem.classList.remove('locked');
  poem.placeholder = !isPlayer
    ? '输入诗句可在棋盘上预览命中（坐上空位才能提交）'
    : ((dsp && pCount > 1) ? '这句正在等待裁决…'
      : (paused ? (pz.why === 'seat-empty' ? '场上缺一位选手，等人补位后自动继续' : '对局已暂停，继续后才能提交')
        : (S.phase === 'playing'
          ? (mine ? '轮到你了：输入一句诗词，回车提交' : '输入诗句可在棋盘上预览命中（轮到时才能提交）')
          : '对局未开始')));

  const canSubmit = mine && !paused && (!dsp || pCount === 1);
  const btn = $('btnSubmit');
  btn.disabled = !canSubmit;
  const teamCls = S.turn === 'A' ? ' team-a' : S.turn === 'B' ? ' team-b' : S.turn === 'C' ? ' team-c' : ' team-d';
  btn.className = 'primary' + (S.phase === 'playing' ? teamCls : '');
  btn.title = !isPlayer ? '观战中（坐上空位才能提交）' : (paused ? '对局已暂停，继续后才能提交' : (canSubmit ? '提交飞花（回车）' : '未轮到你出拳'));
  $('btnPass').disabled = !canSubmit;
  $('btnPass').title = !isPlayer ? '观战中' : (paused ? '对局已暂停' : (canSubmit ? '放弃本回合' : '未轮到你出拳'));

  if (mine && document.activeElement !== poem) poem.focus();

  /* 撤销 / 提前结算 / 暂停：选手点=申请，裁判点=直接生效（服务端分权）。
     已有待确认请求时先锁住，避免连着点。暂停期间也不允许改局面。 */
  const playing = S.phase === 'playing';
  const canControl = !!(S && S.canControl);
  const live = playing && canControl && !paused && !dsp;
  $('btnUndo').disabled = !(live && S.canUndo);
  $('btnFinish').disabled = !live;

  /* 暂停：选手与裁判都能点；暂停后按钮变成「继续」，所有人可见可点。
     缺人导致的暂停不给点继续，等补位后自动续。 */
  const btnPause = $('btnPause');
  const seatEmpty = !!(pz && pz.why === 'seat-empty');
  btnPause.disabled = !(playing && canControl && !dsp) || seatEmpty;
  btnPause.textContent = seatEmpty ? '等待补位' : (paused ? '继续对局' : '暂停');
  btnPause.title = (S && S.youRef) ? '裁判：暂停 / 继续对局' : '暂停 / 继续（任意一方都能操作）';

  /* 下场按钮只给选手；观众看得到「坐下」入口 */
  $('btnStand').classList.toggle('hidden', !isPlayer);
  $('btnStand').disabled = playing && !isPlayer;
  /* 开新局：选手或裁判（提前结算之后总得有人把台子重新摆起来） */
  $('btnRematch').classList.toggle('hidden', !canControl);

  /* 按钮文案：单人与裁判直接生效，多人需对方或裁判同意 */
  const isSolo = !!(S && S.cfg && S.cfg.playerCount === 1);
  if (S && S.youRef) {
    $('btnUndo').title = '裁判：直接撤销上一步（不需要谁批准）';
    $('btnFinish').title = '裁判：直接结算本局';
  } else if (isSolo) {
    $('btnUndo').title = '撤销上一步';
    $('btnFinish').title = '提前结算本局';
  } else {
    $('btnUndo').title = '撤回上一步（需对手或裁判同意）';
    $('btnFinish').title = '立即结算（需对手或裁判同意）';
  }
}

/* ---------- 房间面板：成员 / 事件 ----------
   成员列表回答「谁在这个房间、什么身份、还在不在线」；在线状态来自服务端的 SSE 连接，
   掉线的人会标「离线」，并且只有这时候才会出现「移出」按钮（防止拿来赶在场对手）。 */
let roomTab = 'members';
let editingNick = null;      // 正在改名的 mid
let editingVal = '';         // 改名输入框的当前值（重渲染时用来还原，避免被 SSE 冲掉）
let editingRandom = '';      // 输入框里这个值是不是「抽诗人」抽出来的；手改一个字就作废
let memSig = '';             // 成员快照签名：内容没变就不重绘，免得打断输入

function hhmm(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

const EV_KIND = {
  create: 'in', join: 'in', watch: 'in', seat: 'in', online: 'in',
  stand: 'out', leave: 'out', kick: 'out', offline: 'out', sweep: 'out',
  finish: 'end',
  ready: 'rule', start: 'rule', pause: 'rule', resume: 'rule',
  dispute: 'rule', 'dispute-reject': 'rule', 'dispute-accept': 'rule',
  req: 'rule', 'req-cancel': 'rule', 'req-deny': 'rule', undo: 'rule',
  nick: 'rule', rematch: 'rule', ref: 'rule', cfg: 'rule', redraw: 'rule',
  'finish-by-ref': 'end',
  fly: 'fly', pass: 'fly',
};

function renderMembers() {
  const box = $('memList');
  if (!box) return;
  const ms = (S && S.members) || [];
  const isPlayerMe = !!(S && S.role === 'player');

  $('memCount').textContent = ms.filter((m) => m.kind !== 'empty').length;

  const sig = ms.map((m) => [m.mid, m.nick, m.kind, m.online ? 1 : 0, m.seat, m.ref ? 1 : 0].join('|')).join(',');
  /* 正在改名时，只要成员构成没变就别重绘 —— 否则输入框会被服务端推送打断 */
  if (editingNick && box.querySelector('.nickedit') && sig === memSig) return;
  memSig = sig;

  const seatNames = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
  box.innerHTML = ms.map((m) => {
    if (m.kind === 'empty') {
      const which = seatNames[m.seat] || '空位';
      const isMySeat = S.you && S.you === m.seat;
      const actBtn = (!S.youHidden && !isMySeat)
        ? ('<span class="mact"><button' + (!S.you ? ' class="primary"' : '') +
           ' data-act="seat" data-seat="' + m.seat + '">' +
           (!S.you ? '坐到此位' : '换到此位') + '</button></span>')
        : '';
      return '<li><span class="mdot iface"></span>' +
        '<span class="mname empty-name">空位 · 等人坐下</span>' +
        '<span class="mtag seat' + m.seat + '">' + which + '</span>' +
        actBtn + '</li>';
    }

    const dot = m.kind === 'player' ? ('mdot t' + (m.seat || 'A')) : 'mdot';
    const tags = [];
    if (m.kind === 'player') {
      tags.push('<span class="mtag seat' + m.seat + '">' +
        (seatNames[m.seat] || '选手') + '</span>');
    } else {
      tags.push('<span class="mtag watch">观众</span>');
      if (m.ref) tags.push('<span class="mtag ref" title="裁判：能暂停 / 撤销 / 结算 / 裁决未收录句">裁判</span>');
    }
    if (m.isYou) tags.push('<span class="mtag you">你</span>');
    if (!m.online) tags.push('<span class="mtag off">离线</span>');

    if (m.isYou && editingNick === m.mid) {
      return '<li class="editing"><span class="' + dot + '"></span>' +
        '<div class="nickedit">' +
        '<input id="nickInput" maxlength="12" value="' + esc(editingVal) + '" placeholder="新昵称">' +
        '<button data-act="nick-random" title="抽一位诗人当昵称：不占「24 小时一次」的自定义额度">随机</button>' +
        '<button class="primary" data-act="nick-save" data-mid="' + esc(m.mid) + '">保存</button>' +
        '<button data-act="nick-cancel">取消</button>' +
        '</div></li>';
    }

    /* 改自己的名字：随时可以 */
    const acts = [];
    if (m.isYou) acts.push('<button data-act="nick" data-mid="' + esc(m.mid) + '">改昵称</button>');
    /* 设 / 取消裁判：只有在场选手能把「观众」标成裁判 */
    if (isPlayerMe && !m.isYou && m.kind === 'watcher') {
      if (m.ref) acts.push('<button data-act="unref" data-mid="' + esc(m.mid) + '" title="取消这个人的裁判权">取消裁判</button>');
      else acts.push('<button data-act="ref" data-mid="' + esc(m.mid) + '" title="给这个人裁决权：暂停 / 撤销 / 结算 / 裁决未收录句">设为裁判</button>');
    }
    /* 移出：只有在场选手能操作，且只对「已离线」的别人开放 */
    if (isPlayerMe && !m.isYou && !m.online) {
      acts.push('<button class="danger" data-act="kick" data-mid="' + esc(m.mid) + '">移出</button>');
    }

    return '<li><span class="' + dot + '"></span>' +
      '<span class="mname">' + esc(m.nick) + '</span>' +
      tags.join('') +
      (acts.length ? '<span class="mact">' + acts.join('') + '</span>' : '') +
      '</li>';
  }).join('');

  if (editingNick) {
    const inp = $('nickInput');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
}

/* 事件面板里真正会显示的条目（去掉飞花 / 放弃，它们属于飞花记录） */
function shownEvents() {
  return ((S && S.events) || []).filter((e) => e.type !== 'fly' && e.type !== 'pass');
}

/* 事件里的昵称上色：两位选手用各自阵营色，裁判用棕色，其余人保持原色。
   做法是在「已转义」的文本上做一次正则替换 —— 只扫一遍，替换出来的 <b> 不会被二次匹配；
   名字按长度降序，免得「沈传」抢在「沈传师」前面命中；单字昵称不上色，
   否则正文里出现同一个字就会被误染。 */
function colorEventText(text, ev) {
  const src = esc(text);
  const picks = [];
  for (const m of ((S && S.members) || [])) {
    if (!m.nick || m.nick.length < 2 || m.kind === 'empty') continue;
    const cls = m.kind === 'player'
      ? 'ev-n-' + String(m.seat || 'a').toLowerCase()
      : (m.ref ? 'ev-n-ref' : 'ev-n-watch');
    if (cls) picks.push({ n: esc(m.nick), cls });
  }
  if (ev && ev.seat) {
    const seatCls = 'ev-n-' + String(ev.seat).toLowerCase();
    if (ev.mid) {
      const match = ((S && S.members) || []).find((m) => m.mid === ev.mid);
      if (match && match.nick) picks.unshift({ n: esc(match.nick), cls: seatCls });
    }
  }
  if (!picks.length) return src;
  picks.sort((a, b) => b.n.length - a.n.length);
  const uniq = [];
  for (const p of picks) if (!uniq.some((u) => u.n === p.n)) uniq.push(p);
  const map = new Map(uniq.map((p) => [p.n, p.cls]));
  const re = new RegExp(uniq.map((p) => p.n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return src.replace(re, (m0) => '<b class="' + map.get(m0) + '">' + m0 + '</b>');
}

function renderEvents() {
  const box = $('evList');
  if (!box) return;
  const evs = shownEvents();
  $('evCount').textContent = evs.length;
  $('evEmpty').classList.toggle('hidden', evs.length > 0 || roomTab !== 'events');
  /* 最新在上，和飞花记录保持同一个方向 */
  box.innerHTML = evs.slice().reverse().map((e) => {
    const k = EV_KIND[e.type] || 'rule';
    return '<li><span class="evtime">' + hhmm(e.at) + '</span>' +
      '<span class="evtext k-' + k + '">' + colorEventText(e.text, e) + '</span></li>';
  }).join('');
}

function syncRoomTabs() {
  const isMembers = roomTab === 'members';
  $('tabMembers').classList.toggle('on', isMembers);
  $('tabEvents').classList.toggle('on', !isMembers);
  $('memList').classList.toggle('hidden', !isMembers);
  $('evList').classList.toggle('hidden', isMembers);
  $('evEmpty').classList.toggle('hidden', isMembers || shownEvents().length > 0);
}

/* 席位与观战条：显示身份、空位、坐下/换座入口 */
function renderWatch() {
  const box = $('watchBox');
  const isSpectator = !S.you;
  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
  const seatDefs = [
    { id: 'A', name: '赤营', btn: $('btnSeatA') },
    { id: 'B', name: '青营', btn: $('btnSeatB') },
    { id: 'C', name: '金营', btn: $('btnSeatC') },
    { id: 'D', name: '翠营', btn: $('btnSeatD') },
  ];
  const freeSeats = reqSeats.filter((s) => !S.seats || !S.seats[s]);
  const canSwitch = !isSpectator && !S.youHidden && freeSeats.length > 0;

  box.classList.toggle('hidden', !isSpectator && !canSwitch);
  $('playRow').classList.remove('hidden');
  $('poem').classList.remove('hidden');
  $('poemTitle').classList.remove('hidden');
  if (!isSpectator && !canSwitch) return;

  const n = S.watchers || 0;
  /* 开发者隐形观战：不占席位、不进名单 —— 所以也不给「坐下」按钮，
     免得一点就变成看得见的选手（想真的参战，开一条不带 dev 的链接）。 */
  if (S.youHidden) {
    if ($('watchTag')) $('watchTag').textContent = '开发者';
    $('watchHint').innerHTML = '开发者 · 隐形观战中：别人看不到你在房间里（不占席位、不进成员名单）。' +
      '<button type="button" class="devoff" id="btnDevOff">关闭开发者模式</button>';
    seatDefs.forEach((sd) => { if (sd.btn) sd.btn.classList.add('hidden'); });
    return;
  }

  if (isSpectator) {
    if ($('watchTag')) $('watchTag').textContent = '观战';
    if (freeSeats.length > 0) {
      const names = freeSeats.map((s) => seatDefs.find((d) => d.id === s).name).join('、');
      $('watchHint').innerHTML = '你正在观战（观众 ' + n + ' 人）· ' + names + '空着，可以直接坐下参战。';
    } else {
      $('watchHint').innerHTML = '你正在观战（观众 ' + n + ' 人）· 席位已满，有人下场时就能补位。';
    }
    seatDefs.forEach((sd, idx) => {
      if (!sd.btn) return;
      const isReq = idx < pCount;
      const isFree = isReq && (!S.seats || !S.seats[sd.id]);
      sd.btn.classList.toggle('hidden', !isFree);
      sd.btn.disabled = !isFree;
      const nick = (S.seats && S.seats[sd.id] && S.seats[sd.id].nick) || '';
      sd.btn.textContent = '坐到' + sd.name + (nick ? '（' + nick + '）' : '');
    });
  } else {
    // 选手视角且有空位：换座模式
    if ($('watchTag')) $('watchTag').textContent = '席位';
    const names = freeSeats.map((s) => seatDefs.find((d) => d.id === s).name).join('、');
    $('watchHint').innerHTML = names + '空着，你可以换到空席位。';
    seatDefs.forEach((sd, idx) => {
      if (!sd.btn) return;
      const isReq = idx < pCount;
      const isFree = isReq && (!S.seats || !S.seats[sd.id]);
      sd.btn.classList.toggle('hidden', !isFree);
      sd.btn.disabled = !isFree;
      sd.btn.textContent = '换到' + sd.name;
    });
  }
}

/* 争议条：谁提的、谁能判。
   裁决权：对手席位的选手，或裁判（S.youRef）。提交方本人只能「撤回提交」。
   其他人（普通观众）一律只读 —— 连按钮都不给，点了也会被服务端 403 挡住。
   另外：没有争议时必须把三个按钮的可见性一并归零。只藏整条 bar 是不够的，
   上一轮的 hidden 类会留在 DOM 上，下一次任何异常显示都会让人看到「不该出现的撤回按钮」。 */
function renderDispute() {
  const bar = $('disputeBar');
  const d = S && S.dispute;
  const isSolo = !!(S && S.cfg && S.cfg.playerCount === 1);
  /* 「这个人能不能掌流程」（选手或裁判）—— 多人模式下由服务端按席位算好。
     注意：这个局部量在上一轮重构里被误删过，导致下面的 canJudge 抛 ReferenceError，
     整条裁决条连同其后的成员 / 事件面板全都渲染不出来（按钮一个都不出现）。 */
  const canControl = !!(S && S.canControl);

  if (!d || isSolo) {
    ['btnValid', 'btnRetry', 'btnWithdraw'].forEach((id) => $(id).classList.add('hidden'));
    $('disputeBtns').classList.add('hidden');
    $('disputeText').innerHTML = '';
    bar.classList.remove('mine');
    bar.classList.add('hidden');
    const vEl = $('verdict');
    if (vEl && vEl.textContent && vEl.textContent.includes('裁决')) {
      vEl.className = 'msg';
      vEl.innerHTML = '';
    }
    return;
  }

  const byMe = !!(S.you && d.by === S.you);          /* 提交方：只能撤回 */
  const isRef = !!(S && S.youRef);                   /* 裁判：能判，但不是提交方 */
  const canJudge = canControl && !byMe;
  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const hasRef = !!(S.refs && S.refs.length);
  const seatNames = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
  const who = (S.seats[d.by] && S.seats[d.by].nick) || seatNames[d.by] || '选手';

  const limit = d.maxLen || (S && S.cfg && S.cfg.maxPoemLen) || 17;
  const reasonDesc = d.kind === 'too_many_clauses'
    ? ('超过诗每次至多前后两句上限（含 ' + (d.extra || 3) + ' 句）')
    : (d.kind === 'cross_couplet'
      ? '诗跨联提交两句（非同一联前后句）'
      : (d.kind === 'too_long' ? ('超过 ' + limit + ' 字上限') : (d.source && d.source.kind ? ('出自《' + d.source.title + '》（' + d.source.kind + '），本局未启用该文体') : '语料里没查到')));
  const targetDesc = hasRef ? (pCount > 2 ? '其他选手或裁判' : '对手或裁判') : (pCount > 2 ? '其他选手' : '对手');

  let otherNick = '';
  if (pCount === 2) {
    const oppSeat = d.by === 'A' ? 'B' : 'A';
    otherNick = (S.seats[oppSeat] && S.seats[oppSeat].nick) || '对手';
  }

  bar.classList.remove('hidden');
  bar.classList.toggle('mine', byMe);
  if (byMe) {
    const targetWho = pCount === 2 ? (hasRef ? '<b>' + esc(otherNick) + '</b> 或裁判' : '<b>' + esc(otherNick) + '</b>') : targetDesc;
    $('disputeText').innerHTML = '「<b>' + esc(d.disp || d.text) + '</b>」' + reasonDesc + '，计时已暂停，等 ' +
      targetWho + '裁决是否有效，也可以自己撤回。';
  } else if (canJudge) {
    $('disputeText').innerHTML = '<b>' + esc(who) + '</b> 提交的「<b>' + esc(d.disp || d.text) +
      '」' + reasonDesc + '。<br>计时已暂停：判「有效」按字面正常涂色，判「重填」让他换一句。' +
      (isRef ? '（你以<b>裁判</b>身份裁决）' : '');
  } else {
    $('disputeText').innerHTML = '<b>' + esc(who) + '</b> 提交的「<b>' + esc(d.disp || d.text) +
      '」' + reasonDesc + '，已暂停计时，等' + targetDesc + '裁决。（观众不能判定）';
  }

  $('btnValid').classList.toggle('hidden', !canJudge);
  $('btnRetry').classList.toggle('hidden', !canJudge);
  $('btnWithdraw').classList.toggle('hidden', !byMe);
  $('disputeBtns').classList.toggle('hidden', !(canJudge || byMe));
}

/* 请求条：自己发起 → 等对方回应（可取消）；对方发起 → 同意 / 拒绝；裁判可直接批 */
function renderConsent() {
  const bar = $('consentBar');
  const r = S && S.req;
  const isSolo = !!(S && S.cfg && S.cfg.playerCount === 1);
  if (!r || isSolo) {
    $('btnAgree').classList.add('hidden');
    $('btnDeny').classList.add('hidden');
    $('consentText').innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  const canControl = !!(S && S.canControl);
  const mine = !!(S.you && r.by === S.you);
  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const hasRef = !!(S.refs && S.refs.length);
  const consentTarget = hasRef ? (pCount > 2 ? '其他选手或裁判' : '对手或裁判') : (pCount > 2 ? '其他选手' : '对手');
  const who = (S.seats && S.seats[r.by] && S.seats[r.by].nick) || (r.by === 'A' ? '赤营' : '青营');
  const what = r.type === 'undo' ? '撤销上一步' : '提前结算';
  bar.classList.remove('hidden');
  bar.classList.toggle('mine', mine);
  $('consentText').innerHTML = mine
    ? '已发出「' + what + '」请求，等待' + consentTarget + '同意…'
    : '<b>' + esc(who) + '</b> 请求「' + what + '」，同意后立即生效。' +
      ((S && S.youRef) ? '（你以<b>裁判</b>身份批）' : '');
  $('btnAgree').classList.toggle('hidden', !canControl || mine);
  $('btnDeny').classList.toggle('hidden', !canControl);
  $('btnDeny').textContent = mine ? '取消请求' : '拒绝';
}

/* 准备条：全员到齐后，各自点一次「准备好了」才开局 */
function renderReady() {
  const bar = $('readyBar');
  const waiting = !!(S && S.phase === 'waiting');
  bar.classList.toggle('hidden', !waiting);
  if (!waiting) return;

  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
  const full = reqSeats.every((s) => S.seats && S.seats[s]);

  if (pCount === 1) {
    $('readyTitle').textContent = '点击「我准备好了」开局';
  } else {
    $('readyTitle').textContent = full
      ? '全员都点「准备好了」就开始'
      : '把房号发给对手，等选手坐下（进来后全员再各点一次准备）';
  }

  const seatDefs = [
    { id: 'A', name: '赤营', el: $('readyA') },
    { id: 'B', name: '青营', el: $('readyB') },
    { id: 'C', name: '金营', el: $('readyC') },
    { id: 'D', name: '翠营', el: $('readyD') },
  ];
  seatDefs.forEach((sd, idx) => {
    if (!sd.el) return;
    const active = idx < pCount;
    sd.el.classList.toggle('hidden', !active);
    if (active) {
      const isReady = !!(S.ready && S.ready[sd.id]);
      const nick = (S.seats && S.seats[sd.id] && S.seats[sd.id].nick) || null;
      sd.el.className = 'rpill t' + sd.id + (isReady ? ' on' : '');
      sd.el.textContent = (nick || (pCount === 1 ? '你' : '等待对手')) + (isReady ? ' ✓ 已准备' : ' 未准备');
    }
  });

  const isPlayer = !!S.you;
  const mineReady = isPlayer && !!(S.ready && S.ready[S.you]);
  const btn = $('btnReady');
  btn.classList.toggle('hidden', !isPlayer);
  btn.textContent = mineReady ? '取消准备' : '我准备好了';
  btn.className = mineReady ? '' : 'primary';
  if (!isPlayer) $('readyTitle').textContent += '（你在观战，可以坐上空位一起玩）';
  $('btnInvite').classList.toggle('hidden', full || pCount === 1);
}

/* ---------- 开局设置 ----------
   正式开局前（waiting）才显示。选手与裁判能改，其他人只读 —— 但都能看见这局怎么设的。
   输入框的值只在「服务端配置变了」或「用户没在改」时才覆盖，避免 SSE 推送打断输入。 */
function renderRef() {
  const bar = $('refBar');
  if (!bar) return;
  const on = !!(S && S.youRef);
  bar.classList.toggle('hidden', !on);
  if (!on) return;
  const bits = [];
  if (S.canControl) bits.push('可暂停 / 继续、撤销一步、提前结算、裁决未收录句');
  if (S.phase === 'waiting') bits.push('改开局设置与重抽棋盘');
  $('refText').innerHTML = '你现在是裁判：' + bits.join('，') +
    '。选手提交的句子语料里查不到时，你能直接判「有效 / 重填」。';
}

function renderSetup() {
  const box = $('setupBox');
  if (!box) return;
  const waiting = !!(S && S.phase === 'waiting');
  box.classList.toggle('hidden', !waiting);
  if (!waiting) { setupDirty = false; return; }

  const cfg = S.cfg || {};
  const can = !!S.canControl;
  const sig = [cfg.size, cfg.extra, cfg.rounds, cfg.turnSeconds, cfg.maxPoemLen || 17, cfg.limitCouplet === false ? 0 : 1, cfg.freeSubmit ? 1 : 0, cfg.endless ? 1 : 0,
    KINDS_UI.map((k) => (cfg.kinds && cfg.kinds[k] ? 1 : 0)).join('')].join('|');

  /* 服务端配置没变、用户也没在改 → 不碰输入框 */
  if (!setupDirty && sig !== setupSig) {
    setupSig = sig;
    $('cfgSize').value = cfg.size;
    $('cfgExtra').value = cfg.extra;
    $('cfgRounds').value = cfg.rounds;
    if (cfg.playerCount === 1) {
      $('cfgSeconds').type = 'text';
      $('cfgSeconds').value = '∞';
      if ($('cfgMaxLen')) {
        $('cfgMaxLen').type = 'text';
        $('cfgMaxLen').value = '∞';
      }
    } else {
      $('cfgSeconds').type = 'number';
      $('cfgSeconds').value = cfg.turnSeconds || 120;
      if ($('cfgMaxLen')) {
        $('cfgMaxLen').type = 'number';
        $('cfgMaxLen').value = cfg.maxPoemLen || 17;
      }
    }
    $('cfgEndless').checked = !!cfg.endless;
    if ($('cfgLimitCouplet')) {
      $('cfgLimitCouplet').checked = cfg.limitCouplet !== false;
    }
    if ($('cfgFreeSubmit')) {
      $('cfgFreeSubmit').checked = !!cfg.freeSubmit;
    }
    const n = Number(cfg.size) || 10;
    const minExtra = Math.max(0, n * n - 300);
    const maxExtra = n * n;
    $('cfgExtra').min = String(minExtra);
    $('cfgExtra').max = String(maxExtra);
    $('cfgExtraHint').textContent = minExtra + '–' + maxExtra;
    for (const el of box.querySelectorAll('#cfgKinds input')) {
      el.checked = !!(cfg.kinds && cfg.kinds[el.value]);
    }
    setupDirty = false;
  }

  for (const el of [$('cfgSize'), $('cfgExtra'), $('cfgRounds'), $('cfgSeconds'), $('cfgMaxLen'), $('cfgEndless'), $('cfgLimitCouplet'), $('cfgFreeSubmit'),
    ...box.querySelectorAll('#cfgKinds input')]) {
    if (el) el.disabled = !can;
  }
  if (cfg.playerCount === 1) {
    $('cfgSeconds').disabled = true;
    if ($('cfgMaxLen')) $('cfgMaxLen').disabled = true;
    if ($('cfgLimitCouplet')) $('cfgLimitCouplet').disabled = true;
    if ($('cfgFreeSubmit')) $('cfgFreeSubmit').disabled = true;
  }
  $('btnApplyCfg').disabled = !can;
  $('btnRedraw').disabled = !can;
  $('cfgRounds').disabled = !can || !!$('cfgEndless').checked;
  $('setupHint').textContent = can
    ? '改完点「应用设置」；只换字就点「重抽棋盘」'
    : '开局前由选手或裁判调整（现在是只读）';
  $('cfgDirty').textContent = setupDirty ? '有改动还没应用' : '';
  $('cfgDirty').className = 'sdirty' + (setupDirty ? '' : ' ok');
  syncNumStepButtons();
}

/* ---------- 自定义字库 ----------
   只影响「用哪些字铺盘」：服务端会把文本过一遍 judge.normalize（只留汉字 + 繁转简），
   前端这里只做「数一下能识别出多少个不同的汉字」给人看，不参与实际处理 ——
   两套各自实现一次归一化，迟早会算出不一样的数，反而让人怀疑。 */
function poolHanCount(text) {
  const seen = new Set();
  const s = String(text || '');
  for (const ch of s) {
    if (/[\u3400-\u4DBF\u4E00-\u9FA5\u3007]/.test(ch)) seen.add(ch);
  }
  return seen.size;
}

function renderPool() {
  const btn = $('btnOpenPool');
  if (!btn) return;
  const can = !!(S && S.phase === 'waiting' && S.canPickCells);
  const p = (S && S.pool) || { count: 0, preview: '', by: '' };
  const n = S && S.cfg ? Number(S.cfg.size) * Number(S.cfg.size) : 0;

  btn.disabled = !can;
  btn.classList.toggle('hidden', !(S && S.phase === 'waiting'));
  const clr = $('btnClearPool');
  if (clr) {
    clr.disabled = !can;
    clr.classList.toggle('hidden', !p.count || !(S && S.phase === 'waiting'));
  }
  const stat = $('poolStat');
  if (stat) {
    if (!p.count) {
      stat.textContent = '系统字库';
      stat.title = '';
    } else {
      stat.innerHTML = '自定义 <b>' + p.count + '</b> 字' +
        (n && p.count < n ? '（' + (n - p.count) + ' 格由系统补）' : '');
      stat.title = '字库：' + p.preview + (p.count > 24 ? '…' : '');
    }
  }
  /* 「点格子换字」的提示条：与棋盘可点态同一个条件，别一边能点一边不提示 */
  const hint = $('pickHint');
  if (hint) hint.classList.toggle('hidden', !can);
}

function renderPoolMeta() {
  const el = $('poolMeta');
  if (!el) return;
  const text = ($('poolText') && $('poolText').value) || '';
  const n = S && S.cfg ? Number(S.cfg.size) * Number(S.cfg.size) : 0;
  if (!text.trim()) {
    el.innerHTML = '留空保存 = 撤下自定义字库，回到系统字库。';
    return;
  }
  const han = poolHanCount(text);
  if (!han) {
    el.innerHTML = '<span class="bad">这段文本里没有汉字（标点、数字、字母都会被忽略）。</span>';
    return;
  }
  el.innerHTML = '识别到 <b>' + han + '</b> 个不同的汉字' +
    (n ? '，棋盘 <b>' + n + '</b> 格' +
      (han >= n ? '（字库够铺满）' : '（还差 ' + (n - han) + ' 格，由系统字库补）') : '');
}

function openPoolModal() {
  if (!S || !S.canPickCells) return;
  $('poolText').value = '';
  $('poolFileName').textContent = '未选择文件';
  $('poolFileInput').value = '';
  $('poolOverlay').classList.remove('hidden');
  renderPoolMeta();
  setTimeout(() => { try { $('poolText').focus(); } catch (_) {} }, 30);
}

function closePoolModal() {
  const o = $('poolOverlay');
  if (o) o.classList.add('hidden');
}

function readAsText(file) {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => resolve('');
    fr.readAsText(file, 'utf-8');
  });
}

async function submitPool(text) {
  const btn = $('btnApplyPool');
  if (btn) btn.disabled = true;
  const { data } = await post('/api/room/' + ME.roomId + '/pool', { t: ME.token, text: String(text || '') });
  if (btn) btn.disabled = false;
  if (!data.ok) {
    verdict('err', '✕ ' + esc(data.reason || '设置失败'));
    return false;
  }
  closePoolModal();
  verdict('ok', data.pool && data.pool.count
    ? '✓ 字库已应用：<b>' + data.pool.count + '</b> 字'
    : '✓ 已撤下自定义字库，回到系统字库');
  return true;
}

/* 开局前点格子换一个字。抽签范围由服务端按「这一格原属哪套字库」决定：
   字库字只在自定义字库里换、常用字只在常用字里换、低频字只在低频字里换。 */
async function rerollCellAt(i) {
  if (!S || S.phase !== 'waiting' || !S.canPickCells) return;
  const { data } = await post('/api/room/' + ME.roomId + '/reroll', { t: ME.token, index: i });
  if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '换不了字'));
  /* 事件流会把新状态推下来，但先把这一格刷出来 + 闪一圈，让人看得见点生效了 */
  if (S.chars && data.ch) {
    const arr = S.chars.split('');
    arr[i] = data.ch;
    S.chars = arr.join('');
    S._flash = [i];
    renderBoard();
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (S) S._flash = [];
      renderBoard();
    }, 900);
  }
}

function markSetupDirty() {
  setupDirty = true;
  const el = $('cfgDirty');
  if (el) { el.textContent = '有改动还没应用'; el.className = 'sdirty'; }
  const rawSize = $('cfgSize') ? $('cfgSize').value.trim() : '';
  const numSize = Number(rawSize);
  const n = (!isNaN(numSize) && numSize >= 5 && numSize <= 20) ? numSize : 10;
  const minExtra = Math.max(0, n * n - 300);
  const maxExtra = n * n;
  if ($('cfgExtra')) {
    $('cfgExtra').min = String(minExtra);
    $('cfgExtra').max = String(maxExtra);
  }
  if ($('cfgExtraHint')) $('cfgExtraHint').textContent = minExtra + '–' + maxExtra;
  syncNumStepButtons();
}

/* 暂停条：谁暂停的、还剩多少秒；所有人（含裁判）都能点继续 */
function renderPause() {
  const bar = $('pauseBar');
  const p = S && S.paused;
  if (!p || S.phase !== 'playing') { bar.classList.add('hidden'); return; }
  /* p.by 对选手是席位（A/B/C/D）；裁判暂停时 p.by 为空，名字在 byNick 里 */
  const who = p.byNick || (!p.by ? '有人' : (S.seats[p.by]
    ? S.seats[p.by].nick
    : ((((S.members || []).find((m) => m.mid === p.by) || {}).nick) || '有人')));
  bar.classList.remove('hidden');
  if (p.why === 'seat-empty') {
    const pCount = (S.cfg && S.cfg.playerCount) || 2;
    const reqSeats = pCount === 1 ? ['A'] : pCount === 3 ? ['A', 'B', 'C'] : pCount === 4 ? ['A', 'B', 'C', 'D'] : ['A', 'B'];
    const seatNames = { A: '赤', B: '青', C: '金', D: '翠' };
    const free = reqSeats.filter((s) => !S.seats[s]).map((s) => seatNames[s]).join('、');
    $('pauseText').innerHTML = '有选手下场了，<b>' + free + '位</b>空着 · 计时已冻结，' +
      '等观众坐上或原选手回座后自动继续。';
    $('btnResume').classList.add('hidden');
  } else {
    $('pauseText').innerHTML = '<b>' + esc(who) + '</b> 暂停了对局 · 剩余 ' +
      Math.max(0, Math.round(p.left / 1000)) + ' 秒（倒计时已冻结）';
    $('btnResume').classList.remove('hidden');
  }
}

function poemHTML(e) {
  const hit = e.hitChars || {};
  const s = e.line || e.norm || '';
  let out = '', seen = {};
  for (const ch of s) {
    const k = hit[ch];
    if (k && !seen[ch]) { seen[ch] = 1; out += '<u class="mk mk-' + k + '">' + esc(ch) + '</u>'; }
    else out += esc(ch);
  }
  return out;
}

/* 「语料未收录、但被人工判为有效」的落子：记录里得写清是谁判的。
   裁判判的和对手判的不是一回事，不能一律写「对手裁定有效」。 */
function rulerText(r) {
  if (!r) return '裁定有效';
  const nick = String(r.nick || '').trim();
  if (r.ref) return nick ? '裁判 ' + esc(nick) + ' 裁定有效' : '裁判裁定有效';
  return '对手裁定有效';
}

let lastLogRoomId = null;

function renderLog() {
  const pane = $('logList');
  if (!pane) return;
  const log = S.log || [];
  $('logEmpty').classList.toggle('hidden', log.length > 0);

  /* 与主持台一致：最新一手在最上面；放弃也照常显示所属阵营的赤/青徽标 */
  const rows = log.filter((e) => e.type === 'fly' || e.type === 'pass').slice().reverse();
  const html = rows.map((e) => {
    const seatNames = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
    const markNames = { A: '赤', B: '青', C: '金', D: '翠' };
    const cls = 't' + (e.team || 'A');
    const mark = markNames[e.team] || '赤';
    const nick = (S.seats && S.seats[e.team] && S.seats[e.team].nick) || seatNames[e.team] || '选手';
    const badge = '<span class="badge b' + (e.team || 'A') + '" title="' + esc(nick) + '">' + mark + '</span>';
    if (e.type === 'pass') {
      return '<li class="' + cls + '">' + badge +
        '<div class="body"><div class="line dash">—— 放弃本回合' + (e.why ? '（' + esc(e.why) + '）' : '') + ' ——</div>' +
        '<div class="meta">第 ' + e.round + ' 轮 · 未涂色</div></div></li>';
    }
    const src = e.source
      ? '<span class="src">《' + esc(e.source.title) + '》' + esc(e.source.author) + ' · ' + esc(e.source.dynasty) + '</span>'
      : (e.via === 'manual' ? '<span class="src">' + rulerText(e.ruler) + '</span>' : (e.via === 'free' ? '<span class="src">自由提交</span>' : ''));
    /* 与主持台一致：「新占」「抢夺」连同数字一起用阵营色，一眼看出这一手抢了多少 */
    const pc = 'em-' + String(e.team || 'a').toLowerCase();
    return '<li class="' + cls + '">' + badge +
      '<div class="body"><div class="line">' + poemHTML(e) + '</div>' +
      '<div class="meta">第 ' + e.round + ' 轮 · 命中 <b>' + e.hits + '</b> 格 ｜ ' +
      '<em class="' + pc + '">新占 ' + e.blank + '</em> · ' +
      '<em class="' + pc + '">抢夺 ' + e.capture + '</em> · ' +
      '己方 ' + e.hold +
      (src ? ' ｜ ' + src : '') + '</div></div></li>';
  }).join('');

  const currentRoomId = (S && S.id) || null;
  const isNewRoom = !lastLogRoomId || lastLogRoomId !== currentRoomId;
  lastLogRoomId = currentRoomId;

  // 内容完全没变且不是新进房间时，直接跳过 DOM 更新与滚动重算，保障滑动零抖动
  if (!isNewRoom && pane.__lastHtml === html) {
    return;
  }
  pane.__lastHtml = html;

  if (isNewRoom || rows.length === 0) {
    pane.innerHTML = html;
    pane.scrollTop = 0;
    pane.__lastRowsLen = rows.length;
    return;
  }

  // 记录更新前的滚动状态与内容总高度
  const oldScrollTop = pane.scrollTop;
  const oldScrollHeight = pane.scrollHeight;
  const wasAtTop = oldScrollTop <= 15;

  pane.innerHTML = html;
  pane.__lastRowsLen = rows.length;

  if (wasAtTop) {
    // 若用户就在最顶部，保持在最顶（0），自然看到最新落子
    pane.scrollTop = 0;
  } else {
    // 若用户正在向下滚动浏览历史，补偿顶部插入新条目导致的高度差，保持视口当前内容纹丝不动，绝不强行拉回顶部
    const delta = pane.scrollHeight - oldScrollHeight;
    pane.scrollTop = oldScrollTop + Math.max(0, delta);
  }
}

function showEnd() {
  const c = S.score || { a: 0, b: 0, c: 0, d: 0, n: 0 };
  const pCount = (S.cfg && S.cfg.playerCount) || 2;
  $('endA').textContent = c.a || 0;
  $('endB').textContent = c.b || 0;
  if ($('endC')) $('endC').textContent = c.c || 0;
  if ($('endD')) $('endD').textContent = c.d || 0;
  $('endN').textContent = c.n || 0;

  if ($('boxEndA')) $('boxEndA').classList.toggle('hidden', pCount < 1);
  if ($('boxEndB')) $('boxEndB').classList.toggle('hidden', pCount < 2);
  if ($('boxEndC')) $('boxEndC').classList.toggle('hidden', pCount < 3);
  if ($('boxEndD')) $('boxEndD').classList.toggle('hidden', pCount < 4);

  if (pCount === 1) {
    const total = S.size * S.size;
    const pct = Math.round(((c.a || 0) / total) * 100);
    $('endWinner').textContent = '挑战结束';
    $('endWinner').style.color = 'var(--ink-a)';
    $('endTitle').textContent = '单人 · 涂色 ' + (c.a || 0) + ' / ' + total + ' 格（' + pct + '%）';
  } else {
    const seatScores = [
      { id: 'A', name: '赤营', val: c.a || 0, color: 'var(--ink-a)' },
      { id: 'B', name: '青营', val: c.b || 0, color: 'var(--ink-b)' },
      { id: 'C', name: '金营', val: c.c || 0, color: 'var(--ink-c)' },
      { id: 'D', name: '翠营', val: c.d || 0, color: 'var(--ink-d)' },
    ].slice(0, pCount);

    const maxScore = Math.max(...seatScores.map((s) => s.val));
    const topSeats = seatScores.filter((s) => s.val === maxScore);
    if (topSeats.length > 1) {
      $('endWinner').textContent = '平局';
      $('endWinner').style.color = 'var(--text)';
      $('endTitle').textContent = '对战结束 · 最高 ' + maxScore + ' 格';
    } else {
      const winner = topSeats[0];
      $('endWinner').textContent = winner.name + '获胜';
      $('endWinner').style.color = winner.color;
      const secondScore = Math.max(...seatScores.filter((s) => s !== winner).map((s) => s.val));
      $('endTitle').textContent = '对战结束 · 领先 ' + (winner.val - secondScore) + ' 格';
    }
  }
  $('endReason').textContent = S.reason || '';
  $('endOverlay').classList.remove('hidden');
}

function closeEndModal() {
  endDismissed = true;
  $('endOverlay').classList.add('hidden');
}

/* ---------- 计时 ---------- */
function syncClock() {
  const el = $('clock');
  if (!S || S.phase !== 'playing' || !S.deadline || (S.cfg && (S.cfg.playerCount === 1 || !S.cfg.turnSeconds))) {
    el.textContent = (S && S.cfg && (S.cfg.playerCount === 1 || !S.cfg.turnSeconds)) ? '∞' : String(turnSeconds());
    el.className = 'clock';
    return;
  }
  /* 待裁决：计时同样冻住，显示裁决前剩下的秒数 */
  if (S.dispute) {
    el.textContent = Math.max(0, Math.round(S.dispute.left / 1000));
    el.className = 'clock hold';
    return;
  }
  /* 暂停时按「暂停那一刻的剩余毫秒」显示，不随时间往下走 */
  if (S.paused) {
    el.textContent = Math.max(0, Math.round(S.paused.left / 1000));
    el.className = 'clock paused';
    return;
  }
  const left = Math.max(0, Math.round((S.deadline - (Date.now() + skew)) / 1000));
  el.textContent = left;
  el.className = 'clock' + (left <= 10 ? ' low' : ' run');
}
setInterval(syncClock, 250);

/* ---------- 操作 ---------- */
function verdict(kind, text) {
  const el = $('verdict');
  el.className = 'msg show ' + (kind === 'ok' ? 'ok' : kind === 'warn' ? 'warn' : 'err');
  el.innerHTML = text;
}

async function submit() {
  if (!S || !S.you || S.phase !== 'playing' || S.turn !== S.you || S.paused || S.dispute) return;
  const text = $('poem').value.trim();
  if (!text) return;
  $('btnSubmit').disabled = true;
  const { data } = await post('/api/room/' + ME.roomId + '/move', { t: ME.token, text });
  $('btnSubmit').disabled = false;
  /* 未收录：不算失败，而是挂起等对手裁决 —— 计时已由服务端冻住 */
  if (data.code === 'dispute') {
    verdict('warn', '⏸ ' + esc(data.reason || '这句语料里没查到，等对手裁决。'));
    return;
  }
  if (data.ok) {
    $('poem').value = '';
    renderBoard();                       /* 提交成功：把预览色一并收掉 */
    const src = data.source;
    const tag = { exact: '整句命中', fragment: '名句片段', variant: '异文等价', couplet: '联句', phrase: '跨句连写', free: '自由放行' }[data.entry ? data.entry.via : 'exact'] || '通过';
    verdict('ok', '✓ ' + tag + ' · 判诗通过' +
      (src ? '<span class="src"> ｜ 见《' + esc(src.title) + '》' + esc(src.author) + '（' + esc(src.dynasty) + '）</span>' : ''));
    $('poem').focus();
  } else {
    verdict('err', '✕ ' + esc(data.reason || '无效'));
    $('poem').select();
  }
}
function bindGame() {
  $('btnSubmit').addEventListener('click', submit);
  $('poem').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  /* 打字即预览：把输入句里出现的字在棋盘上刷成当前方的半透明墨色 */
  $('poem').addEventListener('input', () => { if (S) renderBoard(); });

  const btnCloseNotice = $('btnCloseGameNotice');
  if (btnCloseNotice) {
    btnCloseNotice.addEventListener('click', () => {
      if (latestNoticeAt) dismissedGameNoticeAt = latestNoticeAt;
      if ($('gameNotice')) $('gameNotice').classList.add('hidden');
    });
  }

  /* ---- 开局设置：改完点「应用设置」；只换一套字就点「重抽棋盘」 ---- */
  for (const el of [$('cfgSize'), $('cfgExtra'), $('cfgRounds'), $('cfgSeconds'), $('cfgMaxLen'), $('cfgEndless'), $('cfgLimitCouplet'), $('cfgFreeSubmit')]) {
    if (el) {
      el.addEventListener('input', markSetupDirty);
      if (el.type === 'checkbox') el.addEventListener('change', markSetupDirty);
    }
  }

  const clampCfgSize = () => {
    if (!$('cfgSize') || $('cfgSize').disabled) return;
    const n = Math.max(5, Math.min(20, Math.round(Number($('cfgSize').value)) || 10));
    $('cfgSize').value = n;
    const minExtra = Math.max(0, n * n - 300);
    const maxExtra = n * n;
    if ($('cfgExtra')) {
      $('cfgExtra').min = String(minExtra);
      $('cfgExtra').max = String(maxExtra);
      const ev = Math.max(minExtra, Math.min(maxExtra, Math.round(Number($('cfgExtra').value) || 0)));
      $('cfgExtra').value = ev;
    }
    if ($('cfgExtraHint')) $('cfgExtraHint').textContent = minExtra + '–' + maxExtra;
    syncNumStepButtons();
  };
  const clampCfgExtra = () => {
    if (!$('cfgExtra') || $('cfgExtra').disabled) return;
    const min = Number($('cfgExtra').min) || 0;
    const max = Number($('cfgExtra').max) || 400;
    $('cfgExtra').value = Math.max(min, Math.min(max, Math.round(Number($('cfgExtra').value) || 0)));
    syncNumStepButtons();
  };
  const clampCfgRounds = () => {
    if (!$('cfgRounds') || $('cfgRounds').disabled) return;
    $('cfgRounds').value = Math.max(1, Math.min(999, Math.round(Number($('cfgRounds').value) || 20)));
    syncNumStepButtons();
  };
  const clampCfgSeconds = () => {
    if (!$('cfgSeconds') || $('cfgSeconds').disabled || $('cfgSeconds').type === 'text') return;
    $('cfgSeconds').value = Math.max(15, Math.min(600, Math.round(Number($('cfgSeconds').value) || 120)));
    syncNumStepButtons();
  };
  const clampCfgMaxLen = () => {
    if (!$('cfgMaxLen') || $('cfgMaxLen').disabled || $('cfgMaxLen').type === 'text') return;
    $('cfgMaxLen').value = Math.max(5, Math.min(99, Math.round(Number($('cfgMaxLen').value) || 17)));
    syncNumStepButtons();
  };

  $('cfgSize').addEventListener('change', clampCfgSize);
  $('cfgSize').addEventListener('blur', clampCfgSize);
  $('cfgExtra').addEventListener('change', clampCfgExtra);
  $('cfgExtra').addEventListener('blur', clampCfgExtra);
  $('cfgRounds').addEventListener('change', clampCfgRounds);
  $('cfgRounds').addEventListener('blur', clampCfgRounds);
  $('cfgSeconds').addEventListener('change', clampCfgSeconds);
  $('cfgSeconds').addEventListener('blur', clampCfgSeconds);
  if ($('cfgMaxLen')) {
    $('cfgMaxLen').addEventListener('change', clampCfgMaxLen);
    $('cfgMaxLen').addEventListener('blur', clampCfgMaxLen);
  }

  for (const el of document.querySelectorAll('#cfgKinds input')) {
    el.addEventListener('change', markSetupDirty);
  }
  $('btnApplyCfg').addEventListener('click', async () => {
    if (!ME) return;
    const kinds = {};
    for (const el of document.querySelectorAll('#cfgKinds input')) kinds[el.value] = el.checked;
    const cSize = Math.max(5, Math.min(20, Math.round(Number($('cfgSize').value)) || 10));
    const minEx = Math.max(0, cSize * cSize - 300);
    const maxEx = cSize * cSize;
    const cExtra = Math.max(minEx, Math.min(maxEx, Math.round(Number($('cfgExtra').value) || 0)));
    const cRounds = Math.max(1, Math.min(999, Math.round(Number($('cfgRounds').value) || 20)));
    const cSec = (S && S.cfg && S.cfg.playerCount === 1) ? 0 : Math.max(15, Math.min(600, Math.round(Number($('cfgSeconds').value) || 120)));
    const cMax = (S && S.cfg && S.cfg.playerCount === 1) ? 0 : ($('cfgMaxLen') ? Math.max(5, Math.min(99, Math.round(Number($('cfgMaxLen').value) || 17))) : 17);

    const body = {
      t: ME.token,
      size: cSize,
      extra: cExtra,
      rounds: cRounds,
      turnSeconds: cSec,
      maxPoemLen: cMax,
      limitCouplet: (S && S.cfg && S.cfg.playerCount === 1) ? false : ($('cfgLimitCouplet') ? $('cfgLimitCouplet').checked : true),
      freeSubmit: (S && S.cfg && S.cfg.playerCount === 1) ? false : ($('cfgFreeSubmit') ? $('cfgFreeSubmit').checked : false),
      endless: $('cfgEndless').checked,
      kinds,
    };
    const { data } = await post('/api/room/' + ME.roomId + '/cfg', body);
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '设置失败'));
    setupDirty = false; setupSig = '';
    renderSetup();
    verdict('ok', '设置已更新：' + (data.redrew ? '棋盘按新尺寸重铺，' : '') + '双方需要重新点「准备好了」。');
  });
  $('btnRedraw').addEventListener('click', async () => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/redraw', { t: ME.token });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '重抽失败'));
    setupDirty = false; setupSig = '';
    renderSetup();
    verdict('ok', '已重抽棋盘（' + (S ? S.size : '') + '×' + (S ? S.size : '') + '），双方需要重新点「准备好了」。');
  });

  /* ---------- 自定义字库 ---------- */
  $('btnOpenPool').addEventListener('click', openPoolModal);
  $('btnCancelPool').addEventListener('click', closePoolModal);
  $('btnApplyPool').addEventListener('click', () => submitPool($('poolText').value || ''));
  $('poolText').addEventListener('input', renderPoolMeta);
  $('poolOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'poolOverlay') closePoolModal();
  });
  $('btnPickPoolFile').addEventListener('click', () => $('poolFileInput').click());
  $('poolFileInput').addEventListener('change', async () => {
    const f = $('poolFileInput').files && $('poolFileInput').files[0];
    if (!f) return;
    $('poolFileName').textContent = f.name;
    const txt = await readAsText(f);
    if (!txt) return verdict('err', '✕ 这个文件读不出来（可能是二进制或编码不对）。');
    $('poolText').value = txt;
    renderPoolMeta();
  });
  $('btnClearPool').addEventListener('click', () => {
    if (!S || !S.canPickCells) return;
    submitPool('');
  });

  /* 开局前点棋盘换单格的字：委托在容器上，格子是每次重建的，别逐格绑 */
  $('board').addEventListener('click', (e) => {
    const cell = e.target && e.target.closest ? e.target.closest('.cell') : null;
    if (!cell || !cell.dataset || cell.dataset.i === undefined) return;
    rerollCellAt(Number(cell.dataset.i));
  });
  $('btnPass').addEventListener('click', async () => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/pass', { t: ME.token });
    if (!data.ok) verdict('err', '✕ ' + esc(data.reason || '不能放弃'));
    else verdict('warn', '已放弃本回合（未涂色）');
  });
  $('btnRematch').addEventListener('click', async () => {
    const { data } = await post('/api/room/' + ME.roomId + '/rematch', { t: ME.token });
    if (!data.ok) return toast(data.reason || '开不了新局');
    closeEndModal();
    endDismissed = false;
    verdict('warn', '新棋盘已摆好，准备后开始。');
  });
  $('btnEndClose').addEventListener('click', closeEndModal);
  $('endOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'endOverlay') closeEndModal();
  });

  /* ---- 准备 / 邀请 ---- */
  $('btnReady').addEventListener('click', async () => {
    if (!ME || !S) return;
    const mineReady = !!(S.ready && S.you && S.ready[S.you]);
    const { data } = await post('/api/room/' + ME.roomId + '/ready', { t: ME.token, ready: !mineReady });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '操作失败'));
    if (data.started) verdict('ok', '全员准备完毕，对局开始！');
    else verdict('warn', !mineReady ? '已准备，等其他人点「准备好了」。' : '已取消准备。');
  });
  $('btnInvite').addEventListener('click', () => {
    if (!S) return;
    waitDismissed = false;
    $('waitCode').textContent = S.id;
    $('shareUrl').value = roomLink(S.id);
    $('waitOverlay').classList.remove('hidden');
  });
  $('btnWaitClose').addEventListener('click', () => {
    waitDismissed = true;
    $('waitOverlay').classList.add('hidden');
  });

  /* ---- 暂停 / 继续（任意一方都能操作） ---- */
  const togglePause = async () => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/pause', { t: ME.token });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '操作失败'));
    verdict(data.resumed ? 'ok' : 'warn', data.resumed ? '已继续对局。' : '已暂停，倒计时冻结。');
  };
  $('btnPause').addEventListener('click', togglePause);
  $('btnResume').addEventListener('click', togglePause);

  /* ---- 下场当观众 / 观众补位 ---- */
  $('btnStand').addEventListener('click', async () => {
    if (!ME) return;
    if (!confirm('下场后这一局会暂停，等你坐回来或别人补位才继续。确定下场观战？')) return;
    const { data } = await post('/api/room/' + ME.roomId + '/stand', { t: ME.token });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '下不去'));
    verdict('warn', '已下场观战：计时已冻结，随时可以坐回位子。');
  });
  const sit = async (seat) => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/seat', { t: ME.token, seat });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '坐不下'));
    if (ME && data.seat) { ME.seat = data.seat; save(); }
    const seatNames = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
    if (data.switched) {
      verdict('ok', '已换到' + (seatNames[data.seat] || '新席位') + '。');
    } else {
      verdict('ok', '已坐上' + (seatNames[data.seat] || '选手席') + '，准备或直接开局。');
    }
  };
  $('btnSeatA').addEventListener('click', () => sit('A'));
  $('btnSeatB').addEventListener('click', () => sit('B'));
  if ($('btnSeatC')) $('btnSeatC').addEventListener('click', () => sit('C'));
  if ($('btnSeatD')) $('btnSeatD').addEventListener('click', () => sit('D'));

  /* ---- 房间面板：成员 / 事件 页签 ---- */
  $('tabMembers').addEventListener('click', () => { roomTab = 'members'; syncRoomTabs(); });
  $('tabEvents').addEventListener('click', () => { roomTab = 'events'; syncRoomTabs(); });

  /* ---- 成员：改昵称 / 移出离线者 ---- */
  $('memList').addEventListener('input', (e) => {
    if (e.target && e.target.id === 'nickInput') {
      editingVal = e.target.value;
      /* 手改过就不再是「抽来的诗人名」—— 否则把随机名改成自己的名字还能标 random 绕过额度。
         服务端也会核对名字在不在诗人池里，这里只是别让玩家白挨一次拒绝。 */
      if (editingVal.trim() !== editingRandom) editingRandom = '';
    }
  });
  $('memList').addEventListener('keydown', (e) => {
    if (!e.target || e.target.id !== 'nickInput') return;
    if (e.key === 'Enter') { e.preventDefault(); saveNick(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelNick(); }
  });
  $('memList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'seat') {
      const seat = b.getAttribute('data-seat');
      if (seat) sit(seat);
      return;
    }
    if (act === 'nick') {
      const m = ((S && S.members) || []).find((x) => x.mid === b.getAttribute('data-mid'));
      editingNick = b.getAttribute('data-mid');
      editingVal = (m && m.nick) || '';
      editingRandom = '';
      renderMembers();
      return;
    }
    if (act === 'nick-random') {
      b.disabled = true;
      fetchRandomName().then((name) => {
        b.disabled = false;
        if (!name) return;
        editingVal = name;
        editingRandom = name;      /* 标记来源：保存时据此走「不占额度」的路径 */
        const inp = $('nickInput');
        if (inp) { inp.value = name; inp.focus(); }
        verdict('ok', '抽到了「' + esc(name) + '」。用诗人名不占「24 小时一次」的自定义额度。');
      }).catch(() => { b.disabled = false; verdict('err', '✕ 没抽到，再试一次。'); });
      return;
    }
    if (act === 'nick-cancel') { cancelNick(); return; }
    if (act === 'nick-save') { saveNick(); return; }
    if (act === 'ref' || act === 'unref') {
      const m = ((S && S.members) || []).find((x) => x.mid === b.getAttribute('data-mid'));
      if (!m || !ME) return;
      const on = act === 'ref';
      const { data } = await post('/api/room/' + ME.roomId + '/ref', { t: ME.token, mid: m.mid, on });
      if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '设置失败'));
      memSig = '';
      renderMembers();
      verdict('ok', on
        ? '已把「' + esc(m.nick) + '」设为裁判：可暂停 / 撤销 / 结算 / 裁决未收录句。'
        : '已取消「' + esc(m.nick) + '」的裁判身份。');
      return;
    }
    if (act === 'kick') {
      const m = ((S && S.members) || []).find((x) => x.mid === b.getAttribute('data-mid'));
      if (!m || !ME) return;
      if (!confirm('把「' + m.nick + '」移出房间？' +
        (m.kind === 'player' ? '他的席位会空出来，计时会冻结，等别人补位。' : ''))) return;
      const { data } = await post('/api/room/' + ME.roomId + '/kick', { t: ME.token, mid: m.mid });
      if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '移出失败'));
      verdict('warn', '已把「' + m.nick + '」移出房间。');
    }
  });

  function cancelNick() {
    editingNick = null; editingVal = ''; editingRandom = '';
    memSig = '';                 /* 强制重绘回普通行 */
    renderMembers();
  }
  async function saveNick() {
    if (!ME || !editingNick) return;
    const name = String(editingVal || '').trim();
    if (!name) return verdict('err', '✕ 昵称不能为空。');

    /* 没变就不该消耗额度，也不该弹窗打扰 —— 服务端也会判 unchanged，这里提前挡住 */
    if (S && S.youNick && name === S.youNick) {
      editingNick = null; editingVal = ''; editingRandom = '';
      memSig = ''; renderMembers();
      return verdict('warn', '昵称没有变化。');
    }

    /* 「随机诗人名」不占额度；只有自定义名字才要提醒 + 查额度。
       editingRandom 只在「抽完没再手改」时成立，服务端还会再核对名字是否真在诗人池里。 */
    const useRandom = !!editingRandom && name === editingRandom;
    if (!useRandom) {
      const q = await fetchNickQuota();
      if (q && q.canRename === false) {
        return askGame({
          eyebrow: '改名',
          title: '自定义昵称 24 小时只能改一次',
          body: nickCoolBody(q) + '<br>这一行右边的骰子就是「抽一位诗人」。',
          okText: '知道了', hideCancel: true,
        });
      }
      /* 浏览器 confirm 换成站内弹窗：原生弹窗标题栏是域名，跟这里的界面完全两套 */
      const go = await askGame({
        eyebrow: '改名',
        title: '会占用今天唯一一次自定义改名机会',
        body: '把名字改成 <b>「' + esc(name) + '」</b> 之后，<b>24 小时内不能再改成别的自定义昵称</b>。' +
          '<br>想随时换名字，可以点这一行右边的骰子抽一位诗人 —— 诗人名不占额度。',
        okText: '确定改名',
        cancelText: '再想想',
      });
      if (go !== 'ok') return;
    }

    const { data } = await post('/api/room/' + ME.roomId + '/nick', {
      t: ME.token, nick: name, uid: getUid(), random: useRandom,
    });
    if (!data.ok) {
      /* 冷却期被拒不是「出错」—— 玩家没做错什么，只是来早了。
         用同一个弹窗说清楚，而不是一闪而过的 toast。 */
      if (data.code === 'cooldown') {
        return askGame({
          eyebrow: '改名',
          title: '自定义昵称 24 小时只能改一次',
          body: nickCoolBody(data) + '<br>这一行右边的骰子就是「抽一位诗人」。',
          okText: '知道了', hideCancel: true,
        });
      }
      return verdict('err', '✕ ' + esc(data.reason || '改名失败'));
    }
    /* 在房间里改的名字也要记住 —— 只记住大厅那个输入框的话，
       下次重进会拿着旧名字（认不回席位，还会在成员列表里冒出一个「旧的我」）。 */
    rememberNick(data.nick || name);
    editingNick = null; editingVal = ''; editingRandom = '';
    memSig = '';
    renderMembers();
    if (data.unchanged) { verdict('warn', '昵称没有变化。'); return; }
    if (data.random || useRandom) {
      verdict('ok', '已改名为「' + esc(data.nick) + '」。诗人名不占自定义额度，随时可以再换。');
      return;
    }
    const d = data.retryAt ? new Date(data.retryAt) : null;
    const p = (n) => String(n).padStart(2, '0');
    const when = d ? '到 ' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : '24 小时后';
    verdict('ok', '已改名为「' + esc(data.nick) + '」。自定义昵称 24 小时只能改一次，' + when + ' 之后才能再改。');
  }

  /* ---- 未收录句的裁决：对方判有效 / 要求重填；自己只能撤回 ---- */
  const judgeDispute = async (accept) => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/dispute', { t: ME.token, accept });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '裁决失败'));
    if (data.cancelled) return verdict('warn', '已撤回提交，计时继续。');
    if (data.rejected) return verdict('warn', '已判为需重新提交，计时继续。');
    if (data.accepted) return verdict('ok', '已判为有效提交，按字面涂色入账。');
  };
  $('btnValid').addEventListener('click', () => judgeDispute(true));
  $('btnRetry').addEventListener('click', () => judgeDispute(false));
  $('btnWithdraw').addEventListener('click', () => judgeDispute(false));

  /* ---- 撤销一步 / 提前结算：选手=申请等同意；裁判/单人=直接生效 ---- */
  const ask = async (kind, okText) => {
    if (!ME) return;
    const { data } = await post('/api/room/' + ME.roomId + '/' + kind, { t: ME.token });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '发不出去'));
    const isSolo = !!(S && S.cfg && S.cfg.playerCount === 1);
    if (data.byRef) {
      verdict('ok', kind === 'undo' ? '（裁判）已撤销一步，棋局已回退。' : '（裁判）已提前结算本局。');
    } else if (isSolo || data.accepted || data.undone || data.finished) {
      verdict('ok', kind === 'undo' ? '已撤销一步，棋局已回退。' : '对局已提前结算。');
    } else {
      verdict('warn', okText);
    }
  };
  $('btnUndo').addEventListener('click', () => ask('undo', '已发出「撤销一步」请求，等对手或裁判同意。'));
  $('btnFinish').addEventListener('click', () => ask('finish', '已发出「提前结算」请求，等对手或裁判同意。'));

  const answer = async (accept) => {
    if (!ME || !S || !S.req) return;
    const mine = S.req.by === S.you;
    const { data } = await post('/api/room/' + ME.roomId + '/consent', { t: ME.token, accept: mine ? false : accept });
    if (!data.ok) return verdict('err', '✕ ' + esc(data.reason || '操作失败'));
    if (mine) verdict('warn', '已取消请求。');
    else if (data.denied) verdict('warn', '已拒绝对手的请求。');
    else if (data.undone) verdict('ok', '已同意，撤回上一步。');
    else if (data.finished) verdict('ok', '已同意，提前结算。');
  };
  $('btnAgree').addEventListener('click', () => answer(true));
  $('btnDeny').addEventListener('click', () => answer(false));

  /* ---- 导出截图 / GIF（实现在 export.js） ---- */
  const ex = () => window.OLEXport;
  $('btnShot').addEventListener('click', () => { if (ex()) ex().shot(); });
  $('btnEndShot').addEventListener('click', () => { if (ex()) ex().shot(); });
  $('btnEndGif').addEventListener('click', () => { if (ex()) ex().gif(); });
  $('btnGif').addEventListener('click', () => { if (ex()) ex().gif(); });
  $('btnShotSave').addEventListener('click', () => { if (ex()) ex().save(); });
  $('btnShotZoom').addEventListener('click', () => { if (ex()) ex().zoom(); });
  $('btnShotClose').addEventListener('click', () => { if (ex()) ex().close(); });
  $('shotOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'shotOverlay' && ex()) ex().close();
  });

  /* ---- 导出进度到本地 ---- */
  $('btnExportProgress').addEventListener('click', openBackupModal);
  $('btnEndBackup').addEventListener('click', openBackupModal);
  $('btnCloseBackup').addEventListener('click', closeBackupModal);
  $('btnDownloadBackup').addEventListener('click', downloadBackupFile);
  $('btnCopyBackupCode').addEventListener('click', copyBackupCode);
  $('backupCodeArea').addEventListener('click', function () { this.select(); });
  $('backupOverlay').addEventListener('click', (e) => {
    if (e.target && e.target.id === 'backupOverlay') closeBackupModal();
  });

  /* 离开房间：先告诉服务端（释放席位 / 从观众席移除），再清本地身份。
     不通知就直接跳走的话，位子会一直挂着你，别人还以为你在。
     这一发必须在页面卸载后仍然发得出去，所以用 keepalive；失败再用 sendBeacon 兜一次
     —— 少发这一发，服务端最快也要等 75 秒心跳超时才可能发现你已经走了。 */
  $('btnLeave').addEventListener('click', async () => {
    if (ME) {
      if (S && S.role === 'player' && S.phase === 'playing') {
        if (!confirm('这一局还在进行，离开后你的席位会空出来、计时冻结。确定离开？')) return;
      }
      const t = ME.token, rid = ME.roomId;
      leftByUser = true;
      try { sessionStorage.removeItem('feihua-state-' + rid); } catch (_) {}
      ME = null; save(); stopBeat();
      if (ES) { ES.close(); ES = null; }
      await leaveRequest(rid, t);
    } else {
      ME = null; save(); stopBeat();
      if (ES) { ES.close(); ES = null; }
    }
    location.href = selfLink();
  });
  /* 断线遮罩的「回到大厅 / 刷新页面」两个按钮随遮罩一起移除了（2026-10-24）。 */
}

/* ---------- 导出进度到本地 / 导入进度恢复对局 ---------- */
let currentBackupData = null;

async function openBackupModal() {
  if (!ME || !S) return toast('还没进入对局，无法导出。');
  const overlay = $('backupOverlay');
  if (!overlay) return;
  const area = $('backupCodeArea');
  area.value = '正在获取最新规范备份数据...';
  overlay.classList.remove('hidden');

  try {
    const r = await fetch('/api/room/' + ME.roomId + '/backup?t=' + encodeURIComponent(ME.token || ''), { cache: 'no-store' });
    const d = await r.json().catch(() => null);
    if (d && d.ok && d.backup) {
      currentBackupData = d.backup;
    } else {
      currentBackupData = buildLocalBackupFromState(S);
    }
  } catch (_) {
    currentBackupData = buildLocalBackupFromState(S);
  }

  const jsonStr = JSON.stringify(currentBackupData, null, 2);
  area.value = jsonStr;
  const roundTxt = currentBackupData.round ? '第 ' + currentBackupData.round + ' 轮' : '';
  $('backupTitle').textContent = '房号 ' + ME.roomId + (roundTxt ? ' · ' + roundTxt : '') + ' · 进度备份';
}

function closeBackupModal() {
  const overlay = $('backupOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function downloadBackupFile() {
  if (!currentBackupData) return toast('备份数据尚未就绪');
  const jsonStr = JSON.stringify(currentBackupData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const rNo = currentBackupData.round || 1;
  a.href = url;
  a.download = '飞花令进度_房号' + (currentBackupData.roomId || 'room') + '_第' + rNo + '轮.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
  toast('存档文件已下载');
}

async function copyBackupCode() {
  const area = $('backupCodeArea');
  if (!area || !area.value) return;
  try {
    await navigator.clipboard.writeText(area.value);
    toast('存档代码已复制到剪贴板');
  } catch (_) {
    area.select();
    document.execCommand('copy');
    toast('存档代码已复制');
  }
}

function buildLocalBackupFromState(st) {
  if (!st) return {};
  const n = st.cfg ? st.cfg.size * st.cfg.size : 100;
  const bArr = Array.from(st.board || '');
  const cArr = Array.from(st.chars || '');
  const board = [];
  for (let i = 0; i < n; i++) {
    board.push({
      ch: cArr[i] || '',
      owner: ['A', 'B', 'C', 'D'].includes(bArr[i]) ? bArr[i] : null,
    });
  }
  return {
    magic: 'FEIHUA_BACKUP',
    version: 1,
    exportedAt: Date.now(),
    roomId: st.id,
    isPrivate: !!st.isPrivate,
    round: st.round || 1,
    turnNo: st.turnNo || 1,
    cfg: Object.assign({}, st.cfg),
    phase: st.phase,
    turn: st.turn,
    board,
    log: Array.isArray(st.log) ? st.log.slice() : [],
    reason: st.reason || '',
    seats: {
      A: st.seats && st.seats.A ? { nick: st.seats.A.nick } : null,
      B: st.seats && st.seats.B ? { nick: st.seats.B.nick } : null,
      C: st.seats && st.seats.C ? { nick: st.seats.C.nick } : null,
      D: st.seats && st.seats.D ? { nick: st.seats.D.nick } : null,
    },
    paused: st.paused ? { by: st.paused.by, left: st.paused.left, why: st.paused.why } : null,
    events: Array.isArray(st.events) ? st.events.slice(-50) : [],
  };
}

/* ============ 语料数据库查验模块 ============ */
let corpusActiveTab = 'poem';
let corpusSummaryData = null;

function openCorpusModal(initialQuery = '', initialTab = 'poem') {
  const overlay = $('corpusOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  switchCorpusTab(initialTab);
  if (initialQuery) {
    $('corpusQuery').value = initialQuery;
    doCorpusSearch();
  }
  loadCorpusSummary();
}

function closeCorpusModal() {
  const overlay = $('corpusOverlay');
  if (overlay) overlay.classList.add('hidden');
}

async function loadCorpusSummary() {
  if (corpusSummaryData) {
    renderCorpusHeadTags(corpusSummaryData);
    return;
  }
  try {
    const res = await fetch('/api/corpus/summary');
    const json = await res.json();
    if (json && json.ok && json.data) {
      corpusSummaryData = json.data;
      renderCorpusHeadTags(corpusSummaryData);
      if (corpusActiveTab === 'stats') renderCorpusStats(corpusSummaryData);
    }
  } catch (_) {}
}

function renderCorpusHeadTags(d) {
  const box = $('corpusHeadTags');
  if (!box || !d) return;
  const pWan = (d.poems / 10000).toFixed(1);
  const cWan = (d.lines / 10000).toFixed(1);
  box.innerHTML = '<span>总篇数: ' + pWan + '万 (' + d.poems.toLocaleString() + ')</span>' +
    '<span>总小句: ' + cWan + '万 (' + d.lines.toLocaleString() + ')</span>' +
    '<span>异文名篇: ' + (d.variants || 0) + '</span>';
}

function switchCorpusTab(tab) {
  corpusActiveTab = tab;
  if ($('tabPoem')) $('tabPoem').classList.toggle('active', tab === 'poem');
  if ($('tabProbe')) $('tabProbe').classList.toggle('active', tab === 'probe');
  if ($('tabStats')) $('tabStats').classList.toggle('active', tab === 'stats');

  const searchBar = $('corpusSearchBar');
  const chips = $('corpusChips');
  const scrollBox = $('corpusScrollBox');

  if (tab === 'stats') {
    if (searchBar) searchBar.style.display = 'none';
    if (chips) chips.style.display = 'none';
    if (corpusSummaryData) {
      renderCorpusStats(corpusSummaryData);
    } else {
      scrollBox.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);">正在加载全库统计...</div>';
      loadCorpusSummary();
    }
    return;
  }

  if (searchBar) searchBar.style.display = 'flex';
  if (chips) chips.style.display = 'flex';

  if (tab === 'poem') {
    if ($('corpusQuery')) $('corpusQuery').placeholder = '输入诗词标题或作者（如：静女、赤壁怀古、李白、苏轼）';
    if (chips) {
      chips.innerHTML = '<span>快捷示例：</span>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="静女">静女</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="赤壁怀古">赤壁怀古</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="李白">李白</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="苏轼">苏轼</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="李贺">李贺</a>';
    }
  } else if (tab === 'probe') {
    if ($('corpusQuery')) $('corpusQuery').placeholder = '输入完整或连续诗句测试判定与落点（如：静女其姝、乱我心者今日之日多烦忧）';
    if (chips) {
      chips.innerHTML = '<span>快捷示例：</span>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="静女其姝">静女其姝</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="乱我心者今日之日多烦忧">乱我心者今日之日多烦忧</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="床前看月光">床前看月光(异文)</a>' +
        '<a href="javascript:void(0)" class="corpus-chip" data-val="醉翁之意不在酒">醉翁之意不在酒</a>';
    }
  }
}

async function doCorpusSearch() {
  const q = $('corpusQuery').value.trim();
  const box = $('corpusScrollBox');
  if (!q) {
    toast('请输入要查验的标题、作者或诗句');
    $('corpusQuery').focus();
    return;
  }

  box.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);">正在全库毫秒级检索中...</div>';

  if (corpusActiveTab === 'poem') {
    try {
      const res = await fetch('/api/corpus/search?q=' + encodeURIComponent(q) + '&limit=30');
      const r = await res.json();
      if (!r || !r.ok || !r.data) {
        box.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);">检索失败，请稍后重试</div>';
        return;
      }
      renderPoemSearchResults(r.data, q);
    } catch (e) {
      box.innerHTML = '<div style="text-align:center;padding:30px;color:#B03A2E;">网络请求异常: ' + escapeHtml(e.message) + '</div>';
    }
  } else if (corpusActiveTab === 'probe') {
    try {
      const res = await fetch('/api/corpus/probe?q=' + encodeURIComponent(q) + '&limit=15');
      const r = await res.json();
      if (!r || !r.ok || !r.data) {
        box.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);">检索失败，请稍后重试</div>';
        return;
      }
      renderProbeSearchResults(r.data, q);
    } catch (e) {
      box.innerHTML = '<div style="text-align:center;padding:30px;color:#B03A2E;">网络请求异常: ' + escapeHtml(e.message) + '</div>';
    }
  }
}

function renderPoemSearchResults(data, q) {
  const box = $('corpusScrollBox');
  if (!data.list || !data.list.length) {
    box.innerHTML = '<div style="text-align:center;padding:40px 20px;color:var(--muted);">全库 40.8万篇 中未找到标题或作者包含「' + escapeHtml(q) + '」的篇目。<br><span style="font-size:12px;color:var(--faint);margin-top:6px;display:inline-block;">提示：如果是生僻词或散文，可在首页勾选「文」文体或提交反馈申请补录。</span></div>';
    return;
  }

  let html = '<div style="font-size:12px;color:var(--muted);margin-bottom:6px;">共找到 <b>' + data.total + '</b> 篇匹配（当前展示前 ' + data.list.length + ' 条）：</div>';
  for (const item of data.list) {
    const kindClass = item.kind === '诗' ? 'badge-shi' : (item.kind === '词' ? 'badge-ci' : (item.kind === '曲' ? 'badge-qu' : (item.kind === '赋' ? 'badge-fu' : 'badge-wen')));
    const isVar = item.title && item.title.includes('(异文版)');
    html += '<div class="corpus-card">' +
      '<div class="corpus-card-title">' +
        '<span>' + escapeHtml(item.title) + (isVar ? ' <span style="color:#B45309;font-size:11px;background:#FDEBC8;padding:1px 5px;border-radius:4px;">版本异文</span>' : '') + '</span>' +
        '<span style="font-size:12px;color:var(--faint);font-weight:normal;">出处权重: ' + item.prio + '</span>' +
      '</div>' +
      '<div class="corpus-card-meta">' +
        '<span>作者：<b>' + escapeHtml(item.author || '佚名') + '</b></span>' +
        '<span>朝代：' + escapeHtml(item.dynasty || '未知') + '</span>' +
        '<span>文体：<span class="corpus-badge ' + kindClass + '">' + escapeHtml(item.kind) + '</span></span>' +
        '<span>共 ' + item.count + ' 小句</span>' +
      '</div>' +
      '<div class="corpus-card-text">' + escapeHtml(item.text) + '</div>' +
      '<details style="margin-top:8px;">' +
        '<summary style="font-size:12px;color:var(--ink-b);cursor:pointer;padding:2px 0;">查看 ' + item.clauses.length + ' 句切分明细</summary>' +
        '<div class="corpus-clauses">' +
          item.clauses.map(c => '<span class="corpus-clause-tag">' + escapeHtml(c) + '</span>').join('') +
        '</div>' +
      '</details>' +
    '</div>';
  }
  box.innerHTML = html;
}

function renderProbeSearchResults(data, q) {
  const box = $('corpusScrollBox');
  const jd = data.judge;
  let html = '';

  if (!jd) {
    box.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted);">无判定结果</div>';
    return;
  }

  const isPass = jd.ok;
  const statusCls = isPass ? 'pass' : 'fail';
  const viaName = jd.code === 'exact' ? '整句精确命中' : (jd.code === 'couplet' ? '联句(上下句结合)' : (jd.code === 'phrase' ? '名句连续片段' : (jd.code === 'variant' ? '异文对兼容' : '未收录')));

  html += '<div class="judge-res-box ' + statusCls + '">' +
    '<div>' +
      '<div style="font-weight:700;font-size:15px;margin-bottom:2px;">' +
        (isPass ? '✅ 官方判定：通过' : '❌ 官方判定：未收录') +
        '<span style="font-size:12px;font-weight:normal;margin-left:8px;padding:2px 6px;border-radius:4px;background:rgba(0,0,0,.06);">' + viaName + '</span>' +
      '</div>' +
      '<div style="font-size:12.5px;opacity:.9;">' +
        (isPass ? '判定出处：<b>《' + escapeHtml(jd.source.title) + '》</b> ' + escapeHtml(jd.source.author) + ' · ' + escapeHtml(jd.source.dynasty) + ' · ' + escapeHtml(jd.source.kind) : (escapeHtml(jd.reason) || '该句未收录于当前题库')) +
      '</div>' +
    '</div>' +
    '<div style="text-align:right;font-size:12px;opacity:.8;">' +
      '规范化字: ' + escapeHtml(jd.norm || '') +
    '</div>' +
  '</div>';

  if (data.hits && data.hits.length) {
    html += '<div style="font-size:12.5px;color:var(--muted);margin:10px 0 6px;">全库落点分析（共检索到 <b>' + data.hits.length + '</b> 首诗词包含该小句）：</div>';
    for (const h of data.hits) {
      const isOfficial = jd.source && jd.source.title === h.title && jd.source.author === h.author;
      html += '<div class="corpus-card" style="' + (isOfficial ? 'border-color:#A7F3D0;background:#FBFDFB;' : '') + '">' +
        '<div class="corpus-card-title">' +
          '<span>' +
            (isOfficial ? '<span style="color:#059669;font-weight:700;margin-right:4px;">[当前出处]</span>' : '') +
            '《' + escapeHtml(h.title) + '》' +
          '</span>' +
          '<span style="font-size:12px;color:var(--muted);">出处权重打分: <b>' + h.prio + '</b> (' + (h.prio <= 100 ? '极优先' : (h.prio <= 500 ? '较早朝代' : '转引/较晚')) + ')</span>' +
        '</div>' +
        '<div class="corpus-card-meta">' +
          '<span>作者：' + escapeHtml(h.author) + '</span>' +
          '<span>朝代：' + escapeHtml(h.dynasty) + '</span>' +
          '<span>文体：' + escapeHtml(h.kind) + '</span>' +
          '<span>命中句式：' + (h.whole ? '整句吻合' : '小句局部') + '</span>' +
        '</div>' +
        '<div class="corpus-card-text">' + escapeHtml(h.text) + '</div>' +
      '</div>';
    }
  } else {
    html += '<div style="text-align:center;padding:24px;color:var(--muted);font-size:13px;">全库 328 万句中未检索到与「' + escapeHtml(q) + '」连续重合的诗文。</div>';
  }

  box.innerHTML = html;
}

function renderCorpusStats(d) {
  const box = $('corpusScrollBox');
  if (!d) return;

  const kindItems = Object.entries(d.kinds || {}).sort((a,b) => b[1] - a[1]);
  const dynastyItems = Object.entries(d.dynasties || {}).sort((a,b) => b[1] - a[1]);

  let html = '<div class="stat-grid">' +
    '<div class="stat-card">' +
      '<div class="stat-val" style="color:#1B65A3;">' + (d.poems/10000).toFixed(1) + '<span style="font-size:13px;">万</span></div>' +
      '<div class="stat-lbl">收录总篇数 (' + d.poems.toLocaleString() + ')</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-val" style="color:#047857;">' + (d.lines/10000).toFixed(1) + '<span style="font-size:13px;">万</span></div>' +
      '<div class="stat-lbl">独立小句 (' + d.lines.toLocaleString() + ')</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-val" style="color:#B45309;">' + (d.chars/1000000).toFixed(1) + '<span style="font-size:13px;">M</span></div>' +
      '<div class="stat-lbl">语料汉字字数</div>' +
    '</div>' +
    '<div class="stat-card">' +
      '<div class="stat-val" style="color:#7E22CE;">' + (d.variants || 0) + '</div>' +
      '<div class="stat-lbl">版本异文名篇</div>' +
    '</div>' +
  '</div>';

  html += '<div style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px;">' +
    '<div style="font-weight:700;font-size:14px;margin-bottom:8px;">文体分布占比</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      kindItems.map(([k, cnt]) =>
        '<div style="flex:1;min-width:90px;background:#F8FAFC;border:1px solid var(--line);border-radius:8px;padding:8px 10px;text-align:center;">' +
          '<div style="font-weight:700;font-size:16px;">' + cnt.toLocaleString() + '</div>' +
          '<div style="font-size:12px;color:var(--muted);">' + k + ' (' + ((cnt/d.poems)*100).toFixed(1) + '%)</div>' +
        '</div>'
      ).join('') +
    '</div>' +
  '</div>';

  html += '<div style="background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px;">' +
    '<div style="font-weight:700;font-size:14px;margin-bottom:8px;">主要朝代分布</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:6px;">' +
      dynastyItems.slice(0, 12).map(([dy, cnt]) =>
        '<div style="font-size:12.5px;padding:4px 8px;background:#FAFAFB;border-radius:6px;display:flex;justify-content:space-between;">' +
          '<span style="color:var(--muted);">' + dy + '</span>' +
          '<b>' + cnt.toLocaleString() + '</b>' +
        '</div>'
      ).join('') +
    '</div>' +
  '</div>';

  html += '<div style="font-size:12.5px;color:var(--muted);line-height:1.7;padding:4px 2px;">' +
    '<b>📖 人工协作审阅指南：</b><br>' +
    '1. <b>出处判定逻辑</b>：采用「整句 > 跨句 > 片段」以及「朝代先于后世、诗词先于后转引、非僧人偈颂优先」的加权打分规则。<br>' +
    '2. <b>繁简与异文</b>：语料对「乾」「徵」做单字豁免，并对「干↔乾」「着↔著」「唯↔惟」等设立异文对智能重查。<br>' +
    '3. <b>离线版文本下载</b>：如需整库全量排版文本，可在 GitHub 仓库运行 <code>python tools/export_for_review.py</code> 生成分朝代分卷 txt。' +
  '</div>';

  box.innerHTML = html;
}

function openImportModal() {
  const overlay = $('importOverlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  $('importFileName').textContent = '未选择文件';
  $('importCodeInput').value = '';
  $('importFileInput').value = '';
  let nick = $('nick').value.trim();
  if (!nick) {
    try { nick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
  }
  $('importNick').value = nick;
}

function closeImportModal() {
  const overlay = $('importOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function handleImportFileSelect(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  $('importFileName').textContent = file.name;
  const reader = new FileReader();
  reader.onload = (evt) => {
    const txt = evt.target && evt.target.result;
    if (typeof txt === 'string') {
      $('importCodeInput').value = txt;
    }
  };
  reader.readAsText(file, 'utf-8');
}

async function confirmImport() {
  const rawTxt = $('importCodeInput').value.trim();
  if (!rawTxt) return toast('请先选择 .json 存档文件或粘贴存档代码');
  let parsed = null;
  try {
    parsed = JSON.parse(rawTxt);
  } catch (_) {
    return toast('JSON 格式解析失败，请检查粘贴的代码是否完整');
  }

  const callerNick = $('importNick').value.trim() || $('nick').value.trim();
  const keepId = $('importKeepRoomId') ? $('importKeepRoomId').checked : true;

  $('btnConfirmImport').disabled = true;
  const { data } = await post('/api/import', {
    backup: parsed,
    nick: callerNick,
    keepRoomId: keepId,
  });
  $('btnConfirmImport').disabled = false;

  if (!data.ok) return toast(data.reason || '恢复对局失败');

  ME = { roomId: data.roomId, seat: data.seat, role: data.role, token: data.token };
  save();
  rememberNick((data.state && data.state.youNick) || callerNick);
  waitDismissed = true;
  closeImportModal();
  enterGame(data.state);
  toast('对局已恢复并置为暂停保护，点「继续对局」接着打');
}


/* ---------- 启动 ---------- */
(async function init() {
  bindLobby();
  bindGame();
  bindAllNumSteppers();
  syncNumStepButtons();

  const code = new URLSearchParams(location.search).get('r');
  if (code) $('joinCode').value = code.trim().toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 5);

  /* 上次用过的昵称填回输入框，省得每次重打 */
  try {
    const last = localStorage.getItem('feihua-nick');
    if (last && !$('nick').value) $('nick').value = last;
  } catch (_) {}
  /* 第一次来（没记住名字）→ 预填一位语料作者，别让人对着空框猜该叫什么 */
  fillRandomNick();

  /* 当前房间列表：先读一次，之后每 5 秒刷新（只看大厅时才会真的发请求） */
  loadRooms();
  if (roomPoll) clearInterval(roomPoll);
  roomPoll = setInterval(loadRooms, 5000);

  /* 公告：跟房间列表分开的节奏 —— 内容很少变，30 秒一次足够 */
  loadNotice();
  if (noticePoll) clearInterval(noticePoll);
  noticePoll = setInterval(loadNotice, 30000);

  const saved = load();
  if (saved && saved.token) {
    ME = saved;
    /* 只有服务端明确说「这个房间/身份不在了」才清掉本地身份。
       网络层失败（正好赶上服务重启）什么都不动 —— 否则玩家刷新一下就把自己踢出了对局。 */
    let verdict = 'unknown';
    try {
      const r = await fetch('/api/room/' + ME.roomId + '/peek?t=' + encodeURIComponent(ME.token), { cache: 'no-store' });
      const d = await r.json().catch(() => ({}));
      if (r.status === 200 && d.ok) {
        $('lobby').classList.add('hidden');
        $('game').classList.remove('hidden');
        $('headInfo').classList.remove('hidden');
        gameEnterNoticeAt = latestNoticeAt || Date.now();
        dismissedGameNoticeAt = 0;
        if ($('gameNotice')) $('gameNotice').classList.add('hidden');
        applyState(d.state);
        connect();
        startBeat();
        verdict = 'ok';
      } else if (r.status === 401) {
        let nick = '';
        try { nick = localStorage.getItem('feihua-nick') || ''; } catch (_) {}
        const jRes = await post('/api/join', { roomId: ME.roomId, nick, token: ME.token });
        if (jRes.status === 200 && jRes.data && jRes.data.ok) {
          ME = { roomId: jRes.data.roomId, seat: jRes.data.seat, role: jRes.data.role, token: jRes.data.token };
          save();
          $('lobby').classList.add('hidden');
          $('game').classList.remove('hidden');
          $('headInfo').classList.remove('hidden');
          gameEnterNoticeAt = latestNoticeAt || Date.now();
          dismissedGameNoticeAt = 0;
          if ($('gameNotice')) $('gameNotice').classList.add('hidden');
          applyState(jRes.data.state);
          connect();
          startBeat();
          verdict = 'ok';
        } else {
          verdict = 'gone';
        }
      } else if (r.status === 404) {
        verdict = 'gone';
      }
    } catch (_) { verdict = 'offline'; }
    if (verdict === 'gone' || verdict === 'offline') {
      let cached = null;
      try {
        const raw = sessionStorage.getItem('feihua-state-' + ME.roomId);
        if (raw) cached = JSON.parse(raw);
      } catch (_) {}
      if (cached) {
        /* 若服务刚重启完且磁盘无快照，尝试以客户端缓存快照向服务端申请复活对局 */
        const reseeded = await tryReseedRoom(cached);
        if (reseeded) {
          $('lobby').classList.add('hidden');
          $('game').classList.remove('hidden');
          $('headInfo').classList.remove('hidden');
          gameEnterNoticeAt = latestNoticeAt || Date.now();
          dismissedGameNoticeAt = 0;
          if ($('gameNotice')) $('gameNotice').classList.add('hidden');
          return;
        }
        $('lobby').classList.add('hidden');
        $('game').classList.remove('hidden');
        $('headInfo').classList.remove('hidden');
        gameEnterNoticeAt = latestNoticeAt || Date.now();
        dismissedGameNoticeAt = 0;
        if ($('gameNotice')) $('gameNotice').classList.add('hidden');
        applyState(cached);
        netGone = true;
        hideNetMask();
        toast('当前为离线缓存浏览状态');
        return;
      }
      if (verdict === 'gone') {
        ME = null; save();
        toast('这一局已经结束或不在了，重新开一局吧');
      } else if (verdict === 'offline') {
        ME = null;
        toast('服务器暂时连不上，稍后刷新可以回到原来的对局');
      }
    }
  }
})();

/* 浏览器「后退」可能把页面直接从 bfcache 里捞出来 —— 那是一张离开前的快照：
   棋盘、席位、连接全是旧的，看起来就像自己还在那间房里。
   刷新一次，让 init() 按服务端的真实状态重新判定身份。 */
window.addEventListener('pageshow', (e) => {
  if (e.persisted) location.reload();
});

/* 页面真的要被销毁时（关标签、刷新、跳到别的页面），替玩家发一次「安静的离开」。
   不能只等 SSE 的 close：浏览器可能把页面放进 bfcache、或者迟迟不回收连接，
   服务端于是以为人还在 —— 这正是「离开房间后还看到自己在房间里／房间不消失」的根子。
   persisted=true 的那种（进 bfcache）不发：页面还会回来，连接也还在。
   这一发落地后，服务端会记住「这个 token 原来坐哪」，重新加载时凭它原样接回。 */
window.addEventListener('pagehide', (e) => {
  if (!ME || leftByUser || e.persisted) return;
  try {
    const body = JSON.stringify({ t: ME.token, quiet: 1 });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/room/' + ME.roomId + '/leave', new Blob([body], { type: 'application/json' }));
    }
  } catch (_) { /* 发不出去也不要拦着页面卸载 */ }
});
