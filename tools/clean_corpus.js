'use strict';
/**
 * 语料库清淤、朝代修复与标点紧凑化处理
 * 1. 剔除 8 部大戏文剧本（与去杂剧口径一致）及重复长赋篇目
 * 2. 修复朝代标注：将“南北”纠正为“南北朝”
 * 3. 标点紧凑化：92.4% 规律近体诗标点设空，由 punctOf 自动默认推导，消除 39 万冗余字符串
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CLAUSES_PATH = path.join(DATA_DIR, 'clauses.txt.gz');
const POEMS_PATH = path.join(DATA_DIR, 'poems.json.gz');

console.log('[clean] 读取语料数据...');
const t0 = Date.now();
const raw = zlib.gunzipSync(fs.readFileSync(CLAUSES_PATH)).toString('utf8');
const lines = raw.split('\n');
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(POEMS_PATH)).toString('utf8'));
console.log(`[clean] 读取完毕：${lines.length} 句 / ${poems.length} 篇，耗时 ${Date.now() - t0}ms`);

let acc = 0;
const poemEnd = new Uint32Array(poems.length + 1);
for (let i = 0; i < poems.length; i++) {
  acc += poems[i][4];
  poemEnd[i + 1] = acc;
}

const dropIndices = new Set();
// 1. 剔除戏文/传奇大剧本
for (let i = 0; i < poems.length; i++) {
  const title = poems[i][0];
  if (title.startsWith('戏文·') || title.includes('戏文') || title.startsWith('传奇·')) {
    dropIndices.add(i);
    console.log(`  - 剔除戏文剧本: ${title} (${poems[i][1]}, ${poems[i][4]} 句)`);
  }
}

// 2. 剔除重复三都赋
let sandufuCount = 0;
for (let i = 0; i < poems.length; i++) {
  const [title, author] = poems[i];
  if (author === '左思' && title.includes('三都赋')) {
    sandufuCount++;
    if (sandufuCount > 1) {
      dropIndices.add(i);
      console.log(`  - 剔除重复长赋: ${title} (${author}, ${poems[i][4]} 句)`);
    }
  }
}

let fixedDynastyCount = 0;
let strippedPunctCount = 0;
const newPoems = [];
const newLines = [];
let droppedClauses = 0;

for (let i = 0; i < poems.length; i++) {
  if (dropIndices.has(i)) {
    droppedClauses += poems[i][4];
    continue;
  }
  const p = poems[i];
  // 修复朝代：南北 -> 南北朝
  if (p[2] === '南北') {
    p[2] = '南北朝';
    fixedDynastyCount++;
  }
  // 标点紧凑化：符合默认交替逗句号的留空，由 punctOf 自动推导
  const cnt = p[4];
  const puncts = p[6];
  if (puncts && puncts.length === cnt) {
    let isStd = true;
    for (let c = 0; c < cnt; c++) {
      if (puncts[c] !== (c % 2 === 1 ? '。' : '，')) {
        isStd = false;
        break;
      }
    }
    if (isStd) {
      p[6] = '';
      strippedPunctCount++;
    }
  }

  newPoems.push(p);
  const s = poemEnd[i], e = poemEnd[i + 1];
  for (let k = s; k < e; k++) {
    newLines.push(lines[k]);
  }
}

console.log(`[clean] 清理统计:`);
console.log(`  - 剔除篇目: ${dropIndices.size} 篇 (剩余 ${newPoems.length} 篇)`);
console.log(`  - 剔除小句: ${droppedClauses} 句 (剩余 ${newLines.length} 句)`);
console.log(`  - 修复朝代（南北 -> 南北朝）: ${fixedDynastyCount} 篇`);
console.log(`  - 标点紧凑化省略篇数: ${strippedPunctCount} 篇 (转为按需推导)`);

console.log('[clean] 正在压缩写回 clauses.txt.gz...');
fs.writeFileSync(CLAUSES_PATH, zlib.gzipSync(Buffer.from(newLines.join('\n'), 'utf8'), { level: 9 }));

console.log('[clean] 正在压缩写回 poems.json.gz...');
fs.writeFileSync(POEMS_PATH, zlib.gzipSync(Buffer.from(JSON.stringify(newPoems), 'utf8'), { level: 9 }));

console.log(`[clean] 全部处理完成！总耗时 ${Date.now() - t0}ms`);
