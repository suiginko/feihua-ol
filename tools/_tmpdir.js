'use strict';
/* 给自测 / 探针用的临时数据目录。
 *
 *   const tmpDir = require('./_tmpdir');
 *   spawn(node, ['server.js'], { env: { ...process.env, DATA_DIR: tmpDir('leave') } });
 *
 * 为什么需要它：data/ 现在除了存档、反馈、启动记录，还多了一份「房间快照」。
 * 测试直接往项目自己的 data/ 里写，会有两个后果 ——
 *   ① 测完留下的快照会在下一次本地启动时被「恢复」出来，凭空多出几间房；
 *   ② 发布前忘了清就会跟着代码包上线（安全性由快照年龄兜底，但没必要冒这个险）。
 * 同一个 tag 每次调用都会先清空，所以反复跑不会串味。 */
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function tmpDir(tag) {
  const dir = path.join(os.tmpdir(), 'feihua-test-' + String(tag || 'x'));
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 文件还被占着就算了 */ }
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
};
