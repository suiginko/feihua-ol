'use strict';
/* 导出截图 / 导出 GIF —— 从《飞花斯普拉遁-主持台》整段移植（2026-10-16-20-18-16/site/index.html）。
 *
 * 在线版没有主持台那套本地 board / log 全局量，所以前面加一层适配：把服务端推来的
 * 状态（window.OL.state()）映射成同名变量，下面 1000 多行移植代码就能逐字复用。
 *   board / log / SIDE / CELLS / phase / endless / totalRounds / counts() / currentRound()
 * 每次导出前调一次 syncVM()，导出图与页面上的状态始终一致。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var TEAM_NAME = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
  var SEAT_ORDER = ['A', 'B', 'C', 'D'];
  var SEAT_INK = { A: 'inkA', B: 'inkB', C: 'inkC', D: 'inkD' };
  /* 结果条的浅底色：跟四营墨色配套（赤＝暖粉、青＝浅蓝、金＝浅黄、翠＝浅绿） */
  var SEAT_TINT = { A: '#FCF0EE', B: '#EDF4FB', C: '#FDF7E7', D: '#EAF6EF' };

  var board = [];        /* [{ch, owner:null|'A'|'B'|'C'|'D'}] —— 由 S.chars / S.board 还原 */
  var log = [];          /* 服务端记录，条目字段与主持台版同名 */
  var SIDE = 10;
  var CELLS = 100;
  var phase = 'ready';   /* ready | playing | over */
  var endless = false;
  var totalRounds = 20;
  var curRound = 1;
  var playerCount = 2;   /* 本局人数：1 单人 / 2 双人 / 3 三人 / 4 四人 —— 决定导出图里有几营 */

  /* 本局参战的营地（按人数截取 A..D）。导出图里所有「赤营 / 青营」这类硬编码都要走它，
     否则三人局的金营、四人局的翠营会被当成青营，显示成青营的蓝色。 */
  function activeSeats() {
    var n = Math.round(Number(playerCount) || 2);
    if (n < 1) n = 1;
    if (n > 4) n = 4;
    return SEAT_ORDER.slice(0, n);
  }

  /* 席位 → 墨色。认不出席位（老记录缺 team）时给中性灰，绝不冒充青营。 */
  function inkOf(G, seat) {
    return G[SEAT_INK[seat]] || G.muted;
  }

  function scoreOf(c, seat) {
    return (c && c[String(seat).toLowerCase()]) || 0;
  }

  /* 得分最高的一席；并列第一返回 null（＝平局） */
  function leaderOf(c) {
    var seats = activeSeats(), best = -1, win = null, tie = false;
    for (var i = 0; i < seats.length; i++) {
      var v = scoreOf(c, seats[i]);
      if (v > best) { best = v; win = seats[i]; tie = false; }
      else if (v === best) { tie = true; }
    }
    return tie ? null : win;
  }

  /* 比分文案：双人「4 : 3」，三人「4 : 3 : 2」——与图里色块顺序一致；单人只报自己的格数 */
  function scoreText(c) {
    var seats = activeSeats();
    if (seats.length === 1) return TEAM_NAME[seats[0]] + ' ' + scoreOf(c, seats[0]) + ' 格';
    return seats.map(function (s) { return String(scoreOf(c, s)); }).join(' : ');
  }

  /* 比分逐段（供 drawSegs 直接画）。版式沿用原来的「赤营 4 : 3 青营」：
     首营名在左、末营名在右，中间只写数字；三人四人局就继续往右接「: 2 金营」。 */
  function scoreSegs(c, G, short) {
    var seats = activeSeats();
    var nm = function (s) { return short ? TEAM_NAME[s].charAt(0) : TEAM_NAME[s]; };
    var out = [[nm(seats[0]) + ' ', G.muted], [String(scoreOf(c, seats[0])), inkOf(G, seats[0])]];
    for (var i = 1; i < seats.length; i++) {
      out.push([' : ', G.muted]);
      out.push([String(scoreOf(c, seats[i])), inkOf(G, seats[i])]);
      out.push([' ' + nm(seats[i]), G.muted]);
    }
    return out;
  }

  /* GIF 信息条右上角的比分：只画数字，用各营墨色区分，不带「赤 / 青 / 金」字样
     （营地一多，营名字号小又零碎，反倒挤掉了数字本身的份量） */
  function scoreSegsPx(c, G, numPx) {
    var seats = activeSeats();
    var out = [];
    for (var i = 0; i < seats.length; i++) {
      if (i) out.push([' : ', numPx - 6, G.muted]);
      out.push([String(scoreOf(c, seats[i])), numPx, inkOf(G, seats[i])]);
    }
    return out;
  }

  function state() {
    try { return (window.OL && window.OL.state) ? window.OL.state() : null; } catch (e) { return null; }
  }

  function syncVM() {
    var st = state();
    if (!st || !st.size) return false;
    SIDE = st.size;
    CELLS = SIDE * SIDE;
    var chars = st.chars || '';
    var own = st.board || '';
    board = new Array(CELLS);
    for (var i = 0; i < CELLS; i++) {
      var o = own.charAt(i);
      board[i] = { ch: chars.charAt(i), owner: (o === 'A' || o === 'B' || o === 'C' || o === 'D') ? o : null };
    }
    log = (st.log || []).slice();
    phase = st.phase === 'finished' ? 'over' : (st.phase === 'playing' ? 'playing' : 'ready');
    endless = !!st.endless;
    totalRounds = st.rounds || 20;
    curRound = st.round || 1;
    playerCount = (st.cfg && Number(st.cfg.playerCount)) || 2;
    /* 已结束的单人局回看：人数以棋盘上真出现过的席位为准，避免旧存档没有 cfg 时退化成双人图 */
    var seen = {}, maxSeat = 0;
    for (var k = 0; k < CELLS; k++) if (own.charAt(k) && 'ABCD'.indexOf(own.charAt(k)) >= 0) seen[own.charAt(k)] = 1;
    for (var s = 0; s < SEAT_ORDER.length; s++) if (seen[SEAT_ORDER[s]]) maxSeat = s + 1;
    if (maxSeat > playerCount) playerCount = maxSeat;
    return true;
  }

  function isNicksEnabled() {
    var el = $('chkShotNicks');
    return el ? !!el.checked : true;
  }

  function seatNick(seat) {
    var st = state();
    if (st && st.seats && st.seats[seat] && st.seats[seat].nick) {
      return String(st.seats[seat].nick).trim();
    }
    return '';
  }

  function nickOfEntry(e) {
    if (!e) return '';
    if (e.byNick) return String(e.byNick).trim();
    return seatNick(e.team);
  }

  function teamActualNicks(seat) {
    var nicks = [];
    var seen = {};
    log.forEach(function (e) {
      if (e.team === seat && e.byNick) {
        var n = String(e.byNick).trim();
        if (n && !seen[n]) {
          seen[n] = true;
          nicks.push(n);
        }
      }
    });
    if (!nicks.length) {
      var cur = seatNick(seat);
      if (cur) nicks.push(cur);
    }
    return nicks;
  }

  function counts() {
    var a = 0, b = 0, c = 0, d = 0, n = 0;
    for (var i = 0; i < board.length; i++) {
      var o = board[i].owner;
      if (o === 'A') a++;
      else if (o === 'B') b++;
      else if (o === 'C') c++;
      else if (o === 'D') d++;
      else n++;
    }
    return { a: a, b: b, c: c, d: d, n: n };
  }

  function currentRound() { return curRound; }

  function cellsOf(e) { return (e && e.cells) || []; }

  /* 服务端在落子时就记下了每个命中字属于 新占 / 抢夺 / 己方（hitChars），
     直接用；旧房间没有这个字段时按历史重放算一遍，与主持台的算法一致。 */
  function hitKinds(e) {
    if (e && e.hitChars && Object.keys(e.hitChars).length) return e.hitChars;
    var owners = [], out = null, i;
    for (i = 0; i < board.length; i++) owners.push(null);
    log.forEach(function (x) {
      if (x.type !== 'fly' && x.type !== 'pass') return;
      var map = {};
      if (x.type === 'fly') {
        var cells = cellsOf(x);
        for (var c = 0; c < cells.length; c++) {
          var idx = cells[c];
          if (idx == null || idx < 0 || idx >= owners.length) continue;
          var before = owners[idx];
          map[board[idx].ch] = before == null ? 'new' : (before === x.team ? 'hold' : 'cap');
          owners[idx] = x.team;
        }
      }
      if (x === e) out = map;
    });
    return out || {};
  }

  function lineOf(e) {
    var s = (e && (e.line || e.raw || e.norm)) || '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /* 出处文案：与网页飞花记录逐字一致（《书名》作者 · 朝代），句首不带「见」字 */
  function sourceOf(e) {
    var s = e && e.source;
    if (!s || !s.title) return '';
    var out = '《' + s.title + '》';
    if (s.author) out += s.author;
    if (s.dynasty) out += ' · ' + s.dynasty;
    return out;
  }

  /* 人工裁定有效时的来源文案：裁判判的和对手判的必须分开写 */
  function rulerLabel(r) {
    if (!r) return '裁定有效';
    var nick = String(r.nick || '').trim();
    if (r.ref) return nick ? '裁判 ' + nick + ' 裁定有效' : '裁判裁定有效';
    return '对手裁定有效';
  }

  /* 主持台的 flashTip → 在线版：提示条（对局中贴在录入框下方）+ 必要时弹 toast */
  function flashTip(text, kind) {
    if (window.OL && window.OL.tip) window.OL.tip(text, kind);
  }
/* ================= 导出截图（纯 Canvas 手绘，离线可用，不依赖任何外部库） ================= */
var SHOT_FONT = "'Microsoft YaHei','PingFang SC','Source Han Sans SC','Noto Sans SC',system-ui,sans-serif";

function p2(n){ return (n < 10 ? "0" : "") + n; }
function stamp(){
  var d = new Date();
  return d.getFullYear() + p2(d.getMonth()+1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes());
}

function getGameTimes() {
  var st = state() || {};
  var now = Date.now();
  var start = st.startedAt || st.createdAt;
  if (!start && st.events && st.events.length) {
    for (var i = 0; i < st.events.length; i++) {
      if (st.events[i].type === 'start') { start = st.events[i].at; break; }
    }
  }
  if (!start && st.log && st.log.length && st.log[0].at) {
    start = st.log[0].at;
  }
  if (!start) start = now;

  var end = st.finishedAt;
  if (!end && (st.phase === 'finished' || phase === 'over')) {
    if (st.events && st.events.length) {
      for (var j = st.events.length - 1; j >= 0; j--) {
        if (st.events[j].type === 'finish') { end = st.events[j].at; break; }
      }
    }
    if (!end && st.at) end = st.at;
    if (!end) end = now;
  }
  if (!end) end = now;

  var durationMs = Math.max(0, end - start);
  var totalSec = Math.round(durationMs / 1000);
  var m = Math.floor(totalSec / 60);
  var s = totalSec % 60;
  var durStr = (m > 0 ? (m + '分') : '') + s + '秒';
  if (!durStr) durStr = '0秒';

  var d = new Date(end);
  var endStr = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());

  return {
    endStr: endStr,
    durStr: durStr,
    text: '结束时间 ' + endStr + ' ｜ 对局时长 ' + durStr
  };
}
function cssVar(name, fallback){
  try{
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    v = (v || "").trim();
    return v || fallback;
  }catch(e){ return fallback; }
}
function flyCount(team){
  return log.filter(function(e){ return e.type === "fly" && (!team || e.team === team); }).length;
}
function capTotal(){
  return log.reduce(function(s,e){ return s + (e.type === "fly" ? e.capture : 0); }, 0);
}

/* 圆角矩形路径（自己画，避免依赖 ctx.roundRect 的浏览器版本） */
function rrPath(ctx, x, y, w, h, r){
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}
/* 缩字号以塞进给定宽度；缩到下限仍超宽才截断加省略号 */
function fitText(ctx, text, maxW, maxPx, minPx, weight){
  var px = maxPx;
  while(px > minPx){
    ctx.font = weight + " " + px + "px " + SHOT_FONT;
    if(ctx.measureText(text).width <= maxW) return {text: text, px: px};
    px -= 1;
  }
  ctx.font = weight + " " + minPx + "px " + SHOT_FONT;
  var s = text;
  while(s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return {text: s + "…", px: minPx};
}
/* 逐段换色写一行字：segs = [[文本, 颜色], ...] */
function drawSegs(ctx, segs, x, y, px, weight){
  ctx.font = weight + " " + px + "px " + SHOT_FONT;
  ctx.textAlign = "left";
  var cx = x;
  for(var i = 0; i < segs.length; i++){
    ctx.fillStyle = segs[i][1];
    ctx.fillText(segs[i][0], cx, y);
    cx += ctx.measureText(segs[i][0]).width;
  }
  return cx;
}
/* 给诗句里命中的字画标记（网页端 .mk 下划线在 canvas 上的等价实现）：
     抢夺＝己方笔色实线 ／ 新占＝墨黑实线 ／ 己方＝中性灰的点状线（一个个超短小段）
   **必须在 fillText 之前调用**（先线后字，否则线会压住字的下缘）；
   只按下标量前缀宽度，不重排文字 —— 所以字号、截断、换行与原来逐点一致。
   几何对齐网页的 text-underline-offset:4px / text-decoration-thickness:2px：
   截图里字号 18px、GIF 里 17px，都是固定 4px / 2px 的量级，故取 0.22em / 0.125em；
   若照搬网页的 em 值（0.276em）会在更大的字号下把线推得太低、粗得发黑。
   己方的小段和实线**共用 oy / th**（同一个顶边），这样三种标记永远齐平 ——
   这正是当初 text-emphasis 着重点的问题：它的纵向位置由字体度量决定，对不齐下划线。 */
function drawHitMarks(ctx, e, text, x, y, px, weight, G){
  var map = hitKinds(e), team = e.team, seen = {};
  if(!text) return;
  var any = false, i;
  for(i = 0; i < text.length; i++) if(map[text.charAt(i)]){ any = true; break; }
  if(!any) return;
  ctx.font = weight + " " + px + "px " + SHOT_FONT;
  ctx.textAlign = "left";
  var oy = y + px * 0.22;                     /* 线顶 / 点顶（baseline 之下） */
  var th = Math.max(1.1, px * 0.125);         /* 线宽 ≈ 网页 2px@14.5px */
  var pen = team === "A" ? G.inkA : (team === "B" ? G.inkB : (team === "C" ? G.inkC : G.inkD));
  for(i = 0; i < text.length; i++){
    var ch = text.charAt(i), k = map[ch];
    if(!k || seen[ch]) continue;              /* 重复字只标第一次命中 */
    seen[ch] = 1;
    var x0 = ctx.measureText(text.slice(0, i)).width;
    if(k === "hold"){
      /* 与网页 dotted 对齐：每段长≈线宽、段距≈2.5 倍线宽，按字宽均分后居中 */
      ctx.fillStyle = G.hold;
      var cw = ctx.measureText(ch).width;
      var n = Math.max(1, Math.round(cw / (th * 2.5))), j;
      var gap = cw / n, dw = Math.min(th * 1.15, gap * 0.62);
      for(j = 0; j < n; j++){
        rrPath(ctx, x + x0 + gap * (j + 0.5) - dw / 2, oy, dw, th, th * 0.42);
        ctx.fill();
      }
    }else{
      ctx.fillStyle = k === "cap" ? pen : G.text;
      ctx.fillRect(x + x0, oy, Math.max(1, ctx.measureText(ch).width), th);
    }
  }
}

/* 截图版图色令牌：只认"已落定"的所有者，不含出手前的预览色 */
function shotToken(i){
  return (board[i] && board[i].owner) ? "own" + board[i].owner : "blank";
}

/* ── 布局：标题栏 / 棋盘+结算侧栏 / 飞花记录 ── */
function shotMetrics(){
  var W = 1160, PAD = 36;
  /* 棋盘区扩大为 720px 见方（+1px 外框），格子尺寸随 SIDE 缩放，
     右侧结算侧栏相应收窄，突出核心棋盘 */
  var BW = 721, CS = 720 / SIDE;
  var recs = log.filter(function(e){ return e.type === "fly" || e.type === "pass"; });
  /* 记录按「回合」成行：一行即一回合，列 = 本局的营地（双人两列，三人三列，四人四列）。
     同一回合里每个席位各只出手一次，所以 round+seat 能唯一定位一条记录。 */
  var roundMap = {}, rounds = [];
  recs.forEach(function(e){
    if(!roundMap[e.round]){ roundMap[e.round] = {}; rounds.push(e.round); }
    roundMap[e.round][e.team] = e;
  });
  rounds.sort(function(a, b){ return a - b; });
  var ROWH = 64;                             // 一行三行文字：诗句 / 明细 / 出处
  var RECHEAD = 36;                          // 记录区表头高度
  var rows = rounds.length;
  var headH = 84, gap = 26;
  var recH = rows ? RECHEAD + rows * ROWH : 46;
  var boardTop = PAD + headH + gap;
  var H = boardTop + BW + gap + 30 + recH + PAD;
  return {W:W, PAD:PAD, CS:CS, BW:BW, headH:headH, gap:gap,
          recs:recs, rounds:rounds, roundMap:roundMap, cols:activeSeats().length, rows:rows,
          rowH:ROWH, recHeadH:RECHEAD, recH:recH,
          boardTop:boardTop, H:H};
}

function drawShotBoard(ctx, x, y, m, G){
  var cs = m.CS, t = 1;
  /* 整块底铺格线色 → 单元格四周留出 1px 就得到规整网格 + 均匀外框 */
  ctx.fillStyle = G.grid;
  ctx.fillRect(x, y, m.BW, m.BW);
  for(var i = 0; i < CELLS; i++){
    var col = i % SIDE, row = (i - col) / SIDE;
    var tok = shotToken(i);
    var mergeR = (col < SIDE-1) && tok !== "blank" && shotToken(i+1) === tok;
    var mergeB = (row < SIDE-1) && tok !== "blank" && shotToken(i+SIDE) === tok;
    var cx = x + t + col*cs, cy = y + t + row*cs;
    var w = cs - t + (mergeR ? t : 0), h = cs - t + (mergeB ? t : 0);
    var owner = board[i] && board[i].owner;
    ctx.fillStyle = owner === "A" ? G.inkA : (owner === "B" ? G.inkB : (owner === "C" ? G.inkC : (owner === "D" ? G.inkD : G.blank)));
    ctx.fillRect(cx, cy, w, h);
    ctx.fillStyle = owner ? "#FFFFFF" : G.blankText;
    ctx.font = "600 " + Math.min(36, Math.round(cs*0.56)) + "px " + SHOT_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((board[i] && board[i].ch) || "", cx + cs/2, cy + cs/2 + 1);
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

function drawShotPanel(ctx, x, y, w, h, G){
  var pad = 18;
  rrPath(ctx, x + .5, y + .5, w - 1, h - 1, 14);
  ctx.fillStyle = "#FBFCFE"; ctx.fill();
  ctx.strokeStyle = G.line; ctx.lineWidth = 1; ctx.stroke();

  var c = counts();
  var innerR = x + w - pad;

  ctx.fillStyle = G.muted; ctx.font = "700 12.5px " + SHOT_FONT;
  ctx.fillText("涂色面积结算", x + pad, y + 30);

  var withNicks = isNicksEnabled();
  /* 结算逐营一行：双人局仍然是「赤营 / 青营 / 未被涂色」三行，三人四人自动多出金营 / 翠营。
     行的顺序 = 座位顺序 = 面积条的分段顺序 = 下面图例的顺序，读图不会串。 */
  var seats = activeSeats();
  var rowsDef = seats.map(function (s) {
    var nicks = teamActualNicks(s);
    if (!nicks.length && seatNick(s)) nicks = [seatNick(s)];
    return [TEAM_NAME[s], scoreOf(c, s), inkOf(G, s), inkOf(G, s), nicks];
  });
  rowsDef.push(["未被涂色", c.n, G.muted, G.grid, null]);
  var blankRow = rowsDef.length - 1;
  var ry = y + 44;
  rowsDef.forEach(function(r, i){
    /* 色块与棋盘格子保持一致：涂色格＝纯墨色，未涂色格＝空底色 + 格线描边 */
    ctx.fillStyle = i === blankRow ? G.blank : r[2];
    rrPath(ctx, x + pad, ry + 8, 15, 15, 4); ctx.fill();
    if(i === blankRow){
      ctx.strokeStyle = r[3]; ctx.lineWidth = 1;
      rrPath(ctx, x + pad + .5, ry + 8.5, 14, 14, 4); ctx.stroke();
    }
    ctx.fillStyle = G.text; ctx.font = "600 15px " + SHOT_FONT;
    ctx.fillText(r[0], x + pad + 24, ry + 21);
    var labelW = ctx.measureText(r[0]).width;

    /* 测算右侧数字与单位宽度 */
    ctx.font = "400 13px " + SHOT_FONT;
    var uw = ctx.measureText("格").width;
    ctx.font = "800 30px " + SHOT_FONT;
    var nw = ctx.measureText(String(r[1])).width;
    var rightW = uw + 5 + nw;

    /* 若勾选了选手昵称且有选手，紧跟在赤营/青营旁边 */
    if(withNicks && r[4] && r[4].length){
      var nTxt = "（" + r[4].join("、") + "）";
      var availW = innerR - (x + pad + 24 + labelW + 8) - rightW - 12;
      if(availW > 30){
        var fitN = fitText(ctx, nTxt, availW, 12.5, 10, "500");
        ctx.fillStyle = G.muted; ctx.font = "500 " + fitN.px + "px " + SHOT_FONT;
        ctx.fillText(fitN.text, x + pad + 24 + labelW + 6, ry + 21);
      }
    }

    /* 数字右对齐 + 单位 */
    ctx.textAlign = "right";
    ctx.fillStyle = G.muted; ctx.font = "400 13px " + SHOT_FONT;
    ctx.fillText("格", innerR, ry + 20);
    ctx.fillStyle = r[2]; ctx.font = "800 30px " + SHOT_FONT;
    ctx.fillText(String(r[1]), innerR - uw - 5, ry + 24);
    ctx.textAlign = "left";
    if(i < blankRow){
      ctx.strokeStyle = G.line; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + pad, ry + 40.5); ctx.lineTo(innerR, ry + 40.5); ctx.stroke();
    }
    ry += 58;
  });

  /* 面积条：按座位顺序依次堆叠，剩下的底色就是未涂色 —— 三人四人局也画得全 */
  var by = ry + 4, bw = w - pad*2, bh = 14;
  rrPath(ctx, x + pad, by, bw, bh, 7);
  ctx.fillStyle = G.blank; ctx.fill();
  ctx.save();
  rrPath(ctx, x + pad, by, bw, bh, 7); ctx.clip();
  var acc = 0;
  seats.forEach(function(s){
    var seg = bw * scoreOf(c, s) / CELLS;
    ctx.fillStyle = inkOf(G, s);
    ctx.fillRect(x + pad + acc, by, seg, bh);
    acc += seg;
  });
  ctx.restore();

  /* 结果条 */
  var sy = by + bh + 16, sh = 50;
  /* 胜负按「所有参战营地」比，而不是只比赤与青：三人局里金营涂得最多就该写金营获胜 */
  var leader = leaderOf(c);
  var banner = phase === "ready" ? {t: "尚未开局", f: "#F1F4F9", c: G.muted}
             : phase === "playing" ? {t: "对战进行中 · 第 " + currentRound() + (endless ? " 轮 · 战至最后一刻" : " / " + totalRounds + " 轮"), f: "#F1F4F9", c: G.muted}
             : seats.length === 1 ? {t: TEAM_NAME[seats[0]] + " ｜ " + scoreOf(c, seats[0]) + " 格", f: SEAT_TINT[seats[0]], c: inkOf(G, seats[0])}
             : leader ? {t: TEAM_NAME[leader] + "获胜 ｜ " + scoreText(c), f: SEAT_TINT[leader], c: inkOf(G, leader)}
             : {t: "平局 ｜ " + scoreText(c), f: "#F1F4F9", c: G.muted};
  rrPath(ctx, x + pad, sy, bw, sh, 10);
  ctx.fillStyle = banner.f; ctx.fill();
  var fitB = fitText(ctx, banner.t, bw - 16, 16, 12, "800");
  ctx.fillStyle = banner.c; ctx.font = "800 " + fitB.px + "px " + SHOT_FONT;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(fitB.text, x + pad + bw/2, sy + sh/2 + 1);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

  /* 统计 */
  var ty = sy + sh + 24;
  ctx.strokeStyle = G.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + pad, ty - 8); ctx.lineTo(innerR, ty - 8); ctx.stroke();

  var statRows = seats.map(function(s){ return [TEAM_NAME[s] + "出手", flyCount(s) + " 句"]; });
  statRows.push([seats.length > 2 ? "各方抢夺合计" : "双方抢夺合计", capTotal() + " 格"]);
  statRows
  .forEach(function(r){
    ctx.fillStyle = G.muted; ctx.font = "400 13px " + SHOT_FONT;
    ctx.fillText(r[0], x + pad, ty + 14);
    ctx.textAlign = "right";
    ctx.fillStyle = G.text; ctx.font = "700 14px " + SHOT_FONT;
    ctx.fillText(r[1], innerR, ty + 14);
    ctx.textAlign = "left";
    ty += 28;
  });

  /* 尾部：说明（下方一行图例已去掉，上方结算已包含完整图例） */
  var lineY = Math.max(ty + 10, y + h - 46);
  ctx.strokeStyle = G.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + pad, lineY); ctx.lineTo(innerR, lineY); ctx.stroke();

  ctx.fillStyle = G.muted; ctx.font = "400 11px " + SHOT_FONT;
  ctx.fillText("每句须占至少1个空位；可命中抢夺对手格。", x + pad, lineY + 24);
}

/* 单格内容：一句飞花（或"放弃本回合"）；无记录时留一个占位短横 */
function drawShotCell(ctx, cx, ry, w, e, team, G){
  var pc = inkOf(G, team);   /* 金营用金、翠营用翠 —— 不能再一律回落到青营的蓝 */
  if(!e){
    ctx.fillStyle = "#9AA7BA"; ctx.font = "400 13px " + SHOT_FONT;
    ctx.fillText("—", cx + 2, ry + 20);
    return;
  }
  if(e.type === "pass"){
    ctx.fillStyle = G.muted; ctx.font = "400 14px " + SHOT_FONT;
    ctx.fillText("放弃本回合", cx + 2, ry + 20);
    ctx.fillStyle = "#9AA7BA"; ctx.font = "400 12px " + SHOT_FONT;
    ctx.fillText("未涂色", cx + 2, ry + 37);
    return;
  }
  /* 列宽固定，超长句逐级缩字；缩到下限仍超宽才截断 */
  var fit = fitText(ctx, lineOf(e), w - 6, 18, 12, "600");
  drawHitMarks(ctx, e, fit.text, cx + 2, ry + 20, fit.px, "600", G);   /* 先画标记 */
  ctx.font = "600 " + fit.px + "px " + SHOT_FONT;
  ctx.fillStyle = G.text;
  ctx.fillText(fit.text, cx + 2, ry + 20);
  drawSegs(ctx, [
    ["命中 ", G.muted], [String(e.hits), G.muted],
    [" · 新占 ", G.muted], [String(e.blank), pc],
    [" · 抢夺 ", G.muted], [String(e.capture), pc],
    [" · 己方 ", G.muted], [String(e.hold), G.muted]
  ], cx + 2, ry + 37, 12, "400");
  /* 第三行：出处（《书名》作者 · 朝代），与网页记录同一文案；
     人工裁定「有效」的手没有语料出处，改标注裁定来源（对手判 / 裁判判要分清） */
  var src = sourceOf(e) || (e.via === "manual" ? rulerLabel(e.ruler) + " · 语料未收录" : "");
  if(src){
    var fs = fitText(ctx, src, w - 6, 11.5, 10, "400");
    ctx.font = "400 " + fs.px + "px " + SHOT_FONT;
    ctx.fillStyle = "#8A97AA";
    ctx.fillText(fs.text, cx + 2, ry + 54);
  }
}

function drawShotRecords(ctx, x, y, m, G){
  if(!m.rows){
    ctx.fillStyle = G.muted; ctx.font = "400 14px " + SHOT_FONT;
    ctx.fillText("尚未开始，飞花记录会显示在这里。", x, y + 20);
    return;
  }
  var roundW = 60;                       // 行首回合号列
  var colGap = 18;
  var seats = activeSeats();
  var colW = (m.W - m.PAD*2 - roundW - colGap * seats.length) / seats.length;
  var bodyW = m.W - m.PAD*2;
  var colX = seats.map(function(s, i){ return x + roundW + i * (colW + colGap); });

  /* 表头：回合 / 本局各营（双人局就是原来的「赤营 / 青营」两列，列宽一致） */
  ctx.fillStyle = G.muted; ctx.font = "700 12px " + SHOT_FONT;
  ctx.fillText("回合", x + 2, y + 17);
  seats.forEach(function(s, i){
    ctx.fillStyle = inkOf(G, s); ctx.font = "700 13.5px " + SHOT_FONT;
    ctx.fillText(TEAM_NAME[s], colX[i] + 2, y + 18);
  });
  ctx.strokeStyle = G.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + 27.5); ctx.lineTo(x + bodyW, y + 27.5); ctx.stroke();

  var top = y + m.recHeadH;
  m.rounds.forEach(function(r, ri){
    var ry = top + ri * m.rowH;
    /* 隔行浅底：一行就是一回合，淡斑马纹帮助横向扫读 */
    if(ri % 2 === 1){
      ctx.fillStyle = "#F7F9FC";
      rrPath(ctx, x, ry - 3, bodyW, m.rowH - 2, 6); ctx.fill();
    }
    /* 回合号 */
    ctx.fillStyle = G.muted; ctx.font = "600 13px " + SHOT_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(r), x + roundW/2, ry + 21);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

    seats.forEach(function(s, i){
      drawShotCell(ctx, colX[i], ry, colW, m.roundMap[r] && m.roundMap[r][s], s, G);
    });

    ctx.strokeStyle = "#EAEFF7"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, ry + m.rowH - 2.5); ctx.lineTo(x + bodyW, ry + m.rowH - 2.5); ctx.stroke();
  });
}

/* 生成截图所用的 canvas（同步、纯函数，便于测试直接调用） */
function buildShotCanvas(){
  var m = shotMetrics();
  var cv = document.createElement("canvas");
  var s = 2;                                   // 2 倍分辨率，贴到聊天窗口里也不糊
  cv.width = m.W * s; cv.height = m.H * s;
  var ctx = null;
  try{ ctx = cv.getContext("2d"); }catch(e){ ctx = null; }
  if(!ctx) return cv;
  ctx.scale(s, s);

  var G = {
    inkA: cssVar("--ink-a", "#C2352A"),
    inkB: cssVar("--ink-b", "#1F79C4"),
    inkC: cssVar("--ink-c", "#DE9B00"),
    inkD: cssVar("--ink-d", "#18864B"),
    blank: cssVar("--blank", "#EDF1F7"),
    blankText: cssVar("--blank-text", "#33415C"),
    grid: cssVar("--grid", "#9FABBC"),
    text: cssVar("--text", "#1F2937"),
    muted: cssVar("--muted", "#5B6B84"),
    hold: cssVar("--hit-hold", "#6B7688"),
    line: cssVar("--line", "#DCE3EE")
  };

  /* 背景 */
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, m.W, m.H);

  /* 标题栏 */
  ctx.fillStyle = G.text; ctx.font = "800 30px " + SHOT_FONT;
  ctx.fillText("飞花斯普拉遁 · 对战战报", m.PAD, m.PAD + 30);

  ctx.textAlign = "right";
  ctx.fillStyle = G.muted; ctx.font = "400 13px " + SHOT_FONT;
  var gt = getGameTimes();
  ctx.fillText(gt.text, m.W - m.PAD, m.PAD + 18);
  ctx.textAlign = "left";
  ctx.fillStyle = G.muted; ctx.font = "400 13.5px " + SHOT_FONT;
  var sideWord = activeSeats().length > 2 ? "各方" : "双方";
  ctx.fillText(SIDE + "×" + SIDE + " 棋盘 ｜ " +
               (endless ? "战至最后一刻" : "共 " + totalRounds + " 轮 ｜ " + sideWord + "各出手 " + totalRounds + " 次") +
               " ｜ 已记录 " + m.recs.length + " 手", m.PAD, m.PAD + 58);

  /* 棋盘 + 结算侧栏 */
  drawShotBoard(ctx, m.PAD, m.boardTop, m, G);
  drawShotPanel(ctx, m.PAD + m.BW + 24, m.boardTop, m.W - m.PAD*2 - m.BW - 24, m.BW, G);

  /* 飞花记录 */
  var recTop = m.boardTop + m.BW + m.gap;
  ctx.fillStyle = G.text; ctx.font = "700 15px " + SHOT_FONT;
  ctx.fillText("飞花记录", m.PAD, recTop + 16);
  drawShotRecords(ctx, m.PAD, recTop + 30, m, G);

  return cv;
}

var shotUrl = null;          // 当前预览用的 blob URL，关闭预览时释放
var lastShotCanvas = null;   // 最近一次生成的画布，供手动下载复用
var lastGifBlob = null;      // 最近一次生成的 GIF，供手动下载复用
var shotKind = "png";        // png | gif —— 决定预览层文案与下载格式
var shotZoom = false;        // false = 适应窗口；true = 实际大小（1:1，框内滚动）
var shotMetaBase = "";       // 尺寸那行的原文，缩放提示拼在它后面

/* 预览层的统一入口：PNG 与 GIF 共用同一个弹窗 */
function openShotPreview(url, isBlob, name, meta, note){
  var img = $("shotImg"), ov = $("shotOverlay");
  if(!ov || !img) return;
  if(shotUrl && shotUrl !== url){ try{ URL.revokeObjectURL(shotUrl); }catch(e){} }
  shotUrl = isBlob ? url : null;
  shotMetaBase = meta;
  shotZoom = false;                       /* 每次打开都先「适应窗口」 */
  $("shotTitle").textContent = name;
  $("shotMeta").textContent = meta;
  $("shotKindTitle").textContent = shotKind === "gif" ? "导出 GIF" : "导出截图";
  $("shotNote").textContent = note;
  $("btnShotSave").textContent = shotKind === "gif" ? "下载 GIF" : "下载 PNG";
  ov.classList.add("show");
  /* 结算面板不关：预览层在 DOM 里更靠后、z-index 更高，本来就盖在它上面；
     关掉预览后结算面板还在，用户可以接着看比分。 */
  applyShotZoom();
  img.onload = function(){ window.requestAnimationFrame(syncShotMeta); };
  img.src = url;
}

/* ---- 预览缩放 ----------------------------------------------------------
   默认「适应窗口」：整张图等比缩进弹窗，能一眼看全（下载出来的仍是原分辨率）。
   点「实际大小」切到 1:1，装不下就在框内滚动，方便看清飞花记录里的字。 */

function syncShotMeta(){
  var img = $("shotImg"), el = $("shotMeta");
  if(!img || !el || !shotMetaBase) return;
  var nat = img.naturalWidth || 0;
  var shown = Math.round(img.getBoundingClientRect().width || 0);
  if(shotZoom){
    el.textContent = shotMetaBase + " ｜ 按 1:1 显示（可滚动，下载不受影响）";
  }else if(nat > 0 && shown > 0 && shown < nat - 1){
    el.textContent = shotMetaBase + " ｜ 预览按 " + Math.round(shown / nat * 100) +
      "% 缩放显示（实际分辨率不变）";
  }else{
    el.textContent = shotMetaBase;
  }
}

function applyShotZoom(){
  var box = $("shotBox"), btn = $("btnShotZoom");
  if(box) box.classList.toggle("actual", !!shotZoom);
  if(btn) btn.textContent = shotZoom ? "适应窗口" : "实际大小";
  syncShotMeta();
}

function closeShot(){
  var ov = $("shotOverlay");
  if(ov) ov.classList.remove("show");
  var img = $("shotImg");
  if(img) img.removeAttribute("src");
  if(shotUrl){
    try{ URL.revokeObjectURL(shotUrl); }catch(e){}
    shotUrl = null;
  }
  lastShotCanvas = null;
  shotMetaBase = "";
  shotZoom = false;
}

function exportShot(){
  var cv;
  try{ cv = buildShotCanvas(); }catch(e){ cv = null; }
  if(!cv || !cv.width){
    flashTip("✕ 当前环境不支持导出截图（无法创建画布）。", "err");
    return;
  }
  lastShotCanvas = cv;
  lastGifBlob = null;
  shotKind = "png";
  var name = "飞花斯普拉遁-战报-" + stamp() + ".png";

  /* 只生成并展示预览，不再自动触发下载 —— 需要文件时由预览层里的按钮按需下载 */
  function show(url, isBlob){
    openShotPreview(url, isBlob, name,
      "画布 " + cv.width + " × " + cv.height + " px ｜ 含棋盘（" + scoreText(counts()) +
      "）与 " + shotMetrics().recs.length + " 条飞花记录",
      "图片已生成，可直接查看；需要文件请点下方「下载 PNG」，或在图片上右键「图片另存为」。");
    flashTip("✓ 截图已生成（含棋盘与飞花记录）", "ok");
  }

  try{
    if(cv.toBlob){
      /* toBlob 是异步的：先给一个提示，避免点了按钮没反应 */
      flashTip("正在生成截图…", "ok");
      cv.toBlob(function(b){
        if(b){ show(URL.createObjectURL(b), true); }
        else{ show(cv.toDataURL("image/png"), false); }
      }, "image/png");
    }else{
      show(cv.toDataURL("image/png"), false);
    }
  }catch(e){
    flashTip("✕ 生成截图失败：" + (e && e.message ? e.message : "未知错误"), "err");
  }
}

/* 手动下载：PNG 复用最近一次的画布，GIF 复用最近一次的 blob */
function downloadShot(){
  function save(url, revoke, name){
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    if(revoke) setTimeout(function(){ URL.revokeObjectURL(url); }, 3000);
  }

  if(shotKind === "gif" && lastGifBlob){
    var gn = "飞花斯普拉遁-回放-" + stamp() + ".gif";
    try{
      save(URL.createObjectURL(lastGifBlob), true, gn);
      flashTip("✓ 已下载动图：<b>" + gn + "</b>", "ok");
    }catch(e){
      flashTip("✕ 下载失败：" + (e && e.message ? e.message : "未知错误"), "err");
    }
    return;
  }

  var cv = lastShotCanvas;
  if(!cv){
    try{ cv = buildShotCanvas(); }catch(e){ cv = null; }
  }
  if(!cv || !cv.width){
    flashTip("✕ 没有可下载的截图，请先点「导出截图」。", "err");
    return;
  }
  var name = "飞花斯普拉遁-战报-" + stamp() + ".png";
  try{
    if(cv.toBlob){
      cv.toBlob(function(b){
        b ? save(URL.createObjectURL(b), true, name) : save(cv.toDataURL("image/png"), false, name);
      }, "image/png");
    }else{
      save(cv.toDataURL("image/png"), false, name);
    }
    flashTip("✓ 已下载截图：<b>" + name + "</b>", "ok");
  }catch(e){
    flashTip("✕ 下载失败：" + (e && e.message ? e.message : "未知错误"), "err");
  }
}
/* ================= 导出 GIF（逐手回放） =================
   单文件、零依赖：GIF89a 容器 + LZW 压缩 + 中位切分量化全部手写。
   画面只用棋盘 + 一条信息条（回合 / 出手方 / 比分 / 本手诗句），
   这样每一帧的变化都集中在棋盘上，动图不至于几百 K 一个字。 */

function bytesSink(){
  this.a = new Uint8Array(1 << 16);
  this.n = 0;
}
bytesSink.prototype.need = function(k){
  if(this.n + k <= this.a.length) return;
  var cap = this.a.length;
  while(cap < this.n + k) cap *= 2;
  var t = new Uint8Array(cap);
  t.set(this.a.subarray(0, this.n));
  this.a = t;
};
bytesSink.prototype.b = function(v){ this.need(1); this.a[this.n++] = v & 255; };
bytesSink.prototype.u16 = function(v){ this.b(v & 255); this.b((v >>> 8) & 255); };
bytesSink.prototype.arr = function(src){
  this.need(src.length);
  for(var i = 0; i < src.length; i++) this.a[this.n++] = src[i];
};
bytesSink.prototype.str = function(s){
  for(var i = 0; i < s.length; i++) this.b(s.charCodeAt(i));
};
bytesSink.prototype.out = function(){ return this.a.subarray(0, this.n); };

/* 回放序列：从空盘开始，逐条飞花记录重放，得到每手的棋盘快照 */
function gifHistory(){
  var owners = [];
  for(var i = 0; i < CELLS; i++) owners.push(null);
  var snaps = [{owners: owners.slice(), rec: null, changed: null}];

  log.forEach(function(e){
    if(e.type !== "fly" && e.type !== "pass") return;
    var changed = [];
    if(e.type === "fly"){
      var cells = cellsOf(e);            /* 旧记录没有 cells 字段时按诗句里的字重新定位 */
      for(var c = 0; c < cells.length; c++){
        var idx = cells[c];
        if(idx == null || idx < 0 || idx >= CELLS) continue;
        if(owners[idx] !== e.team){ owners[idx] = e.team; changed.push(idx); }
      }
    }
    snaps.push({owners: owners.slice(), rec: e, changed: changed});
  });

  /* 已结算：补一帧"结果"画面，别让动图停在最后一手上 */
  if(phase === "over" && snaps.length > 1){
    snaps.push({owners: owners.slice(), rec: {type: "end"}, changed: []});
  }
  return snaps;
}

function gifMetrics(){
  /* 所有几何都按「逻辑坐标」算（W=620 这一套），绘制时整体乘 S 放大到出图宽度。
     这样版式与 620px 时代逐点一致，只是每处都变得更清晰。 */
  var PAD = 24, W = 620;
  /* 棋盘宽度上限 620 - 两侧留白。10×10 及更大的棋盘格子封顶 52px（10×10 正好 52）；
     5–9 路小棋盘若也用 52，棋盘只有 261–469 宽、四周留一大片空白，所以让小棋盘撑满可用宽度
     （5×5 时一格 108px），构图才和 10×10 一样饱满。 */
  var fill = Math.floor((W - (PAD + 16) * 2) / SIDE);
  var CS = SIDE >= 10 ? Math.min(52, fill) : fill;
  var BW = SIDE * CS + 1;
  var headH = 44;
  var boardTop = PAD + headH;
  var stripTop = boardTop + BW + 14;
  var stripH = 100;
  var H = stripTop + stripH + PAD;
  var S = GIF_WIDTH / W;
  return {W: W, H: H, PAD: PAD, CS: CS, BW: BW,
          headH: headH, boardTop: boardTop, stripTop: stripTop, stripH: stripH,
          bx: Math.floor((W - BW) / 2),
          S: S, PW: GIF_WIDTH, PH: Math.round(H * S)};
}

/* 剪贴板出图的像素预算。
   Windows 剪贴板历史（Win+V）每条上限 4MB，量的不是 PNG 体积、而是**未压缩位图**：
   W×H×4 字节。1080×1266 → 5.47MB 必被丢进「没有预览」；实测 900×1055（3.62MB）能正常预览。
   所以这里不按固定宽度，而是按像素预算反算宽度，保证任何棋盘尺寸都落进 4MB 以内。
   注意：是**按这个尺寸重绘**（换个 S 而已），不是把 1080 的图画小，文字依旧是原始渲染的锐利度。 */
var CLIP_MAX_PX = 950000;   /* ≈ 3.8MB 未压缩位图，留出余量 */

function clipMetrics(){
  var m = gifMetrics();
  /* 面积 = W × (W × H/W) → W = √(预算 ÷ (H/W))；也不超过 GIF 的宽度 */
  var maxW = Math.floor(Math.sqrt(CLIP_MAX_PX * m.W / m.H));
  var W = Math.min(m.PW, maxW);
  var S = W / m.W;
  var o = {};
  for(var k in m) if(Object.prototype.hasOwnProperty.call(m, k)) o[k] = m[k];
  o.S = S;
  o.PW = W;
  o.PH = Math.round(m.H * S);
  return o;
}

function gifCounts(owners){
  var o = {a: 0, b: 0, c: 0, d: 0, n: 0};
  for(var i = 0; i < owners.length; i++){
    var w = owners[i];
    /* 金 / 翠也要认清：老版本只认 A、B，于是三人四人局里金营翠营的格子全被算进「未涂色」 */
    if(w === "A" || w === "B" || w === "C" || w === "D") o[w.toLowerCase()]++;
    else o.n++;
  }
  return o;
}

function drawGifBoard(ctx, m, snap, G){
  var cs = m.CS, x = m.bx, y = m.boardTop, t = 1;
  var owners = snap.owners;
  function tok(i){ return owners[i] ? "own" + owners[i] : "blank"; }
  /* 与静态截图同一套做法：整块铺格线色，单元格四周各让 1px */
  ctx.fillStyle = G.grid;
  ctx.fillRect(x, y, m.BW, m.BW);
  for(var i = 0; i < CELLS; i++){
    var col = i % SIDE, row = (i - col) / SIDE;
    var tk = tok(i);
    var mergeR = (col < SIDE - 1) && tk !== "blank" && tok(i + 1) === tk;
    var mergeB = (row < SIDE - 1) && tk !== "blank" && tok(i + SIDE) === tk;
    var cx = x + t + col * cs, cy = y + t + row * cs;
    var w = cs - t + (mergeR ? t : 0), h = cs - t + (mergeB ? t : 0);
    var o = owners[i];
    ctx.fillStyle = o === "A" ? G.inkA : (o === "B" ? G.inkB : (o === "C" ? G.inkC : (o === "D" ? G.inkD : G.blank)));
    ctx.fillRect(cx, cy, w, h);
    ctx.fillStyle = o ? "#FFFFFF" : G.blankText;
    ctx.font = "600 " + Math.round(cs * 0.56) + "px " + SHOT_FONT;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(board[i].ch, cx + cs / 2, cy + cs / 2 + 1);
  }
  /* 本手刚变化的格子：白色内描边，一眼看出这手涂了哪几格 */
  if(snap.changed && snap.changed.length){
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 3;
    for(var k = 0; k < snap.changed.length; k++){
      var q = snap.changed[k], qc = q % SIDE, qr = (q - qc) / SIDE;
      var bx = x + t + qc * cs, by = y + t + qr * cs;
      ctx.strokeRect(bx + 2.5, by + 2.5, cs - t - 5, cs - t - 5);
    }
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}

function drawGifChrome(ctx, m, snap, i, total, G){
  var withNicks = isNicksEnabled();
  var c = gifCounts(snap.owners);

  /* 标题栏：常规局写「第 x / xx 轮」，战至最后一刻就写模式名 —— 一眼看得出这是哪一轮 */
  var rec0 = snap.rec;
  var title = "飞花斯普拉遁 · ";
  if(endless){
    title += "战至最后一刻";
  }else{
    var rNow = 1;
    if(rec0 && rec0.round) rNow = rec0.round;
    else if(rec0 && rec0.type === "end") rNow = totalRounds;
    if(rNow > totalRounds) rNow = totalRounds;
    title += "第 " + rNow + " / " + totalRounds + " 轮";
  }
  ctx.fillStyle = G.text; ctx.font = "800 22px " + SHOT_FONT;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText(title, m.PAD, m.PAD + 21);
  ctx.textAlign = "right";
  ctx.fillStyle = G.muted; ctx.font = "400 13px " + SHOT_FONT;
  if(rec0 && rec0.type === "invalid"){
    /* 无效提交：右上角直说「没记进战报」，别让人以为这手算数了 */
    ctx.fillStyle = G.danger; ctx.font = "700 13px " + SHOT_FONT;
    ctx.fillText("无效 · 未记录", m.W - m.PAD, m.PAD + 20);
  }else if(rec0 && rec0.type === "end"){
    ctx.fillStyle = G.muted; ctx.font = "400 12px " + SHOT_FONT;
    var gt = getGameTimes();
    ctx.fillText("结束 " + gt.endStr.slice(5) + " ｜ 时长 " + gt.durStr, m.W - m.PAD, m.PAD + 20);
  }else{
    ctx.fillStyle = G.muted; ctx.font = "400 13px " + SHOT_FONT;
    var turnTxt = i === 0 ? "开局前" : "第 " + i + " / " + total + " 手";
    ctx.fillText(turnTxt, m.W - m.PAD, m.PAD + 20);
  }
  ctx.textAlign = "left";

  /* 信息条 */
  var sw = m.W - (m.PAD - 6) * 2, sx = m.PAD - 6, sy = m.stripTop, sh = m.stripH;
  var rec = snap.rec;
  var isEnd = rec && rec.type === "end";
  var isInvalid = rec && rec.type === "invalid";
  rrPath(ctx, sx + .5, sy + .5, sw - 1, sh - 1, 12);
  ctx.fillStyle = isInvalid ? "#FFF6F4" : "#FBFCFE"; ctx.fill();
  ctx.strokeStyle = isInvalid ? "#F0C9C2" : G.line; ctx.lineWidth = 1; ctx.stroke();
  if(isInvalid){
    /* 左侧红标条：一眼分辨"这手没算数" */
    ctx.save();
    rrPath(ctx, sx + .5, sy + .5, sw - 1, sh - 1, 12); ctx.clip();
    ctx.fillStyle = G.danger; ctx.fillRect(sx, sy, 4, sh);
    ctx.restore();
  }

  var ip = sx + 16, ir = sx + sw - 16;

  /* 第一行：出手方 + 昵称 + 回合（结算帧显示胜负）；右侧比分 */
  var seats = activeSeats();
  var leader = leaderOf(c);
  var winColor = leader ? inkOf(G, leader) : G.muted;
  var dot = !rec ? G.grid
          : (isEnd ? winColor
          : (isInvalid ? G.danger : inkOf(G, rec.team)));
  ctx.fillStyle = dot;
  ctx.beginPath(); ctx.arc(ip + 5, sy + 21, 5, 0, Math.PI * 2); ctx.fill();
  var nickTag = (withNicks && rec && rec.byNick) ? "（" + rec.byNick + "）" : "";
  if(!rec){
    ctx.fillStyle = G.muted; ctx.font = "700 14.5px " + SHOT_FONT;
    ctx.fillText("开局前 · 暂无飞花记录", ip + 18, sy + 26);
  }else if(isEnd){
    ctx.fillStyle = winColor; ctx.font = "700 14.5px " + SHOT_FONT;
    var endTxt = seats.length === 1
      ? TEAM_NAME[seats[0]] + " ｜ " + scoreOf(c, seats[0]) + " 格"
      : (leader ? TEAM_NAME[leader] + "获胜" : "平局");
    ctx.fillText("对战结束 · " + endTxt, ip + 18, sy + 26);
  }else if(isInvalid){
    ctx.fillStyle = G.danger; ctx.font = "700 14.5px " + SHOT_FONT;
    ctx.fillText((TEAM_NAME[rec.team] || "选手") + nickTag + " · 第 " + rec.round + " 轮 · 无效提交", ip + 18, sy + 26);
  }else{
    ctx.fillStyle = inkOf(G, rec.team);
    ctx.font = "700 14.5px " + SHOT_FONT;
    var head = (TEAM_NAME[rec.team] || "选手") + nickTag + " · 第 " + rec.round + " 轮";
    ctx.fillText(head, ip + 18, sy + 26);
  }

  /* 比分（右侧，逐段量宽后右对齐）：只画数字、按本局营地分色，三人四人局就「6 : 6 : 6」 */
  var segs = scoreSegsPx(c, G, 20);
  var tw = 0;
  segs.forEach(function(s){ ctx.font = "800 " + s[1] + "px " + SHOT_FONT; tw += ctx.measureText(s[0]).width; });
  var px = ir - tw;
  segs.forEach(function(s){
    ctx.font = (s[1] >= 20 ? "800 " : "400 ") + s[1] + "px " + SHOT_FONT;
    ctx.fillStyle = s[2];
    ctx.textAlign = "left";
    ctx.fillText(s[0], px, sy + 27);
    px += ctx.measureText(s[0]).width;
  });

  /* 第二行：本手诗句 + 明细 */
  var ly = sy + 56;
  if(!rec){
    ctx.fillStyle = G.muted; ctx.font = "400 14px " + SHOT_FONT;
    ctx.fillText(SIDE + " × " + SIDE + " 共 " + CELLS + " 格，等待" + (seats.length > 2 ? "各方" : "双方") + "飞花。", ip, ly);
  }else if(isEnd){
    var endSegs = [["共 " + total + " 手 · ", G.muted]];
    seats.forEach(function(s, k){
      if(k) endSegs.push([" ／ ", G.muted]);
      endSegs.push([TEAM_NAME[s] + " ", G.muted]);
      endSegs.push([String(scoreOf(c, s)), inkOf(G, s)]);
      endSegs.push([" 格", G.muted]);
    });
    endSegs.push([" ／ 未涂色 ", G.muted], [String(c.n), G.muted], [" 格", G.muted]);
    drawSegs(ctx, endSegs, ip, ly, 13.5, "400");
  }else if(isInvalid){
    /* 被拒的句子：诗句划一道，后面直接写拒绝原因 —— 主持人可以原图发出去 */
    var fi = fitText(ctx, lineOf(rec), sw - 32 - 274, 16, 11, "600");
    ctx.font = "600 " + fi.px + "px " + SHOT_FONT;
    ctx.fillStyle = "#7A8698";
    ctx.fillText(fi.text, ip, ly);
    var iw = ctx.measureText(fi.text).width;
    ctx.fillStyle = G.danger;
    ctx.fillRect(ip, ly - fi.px * 0.34, iw, 1.6);
    ctx.font = "600 12.5px " + SHOT_FONT;
    ctx.fillText("✕ " + rec.note, ip + iw + 10, ly);
  }else if(rec.type === "pass"){
    ctx.fillStyle = G.muted; ctx.font = "600 14px " + SHOT_FONT;
    ctx.fillText("放弃本回合 · 未涂色", ip, ly);
  }else{
    var fits = fitText(ctx, lineOf(rec), sw - 32 - 196, 17, 12, "600");
    drawHitMarks(ctx, rec, fits.text, ip, ly, fits.px, "600", G);      /* 先画标记 */
    ctx.font = "600 " + fits.px + "px " + SHOT_FONT;
    ctx.fillStyle = G.text;
    ctx.fillText(fits.text, ip, ly);
    var pw = ctx.measureText(fits.text).width;
    var pc = inkOf(G, rec.team);
    drawSegs(ctx, [
      ["命中 ", G.muted], [String(rec.hits), G.muted],
      [" · 新占 ", G.muted], [String(rec.blank), pc],
      [" · 抢夺 ", G.muted], [String(rec.capture), pc],
      [" · 己方 ", G.muted], [String(rec.hold), G.muted]
    ], ip + pw + 12, ly, 12.5, "400");
  }

  /* 第三行：规则提示（与静态战报保持同一句）；右侧补本手出处 */
  var hint = "每句须至少用 1 个未填色格；可命中并抢夺对方已涂格。";
  ctx.fillStyle = G.muted; ctx.font = "400 11.5px " + SHOT_FONT;
  ctx.fillText(hint, ip, sy + sh - 14);
  var src = (!isEnd && !isInvalid && rec && rec.type === "fly") ? sourceOf(rec) : "";
  if(src){
    var hintW = ctx.measureText(hint).width;
    var fs = fitText(ctx, src, Math.max(60, ir - ip - hintW - 26), 11.5, 9.5, "400");
    ctx.font = "400 " + fs.px + "px " + SHOT_FONT;
    ctx.fillStyle = "#8A97AA";
    ctx.textAlign = "right";
    ctx.fillText(fs.text, ir, sy + sh - 14);
    ctx.textAlign = "left";
  }
}

function drawGifFrame(ctx, m, snap, i, total, G){
  /* 每帧都重置一次变换：逻辑坐标 → 物理像素，布局比例不变，只是分辨率更高 */
  ctx.setTransform(m.S, 0, 0, m.S, 0, 0);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, m.W, m.H);
  drawGifBoard(ctx, m, snap, G);
  drawGifChrome(ctx, m, snap, i, total, G);
}

/* ---- 中位切分量化 ---- */
function quantizeColors(hist, maxColors){
  var items = [];
  hist.forEach(function(n, k){
    items.push([(k >>> 16) & 255, (k >>> 8) & 255, k & 255, n]);
  });
  if(items.length <= maxColors){
    return items.map(function(it){ return [it[0], it[1], it[2]]; });
  }
  function mkBox(arr){
    var mn = [255, 255, 255], mx = [0, 0, 0], cnt = 0;
    for(var i = 0; i < arr.length; i++){
      var it = arr[i];
      for(var c = 0; c < 3; c++){
        if(it[c] < mn[c]) mn[c] = it[c];
        if(it[c] > mx[c]) mx[c] = it[c];
      }
      cnt += it[3];
    }
    var rg = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    var ch = rg[0] >= rg[1] ? (rg[0] >= rg[2] ? 0 : 2) : (rg[1] >= rg[2] ? 1 : 2);
    return {items: arr, ch: ch, range: rg[ch], cnt: cnt, mn: mn, mx: mx};
  }
  var boxes = [mkBox(items)];
  while(boxes.length < maxColors){
    var bi = -1, best = 0;
    for(var i = 0; i < boxes.length; i++){
      var b = boxes[i];
      if(b.items.length < 2 || b.range <= 0) continue;
      /* 色差跨度 × 出现次数的对数：既照顾画面主体，也照顾少量高对比细节 */
      var score = b.range * Math.log(1 + b.cnt);
      if(score > best){ best = score; bi = i; }
    }
    if(bi < 0) break;
    var box = boxes[bi], ch2 = box.ch;
    box.items.sort(function(p, q){ return p[ch2] - q[ch2]; });
    var half = box.cnt / 2, acc = 0, cut = 1;
    for(var k = 0; k < box.items.length - 1; k++){
      acc += box.items[k][3];
      cut = k + 1;
      if(acc >= half) break;
    }
    var left = box.items.slice(0, cut), right = box.items.slice(cut);
    if(!left.length || !right.length) break;
    boxes.splice(bi, 1, mkBox(left), mkBox(right));
  }
  return boxes.map(function(b){
    var r = 0, g = 0, bl = 0, tot = 0;
    for(var i = 0; i < b.items.length; i++){
      var it = b.items[i], w = it[3];
      r += it[0] * w; g += it[1] * w; bl += it[2] * w; tot += w;
    }
    return [Math.round(r / tot), Math.round(g / tot), Math.round(bl / tot)];
  });
}

function nearestColor(r, g, b, pal){
  var best = 0, bd = Infinity;
  for(var i = 0; i < pal.length; i++){
    var p = pal[i];
    var dr = r - p[0], dg = g - p[1], db = b - p[2];
    var d = dr * dr * 3 + dg * dg * 6 + db * db;   /* 近似人眼权重 */
    if(d < bd){ bd = d; best = i; }
  }
  return best;
}

/* 帧间差分：返回两张图不同的外接矩形；完全相同则返回 null */
function diffRect(a, b, W, H){
  var minX = W, minY = H, maxX = -1, maxY = -1;
  for(var y = 0; y < H; y++){
    var base = y * W * 4;
    for(var x = 0; x < W * 4; x += 4){
      var p = base + x;
      if(a[p] !== b[p] || a[p + 1] !== b[p + 1] || a[p + 2] !== b[p + 2]){
        var px = x >> 2;
        if(px < minX) minX = px;
        if(px > maxX) maxX = px;
        if(y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if(maxX < 0) return null;
  return {x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1};
}

/* 把矩形区域转成调色板索引；与上一帧相同的像素填 0（透明），让 LZW 只压真实变化 */
function mapRegion(data, prev, W, rect, pal, lut, out){
  var q = 0;
  for(var y = 0; y < rect.h; y++){
    var base = ((rect.y + y) * W + rect.x) * 4;
    for(var x = 0; x < rect.w; x++, base += 4){
      var p = base;
      if(prev && data[p] === prev[p] && data[p + 1] === prev[p + 1] && data[p + 2] === prev[p + 2]){
        out[q++] = 0;
        continue;
      }
      var k = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      var v = lut[k];
      if(!v){
        v = nearestColor(data[p], data[p + 1], data[p + 2], pal) + 2;
        lut[k] = v;
      }
      out[q++] = v - 1;
    }
  }
}

/* ---- LZW（GIF 变体：按位打包 + 255 字节子块） ---- */
var LZW_DICT = new Int32Array(1 << 20);   /* key = 前缀码<<8 | 字节；value = 代数<<16 | 码 */
var LZW_GEN = 0;

function lzwEncode(px, sink, minCode){
  var CLEAR = 1 << minCode, EOI = CLEAR + 1;
  var codeSize = minCode + 1, next = EOI + 1;
  LZW_GEN++;
  if(LZW_GEN > 250){ LZW_DICT.fill(0); LZW_GEN = 1; }
  var gen = LZW_GEN;

  var acc = 0, nbits = 0;
  var chunk = new Uint8Array(255), cn = 0;

  function flushChunk(){
    if(!cn) return;
    sink.b(cn);
    sink.need(cn);
    for(var i = 0; i < cn; i++) sink.a[sink.n++] = chunk[i];
    cn = 0;
  }
  function emit(code){
    acc |= code << nbits;
    nbits += codeSize;
    while(nbits >= 8){
      chunk[cn++] = acc & 255;
      if(cn === 255) flushChunk();
      acc >>>= 8;
      nbits -= 8;
    }
  }

  emit(CLEAR);
  var prefix = px[0];
  for(var i = 1; i < px.length; i++){
    var k = px[i];
    var key = (prefix << 8) | k;
    var v = LZW_DICT[key];
    if((v >>> 16) === gen){ prefix = v & 0xFFFF; continue; }
    emit(prefix);
    if(next === 4096){
      emit(CLEAR);
      next = EOI + 1; codeSize = minCode + 1;
      LZW_GEN++;
      if(LZW_GEN > 250){ LZW_DICT.fill(0); LZW_GEN = 1; }
      gen = LZW_GEN;
    }else{
      if(next >= (1 << codeSize)) codeSize++;
      LZW_DICT[key] = (gen << 16) | next;
      next++;
    }
    prefix = k;
  }
  emit(prefix);
  emit(EOI);
  if(nbits > 0){
    chunk[cn++] = acc & 255;
    if(cn === 255) flushChunk();
  }
  flushChunk();
  sink.b(0);                 /* 子块终止符 */
}

/* 全局色表：0 号留白（也是背景色），真实颜色从 1 号开始，0 号同时充当透明索引 */
function gifWriteHeader(sink, m, pal){
  sink.str("GIF89a");
  sink.u16(m.PW); sink.u16(m.PH);
  var total = pal.length + 1;
  var bits = 1;
  while((1 << bits) < total) bits++;
  if(bits > 8) bits = 8;
  sink.b(0x80 | 0x70 | (bits - 1));   /* 有全局色表 / 8 位色深 / 表大小 */
  sink.b(0);                          /* 底色索引 = 0（白） */
  sink.b(0);                          /* 像素宽高比 */
  var size = 1 << bits;
  sink.b(255); sink.b(255); sink.b(255);
  for(var i = 1; i < size; i++){
    var c = pal[i - 1] || [0, 0, 0];
    sink.b(c[0]); sink.b(c[1]); sink.b(c[2]);
  }
  /* Netscape 应用扩展：无限循环 */
  sink.b(0x21); sink.b(0xFF); sink.b(0x0B);
  sink.str("NETSCAPE2.0");
  sink.b(0x03); sink.b(0x01); sink.u16(0); sink.b(0);
  return Math.max(2, bits);
}

/* 单帧头：rect 为图像描述符里的矩形；transparent 为真时启用 0 号透明索引 */
function gifWriteFrameHead(sink, rect, delay, minCode, transparent){
  sink.b(0x21); sink.b(0xF9); sink.b(0x04);
  sink.b(transparent ? 0x05 : 0x04);   /* 处置方式 1（保留）+ 透明标记 */
  sink.u16(delay);                     /* 1/100 秒 */
  sink.b(0);                           /* 透明色索引 */
  sink.b(0);                           /* 图形控制扩展的块终止符 */
  sink.b(0x2C);                        /* 图像描述符 */
  sink.u16(rect.x); sink.u16(rect.y);
  sink.u16(rect.w); sink.u16(rect.h);
  sink.b(0);                           /* 无局部色表 / 非交错 */
  sink.b(minCode);                     /* LZW 最小码长 */
}

function gifFrameDelay(i, n){
  if(i === 0) return 55;     /* 开局空盘稍作停留 */
  if(i === n - 1) return 220;
  return 44;                 /* 约 0.44 秒/手，一局 20 轮 ≈ 20 秒 */
}

var gifJob = null;
var GIF_WIDTH = 1080;      /* 出图像素宽度：1080px（约 1.74× 于 620 逻辑宽），版式比例不变 */
var GIF_COLORS = 96;       /* 调色板色彩数：越少 LZW 压缩比越高，96 色在棋盘上肉眼无差 */

/* 配色一律现读 CSS 变量，保证与页面、与静态截图都不漂移 */
function gifColors(){
  return {
    inkA: cssVar("--ink-a", "#C2352A"),
    inkB: cssVar("--ink-b", "#1F79C4"),
    inkC: cssVar("--ink-c", "#DE9B00"),
    inkD: cssVar("--ink-d", "#18864B"),
    blank: cssVar("--blank", "#EDF1F7"),
    blankText: cssVar("--blank-text", "#33415C"),
    grid: cssVar("--grid", "#9FABBC"),
    text: cssVar("--text", "#1F2937"),
    muted: cssVar("--muted", "#5B6B84"),
    hold: cssVar("--hit-hold", "#6B7688"),
    danger: cssVar("--danger", "#98271D"),
    line: cssVar("--line", "#DCE3EE")
  };
}

function exportGif(){
  if(gifJob){ flashTip("GIF 正在生成中，请稍候…", "warn"); return; }
  var snaps = gifHistory();
  if(snaps.length < 2){
    flashTip("✕ 还没有飞花记录：先开局、至少飞一句，再导出 GIF。", "err");
    return;
  }
  var m = gifMetrics();
  var cv = document.createElement("canvas");
  cv.width = m.PW; cv.height = m.PH;
  var ctx = null;
  try{ ctx = cv.getContext("2d"); }catch(e){ ctx = null; }
  if(!ctx){
    flashTip("✕ 当前环境不支持导出 GIF（无法创建画布）。", "err");
    return;
  }

  shotKind = "gif";
  lastGifBlob = null;
  gifJob = {
    snaps: snaps, m: m, cv: cv, ctx: ctx,
    G: gifColors(),
    hist: new Map(),
    lut: new Uint8Array(1 << 24),
    px: new Uint8Array(m.PW * m.PH),
    prev: null,
    pal: null,
    minCode: 8,
    pending: 0,
    sink: new bytesSink(),
    n: snaps.length,
    moves: snaps.filter(function(s){ return s.rec && s.rec.type !== "end"; }).length,
    i: 0, stage: "hist"
  };
  flashTip("正在生成 GIF… 0 / " + snaps.length + " 帧（帧越多越久，请稍候）", "ok");
  setTimeout(gifTick, 30);
}

function gifProgress(txt){
  flashTip("正在生成 GIF… " + txt, "ok");
}

function gifTick(){
  var j = gifJob;
  if(!j) return;
  try{
    if(j.stage === "hist"){
      drawGifFrame(j.ctx, j.m, j.snaps[j.i], j.i, j.moves, j.G);
      var d = j.ctx.getImageData(0, 0, j.m.PW, j.m.PH).data;
      /* 隔点取样足够覆盖所有颜色，省一半扫码时间 */
      for(var p = 0; p < d.length; p += 8){
        var k = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
        j.hist.set(k, (j.hist.get(k) || 0) + 1);
      }
      j.i++;
      if(j.i < j.n){
        gifProgress("分析配色 " + j.i + " / " + j.n + " 帧");
        setTimeout(gifTick, 0);
        return;
      }
      j.stage = "quant"; j.i = 0;
    }

    if(j.stage === "quant"){
      j.pal = quantizeColors(j.hist, Math.min(254, Math.max(8, GIF_COLORS)));
      j.hist = null;
      j.minCode = gifWriteHeader(j.sink, j.m, j.pal);
      j.stage = "encode"; j.i = 0;
    }

    if(j.stage === "encode"){
      var i = j.i;
      drawGifFrame(j.ctx, j.m, j.snaps[i], i, j.moves, j.G);
      var dd = j.ctx.getImageData(0, 0, j.m.PW, j.m.PH).data;
      /* 首帧整幅上色；之后只写"与上一帧不同"的矩形，矩形内没变的像素置为透明 */
      var rect = i === 0
        ? {x: 0, y: 0, w: j.m.PW, h: j.m.PH}
        : diffRect(j.prev, dd, j.m.PW, j.m.PH);
      if(rect){
        var npx = rect.w * rect.h;
        var buf = j.px.subarray(0, npx);
        mapRegion(dd, i === 0 ? null : j.prev, j.m.PW, rect, j.pal, j.lut, buf);
        var delay = gifFrameDelay(i, j.n) + j.pending;
        j.pending = 0;
        gifWriteFrameHead(j.sink, rect, delay, j.minCode, i > 0);
        lzwEncode(buf, j.sink, j.minCode);
      }else{
        j.pending += gifFrameDelay(i, j.n);   /* 完全没变的帧：把时长并到下一帧 */
      }
      j.prev = dd;
      j.i++;
      if(j.i < j.n){
        gifProgress("编码 " + j.i + " / " + j.n + " 帧");
        setTimeout(gifTick, 0);
        return;
      }
      j.sink.b(0x3B);                       /* 文件结束符 */
      finishGif(j);
      return;
    }
  }catch(e){
    gifJob = null;
    flashTip("✕ 生成 GIF 失败：" + (e && e.message ? e.message : "未知错误"), "err");
  }
}

function finishGif(j){
  var bytes = j.sink.out();
  var blob = new Blob([bytes], {type: "image/gif"});
  lastGifBlob = blob;
  var name = "飞花斯普拉遁-回放-" + stamp() + ".gif";
  var kb = Math.max(1, Math.round(bytes.length / 1024));
  openShotPreview(URL.createObjectURL(blob), true, name,
    kb + " KB ｜ " + j.m.PW + " × " + j.m.PH + " px ｜ " + j.n + " 帧 ｜ " +
    j.pal.length + " 色 ｜ 约 " + Math.round((55 + (j.n - 2) * 44 + 220) / 100) + " 秒一轮",
    "动图已生成，由于网页无法正常复制 GIF，请下载后分享。");
  gifJob = null;
  flashTip("✓ 已生成逐手回放动图（" + j.n + " 帧 · " + kb + " KB）", "ok");
}

/* ---- 对外入口：由 app.js 绑定到按钮；每次调用先同步一次状态 ---- */
window.OLEXport = {
  shot: function () {
    if (!syncVM()) return flashTip('还没进入对局，无法导出。', 'err');
    exportShot();
  },
  gif: function () {
    if (!syncVM()) return flashTip('还没进入对局，无法导出。', 'err');
    exportGif();
  },
  canvas: function () {
    syncVM();
    return buildShotCanvas();
  },
  save: function () { downloadShot(); },
  zoom: function () { shotZoom = !shotZoom; applyShotZoom(); },
  close: function () { closeShot(); }
};

/* 仅供自动化测试（tools/test_export_multi.js）：把几块纯绘制的内部函数露出来，
   这样可以直接对「某一手 / 某一帧」断言颜色与列数，不用真的生成 GIF 二进制。
   不参与任何界面逻辑，也不给页面用。 */
window.OLEXport.__draw = {
  seats: activeSeats,
  ink: inkOf,
  metrics: shotMetrics,
  colors: function () {
    return { inkA: cssVar('--ink-a', '#C2352A'), inkB: cssVar('--ink-b', '#1F79C4'),
             inkC: cssVar('--ink-c', '#DE9B00'), inkD: cssVar('--ink-d', '#18864B'),
             muted: cssVar('--muted', '#5B6B84') };
  },
  gifCounts: gifCounts,
  gifHistory: gifHistory,
  gifFrame: drawGifFrame,
  gifColors: gifColors,
  gifMetrics: gifMetrics
};

var chk = $('chkShotNicks');
if (chk) {
  chk.addEventListener('change', function () {
    var ov = $('shotOverlay');
    if (!ov || !ov.classList.contains('show')) return;
    if (shotKind === 'gif') {
      window.OLEXport.gif();
    } else {
      window.OLEXport.shot();
    }
  });
}

})();
