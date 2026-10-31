'use strict';
/**
 * 标点规范化处理脚本
 * 将语料库 data/poems.json.gz 中全部篇目的标点规整为标准的逗号「，」和句号「。」：
 * 1. 消除问号「？」、感叹号「！」、分号「；」、顿号「、」等非标句读符号；
 * 2. 诗文体规律偶数句诗统一出句为「，」、对句为「。」，并紧凑化省略默认存储；
 * 3. 词曲赋文与特殊诗：连续问句/出句疑问转为「，」，结句转为「。」，并列顿号分号转为「，」。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const POEMS_PATH = path.join(DATA_DIR, 'poems.json.gz');

console.log('[normalize_puncts] 读取 data/poems.json.gz...');
const t0 = Date.now();
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(POEMS_PATH)).toString('utf8'));
console.log(`[normalize_puncts] 读取完毕：${poems.length} 篇，耗时 ${Date.now() - t0}ms`);

function normalizePunctStr(str, isEvenShi) {
  if (!str) return '';
  if (isEvenShi) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
      out += (i % 2 === 1 ? '。' : '，');
    }
    return out;
  }
  const chars = str.split('');
  const res = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '，' || ch === '。') {
      res.push(ch);
    } else if (ch === '、' || ch === '；' || ch === '：') {
      res.push('，');
    } else if (ch === '？' || ch === '！') {
      const next = i < chars.length - 1 ? chars[i + 1] : '';
      if (next === '？' || next === '！' || next === '。') {
        res.push('，');
      } else {
        res.push('。');
      }
    } else {
      res.push('，');
    }
  }
  return res.join('');
}

let modifiedCount = 0;
let strippedCount = 0;

for (let i = 0; i < poems.length; i++) {
  const p = poems[i];
  if (!p[6]) continue;
  const isEvenShi = (p[3] === '诗' && p[4] % 2 === 0);
  const norm = normalizePunctStr(p[6], isEvenShi);
  if (norm !== p[6]) {
    modifiedCount++;
  }

  let isStd = true;
  for (let c = 0; c < norm.length; c++) {
    if (norm[c] !== (c % 2 === 1 ? '。' : '，')) {
      isStd = false;
      break;
    }
  }
  if (isStd) {
    p[6] = '';
    strippedCount++;
  } else {
    p[6] = norm;
  }
}

console.log(`[normalize_puncts] 规整完成：`);
console.log(`  - 修复非标标点篇数: ${modifiedCount}`);
console.log(`  - 标点紧凑化省略篇数: ${strippedCount} (转为按需推导)`);

console.log('[normalize_puncts] 正在压缩写回 data/poems.json.gz...');
fs.writeFileSync(POEMS_PATH, zlib.gzipSync(Buffer.from(JSON.stringify(poems), 'utf8'), { level: 9 }));
console.log(`[normalize_puncts] 全部处理完成！总耗时 ${Date.now() - t0}ms`);
