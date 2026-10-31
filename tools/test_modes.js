'use strict';
/* 单人、三人、四人模式及 20 路棋盘回归测试。
 *
 *   node tools/test_modes.js
 *   node tools/test_modes.js --use=http://127.0.0.1:8799
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const tmpDir = require('./_tmpdir');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else {
    fail++;
    console.log('FAIL ' + name + (extra === undefined ? '' : '  「' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) + '」'));
  }
}

let PORT = 0;
let BASE = '';
let dataDir = '';
let child = null;

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function waitUp(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/api/rooms');
      if (r.ok) return true;
    } catch (_) {}
    await sleep(80);
  }
  return false;
}

async function boot() {
  dataDir = tmpDir('modes');
  for (let p = 8800; p < 8900; p++) {
    if (await portFree(p)) { PORT = p; break; }
  }
  BASE = 'http://127.0.0.1:' + PORT;
  const env = Object.assign({}, process.env, {
    PORT: String(PORT),
    DATA_DIR: dataDir,
  });
  child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (c) => {
    const s = c.toString();
    if (!s.includes('[snap]') && !s.includes('ExperimentalWarning')) {
      process.stderr.write(s);
    }
  });
  if (!(await waitUp(10000))) {
    throw new Error('服务在 ' + PORT + ' 启动超时');
  }
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function get(p) {
  const r = await fetch(BASE + p);
  let data = {};
  try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

async function peekState(roomId, token) {
  const r = await get('/api/room/' + roomId + '/peek?t=' + encodeURIComponent(token));
  return r.data.state || null;
}

const BLOB = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'clauses.txt.gz'))).toString('utf8');
function pickLine(chars, board, seed) {
  const need = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (board.charAt(i) === '0') need.add(chars.charAt(i));
  }
  let p = 3000 + ((seed * 7919) % 20000000);
  for (let i = 0; i < 4000; i++) {
    const e = BLOB.indexOf('\n', p);
    if (e < 0) { p = 0; continue; }
    const ln = BLOB.slice(p, e);
    p = e + 1;
    if (ln.length < 5 || ln.length > 12) continue;
    let hit = 0;
    for (const ch of ln) if (need.has(ch)) hit++;
    if (hit >= 2) return ln;
  }
  return null;
}

function pickThreeClausePoem(chars, board) {
  const candidates = [
    '春眠不觉晓处处闻啼鸟夜来风雨声',
    '白日依山尽黄河入海流欲穷千里目',
    '床前明月光疑是地上霜举头望明月',
    '千山鸟飞绝万径人踪灭孤舟蓑笠翁',
    '空山新雨后天气晚来秋明月松间照',
  ];
  for (const c of candidates) {
    for (let i = 0; i < chars.length; i++) {
      if (board.charAt(i) === '0' && c.includes(chars.charAt(i))) return c;
    }
  }
  return candidates[0];
}

async function main() {
  const argUse = process.argv.find((a) => a.startsWith('--use='));
  if (argUse) {
    BASE = argUse.split('=')[1];
  } else {
    await boot();
  }

  // 1. 20 路棋盘与低频字上下限
  {
    const r1 = await post('/api/create', { nick: '大棋盘主', size: 20, extra: 0 });
    check('20 路创建成功', r1.data.ok === true);
    check('20 路尺寸为 20', r1.data.state.size === 20);
    check('20 路格数为 400', r1.data.state.chars.length === 400);
    check('20 路棋盘自动补充至少 100 低频字', r1.data.state.cfg.extra >= 100, r1.data.state.cfg.extra);
  }

  // 2. 单人模式：准备即开局、轮次自增、撤销与结算免确认
  {
    const rSolo = await post('/api/create', { nick: '独行客', playerCount: 1, size: 8 });
    check('单人房创建成功', rSolo.data.ok === true);
    check('单人房模式为 1', rSolo.data.state.cfg.playerCount === 1);
    check('单人房只有赤营席位', rSolo.data.state.seats.A && !rSolo.data.state.seats.B);

    const roomId = rSolo.data.roomId;
    const tokenA = rSolo.data.token;

    // 单人准备
    const rReady = await post('/api/room/' + roomId + '/ready', { t: tokenA, ready: true });
    check('单人准备返回 started=true', rReady.data.started === true);

    const st1 = await peekState(roomId, tokenA);
    check('单人准备后进入 playing 阶段', st1 && st1.phase === 'playing');
    check('单人当前出手为 A', st1 && st1.turn === 'A');

    // 未收录句测试：单人模式下未收录诗句自动放行通过（via=free），支持玩家自由练习，且不进入争议
    const rFake = await post('/api/room/' + roomId + '/move', { t: tokenA, text: '这是一句根本不存在的假诗句呀' });
    check('单人未收录句自动放行通过（via=free）', rFake.data.ok === true && rFake.data.entry && rFake.data.entry.via === 'free', JSON.stringify(rFake.data));
    const stFake = await peekState(roomId, tokenA);
    check('单人房间状态无 dispute', !stFake.dispute);
    check('单人未收录句落子后轮次递增到第 2 轮', stFake && stFake.round === 2);

    // 单人撤销假句落子
    const rUndoFake = await post('/api/room/' + roomId + '/undo', { t: tokenA });
    check('单人撤销假句无需对方同意直接生效', rUndoFake.data.undone === true);
    const stBack = await peekState(roomId, tokenA);
    check('撤销后回退到第 1 轮', stBack && stBack.round === 1);

    // 重新出手一次：单人模式提交 3 句诗（15字），不受两句限制，直接出手成功
    const ln1 = pickThreeClausePoem(stBack.chars, stBack.board);
    const rMove1 = await post('/api/room/' + roomId + '/move', { t: tokenA, text: ln1 });
    check('单人提交3句诗不受限直接出手成功', rMove1.data.ok === true, JSON.stringify(rMove1.data));

    const st2 = await peekState(roomId, tokenA);
    check('单人出手后仍轮到 A', st2 && st2.turn === 'A');
    check('单人无 dispute 状态', !st2.dispute);
    check('单人轮次递增到第 2 轮', st2 && st2.round === 2);

    // 单人撤销
    const rUndo = await post('/api/room/' + roomId + '/undo', { t: tokenA });
    check('单人撤销无需对方同意直接生效', rUndo.data.undone === true);
    const st3 = await peekState(roomId, tokenA);
    check('撤销后回退到第 1 轮', st3 && st3.round === 1);

    // 单人提前结算
    const rFin = await post('/api/room/' + roomId + '/finish', { t: tokenA });
    check('单人提前结算无需对方同意直接生效', rFin.data.finished === true);
    const st4 = await peekState(roomId, tokenA);
    check('提前结算后进入 finished 阶段', st4 && st4.phase === 'finished');
  }

  // 3. 三人模式：A, B, C 全员准备与轮次轮转
  {
    const r3 = await post('/api/create', { nick: '赤方主', playerCount: 3, size: 7 });
    const roomId = r3.data.roomId;
    const tokA = r3.data.token;

    const jB = await post('/api/join', { roomId, nick: '青方客' });
    check('三人房 B 成功加入青营', jB.data.seat === 'B');
    const tokB = jB.data.token;

    const jC = await post('/api/join', { roomId, nick: '金方客' });
    check('三人房 C 成功加入金营', jC.data.seat === 'C');
    const tokC = jC.data.token;

    // 第四人加入应成为观众
    const jD = await post('/api/join', { roomId, nick: '围观群众' });
    check('三人房第四人成为观众', jD.data.role === 'spectator' && !jD.data.seat);

    // 准备
    await post('/api/room/' + roomId + '/ready', { t: tokA, ready: true });
    await post('/api/room/' + roomId + '/ready', { t: tokB, ready: true });
    const rCReady = await post('/api/room/' + roomId + '/ready', { t: tokC, ready: true });
    check('三人全准备好后开局', rCReady.data.started === true);

    const stPlaying = await peekState(roomId, tokA);
    check('三人第一手为 A', stPlaying && stPlaying.turn === 'A');

    const lnA = pickLine(stPlaying.chars, stPlaying.board, 2) || '春眠不觉晓';
    const mA = await post('/api/room/' + roomId + '/move', { t: tokA, text: lnA });
    check('A 出手成功', mA.data.ok === true);
    const stAfterA = await peekState(roomId, tokA);
    check('A 出手后轮到 B', stAfterA && stAfterA.turn === 'B');

    const lnB = pickLine(stAfterA.chars, stAfterA.board, 3) || '白日依山尽';
    const mB = await post('/api/room/' + roomId + '/move', { t: tokB, text: lnB });
    check('B 出手成功', mB.data.ok === true);
    const stAfterB = await peekState(roomId, tokB);
    check('B 出手后轮到 C', stAfterB && stAfterB.turn === 'C');

    const lnC = pickLine(stAfterB.chars, stAfterB.board, 4) || '红豆生南国';
    const mC = await post('/api/room/' + roomId + '/move', { t: tokC, text: lnC });
    check('C 出手成功', mC.data.ok === true);
    const stAfterC = await peekState(roomId, tokC);
    check('C 出手后回到 A，进入第 2 轮', stAfterC && stAfterC.turn === 'A' && stAfterC.round === 2);
    check('比分包含 a, b, c', stAfterC.score.a > 0 && stAfterC.score.b > 0 && stAfterC.score.c > 0);
  }

  // 4. 四人模式：四营全开
  {
    const r4 = await post('/api/create', { nick: '赤1', playerCount: 4, size: 8 });
    const roomId = r4.data.roomId;
    const tA = r4.data.token;
    const jB = await post('/api/join', { roomId, nick: '青2' });
    const jC = await post('/api/join', { roomId, nick: '金3' });
    const jD = await post('/api/join', { roomId, nick: '翠4' });
    check('四人席位分配 A, B, C, D 正确',
      r4.data.seat === 'A' && jB.data.seat === 'B' && jC.data.seat === 'C' && jD.data.seat === 'D');

    // 大厅房间信息验证
    const listRes = await get('/api/rooms');
    const rm = (listRes.data.rooms || []).find((x) => x.id === roomId);
    check('大厅显示 playerCount 为 4', rm && rm.playerCount === 4);
    check('大厅 players 包含 A, B, C, D', rm && rm.players.A && rm.players.B && rm.players.C && rm.players.D);
  }

  // 5. 自定义字数上限：建房默认 17、自定义上限生效、超长触发争议、动态调整
  {
    const rDef = await post('/api/create', { nick: '默认上限' });
    check('默认提交字数上限为 17', rDef.data.state.cfg.maxPoemLen === 17);

    const rCustom = await post('/api/create', { nick: '自定义上限', maxPoemLen: 10 });
    check('自定义上限 10 生效', rCustom.data.state.cfg.maxPoemLen === 10);
    const roomId = rCustom.data.roomId;
    const tA = rCustom.data.token;
    const jB = await post('/api/join', { roomId, nick: '对手B' });
    const tB = jB.data.token;

    // 开局前通过 /cfg 调整字数上限为 12
    const rCfg = await post('/api/room/' + roomId + '/cfg', { t: tA, maxPoemLen: 12 });
    check('通过 /cfg 调整上限为 12', rCfg.data.ok && rCfg.data.cfg.maxPoemLen === 12);

    // 双方准备开局
    await post('/api/room/' + roomId + '/ready', { t: tA, ready: true });
    await post('/api/room/' + roomId + '/ready', { t: tB, ready: true });

    // 提交 >12 字词（非诗），且确保命中棋盘空格子，超过 12 字上限触发争议
    const stReady = await peekState(roomId, tA);
    const candidateCis = [
      '大江东去浪淘尽千古风流人物',
      '明月几时有把酒问青天不知天上宫阙',
      '千里孤坟无处话凄凉纵使相逢应不识',
      '莫听穿林打叶声何妨吟啸且徐行',
      '寻寻觅觅冷冷清清凄凄惨惨戚戚'
    ];
    let longCi = candidateCis[0];
    for (const ci of candidateCis) {
      if (stReady.chars.split('').some((ch, idx) => stReady.board.charAt(idx) === '0' && ci.includes(ch))) {
        longCi = ci; break;
      }
    }
    const rOver = await post('/api/room/' + roomId + '/move', { t: tA, text: longCi });
    check('词超过自定义上限触发争议', rOver.data.code === 'dispute' && rOver.data.pending === true);
    check('争议提示包含自定义上限 12 字', rOver.data.reason && rOver.data.reason.includes('超过 12 字上限'), rOver.data.reason);

    const stDisp = await peekState(roomId, tA);
    check('dispute 状态中记录 maxLen 12', stDisp.dispute && stDisp.dispute.maxLen === 12);
  }

  // 6. 细粒度文体单次提交限制：诗至多前后两句，词/曲/赋/文按字数上限，单人模式不受限
  {
    const r = await post('/api/create', { nick: '规则房主', size: 10 });
    const roomId = r.data.roomId;
    const tA = r.data.token;
    const jB = await post('/api/join', { roomId, nick: '规则对手' });
    const tB = jB.data.token;
    await post('/api/room/' + roomId + '/ready', { t: tA, ready: true });
    await post('/api/room/' + roomId + '/ready', { t: tB, ready: true });

    const stBeforeA = await peekState(roomId, tA);
    // ① 诗：提交同一联前后两句正常通过
    const candidatePoems = [
      '举头望明月低头思故乡',
      '朝辞白帝彩云间千里江陵一日还',
      '白日依山尽黄河入海流',
      '春眠不觉晓处处闻啼鸟'
    ];
    let textPoem = candidatePoems[0];
    for (const cp of candidatePoems) {
      for (let i = 0; i < stBeforeA.chars.length; i++) {
        if (stBeforeA.board.charAt(i) === '0' && cp.includes(stBeforeA.chars.charAt(i))) {
          textPoem = cp; break;
        }
      }
    }
    const rPoem2 = await post('/api/room/' + roomId + '/move', { t: tA, text: textPoem });
    check('诗提交同一联两句正常通过', rPoem2.data.ok === true, JSON.stringify(rPoem2.data));

    // ①-2 诗：跨联提交两句（上一联下句+下一联上句，如“疑是地上霜举头望明月”），必须触发跨联争议
    const rCross = await post('/api/room/' + roomId + '/move', { t: tB, text: '疑是地上霜举头望明月' });
    check('诗跨联提交两句触发争议', rCross.data.code === 'dispute' && rCross.data.pending === true);
    check('跨联争议说明包含跨联提醒', rCross.data.reason && rCross.data.reason.includes('跨联两句'), rCross.data.reason);

    const stCross = await peekState(roomId, tB);
    check('争议状态 kind 为 cross_couplet', stCross.dispute && stCross.dispute.kind === 'cross_couplet');

    // 对手判重填，解除争议，仍轮到 B
    await post('/api/room/' + roomId + '/dispute', { t: tA, accept: false });

    // ② 诗：提交三句（五言三句 15 字，虽然 <=17 字，但文体是诗且含 3 句），必须触发争议
    const rPoem3 = await post('/api/room/' + roomId + '/move', { t: tB, text: '床前明月光疑是地上霜举头望明月' });
    check('诗提交三句触发争议', rPoem3.data.code === 'dispute' && rPoem3.data.pending === true);
    check('诗超句争议说明包含两句上限与句数', rPoem3.data.reason && rPoem3.data.reason.includes('诗每次至多提交前后两句') && rPoem3.data.reason.includes('3 句'), rPoem3.data.reason);

    const stPoem3 = await peekState(roomId, tB);
    check('争议状态 kind 为 too_many_clauses', stPoem3.dispute && stPoem3.dispute.kind === 'too_many_clauses');

    // 对手判重填，争议解除，计时恢复，仍轮到 B
    const rRul = await post('/api/room/' + roomId + '/dispute', { t: tA, accept: false });
    check('对手裁定重填成功', rRul.data.ok === true && rRul.data.rejected === true);

    // ③ 词：长短句不规则文体，字数 <= 17，不受两句限制，由 B 正常提交通过并落子
    const stBeforeB = await peekState(roomId, tB);
    const candidateCis = [
      '春花秋月何时了往事知多少',
      '明月几时有把酒问青天',
      '东风夜放花千树更吹落星如雨',
      '去年元夜时花市灯如昼',
      '无可奈何花落去似曾相识燕归来'
    ];
    let textCi = candidateCis[0];
    for (const cc of candidateCis) {
      for (let i = 0; i < stBeforeB.chars.length; i++) {
        if (stBeforeB.board.charAt(i) === '0' && cc.includes(stBeforeB.chars.charAt(i))) {
          textCi = cc; break;
        }
      }
    }
    const rCiMulti = await post('/api/room/' + roomId + '/move', { t: tB, text: textCi });
    check('词提交在字数内正常通过', rCiMulti.data.ok === true, JSON.stringify(rCiMulti.data));

    // B 提交后轮到 A，④ 词：由 A 提交超过 17 字上限（20字），触发争议
    const rCiLong = await post('/api/room/' + roomId + '/move', { t: tA, text: '大江东去浪淘尽千古风流人物故垒西边人道是' });
    check('词超过 17 字上限触发争议', rCiLong.data.code === 'dispute' && rCiLong.data.pending === true, JSON.stringify(rCiLong.data));
    check('词超长争议说明包含 17 字上限', rCiLong.data.reason && rCiLong.data.reason.includes('超过 17 字上限'), rCiLong.data.reason);
  }

  // 6. 诗联句限制可选项（limitCouplet）：建房时关闭该限制后，诗跨联/多句（<=17字）不触发争议直接落子
  {
    const rNoLimit = await post('/api/create', { nick: '放宽主', playerCount: 2, size: 8, limitCouplet: false });
    check('创建关闭诗联句限制的房间成功', rNoLimit.data.ok === true);
    check('房间 cfg.limitCouplet 为 false', rNoLimit.data.state.cfg.limitCouplet === false);
    const roomId = rNoLimit.data.roomId;
    const tA = rNoLimit.data.token;
    const jB = await post('/api/join', { roomId, nick: '放宽客' });
    const tB = jB.data.token;
    await post('/api/room/' + roomId + '/ready', { t: tA, ready: true });
    await post('/api/room/' + roomId + '/ready', { t: tB, ready: true });

    // A 提交原本会触发跨联争议的两句（<=17字）：此时不限制联句，应直接通过！
    const crossCandidates = [
      '处处闻啼鸟夜来风雨声',
      '疑是地上霜举头望明月',
      '黄河入海流欲穷千里目',
      '万径人踪灭孤舟蓑笠翁',
      '天气晚来秋明月松间照'
    ];
    const stNoLimit = await peekState(roomId, tA);
    let crossText = crossCandidates[0];
    for (const c of crossCandidates) {
      for (let i = 0; i < stNoLimit.chars.length; i++) {
        if (stNoLimit.board.charAt(i) === '0' && c.includes(stNoLimit.chars.charAt(i))) {
          crossText = c;
          break;
        }
      }
    }
    const rPassCross = await post('/api/room/' + roomId + '/move', { t: tA, text: crossText });
    check('关闭诗联句限制时，跨联两句直接通过落子', rPassCross.data.ok === true, JSON.stringify(rPassCross.data));

    // 裁判或选手通过开局设置改回 limitCouplet: true（在下一局或 waiting 时生效）
  }

  console.log('\n==============================');
  console.log('测试完成: ' + pass + ' 通过, ' + fail + ' 失败');
  console.log('==============================');
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('测试异常：' + e.message);
  process.exitCode = 1;
}).finally(() => {
  if (child) {
    try { child.kill(); } catch (_) {}
  }
});
