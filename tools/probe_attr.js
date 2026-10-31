'use strict';
/* 排查「出处指错」：打印某串字在语料里的全部落点（按 blob 顺序） */
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
const poemEnd = new Uint32Array(poems.length + 1);
let acc = 0;
for (let i = 0; i < poems.length; i++) { acc += poems[i][4]; poemEnd[i + 1] = acc; }

function lineAt(pos) {
  let lo = 0, hi = offs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}
function poemOf(line) {
  let lo = 0, hi = poems.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (poemEnd[mid + 1] <= line) lo = mid + 1; else hi = mid; }
  return lo;
}

for (const q of process.argv.slice(2)) {
  console.log('===== ' + q + ' =====');
  let from = 0, n = 0;
  while (true) {
    const pos = blob.indexOf(q, from);
    if (pos < 0) break;
    const line = lineAt(pos);
    const s = offs[line];
    const e = line + 1 < offs.length ? offs[line + 1] - 1 : blob.length;
    const pi = poemOf(line);
    const p0 = poems[pi];
    const whole = pos === s && e - s === q.length;
    n++;
    console.log(
      `#${n} line=${line} ${whole ? '整句' : '片段'} 行文本「${blob.slice(s, e)}」`,
      `| 《${p0[0]}》 ${p0[1]}·${p0[2]}·${p0[3]} 句数=${p0[4]}`
    );
    from = pos + 1;
  }
  console.log('落点合计 ' + n + '\n');
}
