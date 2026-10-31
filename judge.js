'use strict';
/* 飞花令判诗核心（服务端唯一裁判）
 *
 * 语料在内存里是一整块「按诗篇顺序、句与句之间用 \n 分隔」的文本：
 *   - 判定 = blob.indexOf(规范化后的句子)
 *   - 查询串不含 \n，所以命中必然落在同一句内部，不会跨句拼出假句
 *   - 命中位置 → 行号 → 二分出诗篇 → 标题/作者/朝代/文体
 *
 * 只用归一化 + 登记过的异文对，**不做通用模糊匹配**：
 * 5 字句编辑距离 1 的邻域是 5×3 万字量级，等于把所有伪造句都放行。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = path.join(__dirname, 'data');

const MIN_LEN = 2;        // 短于此直接拒
const MIN_FRAG = 5;       // 不是整句时，至少这么长才算「引用了一句」
const MAX_LEN = 40;
const KIND_RANK = { 诗: 1, 词: 1, 曲: 2, 赋: 3, 文: 4 };
/** 出处可信度（构建侧 prio_of 写进第 6 列，越小越好）：僧人转引垫底 → 朝代早者优先 → 文体。
 *  这里只用于「片段命中」时从多个候选句里挑出处；整句判定仍然唯一。 */
const PRIO_FALLBACK = 5000;

/* 异文/异体对：同一位置互换后仍算同一句。
   只收语义等价的写法；真正的版本异文（明月/看月）靠「多版本语料」覆盖，不在这里放宽。
   后 4 组是正字法差异（不是繁简），zhconv 不会处理，但通行本与底本经常只差这一字：
   《石灰吟》语料作「粉骨碎身**全**不怕」、教材作「**浑**不怕」——不加这组就会误拒真句。 */
const VAR_PAIRS = [
  ['干', '乾'], ['着', '著'], ['征', '徵'], ['于', '於'], ['余', '餘'],
  ['里', '裏'], ['云', '雲'], ['后', '後'], ['采', '採'], ['群', '羣'],
  ['峰', '峯'], ['杯', '盃'], ['岩', '巖'], ['叹', '嘆'], ['迹', '跡'],
  ['溪', '谿'], ['鸡', '鷄'], ['棋', '碁'], ['咏', '詠'], ['秘', '祕'],
  ['唯', '惟'], ['沈', '沉'], ['傍', '旁'], ['全', '浑'],
  ['棹', '櫂'], ['径', '迳'], ['阶', '堦'], ['蕊', '蘂'], ['暖', '煖'],
  ['并', '幷'], ['映', '暎'], ['递', '遰'], ['楫', '檝'], ['扫', '埽'],
  ['锁', '鏁'], ['佩', '珮'], ['垄', '垅'], ['剪', '翦'], ['筱', '筿'],
  ['莺', '鶑'], ['羁', '羇'], ['瓶', '缾'], ['净', '浄'], ['答', '荅'],
  ['梨', '棃'], ['岐', '歧'], ['粗', '麤'], ['攲', '欹'], ['粘', '黏'],
  ['碗', '椀'], ['餐', '飡'], ['隐', '隠'], ['只', '祗'], ['斗', '鬬'],
  ['鳌', '鳖'], ['虾', '蛤'], ['缘', '姻'],
  ['消', '销'], ['览', '揽'], ['朓', '脁'],
];

const VAR = (() => {
  const m = new Map();
  for (const [a, b] of VAR_PAIRS) {
    if (!m.has(a)) m.set(a, new Set());
    if (!m.has(b)) m.set(b, new Set());
    m.get(a).add(b);
    m.get(b).add(a);
  }
  return m;
})();

let pb = null;            // 唯一全文文本：篇内小句直接相接，篇与篇之间用 \n
let pstart = null;        // 每篇在 pb 里的字符起点
let clen = null;          // 每个小句的字数长度（Uint8Array，最大单句 40 字，单字节足够）
let poems = null;         // [[标题,作者,朝代,文体,句数,prio], ...]
let poemEnd = null;       // 累计句数
let t2s = null;
let stats = null;

function load() {
  if (pb) return stats;
  const t0 = Date.now();
  /* ---------- 加载期分段回收 ----------
   * 2026-10-23：语料扩到 27.6M 字之后，加载**结束**时 heapUsed 500MB，
   * 但强制 GC 一次只剩 228MB —— 也就是 272MB 全是加载过程的临时垃圾
   * （gunzip 出来的 Buffer、`parts` 那 43 万个中间字符串、JSON.parse 的中间对象）。
   * V8 默认不急，于是一路把 rss 顶到 670~1048MB，最后被容器 OOM。
   * 所以在阶段之间主动回收：峰值一下就从「垃圾 + 常驻」降到「常驻 + 一段临时」。
   * 需要 `node --expose-gc`（package.json 的 start 已带）；没有 gc 时静默跳过，
   * **逻辑一个字没改**，只是更早把垃圾还回去。 */
  const gc = typeof global.gc === 'function' ? global.gc : null;
  const TRACE = process.env.JUDGE_LOAD_TRACE === '1';
  const reap = (tagName) => {
    if (TRACE) console.error('[judge] ' + tagName + ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
    if (gc) { try { gc(); } catch (_) {} }
  };

  poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'poems.json.gz'))).toString('utf8'));
  const strPool = new Map();
  const intern = (s) => {
    if (typeof s !== 'string') return s;
    const cached = strPool.get(s);
    if (cached !== undefined) return cached;
    strPool.set(s, s);
    return s;
  };
  for (let i = 0; i < poems.length; i++) {
    const p = poems[i];
    p[1] = intern(p[1]); // 作者
    p[2] = intern(p[2]); // 朝代
    p[3] = intern(p[3]); // 文体
  }
  strPool.clear();
  reap('after-poems');
  t2s = JSON.parse(fs.readFileSync(path.join(DATA, 't2s.json'), 'utf8'));
  reap('after-t2s');

  poemEnd = new Uint32Array(poems.length + 1);
  let acc = 0;
  for (let i = 0; i < poems.length; i++) {
    acc += poems[i][4];
    poemEnd[i + 1] = acc;
  }
  const totalClauses = acc;
  clen = new Uint8Array(totalClauses);
  pstart = new Uint32Array(poems.length + 1);
  reap('after-poemEnd');

  /* 单轨全文：篇内小句连续拼接，篇与篇之间用 \n 分隔。
     一次性扫描原始按行小句语料，记录每个小句长度并拼成 pb，原始文本立即释放。 */
  let raw = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'clauses.txt.gz'))).toString('utf8');
  reap('after-clauses-read');

  let parts = new Array(poems.length);
  let lineStart = 0;
  let clauseIdx = 0;
  let pbAcc = 0;
  for (let i = 0; i < poems.length; i++) {
    const numClauses = poems[i][4];
    pstart[i] = pbAcc;
    let poemStr = '';
    for (let c = 0; c < numClauses; c++) {
      const nextNl = raw.indexOf('\n', lineStart);
      const end = nextNl >= 0 ? nextNl : raw.length;
      const len = end - lineStart;
      clen[clauseIdx++] = len;
      poemStr += raw.slice(lineStart, end);
      lineStart = nextNl >= 0 ? nextNl + 1 : raw.length;
    }
    parts[i] = poemStr;
    pbAcc += poemStr.length + 1;
  }
  pstart[poems.length] = pbAcc;
  pb = parts.join('\n');
  raw = null;             /* 原始解压字符串立即置空，不占常驻内存 */
  parts = null;           /* 中间数组立即置空 */
  reap('after-pb');

  stats = {
    lines: clen.length, poems: poems.length, chars: pb.length,
    pbmb: +(pb.length / 1048576).toFixed(1), ms: Date.now() - t0,
  };
  return stats;
}


/* ---------- 归一化 ---------- */
function normalize(raw) {
  let s = String(raw == null ? '' : raw);
  if (s.normalize) s = s.normalize('NFKC');
  s = s.replace(/[^\u3400-\u4DBF\u4E00-\u9FA5\u3007]/g, '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    out += t2s[ch] || ch;
  }
  return out;
}

/* 生成异文候选（最多替换 2 处，数量受控） */
function variants(q) {
  const idxs = [];
  for (let i = 0; i < q.length; i++) {
    const alts = VAR.get(q.charAt(i));
    if (alts && alts.size) idxs.push(i);
  }
  if (!idxs.length) return [];
  const out = [];
  const push = (s) => { if (s !== q && out.length < 24) out.push(s); };
  for (const i of idxs) {
    for (const a of VAR.get(q.charAt(i))) push(q.slice(0, i) + a + q.slice(i + 1));
  }
  for (let x = 0; x < idxs.length; x++) {
    for (let y = x + 1; y < idxs.length; y++) {
      const i = idxs[x], j = idxs[y];
      for (const a of VAR.get(q.charAt(i))) {
        for (const b of VAR.get(q.charAt(j))) {
          push(q.slice(0, i) + a + q.slice(i + 1, j) + b + q.slice(j + 1));
        }
      }
    }
  }
  return out;
}

/* ---------- 位置 → 句/篇 ---------- */
function poemOf(line) {
  let lo = 0, hi = poems.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (poemEnd[mid + 1] <= line) lo = mid + 1; else hi = mid;
  }
  return lo;
}
function kindOf(line) { return poems[poemOf(line)][3]; }
function prioOf(line) {
  const v = poems[poemOf(line)][5];
  return v == null ? PRIO_FALLBACK : v;
}
function sourceOf(line) {
  const p = poems[poemOf(line)];
  return { title: p[0], author: p[1], dynasty: p[2], kind: p[3] };
}
function kindOk(line, allow) {
  if (!allow) return true;
  return !!allow[kindOf(line)];
}

/* ---------- 篇级匹配（跨小句连写） ---------- */
function poemAt(bytePos) {
  let lo = 0, hi = poems.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pstart[mid] <= bytePos) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/* 命中区间 [b0,b1) 落在哪几个小句上（字符偏移 → 小句下标 + 首句起止） */
function spanInfo(pi, b0, b1) {
  const from = poemEnd[pi], to = poemEnd[pi + 1];
  let s = pstart[pi], f = -1, t = -1, fs = 0, fe = 0, te = 0;
  for (let k = from; k < to; k++) {
    const ce = s + clen[k];
    if (f < 0 && b0 < ce) { f = k; fs = s; fe = ce; }
    if (b1 <= ce) { t = k; te = ce; break; }
    s = ce;
  }
  return { f: f < 0 ? from : f, t: t < 0 ? to - 1 : t, fs, fe, te: te || s };
}

/** 在整首诗中找连续命中：整句、跨小句、片段都走这里。
 *  同一串字可能出现在很多首诗里，按「整句 > 跨句」再按出处可信度（prio）挑一处。 */
function findSpan(q, allow) {
  let best = null, bestScore = Infinity, from = 0;
  for (let guard = 0; guard < 14; guard++) {
    const pos = pb.indexOf(q, from);
    if (pos < 0) break;
    const pi = poemAt(pos);
    const po = poems[pi];
    if (!allow || allow[po[3]]) {
      const sp = spanInfo(pi, pos, pos + q.length);
      const whole = pos === sp.fs && pos + q.length === sp.te;
      const prio = po[5] == null ? PRIO_FALLBACK : po[5];
      const score = (whole ? 0 : (sp.f === sp.t ? 2e6 : 1e6)) + prio * 10 + (sp.t - sp.f);
      if (score < bestScore) {
        bestScore = score;
        best = { pi, f: sp.f, t: sp.t, whole };
        if (whole && prio < 700) break;   // 已经是「非僧人 + 唐及更早」，不可能更好
      }
    }
    from = pos + q.length;
  }
  return best;
}

/* 取篇 pi 中从第 f 句到第 t 句各小句的字面文本 */
function getClauses(pi, f, t) {
  const from = poemEnd[pi];
  let pos = pstart[pi];
  for (let k = from; k < f; k++) {
    pos += clen[k];
  }
  const res = [];
  for (let k = f; k <= t; k++) {
    const len = clen[k];
    res.push(pb.slice(pos, pos + len));
    pos += len;
  }
  return res;
}

/* 两句在同一首诗中紧邻。
   只在「整首连着查不到、但两句各自成立」时兜底：底本与通行本分属两条记录时，
   同一联的上下句会落在不同的诗篇里。 */
const ANCIENT_DYNASTIES = new Set(['先秦', '汉', '魏晋', '南北朝', '隋']);
const ANCIENT_TITLE_REG = /(歌|行|吟|引|曲|弄|操|谣|辞|骚|叹|哀|古风|古意|古体|乐府|杂言|短歌|长歌)/;

/** 判断一首诗是否为句式字数整齐均一的近体律绝排律。
 *  规则近体诗的小句长度全部统一（如纯五言、纯七言），且句数为偶数（4、8、10、12 等）。
 *  古风、乐府、楚辞、唐前古体诗等句式自由，不套用近体诗的跨联限制。 */
function isUniformShi(pi) {
  const p = poems[pi];
  if (!p || p[3] !== '诗') return false;
  // 先秦、汉、魏晋、南北朝、隋等唐前朝代尚无近体格律诗，不作跨联限制
  if (ANCIENT_DYNASTIES.has(p[2])) return false;
  // 歌行乐府古体等诗体不守近体出对句规则
  if (p[0] && ANCIENT_TITLE_REG.test(p[0])) return false;

  const from = poemEnd[pi], to = poemEnd[pi + 1];
  const count = to - from;
  // 常见近体诗为绝句(4句)、律诗(8句)、短排律(<=16句)；超过16句的长诗多为古风，无底本标点时不强行按近体跨联判定
  if (count < 2 || count % 2 !== 0 || count > 16) return false;
  const firstLen = clen[from];
  if (firstLen < 4) return false;
  for (let k = from + 1; k < to; k++) {
    if (clen[k] !== firstLen) return false;
  }
  return true;
}

function coupletFallback(q, allow) {
  if (q.length !== 10 && q.length !== 14) return null;
  for (const k of [5, 7, 4, 6]) {
    if (k < 3 || q.length - k < 3) continue;
    const a = q.slice(0, k), b = q.slice(k);
    const ha = findSpan(a, allow), hb = findSpan(b, allow);
    if (ha && hb && ha.whole && hb.whole) {
      const sa = sourceOf(ha.f), sb = sourceOf(hb.f);
      if (sa.title === sb.title && sa.author === sb.author) {
        /* pia / pib 必须声明在这一层：下面算 isRegular 时还要用，写在 if(sa.kind==='诗') 里就是块级作用域，
           会抛 ReferenceError（诗的两句落到不同篇时必踩）。 */
        const pia = poemOf(ha.f), pib = poemOf(hb.f);
        let isCrossCouplet = false;
        if (sa.kind === '诗') {
          if (pia === pib) {
            const offsetA = ha.f - poemEnd[pia];
            const pa = poems[pia];
            const hasExplicitPunct = pa[6] && typeof pa[6] === 'string';
            if (hb.f !== ha.f + 1) {
              isCrossCouplet = true;
            } else if (hasExplicitPunct) {
              if (punctOf(ha.f) === '。') isCrossCouplet = true;
            } else if (isUniformShi(pia) && offsetA % 2 !== 0) {
              isCrossCouplet = true;
            }
          }
        }
        /* 上下句之间用空格隔开（不用竖线）—— 与主持台版的飞花记录一致 */
        const lineWithPunct = isCrossCouplet ? a + '。' + b + '，' : a + '，' + b + '。';
        const isRegular = sa.kind === '诗' && pia === pib && isUniformShi(pia);
        return {
          ok: true, code: 'couplet', reason: '', norm: q,
          line: a + ' ' + b,
          lineWithPunct,
          puncts: isCrossCouplet ? ['。', '，'] : ['，', '。'],
          clauseCount: 2,
          isCrossCouplet,
          isRegularShi: isRegular,
          isUniformShi: isRegular,
          clausePunct: isCrossCouplet ? '，' : '。',
          isSentenceEnd: !isCrossCouplet,
          source: sa,
          via: 'couplet',
        };
      }
    }
  }
  return null;
}

function punctOf(line) {
  const pi = poemOf(line);
  const p = poems[pi];
  const offset = line - poemEnd[pi];
  let raw = '';
  if (p && p[6] && typeof p[6] === 'string' && offset < p[6].length) {
    raw = p[6].charAt(offset);
  }
  if (!raw) {
    return offset % 2 === 1 ? '。' : '，';
  }
  return raw === '。' ? '。' : '，';
}

function spanText(sp) {
  const pi = poemOf(sp.f);
  return getClauses(pi, sp.f, sp.t).join(' ');
}

function spanResult(q, sp, code, via) {
  const pi = poemOf(sp.f);
  const clauses = getClauses(pi, sp.f, sp.t);
  const text = clauses.join(' ');
  const p = poems[pi];
  const isShi = p && p[3] === '诗';
  const hasExplicitPunct = p && p[6] && typeof p[6] === 'string';

  let isCrossCouplet = false;
  if (clauses.length === 2 && isShi) {
    const offset = sp.f - poemEnd[pi];
    if (hasExplicitPunct) {
      if (punctOf(sp.f) === '。') {
        isCrossCouplet = true;
      }
    } else if (isUniformShi(pi)) {
      // 偶数句规则近体诗（绝句、律诗、排律等）：出句必须位于偶数偏移（0, 2, 4, ...）
      if (offset % 2 !== 0) {
        isCrossCouplet = true;
      }
    }
    // 注：若为杂言古风、长短句特殊结构诗且无显式句号，包容放行，不生硬误判为跨联
  }

  const puncts = [];
  let punctText = '';
  if (clauses.length === 2 && !isCrossCouplet) {
    // 合法提交同一联（出句 + 对句）：出句后为逗号，句尾为句号
    puncts.push('，', '。');
    punctText = clauses[0] + '，' + clauses[1];
  } else if (clauses.length === 2 && isCrossCouplet) {
    // 跨联提交两句（上一联对句 + 下一联出句）：出句结尾为句号，下一句结尾为逗号
    puncts.push('。', '，');
    punctText = clauses[0] + '。' + clauses[1];
  } else {
    for (let i = 0; i < clauses.length; i++) {
      const k = sp.f + i;
      punctText += clauses[i];
      const p = punctOf(k);
      puncts.push(p);
      if (i < clauses.length - 1) punctText += p;
    }
  }
  const lastP = puncts[puncts.length - 1] || '，';
  let fullLine = punctText;
  if (clauses.length === 2) {
    fullLine = isCrossCouplet ? (clauses[0] + '。' + clauses[1] + '，') : (clauses[0] + '，' + clauses[1] + '。');
  } else {
    fullLine = punctText + (lastP === '。' ? '' : lastP);
  }

  const isRegular = isShi && isUniformShi(pi);

  return {
    ok: true, code, reason: '', norm: q,
    line: text,                 // 飞花记录等地方仍使用空格分句显示
    lineWithPunct: fullLine,    // 幕后带标点格式
    puncts,                     // 幕后标点列表
    clauseCount: clauses.length,
    isCrossCouplet,
    isRegularShi: isRegular,
    isUniformShi: isRegular,
    clausePunct: lastP,         // 幕后末小句标点
    isSentenceEnd: lastP === '。',
    source: sourceOf(sp.f),
    via,
  };
}

/** 单条查询串的一次完整尝试（不含异文替换） */
function probe(q, allow) {
  const sp = findSpan(q, allow);
  if (!sp) return null;
  if (sp.whole && sp.f === sp.t) return spanResult(q, sp, 'exact', 'exact');
  if (sp.f !== sp.t && (sp.whole || q.length >= MIN_FRAG)) {
    const via = sp.t - sp.f === 1 ? 'couplet' : 'phrase';
    return spanResult(q, sp, via, via);
  }
  if (q.length >= MIN_FRAG) return spanResult(q, sp, 'fragment', 'fragment');
  return null;
}

/* ---------- 主判定 ---------- */
/**
 * @returns {{ok:boolean, code:string, reason:string, norm:string, line?:string,
 *            source?:Object, via?:string}}
 */
function judge(raw, opts) {
  if (!pb) load();
  opts = opts || {};
  const allow = opts.allowKinds || null;
  const q = normalize(raw);

  if (!q) return { ok: false, code: 'empty', reason: '没有识别到汉字，请检查输入。', norm: '' };
  if (q.length < MIN_LEN) return { ok: false, code: 'too_short', reason: '至少要两个字。', norm: q };
  const maxLimit = typeof opts.maxLen === 'number' ? opts.maxLen : (opts.unlimitedLen ? 0 : MAX_LEN);
  if (maxLimit > 0 && q.length > maxLimit) return { ok: false, code: 'too_long', reason: '一句最多 ' + maxLimit + ' 字。', norm: q };

  // 1) 语料命中：整句 / 跨小句连写 / 名句片段
  const hit = probe(q, allow);
  if (hit) return hit;

  // 2) 异文替换后重查（乾/干、着/著、征/徵 …）
  for (const v of variants(q)) {
    const h = probe(v, allow);
    if (h) return Object.assign(h, { code: 'variant', via: 'variant', norm: v });
  }

  // 3) 两句分别在两条记录里（底本/通行本各一条），同题同作者认作同一首
  const cp = coupletFallback(q, allow);
  if (cp) return cp;

  if (q.length < MIN_FRAG) {
    return { ok: false, code: 'short', reason: '「' + q + '」不是完整诗句（少于 ' + MIN_FRAG + ' 字，需整句命中）。', norm: q };
  }
  if (allow) {
    const rawHit = probe(q, null) || coupletFallback(q, null);
    if (rawHit && rawHit.source) {
      const s = rawHit.source;
      const who = s.author ? s.author + ' ' : '';
      return {
        ok: false, code: 'not_found',
        reason: '「' + q + '」出自 ' + who + '《' + s.title + '》（' + s.kind + '），本局未启用该文体。',
        norm: q,
        source: s,
      };
    }
  }
  return {
    ok: false, code: 'not_found',
    reason: '「' + q + '」未收录于本局语料' + (allow ? '（也可能出自本局未启用的文体）' : '') + '。',
    norm: q,
  };
}


/* ---------- 作者池（给「不填名字」的人当默认昵称） ----------
   玩家没填昵称时，从语料作者里随机取一位，比一律叫「赤营」有意思。
   但语料里的「作者」列不能直接拿来当名字用：
     · 无名氏 / 佚名 / 不详 / 待考 —— 35 万篇里有四千多篇落在这里
     · 「钱镠（吴越武肃王。以下吴越）」「王冷然（《全唐诗》卷一一五）…」—— 带校勘注，最长 46 字
     · 「赵光逢、张衮」「道镜　善导」—— 多人并列或含全角空格
   所以只收 2–6 个纯汉字的条目：够短能塞进昵称（上限 12 字），也基本都是真人名。 */
let authorPool = null;

function buildAuthorPool() {
  const BAN = /无名|佚名|不详|未知|待考|缺名|阙名/;
  const PURE = /^[\u3400-\u4DBF\u4E00-\u9FA5\u3007]+$/;
  const set = new Set();
  for (const p of poems) {
    const a = String(p[1] || '').trim();
    const len = Array.from(a).length;
    if (len < 2 || len > 6) continue;
    if (BAN.test(a) || !PURE.test(a)) continue;
    set.add(a);
  }
  return Array.from(set);
}

/** 随机一位语料作者；池子空时退回一个中性名（正常不会发生）。 */
function randomAuthor() {
  if (!authorPool) { load(); authorPool = buildAuthorPool(); }
  if (!authorPool.length) return '无名';
  return authorPool[Math.floor(Math.random() * authorPool.length)];
}

/* 这个名字是不是诗人池里抽出来的？
   服务端用它对账「客户端说自己用的是随机昵称」—— 不核对的话，随便把 Nick 标记成
   random 就能绕开「自定义昵称 24 小时只能改一次」。 */
let authorSet = null;
function isAuthor(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (!authorPool) { load(); authorPool = buildAuthorPool(); }
  if (!authorSet) authorSet = new Set(authorPool);
  return authorSet.has(n);
}

/* ---------- 数据库查验与协作检视接口 ---------- */
let corpusSummaryCache = null;

function getCorpusSummary() {
  if (corpusSummaryCache) return corpusSummaryCache;
  load();
  const kinds = {};
  const dynasties = {};
  let variantCount = 0;
  for (let i = 0; i < poems.length; i++) {
    const p = poems[i];
    const k = p[3] || '其他';
    kinds[k] = (kinds[k] || 0) + 1;
    const d = p[2] || '未知';
    dynasties[d] = (dynasties[d] || 0) + 1;
    if (p[0] && p[0].includes('(异文版)')) variantCount++;
  }
  corpusSummaryCache = {
    lines: stats.lines,
    poems: stats.poems,
    chars: stats.chars,
    kinds,
    dynasties,
    variants: variantCount,
  };
  return corpusSummaryCache;
}

function getPoemFull(pi) {
  const p = poems[pi];
  if (!p) return null;
  const from = poemEnd[pi], to = poemEnd[pi + 1];
  const cs = to > from ? getClauses(pi, from, to - 1) : [];
  const clausesWithPunct = [];
  const parts = [];
  for (let i = 0; i < cs.length; i++) {
    const pch = punctOf(from + i);
    clausesWithPunct.push(cs[i] + pch);
    parts.push(cs[i] + pch);
  }
  return {
    id: pi,
    title: p[0],
    author: p[1],
    dynasty: p[2],
    kind: p[3],
    count: p[4],
    prio: p[5],
    clauses: clausesWithPunct,
    text: parts.join(''),
  };
}

function searchPoems(query, limit = 30) {
  load();
  const q = String(query || '').trim();
  if (!q) return { total: 0, list: [] };
  const lim = Math.max(1, Math.min(50, Number(limit) || 30));
  const list = [];
  let total = 0;
  for (let i = 0; i < poems.length; i++) {
    const p = poems[i];
    if (p[0].includes(q) || p[1].includes(q)) {
      total++;
      if (list.length < lim) {
        list.push(getPoemFull(i));
      }
    }
  }
  return { total, list };
}

function probeCorpus(text, limit = 15) {
  load();
  const raw = String(text || '').trim();
  if (!raw) return { judge: null, hits: [] };
  const judgeRes = judge(raw);
  const q = normalize(raw);
  const hits = [];
  if (q && q.length >= 2) {
    const seenPi = new Set();
    let from = 0;
    const maxGuard = 200;
    let guard = 0;
    while (guard++ < maxGuard) {
      const pos = pb.indexOf(q, from);
      if (pos < 0) break;
      const pi = poemAt(pos);
      if (!seenPi.has(pi)) {
        seenPi.add(pi);
        const p = poems[pi];
        const sp = spanInfo(pi, pos, pos + q.length);
        const whole = pos === sp.fs && pos + q.length === sp.te;
        const info = getPoemFull(pi);
        hits.push({
          pi,
          title: info.title,
          author: info.author,
          dynasty: info.dynasty,
          kind: info.kind,
          prio: info.prio,
          whole,
          hitClause: getClauses(pi, sp.f, sp.t).join(' '),
          clauses: info.clauses,
          text: info.text,
        });
        if (hits.length >= limit) break;
      }
      from = pos + Math.max(1, q.length);
    }
  }
  return { judge: judgeRes, hits };
}

module.exports = {
  load, judge, normalize, punctOf,
  stats: () => stats,
  randomAuthor, isAuthor,
  authorCount: () => { if (!authorPool) { load(); authorPool = buildAuthorPool(); } return authorPool.length; },
  getCorpusSummary,
  getPoemFull,
  searchPoems,
  probeCorpus,
};

/* 命令行：node judge.js "床前明月光" */
if (require.main === module) {
  const s = load();
  console.log(`语料：${s.lines} 句 / ${s.poems} 篇 / ${(s.chars / 1048576).toFixed(1)} MB，加载 ${s.ms} ms`);
  const input = process.argv.slice(2).join(' ') || '床前明月光，疑是地上霜';
  const t = Date.now();
  const r = judge(input);
  console.log(JSON.stringify(r, null, 2), '\n判定耗时', Date.now() - t, 'ms');
}
