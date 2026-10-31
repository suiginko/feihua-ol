'use strict';
/**
 * 语料库冗余副本与正字法异文清理脚本
 *
 * 1. 清理 100% 内容完全重复的多余篇目（历史导入重复）
 * 2. 清理差异完全被 judge.js VAR_PAIRS 覆盖的单字异文副本（保留底本，副篇安全合并）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CLAUSES_PATH = path.join(DATA_DIR, 'clauses.txt.gz');
const POEMS_PATH = path.join(DATA_DIR, 'poems.json.gz');

console.log('[dedup] 读取语料数据...');
const t0 = Date.now();
const raw = zlib.gunzipSync(fs.readFileSync(CLAUSES_PATH)).toString('utf8');
const lines = raw.split('\n');
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(POEMS_PATH)).toString('utf8'));
console.log(`[dedup] 读取完毕：${lines.length} 句 / ${poems.length} 篇，耗时 ${Date.now() - t0}ms`);

// 引入 judge.js 中的 VAR_PAIRS
const judge = require('../judge');

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
  ['鳌', '鳖'], ['虾', '蛤'], ['缘', '姻']
];

const varMap = new Map();
for (const [a, b] of VAR_PAIRS) {
  if (!varMap.has(a)) varMap.set(a, new Set());
  if (!varMap.has(b)) varMap.set(b, new Set());
  varMap.get(a).add(b);
  varMap.get(b).add(a);
}

function areVariants(s1, s2) {
  if (s1 === s2) return true;
  if (s1.length !== s2.length) return false;
  let diffs = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1[i] !== s2[i]) {
      const alts = varMap.get(s1[i]);
      if (!alts || !alts.has(s2[i])) return false;
      diffs++;
      if (diffs > 2) return false;
    }
  }
  return true;
}

let acc = 0;
const poemEnd = new Uint32Array(poems.length + 1);
for (let i = 0; i < poems.length; i++) {
  acc += poems[i][4];
  poemEnd[i + 1] = acc;
}

// Group by author + title
const authorTitleMap = new Map();
for (let i = 0; i < poems.length; i++) {
  const p = poems[i];
  const key = p[1] + '|||' + p[0];
  const list = authorTitleMap.get(key) || [];
  list.push(i);
  authorTitleMap.set(key, list);
}

const dropIndices = new Set();
let exactCount = 0;
let varCount = 0;

for (const [k, v] of authorTitleMap.entries()) {
  if (v.length > 1) {
    // 优先保留更可信（prio更小）、标点更全的版本
    v.sort((a, b) => {
      const pa = poems[a], pb = poems[b];
      const prioA = pa[5] == null ? 5000 : pa[5];
      const prioB = pb[5] == null ? 5000 : pb[5];
      if (prioA !== prioB) return prioA - prioB;
      const punctA = (pa[6] || '').length;
      const punctB = (pb[6] || '').length;
      return punctB - punctA;
    });

    const kept = [v[0]];
    for (let j = 1; j < v.length; j++) {
      const curIdx = v[j];
      const curText = lines.slice(poemEnd[curIdx], poemEnd[curIdx + 1]).join('');
      let duplicate = false;
      let isExact = false;
      for (const kIdx of kept) {
        const keptText = lines.slice(poemEnd[kIdx], poemEnd[kIdx + 1]).join('');
        if (curText === keptText) {
          duplicate = true;
          isExact = true;
          break;
        } else if (areVariants(curText, keptText)) {
          duplicate = true;
          isExact = false;
          break;
        }
      }
      if (duplicate) {
        dropIndices.add(curIdx);
        if (isExact) exactCount++; else varCount++;
      } else {
        kept.push(curIdx);
      }
    }
  }
}

console.log(`[dedup] 分析完成：`);
console.log(`  - 100% 完全重复被合并篇数: ${exactCount}`);
console.log(`  - 规则异文被安全合并篇数: ${varCount}`);
console.log(`  - 总计剔除篇数: ${dropIndices.size} 篇 (剩余 ${poems.length - dropIndices.size} 篇)`);

const newPoems = [];
const newLines = [];
let droppedClauses = 0;

for (let i = 0; i < poems.length; i++) {
  if (dropIndices.has(i)) {
    droppedClauses += poems[i][4];
    continue;
  }
  newPoems.push(poems[i]);
  const s = poemEnd[i], e = poemEnd[i + 1];
  for (let k = s; k < e; k++) {
    newLines.push(lines[k]);
  }
}

console.log(`  - 总计剔除小句: ${droppedClauses} 句 (剩余 ${newLines.length} 句)`);

console.log('[dedup] 正在压缩写回 clauses.txt.gz...');
fs.writeFileSync(CLAUSES_PATH, zlib.gzipSync(Buffer.from(newLines.join('\n'), 'utf8'), { level: 9 }));

console.log('[dedup] 正在压缩写回 poems.json.gz...');
fs.writeFileSync(POEMS_PATH, zlib.gzipSync(Buffer.from(JSON.stringify(newPoems), 'utf8'), { level: 9 }));

console.log(`[dedup] 全部完成！总耗时 ${Date.now() - t0}ms`);
