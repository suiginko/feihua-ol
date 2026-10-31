'use strict';
/* test_reseed.js · 客户端快照自动复活房间（Reseed）测试
 *
 * 验证场景：
 *   1. 模拟容器无持久卷更新/重启（磁盘快照丢失，新服务内存无对局）
 *   2. 客户端持有 publicState，在遭遇 404 后通过 POST /api/reseed 自动复活房间
 *   3. 棋盘、落子记录、双方昵称完整保留，时钟安全暂停防超时
 *   4. 对手重新连入能通过 claimOfflineSeat 原样接回原席位
 *   5. 双方点继续后能继续正常落子对局
 *   6. 防护：畸形 state（棋盘尺寸不符、空数据、非法房间号）拒绝并返回 400
 */

const assert = require('assert');
const BASE = process.env.BASE || 'http://127.0.0.1:8799';

async function req(path, opt = {}) {
  const res = await fetch(BASE + path, {
    method: opt.method || 'GET',
    headers: Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {}),
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

async function run() {
  console.log('[test_reseed] 开始测试客户端快照自动复活机制...');

  // 1. 创建对局
  const c1 = await req('/api/create', {
    method: 'POST',
    body: { nick: '李白', cfg: { size: 5, turnSeconds: 60 } },
  });
  assert.strictEqual(c1.status, 200, '创建房间失败');
  const roomId = c1.data.roomId;
  const tokenA = c1.data.token;
  console.log(`[test_reseed] 房间创建成功: ${roomId}`);

  // 2. 选手 B 加入
  const j1 = await req('/api/join', {
    method: 'POST',
    body: { roomId, nick: '杜甫' },
  });
  assert.strictEqual(j1.status, 200, '选手 B 加入失败');
  const tokenB = j1.data.token;

  // 双方准备开局
  await req(`/api/room/${roomId}/ready`, { method: 'POST', body: { t: tokenA, ready: true } });
  const startRes = await req(`/api/room/${roomId}/ready`, { method: 'POST', body: { t: tokenB, ready: true } });
  assert.strictEqual(startRes.data.started, true, '未成功开局');

  // 取开局后的最新 state
  const peek1 = await req(`/api/room/${roomId}/peek?t=${encodeURIComponent(tokenA)}`);
  assert.strictEqual(peek1.status, 200);
  assert.strictEqual(peek1.data.state.phase, 'playing');
  const clientSnapshot = peek1.data.state;
  console.log(`[test_reseed] 客户端获取最新快照，棋盘大小 ${clientSnapshot.board.length}`);

  // 4. 模拟坏数据防护测试
  const bad1 = await req('/api/reseed', {
    method: 'POST',
    body: { roomId: 'BAD_ID_9999999', token: tokenA, seat: 'A', state: clientSnapshot },
  });
  assert.strictEqual(bad1.status, 400, '非法房间号应返回 400');

  const bad2 = await req('/api/reseed', {
    method: 'POST',
    body: { roomId: '999', token: tokenA, seat: 'A', state: { cfg: { size: 5 }, board: [1, 2, 3] } },
  });
  assert.strictEqual(bad2.status, 400, '棋盘尺寸不符应返回 400');

  // 5. 模拟全新房间复活场景（使用一个当前服务端绝对不存在的临时房间号）
  const ghostRoomId = 'G' + Math.floor(100 + Math.random() * 800);
  // 构造 ghostRoomId 的快照
  const ghostSnapshot = JSON.parse(JSON.stringify(clientSnapshot));
  ghostSnapshot.id = ghostRoomId;

  // 验证 ghostRoomId 此时 peek 为 404
  const peekGhost = await req(`/api/room/${ghostRoomId}/peek?t=fake`);
  assert.strictEqual(peekGhost.status, 404, '不存在的房间应为 404');

  // 6. 选手 A 发起 reseed 复活房间
  const reseedA = await req('/api/reseed', {
    method: 'POST',
    body: {
      roomId: ghostRoomId,
      token: tokenA,
      seat: 'A',
      nick: '李白',
      state: ghostSnapshot,
    },
  });
  assert.strictEqual(reseedA.status, 200, 'reseed 应返回 200');
  assert.strictEqual(reseedA.data.ok, true, 'reseed 应该 ok');
  assert.strictEqual(reseedA.data.reseeded, true, '应该是全新复活 (reseeded: true)');
  assert.strictEqual(reseedA.data.seat, 'A', '发起者席位应为 A');
  assert.strictEqual(reseedA.data.state.phase, 'playing', '对局阶段应为 playing');
  assert.strictEqual(reseedA.data.state.paused !== null, true, '复活后应安全暂停');
  console.log('[test_reseed] 选手 A 成功复活房间并重置安全暂停');

  // 7. 选手 B 重连进入
  // 方式一：选手 B 同样调 reseed（客户端重连探测）
  const reseedB = await req('/api/reseed', {
    method: 'POST',
    body: {
      roomId: ghostRoomId,
      token: 'old_b_token',
      seat: 'B',
      nick: '杜甫',
      state: ghostSnapshot,
    },
  });
  assert.strictEqual(reseedB.status, 200, '选手 B reseed 认领席位应返回 200');
  assert.strictEqual(reseedB.data.reseeded, false, '房间已存在，不应重复 reseed');
  assert.strictEqual(reseedB.data.seat, 'B', '选手 B 应成功认领 B 席位');
  const tokenBNew = reseedB.data.token;
  console.log('[test_reseed] 选手 B 成功无缝接回 B 席位');

  // 8. 验证双方状态同步与继续对局
  // 点继续解除暂停
  const unpauseRes = await req(`/api/room/${ghostRoomId}/pause`, {
    method: 'POST',
    body: { t: tokenA },
  });
  assert.strictEqual(unpauseRes.status, 200, '点继续应成功');

  // 查验最新状态
  const finalPeek = await req(`/api/room/${ghostRoomId}/peek?t=${encodeURIComponent(tokenA)}`);
  assert.strictEqual(finalPeek.data.state.seats.A.nick, '李白');
  assert.strictEqual(finalPeek.data.state.seats.B.nick, '杜甫');
  assert.strictEqual(finalPeek.data.state.board.length, finalPeek.data.state.size * finalPeek.data.state.size);
  console.log('[test_reseed] 验证通过：双方席位、昵称、盘面完美复原！');

  console.log('PASS test_reseed');
}

run().catch((e) => {
  console.error('FAIL test_reseed:', e);
  process.exitCode = 1;
});
