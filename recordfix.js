'use strict';
/* 存档阵营修复：把「金营 / 翠营」被记成空白的旧存档补回来。
 *
 * 背景 —— 2026-10-22 发现审阅页把金营翠营一律显示成青营。查下去是两层：
 *   ① 落盘那一刻 `archiveGame()` 只写了 A/B 两个席位，C/D 的昵称当场就丢了；
 *   ② 前端渲染又写了 `e.team === 'A' ? '赤' : '青'`，C/D 的每一手都被标成青营。
 * ② 已经改了（提交 6eb50c4），但 ① 丢掉的昵称在存档里是**真的没有**，
 * 改渲染改不回来 —— 所以需要把旧的那几行补上。
 *
 * 好在存档里留了足够的证据，不需要猜：
 *   · `log[]` 里每一条 `fly` 都有 `team`（席位）与 `byNick`（**那一手当时的最终昵称**）；
 *   · `events[]` 里每一条 `fly` 都有 `seat` 与 `mid`，**顺序与 log 里的 fly 一一对应**
 *     （两边都是「打完一手记一条」），所以同一手能同时拿到 mid 与昵称。
 *
 * 为什么不用 events 自己算昵称：一个席位会被换人坐（实测某局的 B 席先来一个人、
 * 又换成另一个人），按「events 里该席位的昵称」去还原会张冠李戴。
 * 为什么只用最后一手：席位中途换人时，最后一手才是结束时坐这个席位的人 ——
 * 与「比分记在谁头上」一致（实测 log 的 byNick 与存档老字段 257/257 全一致）。
 *
 * 修复原则：**只补空，不覆盖**。已有非空昵称/编号的席位一律原样留着，
 * 对不上的写进 conflicts 让人看 —— 宁可少修，不可改错。
 */

const SEATS = ['A', 'B', 'C', 'D'];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* 这一局应该有几个人：cfg.playerCount 为准；
   没写 playerCount 的老存档，用「log 里真的出现过几号席位」兜底（不超 4）。 */
function seatNeed(rec) {
  let n = Math.round(num(rec && rec.cfg && rec.cfg.playerCount));
  if (!n) {
    let last = 0;
    for (const e of (rec && rec.log) || []) {
      const i = SEATS.indexOf(String((e && e.team) || '').toUpperCase());
      if (i + 1 > last) last = i + 1;
    }
    n = last || 2;
  }
  return Math.max(1, Math.min(4, n));
}

/* 把 log 的 fly 与 events 的 fly 按顺序配对，得到「哪一手 / 哪个席位 / 谁(mid) / 叫什么」。
   两边长度不一致时按短的配对，剩下的（少见：老版本某类事件没记）不给 mid，只给昵称。 */
function flyPairs(rec) {
  const logFly = ((rec && rec.log) || []).filter((e) => e && e.type === 'fly');
  const evFly = ((rec && rec.events) || []).filter((e) => e && e.type === 'fly');
  const out = [];
  const n = Math.max(logFly.length, evFly.length);
  for (let i = 0; i < n; i++) {
    const l = logFly[i] || null;
    const v = evFly[i] || null;
    let team = l ? l.team : (v ? v.seat : '');
    team = String(team || '').toUpperCase();
    if (!SEATS.includes(team)) continue;
    /* 对齐的两条若不是同一个席位，说明顺序真的错位了 —— 这时宁可只信昵称（log 自带席位），
       不拿 ev 的 mid 去配，免得把别人的编号安到这个席位头上。 */
    const sameSeat = !!(l && v && String(v.seat || '').toUpperCase() === team);
    out.push({
      i: i,
      seat: team,
      nick: l && l.byNick ? String(l.byNick) : '',
      mid: sameSeat && v.mid ? String(v.mid) : '',
      aligned: sameSeat,
    });
  }
  return out;
}

/* 某一席位的最终归属：取该席位最后一手。
   昵称以 log 为准（自带席位，最可靠）；mid 以对齐到同一手的那条事件为准。 */
function lastOfSeat(pairs, seat) {
  let nick = '';
  let mid = '';
  let hands = 0;
  for (const p of pairs) {
    if (p.seat !== seat) continue;
    hands++;
    if (p.nick) nick = p.nick;
    if (p.mid) mid = p.mid;
  }
  /* mid 兜底：万一 events 的 fly 少于 log（老存档），退到「该席位最后一条带 mid 的事件」。
     这样拿到的可能是先前来过又走了的人，所以只在没有任何对齐结果时才用。 */
  return { nick: nick, mid: mid, hands: hands };
}

function midFromEvents(rec, seat) {
  const ev = (rec && rec.events) || [];
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i];
    if (!e || !e.mid) continue;
    if (String(e.seat || '').toUpperCase() === seat) return String(e.mid);
  }
  return '';
}

/* 修一局。返回 { changed, players, patches[], conflicts[], need }
   patches 里每条 = { seat, field, from, to, why }，给人看「改了什么、凭什么改」。 */
function repairRecord(rec) {
  const need = seatNeed(rec);
  const pairs = flyPairs(rec);
  const players = Object.assign({}, (rec && rec.players) || {});
  const patches = [];
  const conflicts = [];

  for (let i = 0; i < need; i++) {
    const seat = SEATS[i];
    const cur = players[seat];
    const got = lastOfSeat(pairs, seat);
    const usedMid = got.mid || midFromEvents(rec, seat);

    /* 这一席压根没出过手，也没有任何席位线索 —— 就是空位，别硬塞名字。 */
    if (!got.hands) continue;

    if (!cur || typeof cur !== 'object') {
      if (!got.nick && !usedMid) continue;
      players[seat] = { nick: got.nick || '', mid: usedMid || '' };
      patches.push({
        seat: seat, field: '*', from: null, to: players[seat].nick || '(无昵称)',
        why: '存档里没有这个席位；该席共登记 ' + got.hands + ' 手，取最后一手的出手人',
      });
      continue;
    }

    const curNick = cur.nick ? String(cur.nick) : '';
    const curMid = cur.mid ? String(cur.mid) : '';

    if (!curNick && got.nick) {
      players[seat] = { nick: got.nick, mid: curMid || usedMid || '' };
      patches.push({ seat: seat, field: 'nick', from: '', to: got.nick, why: '该席最后一手的出手人' });
    } else if (curNick && got.nick && curNick !== got.nick) {
      /* 已有昵称但与最后一手对不上：不改，只报。可能是改过名，也可能是席位换人。 */
      conflicts.push({
        seat: seat, field: 'nick', kept: curNick, seen: got.nick,
        why: '存档已有昵称，与该席最后一手不一致，保持原值',
      });
    }

    const midNow = (players[seat] && players[seat].mid) ? String(players[seat].mid) : '';
    if (!midNow && usedMid) {
      players[seat] = { nick: (players[seat] && players[seat].nick) || got.nick || '', mid: usedMid };
      patches.push({ seat: seat, field: 'mid', from: '', to: usedMid, why: '该席最后一手对应的玩家编号' });
    }
  }

  return { changed: patches.length > 0, need: need, players: players, patches: patches, conflicts: conflicts };
}

/* 整份 JSONL 文本一起修：保留原始行序、跳过空行与坏行（坏行原样放回，不丢数据）。 */
function repairText(text) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  const out = [];
  const report = [];
  let fixed = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) { out.push(ln); continue; }
    let rec;
    try { rec = JSON.parse(ln); } catch (_) { out.push(ln); continue; }
    const r = repairRecord(rec);
    if (r.changed) {
      rec.players = r.players;
      out.push(JSON.stringify(rec));
      fixed++;
      report.push({
        line: i + 1, id: rec.id, at: rec.at, need: r.need,
        patches: r.patches, conflicts: r.conflicts,
      });
    } else {
      out.push(ln);
      if (r.conflicts.length) {
        report.push({
          line: i + 1, id: rec.id, at: rec.at, need: r.need,
          patches: [], conflicts: r.conflicts,
        });
      }
    }
  }
  return { text: out.join('\n'), fixed: fixed, report: report, total: lines.filter(Boolean).length };
}

module.exports = { SEATS, seatNeed, flyPairs, lastOfSeat, repairRecord, repairText };
