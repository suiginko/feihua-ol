'use strict';
// tools/test_progress_backup.js - 测试在线版进度导出到本地与进度导入恢复
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const net = require('net');
const tmpDir = require('./_tmpdir');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let BASE = process.env.BASE || '';

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function findPort(from) {
  for (let p = from; p < from + 50; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error('找不到空闲端口');
}

async function waitUp(base, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(base + '/api/stats', { cache: 'no-store' });
      if (r.ok) return true;
    } catch (_) {}
    await sleep(250);
  }
  return false;
}

async function req(path, method = 'GET', body = null) {
  const u = new URL(path, BASE);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject) => {
    const r = http.request(u, opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, text: data });
        }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function check(msg, ok) {
  if (ok) {
    console.log('  PASS ' + msg);
  } else {
    console.error('  FAIL ' + msg);
    process.exitCode = 1;
  }
}

(async function () {
  console.log('=== 测试：导出进度与导入恢复 ===\n');

  if (!BASE) {
    const free = await portFree(8799);
    const port = free ? 8799 : await findPort(8800);
    BASE = `http://127.0.0.1:${port}`;
    const dataDir = tmpDir('backup-test');
    child = spawn(process.execPath, [path.resolve(__dirname, '../server.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'inherit']
    });
    const up = await waitUp(BASE, 8000);
    if (!up) throw new Error('测试服务器启动超时');
  }

  // 1. 创建一局双人对战
  console.log('1. 创建房间');
  const cRes = await req('/api/create', 'POST', {
    nick: '李白',
    size: 6,
    rounds: 10,
    playerCount: 2
  });
  check('创建房间成功', cRes.status === 200 && cRes.body.ok);
  const roomId = cRes.body.roomId;
  const tokenA = cRes.body.token;

  // 2. 杜甫加入
  console.log('2. 杜甫加入 B 席');
  const jRes = await req('/api/join', 'POST', {
    roomId,
    nick: '杜甫'
  });
  check('加入 B 席成功', jRes.status === 200 && jRes.body.seat === 'B');
  const tokenB = jRes.body.token;

  // 3. 双方准备并开局
  await req(`/api/room/${roomId}/ready`, 'POST', { t: tokenA, ready: true });
  await req(`/api/room/${roomId}/ready`, 'POST', { t: tokenB, ready: true });

  const s1 = await req(`/api/room/${roomId}/peek?t=${tokenA}`);
  check('开局成功', s1.body.state.phase === 'playing');

  // 4. 导出进度数据
  console.log('3. 导出对局进度');
  const bRes = await req(`/api/room/${roomId}/backup`);
  check('导出进度接口返回 200', bRes.status === 200 && bRes.body.ok);
  const backup = bRes.body.backup;
  check('备份魔数为 FEIHUA_BACKUP', backup.magic === 'FEIHUA_BACKUP');
  check('备份包含棋盘数据', Array.isArray(backup.board) && backup.board.length === 36);
  check('备份包含各席位昵称', backup.seats.A.nick === '李白' && backup.seats.B.nick === '杜甫');

  // 5. 模拟灾难恢复：导入备份数据
  console.log('4. 模拟服务器重启后导入备份恢复对局');
  const iRes = await req('/api/import', 'POST', {
    backup,
    nick: '李白',
    keepRoomId: false // 分配新房号以示区分
  });
  check('导入接口返回 200', iRes.status === 200 && iRes.body.ok);
  check('标记为 imported', iRes.body.imported === true);
  const newRoomId = iRes.body.roomId;
  const newTokenA = iRes.body.token;
  check('恢复者李白认领 A 席', iRes.body.seat === 'A');

  // 6. 查看恢复出的房间状态
  const s2 = await req(`/api/room/${newRoomId}/peek?t=${newTokenA}`);
  const st2 = s2.body.state;
  check('恢复后的房间处于 playing 阶段', st2.phase === 'playing');
  check('恢复后的房间处于暂停保护态（避免超时）', !!st2.paused);
  check('恢复后的棋盘尺寸正确', st2.cfg.size === 6);
  check('恢复后的棋盘格子数正确', st2.chars.length === 36);
  check('A 席在线，B 席保留原昵称杜甫', st2.seats.A.online === true && st2.seats.B.nick === '杜甫');

  // 7. 杜甫通过原昵称连入并认领 B 席
  console.log('5. 杜甫凭原昵称连入新房间');
  const jBack = await req('/api/join', 'POST', {
    roomId: newRoomId,
    nick: '杜甫'
  });
  check('杜甫接回原席位 B', jBack.body.seat === 'B');

  // 8. 恢复原房号测试：保留原房号
  console.log('6. 测试优先保留原房号导入');
  const uniqueId = 'R' + Math.floor(Math.random() * 8999 + 1000);
  const iKeepRes = await req('/api/import', 'POST', {
    backup: { ...backup, id: uniqueId },
    nick: '李白',
    keepRoomId: true,
    roomId: uniqueId
  });
  check('成功保留原房号 ' + uniqueId, iKeepRes.body.roomId === uniqueId);

  console.log('\n全部导出导入测试完成！');
})().catch((e) => {
  console.error('测试出错：', e);
  process.exitCode = 1;
}).finally(() => {
  if (child) {
    try { child.kill(); } catch (_) {}
  }
});
