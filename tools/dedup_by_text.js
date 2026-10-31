'use strict';
/**
 * 跨标题全文字面正文去重脚本 (Cross-Title Content Deduplication)
 * 解决同诗因不同选本标题写法差异（如带不带组诗序号、词牌异名、连接符不同）被重复收录的问题。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CLAUSES_PATH = path.join(DATA_DIR, 'clauses.txt.gz');
const POEMS_PATH = path.join(DATA_DIR, 'poems.json.gz');

console.log('[dedup_text] 正在读取语料数据...');
const t0 = Date.now();
const raw = zlib.gunzipSync(fs.readFileSync(CLAUSES_PATH)).toString('utf8');
const lines = raw.split('\n');
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(POEMS_PATH)).toString('utf8'));
console.log(`[dedup_text] 读取完成：${lines.length} 句 / ${poems.length} 篇，耗时 ${Date.now() - t0}ms`);

let acc = 0;
const poemEnd = new Uint32Array(poems.length + 1);
for (let i = 0; i < poems.length; i++) {
  acc += poems[i][4];
  poemEnd[i + 1] = acc;
}

// 按全文字面正文聚合
const textMap = new Map();
for (let i = 0; i < poems.length; i++) {
  const t = lines.slice(poemEnd[i], poemEnd[i + 1]).join('');
  const list = textMap.get(t) || [];
  list.push(i);
  textMap.set(t, list);
}

// 篇目版本评优打分：保留最规范、最权威、信息量最全的标题版本
function scorePoem(idx) {
  const p = poems[idx];
  const [title, author, dynasty, kind, clauseCount, prio, puncts] = p;
  let score = 0;
  // 1. 出处优先级（越小越好，转为高分）
  score += (10000 - (prio == null ? 5000 : prio)) * 10;
  // 2. 真实作者加分（避免保留「佚名」副本）
  const isAnon = (!author || /佚名|无名|未知|待考/.test(author));
  if (!isAnon) score += 50000;
  // 3. 标题规范与完整度加分（带中点·、带其一、带副标题更具体）
  if (title.includes('·') || title.includes(' 其') || title.includes('其一') || title.includes('其二')) score += 2000;
  if (title.includes('——') || title.includes('—')) score += 500;
  // 长度适中优先（避免超长爬虫垃圾注）
  if (title.length >= 3 && title.length <= 25) score += 1000;
  // 4. 带标点者加分
  if (puncts && puncts.length > 0) score += 200;
  return score;
}

const dropIndices = new Set();
let dupGroupCount = 0;

for (const [t, list] of textMap.entries()) {
  if (list.length > 1) {
    dupGroupCount++;
    // 按评分从高到低排序，保留最优质的一篇
    list.sort((a, b) => scorePoem(b) - scorePoem(a));
    for (let j = 1; j < list.length; j++) {
      dropIndices.add(list[j]);
    }
  }
}

console.log(`[dedup_text] 扫描统计:`);
console.log(`  - 存在完全相同正文的组数: ${dupGroupCount} 组`);
console.log(`  - 拟合并剔除的多余篇目: ${dropIndices.size} 篇 (剩余 ${poems.length - dropIndices.size} 篇)`);

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

console.log(`  - 拟减少的小句总数: ${droppedClauses} 句 (剩余 ${newLines.length} 句)`);

console.log('[dedup_text] 正在压缩写回 clauses.txt.gz...');
fs.writeFileSync(CLAUSES_PATH, zlib.gzipSync(Buffer.from(newLines.join('\n'), 'utf8'), { level: 9 }));

console.log('[dedup_text] 正在压缩写回 poems.json.gz...');
fs.writeFileSync(POEMS_PATH, zlib.gzipSync(Buffer.from(JSON.stringify(newPoems), 'utf8'), { level: 9 }));

console.log(`[dedup_text] 去重写回完毕！总耗时 ${Date.now() - t0}ms`);
