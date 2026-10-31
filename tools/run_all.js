/* 全量回归：一条命令跑完所有 test_*.js，并在结尾给汇总。
 *
 * 默认行为（推荐）：
 *   node tools/run_all.js
 *   → 自己在一个空闲端口起临时实例，跑完**全部**测试（含 test_batch2），然后关掉。
 *     不碰你正在用的 8787，也不留垃圾；结果可复现。
 *
 * 针对已有实例：
 *   node tools/run_all.js --use=http://127.0.0.1:8799
 *   → 用你指定的实例，**跳过 test_batch2**（它末尾会把 1000 个房号全占满，实例就废了）。
 *
 * 顺序是固定的，不要随意调换：
 *   1) 纯本地测试（不吃服务）先跑，速度快、失败早暴露；
 *   2) 剩下的打 HTTP 接口；
 *   3) test_batch2 永远最后。
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = __dirname;

/* 纯本地：不需要起服务（自己起停临时实例的也算在这里，跟主实例无关） */
const LOCAL = [
  ['test_memory', '内存回归：语料加载后 rss / 堆上限 / 加载耗时（纯本地，只加载语料）'],
  ['test_judge', '判定核心（语料匹配 / 出处打分）'],
  ['test_poem_detection', '诗词联句与跨联综合检测（古风/楚辞/汉魏/歌行不误判）'],
  ['test_share_link', '邀请链接是否保留 sharecode（jsdom）'],
  ['test_no_netmask', '断线遮罩已移除：DOM/文案/逻辑不许回来，但重连与探测必须还在（jsdom）'],
  ['test_leave', '离开房间 / 掉线 / 重进（自带短超时实例）'],
  ['test_snapshot', '发布保护：房间落盘 / 重启恢复（自带实例）'],
  ['test_feedback_pull', '反馈取件：fid / 增量 / peek-commit（自带实例）'],
  ['test_notice', '公告栏：口令 / 截断 / 撤下 / 重启后还在（自带实例）'],
  ['test_records', '存档定位：同房号多局靠 rid 区分（自带实例）'],
  ['test_modes', '单人/三人/四人模式与20路棋盘（自带实例）'],
  ['test_dispute_ui', '争议裁决条：提交方 / 对手 / 裁判 / 观众（jsdom）'],
  ['test_export_multi', '导出截图与 GIF 的多人配色、列数（jsdom + 画布桩）'],
  ['test_dev_mode', '开发者模式：隐形观战 / 大厅可见私密房（自带实例）'],
  ['test_dev_ui', '开发者模式前端：口令不外泄 / 私密标 / 隐形提示（jsdom）'],
  ['test_admin_multi', '审阅页多人存档：金营翠营不丢昵称、不记成青营（自带实例 + jsdom）'],
  ['test_record_fix', '存档阵营回填：只补空不覆盖、幂等、预演不落盘（自带实例）'],
  ['test_custom_pool', '自定义字库与单格重随：字库优先、系统补全、开局后锁死（自带实例）'],
  ['test_reroll_class', '单格重随跟着字库设置走：常用/低频/自定义三类各抽各的（自带实例）'],
  ['test_custom_pool_ui', '自定义字库前端：点格子发 reroll、无权限不发请求（jsdom）'],
  ['test_nick_limit', '自定义昵称 24 小时一次：随机名放行、冒充 random 被拦、重启后仍受限（自带实例）'],
  ['test_nick_limit_ui', '自定义昵称前端：提醒文案、随机按钮、额度用掉时一个请求都不发（jsdom）'],
  ['test_nick_lobby', '大厅改名（建房/加入）同一套额度：冷却拦住、诗人名放行、没进成不扣（自带实例）'],
  ['test_nick_lobby_ui', '大厅改名前端：站内弹窗替掉 confirm、冷却中可一键换诗人名（jsdom）'],
  ['test_crash', '崩溃兜底：未捕获异常不再退出 / 畸形请求只坏一条 / crash.log（自带实例）'],
  ['test_sse_dead', 'SSE 死连接：写前先看 writableEnded、断线风暴不连累别人（自带实例）'],
  ['test_progress_backup', '进度导出到本地与进度导入恢复（自带实例）'],
  ['test_stepper_input', '数字输入框步进器与输入控制器（上调下调/输入不截断/jsdom）'],
  ['test_log_scroll', '飞花记录滚动定位：浏览历史时不强制拉回顶部（视口补偿/jsdom）'],
];

/* 需要 jsdom 的（没装就跳过而不是判失败） */
const NEEDS_JSDOM = ['test_share_link', 'test_no_netmask', 'test_dispute_ui', 'test_export_multi', 'test_dev_ui', 'test_admin_multi', 'test_custom_pool_ui', 'test_nick_limit_ui', 'test_nick_lobby_ui', 'test_stepper_input', 'test_log_scroll'];

/* 打接口的，按依赖关系排好；batch2 必须最后 */
const REMOTE = [
  ['test_room_ops', '房号 / 计时 / 撤销 / 提前结算'],
  ['test_members', '成员与身份'],
  ['test_referee', '裁判权限 / 开局设置'],
  ['test_ruler', '裁定来源标注'],
  ['test_polish', '分句 / 配色 / 大厅排序'],
  ['test_new_features', '争议出处回填 / 自由提交 / 起止时间'],
  ['test_no_blank_dispute', '无未占领格直接拦截：绝不触发争议让对手裁决'],
  ['test_reseed', '状态复活：抹盘重启 / 客户端快照复原'],
  ['test_e2e', '端到端打完一局'],
];

/* 破坏性：末尾会把 000–999 全部占满 */
const DESTRUCTIVE = ['test_batch2', '存档 / 反馈 / 房号上限（占满房号）'];

/* ---------- 小工具 ---------- */

/* 中文字符占两列，否则汇总表会歪 */
function dispWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}
function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - dispWidth(s)));
}

/* Windows 的 SO_REUSEADDR 让 bind() 在端口「已经有人在监听」时照样成功，
   所以「bind 没报错」根本不能证明端口空闲 —— 上一轮就有实例占着 8799，
   这里以为空着，起了一个新进程，结果请求全打到旧实例上（测的不是这次的代码）。
   先真的连一次：连得上就是有人在服务，直接判占用。 */
function inUse(port) {
  return new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy(); } catch (_) {} res(v); };
    s.setTimeout(500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

async function portFree(port) {
  if (await inUse(port)) return false;
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  for (let p = 8799; p <= 8820; p++) if (await portFree(p)) return p;
  return null;
}

async function reachable(base) {
  try {
    const r = await fetch(base + '/api/rooms', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function waitReady(base, limitMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < limitMs) {
    if (await reachable(base)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function hasJsdom() {
  try { require.resolve('jsdom'); return true; } catch (_) { return false; }
}

/* 各脚本的汇总格式不统一（judge 用「通过 37 / 37」、其余用行内 PASS/FAIL），
   所以成败一律看退出码，这里的数字只用于展示。 */
function summarize(out) {
  const m = out.match(/通过\s*(\d+)\s*\/\s*(\d+)/);
  if (m) return { text: '通过 ' + m[1] + '/' + m[2], pass: +m[1], fail: +m[2] - +m[1] };
  const pass = (out.match(/^\s*PASS\b/gm) || []).length;
  const fail = (out.match(/^\s*FAIL\b/gm) || []).length;
  if (pass || fail) return { text: 'PASS ' + pass + (fail ? ' / FAIL ' + fail : ''), pass, fail };
  /* 有的脚本（如 test_e2e）只打过程日志、不打汇总行，成败由退出码与 !! 标记体现 */
  return { text: /^\s*!!/m.test(out) ? '完成（含 !! 警告）' : '完成', pass: 0, fail: 0 };
}

function runOne(name, base) {
  const file = path.join(TOOLS, name + '.js');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { BASE: base }),
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const s = summarize(out);
  return {
    ok: r.status === 0 && !r.error,
    pass: s.pass,
    fail: s.fail,
    text: r.error ? '异常 ' + r.error.message : s.text,
    ms: Date.now() - t0,
    out,
  };
}

/* ---------- 主流程 ---------- */

(async () => {
  const useArg = process.argv.find((a) => a.startsWith('--use='));
  let base = null;
  let child = null;
  let mode = '';

  if (useArg) {
    base = useArg.slice('--use='.length).replace(/\/+$/, '');
    mode = '指定实例（跳过 test_batch2：它会把房号占满）';
    if (!(await reachable(base))) {
      console.error('!! 连不上 ' + base + '，请先起实例，或直接 node tools/run_all.js（会自动起一个）');
      process.exit(1);
    }
  } else {
    const port = await pickPort();
    if (!port) {
      console.error('!! 8799–8820 全被占用，找不到空端口。');
      process.exit(1);
    }
    base = 'http://127.0.0.1:' + port;
    mode = '自起临时实例 ' + port + '（跑完自动关闭）';
    console.log('启动临时实例（端口 ' + port + '）…');
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(port),
        DATA_DIR: require('./_tmpdir')('run-all'),   /* 别写进项目的 data/ */
      }),
      stdio: 'ignore',
    });
    const ready = await waitReady(base, 45000);
    if (!ready) {
      console.error('!! 实例 45 秒内没就绪。手动试试： PORT=' + port + ' node server.js');
      try { child.kill(); } catch (_) {}
      process.exit(1);
    }
    /* 关键自证：端口上回答的必须是我刚起的那个进程。
       Windows 的 SO_REUSEADDR 允许两个进程同时绑同一个端口，所以「.listen() 成功」
       根本不能证明端口是空的 —— 2026-10-21 就因此把一整轮测试（含会把房号占满的
       test_batch2）打到了上一轮遗留的实例上，结果是「全过」但测的不是这次的代码。 */
    let pid = 0;
    try { pid = (await (await fetch(base + '/api/stats')).json()).pid || 0; } catch (_) {}
    if (pid !== child.pid) {
      console.error('!! 端口 ' + port + ' 上回答的是另一个进程（pid ' + pid + '，我要的是 ' + child.pid + '）。');
      console.error('   多半是上一轮留下的实例还占着这个端口。这一轮不跑了，免得测到别的代码上。');
      try { child.kill(); } catch (_) {}
      process.exit(1);
    }
  }

  const cleanup = () => { if (child) { try { child.kill(); } catch (_) {} } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  console.log('BASE = ' + base);
  console.log('实例 = ' + mode);
  console.log('');

  const plan = LOCAL.map((x) => x.concat(['local']))
    .concat(REMOTE.map((x) => x.concat(['remote'])));
  if (!useArg) plan.push(DESTRUCTIVE.concat(['remote']));

  if (!hasJsdom()) {
    console.log('!! 找不到 jsdom，以下测试会跳过：' + NEEDS_JSDOM.join('、') + '。要跑就先设：');
    console.log('   NODE_PATH=C:/Users/Hg/.workbuddy/binaries/node/workspace/node_modules');
    console.log('');
  }

  const rows = [];
  let totalPass = 0;
  let bad = 0;

  for (let i = 0; i < plan.length; i++) {
    const [name, desc] = plan[i];
    const tag = '[' + (i + 1) + '/' + plan.length + '] ' + name;
    if (NEEDS_JSDOM.includes(name) && !hasJsdom()) {
      rows.push({ name, desc, state: '跳过（无 jsdom）', ms: 0 });
      console.log(pad(tag, 30) + '  跳过（无 jsdom）');
      continue;
    }
    process.stdout.write(pad(tag, 30) + '  跑…');
    const r = runOne(name, base);
    totalPass += r.pass;
    if (!r.ok) bad++;
    const state = (r.ok ? 'OK  ' : 'FAIL') + '  ' + pad(r.text, 14);
    console.log('\r' + pad(tag, 30) + '  ' + state + (r.ms / 1000).toFixed(1) + 's');
    rows.push({ name, desc, state: r.ok ? r.text : '失败（' + r.text + '）', ms: r.ms });

    if (!r.ok) {
      const lines = r.out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).slice(0, 6);
      if (lines.length) lines.forEach((l) => console.log('       ' + l.trim()));
      else {
        console.log('       （没有 FAIL 行，可能是启动即失败）');
        console.log('       ' + r.out.split('\n').slice(0, 5).join('\n       '));
      }
    }
  }

  console.log('');
  console.log('  ' + '-'.repeat(60));
  rows.forEach((r) => console.log('  ' + pad(r.name, 18) + pad(r.state, 26) + r.desc));
  console.log('  ' + '-'.repeat(60));
  console.log('  ' + plan.length + ' 个脚本 · ' + bad + ' 个失败 · 断言合计 PASS ' + totalPass);
  console.log(bad === 0 ? '  结论：全部通过' : '  结论：有失败项，先修再看');

  cleanup();
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => {
  console.error('run_all 自身异常：' + (e && e.message));
  process.exit(1);
});
