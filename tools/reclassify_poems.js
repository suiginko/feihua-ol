'use strict';
/**
 * 纠正 data/poems.json.gz 中误将诗、词、曲、赋标为「文」的篇目。
 * 核心原因：之前 build_corpus.py 中的 guess_kind() 仅按「5/7言占比 >= 80%」判定诗，
 * 导致杂言乐府（如李贺《苏小小墓》）、长短句词（如辛弃疾《水龙吟》）、元曲被误判定为「文」。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_DIR = path.join(__dirname, '..', 'data');
const POEMS_PATH = path.join(DATA_DIR, 'poems.json.gz');

console.log('[reclassify] 读取 poems.json.gz...');
const poems = JSON.parse(zlib.gunzipSync(fs.readFileSync(POEMS_PATH)).toString('utf8'));
console.log(`[reclassify] 篇目总数: ${poems.length}`);

// 常见词牌
const CIPAI = [
  '水龙吟','金缕曲','满江红','念奴娇','菩萨蛮','西江月','浣溪沙','鹧鸪天','蝶恋花','浪淘沙',
  '渔家傲','临江仙','定风波','江城子','虞美人','卜算子','青玉案','清平乐','忆江南','长相思',
  '点绛唇','南歌子','生查子','醉花阴','声声慢','雨霖铃','六州歌头','贺新郎','踏莎行','齐天乐',
  '摸鱼儿','八声甘州','高阳台','木兰花','摊破浣溪沙','更漏子','采桑子','减字木兰花','天仙子',
  '风入松','相见欢','乌夜啼','如梦令','诉衷情','喜迁莺','千秋岁','解连环','永遇乐','暗香',
  '疏影','瑞鹤仙','宴山亭','琐窗寒','眉妩','金斑蝶','垂丝钓','风流子','花犯','兰陵王',
  '宝鼎现','六丑','夜飞庆','绮罗香','过秦楼','庆宫春','黄莺儿','玉蝴蝶','尉迟杯','看花回',
  '解语花','绛都春','早春怨','双双燕','夏初临','柳梢青','琵琶仙','玉烛新','河传','转应曲',
  '金风玉露相逢曲','酷相思','醉翁操','喜朝天','意难忘','霜天晓角','祝英台近','御街行','小重山',
  '阮郎归','朝中措','锦缠道','洞仙歌','诉衷情令','一剪梅','行香子','南乡子','渔父','渔父词'
];

// 常见散曲曲牌
const QUPAI = [
  '天净沙','沉醉东风','山坡羊','折桂令','清江引','凭阑人','寨儿令','落梅风','拨不断','红绣鞋',
  '雁儿落','得胜令','喜春来','快活三','朝天子','醉太平','叨叨令','黑漆弩','小梁州','白鹤子',
  '四块玉','驻马听','普天乐','殿前欢','醉中天','红锦袍','脱布衫','小桃红','水仙子','梧桐树'
];

// 诗歌体裁关键词
const POEM_KEYWORDS = [
  '歌','引','吟','行','谣','弄','操','调','篇','绝句','律诗','古风','乐府','竹枝词','杨柳枝','排律','琴歌','怨'
];

// 散文体裁关键词（若包含则保留为文）
const PROSE_KEYWORDS = ['序','记','传','铭','表','碑','书','论','赞','说','策','箴','辩','戒','题','辨','疏','志','跋','状'];

let fixedCi = 0;
let fixedQu = 0;
let fixedFu = 0;
let fixedShi = 0;

for (let i = 0; i < poems.length; i++) {
  const p = poems[i];
  if (p[3] !== '文') continue;
  const title = p[0] || '';
  const author = p[1] || '';
  const dynasty = p[2] || '';

  // 1. 李贺作品全为诗（存诗无散文）
  if (author === '李贺') {
    p[3] = '诗';
    fixedShi++;
    continue;
  }

  // 2. 标题含赋 -> 赋
  if (title.includes('赋')) {
    p[3] = '赋';
    fixedFu++;
    continue;
  }

  // 3. 散曲判断
  if (QUPAI.some(q => title.includes(q)) || (dynasty === '元' && title.includes('·'))) {
    p[3] = '曲';
    fixedQu++;
    continue;
  }

  // 4. 词判断：含词牌名，或含「·」且不含散文体裁
  const hasCipai = CIPAI.some(c => title.includes(c));
  const hasDotCi = title.includes('·') && !PROSE_KEYWORDS.some(k => title.includes(k));
  if (hasCipai || hasDotCi) {
    p[3] = '词';
    fixedCi++;
    continue;
  }

  // 5. 诗判断：含乐府诗体标识且不属于散文文体
  const hasPoemKw = POEM_KEYWORDS.some(k => title.includes(k)) || (title.includes('诗') && !title.includes('集序') && !title.includes('题诗书'));
  const isProse = PROSE_KEYWORDS.some(k => title.includes(k));
  if (hasPoemKw && !isProse) {
    p[3] = '诗';
    fixedShi++;
    continue;
  }
}

// 扩充权威词牌列表
const EXPANDED_CIPAI = [
  ...CIPAI,
  '忆秦娥','好事近','沁园春','满庭芳','蓦山溪','粉蝶儿','眼儿媚','最高楼','夜行船','玉楼春',
  '清商怨','卜算子慢','昭君怨','江神子','离亭燕','西平乐','夜半乐','声声引','甘草子','喜胜仙',
  '庆春泽','醉桃源','倾杯','倾杯乐','红林擒近','隔浦莲','隔浦莲近拍','安公子','法曲献仙音',
  '塞翁吟','紫玉局','倒犯','侧犯','选冠子','尾犯','花心动','芙蓉月','大有','大石调',
  '大酺','西河','宣清','惜红衣','雪狮儿','解佩令','春光好','木兰花慢','山花子','画堂春',
  '误佳期','惜分飞','谒金门','桂殿秋','梦江南','醉落魄','步蟾宫','茶瓶儿','武陵春','调笑令',
  '夜合花','酒泉子','金菊对芙蓉','百字令','丑奴儿','丑奴儿令','丑奴儿近','摊破丑奴儿','一七令',
  '忆王孙','捣练子','相思引','甘州遍','应天长','抛球乐','更漏子','定西番','归自谣','怨回纥',
  '后庭花','望远行','望梅花','河满子','思帝乡','醉公子','月宫春','中兴乐','归国谣','上行杯',
  '三字令','太常引','白纻词','长命女','少年游','换巢鸾凤','醉花间','点额娇','喜长新','凤栖梧',
  '秋蕊香','汉宫春','玲珑四犯','苏武慢','霓裳中序第一','八归','夜游宫','杏花天','清江引',
  '鹤冲天','惜春华','凤求凰','秋波媚','惜黄花慢','西施','双飞燕','六么令','女冠子','长亭怨慢',
  '玉女摇仙佩','隔溪梅令','惜花春起早慢','恋绣衾','惜双双','看蓬莱','无俗念','西湖好',
  '潇湘夜雨','醉蓬莱','彩云归','梦扬州','泛清波摘遍','黄河清','梅花引','翠楼吟','湘春夜月',
  '惜秋华','夜飞鹊','十二时','六七贤','法驾导引','十样花','江南春','潇湘神','甘州子','赞成功',
  '字字双','玉团儿','红罗袄','剔银灯','玉水明沙','红娘子','月中行','胡捣练','古调笑','醉太平',
  '木兰花令','宴桃源','忆仙姿','渔歌子','三台令','赤枣子'
];
const CIPAI_SET = new Set(EXPANDED_CIPAI);

let shiToCi = 0;
let shiToQu = 0;

for (let i = 0; i < poems.length; i++) {
  const p = poems[i];
  if (p[3] !== '诗') continue;
  const title = p[0] || '';
  const author = p[1] || '';
  const dynasty = p[2] || '';

  // 汉魏六朝先秦绝无词曲
  if (/先秦|汉|魏|晋|南北朝|隋/.test(dynasty)) continue;
  // 排除明确诗题标志
  if (/绝句|律诗|古风|排律|杂诗|组诗|诗首|示儿|赠别|感怀|即事|有感|病中|初度|寄/.test(title) && !title.includes('·')) continue;

  let isCi = false;
  let isQu = false;

  // 1. 曲牌判断
  if (dynasty === '元' && QUPAI.some(q => title.includes(q))) {
    isQu = true;
  }

  // 2. 词牌判断
  if (!isQu) {
    let pfx = '';
    if (title.includes('·')) {
      const parts = title.split('·');
      pfx = parts[0].trim();
      const rest = parts.slice(1).join('·').trim();
      if (!/^其[一二三四五六七八九十百千万\d]+.*$/.test(rest)) {
        if (CIPAI_SET.has(pfx)) isCi = true;
        else if (/[令慢引近犯词曲子]$/.test(pfx) && pfx.length <= 6 && !/绝句|律诗|古风|排律|组诗|杂诗/.test(pfx)) {
          isCi = true;
        }
      }
    } else if (title.includes(' ')) {
      pfx = title.split(' ')[0].trim();
      if (CIPAI_SET.has(pfx)) isCi = true;
    } else {
      pfx = title.trim();
      if (CIPAI_SET.has(pfx)) {
        if (/唐/.test(dynasty) && ['李白','杜甫','王维','高适','岑参','白居易','元稹','孟郊','贾岛'].includes(author)) {
          if (['忆江南','潇湘神','三台令','渔父','渔父词'].includes(pfx)) isCi = true;
        } else {
          isCi = true;
        }
      }
    }
  }

  if (isCi) {
    p[3] = '词';
    shiToCi++;
  } else if (isQu) {
    p[3] = '曲';
    shiToQu++;
  }
}

console.log(`[reclassify] 纠正完成:
  - 「文」纠正为「诗」: ${fixedShi} 篇
  - 「文」纠正为「词」: ${fixedCi} 篇
  - 「文」纠正为「曲」: ${fixedQu} 篇
  - 「文」纠正为「赋」: ${fixedFu} 篇
  - 「诗」纠正为「词」: ${shiToCi} 篇
  - 「诗」纠正为「曲」: ${shiToQu} 篇
  - 合计修正: ${fixedShi + fixedCi + fixedQu + fixedFu + shiToCi + shiToQu} 篇`);

console.log('[reclassify] 正在压缩写回 data/poems.json.gz...');
const outJson = JSON.stringify(poems);
const outGz = zlib.gzipSync(Buffer.from(outJson, 'utf8'), { level: 9 });
fs.writeFileSync(POEMS_PATH, outGz);
console.log(`[reclassify] 写入完成，文件大小: ${(outGz.length / 1024 / 1024).toFixed(2)} MB`);
