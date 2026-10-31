const { judge } = require('../judge.js');

const samples = [
  // 1. 楚辞 / 离骚
  { q: '民生各有所乐兮 余独好修以为常', expectedCross: false, desc: '屈原《离骚》同一联' },
  { q: '路漫漫其修远兮 吾将上下而求索', expectedCross: false, desc: '屈原《离骚》名句' },
  { q: '朝饮木兰之坠露兮 夕餐秋菊之落英', expectedCross: false, desc: '屈原《离骚》名句' },
  { q: '长太息以掩涕兮 哀民生之多艰', expectedCross: false, desc: '屈原《离骚》出对句' },

  // 2. 歌行体 / 古风
  { q: '长鲸白齿若雪山 公乎公乎挂罥于其间', expectedCross: false, desc: '李白《公无渡河》' },
  { q: '君不见黄河之水天上来 奔流到海不复回', expectedCross: false, desc: '李白《将进酒》' },
  { q: '君不见高堂明镜悲白发 朝如青丝暮成雪', expectedCross: false, desc: '李白《将进酒》' },
  { q: '五花马千金裘 呼儿将出换美酒', expectedCross: false, desc: '李白《将进酒》' },
  { q: '天生我材必有用 千金散尽还复来', expectedCross: false, desc: '李白《将进酒》' },
  { q: '蜀道之难 难于上青天', expectedCross: false, desc: '李白《蜀道难》' },
  { q: '飞湍瀑流争喧豗 砯崖转石万壑雷', expectedCross: false, desc: '李白《蜀道难》' },
  { q: '我欲因之梦吴越 一夜飞度镜湖月', expectedCross: false, desc: '李白《梦游天姥吟留别》' },
  { q: '安能摧眉折腰事权贵 使我不得开心颜', expectedCross: false, desc: '李白《梦游天姥吟留别》' },
  { q: '同是天涯沦落人 相逢何必曾相识', expectedCross: false, desc: '白居易《琵琶行》' },
  { q: '大弦嘈嘈如急雨 小弦切切如私语', expectedCross: false, desc: '白居易《琵琶行》' },
  { q: '嘈嘈切切错杂弹 大珠小珠落玉盘', expectedCross: false, desc: '白居易《琵琶行》' },
  { q: '别有幽愁暗恨生 此时无声胜有声', expectedCross: false, desc: '白居易《琵琶行》' },
  { q: '在天愿作比翼鸟 在地愿为连理枝', expectedCross: false, desc: '白居易《长恨歌》' },
  { q: '天长地久有时尽 此恨绵绵无绝期', expectedCross: false, desc: '白居易《长恨歌》' },
  { q: '回眸一笑百媚生 六宫粉黛无颜色', expectedCross: false, desc: '白居易《长恨歌》' },

  // 3. 先秦 / 汉魏南北朝古诗
  { q: '关关雎鸠 在河之洲', expectedCross: false, desc: '《诗经·关雎》' },
  { q: '窈窕淑女 君子好逑', expectedCross: false, desc: '《诗经·关雎》' },
  { q: '参差荇菜 左右流之', expectedCross: false, desc: '《诗经·关雎》' },
  { q: '求之不得 寤寐思服', expectedCross: false, desc: '《诗经·关雎》' },
  { q: '悠哉悠哉 辗转反侧', expectedCross: false, desc: '《诗经·关雎》' },
  { q: '青青子衿 悠悠我心', expectedCross: false, desc: '曹操《短歌行》/《诗经》' },
  { q: '但为君故 沉吟至今', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '月明星稀 乌鹊南飞', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '山不厌高 海不厌深', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '周公吐哺 天下归心', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '对酒当歌 人生几何', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '譬如朝露 去日苦多', expectedCross: false, desc: '曹操《短歌行》' },
  { q: '人生几何 譬如朝露', expectedCross: false, desc: '跨句但古诗应包容？' },
  { q: '行行重行行 与君生别离', expectedCross: false, desc: '《古诗十九首》' },
  { q: '相去万余里 各在天一涯', expectedCross: false, desc: '《古诗十九首》' },
  { q: '道路阻且长 会面安可知', expectedCross: false, desc: '《古诗十九首》' },
  { q: '胡马依北风 越鸟巢南枝', expectedCross: false, desc: '《古诗十九首》' },

  // 4. 词 / 曲（词曲长短句不应受诗的律绝跨联限制）
  { q: '明月几时有 把酒问青天', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '不知天上宫阙 今夕是何年', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '我欲乘风归去 又恐琼楼玉宇', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '高处不胜寒 起舞弄清影', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '何似在人间 转朱阁低绮户', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '人有悲欢离合 月有阴晴圆缺', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '此事古难全 但愿人长久', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '但愿人长久 千里共婵娟', expectedCross: false, desc: '苏轼《水调歌头》' },
  { q: '大江东去 浪淘尽千古风流人物', expectedCross: false, desc: '苏轼《念奴娇》' },
  { q: '故垒西边 人道是三国周郎赤壁', expectedCross: false, desc: '苏轼《念奴娇》' },
  { q: '乱石穿空 惊涛拍岸', expectedCross: false, desc: '苏轼《念奴娇》' },
  { q: '卷起千堆雪 江山如画', expectedCross: false, desc: '苏轼《念奴娇》' },

  // 5. 标准近体律绝的真正跨联（必须是格律诗跨联！上一联对句 + 下一联出句）
  { q: '处处闻啼鸟 夜来风雨声', expectedCross: true, desc: '孟浩然《春晓》第2句+第3句（真跨联）' },
  { q: '疑是地上霜 举头望明月', expectedCross: true, desc: '李白《静夜思》第2句+第3句（真跨联）' },
  { q: '白日依山尽 黄河入海流', expectedCross: false, desc: '王之涣《登鹳雀楼》第1+2句（同一联）' },
  { q: '黄河入海流 欲穷千里目', expectedCross: true, desc: '王之涣《登鹳雀楼》第2+3句（真跨联）' },
  { q: '欲穷千里目 更上一层楼', expectedCross: false, desc: '王之涣《登鹳雀楼》第3+4句（同一联）' },
  { q: '汗滴禾下土 谁知盘中餐', expectedCross: true, desc: '李绅《悯农》第2+3句（真跨联）' },
  { q: '锄禾日当午 汗滴禾下土', expectedCross: false, desc: '李绅《悯农》第1+2句（同一联）' },
  { q: '商女不知亡国恨 隔江犹唱后庭花', expectedCross: false, desc: '杜牧《泊秦淮》第3+4句（同一联）' },
  { q: '夜泊秦淮近酒家 商女不知亡国恨', expectedCross: true, desc: '杜牧《泊秦淮》第2+3句（真跨联）' },
];

console.log(`开始检测 ${samples.length} 条测试用例...`);
let fails = 0;
for (const s of samples) {
  const r = judge(s.q);
  if (!r.ok) {
    console.log(`[FAIL 未命中] ${s.desc} -> ${s.q}: ${r.reason}`);
    fails++;
    continue;
  }
  const isCross = !!r.isCrossCouplet;
  if (isCross !== s.expectedCross) {
    console.log(`[FAIL 跨联判断错误] ${s.desc} -> ${s.q}`);
    console.log(`  期望 isCrossCouplet=${s.expectedCross}, 实际=${isCross}, source:`, r.source, `via: ${r.via}, puncts:`, r.puncts);
    fails++;
  } else {
    console.log(`[PASS] ${s.desc} -> ${r.line} (${r.source.dynasty}·${r.source.author}《${r.source.title}》[${r.source.kind}], isCross=${isCross})`);
  }
}

console.log(`\n测试完成: ${samples.length - fails} / ${samples.length} 通过，失败 ${fails}`);
process.exitCode = fails ? 1 : 0;
