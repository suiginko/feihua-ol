# AGENTS.md · 飞花斯普拉遁（在线对战）

本文件是本项目对**所有 AI 编码代理**共同的规范，WorkBuddy 与 Google Antigravity 都适用。
README.md 说明项目「是什么」，本文件说明你「必须怎么做」。**改代码前先读完这一页。**

---

## 0. 一句话

两人开房、服务端判诗、没有主持人的在线飞花令对战。Node 零依赖 + 纯静态前端 + SSE 推送。

---

## 1. 硬约束（违反即返工）

| 约束 | 说明 |
|---|---|
| **零依赖** | `package.json` 没有 `dependencies`，也不要加。服务端只用 Node 内置模块 + 本地 `judge.js` / `data/chars.js` |
| **无构建** | 没有 webpack / vite / babel / tsc。改完文件刷新浏览器就生效。不要引入需要编译的语法（TS、JSX、SFC） |
| **不引 CDN** | 页面不能依赖任何外网资源，线上可能无外网出口 |
| **前端语法** | `public/*.js` 用 ES6（`const` / 箭头函数），浏览器直跑；样式内联在 `public/index.html` 的 `<style>` 里，没有外部 CSS |
| **架构红线** | **前端不做任何规则计算**。判定、涂色、轮次、胜负全在服务端；前端只渲染服务端推来的 `publicState` |
| **Node** | >= 18 |

---

## 2. 跑起来

```bash
node server.js                # 默认 8787
node -e "process.env.PORT=8799;require('./server.js')"   # 换端口（跨平台写法）
```

- `server.js` 读 `process.env.PORT`，默认 **8787**。
- **端口分工：WorkBuddy 用 8787，Antigravity 用 8799。** 同一个端口起两个进程会 `EADDRINUSE`，看到这个错误不要改代码，先换端口。
- 启动时同步加载 35 MB 语料（本地约 1–2 秒）才 `listen`。**这段时间端口无人监听是正常的**，不代表进程崩了。

---

## 3. 测试

多数测试是**打 HTTP 接口**的回归脚本，运行前需要有一个实例在跑；没有测试框架，输出 `PASS` / `FAIL` 行。

```bash
# 1) 先起一个实例（建议用非默认端口，避免和人抢）
node -e "process.env.PORT=8799;require('./server.js')"

# 2) 跑测试，指定同一个 BASE
BASE=http://127.0.0.1:8799 node tools/test_room_ops.js
```

| 脚本 | 覆盖内容 | 需要实例 |
|---|---|---|
| `test_judge.js` | 判定核心（该过的过 / 该拒的拒 / 乾字不误判） | ❌ 纯本地 |
| `test_share_link.js` | 邀请链接是否保留 `sharecode`（jsdom 渲染真实页面） | ❌ 纯本地 |
| `test_leave.js` | 离开 / 掉线 / 重进 / 刷新接回（自带短超时实例，见第 5 节） | ❌ 自带实例 |
| `test_snapshot.js` | 发布保护：退出落盘 / 重启恢复 / 超时变暂停 / 坏快照不恢复（自带实例，见第 6 节） | ❌ 自带实例 |
| `test_feedback_pull.js` | 反馈取件：`fid` / `since` 增量 / peek-commit 幂等 / 拉不到时不许谎报 0（自带实例，见第 6 节） | ❌ 自带实例 |
| `test_notice.js` | 公告栏：口令 / 300 字截断 / 留空撤下 / 重启后还在 / 坏 JSON 不崩（自带实例，见第 12 节） | ❌ 自带实例 |
| `test_room_ops.js` | 房号 / 每步计时 / 撤销 / 提前结算 | ✅ |
| `test_members.js` | 成员、身份、同名观众去重 | ✅ |
| `test_referee.js` | 裁判权限、开局设置、重抽棋盘 | ✅ |
| `test_ruler.js` | 裁定来源标注（裁判判 vs 对手判） | ✅ |
| `test_polish.js` | 空格分句、事件配色、大厅排序、空壳房清扫 | ✅ |
| `test_e2e.js` | 端到端打完一局 | ✅ |
| `test_batch2.js` | 房号顺序分配 / 上限 1000 / 存档 / 反馈 | ✅ **必须最后跑** |

**全量一条命令**（最常用，建议优先用它）：

```bash
npm run test:all                                 # 自己起临时实例，跑完全部（含 batch2），跑完关掉
npm run test:all -- --use=http://127.0.0.1:8799  # 用已有实例，跳过 batch2
```

这个设计有原因：

- **默认自起临时实例**（从 8799 起找空端口），不碰你正在用的 8787，跑完自动关闭，结果可复现。
- **`test_batch2` 会把 000–999 全占满**（验房间上限的必然结果）。所以对着已有实例跑时必须跳过它，否则那个实例之后再也建不出房。默认自起模式下才跑它。
- 顺序在 `tools/run_all.js` 里写死，**别调换**。
- 判定看**退出码**，不看输出格式（各脚本汇总格式不统一：`test_judge` 打「通过 37 / 37」，其余打 `PASS` 行，`test_e2e` 只打过程日志）。
- 写探针或临时脚本验判诗时记住两件事（都踩过）：提交路径是 `POST /api/room/:id/move`，
  body `{t, text}` —— **没有 `/api/judge` 这个接口**；`judge()` 返回 `{ok, sources, source, code, reason, …}`，
  不是 `{results}`。按猜的字段名取下标只会得到一串 `MISS`。

视觉核对用探针（`tools/probe_*.js`，无头 Chromium + CDP，会截图到 `shots/`）：

```bash
NODE_PATH=<node_modules_path> \
  node tools/probe_net.js
```

和「离开 / 在线状态」有关的两个：

- `probe_leave_ui.js` —— 双开真实浏览器，验「点离开 → 大厅 → 后退 → 重进 → 刷新 → 关标签页 → 同昵称重进」
- `probe_ghost.js` —— 用裸 TCP 造半开连接，验幽灵成员 / 房间不消失 / 空位不给「加入」

`probe_net.js` 现在覆盖两条路：磁盘留着 → 重启后遮罩自动收起、对局原样还在；
磁盘被换掉（探针会主动清空数据目录）→ 才走「这一局已经不在了」。
`probe_admin.js` 验审阅页的「启动记录」「房间快照」「公告」三个标签（公告那项是**真的打字 + 点保存**）。
`probe_notice.js` 自带实例，验大厅那条公告：出现 / 换色 / 横跨两列 / 撤下 / 尖括号不被当 HTML。

**对局数据分析**（不测代码，看玩家实际在打什么）：

```bash
node tools/export_records.js        # 先把线上存档拉到 exports/records-<日期>.json
node tools/report_poem_usage.js     # 合并 exports/ 下全部 records-*.json，出诗句使用频次
node tools/analyze_first_move.js    # 同上合并，出「先手（A 席）对胜率的影响」，含三人/四人局分表
```

两把分析脚本都**默认合并 `exports/` 下全部 `records-*.json` 并按 rid 去重**，不要改成只读最新一份。

`report_poem_usage.js` 输出 `exports/poem-usage.{csv,json,html}`：完整排行榜 CSV、机器可读 JSON、
以及一份可直接看的 HTML 报告。四条口径别搞错，都在脚本头部注释里：

1. **只算 `type === 'fly'` 的落子**，让子（`pass`）、争议、撤回都不算「使用」。
2. **排除单人模式**（`playerCount === 1`）。老存档没有 `cfg.playerCount`，脚本用非空席位数兜底。
3. **跨导出文件按 `rid` 去重** —— `exports/` 里往往同时存在同一批局的多个版本
   （`records-2026-10-22.json` 与 `-fixed.json` 内容相同），不去重会把次数算成两倍。
4. **因为 `allowDup=false`，同一句在一局里只可能出现一次**，所以「次数」必然等于「局数」。
   区分冷热要看第三个数字 —— **独立玩家数**。一个人连用 28 局和 28 个不同的人各用一次，
   在「这句诗有多受欢迎」这个问题上完全不是一回事。

`analyze_first_move.js` 有三个**必须遵守的判读纪律**，写错会得出反的结论：

1. **「先手」混着两件事**：位置（出手次数相等时的先后）与机会（A 多打一手）。
   只有「出手次数相等」的那批局才是干净的位置比较。
2. **「A 多一手」的局不能当因果读**。那多半是 **B 卡壳/掉线/让子**造成的 —— B 平均跳过次数是
   相等等组的 2 倍多，而且这些局本身长得多（56 手 vs 40 手）。把它当「多一次机会值多少」，
   等于把「B 打不动」错记成「先手收益」。这是逆向因果。
3. **三人/四人局的基线是 1/N，不是 50%**。且「后手」在这些局里没有唯一定义（每轮收官的人不同），
   所以只能逐席位看胜率，样本十几局时任何百分比都不显著 —— 四人局「某席位 0/12」在随机下
   出现的概率约 12%，不要当发现。

---

## 4. 代码地图

| 文件 | 行数 | 职责 |
|---|---|---|
| `server.js` | ~3850 | 全部 HTTP 接口、房间状态机、SSE 推送、在线判定、对局存档、房间快照、公告、审阅接口 |
| `judge.js` | ~570 | 判诗：语料加载、篇级跨小句匹配、联句（同一联上下句）判定、出处打分 |
| `public/app.js` | ~3110 | 前端唯一控制器：渲染状态、发请求、心跳、断线重连、公告轮询 |
| `public/index.html` | ~1415 | 页面结构 + 全部 CSS（内联，含大厅公告条） |
| `public/export.js` | ~1560 | 导出图片 / GIF（canvas 重绘，不依赖 DOM 截图） |
| `public/admin.html` | ~565 | 审阅页（存档 / 反馈 / 启动记录 / 房间快照 / 公告），口令在 `admin.key` |

数据目录：

| 路径 | 是什么 |
|---|---|
| `data/clauses.txt.gz` | 语料，328 万句，35 MB。**重建走 `tools/build_corpus.py`，很慢，非必要别碰** |
| `data/poems.json.gz` | 篇级索引（标题 / 作者 / 朝代 / 文体 / 句数 / 出处优先级） |
| `data/chars.js` | 棋盘字池，**由 `tools/export_chars.py` 生成，勿手改** |
| `data/t2s.json` | 繁简映射 |
| `data/records.jsonl` · `feedback.jsonl` · `boot.log` · `rooms.snap.json` · `notice.json` | 运行期产物，不进版本库 |

`DATA_DIR` 环境变量可以把这一整组运行期文件指到别处（自测用临时目录，别写进项目的 `data/`）。

---

## 5. 成员在线：只认心跳（`aliveMember()`）

「这个人还在不在」全服务端只有一个判据：`aliveMember(room, rec, token)`。席位接管、
幽灵清理、大厅的 `hostOnline`/`joinable`、成员列表的在线小圆点，全部走它。**不要再用
`rec.online` 裸判断，也不要自己写一套。**

规则（2026-10-21 起）：

| 机制 | 位置 | 说明 |
|---|---|---|
| 心跳 | `app.js` `startBeat()` → `POST /api/room/:id/beat` | 每 20 秒一次，`beatSeen=true` 之后才按心跳判生死 |
| 判死 | `ALIVE_MS = 75s` | 心跳停了就当作人已走（容忍后台标签页被节流到 1 分钟一次） |
| 校准 | 清扫循环第 1 步 | `online` 还挂着但心跳停了 → `markOffline`，`offlineAt` 记在最后一次心跳上 |
| 收房 | 清扫循环第 2 步 | 房间里一个活人都没有且不在对局中 → 立刻删房 |
| 刷新 | `pagehide` → `sendBeacon /leave {quiet:1}` | 页面卸载时替玩家发一次「安静的离开」，服务端记进 `room.recall` |
| 接回 | `peek` / `events` / `beat` 里 `recallSeat()` | 同一个 token 在 `RECALL_MS = 30s` 内回来 → 原样放回原席位（刷新 = 什么都没发生） |
| 留座 | `standUp()` 写 `room.vacant` | 开局后空出来的位子不随便给陌生人，但原主用同昵称回来（`VACANT_MS = 5min`）能坐回 |

为什么必须这样：手机切网 / 进程被杀 / 页面进 bfcache 时，SSE 的 `close` 事件可能**永远不来**，
连接会变成半开。只靠 close 判在线 → 人走了席位还占着、房间永远不消失、重进只能当观众
看着自己还坐在位子上。心跳是唯一能证明「人还在」的东西。

三条配套约束：

1. **新增「判断某人还在不在」的代码，必须调 `aliveMember()`**，不要读 `rec.online`。
2. **改 `public/app.js` 时不要删掉 `startBeat()`**，`enterGame()` 和 `init()` 里各有一处调用点。
3. **探针里不要带 token 去 `peek`** —— `peek` 会把刚离开的人「探活」（`recallSeat`），
   你会得到一个假的「他还活着」。要看别人还在不在，只能看 `/api/rooms` 的席位。

---

## 6. 发布保护：房间落盘 + 启动恢复（`flushSnapshot()` / `restoreSnapshot()`）

发布 = 覆盖沙箱代码 + 容器重启。房间只在内存里，所以以前每次发布都在杀掉所有人的对局。
2026-10-21 起有了这套机制，**「发布一定丢对局」不再是必然**：

| 环节 | 位置 | 说明 |
|---|---|---|
| 周期落盘 | `setInterval(snapTick, SNAP_MS=1.5s)` | 有脏数据（`broadcast` 打过标记）或房间数变化才写，其余时候一个字节都不写 |
| 退出落盘 | `shutdown()` ← `SIGTERM` / `SIGINT` | **同步**写盘，异步的根本跑不完（之后就是 SIGKILL） |
| 崩溃落盘 | `uncaughtException` / `unhandledRejection` | 先存盘再 `exit(1)`，以前是静默退出、日志里什么都不留 |
| 原子写 | `rooms.snap.json.tmp` → `rename` | 避免「写到一半被杀」留下残缺 JSON |
| 恢复 | 启动时 `restoreSnapshot()` | 快照 `age ≤ SNAP_MAX_AGE_MS(6h)` 才用，`schema` 必须相等，`dir` 指纹必须一致 |
| 环境指纹 | `payload.dir = SNAP_ENV(__dirname)` | 线上 `/workspace`、本地 `C:\Users\...`。**防止本地漏删的快照被随包传上线后当成线上房间恢复** |
| 房间寿命 | `restoreSnapshot()` 里的 `createdAt` 平移 | 停机时长**不计入** `ROOM_TTL`：接回来的房间剩余寿命 = 它挂掉那一刻的剩余寿命 |
| 重连宽限 | `rec.restoredAt` → `aliveMember()` | 恢复后的 `RESTORE_GRACE_MS(90s)` 内一律算他在，否则第一轮清扫就把房收掉了 |
| 时钟 | `reviveClock()` | `deadline` 存绝对时间戳，按墙钟重算；**停机期间超时的变「暂停」，绝不判负** |
| 审阅 | `GET /api/snapshot?key=` | 审阅页「房间快照」标签：内存几间 / 快照几间 / 这一轮接回几间 |

失败模式是唯一的、也是安全的：**读不到 / 太旧 / 版本不符 / JSON 坏 / 环境不符 → 什么都不恢复**，
和没有这套机制一模一样。所以「容器重启后磁盘到底还在不在」（`data/boot.log` 那套实验）
还没有答案时，这套机制也能先上线，等发布一次后用审阅页看结果。

**窗口为什么从 15 分钟放宽到 6 小时（2026-10-24）**：平台停容器后**不会可靠地自己拉起**，
恢复只能靠外部（人发现 / 本机保活任务重新发布），而外部恢复可能是几小时后。15 分钟窗口下，
停机那一刻在打的对局**必然全丢** —— 10-24 03:03 那次就是 3 间房 `restored=0`。
放宽窗口必须**同时**做三件事，少一件就是空转：

1. `SNAP_MAX_AGE_MS` 放大到 6h；
2. 快照写 `dir` 指纹，恢复时比对（否则本地快照上线就是几间幽灵房）；
3. `restoreSnapshot` 的 TTL 判断改成**按快照时刻的年龄**算，并把 `createdAt` 平移到 `now` 之前
   同样的位置 —— 否则 `ROOM_TTL(2h)` 会把停机超过 2 小时的所有房间全部 skip 掉，窗口放大等于没做。


四条约束：

1. **`snapRoom()` 里不要放不可序列化的东西**（`timer` 是 Timeout 句柄、`clients` 里是 SSE 的
   `res`）。新增字段如果是 `Map`，要在 `snapRoom` 转数组、在 `reviveRoom` 转回来。
2. **改 `room` 的字段结构后要把 `SNAP_SCHEMA` +1**，否则新进程会拿旧结构的快照去喂新代码。
3. **恢复出来的成员一律 `online=false`**，靠 `restoredAt` 撑过宽限期；不要图省事写成 `online=true`，
   那会让「其实没人回来」的房间永久占着席位。
4. **本地测试优雅停机只能走 `SHUTDOWN_HOOK=1` + `POST /api/shutdown`**：Windows 上
   `child.kill('SIGTERM')` 走 `TerminateProcess`，子进程收不到信号、处理函数根本不执行。
   这条开关不设环境变量时那个路由不存在，线上不受影响。

---

## 7. 不许动

- `data/clauses.txt.gz`、`data/poems.json.gz`、`data/chars.js`、`data/t2s.json` —— 都是生成物，要改就改生成脚本
- `admin.key` —— 审阅页口令，本地与线上同一个
- `data/*.jsonl`、`data/boot.log`、`data/rooms.snap.json`、`data/notice.json` —— 运行状态，不要手工编辑，也不要提交
- `.wbapp_*.genie` —— 发布关联标记，删了就认不出线上应用

---

## 8. 发布纪律（最重要，请逐条遵守）

1. **改完不自动发布。** 必须等用户明确说「发布」。
2. **发布前必须查有没有人在打**：`GET /api/rooms`，任何 `live: true` 的房间都要先报给用户、等他拍板。
   （2026-10-20 用户明确说过：线上有用户正在使用，不能更新。）
3. **发布 = 覆盖沙箱 + 容器重启。** 有了第 6 节的房间快照，对局**有机会**活下来，但**不要承诺**：
   还不确定容器重启后磁盘是否延续（看 `data/boot.log` 的 `prevLines`）。发布前仍按「会打断」告知用户。
4. **发布前必须先取走未读反馈**：`node tools/pull_feedback.js`（见第 11 节）。
   `data/feedback.jsonl` 活在容器磁盘上，重建沙箱就清空 —— 没取走就真没了。
5. **发布前删掉 `data/boot.log`、`data/rooms.snap.json`、`data/notice.json`、`data/nicklimit.json`**（以及 `data/*.jsonl` 里的测试数据）。
   `boot.log` 是「磁盘是否延续」的判据，随包上线会让判据失真；
   快照随包上线会让「本地遗留的对局」被当成线上房间恢复 —— 2026-10-24 起有 `dir` 指纹兜底
   （本地 `C:\Users\...` vs 线上 `/workspace`，对不上就不恢复），**但这条纪律照旧要守**，
   别把安全性押在兜底上；
   `notice.json` 随包上线会把一条本地测试用的旧公告「复活」到线上大厅顶上；
   `nicklimit.json` 随包上线会让本机测试用的那几个 uid 在线上也被锁一天。
6. **只有 WorkBuddy 能发布**（走平台的部署工具）。Antigravity **不要尝试**发布，也不要写发布脚本。
7. 发布后立刻验证 `/` 与 `/api/rooms` 都返回 200，再回复用户；顺手看一眼审阅页
   「启动记录」与「房间快照」两个标签，把 `prevLines` 与「接回几间」记下来。
8. **发布前先 `du -sh .`：上传的是整个目录，生成物会把上传拖到超时。**
   2026-10-23 23:00 连吃两次 `SITES_UPLOAD_FAILED / UND_ERR_HEADERS_TIMEOUT`，
   原因不是网络，是项目根目录涨到 **741MB**：`export_review/` 281MB（审阅用的文本导出）、
   `shots/.profile-*` 184MB（无头 Chrome 的 profile 缓存，每次探针都新建一个）、
   `tools/.cache/` 92MB（下载的语料缓存）。部署工具没有 exclude 参数，只排 `.git` / `node_modules`。
   把这三类移出项目根（`../feihua-ol-archive/`）后，186MB → 一次就传上去了。
   规矩：**生成物不进项目根**；`export_review/`、`shots/.profile-*`、`tools/.cache/` 用完即移走。

---

## 9. 已知陷阱（都是踩过的，别重犯）

1. **HTML 注释只能是 `<!-- -->`。** 曾把结尾误写成 `*/}`（CSS 写法），导致注释没闭合、整块 DOM 被吞掉：`querySelector` 找不到元素，但页面源码里能搜到。排查手法：用 jsdom 解析 `index.html` 打印 `document.body.children`。
2. **`/api/rooms` 的排序不能改成「可加入优先」。** 必须「进行中且有人 → 可加入 → 其他」；否则几十个空等房会把正在打的局挤出列表。
3. **`paused.by` 存席位（`'A'` / `'B'`），不是 `mid`。** 裁判暂停时另存 `byNick` / `byMid` / `byRef`，别把 `by` 改成 mid。
4. **`claimOfflineSeat()` 的判据是 `!aliveMember(...)`，不是 `!p.online`。** 半开连接会一直
   `online=true`，只看 `online` 就永远接不回原席位（「退出重进回不去」的根因）。但也不能反过来
   只看「连接在不在」—— 连接在、人不在才是最常见的状态。见第 5 节。
5. **命中闪框 `_flash` 必须在 `renderBoard()` 之前算。** 算在 `renderLog` 里会导致永远不显示（因为 renderLog 排在后面）。
6. **`placePoem()` 只按字面涂色，不查语料。** 判诗通过和「裁定有效」都走它，判定与落子必须保持分离。
7. **无头 Chrome 探针每次都要新的 `--user-data-dir`** 并加 `--disable-http-cache`。复用 profile 会读到缓存的旧 HTML，产生假阴性。
8. **本机 `curl` 可能被代理拦**（127.0.0.1 返回 502）。判断服务是否活着请用 node 的 `fetch`。
9. **`--virtual-time-budget` 会快进定时器，但不会快进真实异步**（如 `canvas.toBlob()`）。这类「看起来没执行」是假阴性。
10. **改了 `server.js` 必须重启进程才生效**；只改 `public/*` 刷新浏览器即可。
11. **`String.replace(str, str)` 的第二参数会展开 `$&`。** 典型写法 `html.replace('<script src="app.js"></script>', 整个appJs)` 里，如果 `app.js` 含 `'\\$&'`（转义正则元字符的标准写法，本项目第 863 行就有），`$&` 会被替换成「匹配到的整段」，把 `<script src="app.js"></script>` 插进字符串中间、打断引号，报 `SyntaxError: Invalid or unexpected token`，而且报错位置看起来完全无关。用 `split/join`，或把第二参数写成函数 `() => appJs`。
12. **不要用 `/api/rooms` 反推「当前最小的空号」。** 那个列表有上限（60 条）且按「进行中优先」排序，房号一多推出来的就是错的，会把正确的分配误报成 bug。
13. **别用 `performance` 资源时序验证 `keepalive` 的 fetch / sendBeacon。** 这类请求不进 Resource Timing 缓冲区，看起来「一次都没发」—— 是假阴性。要验心跳就在进房间前包一层 `window.fetch` 计数。
14. **探针里带 token 去 `peek` 会把刚离开的人「探活」。** `peek` 内部走 `recallSeat()`（刷新接回机制），一探就把人放回席位了。验「别人还在不在」只能看 `/api/rooms`。
15. **`process.exit()` 会截断 Windows 管道 / 文件里的 stdout。** 测试脚本一律用 `process.exitCode = N`，否则「跑完了但一个字都没有」。
16. **测试脚本里的端口探测 `portFree()` 忘了 `srv.listen()` 时，进程会静默退出（退出码 0、无输出）。** 因为 Promise 永远不 settle、又没有活跃句柄。遇到「什么都没打印就结束」，先查这里。
17. **Windows 上 `child.kill('SIGTERM')` 不会给子进程送信号**，走的是 `TerminateProcess`：子进程的 `process.on('SIGTERM')` 永远不执行。所以「收到信号 → 同步落盘」这条路径本地只能靠 `SHUTDOWN_HOOK=1` + `POST /api/shutdown` 驱动同一个 `shutdown()` 来验；线上是 Linux，真的会收到 SIGTERM。
18. **自测/探针必须给子进程设 `DATA_DIR`。** 否则测试写下的 `rooms.snap.json` 会留在项目的 `data/` 里，下一次本地启动被当成「上一次没打完的对局」恢复出来 —— 你会看到几间从来没人建的幽灵房，而且怎么重启都还在（除非删文件）。统一用 `tools/_tmpdir.js`。**窗口放宽到 6 小时之后这条更要守**：以前「等 15 分钟它自己就过期了」，现在一个没删的测试快照能顶 6 小时，而且还会被发布带上线（`dir` 指纹能挡住线上那一步，但本地照样被污染）。
19. **线上那层网关要 `sharecode`，但它会给浏览器种 cookie（`__wb_rsc`，30 天）。** 所以：
    - 直接开 `/admin?key=…`（不带 sharecode）→ **403**；带上 sharecode 打开一次之后，
      同浏览器再开只带 key 的地址也是 200。**第一次必须用完整地址**，之后可以存书签。
    - **`/api/notice` 在「没 sharecode 也没 cookie」时返回的是 HTML 页面，不是 403 JSON。**
      前端 `r.json()` 会抛错 → 页面显示「读取失败」，看起来像服务端坏了，其实是网关拦的。
      遇到审阅页「读取失败」先看浏览器地址里有没有带过 sharecode。
    - 脚本侧（`pull_feedback.js` 等）不会自动带 cookie，必须显式拼 `&sharecode=…`。
20. **重构多人模式时删掉过一个局部量，代价是整块 UI 静默失效。** `renderDispute()` 里的
    `const canControl = !!(S && S.canControl);` 被误删后，`const canJudge = canControl && !byMe;`
    抛 `ReferenceError` —— 于是「撤回提交 / 有效 / 重填」三个按钮全都不出现（提交方、对手、裁判都看不到），
    而且它后面的 `renderMembers()` / `renderEvents()` 一起停更。**现象只是「按钮不见了」，完全看不出根因。**
    两道防线：
    - `applyState()` 现在走 `renderAll()`，逐个面板 try/catch，一个挂了其余照常刷新，
      并把错误记进 `window.__renderErrors`（测试断言它为空）；
    - `tools/test_dispute_ui.js` 用真状态跑真渲染，逐席位断言三个按钮 —— 改这块必跑。
21. **凡是「赤营 / 青营」的硬编码都要走席位表 —— 导出图、存档、审阅页都一样。**
    多人模式上线后，`export.js` 里残留的 `team === "A" ? G.inkA : G.inkB` 让金营、翠营全变成
    青营的蓝；`gifCounts()` 只数 A/B，还把金翠的格子算成「未涂色」；结算侧栏 / 面积条 / 图例 /
    记录表 / 胜负条也都写死两营。判据：新增席位/营地时，先 `grep -n 'inkA\|inkB\|"A"\|"B"' public/export.js`。
    `tools/test_export_multi.js` 用「记账画布桩」直接断言颜色画在哪儿、青蓝有没有跑到金营的列里。

    **2026-10-22 又栽在同一件事上，这次是审阅页**：四人局打完，`/admin` 的「飞花记录」里金营翠营
    的每一手都标成「青」，「双方」「比分」也只显示两家。两层都错：
    - **存档层**：`archiveGame()` 只写 `players.A` / `players.B` —— 金营翠营的昵称在**落盘那一刻**
      就丢了，前端再怎么改也补不回来。现在是 `seatMap(room)` 走 `ALL_SEATS` 一次写全。
      `/api/snapshot` 的房间条目同样要返回 A–D（否则「房间快照」那栏永远是「—」）。
    - **显示层**：`admin.html` 写的是 `e.team === 'A' ? '赤' : '青'`。现在只留一张
      `SEAT_NAME / SEAT_HALL / SEAT_VAR` 表，日志标签、双方、比分、快照表全走 `seatTag()` / `seatLine()` /
      `scoreLine()`。**认不出席位时要显示「未知」，绝不能默认成青营**（老记录缺 `team` 时尤其明显）。
    - 两营的老存档（没有 `cfg.playerCount`）要按双人局显示，不能因为「四人房」被撑出两个空营地。
    - 回归：`tools/test_admin_multi.js`（34 断言，服务端 + jsdom）。它会反向验证 —— 把
      `archiveGame` 改回只写 A/B、或把标签改回 `? '赤' : '青'`，对应断言立刻变红。改这块必跑。
    - `tools/export_records.js` 导出的 CSV 也补了金营/翠营与金分/翠分两列，老存档留空。
22. **一个未捕获异常就等于整站数小时不可用，因为容器被自动拉起要等约 3 小时。**
    2026-10-22 10:08:37 线上进程终止，网关 504 一直持续到 13:05:55 平台才把容器重新拉起
    —— 静默下线 **2 小时 57 分**，对局空档 192 分钟。`boot.log` 里没有新记录。
    **注意：平台确实会自动重启，但延迟约 3 小时**，所以「它会自己起来」不能当应急预案。
    （这个时刻是从下一次启动记录里的 `restoreAge=10637659ms` 反推出来的：
    13:05:55 − 177 分 18 秒 = 10:08:37。想定位本进程死在哪一刻，这是唯一可靠的办法。）
    当时只有 `console.error`，容器日志我们拿不到，等于零证据。
    现在的规矩：
    - **请求入口整段包 try/catch**。`new URL(req.url, 'http://' + req.headers.host)` 在
      Host 畸形（例如 `Host: bad host`）时**同步抛**，而请求监听器里没有 catch ——
      直接升级成 uncaughtException。已用 `tools/test_crash.js` 反向验证：去掉这层，
      一条裸 TCP 请求就能把进程带走。
    - **计时器 / 清扫 / 落盘的回调各自 try/catch**：一局超时判负出错，不该让所有房间一起消失。
    - **`uncaughtException` / `unhandledRejection` 默认不再 `exit(1)`**：写 `data/crash.log`
      （含栈、rss、房间数）→ 落盘 → 继续服务。想复现崩溃退出行为，设 `CRASH_EXIT=1`。
    - 事后取证：`GET /api/boot?key=` 的 `crashes` 数组；内存看 `/api/stats` 的 `rss` / `heapUsed`。
    - **`/api/_test_throw` 只在 `TEST_HOOKS=1` 时存在**，线上不该有它。
    - **listen 之前的代码一旦抛错，表现是「重启一次就再也起不来」，而且 `boot.log` 里什么都没有**
      （那行是在 `listen` 回调里写的）。所以 `restoreSnapshot()` 现在**调用点**也包了 try/catch，
      恢复失败最多丢掉这一批房间；恢复循环里逐间 try/catch，一间房的快照形状不对不连累其余。
    - `server.on('error')` 必须接住：端口被占（EADDRINUSE）走的是事件不是异常，
      没人接就是未捕获异常。现在记 crash.log 并退避重试 5 次。
23. **「站点打不开」先分清是应用挂了还是域名没了 —— 两者的症状和施救方式完全不同。**
    2026-10-22 16:00 前后，玩家陆续反馈微信报 `-105 NAME_NOT_RESOLVED`。查下来是注册局
    给整个 **`workbuddy.host` 加了 `serverHold`**，所有 `*.app.workbuddy.host` 同时 NXDOMAIN，
    应用本身没坏。判读方法（`node tools/check_domain.js` 一条命令跑完）：
    - **四家公共 DoH 交叉验证**（阿里 / 腾讯 / Cloudflare / Google）。只用一家容易误判；
      **本机 DNS 一定不能信** —— 本机代理是 fake-ip（解析到什么 `198.18.0.x` 的都是假的），
      `nslookup` 会一律回同一个假 IP，看起来「能解析」，其实是劫持。
    - **一定要带对照组**（`www.baidu.com`）。对照组正常才说明探针本身是好的。
    - **查根域**：如果 `workbuddy.host` 自己也 NXDOMAIN，那是整个域没了，不是某个子域配错。
    - **查注册局 RDAP**（从 IANA 引导文件里找权威地址，别硬编码）：
      `status` 里有 `server hold` 就是注册局暂停解析；看 `expiration` 排除「到期被删」。
      这次 `expiration=2029`，域名没过期，是 hold。
    - **`serverHold` 只能由域名持有人向平台/注册商申请解除**，改代码、重新发布全都没用：
      发布出来的链接还是同一个不解析的域名。
    - **为什么是「有些玩家」打不开**：hold 一加，权威 DNS 立刻没有这个域，但玩家设备、
      运营商、微信内置浏览器还缓存着旧 A 记录。缓存没到期的照常能进，过期的开始报 -105，
      所以现象是**陆续掉线、越来越多**，而不是同时全挂。别被「有些人还能用」误导成「局部网络问题」。

24. **回填历史数据只补空、不覆盖，而且必须先预演给人看。**
    陷阱 21 那两层修完之后，旧存档里 C/D 的昵称仍然是空的 —— 渲染改了也变不出数据。
    `recordfix.js` 负责回填，判据是存档里自带的痕迹，不是猜：
    - **`log[].team` + `log[].byNick` 最可靠**：每条落地手都自带席位和「那一手当时的最终昵称」。
      别用 `events` 里的昵称去还原 —— 席位会被换人坐（实测某局 B 席先来一个又换成另一个），
      按席位推昵称会张冠李戴。
    - **`events` 的 `seat` + `mid` 要按顺序对齐**：`events` 的 `fly` 与 `log` 的 `fly` 一一对应
      （都是「打完一手记一条」），第 i 条对第 i 条才拿得到同一手的 mid。两边数量不一致就只信
      `log` 的昵称、mid 留空 —— **宁可空着，不能把别人的编号安到这个席位头上**。
    - **已有非空昵称一律不动**，对不上只写进 `conflicts` 报给人看（可能是改名，也可能是换人）。
    - **幂等**：修过的再修必须一条不改。`test_record_fix.js` 用「跑两遍」锁这条。
    - 规矩是**默认干跑**：`POST /api/records/repair?key=` 只算不写，`&apply=1` 才落盘，
      写之前 `copyFileSync` 留 `.bak`，再 `writeFileSync(tmp)` + `renameSync` 原子替换。
      `records.1.jsonl`（滚动出去的那一份）一起处理，不然上个月的存档永远错着。
    - 线上那份**只能靠这个接口改**（容器磁盘拿不到），`tools/fix_records.js` 的本地修复
      只产出副本，用于核对与长期留存。

25. **算「谁多打了一手」时，跳过（pass）也是出手。**
    统计先后手优势时若只数 `type === 'fly'`，会把「对手跳过、我方多落地一次」当成「多打一手」，
    凭空造出一个「44 局赢 37 局」的强信号 —— 按出手次数重算其实是 15 局赢 13 局，样本根本撑不住。
    校验办法：`轮数已满` 的双人局，两边出手次数必须都恰好等于 `cfg.rounds` —— 105 局一局不差。
    另外「先手有没有优势」必须拆成两件事：**位置**（出手次数相等时才叫先手 vs 后手）
    与**机会**（总次数为奇数时 A 多一次）。混在一起算总胜率会互相抵消成 50%，看着像「没影响」。

26. **棋盘上的字与判定用的字必须是同一个字面 —— 自定义字库一律过 `judge.normalize`。**
    盘上的字决定「这句能涂哪一格」，判定用的是归一化后的简体字。字库若保留繁体，
    玩家敲简体永远涂不上那些格，功能看着就是坏的。`textToChars()` 走 `judgeMod.normalize()`
    （只留汉字 + 繁转简 + 去标点数字字母），前端弹窗只负责「数一下识别出几个字」给人看，
    **不在前端做归一化** —— 两套实现迟早算出不一样的数，反而让人怀疑服务端。

27. **`data/chars.js` 里的 `POOL` 和 `EXTRA` 都是字符串，不是数组。**
    `EXTRA[pick]` / `EXTRA_WT.map` 对字符串能用，容易让人以为它是数组；
    一旦写 `EXTRA.filter(...)` 就是 `TypeError: EXTRA.filter is not a function`，
    而且它发生在 `newRoom → buildBoard`，表现是**建房直接 500**，日志里只有一行 TypeError。
    要过滤就 `EXTRA.split('').filter(...)`。另外棋盘铺字有两处硬约束：
    ①「一格一个字」——补字时必须跳过已在盘上的字；②自定义字库**只决定用哪些字**，
    不改变 `cfg.extra` 的含义（低频字名额仍在系统补的那部分里生效）。

28. **加字段到房间快照要先问「旧快照还能不能用」，能就别升 `SNAP_SCHEMA`。**
    `pool` 是可选的：旧快照没有它 → `revivePool(undefined)` 返回 `null` → 回到系统字库，
    对局照常恢复。为它把 schema 从 2 升到 3，等于发布那一刻**所有旧快照整份丢弃**、
    线上正在跑的房间全部打断 —— 加可选字段的代价不该这么大。

29. **自定义昵称 24 小时一次：`random:true` 必须由服务端核名字，uid 是唯一能跨房间计数的东西。**
    三个容易做错的地方：
    ① 「我用的是随机诗人名」是**客户端自称**的。只信这个标记，谁都能把自定义名字标成 random
       绕过去 —— 所以 `renameMember()` 里必须是 `o.random === true && judgeMod.isAuthor(name)`，
       名字不在诗人池（14769 个）就按自定义处理。
    ② token / mid 都是**按房间发**的，换个房间就是另一个人，没法拿它们做「每人一次」；
       只能靠前端持久 uid（localStorage `feihua-uid`）。拿不到 uid 的旧页面退回按 IP 记账
       （`ip:127.0.0.1` 这种 key），这是降级：同一出口 IP 的几个人会互相拖累，
       但总比「老页面完全不受限」好。
    ③ **写测试时要给每个「人」不同的 uid，或者干脆把 `NICK_GAP_MS` 设成 1。**
       `test_members` 就因为几次改名都没带 uid、全落到同一个 IP 键上，改成第 2 次就被拒，
       报的却是「选手改昵称成功」失败 —— 看起来像改名功能坏了，其实是额度在用。
       同一个实例上连跑两遍还会因为上一遍的额度没到期而再挂一次，所以 uid 要带上时间戳。

30. **`data/nicklimit.json` 和 `notice.json` 一样是运行期状态，发布前要删。**
    本地测试改几次名就写进去几条，随包上线会让「本机那几个 uid」在线上也被锁一天。
    `.gitignore` 里已经有它；发布清单见第 8 节第 5 条。

31. **`/api/rooms` 的 `age` 单位是「秒」，不是分钟 —— 判「有没有人在打」全靠它，读错会闯祸。**
    2026-10-22 23:15 我把 `age: 5230` 当成「87 小时」，于是把线上当成「一批挂了很久的空房」，
    差点在 8 间正在进行的对局上发布。实际它是 **87 分钟**，是真在打。
    判活跃的正确读法：
    ① `age` 按秒读，`age < 600` 的房间是**十几分钟内新建的**，那是活人；
    ② 隔 1–2 分钟连查两次：`age` 在涨、房号在换（旧房被清扫、新房用空号）＝ 有人在打；
    ③ 别只看 `live` 数量 —— `live` 只说明 `phase==='playing'`，挂机房也会是 true。
    另外 `rooms` 里列表条数可能少于 `/api/stats` 的 `rooms`（没人/已结束的被过滤掉了）。

32. **SSE 往已关闭的响应写会抛 `ERR_STREAM_WRITE_AFTER_END`（线上 2026-10-22 23:48 真发生过）。**
    栈落在 `Timeout._onTimeout` 里对 `res.write()` 的调用上。兜底会让进程活着，所以症状不是宕机，
    而是 `data/crash.log` 里一条条堆积。动 SSE 广播 / 心跳定时器时必须先判
    `res.writableEnded || res.destroyed` 再写。

33. **单格重随必须「同库抽」：常用字只换常用字、低频字只换低频字、字库字只换字库字。**    初版是 `(POOL + EXTRA).split('')` 混着抽，看着能用，实际上等于**点几下就把房间的字库设置改掉了**。
    实测（`node tools/probe_reroll_pool.js`，改动前）：
    - 低频字设 0 的 81 格盘面，点 120 下换出 **95%** 的生僻字；
    - 低频字设 17 的盘面，点常用字格 60 次有 **91.7%** 变成低频字，120 下之后盘面变成 **66 个低频字**；
    - 有自定义字库时，字库字已全部上盘的情况下点字库格，`candidates` 只剩它自己 →
      返回 `ok:true` 但**字没变**（假成功），事件流里写着「换了第 N 格：海 → 海」。
    现在 `rerollCell()` 先判这一格原来属于哪套字库（`poolSet.has(old)` → `POOL_SET` → `EXTRA_SET`），
    再在那套字库里抽；低频字按 `EXTRA_WT` 权重抽（与 `buildBoard` 的 `pickExtras` 同源）。
    连带两条硬约束：**候选必须排除旧字**（否则有概率换出同一个字，看着像没反应）；
    **那一类换不动了就报 `exhausted`**，不许拿系统字或重字将就 —— 假成功比报错更难查。
    回归：`tools/test_reroll_class.js`（29 断言）。判「盘面配比有没有被点乱」要数整盘，别只断言新字。

34. **改名这条路有两条入口，规则只能写一处：`nickGate()`。**
    「自定义昵称 24 小时一次」最初只做在房间里的 `POST /room/:id/nick`（`renameMember`），
    而大厅那个昵称输入框是随 `/api/create`、`/api/join` 一起发出去的 —— 那两条路根本没看过
    `nicklimit`，于是「在大厅改个名再进房」既不提醒也不扣次数，规则被绕过一半（用户实测发现）。
    现在三个入口都过 `nickGate(req, uid, nick)`，前端只负责把结论渲染成弹窗：
    - **只在有 uid 时算账**：没有 uid 就只能退回 IP，而进房是每个人都要走的一步，按 IP 记会把
      一家人 / 同一出口的人互相锁 24 小时。房间内的改名仍保留 IP 兜底（那一层人数少、出口杂）。
    - **诗人名放行、同名放行**：`judgeMod.isAuthor(name)` 命中即不占额度；与上次记录同名 = 没改，
      既不能拦也不能重复记账。
    - **记账必须落在「真的进了房间」之后**（`markUsed()`）：被观众席上限（409）挡回去的那次不许白扣。
    - `/api/nick-status?uid=&nick=` 直接回 `isCustom / isAuthorName / unchanged / willBlock / needsPay`。
      **前端不要自己判断「这名字算不算诗人名」** —— 作者池在服务端（14769 个），前端没有也不该有。

35. **改名确认与冷却提示一律用站内弹窗，不要用浏览器 `confirm()`。**
    原生弹窗标题栏显示域名、按钮写「确定/取消」，跟站内 UI 完全是两套东西，手机上还多一次返回。
    统一走 `public/app.js` 的 `askGame({ eyebrow, title, body, okText, cancelText, hideCancel })`
    （返回 `'ok' | 'cancel'`；`body` 收 HTML，**玩家输入的名字必须先 `esc()`**）。四个出口都已接：
    确定 / 取消 / 点遮罩 / Esc。`hideCancel: true` 用于「只能知道了」的纯提示。
    `test_nick_limit_ui.js` / `test_nick_lobby_ui.js` 会同时断言「弹窗出现」和「没用 confirm」。

36. **整站 504「service on port 3000 not ready after 30000ms」先查内存，别先怀疑域名。**
    2026-10-23 20:04 进程消失，平台反复重启都起不来，**504 持续 54 分钟**，直到重新发布（21:00）才恢复。
    取证全在 `/api/boot`：
    - 崩溃记录里那 10 条 `write after end` 都带着 **`rss=1047~1048MB`**。语料扩到 27.6M 字之后，
      常驻堆（steady heap ~230MB）其实够用，但 **V8 默认堆上限太大、不肯及时回收**，rss 会一路漂到 1GB；
      容器（约 1GB）一到顶就被 OOM —— 这种死法**连 crash.log 都不会有**，平台重启又在「加载语料」的峰值处
      被杀，于是一直等不到监听，网关就一直 504。
    - 三个可观测点：启动记录的 `heapLimit` / `maxOldSpace` / `rss`，以及 `/api/stats` 的 `rssPeak`。
      **`maxOldSpace` 是 0 就说明 `npm start` 里的 `--max-old-space-size=640` 没生效** —— 部署按
      package.json 的 `start` 跑才有效，直接 `node server.js` 不受影响。实测量级：
      无上限时加载完 rss 748MB、随后可漂到 1048MB；限 640 后加载完 598MB、峰值受控。
    - 内存软阈值：`MEM_WARN_MB`（默认 850）以上会往 `crash.log` 落一条 `kind:'mem'`，哪怕没被 OOM 也留证。
    - 排查顺序：`tools/check_domain.js`（域名/解析）→ 看 504 还是 525/524 → **起不来就重新发布**。
      等平台自己重启没有意义（10-22 那次等了 2h57m，这次 54 分钟，都是重新发布才活）。
    - 顺带修掉的老坑：SSE 的写操作现在统一走 `sseWrite()`（写前看 `writableEnded / destroyed / writable`，
      顺手把死连接踢出 `clients`）。`res.write()` 的 `ERR_STREAM_WRITE_AFTER_END` 是**异步抛**的，
      `try/catch` 接不住 —— 这就是它为什么能在兜底里刷出一串记录。回归：`test_sse_dead.js`（14 断言）。

37. **先分清「我们的代码死了」还是「平台把容器停了、又没及时拉起」，两者的处置完全相反。**
    判据只看 `mem.log` 最后一条 + `crashes` + 快照年龄，三十秒能定案：

    | 信号 | 读法 |
    |---|---|
    | 最后一条 `mem` 记录的时刻 | 死亡发生在**它之后的一分钟内**（`mem` 每 60s 一条，缺的那分钟就是死点） |
    | 那条记录的 `rss` | 远低于 `heapLimit`（如 441 / 688）→ **排除 OOM**；贴着上限才是 OOM |
    | `crashes` 有没有新条目 | 没有 → **不是 JS 异常**（`uncaughtException` 兜底一定会写 crash.log） |
    | 快照年龄 ≈ 死亡时刻 | **收到的是 SIGTERM**（handler 立刻同步落盘才退出，两个时间才会重合） |
    | 平台启动时刻 − 死亡时刻 | **静默时长**，这才是用户真正承受的损失 |

    2026-10-24 03:03 那次：`mem` 停在 03:02:30（rss 441MB）、03:03:30 那条不存在、`crashes` 一条没有、
    快照正好 622 分钟前、13:25:18 才恢复 → **平台优雅停容器**。
    但注意后半段：**13:24 的恢复是本机保活任务重新发布做到的，不是平台自己起来的**，
    所以空窗 10h21m 的责任在「本机休眠期间保活一次都没跑」，不在平台。
    处置仍然是「重新发布」而不是改代码。

    ⚠️ **自动保活跑在本机的 WorkBuddy 客户端里，不是云端定时器。** 本机休眠/关机 = 没有任何人保活
    （10-24 那次就是深夜 03:03 到 13:24 全程没人看着，条件完全允许的话本机应保持唤醒）。
    平台自己的拉起能力也**不可依赖**：10-22 10:08 停 → 平台 13:05 自行拉起（2h57m，当时还没有保活任务），
    而 10-24 那次平台一直没动。**两种情况都只会让「她会自己起来」这个假设更不可靠。**

38. **应用一启动就 `Killed`、发布报 `SITES_START_FAILED` —— 先看 cgroup 的 `sock`，
    别急着改代码、也别怀疑自己的内存泄漏。**（2026-10-24 踩过，四次发布全挂）

    那次的现象：`service did not become reachable on port 3000 within 60s`、
    `app stderr` 只有一行 `Killed`、`stdout` 一行日志都没有。反复试、把代码和数据
    **完整回退到上一次发布成功的版本**，结果一模一样 —— 这就说明不是我们的东西。

    三步定性（都能在容器里直接读到）：

    | 步骤 | 干什么 | 那次的结果 |
    |---|---|---|
    | ① 起一个极轻的服务（55MB，不加载语料） | 能起来 → 容器本身没问题，是「我们这个应用太重/内存不够」 | 起来了，`verified:true` |
    | ② 读 `/sys/fs/cgroup/memory.max` / `memory.current` / `memory.stat` / `memory.events` | 看配额、占用、明细 | max 8192MB / current 7979MB / **可用仅 213MB** |
    | ③ 看 `memory.stat` 里哪一项大 | 关键就在这一行 | **`sock` 6735MB**、anon 1048MB、file 129MB |

    **`sock` 是 socket 缓冲区**：90 秒内反复测量纹丝不动（不是能自然过期的 `TIME_WAIT`）。
    同一 cgroup 里所有进程的 `VmRSS` 加起来才 1289MB，说明**占内存的根本不是 app 进程** ——
    所以「查飞花自己有没有泄漏」是无效方向，**方向要放到沙箱里的其他进程上**。

    **这次一开始就停在这里、下了「只能等平台」的结论，是错的。** 补上第 4、5 步才定案：

    | 步骤 | 干什么 | 那次的结果 |
    |---|---|---|
    | ④ 看 `/proc/net/tcp` 的状态分布 | `CLOSE_WAIT` 多＝有人收了 FIN 不 close | **`CLOSE_WAIT` 1610** / ESTABLISHED 127 / TIME_WAIT 76 |
    | ⑤ 按 `/proc/<pid>/fd` 里 `socket:[inode]` 数持有者 | 谁握着这些 fd | **`local-proxy` 独占 1728 个**（RSS 397MB） |

    **`CLOSE_WAIT` 是判据**：对端已经 FIN、本端没 `close()`，fd 会一直挂着，内核缓冲区一直
    记在 cgroup 的 `sock` 里，**不会过期、也不能 reclaim**。看到几百上千个就是连接泄漏，
    而且必然集中在某一个长期运行的代理进程上。

    **修复（已验证）**：重启那个进程即可，`supervisord` 会自动拉起干净的新实例。实测结果：
    `sock` 6736MB → **0MB**、可用 191MB → **7274MB**、`CLOSE_WAIT` 1610 → **1**，
    随后一次发布就成功。**所以「只能等平台释放」不成立。**

    ⚠️ 动手前必须先确认「杀它不会切断自己的路」：
    - 先用 `/proc/net/tcp` 的 LISTEN 行 + fd inode 反查端口归属。那次 **`:3000` 是应用自己
      监听的**，`local-proxy` 只占 `:65216`，所以杀它不影响应用入口。
    - 部署走的是云端 API，不走沙箱内的代理，所以也不会切断发布通道。
    - **杀完立刻复查**：若 5 秒内网关返回 502，等它自愈（那次 5 秒后就 200 了）；
      若始终不恢复，`set_start.js maintain` 把维护页发回去，别硬撑。

    还有一个容易搞混的点：**这个 8GB 不是飞花专属的**。`/proc/self/cgroup` 是 `0::/init.scope`、
    pid 1 是 `docker-init → supervisord`，里面同时跑着 IDE、`editor_sdk`、`terminal/app`、
    `codebuddy --prewarm`（2×274MB）、`sandbox-proxy`。所以「别的应用能跑、只有飞花不行」
    的真实原因是：**别的应用在自己的沙箱里，余量足够；而飞花和这个开发会话共用同一个沙箱**，
    一旦这里的代理泄漏，先撑不住的就是需要 520MB 的我们。


    几条已验证的边界：
    - `echo 1G > /sys/fs/cgroup/memory.reclaim` → **EACCES**，容器内没有 cgroup 写权限，主动回收这条路走不通。
    - 正式应用加载语料需要约 **520MB 峰值**（`JUDGE_LOAD_TRACE=1` 实测 after-pb 515MB）。
      可用余量 < 520MB 时**必然**被 OOM，任何参数调整都救不回来。
    - `/dev/shm` 是 tmpfs 8GB 但 `shmem` 只有 4KB，所以不是它；`SwapTotal=0`，也没有 swap 兜底。

    降级与恢复（`_maintain.js` 保留在仓库里，它就是这类故障的急救箱）：
    - `node tools/set_start.js maintain` → start 改成 `node _maintain.js`（约 55MB，能挤进去）。
      它提供的端点（除 `/` 维护页外都要带 `admin.key`）：
      | 端点 | 用途 |
      |---|---|
      | `/diag` | cgroup 配额 / 占用明细 / `availableMB` / 进程排行 |
      | `/sock` | TCP 状态分布 + 按进程数 socket fd（**查 `CLOSE_WAIT` 就看这里**） |
      | `/fix?do=ports` | LISTEN 端口 → 进程归属（判断能不能杀谁） |
      | `/fix?do=restart-proxy` | 重启 `local-proxy`（唯一能清掉泄漏的手段） |
      | `/ls`、`/dump?file=` | 列 / 下载 `data/` 下文件（重建沙箱前取数据用） |
    - `node tools/set_start.js app` → 切回 `node --max-old-space-size=640 --expose-gc server.js`，
      **确认 `/diag` 的 availableMB ≥ 600 再发布**。
    - 取数据：`/dump` 是流式的，大文件也可能中途断（那次 `records.jsonl` 只下来 946 字节）。
      **必须逐个校验大小 + 逐行 `JSON.parse`**，别看到 HTTP 200 就当备份成功。


    顺带发现的两个线上残留（增量覆盖不会删线上旧文件，别以为本地移走就没了）：
    `/workspace/core.2969402` **770MB**（历史崩溃的 core dump）、`shots/` 360MB、`export_review/` 271MB。

39. **分享出去的邀请链接偶尔没有 `sharecode`，对方点开 403「链接不完整」—— 不是生成逻辑写错，
    而是只读了 `location.search`。**（2026-10-24 用户实测）

    链路是这样的：线上网关第一次被带 `?sharecode=xxx` 访问后，会种一个
    `__wb_rsc=<32位哈希>` 的 cookie（`HttpOnly; Secure; SameSite=None; Max-Age=2592000`）。
    之后玩家从**书签 / 浏览器历史 / 直接输域名**进来时，地址栏干干净净也能进站（靠 cookie 放行），
    这时他复制出来的房间链接就没有 sharecode —— 别人第一次点开必然 403。
    这就是「同样点复制链接，有时带码有时不带」的真相。

    **别再指望从 cookie 里捞**：`HttpOnly` 让 JS 读不到，而且它的值是哈希不是 sharecode 明文
    （实测 `__wb_rsc=45f3e8bceb60d21b5d3b069a9a320b57`，跟 `MZA5YPLHV3` 无关）。
    现在 `sharecode()` 三级兜底（`public/app.js`）：
    ① `location.search` 里有 → 用掉并写进 `localStorage['feihua-sharecode']`；
    ② 没有 → 用存下来的（上次带码进来的那次记的）；
    ③ 都没有、且域名确实是 `*.app.workbuddy.host` → 用内置 `SHARE_FALLBACK`。
    **本地 / 旧域名一律不加参数**（否则 `test_share_link` 的第 3 个场景和本地开发全坏）。

    ⚠️ `SHARE_FALLBACK` 是硬编码的。平台侧重置分享码后它就会过期，
    `tools/watch_site.js` 带它探活 —— **哪天探活返回 403，第一件事就是更新这个常量**。
    回归：`tools/test_share_link.js`（6 个场景，含「靠 cookie 进来」与「从未见过码」）。

40. **「连接中断」断线遮罩已按用户要求整体移除，不要再加回来。**（2026-10-24）

    SSE 偶尔抖一下时，`armNetMask()` 1.2 秒就浮出遮罩、`hideNetMask()` 又立刻收起，
    一天里频繁闪几次，比什么都看不见更影响体验。删掉了 `#netMask` 的 DOM / CSS /
    `setNetKind()` / 两个按钮绑定。

    **但断线重连与房间探测是真功能，必须保留**，别把 `armNetMask` / `probeRoom` 一起删了：
    `probeRoom()` 每 2.5 秒 `peek` 一次，用来判断「本局是否已在服务端结束」——
    那个分支会 toast「本局在服务端已结束」并让玩家留在缓存窗口（而不是丢回大厅）。
    函数名沿用旧名（改名怕漏改调用点），实际已不碰任何 DOM。
    回归：`tools/test_no_netmask.js`（12 断言）**同时守两端** ——
    DOM/文案/`setNetKind` 不许回来，`armNetMask`/`probeRoom`/退避重连必须还在。

41. **诗曾经可以一次甩出整首。现在的规则是「每次至多 2 句，且必须是同一联的上下句」——
    但只有「规则近体律绝」才套跨联限制，古风/乐府/楚辞/汉魏古诗一律放行；
    且违规只走「争议」，不直接拒绝。**（2026-10-26 立规则，当晚收紧，两次都审核后发布）

    旧行为：`maxPoemLen`(17) 只作用于词曲赋文，`kind === '诗'` 分支既不限字也不限句，
    「床前明月光疑是地上霜举头望明月低头思故乡」能一口气交上去，一局就结束了。
    第一版收紧后把 `kind === '诗'` 全当近体判 → **古风、离骚、将进酒、诗经全被误判跨联**，
    这是当晚必须再收紧一次的原因。

    现在（`server.js` 的 `applyMove`，**命中语料之后**才检查；未收录仍走原来的争议流程）：

    | 情况 | 判定 |
    |---|---|
    | 句数 ≥ 3 | `kind='too_many_clauses'`，`extra` 带实际句数 |
    | 2 句但不是相邻行（`hb.f !== ha.f + 1`） | `kind='cross_couplet'` |
    | 2 句、相邻、篇有显式标点 | 看前一句标点：是 `。` → 跨联 |
    | 2 句、相邻、无标点、`isUniformShi(篇)` 为真 | 出句偏移必须偶数（`offset % 2 === 0`），否则跨联 |
    | 2 句、相邻、无标点、`isUniformShi` 为假（古风/乐府/词曲赋文…） | **不判跨联**，只按 `maxPoemLen` 限字 |
    | 单人（`playerCount === 1`）或 `cfg.freeSubmit` | 字数、句数**全不限**，整段逻辑跳过 |
    | `cfg.limitCouplet === false` | 诗不限联句，但仍按 `maxPoemLen` 限字 |

    `isUniformShi(pi)`（`judge.js`）是唯一的「这算不算近体」判据，四个条件全过才算：
    篇内小句字数**全部相同**、句数为**偶数**且 **≤16**、朝代**不是**先秦/汉/魏晋/南北朝/隋、
    题名**不含**歌/行/吟/引/曲/弄/操/谣/辞/骚/叹/哀/古风/古意/古体/乐府/杂言/短歌/长歌。

    六条必须知道的边界，改这块之前先读：

    - **宁放过不误伤**：古风与楚辞的联边界推不出来，硬判就是在正常提交上刷争议。
      判断不了的时候，字数上限（17）还在兜底，不会让人一口气甩整首。
    - **只在同一篇内判**（`poemOf(ha.f) === poemOf(hb.f)`）：跨篇的两个相邻行号毫无关系。
    - **先放宽查询再判**：多人模式先按 `maxLen: 40` 查一次，拿到真实的 `source.kind` 与句数，
      再按文体分流。直接按 17 字查会把长句打成 `too_long`，拿不到 `kind`，规则永远不生效。
    - **`too_long` 与 `not_found` 的分流点**：`q.length > maxLen` 才是「超字上限」，否则是「未收录」——
      两者争议文案完全不同，别写反。`freeSubmit` 下永远不算超字，只会是「未收录」。
    - **违规不等于无效**：走 `openDispute()` 是为了给人工出口（玩家看到「计时已暂停，等对手裁决」，
      对手点「有效」照样成立，并把 `source` / `line` 一起带进落子）。启发式判定，终审权必须留给人。
    - **`coupletFallback` 里的 `pia` / `pib` 必须声明在 `if (sa.kind === '诗')` 外面**：
      算 `isRegular` 时块外还要用，写在里面就是块级作用域 → 诗的两句落到不同篇时抛 `ReferenceError`。
      2026-10-26 踩过一次，别重犯。

    回归：`tools/test_poem_detection.js`（60 条：离骚/将进酒/蜀道难/琵琶行/诗经/古诗十九首/词曲
    全不许判跨联，春晓/静夜思/登鹳雀楼/悯农/泊秦淮 的真跨联必须判出来）、`tools/test_judge.js`、
    `tools/test_modes.js`（四种人数 + 20 路 + `limitCouplet:false` 放行）、`tools/test_new_features.js`（`freeSubmit`）。

42. **开发者隐形观众进房后，选手全退房间还挂在大厅里 —— 对普通玩家可见，等于宣告「屋里有隐形人」。**
    （2026-10-26，Antigravity 修复）

    三条独立根因，缺一条都还是露：

    | 根因 | 修复 |
    |---|---|
    | `adoptStaleWatcher` / `dropGhostWatcher` / `setRef` / `kickMember` 四个函数没跳过 `w.hidden` | 各加一处 `if (w.hidden) continue;` |
    | 大厅列表只判 `live`，而 `live` 不含观众 —— 「无活人选手 + 只有隐形观众」的房间照样列出 | `if (!dev && !live && visibleWatchers(room) === 0 && pruneRecall(room, now) === 0) continue;` |
    | `sweepAll` 只在 `!anyAlive` 且 `phase !== 'playing'` 时收房，`playing` 的空房永远留着 | 先算 `allSeatsEmpty = ALL_SEATS.every(s => !room.seats[s])`，收房条件改成「无人存活，且（不在对局中 或 席位全空），且无刷新凭证」 |

    - 大厅那条里的 `pruneRecall(room, now) === 0` **必须一起判**：否则「正在刷新中的真人房」会从大厅闪没，
      刷新回来人已经在屋外了。
    - `hidden` 观众对「这个房间还活着吗」**完全不算数**（`visibleWatchers()` 是唯一口径），
      但它对「我还想继续这一局吗」算数 —— 所以收房用 `allSeatsEmpty` 兜住 `playing` 的边界。
    - **大厅里偶尔出现一个「没人」的房间，先别当清扫失灵**：那多半是 `recall` 窗口
      （`RECALL_MS = 30s`，玩家关页面/刷新时客户端发的安静离开），`pruneRecall()` 非 0 就故意留着，
      怕他刷新回来发现被踢。30 秒后 `sweepAll` 自然收走，房号立刻被下一个人占走 —— 正常的。
      排查房间真实状态用 `/api/rooms?dev=<admin.key>`（能看到被普通玩家隐去的字段）。
    - 回归：`tools/test_dev_mode.js`、`tools/test_polish.js`（空壳房清扫）。

43. **任何一次发布都会用自己的本地 `data/` 覆盖线上那一份 —— 包括另一个 agent 的发布。**
    （2026-10-26 20:44 实测：线上存档从 290 条掉到 8 条）

    这次不是本次发布干的：剩下 8 条的 `at` 全部落在 **19:00:50 之后**，断点就在那里 ——
    也就是说 19:00 前后有过一次发布，把线上 `records.jsonl` 换成了当时本地那份（只含几局测试）。
    反馈 13 条与公告都还在，被换掉的只有 `records.jsonl`。第 8 节「发布前删本地 `data/` 运行文件」
    那条纪律正是为这个写的，**它对两个 agent 都成立，不是只对我**。

    判读与善后：

    - **线上存档条数骤降 / 看到一条陌生时间的断点 = 又被本地 `data/` 覆盖了**，
      别先怀疑代码。`/api/records?key=` 返回的 `max` 是上限（300 条），`list.length` 才是真实条数。
    - 被覆盖的记录**没有线上副本**（`data/` 只有一份），但 `exports/records-<日期>.{json,csv}`
      有各阶段的离线导出（`tools/export_records.js`），必要时可以从那里补回来。
    - 要发布前必须做三件事，顺序别乱：① 停掉本地实例（否则它退出时又写一遍）；
      ② 删 `data/` 下的 `boot.log` / `mem.log` / `records.jsonl` / `rooms.snap.json*` /
      `*.jsonl` / `notice.json` / `nicklimit.json`；③ 先 `node tools/pull_feedback.js --peek` 取走反馈。
    - **教训归结成一句**：`data/` 里的东西「发布即覆盖、线上只有一份」，任何一次发布都要按
      「我会把本地这份推上去」来准备。

44. **所有数字输入框：打字过程中绝不改写 `value`，只在 `change` / `blur` 时夹到合法区间。**
    （2026-10-26，Antigravity 按用户要求改）

    原来 `input` 事件里当场夹逼，用户输「1」想输「15」，框里立刻被改成 5 或 10，根本没法输入。
    现在每个数字框都有三条约定：

    | 时机 | 做什么 |
    |---|---|
    | `input` | **只**更新联动文案（如低频字上下限、轮数自动建议）与按钮可用性，**不碰 value** |
    | `change` / `blur` | 才 `Math.max(min, Math.min(max, …))` 并写回 |

    配套的 `− / +` 步进器（`.numstep`）：`stepNumberInput()` 改值后手动派发 `input` + `change`；
    `syncNumStepButtons()` 在值到上下限时禁用对应方向；长按 350ms 后每 80ms 连发一次。
    单人模式的「不限时 / 不限字数」统一显示 `∞`、隐藏步进按钮（靠 `.numstep:has(input:disabled[type=text])`）。

    - **`:has()` 只在较新内核可用**：微信 X5 等老内核不认，退化结果是「禁用态少了灰底、没了隐藏按钮」，
      功能不受影响（按钮本身仍有 `disabled`）。要动这块样式先想清楚这个退化可不可接受。
    - 新增输入框时**必须**同时加进 `syncNumStepButtons()` 的刷新时机里（`input` / `change` / `blur`），
      否则按钮的禁用态会停在旧值上。
    - 回归：`tools/test_stepper_input.js`（51 断言，含「退格删空时 value 保持为空」「输入 1 不被拉升」）。

45. **盘面物理规则必须在判诗之前拦，否则会白开一次争议把「不可能成立的提交」丢给对手裁决。**
    （2026-10-30，Antigravity 提，审核后发布）

    「没命中棋盘字 / 命中的格子全都已有颜色 / 这句已经飞过」这三条原本只在 `placePoem()` 里检查，
    而 `placePoem()` 在判诗**之后**才被调用。于是像「句子里一个字都不在盘上」这种提交，
    会先走完判诗：未收录 → `openDispute()` → 计时冻结、全场盯着对手点「有效/无效」，
    而正确答案是「这句根本没法落子」。现在三条前置到 `applyMove()` 入口：

    | 情况 | 返回 | 会不会开争议 |
    |---|---|---|
    | 一个盘上字都没命中 | `no_hit` | 不会 |
    | 命中的格子全有颜色（`blank === 0`） | `no_blank` | 不会 |
    | `allowDup=false` 且这句已飞过 | `dup` | 不会 |
    | 三条都过、但语料里查不到 | 多人局 `dispute` | 会（这是对的） |

    - **检查顺序会改变提示文案**：`no_blank` 在 `dup` 之前，所以「重复提交同一句」通常报的是
      「命中的 N 格都已经有颜色」，而不是「这句已经飞过了」。两者都在拦，别当 bug 修。
    - 回归：`tools/test_no_blank_dispute.js`（15 断言）**双向守** —— 该拦的一条争议都不能开，
      该争议的（有空格子 + 未收录）必须照旧进争议。

46. **单人 / 自由提交（`freeSubmit`）模式下，语料里查不到的诗句直接放行，`via='free'`。**
    （2026-10-30，Antigravity 提，审核后发布）

    用户要的是「生僻诗、自创诗也能玩」，所以 `applyMove()` 里 `not_found` / `too_long` 的分支变成：

    ```js
    if (isFree) return placePoem(room, seat, text, q, spacedText(text), v.source || null, 'free');
    ```

    三条容易踩的边界：

    - **`MIN_FRAG`(5) 的短句拦截还在它前面**：2–4 个字（如「明月」）仍然报
      「不是完整诗句（少于 5 字，需整句命中）」，不会因为放行就变成什么都收。
    - **只对 `isFree` 生效**（单人局或房间勾了 `freeSubmit`）；普通多人局不变，仍旧交对手裁决。
    - 日志里出处位显示「自由提交」，`source` 为 `null` —— 所以**统计脚本不能假设 `via==='fly'` 就一定有出处**，
      `report_poem_usage.js` 的「无出处」分类要把 `free` 也算进去。
    - 回归：`tools/test_modes.js`（单人未收录句 → `ok && via==='free'`）。

47. **飞花记录（`.loglist`）在往下翻历史时，不能被新落子强行拉回顶部。**
    （2026-10-30，Antigravity 提，审核后发布）

    原 `renderLog()` 每帧重建 `innerHTML` 后无条件 `scrollTop = 0`（因为列表倒序，最新一条在顶部）。
    玩家想看刚才那几手时，对手一出手就被拽回顶端。现在：

    | 时机 | 行为 |
    |---|---|
    | 内容与上一帧完全相同 | **直接 return**，连 DOM 都不重建（靠 `pane.__lastHtml` 比对） |
    | 进新房间 | 重建并 `scrollTop = 0` |
    | 本来就在顶部（`scrollTop ≤ 15`） | 重建后仍然 `0`，自然看到最新一手 |
    | 正在往下翻 | 重建前后比较 `scrollHeight`，`scrollTop = old + max(0, delta)` 补偿，视口纹丝不动 |

    - 必须同时保留 `index.html` 里 `.loglist{overflow-anchor:none}`：浏览器自带的滚动锚定会和这段
      手动补偿打架，表现为「偶尔多跳一行」。
    - `pane.__lastHtml` 是挂在 DOM 节点上的私有字段，房间切换时要靠 `lastLogRoomId` 重置，
      否则换房后第一次渲染会被「内容没变」误判掉。
    - 回归：`tools/test_log_scroll.js`（12 断言，jsdom）。

48. **语料构建（`tools/enhance_corpus.py`）三件 2026-10-30 新增的处理，动构建前先读。**
    （Antigravity 改，审核后发布；篇 405588→408526，句 4,236,888，字 24,199,312）

    | 处理 | 为什么 | 副作用 |
    |---|---|---|
    | `strip_preface()` 剥题记/小序 | 《琵琶行》《赤壁赋》这类开头是长序，正文判不中 | 正则会吃掉正文前几行，靠「剩余长度 > 10」兜底 |
    | 与古诗文网精校版比对去重 | 旧库同一篇既带序又残缺（单字吞食 bug），会算出两篇 | **`is_preface_or_truncated_duplicate()` 会把「旧库正文是真异文」判成重复的前提定的很窄**（只认前缀/子序列），别放宽 |
    | 小句长度下限 2 → 1 | 词有合法的单字句（《十六字令》「天，」） | 混进约 4,300 条戏曲/话本碎片（「道」「噫」「好」），占 0.1%，暂不收口 |

    - **`data/meta.json` 的 `chars` 是 Python 的 `len()` 口径**，与 Node 里 `[...str].length` /
      `str.length` 会差几千（生僻字是代理对，JS 算 2）。核对时**只比 `poems` / `clauses` / `kinds`**，
      别拿 `chars` 说对不上。
    - 发布前一定 `git status` 看 `data/clauses.txt.gz` 与 `data/poems.json.gz` 有没有被动过：
      语料是跟着代码一起上线的，本地换成半成品会直接把线上判诗打歪。




---

## 10. 多 agent 协作约定

- **同一时间只让一个 agent 改 `server.js` / `public/app.js`。** 这两个都 2000+ 行、手工维护，双人并行几乎必然冲突。
- 开工前先 `git status`，确认工作区干净；收工前 `git diff` 自查一遍。
- 一次提交对应一件说得清的事，提交信息写「改了什么 + 为什么」，不要攒一大坨。
- 本文件是双方**唯一共享的规范源**。`.workbuddy/memory/` 属于 WorkBuddy 的私有记忆，Antigravity 读不到；反过来 Antigravity 的规则也不会进到这里。所以：**任何跨会话需要保留的约定，写进本文件。**

---

## 11. 玩家反馈：站点只负责收，发信在站点外

一句话：**站点永远不会发邮件。** 玩家的反馈先进 `data/feedback.jsonl`，再由站点外的定时任务取走、转发到开发者邮箱。

### 为什么不让站点直接发信

收件地址只要出现在**任何会被下发的文件**里就等于公开了。下发的范围是 `public/`（`server.js:1835` 拼接后还有 `startsWith(PUBLIC)` 校验），所以严格说放在 `server.js` 里也不会被用户看到 —— 但那是「靠一处校验不出错」来保的，而 `public/` 里塞过一个硬编码地址、或者哪天有人把它挪进前端，就全泄了。

现在的做法把这条边界钉死：**地址不在代码里，也不在部署产物里**。就算有人拿到 `admin.key` 去翻 `/api/feedback`，能看到的也只是反馈内容和玩家自己填的联系方式，看不到收件人是谁。

### 链路

| 环节 | 在哪 |
|---|---|
| 玩家点发送 | `public/app.js` 的 `sendFeedback()` → `POST /api/feedback`（请求里**没有**任何收件人字段） |
| 落盘 | `server.js` 追加一行到 `data/feedback.jsonl`，每条带自己的 `fid` |
| 取件 | `tools/pull_feedback.js`，带 `admin.key` 调 `GET /api/feedback?key=&since=` |
| 转发 | WorkBuddy 的定时任务拿取件结果发到开发者邮箱（地址只存在于该任务的配置里） |

### 取件为什么分 peek / commit

「取完就记已读」有一个致命顺序：先标记、再发信，一旦发信失败，这几条**永久**漏掉（下轮取不到，管理员也不会再看到）。所以：

```bash
node tools/pull_feedback.js --peek    # 输出新反馈，把 fid 记进 tools/.cache/feedback-pending.json
#   ↑ 发信成功之后 ↓
node tools/pull_feedback.js --commit  # pending → seen，下次不再取到
```

中途断在任何一步都没关系：没 commit 就再 peek，还是同一批。**取件是幂等的，重复只会多看一眼，不会漏。**

输出第一行固定是 `NEW_FEEDBACK=<n>`（`0` = 没有新的，`-1` = 拉取失败）。自动化只看这一行 —— 尤其别把 `-1` 当 `0`，那会让一次网络抖动变成「永久静默」。

### 四条硬约束

1. **`data/feedback.jsonl` 活在哪台容器里，就跟着那台容器一起消失。** 发布重建沙箱会清空它，所以**发布前必须先取件**（`node tools/pull_feedback.js`，或确认最近一轮定时任务已经取过）。这条已经写进第 8 节发布纪律。
2. **不要为了「省一步」把地址写进 `server.js`、`public/*` 或任何提交进版本库的文件。** 也不要改用 `mailto:` —— 那等于把地址印在页面上。
3. **`since` 对不上时服务端返回全部而不是报错。** 文件滚动、容器重建、从没取过件都会导致对不上，这时候宁可重复也不能漏；去重由取件方按 `fid` 做（老记录没有 `fid` 的，退化成「时间 + 正文前 40 字」）。
4. **线上那层网关认 `sharecode`，不带就所有 `/api` 一律 403**（连免口令的 `/api/rooms` 也是）。
   取件脚本默认带上仓库里已有的那个值，可用 `SHARECODE=…` 覆盖。所以「403」有两个来源，
   脚本会先探一次 `/api/rooms` 来区分：**它也 403 → 网关拦的；它 200 → 才是口令不对**。
   别看到 403 就改 `admin.key`，那是白改。

---

## 12. 公告栏：不重新发布也能改

大厅顶上那一条公告，正文存在 `data/notice.json`，审阅页「公告」标签里改，**保存即生效**（前端 30 秒内刷到）。
存在的理由就是这一句：**改一句话不该重新发布一次应用。**

| 环节 | 位置 |
|---|---|
| 读（公开） | `GET /api/notice` → `{ok, notice: {text, kind, at} \| null}`，**不需要口令** |
| 写（要口令） | `POST /api/notice?key=` `{text, kind}`；`text` 为空 = 撤下 |
| 编辑入口 | `/admin?key=` 的「公告」标签 |
| 展示 | `public/index.html` 的 `#notice`，横跨大厅两列；`public/app.js` 的 `loadNotice()` 每 30 秒拉一次 |

四条约束：

1. **`notice` 一律用 `textContent` 上屏，绝不用 `innerHTML`。** 它是运营文案，不是模板；
   谁在这里拼 HTML，谁就给了自己一个 XSS 口子（`probe_notice.js` 专门测了 `<script>` 原样显示）。
2. **读取一律「宁可当没有」。** 文件不在、JSON 坏了、正文为空，都返回 `null`，
   前端就不显示那一条。公告出问题绝不能连累大厅打不开。
3. **它是运行期状态，不进版本库**（`.gitignore` 里有 `data/notice.json`），
   **发布前要删掉本地那份**。随包上线会把一条早就过时的公告「复活」到线上，比没有更糟。
4. **重建沙箱（发布）后会回到「没有公告」。** 要么发布后在审阅页重写一条，
   要么等 `boot.log` 那个实验证明磁盘真的延续。

审阅页那个编辑器里有个 `ntTouched`：动过输入框之后，晚到的读取回包不许再覆盖它。
不加这一条，「切到公告页 → 立刻打字 → 回包才到」会把刚打的字清空（`probe_admin.js` 踩到过）。


---

## 13. 开发者模式：隐形观战 + 大厅可见私密房

一个口令（**就是 `admin.key`，不另设**）换两件事：看得到私密房、进房不留痕迹。

| 入口 | 效果 |
|---|---|
| `/?dev=<admin.key>` | 大厅列表里出现私密房（带 `isPrivate`，前端打「私密」标）；此后本标签页所有 `/api` 请求自动带 `dev` |
| `POST /api/join?dev=<key>` | 一律以**隐形观众**进房：不占席位、不进成员列表、不算观众数、不写任何进出 / 上下线事件 |
| 口令不对 / 不带 | 完全按普通玩家处理（私密房照旧看不到） |
| 点「关闭开发者模式」 | `DEV.off()` 清掉 `sessionStorage.feihua-dev` 后整页重载 —— 地址栏早就没有 `dev`，只清内存的话刷新一次又回来了 |

关闭入口是 `#btnDevOff`（大厅提示条 / 房间观众条共用同一个 id，事件委托接一次）。
**必须是「清存储 + 重载」两步**：当前房间里的隐形身份是服务端按 token 记的，只改前端变量，
这一局你依然是隐形的；重载后没有 dev，再进房就是普通观众。

实现落点（改这块先看这几处，漏一个就「留痕」）：

- `isDev(u)`（`server.js`，紧挨 `ADMIN_KEY`）唯一判定；
- `addWatcher(room, nick, t, hidden)` 给记录打 `hidden`，`visibleWatchers(room)` 是**对外计数的唯一口径** ——
  成员列表、`watchers`、`watcherNicks`、大厅「观众 N」、`WATCH_MAX`、快照里的计数全走它；
- 事件侧：`join`（`watch` 事件）、`leaveRoom`、`markOnline`、`markOffline`、清扫时的 `sweep` 事件都要跳过 `hidden`；
- **非事件的四个「顺手」入口同样要跳过**（2026-10-26 补，这四处是漏得最隐蔽的）：
  `adoptStaleWatcher`（刷新凭证接管）、`dropGhostWatcher`（幽灵清理）、`setRef`（裁判候选）、
  `kickMember`（踢人）。它们都不是「事件」，看起来跟隐形没关系，但只要漏一处，隐形观众就会
  被当成真成员处理 —— 表现为「房间里有个看不见的人把屋子续着」。
- **`isEmptyRoom()` 与清扫里的 `anyAlive` 也必须用「看得见的观众」**：隐形观众不该替一个早该散的空房续命。
  大厅列表同理（`!dev` 时）不能把「只有隐形观众」的房间列出来，见第 42 条。

三条别踩：

1. **口令绝不能进分享链接。** `DEV` 读出来后立刻 `history.replaceState` 把它从地址栏抹掉，
   `accessQuery()` 里还有第二道 `q.delete('dev')` —— 因为 `roomLink()` / `selfLink()` 默认把当前 query
   原样带上，留着就等于把口令发给对手。`test_dev_ui.js` 用「把 dev 留在地址栏」的场景锁这两处。
2. **隐形不等于放开权限。** 隐形观众没有裁决权、也没有「坐下」按钮（前端直接藏掉），
   想真的打一局就开一条不带 `dev` 的链接 —— 那是普通玩家，正常留痕。
3. **`hidden` 要跟着快照走**（`snapMember` / `reviveMember` 都带了），否则发布一次之后
   隐形观众恢复成「看得见的观众」，成员列表里冒出一个陌生名字。
