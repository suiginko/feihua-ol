'use strict';
/* 飞花斯普拉遁 · 在线对战服务端
 *
 * 零依赖：node server.js 即可跑。
 * 服务端是唯一真相 —— 棋盘、轮次、判定、涂色全部在这里算；
 * 客户端只允许发「诗句原文」，并且只能看到服务器推给它的状态。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const judgeMod = require('./judge');
const recordFix = require('./recordfix');
const { POOL, EXTRA, EXTRA_WT } = require('./data/chars');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC = path.join(__dirname, 'public');
const TURN_SECONDS_DEFAULT = 120;     /* 每步时间默认 120 秒，建房时可改（15–600） */
const ROOM_TTL = 2 * 3600 * 1000;
const REQ_TTL = 60 * 1000;            /* 撤销 / 提前结算 的请求等待对方同意的时限 */
const UNDO_MAX = 60;                  /* 撤销快照最多留这么多手 */
const EVENT_MAX = 400;                /* 房间事件流水上限（超出丢最早的） */
/* 掉线清理的等待时间：手机切后台会短暂断开 SSE，太短会把人误踢。
   观众等 2 分钟、选手等 5 分钟；在场的人也可以对更早掉线的人手动「移出」。 */
const WATCH_AWAY_MS = Number(process.env.WATCH_AWAY_MS || 120 * 1000);  /* 观众掉线多久后从房间移除 */
const SEAT_AWAY_MS = Number(process.env.SEAT_AWAY_MS || 300 * 1000);    /* 选手掉线多久后自动下场（席位空出，别人可补位） */
const SWEEP_MS = Number(process.env.SWEEP_MS || 10 * 1000);             /* 掉线清扫周期 */
/* ---------- 「人到底还在不在」 ----------
   只靠 SSE 的 close 事件判断在线是不准的：手机切网、休眠、进程被杀时连接会变成
   半开（socket 还在，对端早没了），close 迟迟不来，于是席位和观众记录永远挂着 ——
   人会「离开房间后还看到自己在房间里」，空房间也永远不消失。
   所以让客户端每 20 秒发一次心跳（POST /beat），服务端以「最近一次心跳」为准：
     · 有心跳的客户端：超过 ALIVE_MS 没心跳就当人已走（哪怕 socket 还在）；
     · 没心跳的客户端（发版前打开的旧页面）：退回老规则「连接还在就算在」，
       再加 JOIN_GRACE_MS 宽限，免得刚 join 完、SSE 还没连上就被判死。 */
const ALIVE_MS = Number(process.env.ALIVE_MS || 75 * 1000);   /* 容忍后台标签页被节流到 1 分钟一次 */
const JOIN_GRACE_MS = 20 * 1000;      /* 刚 join / 接管、页面还没连上 SSE 的宽限 */
const VACANT_MS = Number(process.env.VACANT_MS || 5 * 60 * 1000);   /* 开局后空出来的席位给原主留多久 */
/* 「刚刚离开」的席位还能用原 token 接回来多久。
   页面卸载（刷新 / 后退 / 关页面）时客户端会替玩家发一次安静的离开，随后重新加载时
   拿着同一个 token 来问 —— 这段时间内就把他原样放回原位，刷新因此等于没发生。 */
const RECALL_MS = Number(process.env.RECALL_MS || 30 * 1000);

/* ---------- 语料加载：挪到 listen 之后 ----------
 * 语料 26M 字，加载峰值约 515MB / 本地 2.4 秒（2026-10-24 实测，`JUDGE_LOAD_TRACE=1` 可复现：
 * after-poems 224MB → after-clauses-read 422MB → after-pb 515MB）。
 * 原来这一行在**模块顶层**同步跑完才去 listen，于是「冷容器 + 大语料」必然踩这条线：
 * 端口迟迟不监听，网关 30 秒后先回 504，部署工具 60 秒判定 SITES_START_FAILED。
 * 2026-10-24 14:58 那两次发布都栽在这里（`app stderr: Killed`，stdout 一行日志都没有）。
 *
 * 现在改成「先监听、后加载」：
 *   ① listen 回调里用 setImmediate 预热，端口一两秒内就绪；
 *   ② 加载完成前任何需要判诗的请求会自动等它 —— judge 内部的 `if (!pb) load()` 是同步的，
 *      单线程下不会被并发打断，所以正确性完全不变；
 *   ③ 换来的是「最多第一个请求慢一点」而不是「整站 504」。
 * 注意 `stats` 因此可能是 null：/api/stats 与启动记录都要按 null 处理。 */
let stats = null;
function warmJudge() {
  if (stats) return stats;
  try {
    stats = judgeMod.load();
    console.log(`[judge] ${stats.lines} 句 / ${stats.poems} 篇 / ${(stats.chars / 1048576).toFixed(1)} MB，加载 ${stats.ms} ms`);
    console.log(`[judge] 可作默认昵称的作者 ${judgeMod.authorCount()} 位`);
  } catch (e) {
    /* 语料坏了不要连带整站下线：判诗会一直报错，但大厅、存档、审阅都还能用 */
    try { logCrash('judge-load', e); } catch (_) {}
    console.error('[judge] 语料加载失败：' + (e && e.message));
  }
  return stats;
}

/* ---------- 内存观测 ----------
 * 2026-10-23 整站 504 的根因：语料从 19M 字扩到 27.6M 字之后，常驻堆够用，
 * 但 V8 默认的堆上限太大、不肯及时回收，rss 会一路漂到 1048MB —— 容器（约 1GB）直接 OOM，
 * 进程死得连 crash.log 都没有，平台反复重启又反复被杀，网关就一直 504。
 * 这里做三件事：
 *   ① 记峰值，让「漂到多少才危险」看得见（/api/stats 的 rssPeak）；
 *   ② 把 V8 的堆上限写进启动记录，用来证明 `--max-old-space-size` 到底有没有生效；
 *   ③ 超过软阈值就落一条 crash.log，哪怕最后没被 OOM 也留下证据。 */
const v8mod = require('v8');
const heapLimitBytes = v8mod.getHeapStatistics().heap_size_limit;
let rssPeakMB = 0;
function maxOldSpaceArg() {
  for (const a of process.execArgv || []) {
    const m = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(String(a));
    if (m) return Number(m[1]);
  }
  return 0;
}
const MEM_WARN_MB = Number(process.env.MEM_WARN_MB || 850);
/* 每 60 秒往 data/mem.log 记一行内存。
   为什么值得单独一个文件：OOM 死法（内核 SIGKILL / V8 abort）**不会走 uncaughtException**，
   crash.log 里一片空白 —— 10-23 那次只能靠几条碰巧的 SSE 错误反推 rss 到过 1048MB。
   有了这条时间线，「死之前涨到多少、涨了多久」是现成的。保留最近 120 行，不长大。 */
const MEM_KEEP = 120;
function sampleMem() {
  /* 注意：DATA_DIR 在这一段下面才定义（模块初始化顺序），所以这里取路径，不要提到外面去 */
  const memFile = path.join(DATA_DIR, 'mem.log');
  const m = process.memoryUsage();
  const mb = Math.round(m.rss / 1048576);
  if (mb > rssPeakMB) rssPeakMB = mb;
  const rec = {
    at: Date.now(), rss: mb, heapUsed: Math.round(m.heapUsed / 1048576),
    heapTotal: Math.round(m.heapTotal / 1048576), rooms: rooms.size,
    uptime: Math.round(process.uptime()),
  };
  try {
    fs.appendFileSync(memFile, JSON.stringify(rec) + '\n');
    const st = fs.statSync(memFile);
    if (st.size > 40 * 1024) {
      const lines = fs.readFileSync(memFile, 'utf8').split('\n').filter(Boolean).slice(-MEM_KEEP);
      fs.writeFileSync(memFile, lines.join('\n') + '\n');
    }
  } catch (_) { /* 写不进去就算了，别为了观测把服务弄挂 */ }
}
if (process.env.MEM_LOG !== '0') {
  setInterval(sampleMem, Number(process.env.MEM_SAMPLE_MS || 60 * 1000)).unref();
}
if (MEM_WARN_MB > 0) {
  let warned = false;
  setInterval(() => {
    const mb = Math.round(process.memoryUsage().rss / 1048576);
    if (mb > rssPeakMB) rssPeakMB = mb;
    if (!warned && mb >= MEM_WARN_MB) {
      warned = true;
      try {
        logCrash('mem', new Error('rss 达到 ' + mb + 'MB（阈值 ' + MEM_WARN_MB + 'MB，堆上限 ' +
          Math.round(heapLimitBytes / 1048576) + 'MB）'));
      } catch (_) {}
    }
  }, 10000).unref();
}

/* ================= 存档 / 反馈（落到 data/ 下的 JSONL，供开发者审阅） =================
   沙箱里没有数据库，只有磁盘：追加写一行一条，读的时候按「最新在前」取最近若干条。
   注意：文件活在容器里，发布新版本重建沙箱会一起没掉 —— 需要长期留存就先在审阅页导出。
   DATA_DIR 可以用环境变量指到别处：自测时用临时目录，别把测试数据写进线上那一份。 */
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
/* 目录不在就先建出来：DATA_DIR 指到一个还不存在的临时目录时，启动记录会静默写失败。 */
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* 没权限就让后面的写各自报错 */ }
const RECORDS_FILE = path.join(DATA_DIR, 'records.jsonl');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.jsonl');
const BOOT_FILE = path.join(DATA_DIR, 'boot.log');   /* 每次启动追加一行，用来判断「发布后磁盘是否还在」 */
/* 崩溃记录：2026-10-22 早上线上 504 三个小时，`boot.log` 里一条新记录都没有 ——
   说明「进程死了但没人重启」。当时只有 console.error，容器日志拿不到，等于什么都没留下。
   现在把未捕获异常 / 未处理拒绝的栈写进这个文件，审阅页的 /api/boot 能直接看到。 */
const CRASH_FILE = path.join(DATA_DIR, 'crash.log');
const CRASH_MAX_BYTES = 256 * 1024;
const RECORD_MAX_BYTES = 8 * 1024 * 1024;   /* 超过就滚动一份 records.1.jsonl，只留一档 */
const RECORD_LIST_MAX = 300;                /* 审阅页一次最多列这么多局 */

/* 公告栏：一个存在磁盘上的小 JSON，审阅页改它、大厅读它。
   存在的理由就是「改一句话不该重新发布一次应用」——所以它必须在运行期可改，
   而不是写在前端模板里。改了立即对所有人生效（前端每 30 秒拉一次）。
   注意它跟 feedback.jsonl 一样活在容器磁盘上，重建沙箱会回到「没有公告」。 */
const NOTICE_FILE = path.join(DATA_DIR, 'notice.json');
const NOTICE_MAX = 300;                     /* 公告正文上限，够写三四行了 */

/* ---------- 自定义昵称：每人 24 小时只能改一次 ----------
 * 只管「自定义」名字。抽一位诗人当昵称（骰子 / 随机按钮）不受限，因为它不承担
 * 「这个人想让自己叫什么」的表达，被刷也只是换了个古人的名字。
 * 判据是前端的持久 uid（localStorage）—— 这是「每个用户」唯一能落地的东西：
 * token / mid 都是按房间发的，换个房间就换一个，没法跨房间计数。
 * 拿不到 uid 的旧页面退回用 IP，宁可让老页面也受限，也不能让限制形同虚设。 */
const NICK_FILE = path.join(DATA_DIR, 'nicklimit.json');
const NICK_GAP_MS = Number(process.env.NICK_GAP_MS || 24 * 60 * 60 * 1000);
/* 盘上记录的生命周期：至少保留 30 天（或 30 倍冷却），
   即便 24 小时冷却已过，也认得他上一次的名字，避免每天进房都误当成「新改名」反复打扰 */
const NICK_RECORD_TTL_MS = Math.max(NICK_GAP_MS * 30, 30 * 24 * 60 * 60 * 1000);
/* key 只允许这几种字符：文件名是本地文件，键是前端给的，别让 '__proto__' 之类的东西进来。
   用的是无原型对象，这里算是第二道门。 */
const NICK_KEY_RE = /^[A-Za-z0-9_.:-]{6,80}$/;

/* ---------- 发布保护：把房间落盘，重启后接着打 ----------
 * 发布新版本 = 覆盖沙箱代码 + 容器重启，房间只在内存里，所以每次发布都在杀掉所有人的对局。
 * 这里做三件事：
 *   ① 状态变化后最多 SNAP_MS 毫秒写一份完整快照（写临时文件 + 原子改名）；
 *   ② 收到 SIGTERM / SIGINT（平台停容器时发的信号）立刻**同步**再落一次盘；
 *   ③ 启动时如果快照还新鲜，就把房间原样接回来（deadline 按墙钟重算）。
 *
 * 唯一的关键未知：容器重启后磁盘还在不在（见 boot.log 那套实验）。
 * 所以这套机制刻意做成「两边都不会更糟」：
 *   磁盘保住了 → 对局真的活下来；
 *   磁盘被换了 → 读不到快照，什么都不恢复，和没有这套机制一模一样。
 * 另外 SNAP_MAX_AGE_MS 是安全阀：随代码包上传的旧快照年龄一定超限，不会被误恢复。 */
const SNAP_FILE = path.join(DATA_DIR, 'rooms.snap.json');
const SNAP_TMP = SNAP_FILE + '.tmp';
const SNAP_BAK_FILE = SNAP_FILE + '.bak';
const SNAP_SCHEMA = 2;                                              /* 字段结构变了就 +1，旧快照直接丢 */
const SNAP_MS = Number(process.env.SNAP_MS || 1500);                /* 有脏数据时最多这么久落一次盘 */
/* 快照超过这个年龄不恢复。2026-10-24 从 15 分钟放宽到 6 小时。
 * 起因：平台会优雅停容器（SIGTERM）且不一定自己拉起，恢复只能靠外部——
 * 要么人发现、要么本机那个保活定时任务重新发布。2026-10-24 03:03 那次停了之后，
 * 一直没人管到 13:24（本机在休眠，保活任务根本没跑），空窗 10h21m；
 * 15 分钟的窗口意味着「只要恢复得晚一点，停机那一刻在打的对局必然全丢」
 * （那次 3 间房 restored=0）。放宽后真正的约束变成 ROOM_TTL，而且那 2 小时
 * 改按「真在跑的时间」算 —— 见 restoreSnapshot 里的 createdAt 平移。 */
const SNAP_MAX_AGE_MS = Number(process.env.SNAP_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const RESTORE_GRACE_MS = Number(process.env.RESTORE_GRACE_MS || 90 * 1000);     /* 恢复后留给玩家重连的时间 */
/* 窗口只有 15 分钟时，「发布前删掉本地快照」这一条纪律就够用了：旧文件年龄必然超限，
   根本进不了恢复流程。放宽到 6 小时之后这条兜不住了 —— 本地漏删的 data/rooms.snap.json
   会被随代码包传上线，然后在容器启动时被当成线上房间恢复（凭空多出几间幽灵房）。
   所以快照里记一个环境指纹：本地是 C:\Users\...，线上是 /workspace，一比就挡住。 */
const SNAP_ENV = __dirname;

/* 启动记录：只为一件事——回答「发布新版本时，容器是新的还是原来那台、磁盘还在不在」。
 * 每次启动往 data/boot.log 追加一行，记下「启动前这个文件里已经有几行」和「本机 hostname」：
 *   prevLines > 0  → 上一次启动写的内容还在，磁盘是延续的；
 *   prevLines = 0  → 文件是这一轮新生成的，磁盘被换掉了。
 * 配合 host 字段（容器换了 hostname 一般也会变）就能区分「进程重启」「同机持久卷」「全新容器」。 */
function logBoot(extra) {
  let prevLines = 0;
  try {
    const txt = fs.readFileSync(BOOT_FILE, 'utf8');
    prevLines = txt.split('\n').filter(Boolean).length;
  } catch (_) { /* 第一次启动，文件还不存在 */ }
  const rec = {
    at: Date.now(),
    prevLines,
    pid: process.pid,
    host: (() => { try { return os.hostname(); } catch (_) { return ''; } })(),
    node: process.version,
    dir: __dirname,
    ...extra,
  };
  try {
    fs.appendFileSync(BOOT_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    console.error('[boot] 启动记录写不进去：' + e.message);
    return;
  }
  if (prevLines > 0) {
    console.log('[boot] 上次启动的记录还在（' + prevLines + ' 条）—— 磁盘在重启后保留得住');
  } else {
    console.log('[boot] data/boot.log 是新建的 —— 这一轮拿到的是干净磁盘');
  }
}

/* 审阅口令：优先取环境变量，其次读项目根的 admin.key（随代码一起发布，
   这样本地和线上是同一个口令，开发者随时能查）。都没有就随机生成一份落盘。 */
function loadAdminKey() {
  if (process.env.ADMIN_KEY) return String(process.env.ADMIN_KEY).trim();
  const f = path.join(__dirname, 'admin.key');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s) return s;
  } catch (_) { /* 没有就造一个 */ }
  const k = crypto.randomBytes(12).toString('hex');
  try { fs.writeFileSync(f, k + '\n'); } catch (_) {}
  return k;
}
const ADMIN_KEY = loadAdminKey();

/* ---------- 开发者模式 ----------
   口令就是 admin.key（同一个，不另设），入口形如 `?dev=<key>`：
   - 以「隐形观众」进房：不占席位、不进成员列表、不算观众数、不写进出事件，
     所以对局里其他人看不到你来过；也不会让一个空房间因为你挂着而不散。
   - 大厅里能看到私密房间（否则那些房号你自己也找不到）。
   不做的事：隐形观众不能当裁判/掌流程（那会改动别人的局），想真的打就开不带 dev 的链接。 */
function isDev(u) {
  const d = u && u.searchParams ? u.searchParams.get('dev') : '';
  return !!d && d === ADMIN_KEY;
}

function rotateIfBig(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size > (maxBytes || RECORD_MAX_BYTES)) fs.renameSync(file, file.replace(/(\.\w+)$/, '.1$1'));
  } catch (_) { /* 文件还不存在，无需滚动 */ }
}

function appendJSONL(file, obj) {
  rotateIfBig(file);
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJSONL(file, limit) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const lines = txt.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const ln = lines[i];
    if (!ln) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* 半行 / 坏行直接跳过 */ }
  }
  return out;
}

/* 每条反馈一个自己的编号，取件方靠它去重。
   用「毫秒时间戳(base36) + 4 位随机」而不是自增序号：文件滚动、容器重建之后
   序号会从头来，拿序号去重会把新反馈当成旧的扔掉。 */
function newFid() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

/* 增量读反馈：从最新往回扫，扫到 since 那一条就停（它更早的都已经取过了）。
   since 传空 → 最近 limit 条。
   找不到 since（文件滚动掉了、或者容器重建后文件被清空、或者是从没取过件）
   就返回手上全部的，让取件方自己按 fid 去重 —— 宁可重复也不漏。 */
function readFeedbackSince(since, limit) {
  let txt = '';
  try { txt = fs.readFileSync(FEEDBACK_FILE, 'utf8'); } catch (_) {
    return { list: [], ahead: 0, foundSince: !since };
  }
  const lines = txt.split('\n');
  const list = [];
  let ahead = 0;
  let foundSince = !since;
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    let rec;
    try { rec = JSON.parse(ln); } catch (_) { continue; }   /* 半行 / 坏行跳过 */
    if (since && rec.fid === since) { foundSince = true; break; }
    ahead++;
    if (list.length < limit) list.push(rec);
  }
  return { list, ahead, foundSince };
}

/* ---------- 公告栏 ----------
 * 一个存在磁盘上的小 JSON：审阅页写它，大厅读它。
 * 存在的理由就一句话 —— 改一句话不该重新发布一次应用。
 *
 * 两个读取口径都是「宁可当没有」：文件不在、JSON 坏了、正文是空的，
 * 一律返回 null（前端就不显示那一条）。公告出问题绝不能连累大厅打不开。 */
function readNotice() {
  let txt = '';
  try { txt = fs.readFileSync(NOTICE_FILE, 'utf8'); } catch (_) { return null; }
  let o = null;
  try { o = JSON.parse(txt); } catch (_) { return null; }
  const text = String((o && o.text) || '').replace(/\s+$/g, '');
  if (!text) return null;
  return {
    text: text.slice(0, NOTICE_MAX),
    kind: o.kind === 'warn' ? 'warn' : 'info',
    at: Number(o.at) || 0,
  };
}

/* 先写 .tmp 再改名：写到一半被杀也不会留下半截 JSON。
   公告是给人看的、丢了不致命，但「改成乱码」最容易被当成 bug 报上来。 */
function writeNotice(text, kind) {
  const o = { text, kind, at: Date.now() };
  const tmp = NOTICE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o) + '\n');
  fs.renameSync(tmp, NOTICE_FILE);
  return o;
}

/* ---------- 自定义昵称的 24 小时冷却 ----------
 * 存 data/nicklimit.json：{ "u:xxxx": { at, nick } }。只留冷却期内的记录 ——
 * 一个两年不上的用户不该拖着一个越来越大的文件，过期即忘。
 * 读坏了/没权限一律当作「没人改过」：宁可少限一次，也不能让改名功能整个不可用。 */
let nickLog = null;

function nickLogOf() {
  if (nickLog) return nickLog;
  const out = Object.create(null);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(NICK_FILE, 'utf8')); } catch (_) { raw = null; }
  const now = Date.now();
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(raw)) {
      if (!NICK_KEY_RE.test(k)) continue;
      const v = raw[k];
      if (!v || typeof v.at !== 'number' || !Number.isFinite(v.at)) continue;
      if (now - v.at >= NICK_RECORD_TTL_MS) continue;
      out[k] = { at: v.at, nick: String(v.nick || '').slice(0, 12) };
    }
  }
  nickLog = out;
  return out;
}

/* 写盘失败只是丢了「下次不能再改」的记账，不影响这一次改名 —— 所以不抛。
   有了上次 feedback 被 /tmp 顶掉的教训，这里同样先写 .tmp 再改名。 */
function saveNickLog() {
  try {
    const tmp = NICK_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(nickLogOf()) + '\n');
    fs.renameSync(tmp, NICK_FILE);
  } catch (e) { console.log('[nick] 落盘失败：' + e.message); }
}

/* 请求 → 这个人是谁。uid 是前端的持久身份；没有就退回 IP。
   IP 只当兜底：同一个 WiFi 下一家人共用一个出口 IP，把 IP 当主键会让一个人改名
   把另外几个人一起锁住 —— 那是最容易招骂的误伤。 */
function nickKeyOf(req, uid) {
  const u = String(uid || '').trim();
  if (/^[A-Za-z0-9_-]{16,64}$/.test(u)) return 'u:' + u;
  const ip = clientIP(req);
  return ip ? 'ip:' + ip : '';
}

/* 还能不能改？返回剩余时间，前端拿它显示「x 小时 y 分后可以再改」。 */
function nickQuota(key) {
  if (!key) return { ok: true, retryAt: 0, waitMs: 0, lastNick: '' };
  const rec = nickLogOf()[key];
  if (!rec) return { ok: true, retryAt: 0, waitMs: 0, lastNick: '' };
  const left = rec.at + NICK_GAP_MS - Date.now();
  if (left <= 0) return { ok: true, retryAt: 0, waitMs: 0, lastNick: rec.nick || '', lastAt: rec.at };
  return { ok: false, retryAt: rec.at + NICK_GAP_MS, waitMs: left, lastNick: rec.nick || '', lastAt: rec.at };
}

function recordNick(key, nick) {
  if (!key) return;
  nickLogOf()[key] = { at: Date.now(), nick: String(nick || '').slice(0, 12) };
  saveNickLog();
}

/* 大厅那条路（建房 / 加入）也要认同一套额度 —— 玩家在大厅的输入框里改个名再进房，
   和进房之后点「改名」是同一件事，不能只有后者受限制。
 *
 * 为什么这里只在「有 uid」时才算账：没有 uid 就认不出是不是同一个人，只能退回 IP，
 * 而 IP 记账在进房这一步的误伤面太大 —— 一家人、一间网吧、一个公司出口，一个人改名
 * 会把其余人一起锁 24 小时。房间里改名仍保留 IP 兜底（人数少、出口杂），进房这一步
 * 则宁可漏一例也不误伤一屋人。没有 uid 的老页面在这里不受限，这是有意的降级。
 *
 * 返回 key 非空 = 这次真的会消耗额度，调用方**成功之后**再 recordNick。 */
function nickGate(req, uid, nick) {
  const name = String(nick || '').trim().slice(0, 12);
  if (!name) return { ok: true, key: '' };                       /* 留空 = 服务端随机补诗人名 */
  if (judgeMod.isAuthor(name)) return { ok: true, key: '' };      /* 诗人名不占额度 */
  const u = String(uid || '').trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(u)) return { ok: true, key: '' };
  const key = 'u:' + u;
  const q = nickQuota(key);
  if (q.lastNick && q.lastNick === name) return { ok: true, key: '' };   /* 没变，不重复记账 */
  if (!q.ok) {
    return {
      ok: false, code: 'cooldown', retryAt: q.retryAt, waitMs: q.waitMs, lastNick: q.lastNick || '',
      reason: '自定义昵称 24 小时只能改一次。你上次在 ' + fmtClock(q.lastAt) + ' 改成了「' +
        (q.lastNick || '别的名字') + '」，还要等 ' + fmtWait(q.waitMs) + '才能再改。' +
        '想现在就换，可以用「换一位诗人」抽个诗人名（不占额度）。',
    };
  }
  return { ok: true, key };
}

/* 「还要等 23 小时 12 分」—— 说人话，别丢一个毫秒数给玩家 */
function fmtWait(ms) {
  const m = Math.max(1, Math.ceil(ms / 60000));
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? h + ' 小时 ' + mm + ' 分' : h + ' 小时';
}

function fmtClock(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 席位 → { nick, mid }，四个营地一个不落。
   老版本这里只写了 A/B，金营翠营的昵称在**落盘那一刻**就没了 —— 审阅页再怎么改也补不回来，
   所以存档结构必须一次写全。 */
function seatMap(room) {
  const out = {};
  for (const s of ALL_SEATS) {
    const m = room.seats[s];
    out[s] = m ? { nick: m.nick, mid: m.mid } : null;
  }
  return out;
}

/* 一局打完就存档：配置、双方、比分、每一手、事件流水全留下。
   只看「结束」这一刻的结果，不参与任何对局逻辑，写失败也不影响玩家。 */
function archiveGame(room) {
  if (room.archived) return;
  room.archived = true;
  try {
    const c = counts(room);
    appendJSONL(RECORDS_FILE, {
      id: room.id,
      at: Date.now(),
      createdAt: room.createdAt,
      startedAt: room.startedAt || room.createdAt,
      finishedAt: room.finishedAt || Date.now(),
      reason: room.reason || '',
      cfg: room.cfg,
      players: seatMap(room),
      score: c,
      turns: room.log.filter((e) => e.type === 'fly').length,
      log: room.log,
      events: room.events,
    });
  } catch (e) {
    console.error('[records] 存档失败：' + e.message);
  }
}

/* 反馈落盘（带一点防滥用：同 IP 30 秒一条，正文限 1000 字） */
const FEEDBACK_GAP_MS = Number(process.env.FEEDBACK_GAP_MS !== undefined ? process.env.FEEDBACK_GAP_MS : 30 * 1000);
const feedbackLast = new Map();          /* ip -> 上次提交时间 */
function clientIP(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '';
}

/* ================= 工具 ================= */
const MAX_ROOMS = 1000;               /* 房间号只有 000–999 这一千个，满了就不再建房 */

/* 房号：000–999 顺序分配，取第一个没被占用的。
   以前是随机取 100–999，导致大厅里房号跳来跳去、也读不出「现在开了多少间」；
   顺序发号之后，新房永远落在最小的空号上，现场念「三号房」也更顺口。 */
function roomCode() {
  for (let i = 0; i < MAX_ROOMS; i++) {
    const id = String(i).padStart(3, '0');
    if (!rooms.has(id)) return id;
  }
  return null;                        /* 一千间全占满 */
}

/* 私密房号：5 位数字与大写字母组合（32 个字符，排除易混淆字符 0O1I） */
const PRIV_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function privateRoomCode() {
  for (let tries = 0; tries < 2000; tries++) {
    let id = '';
    const bytes = crypto.randomBytes(5);
    for (let i = 0; i < 5; i++) {
      id += PRIV_CHARS[bytes[i] % PRIV_CHARS.length];
    }
    if (!rooms.has(id)) return id;
  }
  return null;
}
function token() { return crypto.randomBytes(16).toString('hex'); }
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
/* 按权重不放回抽 k 个低频字。skip 里的字已经在盘上了，不能再抽一次 ——
   自定义字库可能用掉一部分 EXTRA，剩下的名额要留给没上盘的字。 */
function pickExtras(k, skip) {
  const idx = [];
  for (let i = 0; i < EXTRA.length; i++) {
    if (skip && skip.has(EXTRA[i])) continue;
    idx.push(i);
  }
  const out = [];
  for (let n = 0; n < k && idx.length; n++) {
    let total = 0;
    for (const i of idx) total += EXTRA_WT[i];
    let r = Math.random() * total;
    let pick = idx[idx.length - 1];
    for (const i of idx) {
      r -= EXTRA_WT[i];
      if (r < 0) { pick = i; break; }
    }
    out.push(EXTRA[pick]);
    idx.splice(idx.indexOf(pick), 1);
  }
  return out;
}
const SUGGEST = {
  5: 8, 6: 10, 7: 12, 8: 15, 9: 17, 10: 20, 11: 23, 12: 26, 13: 29, 14: 33,
  15: 37, 16: 41, 17: 45, 18: 49, 19: 53, 20: 57
};
const KINDS = ['诗', '词', '曲', '赋', '文'];
const ALL_SEATS = ['A', 'B', 'C', 'D'];
const SEAT_NAMES = { A: '赤营', B: '青营', C: '金营', D: '翠营' };
function seatName(seat) { return SEAT_NAMES[seat] || '营地'; }
function requiredSeats(room) {
  const pCnt = Math.max(1, Math.min(4, Number(room && room.cfg && room.cfg.playerCount) || 2));
  return ALL_SEATS.slice(0, pCnt);
}

/* ================= 房间 ================= */
const rooms = new Map();

/* ---------- 崩溃取证 ----------
   为什么值得单独一个文件：线上那台容器没有自动重启，进程一死就是整站 504，
   而 console 输出我们拿不到。写盘之后，下一次出问题可以在审阅页 /api/boot 的
   crashes 里直接看到「什么时候、什么错、当时内存多大、几个房间」。 */
function logCrash(kind, e) {
  const err = e && e.__err ? e.__err : e;   /* unhandledRejection 传进来的可能是任意值 */
  const rec = {
    at: Date.now(),
    kind,
    msg: String((err && err.message) || err || '').slice(0, 500),
    stack: String((err && err.stack) || '').slice(0, 4000),
    rooms: rooms.size,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  try { rotateIfBig(CRASH_FILE, CRASH_MAX_BYTES); } catch (_) {}
  try { fs.appendFileSync(CRASH_FILE, JSON.stringify(rec) + '\n'); } catch (_) {}
  return rec;
}

function readCrashes(limit) {
  try {
    const txt = fs.readFileSync(CRASH_FILE, 'utf8');
    return txt.split('\n').filter(Boolean).slice(-(limit || 5)).map((ln) => {
      try { return JSON.parse(ln); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}


/* 成员：一个 token 在房间里只有一个身份（选手 A/B 或观众）。
   mid 是这个人的稳定标识 —— 下场、补位、换席位都不变，用于成员列表与「移出」定位。
   mid 与 token 无关：对外只暴露 mid，不泄露 token。 */
function newMember(nick, t) {
  const now = Date.now();
  return {
    nick: String(nick || '').slice(0, 12) || '无名',
    token: t,
    mid: 'm' + crypto.randomBytes(3).toString('hex'),
    online: false,
    offlineAt: 0,      /* 掉线时刻（online=false 时有效），供清扫用 */
    at: now,           /* 进房间的时刻 */
    everOnline: false, /* 是否真的连上过（只建了身份、页面却没打开的人不该永久算在线） */
    beatAt: now,       /* 最后一次心跳（或最后一次带 token 的请求） */
    beatSeen: false,   /* 是否真的收到过心跳：旧页面没有心跳，不能按心跳判死 */
    restoredAt: 0,     /* 从磁盘快照恢复的时刻：RESTORE_GRACE_MS 内算他在线 */
  };
}

/* 「这个人现在还在不在」—— 全服务端只认这一个判据。
   席位接管、幽灵清理、大厅的在线标记、成员列表的小圆点，全走它，避免各处口径不一。
   grace 是「刚 join、页面还没连上 SSE」的宽限：席位需要（同名不能被顶掉），
   观众不需要（同名观众就该合并成一条，否则列表里会堆出一串自己）。 */
function aliveMember(room, rec, t, grace) {
  if (!rec) return false;
  /* 刚从快照恢复、玩家还没来得及重连上来的那段时间，算他在。
     否则新进程启动后的第一轮清扫就会把「只有快照、没有连接」的房间当空房收掉，
     落盘恢复白做。RESTORE_GRACE_MS 一过立刻回到正常判据，一点都不放松。 */
  if (rec.restoredAt && Date.now() - rec.restoredAt < RESTORE_GRACE_MS) return true;
  if (!rec.online) return false;
  if (rec.beatSeen) return Date.now() - (rec.beatAt || 0) <= ALIVE_MS;
  /* 没有心跳的旧客户端：连接还在就算在 */
  if (linkAlive(room.id, t || rec.token)) return true;
  return Date.now() - (rec.at || 0) <= (grace === undefined ? JOIN_GRACE_MS : grace);
}

/* 心跳 / 任何带 token 的请求都算「人还在」的证据。
   prove=true 只有 /beat 会传：只有客户端**主动**报心跳，才允许按心跳判生死。
   别的请求可能来自发版前打开的旧页面（它永远不会发心跳），不能让它们把 beatSeen 打开 ——
   否则旧页面会在 75 秒后被当成幽灵踢掉。 */
function touchMember(room, t, prove) {
  const m = memberOf(room, t);
  if (!m) return false;
  const rec = m.seat ? room.seats[m.seat] : room.watchers.get(t);
  if (!rec) return false;
  /* 已经离线、而且连接也没了 → 这一发多半是页面卸载时用 keepalive 发出、却晚于
     SSE close 才到达的「遗言」。它不能把人叫回来：否则人明明已经走了，服务端却认为
     他还在，同名重进只能以观众身份看着自己还坐在位子上。 */
  if (!rec.online && !linkAlive(room.id, t || rec.token)) return true;
  rec.beatAt = Date.now();
  if (prove) rec.beatSeen = true;
  if (!rec.online) markOnline(room, t);          /* 心跳比 close 事件更可信 */
  else rec.offlineAt = 0;
  return true;
}

/* 一个人「算不算已经走了」：从掉线那一刻、或从未连上过的那一刻开始计时。
   返回 0 表示人还在。 */
function goneSince(rec, now) {
  if (!rec) return 0;
  if (!rec.online) return (rec.offlineAt || rec.at || now);
  if (!rec.everOnline) return (rec.at || now);   /* join 了却一直没连上 SSE */
  return 0;
}

/* 房间事件流水：与「飞花记录」互补 —— 这里记人与流程（进出、准备、暂停、裁决、改名），
   不参与撤销回滚，是纯粹的审计时间线。文本在服务端生成，前端只渲染。 */
function pushEvent(room, type, text, extra) {
  const e = Object.assign({ at: Date.now(), type, text: String(text || '') }, extra || {});
  room.events.push(e);
  if (room.events.length > EVENT_MAX) room.events.splice(0, room.events.length - EVENT_MAX);
  return e;
}

function newRoom(cfg, nick, isPrivate) {
  const id = isPrivate ? privateRoomCode() : roomCode();
  if (!id) return null;               /* 房间号全占满，交给调用方回「房间已满」 */
  const room = {
    id,
    isPrivate: !!isPrivate,
    createdAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    cfg,
    seats: {
      A: newMember(nick || judgeMod.randomAuthor(), token()),
      B: null,
      C: null,
      D: null,
    },
    phase: 'waiting',
    board: [],
    /* 自定义字库：{ chars, total, at, by }。null = 用系统字库。
       只在 phase==='waiting' 时可改，改完整盘重铺（见 setPool）。 */
    pool: null,
    turn: 'A',
    turnNo: 1,
    log: [],
    deadline: 0,
    timer: null,
    order: 'ABCD',
    reason: '',
    undo: [],        /* 每一步之前的棋盘快照，供「撤销一步」回退 */
    req: null,       /* 待对方同意的操作：{type:'undo'|'finish', by, at} */
    ready: { A: false, B: false, C: false, D: false },   /* 对应席位都点了「准备好了」才开局 */
    /* 留座：谁刚从这个席位离开（{nick, at}）。开局之后空出来的位子不再随便让人坐，
       但原来那个人用同一个昵称回来，凭这条记录还能坐回原位 —— 否则一离开就再也回不去。 */
    vacant: { A: null, B: null, C: null, D: null },
    /* 刚离开的 token → 原席位（RECALL_MS 内有效）。专给「刷新 / 后退」用：
       页面卸载时客户端会替玩家发一次安静的离开，重新加载时用同一个 token 一问，
       就把他原样放回原位，不必重新加入，事件流里也不会多出一进一出。 */
    recall: new Map(),
    paused: null,    /* 暂停中：{by, left:剩余毫秒, at, why} —— why 区分手动暂停 / 有人下场 */
    watchers: new Map(),             /* 观众：token -> {nick, online, since, mid, offlineAt} */
    dispute: null,   /* 待裁决的一手：{by, text, norm, at, left} —— 未收录时冻结计时 */
    refs: new Map(), /* 裁判：mid -> {by, at}。由在场选手把观众标成裁判，可多个人 */
    events: [],      /* 房间事件流水（审计用，不参与撤销） */
  };
  buildBoard(room);          /* 建房即铺盘：等待对手时也能看见棋盘，不是一片空格 */
  rooms.set(id, room);
  const pCnt = cfg.playerCount || 2;
  const modeText = pCnt === 1 ? '单人' : (pCnt === 3 ? '三人' : (pCnt === 4 ? '四人' : '双人'));
  const timeText = (pCnt === 1 || !cfg.turnSeconds) ? '不限时' : ('每手 ' + (cfg.turnSeconds || TURN_SECONDS_DEFAULT) + ' 秒');
  pushEvent(room, 'create', room.seats.A.nick + ' 创建了房间 · ' + modeText + ' · ' + cfg.size + '×' + cfg.size +
    ' · ' + (cfg.endless ? '战至最后一刻' : cfg.rounds + ' 轮') + ' · ' + timeText,
    { seat: 'A', mid: room.seats.A.mid });
  return room;
}

function cells(room) { return room.cfg.size * room.cfg.size; }

/* ---------- 自定义字库 ----------
   玩家可以粘一段文本上来，棋盘优先用里面的字，字不够才用系统字库补。
   归一化必须走 judge.normalize（同一套「只留汉字 + 繁转简」）：
   否则粘一首繁体诗上来，玩家敲简体永远涂不上那些格子 —— 盘上的字与判定的字
   必须是同一个字面，这是这套东西能用的前提。 */
const POOL_MAX = 400;        /* 20×20 是棋盘上限，存再多也用不到 */
const POOL_RAW_MAX = 8000;   /* 原始文本字符上限，挡掉几十万字的粘贴 */

/* 判断「盘上这一格原来属于哪套字库」要用成员查询。POOL 与 EXTRA 无交集（300 / 2578 字）。 */
const POOL_LIST = POOL.split('');
const POOL_SET = new Set(POOL_LIST);
const EXTRA_SET = new Set(EXTRA.split(''));

function poolChars(room) {
  return (room.pool && Array.isArray(room.pool.chars)) ? room.pool.chars : [];
}

/* 对外只给统计和缩略：整份字库前端不需要（棋盘上已经全是这些字了） */
function poolPublic(room) {
  const c = poolChars(room);
  return {
    count: c.length,
    preview: c.slice(0, 24).join(''),
    by: room.pool ? String(room.pool.by || '') : '',
  };
}

/* 文本 → 字库数组：只留汉字、繁转简、去重保序、截到 POOL_MAX */
function textToChars(text) {
  const norm = judgeMod.normalize(String(text == null ? '' : text).slice(0, POOL_RAW_MAX * 2));
  const seen = new Set();
  const out = [];
  for (const ch of norm) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
    if (out.length >= POOL_MAX) break;
  }
  return out;
}

function buildBoard(room) {
  const n = cells(room);
  const picked = [];
  const used = new Set();

  /* ① 自定义字库优先：先洗牌再取，不按粘贴顺序铺 —— 否则棋盘左上角永远是开头那几句 */
  for (const ch of shuffle(poolChars(room).slice())) {
    if (picked.length >= n) break;
    if (!ch || used.has(ch)) continue;
    picked.push(ch);
    used.add(ch);
  }

  /* ② 不足的部分才由系统字库补：仍按「低频字」名额掺 EXTRA，其余从 POOL 取，
        都跳过已上盘的字 —— 一格一个字，重字会让「这句命中哪一格」变得含糊。 */
  const rest = n - picked.length;
  if (rest > 0) {
    const normalPool = POOL.split('').filter((ch) => !used.has(ch));
    const extraLeft = EXTRA.split('').filter((ch) => !used.has(ch)).length;
    const minExtra = Math.max(0, rest - normalPool.length);
    const maxExtra = Math.min(rest, extraLeft);
    const extraN = Math.max(minExtra, Math.min(room.cfg.extra, maxExtra));
    const normalN = rest - extraN;
    for (const ch of shuffle(normalPool).slice(0, normalN)) { picked.push(ch); used.add(ch); }
    for (const ch of pickExtras(extraN, used)) {
      if (used.has(ch) || picked.length >= n) continue;
      picked.push(ch);
      used.add(ch);
    }
    /* 极端情况（自定义字库塞满生僻字，系统池不够铺）宁可重字也要把盘铺满：
       棋盘少一格是真的坏，重一个字只是稍微含糊。 */
    let guard = 0;
    while (picked.length < n && guard++ < n * 4) picked.push(POOL.charAt(crypto.randomInt(POOL.length)));
  }

  shuffle(picked);
  room.board = picked.map((ch) => ({ ch, owner: null }));
}

/* 设置 / 撤下自定义字库。空文本 = 撤下，回到系统字库。 */
function setPool(room, t, text) {
  const a = actorOf(room, t);
  if (!a || !(a.seat || a.ref)) {
    return { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能改字库。' };
  }
  if (room.phase !== 'waiting') {
    return { ok: false, code: 'phase', reason: '对局已经开始，字库只能在开局前设置。' };
  }
  const raw = String(text == null ? '' : text);
  if (raw.length > POOL_RAW_MAX) {
    return { ok: false, code: 'too-long', reason: '文本太长（上限 ' + POOL_RAW_MAX + ' 字符），请只粘要用的部分。' };
  }
  if (!raw.trim()) {
    /* 留空保存 = 撤下。与公告栏同一个约定：没有字库只有一种表示 */
    room.pool = null;
    buildBoard(room);
    room.ready = { A: false, B: false, C: false, D: false };
    room.req = null;
    pushEvent(room, 'pool', a.nick + ' 撤下了自定义字库，棋盘回到系统字库');
    broadcast(room);
    return { ok: true, pool: poolPublic(room) };
  }
  const chars = textToChars(raw);
  if (!chars.length) {
    return { ok: false, code: 'no-hanzi', reason: '这段文本里没有汉字。' };
  }
  room.pool = { chars, total: raw.length, at: Date.now(), by: a.nick };
  buildBoard(room);
  room.ready = { A: false, B: false, C: false, D: false };   /* 盘全换了，旧的准备不算数 */
  room.req = null;
  pushEvent(room, 'pool', a.nick + ' 设了自定义字库：' + chars.length + ' 字（去重后）' +
    '，棋盘已按字库重铺' + (chars.length < cells(room) ? '，不足的 ' + (cells(room) - chars.length) + ' 格由系统字库补' : ''));
  broadcast(room);
  return { ok: true, pool: poolPublic(room) };
}

/* 单格重随：开局前点一下格子换一个字。
   抽签范围必须跟着这一格**原来属于哪套字库**走，三类各抽各的：
     · 字库字 → 只在自定义字库里换
     · 常用字 → 只在常用字里换
     · 低频字 → 只在低频字里换（按低频字权重抽）
   只有这样才能保证「点几下格子不会把房间的字库设置悄悄改掉」。跨库混抽的后果
   实测过：低频字 0 的房间点一下有 90% 概率冒出个生僻字；点 120 下之后，配额 17 的
   盘面变成 66 个低频字 —— 设置还在，盘面早就不是它了。
   同一套字库内仍然优先挑还没上盘的字（一格一字）；那一类真的换不动了就明确报错，
   不拿「系统字」或「重字」将就。 */
function rerollCell(room, t, index) {
  const a = actorOf(room, t);
  if (!a || !(a.seat || a.ref)) {
    return { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能换字。' };
  }
  if (room.phase !== 'waiting') {
    return { ok: false, code: 'phase', reason: '对局已经开始，不能再换字了。' };
  }
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= room.board.length) {
    return { ok: false, code: 'index', reason: '格子编号不对。' };
  }
  const old = room.board[i].ch;
  const onBoard = new Set();
  for (let k = 0; k < room.board.length; k++) if (k !== i) onBoard.add(room.board[k].ch);
  onBoard.add(old);   /* 新字不能等于旧字 —— 换出来还是一样，等于点了没反应 */

  const inPool = poolChars(room);
  const poolSet = inPool.length ? new Set(inPool) : null;
  let src, where;
  if (poolSet && poolSet.has(old)) { src = inPool; where = '自定义字库'; }
  else if (POOL_SET.has(old)) { src = POOL_LIST; where = '常用字'; }
  else if (EXTRA_SET.has(old)) { src = EXTRA_SET; where = '低频字'; }
  else { src = POOL_LIST; where = '常用字'; }   /* 兜底：盘上的字只可能来自这三套 */

  let next = null;
  if (src === EXTRA_SET) {
    const one = pickExtras(1, onBoard);
    if (one.length) next = one[0];
  } else {
    const fresh = src.filter((ch) => ch && !onBoard.has(ch));
    if (fresh.length) next = fresh[crypto.randomInt(fresh.length)];
  }
  if (!next) {
    return {
      ok: false, code: 'exhausted',
      reason: where + '里的字都已在盘上，这一格没有别的字可换（一格一个字，不重复）。',
    };
  }
  room.board[i].ch = next;
  pushEvent(room, 'reroll', a.nick + ' 换了第 ' + (i + 1) + ' 格：' + old + ' → ' + next);
  broadcast(room);
  return { ok: true, index: i, ch: next };
}

function counts(room) {
  let a = 0, b = 0, c = 0, d = 0, n = 0;
  for (const cell of room.board) {
    if (cell.owner === 'A') a++;
    else if (cell.owner === 'B') b++;
    else if (cell.owner === 'C') c++;
    else if (cell.owner === 'D') d++;
    else n++;
  }
  return { a, b, c, d, n };
}

/* ---------- 开局设置（正式开局前才能改） ----------
   主持人视角的「尺寸 / 低频字 / 轮数 / 每手秒数 / 文体 / 重抽棋盘」在联机版里的对应物：
   房主或裁判在 waiting 阶段改，改完重铺棋盘并让双方重新准备（规则变了，旧的准备不算数）。 */
function cfgText(c) {
  const kinds = KINDS.filter((k) => c.kinds && c.kinds[k]).join('');
  const pCnt = c.playerCount || 2;
  const modeText = pCnt === 1 ? '单人' : (pCnt === 3 ? '三人' : (pCnt === 4 ? '四人' : '双人'));
  const timeText = (pCnt === 1 || !c.turnSeconds) ? '不限时' : ('每手 ' + c.turnSeconds + ' 秒');
  const lenText = (pCnt === 1 || c.freeSubmit) ? ' · 不限字数' : (c.maxPoemLen && c.maxPoemLen !== 17 ? (' · 限 ' + c.maxPoemLen + ' 字') : '');
  const coupletText = (pCnt === 1 || c.freeSubmit) ? '' : (c.limitCouplet === false ? ' · 不限诗联句' : '');
  const freeText = (pCnt > 1 && c.freeSubmit) ? ' · 自由提交' : '';
  return modeText + ' · ' + c.size + '×' + c.size + ' · ' + (c.endless ? '战至最后一刻' : c.rounds + ' 轮') +
    ' · ' + timeText + lenText + coupletText + freeText +
    (c.extra ? ' · 低频字 ' + c.extra : '') +
    ' · 语料 ' + (kinds || '诗');
}

function mergeCfg(cur, body) {
  const b = {
    size: body.size !== undefined ? body.size : cur.size,
    extra: body.extra !== undefined ? body.extra : cur.extra,
    rounds: body.rounds !== undefined ? body.rounds : cur.rounds,
    turnSeconds: body.turnSeconds !== undefined ? body.turnSeconds : cur.turnSeconds,
    endless: body.endless !== undefined ? body.endless : cur.endless,
    allowDup: body.allowDup !== undefined ? body.allowDup : cur.allowDup,
    playerCount: body.playerCount !== undefined ? body.playerCount : cur.playerCount,
    maxPoemLen: body.maxPoemLen !== undefined ? body.maxPoemLen : cur.maxPoemLen,
    limitCouplet: body.limitCouplet !== undefined ? body.limitCouplet : cur.limitCouplet,
    freeSubmit: body.freeSubmit !== undefined ? body.freeSubmit : cur.freeSubmit,
    kinds: body.kinds && typeof body.kinds === 'object' ? body.kinds : cur.kinds,
  };
  return sanitizeCfg(b);
}

function applyCfg(room, t, body) {
  const a = actorOf(room, t);
  if (!a || !(a.seat || a.ref)) {
    return { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能改设置。' };
  }
  if (room.phase !== 'waiting') {
    return { ok: false, code: 'phase', reason: '对局已经开始，规则只能开局前调整。' };
  }
  const old = room.cfg;
  const next = mergeCfg(old, body);
  const redrew = next.size !== old.size || next.extra !== old.extra;
  room.cfg = next;
  if (redrew) buildBoard(room);
  room.ready = { A: false, B: false, C: false, D: false };   /* 规则换了，旧的「准备好了」不成立 */
  room.req = null;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  pushEvent(room, 'cfg', a.nick + ' 调整了设置：' + cfgText(next) + (redrew ? '，并重铺了棋盘' : ''));
  broadcast(room);
  return { ok: true, cfg: next, redrew };
}

function redrawBoard(room, t) {
  const a = actorOf(room, t);
  if (!a || !(a.seat || a.ref)) {
    return { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能重抽棋盘。' };
  }
  if (room.phase !== 'waiting') {
    return { ok: false, code: 'phase', reason: '对局已经开始，棋盘不能再重抽。' };
  }
  buildBoard(room);
  room.ready = { A: false, B: false, C: false, D: false };
  room.req = null;
  pushEvent(room, 'redraw', a.nick + ' 重抽了棋盘（' + room.cfg.size + '×' + room.cfg.size + ' · 低频字 ' +
    room.cfg.extra + '）');
  broadcast(room);
  return { ok: true, cfg: room.cfg };
}


function roundOf(turnNo, roomOrCnt) {
  const pCnt = typeof roomOrCnt === 'number'
    ? roomOrCnt
    : (roomOrCnt && roomOrCnt.cfg && roomOrCnt.cfg.playerCount ? Number(roomOrCnt.cfg.playerCount) : 2);
  return Math.ceil(turnNo / (pCnt || 2));
}

/* ---------- 记录的展示串 ----------
   同一份「飞花记录」里，命中语料的句子带着底本标点（八百里分麾下炙，五十弦翻塞外声），
   未收录的句子是玩家自己打的、归一化后没有分隔（合抱之木生于毫末九层之台…），
   两种排版摆在一起很乱。这里统一成「分句之间一个空格」：
   判定与落子只看归一化后的汉字，展示串纯粹是给人读的。 */
function spacedText(s) {
  return String(s == null ? '' : s)
    .replace(/[，。！？；：、,.!?;:…·—～~'"“”‘’()（）【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* 这个 token 现在还有没有活着的 SSE 连接。
   online 标志可能因为页面被系统杀掉而残留（连接没走到 close），
   真正能证明「人还在」的是连接本身 —— 判定幽灵成员一律以它为准。 */
function linkAlive(roomId, t) {
  const set = clients.get(roomId);
  if (!set || !t) return false;
  for (const c of set) if (c.token === t) return true;
  return false;
}

function dropClientByToken(roomId, t) {
  const set = clients.get(roomId);
  if (!set || !t) return;
  for (const c of set) {
    if (c.token === t) {
      try { c.res.end(); } catch (_) {}
      set.delete(c);
    }
  }
}

function teamOf(room) { return room.turn; }

function startPlay(room, rebuild, waitReady) {
  if (rebuild || !room.board.length) buildBoard(room);
  room.turn = 'A';
  room.turnNo = 1;
  room.log = [];
  room.reason = '';
  room.undo = [];
  room.req = null;
  room.ready = { A: false, B: false, C: false, D: false };
  room.paused = null;
  room.dispute = null;
  room.vacant = { A: null, B: null, C: null, D: null };   /* 新的一局，旧的留座作废 */
  /* 再来一局：先摆好新棋盘回到「等待准备」，各方都点准备好了才真的开始 */
  if (waitReady) {
    room.phase = 'waiting';
    room.deadline = 0;
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    return;
  }
  room.phase = 'playing';
  room.startedAt = Date.now();
  room.finishedAt = null;
  resetTimer(room);
}

function startTimer(room, ms) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.cfg.playerCount === 1 || !room.cfg.turnSeconds) {
    room.deadline = 0;
    return;
  }
  if (room.phase !== 'playing' || room.paused) return;
  /* 场上缺人时不走表：deadline 保持冻结值，等补位后 syncSeatPause 自动续上 */
  if (!requiredSeats(room).every((s) => !!room.seats[s])) return;
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    /* 计时器回调里抛错同样是「无人接住」的 → 会把整个进程带走。
       一局出问题不该让所有人一起掉线，这里就地记下来继续跑。 */
    try {
      if (room.phase !== 'playing' || room.paused) return;
      if (!requiredSeats(room).every((s) => !!room.seats[s])) return;
      applyPass(room, '超时');
    } catch (e) {
      logCrash('timer', e);
      console.error('[timer] 超时判负出错：' + (e && e.stack ? e.stack : e));
    }
  }, ms);
}

function resetTimer(room) {
  const sec = Math.max(5, Number(room.cfg.turnSeconds) || TURN_SECONDS_DEFAULT);
  startTimer(room, sec * 1000);
}

/* ---------- 暂停 ----------
   两个来源：任一方手动暂停；或者有一位选手下场（场上缺人）。
   缺人导致的暂停，在补位后自动继续。 */
function pauseClock(room, by, why) {
  if (room.phase !== 'playing' || room.paused) return;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const left = Math.max(1000, room.deadline - Date.now());
  room.paused = { by: by || null, left, at: Date.now(), why: why || 'manual' };
  room.deadline = Date.now() + left;     /* 冻结：让时钟停在暂停那一刻 */
}

function resumeClock(room) {
  const p = room.paused;
  if (!p) return;
  room.paused = null;
  startTimer(room, Math.max(1000, Math.round(p.left)));
}

function pauseGame(room, actor) {
  if (room.phase !== 'playing') return { ok: false, code: 'phase', reason: '对局不在进行中。' };
  if (room.dispute) return { ok: false, code: 'dispute', reason: '有一句诗正在等待裁决，裁决后才能操作。' };
  if (room.paused) {
    if (!requiredSeats(room).every((s) => !!room.seats[s])) {
      return { ok: false, code: 'seat-empty', reason: '场上还有空位，等人补位后会自动继续。' };
    }
    resumeClock(room);
    pushEvent(room, 'resume', actor.nick + ' 继续了对局', { seat: actor.seat || null, mid: actor.mid });
    broadcast(room);
    return { ok: true, resumed: true, paused: null };
  }
  /* by 存席位（前端与自测都按 A/B 认人）；裁判暂停时 by 为 null，
     另存 byNick / byMid 供显示 —— 不能把 by 改成 mid，那会破坏既有契约。 */
  pauseClock(room, actor.seat, 'manual');
  room.paused.byNick = actor.nick;
  room.paused.byMid = actor.mid;
  room.paused.byRef = !actor.seat;
  pushEvent(room, 'pause', actor.nick + (actor.seat ? '' : '（裁判）') + ' 暂停了对局',
    { seat: actor.seat || null, mid: actor.mid });
  broadcast(room);
  return { ok: true, paused: room.paused };
}

/* 场上缺人 → 冻结；人到齐且是因为缺人才停的 → 自动续 */
function syncSeatPause(room) {
  if (room.phase !== 'playing') return;
  const full = requiredSeats(room).every((s) => !!room.seats[s]);
  if (!full) {
    if (!room.paused) pauseClock(room, null, 'seat-empty');
    else if (room.paused.why === 'manual') { /* 手动暂停保持原样 */ }
  } else if (room.paused && room.paused.why === 'seat-empty') {
    resumeClock(room);
  }
}

/* ---------- 准备 ----------
   选手就位后各点「准备好了」才真正开局。 */
function setReady(room, seat, val) {
  if (room.phase === 'playing') return { ok: false, code: 'phase', reason: '对局已经开始了。' };
  if (room.phase === 'finished') return { ok: false, code: 'phase', reason: '这一局已经结束。' };
  const was = room.ready[seat];
  room.ready[seat] = val !== false;
  if (was !== room.ready[seat]) {
    pushEvent(room, 'ready', nickOf(room, seat) + (room.ready[seat] ? ' 准备好了' : ' 取消了准备'),
      { seat, mid: room.seats[seat] && room.seats[seat].mid });
  }
  const req = requiredSeats(room);
  const both = req.length > 0 && req.every((s) => room.seats[s] && room.ready[s]);
  if (both) {
    startPlay(room, false);
    pushEvent(room, 'start', req.length === 1 ? '选手准备完毕，挑战开始' : '全员准备完毕，对局开始');
  }
  broadcast(room);
  return { ok: true, ready: room.ready, started: both };
}

/* ---------- 席位 / 观众 ----------
   一个 token 在房间里只有一个身份：选手（坐 A 或 B）或观众。
   选手可随时下场变观众，观众也能随时坐上空出来的位子。 */
const WATCH_MAX = 30;

function memberOf(room, t) {
  if (!t) return null;
  const seat = seatOf(room, t);
  if (seat) return { kind: 'player', seat, nick: room.seats[seat].nick, mid: room.seats[seat].mid };
  const w = room.watchers.get(t);
  if (w) return { kind: 'watcher', seat: null, nick: w.nick, mid: w.mid };
  return null;
}

function addWatcher(room, nick, t, hidden) {
  const m = newMember(nick || '观众', t || token());
  m.online = !!t;                 /* 传了 token 说明调用方已经接管过一条旧记录 */
  m.since = Date.now();
  if (hidden) m.hidden = true;    /* 开发者：看得见所有人，但名单上没有他 */
  room.watchers.set(m.token, m);
  return m.token;
}

/* 观众人数：隐形观众不参与一切对外计数（成员列表、大厅「观众 N」、观众席上限、
   「房里还有没有人」都按它算）。否则「没痕迹」就成了半句空话。 */
function visibleWatchers(room) {
  let n = 0;
  for (const w of room.watchers.values()) if (!w.hidden) n++;
  return n;
}

/* 同一个人反复进出会留下多条同名的「幽灵」观众：旧记录还没超时，新的一次 join
   又多出一条 —— 成员列表里于是看到「自己」重复好几次（裁判标记还挂在旧的那条上）。
   这里把「同名、且已经没有活连接」的旧记录接管掉：mid 不变（裁判身份因此保住），
   只换 token，不新增条目。
   两个真人真用同一个昵称、而且都在线时，两条都保留 —— 那是两个人。 */
function adoptStaleWatcher(room, nick, t, clientToken) {
  for (const [k, w] of room.watchers) {
    if (w.hidden) continue;
    if (clientToken && k === clientToken) {
      dropClientByToken(room.id, k);
      room.watchers.delete(k);
      w.token = t;
      w.online = true;
      w.offlineAt = 0;
      w.everOnline = true;
      w.beatAt = Date.now();
      w.since = Date.now();
      room.watchers.set(t, w);
      pushEvent(room, 'online', w.nick + ' 重新进入房间', { mid: w.mid });
      return w;
    }
    if (w.nick !== nick) continue;
    const dead = !w.online || !aliveMember(room, w, w.token, 0) || (w.beatSeen && (Date.now() - (w.beatAt || 0) > Math.min(22000, ALIVE_MS))) || (w.everOnline && !linkAlive(room.id, w.token) && (Date.now() - (w.at || 0) > JOIN_GRACE_MS));
    if (!dead) continue;
    dropClientByToken(room.id, k);
    room.watchers.delete(k);
    w.token = t;
    w.online = true;
    w.offlineAt = 0;
    w.everOnline = true;
    w.beatAt = Date.now();
    w.since = Date.now();
    room.watchers.set(t, w);
    pushEvent(room, 'online', nick + ' 重新进入房间', { mid: w.mid });
    return w;
  }
  return null;
}

/* 坐上席位的人，不该同时以观众身份留在名单里（同名幽灵及旧 token 同样清掉） */
function dropGhostWatcher(room, nick, keepToken, clientToken) {
  for (const [k, w] of room.watchers) {
    if (w.hidden) continue;
    if (k === keepToken) continue;
    if (w.nick === nick || (clientToken && k === clientToken)) {
      dropClientByToken(room.id, k);
      room.watchers.delete(k);
    }
  }
}

/* 席位名（给事件文本用） */
function nickOf(room, seat) {
  return (room.seats[seat] && room.seats[seat].nick) || seatName(seat);
}

/* ---------- 裁判 ----------
   裁判是「被在场选手标记出来的观众」：看得到全场，能掌流程（暂停 / 暂停恢复 /
   撤销 / 提前结算 / 裁决未收录句 / 改规则重铺棋盘），但不能出手、不能替选手提交。
   标记跟着 mid 走 —— 下场再补位、换席位都还是同一个人。
   权限判定全部收敛到 actorOf()：seat 表示他能不能出手，ref 表示他有没有裁决权。 */
function isRefMid(room, mid) {
  return !!(mid && room.refs.has(mid));
}

function actorOf(room, t) {
  const m = memberOf(room, t);
  if (!m) return null;
  return {
    kind: m.kind, seat: m.seat, nick: m.nick, mid: m.mid,
    ref: m.kind === 'watcher' && room.refs.has(m.mid),
  };
}

/* 「能掌流程的人」：场上选手 + 裁判。出手权仍然只看 seat。 */
function canControl(room, t) {
  const a = actorOf(room, t);
  return !!(a && (a.seat || a.ref));
}

/* 设 / 取消裁判：只有在场选手能操作，只能标观众。 */
function setRef(room, byToken, mid, on) {
  const me = actorOf(room, byToken);
  if (!me || !me.seat) {
    return { ok: false, code: 'not-player', reason: '只有在场选手能把观众设为裁判。' };
  }
  if (!mid) return { ok: false, code: 'bad-mid', reason: '找不到这个人。' };
  let target = null;
  for (const w of room.watchers.values()) {
    if (w.hidden) continue;
    if (w.mid === mid) { target = w; break; }
  }
  if (!target) {
    /* 席位上的选手不能当裁判 —— 选手本来就有控制权，再标一遍只会让人误会 */
    for (const s of ALL_SEATS) {
      if (room.seats[s] && room.seats[s].mid === mid) {
        return { ok: false, code: 'is-player', reason: '选手本身就有裁决权，不需要再设为裁判。' };
      }
    }
    return { ok: false, code: 'missing', reason: '这个人已经不在观众席了。' };
  }
  if (on === false) {
    if (!room.refs.delete(mid)) return { ok: true, unchanged: true, refs: refMids(room) };
    pushEvent(room, 'ref', me.nick + ' 取消了 ' + target.nick + ' 的裁判身份', { mid, by: me.mid });
    broadcast(room);
    return { ok: true, refs: refMids(room) };
  }
  if (room.refs.has(mid)) return { ok: true, unchanged: true, refs: refMids(room) };
  room.refs.set(mid, { by: me.mid, at: Date.now() });
  pushEvent(room, 'ref', me.nick + ' 把 ' + target.nick + ' 设为裁判', { mid, by: me.mid });
  broadcast(room);
  return { ok: true, refs: refMids(room) };
}

function refMids(room) { return Array.from(room.refs.keys()); }

/* 选手下场 → 变观众。mid 保持不变，所以成员列表里是同一个人换了身份。
   quiet：页面卸载时代发的离开，不往事件流里写「下场观战」这种会让人困惑的记录。 */
function standUp(room, t, why, quiet) {
  const seat = seatOf(room, t);
  if (!seat) return { ok: false, code: 'not-player', reason: '你现在不是选手。' };
  const s = room.seats[seat];
  const m = newMember(s.nick, t);
  m.mid = s.mid;
  m.online = !!s.online;
  m.offlineAt = s.offlineAt || 0;
  m.everOnline = !!s.everOnline;
  m.beatAt = s.beatAt || Date.now();
  m.beatSeen = !!s.beatSeen;
  m.since = Date.now();
  room.watchers.set(t, m);
  room.seats[seat] = null;
  room.vacant[seat] = { nick: s.nick, at: Date.now() };   /* 留座：原主回来还能坐 */
  room.ready[seat] = false;
  room.req = null;            /* 席位变了，挂着等确认的请求作废 */
  /* 先把表冻住（保留这一刻的剩余秒数），再把挂着的争议按「需重新提交」收掉 */
  syncSeatPause(room);
  if (room.dispute) rejectDispute(room, '有人下场');
  if (!quiet) {
    pushEvent(room, 'stand', s.nick + ' 从' + seatName(seat) + '下场观战' + (why ? '（' + why + '）' : ''),
      { mid: s.mid, seat });
  }
  broadcast(room);
  return { ok: true, seat: null, nick: s.nick, watchers: visibleWatchers(room) };
}

function takeSeat(room, t, want) {
  const req = requiredSeats(room);
  const seat = req.includes(want) ? want : req.find((s) => !room.seats[s]);
  if (!seat) return { ok: false, code: 'no_seat', reason: '场上没有空闲席位。' };

  /* 选手换座：若目标席位就是当前席位，直接返回 unchanged */
  const oldSeat = seatOf(room, t);
  if (oldSeat && oldSeat === seat) {
    return { ok: true, seat, nick: room.seats[seat].nick, unchanged: true };
  }

  if (room.seats[seat]) return { ok: false, code: 'taken', reason: '这个位子已经有人了。' };

  if (oldSeat) {
    const p = room.seats[oldSeat];
    room.seats[oldSeat] = null;
    room.vacant[oldSeat] = null;
    room.ready[oldSeat] = false;

    room.vacant[seat] = null;
    room.seats[seat] = p;
    room.ready[seat] = false;
    room.req = null;
    if (room.dispute) rejectDispute(room, '选手换位');
    syncSeatPause(room);
    pushEvent(room, 'seat', p.nick + ' 从' + seatName(oldSeat) + '换到了' + seatName(seat), { mid: p.mid, seat, oldSeat });
    broadcast(room);
    return { ok: true, seat, nick: p.nick, switched: true, oldSeat };
  }

  const w = room.watchers.get(t);
  if (!w) return { ok: false, code: 'not-member', reason: '你还没进这个房间。' };
  room.vacant[seat] = null;              /* 有人坐下了，之前那条留座作废 */
  room.seats[seat] = newMember(w.nick, t);
  room.seats[seat].mid = w.mid;         /* 身份标识跨补位保持不变 */
  room.seats[seat].online = !!w.online;
  room.seats[seat].offlineAt = w.offlineAt || 0;
  room.seats[seat].everOnline = !!w.everOnline;
  room.seats[seat].beatAt = w.beatAt || Date.now();
  room.seats[seat].beatSeen = !!w.beatSeen;
  room.seats[seat].at = w.at || Date.now();
  room.watchers.delete(t);
  dropGhostWatcher(room, w.nick, null);
  room.ready[seat] = false;
  room.req = null;            /* 换人了，旧座位发起的请求不再有效 */
  syncSeatPause(room);          /* 人数补齐 → 因缺人而停的表自动续上 */
  pushEvent(room, 'seat', w.nick + ' 坐上了' + seatName(seat), { mid: w.mid, seat });
  broadcast(room);
  return { ok: true, seat, nick: w.nick };
}

/* 改昵称：选手和观众都能改，mid 不变。
   自定义昵称每人 24 小时只能改一次（opt.key 是 nickKeyOf 算出来的）；随机诗人名不占额度。
   「随机」是客户端自称的，所以必须核对名字真在诗人池里 —— 否则标一个 random 就能绕过去。 */
function renameMember(room, t, nick, opt) {
  const name = String(nick || '').trim().slice(0, 12);
  if (!name) return { ok: false, code: 'empty', reason: '昵称不能为空。' };
  const m = memberOf(room, t);
  if (!m) return { ok: false, code: 'not-member', reason: '你不在这个房间里。' };
  if (name === m.nick) return { ok: true, unchanged: true, nick: name };

  const o = opt || {};
  const random = o.random === true && judgeMod.isAuthor(name);
  let key = random ? '' : String(o.key || '');
  let leftWaitMs = 0;
  if (key) {
    const q = nickQuota(key);
    if (!q.ok) {
      /* 冷却中，但如果他改回的就是「上次记录在案的那个自定义名」，等于没有产生新的自定义名 ——
         放行、也不重新记账。大厅那条路（nickGate）一直是这样「同名不算改」的，
         这里以前没跟上，于是出现「在大厅用同一个名字能进房、在房里改回同一个名字却被拦」。
         2026-10-24 用户的朋友正好问到这一点。 */
      if (q.lastNick && q.lastNick === name) {
        key = '';
        leftWaitMs = q.waitMs;      /* 额度还在，只是这次没用掉 —— 回给前端显示剩余时间用 */
      } else {
        return {
          ok: false, code: 'cooldown', retryAt: q.retryAt, waitMs: q.waitMs,
          reason: '自定义昵称 24 小时只能改一次。你上次在 ' + fmtClock(q.lastAt) + ' 改成了「' +
            (q.lastNick || '别的名字') + '」，还要等 ' + fmtWait(q.waitMs) + '才能再改。' +
            '想现在就换，可以用「随机」抽一位诗人（不占额度）。',
        };
      }
    }
  }

  const old = m.nick;
  if (m.seat) room.seats[m.seat].nick = name;
  else room.watchers.get(t).nick = name;
  /* 用掉额度必须落在「真的改了」之后：改名本身不会失败，但顺序别反过来 ——
     先记账再改，一旦中途抛错，玩家白白损失一次机会。 */
  if (key) recordNick(key, name);
  pushEvent(room, 'nick', old + ' 改名为 ' + name, { mid: m.mid, seat: m.seat || null });
  broadcast(room);
  return {
    ok: true, nick: name, old, random,
    /* 改回旧名字不重新计时：把原来那一次剩下的时间还回去，前端照样能显示「还要等多久」 */
    retryAt: key ? Date.now() + NICK_GAP_MS : (leftWaitMs ? Date.now() + leftWaitMs : 0),
    gapMs: NICK_GAP_MS,
  };
}

/* 移出成员：只能由在场选手操作，且只能移出「已经掉线」的人 —— 防止被用来赶走场上对手 */
function kickMember(room, byToken, mid) {
  const me = memberOf(room, byToken);
  if (!me || me.kind !== 'player') {
    return { ok: false, code: 'not-player', reason: '只有在场选手能移出成员。' };
  }
  if (mid === me.mid) return { ok: false, code: 'self', reason: '不能移出自己，用「离开房间」。' };

  let target = null, targetSeat = null;
  for (const s of ALL_SEATS) {
    if (room.seats[s] && room.seats[s].mid === mid) { target = room.seats[s]; targetSeat = s; }
  }
  if (!target) {
    for (const w of room.watchers.values()) {
      if (w.hidden) continue;
      if (w.mid === mid) { target = w; break; }
    }
  }
  if (!target) return { ok: false, code: 'missing', reason: '这个人已经不在房间里了。' };
  /* 「无响应」＝ 已经掉线，或进来之后一直没打开过页面；还在线上的人不能踢。
     另外要求至少失踪 60 秒，避免刚进房间、或切后台一下的人被误踢。 */
  const gone = goneSince(target, Date.now());
  if (!gone || Date.now() - gone < 60 * 1000) {
    return { ok: false, code: 'online', reason: target.nick + ' 还在线，只能移出已经掉线的成员。' };
  }

  const name = target.nick;
  if (targetSeat) {
    /* 选手：先下场（会冻结计时、收掉争议），再把他从观众席删掉 */
    standUp(room, target.token);
    room.watchers.delete(target.token);
  } else {
    for (const [k, w] of room.watchers) { if (w.mid === mid) { room.watchers.delete(k); break; } }
  }
  pushEvent(room, 'kick', name + ' 被 ' + me.nick + ' 移出房间',
    { mid, seat: targetSeat, by: me.mid });
  broadcast(room);
  if (isEmptyRoom(room)) dropRoom(room);
  return { ok: true, nick: name, seat: targetSeat };
}

/* 在线状态：以「该 token 还有没有活跃 SSE 连接」为准，而不是看某一次连接关闭。
   同一个人开两个标签页时，关掉一个不算掉线 —— 这是「人走了却还显示在房间」
   和「人在却显示离线」两个毛病共同的根子。 */
function markOnline(room, t) {
  const m = memberOf(room, t);
  if (!m) return;
  const rec = m.seat ? room.seats[m.seat] : room.watchers.get(t);
  if (!rec) return;
  const wasOffline = !rec.online;
  rec.online = true;
  rec.offlineAt = 0;
  rec.restoredAt = 0;        /* 人已经回来了，恢复期的宽限不再需要 */
  const firstTime = !rec.everOnline;
  rec.everOnline = true;
  /* 首次连上不写事件（紧接着的 join/watch 已经说明他进来了），只有「回来」才记。
     隐形观众（开发者）上下线都不记 —— 否则「回到房间 / 掉线了」照样会出现在事件流里。 */
  if (wasOffline && !firstTime && !rec.hidden) {
    pushEvent(room, 'online', m.nick + ' 回到房间', { mid: m.mid, seat: m.seat || null });
  }
}

function markOffline(room, t, at) {
  const m = memberOf(room, t);
  if (!m) return;
  const rec = m.seat ? room.seats[m.seat] : room.watchers.get(t);
  if (!rec || !rec.online) return;
  rec.online = false;
  /* 掉线时刻传进来时（半开连接：最后一次心跳才是他真正离开的时刻），
     两种计时都从那一刻算，而不是从「终于被发现」的这一刻算。 */
  rec.offlineAt = at || Date.now();
  if (!rec.hidden) {
    pushEvent(room, 'offline', m.nick + ' 掉线了' + (m.seat ? '（席位仍占着）' : ''),
      { mid: m.mid, seat: m.seat || null });
  }
}

function hasOtherLink(roomId, t, except) {
  const set = clients.get(roomId);
  if (!set) return false;
  for (const c of set) { if (c !== except && c.token === t) return true; }
  return false;
}

/* 房间彻底没人了：立刻删掉，顺手把还挂着的 SSE 连接关掉。
   以前要等下一轮清扫（10 秒）才消失，离开的人回到大厅还能看到自己刚离开的那间房。
   但「刚离开、可能马上回来」的人（刷新页面，recall 里还留着凭据）要给他留一点时间，
   否则单人房一刷新就没了。 */
function pruneRecall(room, now) {
  const t0 = now || Date.now();
  for (const [k, r] of room.recall) if (t0 - r.at > RECALL_MS) room.recall.delete(k);
  return room.recall.size;
}

function isEmptyRoom(room) {
  /* 隐形观众（开发者）不算「房里还有人」：你不该因为挂着看一眼，
     就让一个早就没人、该散的房间一直留在大厅和内存里。 */
  if (ALL_SEATS.some((s) => !!room.seats[s]) || visibleWatchers(room)) return false;
  return pruneRecall(room) === 0;
}

function dropRoom(room) {
  if (!rooms.has(room.id)) return false;
  if (room.timer) clearTimeout(room.timer);
  rooms.delete(room.id);
  const set = clients.get(room.id);
  if (set) {
    for (const c of set) { try { c.res.end(); } catch (_) {} }
    clients.delete(room.id);
  }
  return true;
}

/* 主动离开：观众直接走；选手先下场再把观众身份也删掉，席位随即空出。
   走完最后一个人 → 房间当场消失（不等清扫）。
   quiet=true 是「页面卸载时替玩家发的」那一种：不写离开事件，但把 token 和席位记进
   recall，重新加载时凭它原样接回去（刷新 = 什么都没发生）。 */
function leaveRoom(room, t, quiet) {
  const m = memberOf(room, t);
  if (!m) {
    /* token 已经不在名单里（重复点离开 / 另一个标签页先走了）：
       只要房间因此空了，也顺手收掉，别留个空壳在大厅里。 */
    if (isEmptyRoom(room)) dropRoom(room);
    return { ok: true, gone: true };
  }
  /* 只有「页面卸载时代发的」那种离开才留接回凭据。
     玩家亲手点「离开房间」就是真的走了，旧 token 必须立刻失效。 */
  if (m.seat && quiet) rememberSeat(room, t, m.seat, m.nick, m.mid);
  /* 隐形观众（开发者）进出不留事件 —— 判断要在删除之前取，删完就查不到了 */
  const wasHidden = !!(room.watchers.get(t) && room.watchers.get(t).hidden);
  if (m.seat) {
    standUp(room, t, quiet ? '' : '主动离开', quiet);
    room.watchers.delete(t);
  } else {
    room.watchers.delete(t);
  }
  if (!quiet && !wasHidden) {
    pushEvent(room, 'leave', m.nick + ' 离开了房间', { mid: m.mid, seat: m.seat || null });
  }
  broadcast(room);
  if (isEmptyRoom(room)) dropRoom(room);
  return { ok: true, roomGone: !rooms.has(room.id) };
}

/* 记住「刚离开的这个 token 原来坐哪」*/
function rememberSeat(room, t, seat, nick, mid) {
  if (!t || !seat) return;
  room.recall.set(t, { seat, nick, mid, at: Date.now() });
  /* 只留最近的 20 条，别让一张表无限长（房间里最多两个席位，正常也就一两条） */
  if (room.recall.size > 20) {
    const first = room.recall.keys().next().value;
    room.recall.delete(first);
  }
}

/* 同一个 token 在 RECALL_MS 内回来 → 原样放回原位。
   席位已经被别人坐了、或者超时了，就返回 null，按普通流程处理。 */
function recallSeat(room, t) {
  const r = room.recall.get(t);
  if (!r) return null;
  if (Date.now() - r.at > RECALL_MS) { room.recall.delete(t); return null; }
  if (room.seats[r.seat]) { room.recall.delete(t); return null; }
  const m = newMember(r.nick, t);
  m.mid = r.mid;
  m.online = true;
  m.everOnline = true;
  m.beatAt = Date.now();
  room.seats[r.seat] = m;
  room.vacant[r.seat] = null;
  room.recall.delete(t);
  syncSeatPause(room);
  pushEvent(room, 'online', r.nick + ' 回到' + seatName(r.seat), { mid: r.mid, seat: r.seat });
  broadcast(room);
  return { seat: r.seat };
}

/* 裁决目标名称：根据有无裁判和选手数量返回精准称谓 */
function disputeTargetName(room) {
  const hasRef = room.refs && room.refs.size > 0;
  const pCount = (room.cfg && room.cfg.playerCount) || 2;
  if (hasRef) {
    return pCount > 2 ? '其他选手或裁判' : '对手或裁判';
  }
  return pCount > 2 ? '其他选手' : '对手';
}

/* ---------- 争议：诗句未收录或超长 ----------
   判诗返回 not_found 或超过字数上限时不直接拒，而是冻结计时，交给对方/其他选手或裁判裁决：
   「有效提交」= 按字面正常涂色入账；「需重新提交」= 时钟续走，同一人重填。 */
function openDispute(room, seat, text, norm, reasonKind, maxLen, extraVal, source, line) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  const left = Math.max(1000, room.deadline - Date.now());
  const disp = spacedText(line || text);
  const kind = reasonKind || 'not_found';
  const limit = (kind === 'too_long') ? (maxLen || (room.cfg && room.cfg.maxPoemLen) || 17) : maxLen;
  room.dispute = {
    by: seat, byNick: nickOf(room, seat), text: String(text).trim(), disp,
    norm: norm || '', kind, at: Date.now(), left, maxLen: limit, extra: extraVal,
    source: source || null, line: line || null,
  };
  room.deadline = Date.now() + left;      /* 冻结显示 */
  room.req = null;
  const targetDesc = disputeTargetName(room);
  let reasonDesc = '未收录';
  if (kind === 'too_long') {
    reasonDesc = '超过 ' + limit + ' 字上限';
  } else if (kind === 'too_many_clauses') {
    reasonDesc = '超过诗每次至多两句上限（含 ' + extraVal + ' 句）';
  } else if (kind === 'cross_couplet') {
    reasonDesc = '诗提交跨联两句（非同一联前后句）';
  } else if (source && source.kind) {
    reasonDesc = '出自《' + source.title + '》（' + source.kind + '），本局未启用该文体';
  }
  pushEvent(room, 'dispute', nickOf(room, seat) + ' 提交的「' + (disp || room.dispute.text) +
    '」' + reasonDesc + '，计时冻结，等' + targetDesc + '裁决', { seat, mid: room.seats[seat] && room.seats[seat].mid });
}

function rejectDispute(room, why) {
  const d = room.dispute;
  if (!d) return false;
  room.dispute = null;
  startTimer(room, Math.max(1000, Math.round(d.left)));
  if (why) {
    room.lastDispute = { by: d.by, why, at: Date.now() };
    pushEvent(room, 'dispute-reject', '「' + (d.disp || d.text) + '」' + why + '，计时继续',
      { seat: d.by, mid: room.seats[d.by] && room.seats[d.by].mid });
  }
  return true;
}

/* 裁决：actor 是「操作的人」——可能是对手席位的选手，也可能是裁判（seat 为 null）。
   提交方本人（只能是选手）点这里＝撤回提交，裁判不享受这条分支。 */
function resolveDispute(room, actor, accept) {
  const d = room.dispute;
  if (!d) return { ok: false, code: 'none', reason: '没有待裁决的提交。' };
  if (actor.seat && actor.seat === d.by) {
    /* 提交方自己点＝撤回提交，等同「需重新提交」 */
    rejectDispute(room, '提交方撤回');
    broadcast(room);
    return { ok: true, cancelled: true };
  }
  if (!accept) {
    const isRef = !!(actor.ref && !actor.seat);
    const byWho = isRef ? '裁判' : (room.cfg.playerCount > 2 ? actor.nick : '对手');
    rejectDispute(room, byWho + '判为需重新提交');
    broadcast(room);
    return { ok: true, rejected: true };
  }
  room.dispute = null;
  const isRef = !!(actor.ref && !actor.seat);
  const r = placePoem(room, d.by, d.text, d.norm, d.disp || spacedText(d.line || d.text), d.source || null, 'manual',
    { nick: actor.nick, ref: isRef });
  if (!r.ok) {
    room.dispute = d;               /* 判不了有效就原样退回，让对手改判 */
    return r;
  }
  pushEvent(room, 'dispute-accept', actor.nick + ' 判「' + (d.disp || d.text) + '」有效，按字面涂色',
    { seat: actor.seat, mid: actor.mid });
  broadcast(room);
  return { ok: true, accepted: true, entry: r.entry };
}

/* ---------- 撤销 / 提前结算 ---------- */
function snapshot(room) {
  return {
    owners: room.board.map((c) => c.owner),
    logLen: room.log.length,
    turnNo: room.turnNo,
    reason: room.reason,
  };
}

function pushUndo(room) {
  room.undo.push(snapshot(room));
  if (room.undo.length > UNDO_MAX) room.undo.shift();
}

function restore(room, snap) {
  room.board.forEach((c, i) => { c.owner = snap.owners[i]; });
  room.log.length = snap.logLen;
  room.turnNo = snap.turnNo;
  const seats = requiredSeats(room);
  const idx = (room.turnNo - 1) % seats.length;
  room.turn = seats[idx];
  room.phase = 'playing';
  room.reason = snap.reason || '';
  room.req = null;
  room.dispute = null;
  room.paused = null;          /* 回退后重新开始计时，不留在暂停态 */
  resetTimer(room);
}

function finish(room, reason) {
  room.phase = 'finished';
  room.reason = reason;
  room.finishedAt = Date.now();
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.deadline = 0;
  room.paused = null;
  room.dispute = null;
  const c = counts(room);
  const pCnt = room.cfg.playerCount || 2;
  let scoreText = '';
  if (pCnt === 1) scoreText = '赤 ' + c.a + ' 格';
  else if (pCnt === 2) scoreText = '赤 ' + c.a + ' : ' + c.b + ' 青';
  else if (pCnt === 3) scoreText = '赤 ' + c.a + ' : ' + c.b + ' 青 : ' + c.c + ' 金';
  else scoreText = '赤 ' + c.a + ' : ' + c.b + ' 青 : ' + c.c + ' 金 : ' + c.d + ' 翠';
  pushEvent(room, 'finish', '对局结束（' + reason + '）· ' + scoreText);
  archiveGame(room);          /* 存档给开发者审阅；失败只写日志，不影响结算 */
}

/* ---------- 一手棋 ---------- */
function advance(room) {
  room.req = null;                  /* 局面变了，挂着未确认的请求就作废 */
  room.turnNo++;
  const c = counts(room);
  if (c.n === 0) { finish(room, '棋盘已填满'); return; }
  const pCnt = room.cfg.playerCount || 2;
  if (!room.cfg.endless && room.turnNo > room.cfg.rounds * pCnt) { finish(room, '轮数已满'); return; }
  const seats = requiredSeats(room);
  const idx = (room.turnNo - 1) % seats.length;
  room.turn = seats[idx];
  resetTimer(room);
}

function applyPass(room, why) {
  pushUndo(room);
  room.log.push({ type: 'pass', team: room.turn, round: roundOf(room.turnNo, room), why: why || '', byNick: nickOf(room, room.turn) });
  pushEvent(room, 'pass', nickOf(room, room.turn) + (why === '超时' ? ' 超时，本回合作废' : ' 放弃本回合'),
    { seat: room.turn });
  advance(room);
  broadcast(room);
}

/* 把一句诗落到棋盘上（判诗通过、或对方 / 裁判裁定有效都走这里）。
   只按字面涂色，不查语料 —— 判定与落子彻底分离。
   ruler 只在「人工裁定有效」时有值：{ nick, ref }，ref 为真表示裁定人是裁判而非对手。 */
function placePoem(room, seat, text, q, line, source, via, ruler) {
  const set = new Set(q.split(''));
  const hits = [];
  let blank = 0, capture = 0, hold = 0;
  const hitChars = {};

  room.board.forEach((cell, idx) => {
    if (!set.has(cell.ch)) return;
    hits.push(idx);
    let kind;
    if (!cell.owner) { blank++; kind = 'new'; }
    else if (cell.owner !== seat) { capture++; kind = 'cap'; }
    else { hold++; kind = 'hold'; }
    hitChars[cell.ch] = kind;
  });

  if (!hits.length) return { ok: false, code: 'no_hit', reason: '这句里没有出现棋盘上的任何字。', norm: q };
  if (!blank) return { ok: false, code: 'no_blank', reason: '命中的 ' + hits.length + ' 格都已经有颜色，至少要占用 1 个未涂色格。', norm: q };
  if (!room.cfg.allowDup && room.log.some((e) => e.type === 'fly' && e.norm === q)) {
    return { ok: false, code: 'dup', reason: '这句已经飞过了，换一句。', norm: q };
  }

  pushUndo(room);
  for (const idx of hits) {
    if (room.board[idx].owner !== seat) room.board[idx].owner = seat;
  }

  const poetNick = (room.dispute && room.dispute.by === seat && room.dispute.byNick) ? room.dispute.byNick : nickOf(room, seat);
  const entry = {
    type: 'fly', team: seat, round: roundOf(room.turnNo, room),
    raw: String(text).trim(), norm: q, line: spacedText(line || q),
    hits: hits.length, blank, capture, hold,
    cells: hits.slice(),
    hitChars, source: source || null, via: via || 'exact', ruler: ruler || null,
    byNick: poetNick,
  };
  room.log.push(entry);
  pushEvent(room, 'fly', nickOf(room, seat) + ' 飞出「' + entry.line + '」· 新占 ' + blank +
    ' / 抢夺 ' + capture + ' / 同色 ' + hold + (source ? ' · 出自《' + source.title + '》' + source.author : ''),
    { seat, mid: room.seats[seat] && room.seats[seat].mid });
  advance(room);
  broadcast(room);
  return { ok: true, entry, source: entry.source, norm: q };
}

function applyMove(room, seat, text) {
  if (room.phase !== 'playing') return { ok: false, code: 'phase', reason: '当前不在对局中。' };
  if (room.dispute) return { ok: false, code: 'dispute', reason: '有一句诗正在等待裁决，裁决后才能再出手。' };
  if (room.paused) return { ok: false, code: 'paused', reason: '对局已暂停，继续后才能出手。' };
  if (!requiredSeats(room).every((s) => !!room.seats[s])) return { ok: false, code: 'seat-empty', reason: '场上还缺选手。' };
  if (room.turn !== seat) return { ok: false, code: 'turn', reason: '还没到你出手。' };

  const q = judgeMod.normalize(text);
  if (!q) return { ok: false, code: 'empty', reason: '没有识别到汉字，请检查输入。', norm: '' };
  if (q.length < 2) return { ok: false, code: 'too_short', reason: '至少要两个字。', norm: q };

  // 必须满足棋盘基础落子规则（命中字、至少一个未涂色格、未重复飞花）
  // 盘面物理规则不满足时直接提示无法提交，绝不转交对手裁决
  const set = new Set(q.split(''));
  let hits = 0, blank = 0;
  for (const cell of room.board) {
    if (set.has(cell.ch)) {
      hits++;
      if (!cell.owner) blank++;
    }
  }
  if (!hits) return { ok: false, code: 'no_hit', reason: '这句里没有出现棋盘上的任何字。', norm: q };
  if (!blank) return { ok: false, code: 'no_blank', reason: '命中的 ' + hits + ' 格都已经有颜色，至少要占用 1 个未涂色格。', norm: q };
  if (!room.cfg.allowDup && room.log.some((e) => e.type === 'fly' && e.norm === q)) {
    return { ok: false, code: 'dup', reason: '这句已经飞过了，换一句。', norm: q };
  }

  const isSolo = room.cfg.playerCount === 1;
  const isFree = isSolo || !!room.cfg.freeSubmit;
  const maxLen = Number(room.cfg.maxPoemLen) || 17;

  const allowKinds = {};
  for (const k of KINDS) if (room.cfg.kinds[k]) allowKinds[k] = true;

  // 判定：单人或自由提交模式不设字数/句数上限；普通多人模式先放宽查询（最多 40 字）以识别真实文体与句数
  const v = judgeMod.judge(text, { allowKinds, maxLen: isFree ? 0 : 40, unlimitedLen: isFree });
  if (!v.ok) {
    /* 语料里查不到 / 超长：
       单人模式或自由提交模式下：允许自创诗与生僻诗自由游玩，自动放行通过，按字面涂色入账！
       普通多人模式下：转交对手/裁判裁决 */
    if (v.code === 'not_found' || v.code === 'too_long') {
      if (isFree) {
        return placePoem(room, seat, text, q, spacedText(text), v.source || null, 'free');
      }
      const isOver = !isFree && (q.length > maxLen);
      const disputeKind = isOver ? 'too_long' : 'not_found';
      openDispute(room, seat, text, v.norm, disputeKind, isOver ? maxLen : undefined, undefined, v.source, v.line);
      broadcast(room);
      const targetDesc = disputeTargetName(room);
      const reasonDesc = isOver ? ('超过 ' + maxLen + ' 字上限') : (v.source && v.source.kind ? ('出自《' + v.source.title + '》（' + v.source.kind + '），本局未启用该文体') : '未收录');
      return {
        ok: false, code: 'dispute', pending: true, norm: v.norm,
        reason: '「' + (v.norm || String(text).trim()) + '」' + reasonDesc + '，计时已暂停，等' + targetDesc + '裁决。',
      };
    }
    return { ok: false, code: v.code, reason: v.reason, norm: v.norm };
  }

  // 命中语料：检查单次提交限制（单人模式与自由提交模式不受限）
  if (!isFree) {
    // 只有对诗这种有规律结构的近体律绝且开启了联句限制（limitCouplet !== false）时，才限制至多提交同一联前后两句；
    // 对词、曲、赋、文及其他长短句不规则文体（或未开启联句限制时），按 maxLen (默认 17) 字上限限制
    const limitCouplet = room.cfg.limitCouplet !== false;
    const isRegularShi = limitCouplet && !!(v.isRegularShi || (v.source && v.source.kind === '诗' && v.isUniformShi));
    if (isRegularShi) {
      // 对诗这种有规律的结构，每次至多提交同一联前后两句
      const clauses = v.clauseCount || (v.line ? v.line.split(' ').length : 1);
      if (clauses > 2) {
        openDispute(room, seat, text, v.norm, 'too_many_clauses', maxLen, clauses, v.source, v.line);
        broadcast(room);
        const targetDesc = disputeTargetName(room);
        return {
          ok: false, code: 'dispute', pending: true, norm: v.norm,
          reason: '诗每次至多提交前后两句（当前包含 ' + clauses + ' 句），计时已暂停，等' + targetDesc + '裁决是否有效。',
        };
      }
      if (v.isCrossCouplet) {
        openDispute(room, seat, text, v.norm, 'cross_couplet', maxLen, clauses, v.source, v.line);
        broadcast(room);
        const targetDesc = disputeTargetName(room);
        return {
          ok: false, code: 'dispute', pending: true, norm: v.norm,
          reason: '诗每次至多提交同一联前后两句（当前为跨联两句），计时已暂停，等' + targetDesc + '裁决是否有效。',
        };
      }
    } else {
      // 对其他长短句不规则的文体（词、曲、赋、文等），仍按 maxLen (默认 17) 字上限
      if (q.length > maxLen) {
        openDispute(room, seat, text, v.norm, 'too_long', maxLen, undefined, v.source, v.line);
        broadcast(room);
        const targetDesc = disputeTargetName(room);
        return {
          ok: false, code: 'dispute', pending: true, norm: v.norm,
          reason: '「' + (v.norm || String(text).trim()) + '」超过 ' + maxLen + ' 字上限，计时已暂停，等' + targetDesc + '裁决是否有效。',
        };
      }
    }
  }

  return placePoem(room, seat, text, v.norm, v.line, v.source, v.via || 'exact');
}

/* ================= 状态序列化 ================= */
function publicState(room, t) {
  const c = counts(room);
  const me = memberOf(room, t);
  const req = requiredSeats(room);

  /* 房间成员：各席位 + 观众席，按「赤 / 青 / 金 / 翠 / 观众」顺序，附在线状态与 mid。
     前端据此渲染成员列表；mid 不含 token，移出操作用它定位。 */
  const members = [];
  for (const s of ALL_SEATS) {
    if (!req.includes(s) && !room.seats[s]) continue;
    const p = room.seats[s];
    members.push(p
      ? { mid: p.mid, nick: p.nick, kind: 'player', seat: s, online: aliveMember(room, p, p.token), isYou: !!(me && me.mid === p.mid) }
      : { mid: null, nick: '', kind: 'empty', seat: s, online: false, isYou: false });
  }
  for (const w of room.watchers.values()) {
    if (w.hidden) continue;           /* 开发者：名单里没有他 */
    members.push({
      mid: w.mid, nick: w.nick, kind: 'watcher', seat: null,
      online: aliveMember(room, w, w.token), isYou: !!(me && me.mid === w.mid),
      ref: room.refs.has(w.mid),
    });
  }
  const meRef = !!(me && me.kind === 'watcher' && room.refs.has(me.mid));

  return {
    id: room.id,
    phase: room.phase,
    cfg: room.cfg,
    size: room.cfg.size,
    board: room.board.map((x) => x.owner ? x.owner : 0).join(''),
    chars: room.board.map((x) => x.ch).join(''),
    turn: room.turn,
    turnNo: room.turnNo,
    round: roundOf(room.turnNo, room),
    rounds: room.cfg.rounds,
    endless: room.cfg.endless,
    score: c,
    log: room.log,
    seats: {
      A: room.seats.A ? { nick: room.seats.A.nick, online: aliveMember(room, room.seats.A, room.seats.A.token), mid: room.seats.A.mid } : null,
      B: room.seats.B ? { nick: room.seats.B.nick, online: aliveMember(room, room.seats.B, room.seats.B.token), mid: room.seats.B.mid } : null,
      C: room.seats.C ? { nick: room.seats.C.nick, online: aliveMember(room, room.seats.C, room.seats.C.token), mid: room.seats.C.mid } : null,
      D: room.seats.D ? { nick: room.seats.D.nick, online: aliveMember(room, room.seats.D, room.seats.D.token), mid: room.seats.D.mid } : null,
    },
    you: me ? me.seat : null,
    role: me ? me.kind : 'guest',
    youNick: me ? me.nick : '',
    youMid: me ? me.mid : null,
    /* 裁判：refs 给成员面板画徽标，youRef 给「我是裁判」的提示，
       canControl 统一回答「这个人能不能掌流程」（选手或裁判）。 */
    refs: refMids(room),
    youRef: meRef,
    canControl: !!(me && (me.kind === 'player' || meRef)),
    cfgEditable: room.phase === 'waiting',
    /* 自定义字库的统计与缩略（整份不给：棋盘上已经全是这些字了）。
       canPickCells 告诉前端「现在点格子能不能换字」—— 只有开局前、且是选手或裁判。 */
    pool: poolPublic(room),
    canPickCells: !!(me && (me.kind === 'player' || meRef) && room.phase === 'waiting'),
    members,
    watchers: visibleWatchers(room),
    watcherNicks: Array.from(room.watchers.values())
      .filter((w) => !w.hidden)
      .map((w) => ({ nick: w.nick, online: !!w.online })),
    /* 开发者视角：isPrivate 用来在房间页标「私密」，youHidden 让前端亮出「隐形观战」标记 */
    isPrivate: !!room.isPrivate,
    youHidden: !!(me && me.kind === 'watcher' && room.watchers.get(t) && room.watchers.get(t).hidden),
    deadline: room.deadline,
    serverNow: Date.now(),
    startedAt: room.startedAt || room.createdAt,
    finishedAt: room.finishedAt || (room.phase === 'finished' ? ((room.events && room.events.length && room.events[room.events.length - 1].at) || Date.now()) : null),
    reason: room.reason,
    req: room.req,
    canUndo: room.undo.length > 0,
    ready: room.ready,
    paused: room.paused,
    dispute: room.dispute,
    events: room.events,
  };
}

const clients = new Map(); // roomId -> Set({token, res})

/* 往 SSE 连接里写一段。
 * **`res.write()` 在连接已经结束时是「异步」抛的**（内部走 nextTick 触发 'error'），
 * try/catch 根本接不住 —— 线上 2026-10-22 / 10-23 各刷出一串
 * `ERR_STREAM_WRITE_AFTER_END: write after end`，就是定时器踩在这个坑上。
 * 所以只能：① 写之前先看 writableEnded / destroyed；② 顺手把死连接从集合里摘掉。 */
function sseAlive(c) {
  const res = c && c.res;
  return !!res && !res.writableEnded && !res.destroyed && res.writable !== false;
}
function sseWrite(c, text) {
  if (!sseAlive(c)) return false;
  try { c.res.write(text); return true; } catch (_) { return false; }
}

/* 每条连接都要按「它自己的 token」生成状态 —— 席位、角色、能不能裁决都在里面。
   这里曾经写成 c.seat（对象上根本没有这个字段），于是每次广播都把 you 推成 null、
   role 推成 guest：所有人收到的都成了「路人视角」，观众和提交方因此看到了裁决按钮。
   字段名必须与建立连接时的 {token, res} 对齐。 */
function broadcast(room) {
  markSnapDirty();          /* 每一次状态变化都记下来，由快照定时器统一落盘 */
  const set = clients.get(room.id);
  if (!set) return;
  for (const c of Array.from(set)) {
    if (!sseAlive(c)) { set.delete(c); continue; }   /* 尸体不写、也顺手清掉 */
    const payload = JSON.stringify({ type: 'state', state: publicState(room, c.token) });
    sseWrite(c, 'data: ' + payload + '\n\n');
  }
  if (!set.size) clients.delete(room.id);
}

/* ================= HTTP ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxLen) {
  const limit = maxLen || 32768;
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (d) => {
      buf += d;
      if (buf.length > limit) { buf = ''; req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function seatOf(room, t) {
  if (!t) return null;
  for (const s of ALL_SEATS) {
    if (room.seats[s] && room.seats[s].token === t) return s;
  }
  return null;
}

function sanitizeCfg(body) {
  const size = Math.max(5, Math.min(20, Number(body.size) || 10));
  const minExtra = Math.max(0, size * size - POOL.length);
  const maxExtra = Math.min(size * size, EXTRA.length);
  const extra = Math.max(minExtra, Math.min(maxExtra, Number(body.extra) || 0));
  let rounds = Math.max(1, Math.min(999, Number(body.rounds) || SUGGEST[size] || 20));
  const playerCount = Math.max(1, Math.min(4, Number(body.playerCount) || 2));
  const turnSeconds = playerCount === 1 ? 0 : Math.max(15, Math.min(600, Number(body.turnSeconds) || TURN_SECONDS_DEFAULT));
  const maxPoemLen = Math.max(5, Math.min(99, Number(body.maxPoemLen) || 17));
  const limitCouplet = playerCount === 1 ? false : (body.limitCouplet === undefined ? true : !!body.limitCouplet);
  const freeSubmit = !!body.freeSubmit;
  const endless = !!body.endless;
  const allowDup = !!body.allowDup;
  const kinds = {};
  for (const k of KINDS) {
    const v = body.kinds && typeof body.kinds === 'object' ? body.kinds[k] : undefined;
    if (v === undefined) kinds[k] = true;
    else kinds[k] = !!v;
  }
  if (!KINDS.some((k) => kinds[k])) kinds['诗'] = true;
  return { size, extra, rounds, endless, allowDup, kinds, turnSeconds, playerCount, maxPoemLen, limitCouplet, freeSubmit };
}

async function api(req, res, u) {
  const parts = u.pathname.split('/').filter(Boolean); // ['api','room','ABCD','move']

  /* ---------- 审阅：已结束对局的存档 ----------
     口令对了才给看；列表只回摘要（不含每一手），要看细节带 ?id= 取单局。 */
  if (u.pathname === '/api/records' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    /* 定位一局：优先 rid（房号@结束时刻），其次 id（老的定位方式）。
       光用 id 是不够的 —— 房号 000–999 顺序发号，一天就能转一圈，同一个房号会打好几局；
       原来的 find(r => r.id === wantId) 只会返回该房号最新那一局，其余的取不到。 */
    const ridOf = (r) => r.id + '@' + r.at;
    const wantRid = u.searchParams.get('rid');
    const wantId = u.searchParams.get('id');
    if (wantRid || wantId) {
      const all = readJSONL(RECORDS_FILE, 5000);
      const hit = wantRid
        ? all.find((r) => ridOf(r) === wantRid)
        : all.find((r) => r.id === wantId);
      if (!hit) return sendJSON(res, 404, { ok: false, reason: '没有这一局的存档。' });
      return sendJSON(res, 200, { ok: true, rid: ridOf(hit), record: hit });
    }
    const all = readJSONL(RECORDS_FILE, RECORD_LIST_MAX);
    return sendJSON(res, 200, {
      ok: true,
      file: path.basename(RECORDS_FILE),
      max: RECORD_LIST_MAX,
      list: all.map((r) => ({
        rid: ridOf(r),
        id: r.id, at: r.at, createdAt: r.createdAt, reason: r.reason, cfg: r.cfg,
        players: r.players, score: r.score, turns: r.turns,
        events: (r.events || []).length,
      })),
    });
  }

  /* ---------- 审阅：把旧存档里丢掉的阵营补回来 ----------
     2026-10-22 之前落盘的多人对局只记了赤营/青营，金营翠营的昵称当场就没了。
     渲染层已经修好，但那几行的数据确实是空的，只能回填 —— 证据在 log 的 byNick
     与 events 的 seat+mid（一一对应，见 recordfix.js 开头的说明）。
     默认**只算不写**：先看报告，确认了再加 &apply=1。写之前留一份 .bak。 */
  if (u.pathname === '/api/records/repair' && req.method === 'POST') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    const apply = u.searchParams.get('apply') === '1';
    const targets = [RECORDS_FILE, RECORDS_FILE.replace(/(\.\w+)$/, '.1$1')];
    const files = [];
    for (const f of targets) {
      let txt;
      try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }   /* 没这个文件就跳过 */
      const r = recordFix.repairText(txt);
      const item = {
        file: path.basename(f), total: r.total, fixed: r.fixed,
        report: r.report.slice(0, 200), reportTruncated: r.report.length > 200,
      };
      if (apply && r.fixed) {
        try {
          /* 先留备份再原子改名：中途出任何事，最多是「没改成」，不会是「改坏了一半」。 */
          const bak = f + '.bak';
          try { fs.copyFileSync(f, bak); } catch (_) { /* 备份失败也继续：有 .tmp + rename 兜底 */ }
          const tmp = f + '.tmp';
          fs.writeFileSync(tmp, r.text);
          fs.renameSync(tmp, f);
          item.written = true;
          item.backup = path.basename(bak);
        } catch (e) {
          item.error = e.message;
        }
      }
      files.push(item);
    }
    const fixed = files.reduce((n, x) => n + x.fixed, 0);
    console.log('[records] 阵营回填' + (apply ? '（已写回）' : '（预演）') + '：' + fixed + ' 局');
    return sendJSON(res, 200, {
      ok: true, dry: !apply, fixed: fixed, files: files,
      hint: apply ? '' : '这是预演，档案没有被改动。确认无误后加 &apply=1 写回。',
    });
  }

  /* ---------- 反馈：玩家写给开发者的话 ---------- */
  if (u.pathname === '/api/feedback' && req.method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').replace(/\s+$/g, '').slice(0, 1000).trim();
    const contact = String(body.contact || '').trim().slice(0, 80);
    const nick = String(body.nick || '').trim().slice(0, 12);
    const roomId = String(body.roomId || '').trim().slice(0, 8);
    if (text.length < 2) return sendJSON(res, 400, { ok: false, reason: '再多写两个字吧。' });
    const ip = clientIP(req);
    const now = Date.now();
    const last = feedbackLast.get(ip) || 0;
    if (now - last < FEEDBACK_GAP_MS) {
      const wait = Math.ceil((FEEDBACK_GAP_MS - (now - last)) / 1000);
      return sendJSON(res, 429, { ok: false, reason: '刚提交过，' + wait + ' 秒后再发。' });
    }
    feedbackLast.set(ip, now);
    if (feedbackLast.size > 5000) feedbackLast.clear();   /* 别让这张表无限长 */
    const fid = newFid();
    try {
      appendJSONL(FEEDBACK_FILE, {
        fid, at: now, text, contact, nick, roomId,
        ip: ip.slice(0, 45),
        ua: String(req.headers['user-agent'] || '').slice(0, 160),
      });
    } catch (e) {
      console.error('[feedback] 写入失败：' + e.message);
      return sendJSON(res, 500, { ok: false, reason: '暂时存不下，稍后再试。' });
    }
    console.log('[feedback] ' + (nick || '匿名') + '：' + text.slice(0, 60));
    return sendJSON(res, 200, { ok: true, fid });
  }

  /* ---------- 公告栏：大厅顶上那一条，不重新发布也能改 ---------- */
  if (u.pathname === '/api/notice' && req.method === 'GET') {
    /* 公开、不需要口令 —— 它本来就是给所有人看的东西 */
    return sendJSON(res, 200, { ok: true, notice: readNotice() });
  }

  if (u.pathname === '/api/notice' && req.method === 'POST') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    const body = await readBody(req);
    const text = String(body.text || '').replace(/\s+$/g, '').slice(0, NOTICE_MAX);
    const kind = body.kind === 'warn' ? 'warn' : 'info';
    if (!text.trim()) {
      /* 正文清空 = 撤掉公告。删文件而不是写空串，让「没有公告」只有一种表示。 */
      try { fs.unlinkSync(NOTICE_FILE); } catch (_) { /* 本来就没有 */ }
      console.log('[notice] 已撤下');
      return sendJSON(res, 200, { ok: true, notice: null });
    }
    try {
      const o = writeNotice(text, kind);
      console.log('[notice] 已更新（' + text.length + ' 字）：' + text.slice(0, 50));
      return sendJSON(res, 200, { ok: true, notice: o });
    } catch (e) {
      console.error('[notice] 写入失败：' + e.message);
      return sendJSON(res, 500, { ok: false, reason: '存不下，稍后再试。' });
    }
  }

  /* 取反馈。site 上不放任何收件地址，所以「发到开发者邮箱」这一步是站点外的定时任务
     带口令来取的：?since=<上一条 fid> 只要比它新的，取件方按 fid 去重。 */
  if (u.pathname === '/api/feedback' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    const since = String(u.searchParams.get('since') || '').trim();
    const r = readFeedbackSince(since, 500);
    return sendJSON(res, 200, {
      ok: true, now: Date.now(),
      since: since || null, foundSince: r.foundSince, ahead: r.ahead,
      list: r.list,
    });
  }

  /* 启动记录：审阅页的「启动记录」标签用。最后一条是本次启动。 */
  if (u.pathname === '/api/boot' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    return sendJSON(res, 200, {
      ok: true,
      now: Date.now(),
      currentBoot: readJSONL(BOOT_FILE, 1)[0] || null,
      list: readJSONL(BOOT_FILE, 100),
      /* 最近几次未捕获异常 / 未处理拒绝。容器日志拿不到，这是唯一能事后查的证据。 */
      crashes: readCrashes(10),
      /* 内存时间线（每 60 秒一行）：OOM 死法不留 crash.log，只有这条曲线能说明
         「死之前涨到多少、涨了多久」。跟着审阅页一起读，不必登容器。 */
      mem: readJSONL(path.join(DATA_DIR, 'mem.log'), 40),
    });
  }

  /* 房间快照：发布保护机制的现场状态，审阅页第 4 个标签用。
     发布之后点一下这里就能回答「这次更新到底把对局接回来了没有」。 */
  if (u.pathname === '/api/snapshot' && req.method === 'GET') {
    if (u.searchParams.get('key') !== ADMIN_KEY) {
      return sendJSON(res, 403, { ok: false, reason: '口令不对。' });
    }
    let st = null;
    try { st = fs.statSync(SNAP_FILE); } catch (_) { /* 还没写过盘 */ }
    return sendJSON(res, 200, {
      ok: true,
      now: Date.now(),
      file: path.basename(SNAP_FILE),
      exists: !!st,
      bytes: st ? st.size : 0,
      mtime: st ? Math.round(st.mtimeMs) : 0,
      lastWriteAt: snapAt,
      lastWriteWhy: snapWhy,
      writeErrors: snapErr,
      inMemory: rooms.size,
      inSnapshot: snapRooms,
      lastRestore: lastRestore,
      maxAgeMs: SNAP_MAX_AGE_MS,
      graceMs: RESTORE_GRACE_MS,
      rooms: Array.from(rooms.values(), (r) => ({
        id: r.id, phase: r.phase, round: roundOf(r.turnNo),
        /* 四个营地都要给：审阅页「房间快照」要按席位显示，只给 A/B 的话
           金营翠营在那一页永远是「—」，看起来像没人坐。 */
        players: {
          A: r.seats.A ? r.seats.A.nick : null,
          B: r.seats.B ? r.seats.B.nick : null,
          C: r.seats.C ? r.seats.C.nick : null,
          D: r.seats.D ? r.seats.D.nick : null,
        },
        playerCount: (r.cfg && r.cfg.playerCount) || 2,
        watchers: visibleWatchers(r), paused: !!r.paused,
        deadline: r.deadline || 0, restored: !!r.restoredAt,
      })),
    });
  }

  /* 只给自测用的优雅停机开关：线上不设 SHUTDOWN_HOOK，这个路由根本不存在。
     为什么需要它 —— Windows 上没法从外面给子进程发真正的 SIGTERM：
     node 的 child.kill('SIGTERM') 在 Windows 走的是 TerminateProcess，进程不会执行任何
     信号处理函数。所以「收到信号 → 同步落盘 → 退出」这条路径，本地只能靠这个开关驱动
     同一个 shutdown()，否则它永远没被验证过。 */
  if (u.pathname === '/api/shutdown' && req.method === 'POST' && process.env.SHUTDOWN_HOOK === '1') {
    sendJSON(res, 200, { ok: true });
    return setTimeout(() => shutdown('hook'), 100);
  }

  if (u.pathname === '/api/create' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = sanitizeCfg(body);
    const isPrivate = !!body.isPrivate;
    const nickIn = String(body.nick || '').slice(0, 12).trim();
    /* 大厅改名与房内改名是同一件事：额度不够就先挡住，别先把人放进房间再让他改名 */
    const gate = nickGate(req, body.uid, nickIn);
    if (!gate.ok) {
      return sendJSON(res, 200, {
        ok: false, code: gate.code, retryAt: gate.retryAt, waitMs: gate.waitMs,
        lastNick: gate.lastNick, reason: gate.reason,
      });
    }
    const room = newRoom(cfg, nickIn, isPrivate);
    if (!room) return sendJSON(res, 503, { ok: false, reason: '房间已满（' + MAX_ROOMS + ' 间），等有人散场后再开。' });
    if (room.seats.A) { room.seats.A.online = true; room.seats.A.offlineAt = 0; }
    if (gate.key) recordNick(gate.key, nickIn);
    return sendJSON(res, 200, {
      ok: true, roomId: room.id, seat: 'A', role: 'player',
      token: room.seats.A.token, state: publicState(room, room.seats.A.token),
    });
  }

  /* 重进接管：掉线或关掉网页再用同一个昵称/Token 进来的人，极可能就是原来那位选手。
   若携带原 token（绝对凭据）或同名且旧连接已断线/心跳中断，把席位直接还给他 ——
   否则他会以观众身份进来，然后在成员列表里看到「自己」还坐在位子上，那是最容易让人困惑的一幕。
   在线活跃选手不会被陌生人顶替；mid 保持不变，历史事件仍然指向同一个人。 */
function claimOfflineSeat(room, nick, clientToken) {
  const name = String(nick || '').trim();
  // 1. 优先根据 clientToken 认领（本人铁证）：旧连接直接踢掉接管
  if (clientToken) {
    for (const s of ALL_SEATS) {
      const p = room.seats[s];
      if (p && p.token === clientToken) {
        dropClientByToken(room.id, p.token);
        const t = token();
        p.token = t;
        p.online = true;
        p.offlineAt = 0;
        p.everOnline = true;
        p.beatAt = Date.now();
        p.at = Date.now();
        pushEvent(room, 'online', p.nick + ' 重新连回，坐回' + seatName(s) + '的席位', { mid: p.mid, seat: s });
        return { seat: s, token: t };
      }
    }
  }

  // 2. 根据同名认领：原选手已掉线（断网、心跳停滞、离线）时允许接回
  if (!name) return null;
  for (const s of ALL_SEATS) {
    const p = room.seats[s];
    if (p && p.nick === name) {
      const dead = !p.online || !aliveMember(room, p, p.token) || (p.beatSeen && (Date.now() - (p.beatAt || 0) > Math.min(22000, ALIVE_MS))) || (p.everOnline && !linkAlive(room.id, p.token) && (Date.now() - (p.at || 0) > JOIN_GRACE_MS));
      if (dead) {
        dropClientByToken(room.id, p.token);
        const t = token();
        p.token = t;
        p.online = true;
        p.offlineAt = 0;
        p.everOnline = true;
        p.beatAt = Date.now();          /* 接管即视为活着，等他第一条心跳 */
        p.at = Date.now();
        pushEvent(room, 'online', name + ' 重新进入，接回' + seatName(s) + '的席位', { mid: p.mid, seat: s });
        return { seat: s, token: t };
      }
    }
  }
  return null;
}

  /* ---------- 导入本地对局进度恢复对局 ----------
     用于服务器重启、崩溃或跨设备恢复：解析客户端提交的备份 JSON，
     校验盘面与配置合法性后重构房间，导入者自动坐回对应席位（带新 token），
     对局进入暂停保护态，防止超时判负，其他选手可凭房号进入继续对局。 */
  if (u.pathname === '/api/import' && req.method === 'POST') {
    const body = await readBody(req);
    const backup = body.backup || body.save || body.state || body;
    if (!backup || typeof backup !== 'object') {
      return sendJSON(res, 400, { ok: false, reason: '未识别到有效的存档数据。' });
    }
    const data = (backup.magic === 'FEIHUA_BACKUP' && backup.board) ? backup : (backup.state || backup.room || backup);
    if (!data || !data.board || !data.cfg) {
      return sendJSON(res, 400, { ok: false, reason: '存档缺少棋盘或规则配置数据。' });
    }

    const rawCfg = Object.assign({}, data.cfg);
    const cfg = sanitizeCfg(rawCfg);
    const n = cfg.size * cfg.size;

    let roomBoard = [];
    if (Array.isArray(data.board) && data.board.length === n && typeof data.board[0] === 'object') {
      roomBoard = data.board.map((x) => ({
        ch: String((x && x.ch) || ''),
        owner: x && ALL_SEATS.includes(x.owner) ? x.owner : null,
      }));
    } else {
      const charsStr = Array.isArray(data.chars) ? data.chars.join('') : String(data.chars || '');
      const boardStr = Array.isArray(data.board) ? data.board.map((x) => (typeof x === 'object' ? (x.owner || 0) : x)).join('') : String(data.board || '');
      const charsArr = Array.from(charsStr);
      const boardArr = Array.from(boardStr);
      if (charsArr.length !== n || boardArr.length !== n) {
        return sendJSON(res, 400, { ok: false, reason: '棋盘字数与规格不符，存档可能已损坏。' });
      }
      roomBoard = charsArr.map((ch, i) => {
        const owner = ALL_SEATS.includes(boardArr[i]) ? boardArr[i] : null;
        return { ch, owner };
      });
    }

    if (rooms.size >= MAX_ROOMS) {
      return sendJSON(res, 503, { ok: false, reason: '服务器房间已满（' + MAX_ROOMS + ' 间），请稍后再试。' });
    }

    // 房号决策：默认尝试使用原房号
    let targetId = null;
    const wantOriginalId = body.keepRoomId !== false;
    const candidateId = String(body.roomId || data.roomId || data.id || '').toUpperCase().trim();
    if (wantOriginalId && /^[0-9A-Z]{3,6}$/.test(candidateId) && !rooms.has(candidateId)) {
      targetId = candidateId;
    } else {
      targetId = data.isPrivate ? privateRoomCode() : roomCode();
    }
    if (!targetId) targetId = roomCode();
    if (!targetId) return sendJSON(res, 503, { ok: false, reason: '无法分配房间号。' });

    const now = Date.now();
    const callerNick = String(body.nick || '').slice(0, 12).trim() || '恢复者';
    const callerToken = token();

    // 确定导入者应当坐哪个席位：若传入的昵称匹配原 seats 里的某个阵营，优先认领该阵营
    const reqS = 'ABCD'.slice(0, cfg.playerCount).split('');
    let callerSeat = null;
    for (const s of reqS) {
      const origMember = data.seats && data.seats[s];
      const origNick = origMember && origMember.nick ? String(origMember.nick).slice(0, 12).trim() : null;
      if (origNick && origNick === callerNick && !callerSeat) {
        callerSeat = s;
      }
    }
    if (!callerSeat) callerSeat = 'A';

    const seats = { A: null, B: null, C: null, D: null };
    for (const s of reqS) {
      const origMember = data.seats && data.seats[s];
      const origNick = origMember && origMember.nick ? String(origMember.nick).slice(0, 12).trim() : seatName(s);
      if (s === callerSeat) {
        seats[s] = {
          nick: callerNick,
          token: callerToken,
          mid: 'm' + crypto.randomBytes(3).toString('hex'),
          online: true,
          offlineAt: 0,
          at: now,
          everOnline: true,
          beatAt: now,
          beatSeen: true,
          since: now,
          restoredAt: now,
        };
      } else {
        seats[s] = {
          nick: origNick,
          token: token(),
          mid: 'm' + crypto.randomBytes(3).toString('hex'),
          online: false,
          offlineAt: now,
          at: now,
          everOnline: true,
          beatAt: now,
          beatSeen: false,
          since: now,
          restoredAt: now,
        };
      }
    }

    const fullTurnSeconds = Math.max(5000, (Number(cfg.turnSeconds) || TURN_SECONDS_DEFAULT) * 1000);
    const room = {
      id: targetId,
      isPrivate: !!data.isPrivate,
      createdAt: Number(data.createdAt) || now,
      cfg,
      seats,
      phase: data.phase === 'playing' ? 'playing' : (data.phase === 'finished' ? 'finished' : 'waiting'),
      board: roomBoard,
      turn: ALL_SEATS.includes(data.turn) ? data.turn : 'A',
      turnNo: Math.max(1, Number(data.turnNo) || 1),
      log: Array.isArray(data.log) ? data.log : [],
      deadline: 0,
      timer: null,
      order: typeof data.order === 'string' ? data.order : 'ABCD'.slice(0, cfg.playerCount),
      reason: String(data.reason || ''),
      undo: Array.isArray(data.undo) ? data.undo : [],
      req: null,
      ready: { A: true, B: true, C: true, D: true },
      vacant: { A: null, B: null, C: null, D: null },
      recall: new Map(),
      paused: {
        by: null,
        left: fullTurnSeconds,
        at: now,
        why: 'import',
      },
      watchers: new Map(),
      dispute: null,
      refs: new Map(),
      events: Array.isArray(data.events) ? data.events.slice(-EVENT_MAX) : [],
      restoredAt: now,
    };

    pushEvent(room, 'restore', `${callerNick} 导入了本地进度，对局已恢复！（当前已暂停，点「继续对局」接着打）`);
    rooms.set(room.id, room);
    markSnapDirty();

    return sendJSON(res, 200, {
      ok: true,
      imported: true,
      roomId: room.id,
      seat: callerSeat,
      role: 'player',
      token: callerToken,
      state: publicState(room, callerToken),
    });
  }

  /* ---------- 客户端快照复活房间（Reseed） ----------
     用于容器销毁重建等无持久卷重启场景：客户端持有最近一次由服务端广播的 publicState。
     当服务端重启且磁盘快照丢失时，客户端可凭快照向新服务端申请复活对局。
     校验盘面合法性、棋盘尺寸一致性后重构房间，发起者原地接回席位，并安全重置时钟。 */
  if (u.pathname === '/api/reseed' && req.method === 'POST') {
    const body = await readBody(req);
    const roomId = String(body.roomId || '').toUpperCase().trim();
    if (!roomId || !/^[0-9A-Z]{3,6}$/.test(roomId)) {
      return sendJSON(res, 400, { ok: false, reason: '房间号不合法' });
    }

    // 1. 若房间已在内存中，尝试认领席位
    let room = rooms.get(roomId);
    if (room) {
      const clientToken = String(body.token || '').trim();
      const nick = String(body.nick || '').trim();
      const back = claimOfflineSeat(room, nick, clientToken);
      if (back) {
        dropGhostWatcher(room, nick, null, clientToken);
        syncSeatPause(room);
        broadcast(room);
        return sendJSON(res, 200, {
          ok: true, reseeded: false, roomId: room.id,
          seat: back.seat, role: 'player', token: back.token,
          state: publicState(room, back.token),
        });
      }
      const activeToken = clientToken || token();
      return sendJSON(res, 200, {
        ok: true, reseeded: false, roomId: room.id,
        seat: null, role: 'watcher', token: activeToken,
        state: publicState(room, activeToken),
      });
    }

    // 2. 校验传入的快照数据
    const st = body.state;
    if (!st || typeof st !== 'object') {
      return sendJSON(res, 400, { ok: false, reason: '缺少快照状态数据' });
    }
    const rawCfg = Object.assign({}, st.cfg);
    const cfg = sanitizeCfg(rawCfg);
    const n = cfg.size * cfg.size;

    let roomBoard = [];
    if (Array.isArray(st.board) && st.board.length === n && typeof st.board[0] === 'object') {
      roomBoard = st.board.map((x) => ({
        ch: String((x && x.ch) || ''),
        owner: x && ALL_SEATS.includes(x.owner) ? x.owner : null,
      }));
    } else {
      const charsStr = Array.isArray(st.chars) ? st.chars.join('') : String(st.chars || '');
      const boardStr = Array.isArray(st.board) ? st.board.map((x) => (typeof x === 'object' ? (x.owner || 0) : x)).join('') : String(st.board || '');
      const charsArr = Array.from(charsStr);
      const boardArr = Array.from(boardStr);
      if (charsArr.length !== n || boardArr.length !== n) {
        return sendJSON(res, 400, { ok: false, reason: '棋盘规格与数据不符' });
      }
      roomBoard = charsArr.map((ch, i) => {
        const owner = ALL_SEATS.includes(boardArr[i]) ? boardArr[i] : null;
        return { ch, owner };
      });
    }

    if (rooms.size >= MAX_ROOMS) {
      return sendJSON(res, 503, { ok: false, reason: '房间已满，暂时无法复原。' });
    }

    // 3. 构建复原房间
    const now = Date.now();
    const callerSeat = ALL_SEATS.includes(body.seat) ? body.seat : 'A';
    const callerNick = String(body.nick || (st.seats && st.seats[callerSeat] && st.seats[callerSeat].nick) || (st.players && st.players[callerSeat]) || '赤营').slice(0, 12).trim();
    const callerToken = String(body.token || token());

    const seats = { A: null, B: null, C: null, D: null };
    const reqS = 'ABCD'.slice(0, cfg.playerCount).split('');
    for (const s of reqS) {
      const pNick = (st.seats && st.seats[s] && st.seats[s].nick) || (st.players && st.players[s]) ? String((st.seats && st.seats[s] && st.seats[s].nick) || (st.players && st.players[s])).slice(0, 12).trim() : null;
      if (s === callerSeat) {
        seats[s] = {
          nick: callerNick,
          token: callerToken,
          mid: 'm' + crypto.randomBytes(3).toString('hex'),
          online: true,
          offlineAt: 0,
          at: now,
          everOnline: true,
          beatAt: now,
          beatSeen: true,
          since: now,
          restoredAt: now,
        };
      } else if (pNick) {
        seats[s] = {
          nick: pNick,
          token: token(),
          mid: 'm' + crypto.randomBytes(3).toString('hex'),
          online: false,
          offlineAt: now,
          at: now,
          everOnline: true,
          beatAt: now,
          beatSeen: false,
          since: now,
          restoredAt: now,
        };
      }
    }

    room = {
      id: roomId,
      isPrivate: !!st.isPrivate,
      createdAt: Number(st.createdAt) || now,
      cfg,
      seats,
      phase: st.phase === 'playing' ? 'playing' : (st.phase === 'finished' ? 'finished' : 'waiting'),
      board: roomBoard,
      turn: ALL_SEATS.includes(st.turn) ? st.turn : 'A',
      turnNo: Math.max(1, Number(st.turnNo) || 1),
      log: Array.isArray(st.log) ? st.log : [],
      deadline: 0,
      timer: null,
      order: typeof st.order === 'string' ? st.order : 'ABCD'.slice(0, cfg.playerCount),
      reason: String(st.reason || ''),
      undo: [],
      req: null,
      ready: { A: true, B: true, C: true, D: true },
      vacant: { A: null, B: null, C: null, D: null },
      recall: new Map(),
      paused: null,
      watchers: new Map(),
      dispute: null,
      refs: new Map(),
      events: Array.isArray(st.events) ? st.events.slice(-EVENT_MAX) : [],
      restoredAt: now,
    };

    pushEvent(room, 'restore', '服务更新后对局已自动复原，计时已重置，点「继续」接着打');
    reviveClock(room, now);

    rooms.set(roomId, room);
    markSnapDirty();

    return sendJSON(res, 200, {
      ok: true,
      reseeded: true,
      roomId: room.id,
      seat: callerSeat,
      role: 'player',
      token: callerToken,
      state: publicState(room, callerToken),
    });
  }

/* 加入：有空位就坐下当选手，坐满了就以观众身份进来看 */
  if (u.pathname === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.roomId || '').toUpperCase().trim();
    const room = rooms.get(id);
    if (!room) return sendJSON(res, 404, { ok: false, reason: '房间不存在或已过期。' });
    /* 没填名字的人给一位语料作者当昵称，而不是一律「观众」/「赤营」 */
    const nick = String(body.nick || '').slice(0, 12).trim() || judgeMod.randomAuthor();
    const clientToken = String(body.token || '').trim();

    /* 0) 开发者入口：一律当「隐形观众」进来 —— 不抢空位、不进名单、不写事件。
       想真的打一局，开一条不带 dev 的链接就行（那样就是普通玩家）。 */
    if (isDev(u)) {
      const dt = addWatcher(room, nick, token(), true);
      markSnapDirty();
      return sendJSON(res, 200, {
        ok: true, roomId: room.id, seat: null, role: 'spectator', hidden: true, dev: true,
        token: dt, state: publicState(room, dt),
      });
    }

    /* 0.5) 额度：大厅里改的名字与房间里改的名字共用同一个 24 小时额度（开发者入口不算） */
    const gate = nickGate(req, body.uid, nick);
    if (!gate.ok) {
      return sendJSON(res, 200, {
        ok: false, code: gate.code, retryAt: gate.retryAt, waitMs: gate.waitMs,
        lastNick: gate.lastNick, reason: gate.reason,
      });
    }
    /* 真的进了房间才算用掉额度：被观众席上限挡回去的人不该白扣一次改名机会 */
    const markUsed = () => { if (gate.key) recordNick(gate.key, nick); };

    /* 1) 原选手掉线或重进 → 接回原席位（凭 Token 或 同名+断线） */
    const back = claimOfflineSeat(room, nick, clientToken);
    if (back) {
      /* 接回席位时，自己之前以观众身份留下的同名幽灵一并清掉 ——
         否则成员列表里会同时出现「乙（青营）」和「乙（观众）」。 */
      dropGhostWatcher(room, nick, null, clientToken);
      syncSeatPause(room);
      broadcast(room);
      markUsed();
      return sendJSON(res, 200, {
        ok: true, roomId: room.id, seat: back.seat, role: 'player',
        token: back.token, reclaimed: true, state: publicState(room, back.token),
      });
    }

    /* 2) 有空位就坐下当选手：按所需席位顺序寻找空位。
       对局开始后不再随便让陌生人坐空位（半路接管一盘已经开打的棋不合理），
       但这个位子原来那个人用同一个昵称回来时例外 —— 留座记录还热着就还给他。 */
    const reqSeats = requiredSeats(room);
    const reservedSeat = reqSeats.find((s) => {
      const vac = !room.seats[s] && room.vacant[s];
      return vac && vac.nick === nick && (Date.now() - vac.at < VACANT_MS);
    });
    let freeSeat = reservedSeat;
    if (!freeSeat && room.phase === 'waiting') {
      const nonA = reqSeats.slice(1).find((s) => !room.seats[s]);
      freeSeat = nonA || (reqSeats.includes('A') && !room.seats.A ? 'A' : null);
    }
    if (freeSeat) {
      dropGhostWatcher(room, nick, null, clientToken);      /* 自己之前以观众身份留下的同名幽灵 */
      room.vacant[freeSeat] = null;
      room.seats[freeSeat] = newMember(nick, token());
      room.seats[freeSeat].online = true;
      room.ready[freeSeat] = false;         /* 新坐下的选手默认「未准备」 */
      syncSeatPause(room);
      pushEvent(room, 'join', room.seats[freeSeat].nick + ' 进入房间，坐上' + seatName(freeSeat),
        { seat: freeSeat, mid: room.seats[freeSeat].mid });
      broadcast(room);
      markUsed();
      return sendJSON(res, 200, {
        ok: true, roomId: room.id, seat: freeSeat, role: 'player',
        token: room.seats[freeSeat].token, state: publicState(room, room.seats[freeSeat].token),
      });
    }
    if (visibleWatchers(room) >= WATCH_MAX) {
      return sendJSON(res, 409, { ok: false, reason: '这个房间的观众席也满了。' });
    }
    /* 3) 以观众身份进来：同名且已经掉了的旧记录直接接管，不再新增一条 */
    const wt = token();
    const adopted = adoptStaleWatcher(room, nick, wt, clientToken);
    if (adopted) {
      syncSeatPause(room);
      broadcast(room);
      markUsed();
      return sendJSON(res, 200, {
        ok: true, roomId: room.id, seat: null, role: 'spectator', resumed: true,
        token: wt, state: publicState(room, wt),
      });
    }
    const t = addWatcher(room, nick, wt);
    pushEvent(room, 'watch', nick + ' 以观众身份进入', { mid: room.watchers.get(t).mid });
    broadcast(room);
    markUsed();
    return sendJSON(res, 200, {
      ok: true, roomId: room.id, seat: null, role: 'spectator',
      token: t, state: publicState(room, t),
    });
  }

  if (parts[0] === 'api' && parts[1] === 'room' && parts[2]) {
    const room = rooms.get(parts[2].toUpperCase());
    if (!room) return sendJSON(res, 404, { ok: false, reason: '房间不存在或已过期。' });
    const action = parts[3];

    if (action === 'backup' && req.method === 'GET') {
      const backupData = {
        magic: 'FEIHUA_BACKUP',
        version: 1,
        exportedAt: Date.now(),
        roomId: room.id,
        isPrivate: !!room.isPrivate,
        round: roundOf(room.turnNo, room.cfg.playerCount),
        turnNo: room.turnNo,
        cfg: Object.assign({}, room.cfg),
        phase: room.phase,
        turn: room.turn,
        board: room.board.map((c) => ({ ch: c.ch, owner: c.owner })),
        log: room.log.slice(),
        reason: room.reason || '',
        seats: {
          A: room.seats.A ? { nick: room.seats.A.nick } : null,
          B: room.seats.B ? { nick: room.seats.B.nick } : null,
          C: room.seats.C ? { nick: room.seats.C.nick } : null,
          D: room.seats.D ? { nick: room.seats.D.nick } : null,
        },
        paused: room.paused ? { by: room.paused.by, left: room.paused.left, why: room.paused.why } : null,
        events: room.events.slice(-50),
      };
      return sendJSON(res, 200, { ok: true, backup: backupData });
    }

    if (action === 'peek' && req.method === 'GET') {
      const t = u.searchParams.get('t');
      /* 刷新 / 后退回来：页面卸载时替玩家发过安静的离开，这里凭同一个 token 原样接回 */
      if (!memberOf(room, t)) recallSeat(room, t);
      if (!memberOf(room, t)) return sendJSON(res, 401, { ok: false, reason: '身份失效' });
      touchMember(room, t);            /* 能带着有效 token 来问，说明人还在 */
      return sendJSON(res, 200, { ok: true, state: publicState(room, t) });
    }

    /* 心跳：客户端每 20 秒报一次「我还在」。这是「半开连接」唯一的解法 ——
       人走了、连接没断时，只有心跳停下能证明他真的走了。 */
    if (action === 'beat' && req.method === 'POST') {
      const body = await readBody(req);
      const t = String(body.t || '');
      if (!memberOf(room, t)) recallSeat(room, t);
      if (!touchMember(room, t, true)) {
        return sendJSON(res, 401, { ok: false, reason: '身份无效。' });
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (action === 'events' && req.method === 'GET') {
      const t = u.searchParams.get('t');
      if (!memberOf(room, t)) recallSeat(room, t);
      const me = memberOf(room, t);
      if (!me) return sendJSON(res, 401, { ok: false, reason: '身份无效。' });
      const rec = me.seat ? room.seats[me.seat] : room.watchers.get(t);
      /* 连上 SSE 就是「刚活动过」；但不置 beatSeen —— 会不会报心跳要等 /beat 才知道 */
      if (rec) { rec.online = true; rec.offlineAt = 0; rec.beatAt = Date.now(); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      res.write('data: ' + JSON.stringify({ type: 'state', state: publicState(room, t) }) + '\n\n');
      /* 客户端突然断线时 socket 会发 error（ECONNRESET）；没人接就是未捕获异常 */
      res.on('error', () => { try { res.destroy(); } catch (_) {} });
      if (!clients.has(room.id)) clients.set(room.id, new Set());
      const client = { token: t, res };
      clients.get(room.id).add(client);
      markOnline(room, t);
      broadcast(room);
      const ping = setInterval(() => {
        if (!sseAlive(client)) { clearInterval(ping); return; }
        sseWrite(client, ': ping\n\n');
      }, 20000);
      req.on('close', () => {
        clearInterval(ping);
        const set = clients.get(room.id);
        if (set) set.delete(client);
        /* 同一 token 还有别的标签页连着 → 仍然算在线 */
        if (hasOtherLink(room.id, t, client)) return;
        markOffline(room, t);
        broadcast(room);
      });
      return;
    }

    /* ---------- 席位：选手下场 / 观众补位 ---------- */
    if (action === 'stand' && req.method === 'POST') {
      const body = await readBody(req);
      const m = memberOf(room, body.t);
      if (!m) return sendJSON(res, 401, { ok: false, reason: '身份无效。' });
      return sendJSON(res, 200, standUp(room, body.t));
    }

    if (action === 'seat' && req.method === 'POST') {
      const body = await readBody(req);
      const m = memberOf(room, body.t);
      if (!m) return sendJSON(res, 401, { ok: false, reason: '身份无效。' });
      return sendJSON(res, 200, takeSeat(room, body.t, String(body.seat || 'A').toUpperCase()));
    }

    /* ---------- 改昵称 / 离开 / 移出成员 ---------- */
    if (action === 'nick' && req.method === 'POST') {
      const body = await readBody(req);
      const m = memberOf(room, body.t);
      if (!m) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      return sendJSON(res, 200, renameMember(room, body.t, body.nick, {
        random: body.random === true,
        key: nickKeyOf(req, body.uid),
      }));
    }

    if (action === 'leave' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, leaveRoom(room, body.t, !!body.quiet));
    }

    if (action === 'kick' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, kickMember(room, body.t, String(body.mid || '')));
    }

    /* ---------- 争议裁决 ----------
       裁决权：对手席位的选手，或裁判。提交方本人（只能是他自己的席位）调这里＝撤回；
       普通观众一律无权（前端也不给他看按钮）。 */
    if (action === 'dispute' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      if (!a.seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-player', reason: '只有场上的选手或裁判能裁决，普通观众不能判定。' });
      }
      if (room.cfg.playerCount === 1) {
        return sendJSON(res, 400, { ok: false, reason: '单人模式无争议裁决。' });
      }
      return sendJSON(res, 200, resolveDispute(room, a, !!body.accept));
    }

    if (action === 'move' && req.method === 'POST') {
      const body = await readBody(req);
      const seat = seatOf(room, body.t);
      if (!seat) return sendJSON(res, 401, { ok: false, reason: '你现在是观众，坐上空位才能出手。' });
      return sendJSON(res, 200, applyMove(room, seat, String(body.text || '')));
    }

    if (action === 'pass' && req.method === 'POST') {
      const body = await readBody(req);
      const seat = seatOf(room, body.t);
      if (!seat) return sendJSON(res, 401, { ok: false, reason: '只有场上的选手可以放弃。' });
      if (room.dispute) return sendJSON(res, 200, { ok: false, code: 'dispute', reason: '有一句诗正在等待裁决。' });
      if (room.paused) return sendJSON(res, 200, { ok: false, code: 'paused', reason: '对局已暂停。' });
      if (room.phase !== 'playing' || room.turn !== seat) {
        return sendJSON(res, 200, { ok: false, code: 'turn', reason: '还没到你。' });
      }
      applyPass(room, '主动放弃');
      return sendJSON(res, 200, { ok: true });
    }

    /* 准备：双方都点了才开始；点第二次就是取消准备 */
    if (action === 'ready' && req.method === 'POST') {
      const body = await readBody(req);
      const seat = seatOf(room, body.t);
      if (!seat) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      return sendJSON(res, 200, setReady(room, seat, body.ready !== false));
    }

    /* 暂停 / 继续：选手与裁判随时可用，其他人也能点继续 */
    if (action === 'pause' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      if (!a.seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-allowed', reason: '只有场上的选手或裁判能暂停对局。' });
      }
      return sendJSON(res, 200, pauseGame(room, a));
    }

    /* ---------- 开局设置 / 重抽棋盘 ----------
       正式开局前（waiting）：房主（赤营）、对手、裁判都能调。
       开局后一律锁死 —— 中途换盘面等于换了一局。 */
    if (action === 'cfg' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, applyCfg(room, body.t, body));
    }

    if (action === 'redraw' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, redrawBoard(room, body.t));
    }

    /* 自定义字库：粘贴一段文本，棋盘优先用里面的字，不够才由系统字库补。
       留空提交 = 撤下字库。只有开局前能改（与 cfg / redraw 同一档权限）。 */
    if (action === 'pool' && req.method === 'POST') {
      const body = await readBody(req, 128 * 1024);
      return sendJSON(res, 200, setPool(room, body.t, body.text));
    }

    /* 单格重随：开局前点棋盘上某一格换一个字 */
    if (action === 'reroll' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, rerollCell(room, body.t, body.index));
    }

    /* 裁判标记：在场选手把某个观众设成裁判 / 取消 */
    if (action === 'ref' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, setRef(room, body.t, String(body.mid || ''), body.on !== false));
    }

    /* 撤销一步 / 提前结算：
       选手点 → 只是「申请」，要对方（或裁判）点同意；
       裁判点 → 直接生效，不用等谁批 —— 裁判就是来处理这类事的。 */
    if (action === 'undo' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      if (!a.seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能撤销。' });
      }
      if (room.phase !== 'playing') return sendJSON(res, 200, { ok: false, code: 'phase', reason: '对局不在进行中，无法撤销。' });
      if (!room.undo.length) return sendJSON(res, 200, { ok: false, code: 'empty', reason: '已经是第一步，没有可撤销的记录。' });
      if (a.ref && !a.seat || (room.cfg.playerCount === 1)) {
        room.req = null;
        const snap = room.undo.pop();
        restore(room, snap);
        pushEvent(room, 'undo', a.nick + (room.cfg.playerCount === 1 ? ' 撤销了一步，回退到第 ' : '（裁判）撤销一步，回退到第 ') +
          roundOf(room.turnNo, room) + ' 轮',
          { mid: a.mid, byRef: !!a.ref });
        broadcast(room);
        return sendJSON(res, 200, { ok: true, accepted: true, undone: true, byRef: !!a.ref });
      }
      if (room.req) return sendJSON(res, 200, { ok: false, code: 'busy', reason: '已有待确认的请求，请先等对手回应。' });
      room.req = { type: 'undo', by: a.seat, at: Date.now() };
      pushEvent(room, 'req', a.nick + ' 请求「撤销一步」', { seat: a.seat });
      broadcast(room);
      return sendJSON(res, 200, { ok: true, req: room.req });
    }

    if (action === 'finish' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      if (!a.seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能提前结算。' });
      }
      if (room.phase !== 'playing') return sendJSON(res, 200, { ok: false, code: 'phase', reason: '对局不在进行中。' });
      if (a.ref && !a.seat || (room.cfg.playerCount === 1)) {
        room.req = null;
        finish(room, room.cfg.playerCount === 1 ? '单人提前结算' : '裁判提前结算');
        pushEvent(room, 'finish-by-ref', a.nick + (room.cfg.playerCount === 1 ? ' 提前结算' : '（裁判）提前结算'), { mid: a.mid, byRef: !!a.ref });
        broadcast(room);
        return sendJSON(res, 200, { ok: true, accepted: true, finished: true, byRef: !!a.ref });
      }
      if (room.req) return sendJSON(res, 200, { ok: false, code: 'busy', reason: '已有待确认的请求，请先等对手回应。' });
      room.req = { type: 'finish', by: a.seat, at: Date.now() };
      pushEvent(room, 'req', a.nick + ' 请求「提前结算」', { seat: a.seat });
      broadcast(room);
      return sendJSON(res, 200, { ok: true, req: room.req });
    }

    /* 对方点同意/拒绝；发起方自己调就是"取消请求"；裁判也可以代批 */
    if (action === 'consent' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效，请刷新。' });
      const seat = a.seat;
      if (!seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能处理请求。' });
      }
      const r = room.req;
      if (!r) return sendJSON(res, 200, { ok: false, code: 'none', reason: '没有待确认的请求。' });
      if (seat && r.by === seat) {
        room.req = null;
        pushEvent(room, 'req-cancel', a.nick + ' 取消了自己的请求', { seat });
        broadcast(room);
        return sendJSON(res, 200, { ok: true, cancelled: true });
      }
      if (Date.now() - r.at > REQ_TTL) {
        room.req = null;
        broadcast(room);
        return sendJSON(res, 200, { ok: false, code: 'expired', reason: '请求已超时，需要重新发起。' });
      }
      const accept = !!body.accept;
      room.req = null;
      if (!accept) {
        pushEvent(room, 'req-deny', a.nick + ' 拒绝了' +
          (r.type === 'undo' ? '撤销一步' : '提前结算') + ' 的请求', { seat: seat || null, mid: a.mid });
        broadcast(room);
        return sendJSON(res, 200, { ok: true, denied: true });
      }
      if (r.type === 'undo') {
        const snap = room.undo.pop();
        if (!snap) {
          broadcast(room);
          return sendJSON(res, 200, { ok: false, code: 'empty', reason: '没有可撤销的记录。' });
        }
        restore(room, snap);
        pushEvent(room, 'undo', a.nick + ' 同意撤销，回退到第 ' +
          roundOf(room.turnNo, room) + ' 轮', { seat: seat || null, mid: a.mid });
        broadcast(room);
        return sendJSON(res, 200, { ok: true, accepted: true, undone: true });
      }
      if (r.type === 'finish') {
        finish(room, '提前结算');
        broadcast(room);
        return sendJSON(res, 200, { ok: true, accepted: true, finished: true });
      }
      broadcast(room);
      return sendJSON(res, 200, { ok: false, reason: '未知的请求类型。' });
    }

    /* 开新一局：选手或裁判都行（提前结算之后总得有人把台子重新摆起来） */
    if (action === 'rematch' && req.method === 'POST') {
      const body = await readBody(req);
      const a = actorOf(room, body.t);
      if (!a) return sendJSON(res, 401, { ok: false, reason: '身份无效。' });
      if (!a.seat && !a.ref) {
        return sendJSON(res, 403, { ok: false, code: 'not-allowed', reason: '只有在场选手或裁判能开新局。' });
      }
      if (requiredSeats(room).some((s) => !room.seats[s])) return sendJSON(res, 200, { ok: false, reason: '还没坐满。' });
      startPlay(room, true, true);
      pushEvent(room, 'rematch', a.nick + ' 开了新一局，等准备', { mid: a.mid });
      broadcast(room);
      return sendJSON(res, 200, { ok: true, waitingReady: true });
    }
  }

  /* 房间列表：大厅里显示「现在有哪些局」，可以直接点进去加入。
     只暴露公开信息（房号 / 昵称 / 规格 / 进度），绝不返回 token。 */
  if (u.pathname === '/api/rooms' && req.method === 'GET') {
    const now = Date.now();
    const dev = isDev(u);
    const list = [];
    for (const room of rooms.values()) {
      if (room.phase === 'finished') continue;
      /* 私密房间不出现在大厅列表中 —— 除非带了开发者口令：
         房号是 5 位随机码，看不到列表就没法点进去看自己的房。 */
      if (room.isPrivate && !dev) continue;
      /* 房里还有活人吗：以 aliveMember 为准（心跳），而不是看 online 标志。
         没人、也没席位的空壳不该占着大厅的位子。
         特别针对隐形观战：若场上已无活跃选手且无可见观众，对普通玩家一律隐藏，
         防止选手退出后发现该房依然留在大厅而暴露房内有隐形观众。 */
      const req = requiredSeats(room);
      const live = req.some((s) => room.seats[s] && aliveMember(room, room.seats[s], room.seats[s].token));
      /* 对普通玩家：没有活人选手、无可见观众、且无刷新中凭证的空房，绝不暴露在大厅中 */
      if (!dev && !live && visibleWatchers(room) === 0 && pruneRecall(room, now) === 0) continue;
      list.push({
        id: room.id,
        isPrivate: !!room.isPrivate,     /* 前端据此打「私密」标（只有开发者能收到这类条目） */
        host: room.seats.A ? room.seats.A.nick : '',
        size: room.cfg.size,
        rounds: room.cfg.rounds,
        endless: !!room.cfg.endless,
        turnSeconds: room.cfg.turnSeconds,
        playerCount: room.cfg.playerCount || 2,
        /* 大厅条目要能一眼看出「这局考什么文体、除棋盘外还多了几个字」 */
        kinds: KINDS.filter((k) => room.cfg.kinds && room.cfg.kinds[k]).join('') || '诗',
        extra: room.cfg.extra || 0,
        phase: room.phase,
        live,
        paused: !!room.paused,
        round: roundOf(room.turnNo, room),
        score: counts(room),
        ready: { A: !!room.ready.A, B: !!room.ready.B, C: !!room.ready.C, D: !!room.ready.D },
        players: {
          A: room.seats.A ? room.seats.A.nick : null,
          B: room.seats.B ? room.seats.B.nick : null,
          C: room.seats.C ? room.seats.C.nick : null,
          D: room.seats.D ? room.seats.D.nick : null,
        },
        /* 「加入」= 还有空位，并且还没开局。 */
        joinable: room.phase === 'waiting' && req.some((s) => !room.seats[s]),
        spectatable: true,
        watchers: visibleWatchers(room),
        hostOnline: !!(room.seats.A && aliveMember(room, room.seats.A, room.seats.A.token)),
        age: Math.round((now - room.createdAt) / 1000),
      });
    }
    /* 排序：正在打、且房里还有人 → 最前；其次能坐进去的；最后是满员观战的。
       同一档里新开在前。这里曾经只按 joinable 排，再截前 24 条，
       结果大厅攒下二十几个没人管的空等房之后，真正在进行的局直接被挤掉了。 */
    const rank = (r) => (r.phase === 'playing' && r.live ? 0 : r.joinable ? 1 : 2);
    list.sort((x, y) => (rank(x) - rank(y)) || (x.age - y.age));
    return sendJSON(res, 200, { ok: true, rooms: list.slice(0, 60), total: list.length });
  }

  /* ---------- 语料查验与协作检视 API（公开只读） ---------- */
  if (u.pathname === '/api/corpus/summary') {
    return sendJSON(res, 200, { ok: true, data: judgeMod.getCorpusSummary() });
  }

  if (u.pathname === '/api/corpus/search') {
    const q = u.searchParams.get('q') || '';
    const limit = u.searchParams.get('limit') || 30;
    return sendJSON(res, 200, { ok: true, data: judgeMod.searchPoems(q, limit) });
  }

  if (u.pathname === '/api/corpus/probe') {
    const q = u.searchParams.get('q') || '';
    const limit = u.searchParams.get('limit') || 15;
    return sendJSON(res, 200, { ok: true, data: judgeMod.probeCorpus(q, limit) });
  }

  if (u.pathname === '/api/stats') {
    /* pid 是给自测用的：Windows 上 SO_REUSEADDR 允许两个进程同时绑同一个端口，
       「端口上有人回答」不等于「回答的是我刚起的那个进程」。测试靠它自证。
       rss 是给「内存有没有一路涨到 OOM」这个疑问留的观测点。
       2026-10-23 那次整站 504 就是它：语料扩到 27.6M 字之后，V8 默认堆上限太大、
       迟迟不回收，rss 一路漂到 1048MB 被容器 OOM 掉。所以这里多给三个数：
         rssPeak —— 本进程运行以来的峰值（漂到多少才危险，一眼看得出）
         heapLimit —— V8 的堆上限（`--max-old-space-size` 有没有真的生效，全靠它证明）
         maxOldSpace —— 启动参数里那个值，没写就是 undefined */
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1048576);
    if (rssMB > rssPeakMB) rssPeakMB = rssMB;
    return sendJSON(res, 200, {
      judge: stats || { pending: true }, rooms: rooms.size, uptime: Math.round(process.uptime()), pid: process.pid,
      rss: rssMB, rssPeak: rssPeakMB, heapUsed: Math.round(mem.heapUsed / 1048576),
      heapLimit: Math.round(heapLimitBytes / 1048576),
      maxOldSpace: maxOldSpaceArg() || null,
    });
  }

  /* 只在 TEST_HOOKS=1 时存在：让测试可以从外面制造一次真正的未捕获异常 /
     未处理拒绝，验证「进程不会因此退出」这条兜底。线上不设这个变量，路由根本不存在。 */
  if (u.pathname === '/api/_test_throw' && req.method === 'POST' && process.env.TEST_HOOKS === '1') {
    const mode = u.searchParams.get('mode') || 'uncaught';
    setTimeout(() => {
      if (mode === 'rejection') Promise.reject(new Error('测试用的未处理拒绝'));
      else throw new Error('测试用的未捕获异常');
    }, 10);
    return sendJSON(res, 200, { ok: true, mode });
  }

  /* 只在 TEST_HOOKS=1 时存在：证明 sseWrite 对「已经不能写的响应」真的不写。
     write-after-end 是异步抛的，真环境下要复现得靠运气（客户端得在广播那一刻恰好断开），
     所以这里直接喂三种「不该写」的假 res：它们的 write() 会**安安静静成功**，
     于是「有没有写」只取决于那三个状态判断 —— 判断被删掉，测试立刻红。 */
  if (u.pathname === '/api/_test_sse_write' && req.method === 'POST' && process.env.TEST_HOOKS === '1') {
    const okWrite = () => true;
    const ended = { res: { writableEnded: true, destroyed: false, writable: false, write: okWrite } };
    const gone = { res: { writableEnded: false, destroyed: true, writable: false, write: okWrite } };
    const half = { res: { writableEnded: false, destroyed: false, writable: false, write: okWrite } };
    const alive = { res: { writableEnded: false, destroyed: false, writable: true, write: okWrite } };
    return sendJSON(res, 200, {
      ok: true, ended: sseWrite(ended, 'x'), destroyed: sseWrite(gone, 'x'),
      halfClosed: sseWrite(half, 'x'), nullish: sseWrite(null, 'x'),
      alive: sseWrite(alive, 'x'),   /* 正常的照写，别把保护做成「一律不写」 */
    });
  }

  /* 大厅昵称预填：前端只在输入框还空着时用一次。
     不给缓存，免得几个人同时打开拿到同一个名字。 */
  if (u.pathname === '/api/rand-name') {
    return sendJSON(res, 200, { ok: true, name: judgeMod.randomAuthor() });
  }

  /* 「我今天还能自定义改名吗」—— 前端在保存前先问一次。
     知道了就能提前劝住，而不是等玩家输入完一整句话再被拒。
     uid 是 32 位随机串，猜不到；这里不返回任何能反查身份的东西，只回时间。
     带上 nick 时再多回几个判断（isCustom / unchanged / willBlock / needsPay）——
     大厅建房、加入那一路没有「输入框失焦」这种时机，只能靠它决定要不要弹窗。 */
  if (u.pathname === '/api/nick-status' && req.method === 'GET') {
    const key = nickKeyOf(req, u.searchParams.get('uid'));
    const q = nickQuota(key);
    const out = {
      ok: true, canRename: q.ok, retryAt: q.retryAt, waitMs: q.waitMs,
      gapMs: NICK_GAP_MS, lastNick: q.lastNick || '',
    };
    const want = String(u.searchParams.get('nick') || '').trim().slice(0, 12);
    if (want) {
      const isAuthorName = judgeMod.isAuthor(want);
      const unchanged = !!q.lastNick && q.lastNick === want;
      out.isAuthorName = isAuthorName;
      out.isCustom = !isAuthorName;
      out.unchanged = unchanged;
      out.willBlock = !isAuthorName && !unchanged && !q.ok;
      out.needsPay = !isAuthorName && !unchanged && q.ok;
    }
    return sendJSON(res, 200, out);
  }

  sendJSON(res, 404, { ok: false, reason: 'no such api' });
}

function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  /* 整个请求入口包一层：`new URL()` 遇到畸形请求行（扫描器、裸 TCP、Host 里塞怪字符）
     会**同步抛错**，而请求监听器里的同步异常没有任何 catch —— 直接升级成
     uncaughtException，整个进程退出。2026-10-22 早上那次三小时 504 的高度疑似原因。 */
  try {
    const u = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    if (u.pathname.startsWith('/api/')) {
      api(req, res, u).catch((e) => {
        console.error(e);
        try { sendJSON(res, 500, { ok: false, reason: 'server error' }); } catch (_) {}
      });
      return;
    }
    /* 审阅页：口令不对连页面都不给，避免被随手翻到 */
    if (u.pathname === '/admin' || u.pathname === '/admin/') {
      if (u.searchParams.get('key') !== ADMIN_KEY) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('需要口令：在地址后加 ?key=……（口令在项目的 admin.key 里）');
      }
      return fs.readFile(path.join(PUBLIC, 'admin.html'), (err, buf) => {
        if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('缺少 admin.html'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    serveStatic(req, res, u);
  } catch (e) {
    logCrash('request', e);
    console.error('[request] ' + (e && e.stack ? e.stack : e));
    try {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
    } catch (_) {}
  }
});

/* 掉线清扫。顺序很重要：
   1) 先把「心跳停了但 online 还挂着」的人校准成离线（半开连接的唯一出口）；
   2) 再看房间里还有没有活人 —— 一个都没有就直接收房，别让空壳钉在大厅；
   3) 最后按掉线时长处理：观众 2 分钟移出、选手 5 分钟下场。
   这样「关掉网页的人」不会一直挂在房间里占着位子。 */
function sweepAll() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    let changed = false;

    /* 1) 校准在线状态：有心跳的按心跳判，心跳停了就当作人已经走了。
       offlineAt 记在「最后一次心跳」上 —— 他真正离开的时刻，而不是被发现迟到时刻。 */
    const stale = (rec, t) => {
      if (!rec || !rec.online) return;
      if (aliveMember(room, rec, t)) return;
      markOffline(room, t, rec.beatSeen ? (rec.beatAt || now) : now);
      changed = true;
    };
    for (const s of ALL_SEATS) if (room.seats[s]) stale(room.seats[s], room.seats[s].token);
    for (const [t, w] of room.watchers) stale(w, t);

    /* 2) 房间里已经没有任何活人（席位空着、剩下的都是幽灵）→ 直接收房。
       正在打的局若席位上还有掉线选手，多给一点时间（5分钟接回），但若席位已全空且无可见观众，
       绝不因开发者隐形挂着而不散。刚发生过「刷新式离开」的（recall 还有效）先留着，等他刷新回来。 */
    const anyAlive = ALL_SEATS.some((s) => room.seats[s] && aliveMember(room, room.seats[s], room.seats[s].token)) ||
      Array.from(room.watchers.entries()).some(([t, w]) => !w.hidden && aliveMember(room, w, t));
    const allSeatsEmpty = ALL_SEATS.every((s) => !room.seats[s]);
    if (!anyAlive && (room.phase !== 'playing' || allSeatsEmpty) && pruneRecall(room, now) === 0) {
      dropRoom(room);
      continue;
    }

    /* 3) 选手长时间无响应 → 自动下场（standUp 内部会冻结计时、收掉争议） */
    for (const s of ALL_SEATS) {
      const p = room.seats[s];
      if (!p) continue;
      const since = goneSince(p, now);
      if (since && now - since > SEAT_AWAY_MS) {
        standUp(room, p.token, '掉线超过 ' + Math.round(SEAT_AWAY_MS / 60000) + ' 分钟');
        changed = true;
      }
    }

    /* 观众掉线（或进来后一直没打开页面）→ 直接移出名单。
       「join 了却从没连上 SSE」的，只在名单里挂 30 秒 —— 那是没打开成功的页面，
       留它两分钟只会在成员列表里堆出一串同名幽灵。 */
    for (const [t, w] of room.watchers) {
      const since = goneSince(w, now);
      if (!since) continue;
      const limit = w.everOnline ? WATCH_AWAY_MS : 30 * 1000;
      if (now - since > limit) {
        room.watchers.delete(t);
        if (!w.hidden) {
          pushEvent(room, 'sweep', w.nick + (w.everOnline ? ' 掉线超时，已移出房间' : ' 一直没进来，已移出房间'),
            { mid: w.mid });
        }
        changed = true;
      }
    }

    if (changed) broadcast(room);

    /* 空壳房间（没有席位、也没有观众）直接清掉：否则大厅会被一堆「早就没人」的房号
       占满，真正在打的局反而被挤出列表。 */
    if (isEmptyRoom(room)) { dropRoom(room); continue; }

    if (now - room.createdAt > ROOM_TTL) dropRoom(room);
  }
}

/* 清扫跑在 setInterval 里 —— 回调抛错没人接，等于把整个进程带走。
   一轮出问题只该丢这一轮，不该让所有房间一起消失。 */
setInterval(() => {
  try { sweepAll(); } catch (e) {
    logCrash('sweep', e);
    console.error('[sweep] ' + (e && e.stack ? e.stack : e));
  }
}, SWEEP_MS);

/* ================= 房间快照：发布时保住正在进行的对局 =================
   为什么要有它 —— 发布新版本 = 覆盖沙箱代码 + 容器重启，房间只活在内存里，
   一发布所有对局当场消失，玩家回来只看到「房间不存在」。这不是 bug，是一直没做的功课。

   序列化只挑纯数据：`timer` 是 Timeout 句柄、`clients` 里是 SSE 的 res，都不可序列化；
   `watchers` / `refs` / `recall` 三个 Map 转成数组，恢复时再转回来。
   `deadline` 存的是绝对时间戳，恢复时按墙钟重算 —— 停机期间耗掉的时间不算在玩家头上。 */

let snapDirty = false;
let snapAt = 0;          /* 最后一次成功写盘的时刻 */
let snapErr = 0;         /* 连续失败次数（退避用，别把日志刷爆） */
let snapRooms = 0;       /* 上一次写进快照的房间数，用来发现「房间被收掉了」 */
let snapWhy = '';        /* 最后一次写盘的原因：timer / signal:SIGTERM / crash */
let lastRestore = null;  /* 本次启动的恢复结果，审阅页直接看它 */

function snapMember(m) {
  if (!m) return null;
  return {
    nick: m.nick, token: m.token, mid: m.mid,
    online: !!m.online, offlineAt: m.offlineAt || 0, at: m.at || 0,
    everOnline: !!m.everOnline, beatAt: m.beatAt || 0, beatSeen: !!m.beatSeen,
    since: m.since || 0, restoredAt: m.restoredAt || 0,
    hidden: !!m.hidden,          /* 开发者标签要跟着落盘，否则发布一次就冒出来了 */
  };
}

function snapRoom(room) {
  return {
    id: room.id, isPrivate: !!room.isPrivate, createdAt: room.createdAt,
    startedAt: room.startedAt, finishedAt: room.finishedAt, cfg: room.cfg,
    phase: room.phase, board: room.board,
    turn: room.turn, turnNo: room.turnNo, order: room.order,
    log: room.log, reason: room.reason, deadline: room.deadline,
    undo: room.undo, req: room.req, ready: room.ready,
    vacant: room.vacant, paused: room.paused, dispute: room.dispute,
    /* 自定义字库要一起落盘：否则发布重启后房间恢复了，字库却没了 ——
       盘面上还是那些字，但玩家再点格子就换不到字库里去了。 */
    pool: room.pool,
    events: room.events.slice(-80),        /* 流水只留最近 80 条，别让快照无限长大 */
    seats: {
      A: snapMember(room.seats.A),
      B: snapMember(room.seats.B),
      C: snapMember(room.seats.C),
      D: snapMember(room.seats.D),
    },
    watchers: Array.from(room.watchers, ([t, w]) => [t, snapMember(w)]),
    refs: Array.from(room.refs),
    recall: Array.from(room.recall),
  };
}

let restoreDone = false;

function markSnapDirty() { snapDirty = true; }

/* 同步写盘。SIGTERM 之后进程随时会被 SIGKILL，异步写根本跑不完。
   先写 .tmp 再改名：避免「写到一半被杀」留下一个残缺的 JSON，把恢复也带崩。 */
function flushSnapshot(why) {
  // 防自杀保护：
  // 1) 崩溃落盘时若内存无房间，坚决不写盘（防止启动期异常将磁盘快照覆写为 rooms: []）
  if (why === 'crash' && rooms.size === 0) {
    console.warn('[snap] 崩溃时内存房间数为 0，为保护磁盘快照跳过落盘');
    return false;
  }
  // 2) 启动恢复未就绪时，若 rooms 为空，禁止在信号退出时覆盖现有快照
  if (!restoreDone && rooms.size === 0 && (why === 'crash' || String(why).startsWith('signal:'))) {
    console.warn('[snap] 启动恢复未完成且房间数为 0，跳过落盘保护现有快照');
    return false;
  }
  const payload = {
    schema: SNAP_SCHEMA, at: Date.now(), pid: process.pid,
    dir: SNAP_ENV,             /* 环境指纹，见 SNAP_ENV 注释 */
    why: why || 'timer',
    rooms: Array.from(rooms.values(), snapRoom),
  };
  let txt;
  try { txt = JSON.stringify(payload); } catch (e) {
    console.error('[snap] 序列化失败：' + e.message);
    return false;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAP_TMP, txt);
    // 滚动双备份：写新快照前，先将当前已有的有效快照保留到 .bak
    if (fs.existsSync(SNAP_FILE)) {
      try {
        const curStat = fs.statSync(SNAP_FILE);
        if (curStat.size > 0) fs.copyFileSync(SNAP_FILE, SNAP_BAK_FILE);
      } catch (_) {}
    }
    fs.renameSync(SNAP_TMP, SNAP_FILE);
    snapDirty = false; snapAt = payload.at; snapErr = 0;
    snapRooms = payload.rooms.length; snapWhy = payload.why;
    return true;
  } catch (e) {
    snapErr++;
    if (snapErr <= 3 || snapErr % 50 === 0) {
      console.error('[snap] 写快照失败（第 ' + snapErr + ' 次）：' + e.message);
    }
    return false;
  }
}

/* ---------- 恢复 ---------- */

/* 恢复出来的成员：连接早就不存在了，所以 online=false，掉线计时也从「恢复这一刻」重新起算。
   restoredAt 是给 aliveMember 看的：RESTORE_GRACE_MS 内一律算他在，留出重连的时间；
   否则新进程第一轮清扫就会把「只有快照、没有连接」的房间当空房收掉。 */
function reviveMember(m, now) {
  if (!m || !m.token) return null;
  return {
    nick: String(m.nick || '无名').slice(0, 12) || '无名',
    token: String(m.token),
    mid: String(m.mid || ('m' + crypto.randomBytes(3).toString('hex'))),
    online: false,
    offlineAt: now,
    at: Number(m.at) || now,
    everOnline: !!m.everOnline,
    beatAt: now,
    beatSeen: !!m.beatSeen,
    since: Number(m.since) || now,
    restoredAt: now,
    hidden: !!m.hidden,
  };
}

/* 时钟：本来在走表的，按剩余时间重挂 setTimeout。停机期间已经超时的**不按超时判负**
   （那对玩家太狠），改成暂停并记一条事件，任一方点「继续」就接着打。 */
function reviveClock(room, now) {
  if (room.phase !== 'playing') { room.deadline = 0; return; }
  if (room.paused) { room.deadline = now + Math.max(1000, room.paused.left || 0); return; }
  const req = requiredSeats(room);
  if (req.some((s) => !room.seats[s])) { room.deadline = 0; return; }   /* 缺人：等补位自动续 */
  const left = (Number(room.deadline) || 0) - now;
  if (left > 1000) { startTimer(room, left); return; }
  const full = Math.max(5000, (Number(room.cfg.turnSeconds) || TURN_SECONDS_DEFAULT) * 1000);
  room.paused = { by: null, left: full, at: now, why: 'restore' };
  room.deadline = now + full;
  pushEvent(room, 'restore', '服务更新期间本步超时了，计时已重置，点「继续」接着打');
}

/* 恢复字库：形状不对就当没有，绝不把半套字喂进 buildBoard。
   SNAP_SCHEMA 不因为这个字段 +1：pool 是可选的，旧快照没有它照样能恢复对局，
   为它升版本会白白丢掉线上正在跑的房间。 */
function revivePool(p) {
  if (!p || !Array.isArray(p.chars)) return null;
  const chars = p.chars
    .filter((ch) => typeof ch === 'string' && ch.length === 1)
    .slice(0, POOL_MAX);
  if (!chars.length) return null;
  return {
    chars,
    total: Number(p.total) || chars.length,
    at: Number(p.at) || 0,
    by: String(p.by || ''),
  };
}

function reviveRoom(r, now, schema) {
  const rawCfg = Object.assign({}, r.cfg);
  if (!schema || schema < 2) {
    rawCfg.playerCount = rawCfg.playerCount || 2;
  }
  const cfg = sanitizeCfg(rawCfg);
  const n = cfg.size * cfg.size;
  /* 盘面大小对不上 = 快照坏了，宁可丢掉这一局，也不要把半套数据喂进正在跑的规则里 */
  if (!Array.isArray(r.board) || r.board.length !== n) return null;
  const room = {
    id: String(r.id),
    isPrivate: !!r.isPrivate,
    createdAt: Number(r.createdAt) || now,
    startedAt: Number(r.startedAt) || Number(r.createdAt) || now,
    finishedAt: Number(r.finishedAt) || null,
    cfg,
    seats: {
      A: reviveMember(r.seats && r.seats.A, now),
      B: reviveMember(r.seats && r.seats.B, now),
      C: reviveMember(r.seats && r.seats.C, now),
      D: reviveMember(r.seats && r.seats.D, now),
    },
    phase: r.phase === 'playing' ? 'playing' : (r.phase === 'finished' ? 'finished' : 'waiting'),
    pool: revivePool(r.pool),
    board: r.board.map((x) => ({
      ch: String((x && x.ch) || ''),
      owner: x && ALL_SEATS.includes(x.owner) ? x.owner : null,
    })),
    turn: ALL_SEATS.includes(r.turn) ? r.turn : 'A',
    turnNo: Math.max(1, Number(r.turnNo) || 1),
    log: Array.isArray(r.log) ? r.log : [],
    deadline: 0,
    timer: null,
    order: typeof r.order === 'string' ? r.order : 'ABCD'.slice(0, cfg.playerCount),
    reason: String(r.reason || ''),
    undo: Array.isArray(r.undo) ? r.undo : [],
    req: null,        /* 挂着等对方点「同意」的撤销 / 结算，现在没人盯着了，一律作废 */
    ready: {
      A: !!(r.ready && r.ready.A),
      B: !!(r.ready && r.ready.B),
      C: !!(r.ready && r.ready.C),
      D: !!(r.ready && r.ready.D),
    },
    vacant: {
      A: (r.vacant && r.vacant.A) || null,
      B: (r.vacant && r.vacant.B) || null,
      C: (r.vacant && r.vacant.C) || null,
      D: (r.vacant && r.vacant.D) || null,
    },
    recall: new Map(Array.isArray(r.recall) ? r.recall : []),
    paused: null,
    watchers: new Map(),
    dispute: null,
    refs: new Map(Array.isArray(r.refs) ? r.refs : []),
    events: Array.isArray(r.events) ? r.events.slice(-EVENT_MAX) : [],
    restoredAt: now,
  };
  for (const pair of (Array.isArray(r.watchers) ? r.watchers : [])) {
    if (!Array.isArray(pair)) continue;
    const rec = reviveMember(pair[1], now);
    if (rec) room.watchers.set(String(pair[0]), rec);
  }
  if (r.paused && typeof r.paused === 'object' && Number(r.paused.left) > 0) {
    room.paused = {
      by: r.paused.by || null,
      left: Math.max(1000, Number(r.paused.left)),
      at: now,
      why: r.paused.why || 'manual',
    };
    if (r.paused.byNick) room.paused.byNick = r.paused.byNick;
    if (r.paused.byMid) room.paused.byMid = r.paused.byMid;
    if (r.paused.byRef) room.paused.byRef = true;
  } else if (r.dispute) {
    pushEvent(room, 'restore', '服务更新：有一句待裁决的提交已取消，请重新提交');
  }
  reviveClock(room, now);
  return room;
}

/* 启动时调一次。优先读主快照；若主快照文件不存在则尝试读 .bak 备份。
   所有「不敢恢复」的情况都只是不恢复，绝不会把坏数据塞进内存：
   文件不存在（磁盘被换过）、JSON 坏了、版本不符、快照太旧 —— 一律退回「空房间」。 */
function restoreSnapshot() {
  let raw;
  let fromBak = false;
  try {
    raw = fs.readFileSync(SNAP_FILE, 'utf8');
  } catch (_) {
    try {
      raw = fs.readFileSync(SNAP_BAK_FILE, 'utf8');
      fromBak = true;
    } catch (_) {
      return (lastRestore = { ok: true, rooms: 0, skipped: 0, age: 0,
        why: '没有快照文件（首次启动，或磁盘被换过）' });
    }
  }
  let p = null;
  try { p = JSON.parse(raw); } catch (e) {
    return (lastRestore = { ok: false, rooms: 0, skipped: 0, age: 0,
      why: '快照解析失败，整份丢弃：' + e.message });
  }
  // 向后兼容支持：1 <= schema <= SNAP_SCHEMA
  if (!p || typeof p.schema !== 'number' || p.schema < 1 || p.schema > SNAP_SCHEMA) {
    return (lastRestore = { ok: false, rooms: 0, skipped: 0, age: 0,
      why: '快照版本不符（' + (p && p.schema) + ' 不在 1..' + SNAP_SCHEMA + ' 范围），整份丢弃' });
  }
  const now = Date.now();
  const age = now - (Number(p.at) || 0);
  if (!(age >= 0) || age > SNAP_MAX_AGE_MS) {
    return (lastRestore = { ok: false, rooms: 0, skipped: 0, age,
      why: '快照是 ' + Math.round(age / 60000) + ' 分钟前的，超过 ' +
        Math.round(SNAP_MAX_AGE_MS / 60000) + ' 分钟不恢复' });
  }
  /* 环境指纹：本地开发机漏删的快照会被发布带上线，绝不能拿它冒充线上房间。
     没有 dir 字段的是放宽窗口之前写的老快照（那时只可能是线上自己写的），照旧放行。 */
  if (p.dir && p.dir !== SNAP_ENV) {
    return (lastRestore = { ok: false, rooms: 0, skipped: 0, age,
      why: '快照是另一个环境写的（' + p.dir + '），本机是 ' + SNAP_ENV + '，不恢复' });
  }
  let n = 0, skipped = 0;
  /* 房间寿命只算「真的在跑」的那段时间：停机期间玩家根本进不来，不该白烧 ROOM_TTL 的额度。
     按快照时刻的年龄判 TTL，再把 createdAt 平移到 now 之前同样的位置 ——
     恢复出来的房间剩余寿命和它挂掉那一刻完全一致。
     （只把 SNAP_MAX_AGE_MS 放宽是不够的：停机 10 小时后房间年龄必然超过 ROOM_TTL，
      那一行 `now - createdAt > ROOM_TTL` 会把所有房间全部 skip 掉，窗口放宽等于没做。） */
  const snapAt = Number(p.at) || now;
  for (const r of (Array.isArray(p.rooms) ? p.rooms : [])) {
    const id = r && r.id ? String(r.id) : '';
    if (!id || rooms.has(id)) { skipped++; continue; }
    const born = Number(r.createdAt) || snapAt;
    const livingMs = Math.max(0, snapAt - born);      /* 挂掉那一刻，这间房已经活了多久 */
    if (livingMs > ROOM_TTL) { skipped++; continue; }
    r.createdAt = now - livingMs;                     /* 把停机时长从房间寿命里扣掉 */
    /* 逐间兜底：一间房的快照形状不对，不该连累其余九间（更不该在 listen 之前把进程带走 ——
       那是「重启一次就再也起不来」的典型症状）。 */
    let room = null;
    try { room = reviveRoom(r, now, p.schema); } catch (e) {
      logCrash('restore-room', e);
      skipped++;
      continue;
    }
    if (!room) { skipped++; continue; }
    rooms.set(room.id, room);
    pushEvent(room, 'restore', '服务刚更新过，这一局原样接回来了');
    n++;
  }
  if (fromBak && n > 0) {
    console.log('[restore] 主快照缺失，已自动从备份快照 (.bak) 接回 ' + n + ' 个房间！');
  }
  return (lastRestore = { ok: true, rooms: n, skipped, age, why: fromBak ? '从备份快照恢复' : '' });
}

/* 定时器：有脏数据、或者房间数变了（有人走了要跟着改快照）才写，其余时候一个字节都不写。 */
const snapTimer = setInterval(() => {
  if (!snapDirty && rooms.size === snapRooms) return;
  try { flushSnapshot('timer'); } catch (e) {
    logCrash('snapshot', e);   /* 磁盘写不进去（满了 / 只读）不该把进程带走 */
    console.error('[snap] ' + (e && e.stack ? e.stack : e));
  }
}, SNAP_MS);
snapTimer.unref();

/* ---------- 退出与崩溃：最后一发落盘 ----------
   平台停容器先发 SIGTERM，过一会儿才 SIGKILL，所以必须在这一刻同步写完。
   顺手给还连着的页面塞一条注释帧：它是「服务端在更新」，不是玩家自己断网。
   前端仍按原来的逻辑走断线遮罩 → 重连 → peek 成功就收起遮罩，不用改。 */
let stopping = false;
function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  const ok = flushSnapshot('signal:' + sig);
  for (const set of clients.values()) {
    for (const c of set) sseWrite(c, ': bye ' + sig + '\n\n');
  }
  console.log('[shutdown] 收到 ' + sig + ' → ' + (ok ? '已把 ' + rooms.size + ' 个房间落盘' : '落盘失败！'));
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/* 兜底：进程因为未捕获异常要死了，也先把房间存下来。以前没有这两个钩子，
   一个未捕获异常就等于静默退出、所有对局无声消失，日志里什么都没留。

   **2026-10-22 改了处理方式：默认「记下来、继续跑」，不再 exit(1)。**
   原因是那天早上 10:08 进程死掉之后，容器一直没有被重新拉起 —— 网关只会
   「等 30 秒 → 504」，三个小时整站不可用。对一个没有 supervisor 的单进程服务来说，
   「带着一点不确定继续服务」也比「确定性地全站下线」要好。
   本地想复现崩溃退出行为，设 CRASH_EXIT=1 即可。 */
function onFatal(kind, e) {
  const rec = logCrash(kind, e);
  console.error('[fatal] ' + kind + '：' + (e && e.stack ? e.stack : e));
  console.error('[fatal] 已写入 ' + path.basename(CRASH_FILE) + '（rss ' + rec.rssMB + 'MB，' + rec.rooms + ' 个房间）');
  try { flushSnapshot('crash'); } catch (_) {}
  if (process.env.CRASH_EXIT === '1') process.exit(1);
}
process.on('uncaughtException', (e) => onFatal('uncaught', e));
process.on('unhandledRejection', (e) => onFatal('rejection', e));

/* 恢复放在 listen 之前，所以它一旦抛错，进程就永远走不到 listen ——
   表现是「重启一次就再也起不来」，而且 boot.log 里连记录都没有（那行是在 listen 回调里写的）。
   这里再包一层：恢复失败最多丢掉这一批房间，绝不能挡住监听。 */
let restored;
try {
  restored = restoreSnapshot();
} catch (e) {
  logCrash('restore', e);
  restored = { ok: false, rooms: 0, skipped: 0, age: 0, why: '恢复过程抛错，整批跳过：' + (e && e.message) };
}
if (restored.rooms) {
  /* 立刻把「重算过的时钟、重新起算的掉线时刻」写回盘：
     万一刚起来又停一次，用的就是这一份，而不是上一次留下的旧 deadline。 */
  flushSnapshot('restore');
  console.log('[restore] 接回 ' + restored.rooms + ' 个房间（快照年龄 ' +
    Math.max(0, Math.round((restored.age || 0) / 1000)) + ' 秒，跳过 ' + restored.skipped + ' 个）');
} else if (!restored.ok) {
  console.log('[restore] 没有恢复任何房间：' + restored.why);
}
restoreDone = true;

/* 监听失败（端口被占、权限不足）走的是 'error' 事件，没人接就是未捕获异常 → 进程退出。
   表现同样是「网关等 30 秒 → 504」。EADDRINUSE 多半是同一容器里上一个进程还没退干净，
   等一两秒再试通常就好了，所以这里退避重试几次，并把失败记进 crash.log。

   **重试用尽必须退出**（2026-10-23 补）。旧写法重试 5 次就不管了，进程于是活着、
   却永远不监听 —— 网关一直 504，boot.log 一行不写，crash.log 里只有几条 EADDRINUSE。
   这种「僵尸态」比干脆死掉更糟：守护进程看不到它死，就不会重拉；我们也没法从记录里分辨它。
   宁可退出让平台重试（它起不来是它的事，至少状态是「明确的死」）。 */
let listenTries = 0;
const LISTEN_MAX_TRIES = 5;
server.on('error', (e) => {
  logCrash('listen', e);
  console.error('[listen] ' + (e && e.stack ? e.stack : e));
  if (!server.listening && listenTries < LISTEN_MAX_TRIES) {
    listenTries++;
    setTimeout(() => { try { server.listen(PORT); } catch (_) {} }, 1000 * listenTries);
    return;
  }
  /* 端口被别人占着、重试也过不去 —— 别装死，退出等重启 */
  console.error('[listen] ' + LISTEN_MAX_TRIES + ' 次都没绑上端口 ' + PORT + '，退出等重启');
  logCrash('listen-giveup', new Error('重试 ' + LISTEN_MAX_TRIES + ' 次仍未能监听端口 ' + PORT + '（' + (e && e.code) + '）'));
  try { flushSnapshot('listen-giveup'); } catch (_) {}
  process.exit(1);
});

/* 启动看门狗：20 秒还没进入监听状态就主动退出。
   覆盖「卡在莫名其妙的地方」这类问题 —— 症状同样是网关 504 + boot.log 无记录，
   而退出至少会给平台/日志一个明确信号。 */
const BOOT_WATCHDOG_MS = Number(process.env.BOOT_WATCHDOG_MS || 20000);
setTimeout(() => {
  if (server.listening) return;
  console.error('[boot] ' + BOOT_WATCHDOG_MS + 'ms 仍未监听，退出等重启');
  logCrash('boot-stuck', new Error('启动 ' + BOOT_WATCHDOG_MS + 'ms 后仍未监听（端口 ' + PORT + '）'));
  try { flushSnapshot('boot-stuck'); } catch (_) {}
  process.exit(1);
}, BOOT_WATCHDOG_MS).unref();

server.listen(PORT, () => {
  logBoot({
    /* bootMs 现在只到「端口可用」，不含语料加载 —— 这正是网关关心的那个数。
       语料加载耗时看 judgeMs（listen 那一刻还是 -1，预热完成后 /api/stats 里有真值）。 */
    port: PORT, bootMs: Math.round(process.uptime() * 1000), judgeMs: stats ? stats.ms : -1,
    /* 内存三件套：heapLimit 是 V8 真实上限（args 生效与否看它），
       maxOldSpace 是启动参数里写的值，rss 是此刻的占用 */
    heapLimit: Math.round(heapLimitBytes / 1048576),
    maxOldSpace: maxOldSpaceArg() || 0,
    rss: Math.round(process.memoryUsage().rss / 1048576),
    restored: restored.rooms, restoreWhy: restored.why || 'ok', restoreAge: restored.age || 0,
  });
  console.log('飞花斯普拉遁 · 在线  →  http://localhost:' + PORT);
  /* 起来那一刻先记一条：这一行就是「启动峰值」，和后面每 60 秒的曲线合起来看 */
  sampleMem();
  /* 端口已经在监听了，再去啃语料。顺序反过来就是 2026-10-24 那两次 SITES_START_FAILED。
     留 200ms 再开始：listen 是内核层面的绑定，但同步加载会**占住事件循环**
     （实测加载 2.2 秒期间 HTTP 请求全部排队），给平台的探活请求留个处理窗口。 */
  setTimeout(warmJudge, 200);
});
