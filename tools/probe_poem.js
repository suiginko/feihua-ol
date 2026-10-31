'use strict';
/* 按标题打印某一篇的全部句（排查语料是否残缺） */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA = path.join(__dirname, '..', 'data');
const blob = zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'clauses.txt.gz'))).toString('utf8');
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DATA, 'poems.json.gz'))).toString('utf8'));

const starts = [0];
let p = 0;
while ((p = blob.indexOf('\n', p)) >= 0) { p++; starts.push(p); }
const offs = Uint32Array.from(starts);

const want = process.argv[2];
const poemEnd = new Uint32Array(poems.length + 1);
let acc = 0;
for (let i = 0; i < poems.length; i++) { acc += poems[i][4]; poemEnd[i + 1] = acc; }

let shown = 0;
for (let i = 0; i < poems.length; i++) {
  const p0 = poems[i];
  const key = p0[0] + '|' + p0[1];
  if (!key.includes(want)) continue;
  shown++;
  const from = poemEnd[i], to = poemEnd[i + 1];
  const lines = [];
  for (let k = from; k < to; k++) {
    const s = offs[k];
    const e = k + 1 < offs.length ? offs[k + 1] - 1 : blob.length;
    lines.push(blob.slice(s, e));
  }
  console.log(`《${p0[0]}》 ${p0[1]}·${p0[2]}·${p0[3]}  句数=${p0[4]}  记录#${i}`);
  console.log(lines.map((l, n) => `${n + 1}. ${l}`).join('\n'));
  console.log('');
  if (shown >= 3) break;
}
if (!shown) console.log('未找到匹配「' + want + '」的篇目');
