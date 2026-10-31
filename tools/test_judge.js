'use strict';
/* 判定核心自测：node tools/test_judge.js
 * 关注三类：该过的要过（含跨朝代/赋/繁体输入）、该拒的要拒、乾字不能被误判。 */

const { load, judge } = require('../judge');

const CASES = [
  // [输入, 期望 ok, 说明]
  ['床前明月光', true, '通行本《静夜思》（与全唐诗底本不同）'],
  ['床前看月光', true, '全唐诗底本《静夜思》'],
  ['举头望山月', true, '全唐诗底本'],
  ['举头望明月', true, '通行本'],
  ['疑是地上霜', true, '五言'],
  ['乾坤日夜浮', true, '杜甫《登岳阳楼》· 乾字'],
  ['吳楚東南坼，乾坤日夜浮', true, '繁体输入 + 标点'],
  ['床前明月光，疑是地上霜', true, '带标点的联句'],
  ['床前明月光疑是地上霜', true, '两句连写（无标点）'],
  ['春风又绿江南岸', true, '王安石《泊船瓜洲》· 宋诗'],
  ['明月几时有', true, '苏轼《水调歌头》· 宋词'],
  ['大江东去', true, '苏轼《念奴娇》· 四字整句'],
  ['关关雎鸠', true, '《诗经》· 四字整句'],
  ['路漫漫其修远兮', true, '《离骚》· 楚辞'],
  ['落霞与孤鹜齐飞', true, '《滕王阁序》· 骈文'],
  ['先天下之忧而忧', true, '《岳阳楼记》· 散文'],
  ['我编了一句根本不存在的诗', false, '伪造句'],
  ['床前明月光疑是地上霜啊啊', false, '真句后面接垃圾'],
  ['春风吹又生', true, '白居易《赋得古原草送别》'],
  ['野火烧不尽', true, '同上'],
  ['宫商角徵羽', true, '徵字（五音，语料作「征」）'],
  ['干戈寥落四周星', true, '文天祥 · 干字'],
  ['粉骨碎身浑不怕', true, '《石灰吟》· 语料作「全不怕」，异文对 全/浑'],
  ['唯见长江天际流', true, '唯/惟 异文对'],
  ['乾坤', false, '两字不成句（少于 5 字须整句命中）'],
  ['执手相看泪眼', true, '柳永《雨霖铃》'],
  ['大漠孤烟直', true, '王维'],
  ['长风破浪会有时', true, '李白'],
  ['天生我材必有用', true, '李白《将进酒》'],
  ['安得广厦千万间', true, '杜甫'],
  // 2026-10-20：跨小句连写 + 语料不再全局去重（用户报「未收录」的五条）
  ['故国神游，多情应笑我，早生华发', true, '苏轼《念奴娇》· 三个小句连写'],
  ['百年里浑教是醉三万六千场', true, '苏轼《满庭芳》· 中段曾被去重删掉'],
  ['眼前直下三千字胸次全无一点尘', true, '于谦《观书》· 曾被去重删句'],
  ['归去，也无风雨也无晴', true, '苏轼《定风波》· 2 字小句 + 7 字小句'],
  ['欲把西湖比西子，淡妆浓抹总相宜', true, '苏轼《饮湖上初晴后雨》· 曾只剩前两句'],
  ['故国神游，多情应笑我，早生华发啊', false, '真句尾巴接垃圾'],
  ['欲把西湖比西子淡妆浓抹总相宜啊', false, '真句尾巴接垃圾（无标点）'],
  // 2026-10-26：乐府杂言与词作分类纠正回归
  ['无物结同心，烟花不堪剪', true, '李贺《苏小小墓》· 乐府杂言（曾误标为文）'],
  ['楚天千里清秋，水随天去秋无际', true, '辛弃疾《水龙吟·登建康赏心亭》· 词（曾误标为文）'],
];

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

function main() {
  const s = load();
  console.log(`语料：${s.lines} 句 / ${s.poems} 篇 / ${(s.chars / 1048576).toFixed(1)} MB，加载 ${s.ms} ms\n`);

  const all = { 诗: 1, 词: 1, 曲: 1, 赋: 1, 文: 1 };
  let pass = 0, fail = 0;
  const times = [];
  for (const [text, want, note] of CASES) {
    const t = process.hrtime.bigint();
    const r = judge(text, { allowKinds: all });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    times.push(ms);
    const good = r.ok === want;
    if (good) pass++; else fail++;
    const src = r.source ? `《${r.source.title}》${r.source.author}·${r.source.dynasty}·${r.source.kind}` : r.reason;
    console.log('%s %s %s %s %sms  %s',
      good ? '  ' : '!!', pad(text, 26), r.ok ? 'PASS' : 'FAIL',
      pad(r.via || r.code, 9), ms.toFixed(1).padStart(5), src);
    if (!good) console.log('     期望', want, '实际', JSON.stringify(r));
  }

  // 专项验证：只开启「诗」时，苏小小墓通过，而《赤壁赋》（赋）提示本局未启用该文体
  const rSu = judge('无物结同心，烟花不堪剪', { allowKinds: { 诗: 1 } });
  if (rSu.ok && rSu.source && rSu.source.kind === '诗') {
    pass++;
    console.log('   苏小小墓（诗模式）       PASS exact');
  } else {
    fail++;
    console.log('!! 苏小小墓（诗模式）       FAIL', JSON.stringify(rSu));
  }

  const rFu = judge('清风徐来，水波不兴', { allowKinds: { 诗: 1 } });
  if (!rFu.ok && rFu.reason.includes('本局未启用该文体')) {
    pass++;
    console.log('   赤壁赋（未启用文体提示） PASS kind-reject');
  } else {
    fail++;
    console.log('!! 赤壁赋（未启用文体提示） FAIL', JSON.stringify(rFu));
  }

  // 专项验证：杂言古诗（公无渡河）两句相连不误判跨联，标点正常
  const rGwh = judge('有长鲸白齿若雪山 公乎公乎挂罥于其间');
  if (rGwh.ok && !rGwh.isCrossCouplet && rGwh.lineWithPunct === '有长鲸白齿若雪山，公乎公乎挂罥于其间。') {
    pass++;
    console.log('   公无渡河（杂言古诗两句不误判跨联） PASS non-cross');
  } else {
    fail++;
    console.log('!! 公无渡河（杂言古诗两句不误判跨联） FAIL', JSON.stringify(rGwh));
  }

  // 专项验证：规则近体诗（静夜思）跨联提交两句准确拦截
  const rJysCross = judge('疑是地上霜 举头望明月');
  if (rJysCross.ok && rJysCross.isCrossCouplet === true) {
    pass++;
    console.log('   静夜思（规则近体诗跨联两句拦截） PASS cross-couplet');
  } else {
    fail++;
    console.log('!! 静夜思（规则近体诗跨联两句拦截） FAIL', JSON.stringify(rJysCross));
  }

  // 专项验证：屈原《离骚》同一联不误判跨联
  const rLs = judge('民生各有所乐兮 余独好修以为常');
  if (rLs.ok && !rLs.isCrossCouplet && rLs.lineWithPunct === '民生各有所乐兮，余独好修以为常。') {
    pass++;
    console.log('   离骚（屈原离骚同一联不误判跨联） PASS lisao-non-cross');
  } else {
    fail++;
    console.log('!! 离骚（屈原离骚同一联不误判跨联） FAIL', JSON.stringify(rLs));
  }

  // 专项验证：唐前古体诗（短歌行）不误判近体跨联
  const rDgx = judge('人生几何 譬如朝露');
  if (rDgx.ok && !rDgx.isCrossCouplet) {
    pass++;
    console.log('   短歌行（汉代古诗不误判跨联） PASS ancient-non-cross');
  } else {
    fail++;
    console.log('!! 短歌行（汉代古诗不误判跨联） FAIL', JSON.stringify(rDgx));
  }

  // 专项验证：李白《宣州谢朓楼饯别校书叔云》异文全覆盖（览/揽、消/销）
  const rXtl1 = judge('俱怀逸兴壮思飞，欲上青天览明月');
  const rXtl2 = judge('抽刀断水水更流，举杯消愁愁更愁');
  if (rXtl1.ok && rXtl2.ok) {
    pass++;
    console.log('   宣州谢朓楼饯别校书叔云（异文全兼容） PASS xietiaolou-variants');
  } else {
    fail++;
    console.log('!! 宣州谢朓楼饯别校书叔云（异文全兼容） FAIL', JSON.stringify({ rXtl1, rXtl2 }));
  }

  times.sort((a, b) => a - b);
  console.log(`\n通过 ${pass} / ${pass + fail}，错误 ${fail}`);
  console.log(`判定耗时：中位 ${times[Math.floor(times.length / 2)].toFixed(1)}ms  ` +
    `p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)}ms  最大 ${times[times.length - 1].toFixed(1)}ms`);
  process.exit(fail ? 1 : 0);
}

main();
