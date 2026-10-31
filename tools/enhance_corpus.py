# -*- coding: utf-8 -*-
"""处理与整合高质量古诗文网数据库到主语料中。
核心功能：
1. 异文智能展开：包含 (A 一作：B) 与 (一作：B) 的名篇，同时展开收录通行本与异文本
2. 保留标点符号：每个小句记录其原始标点（，、。、！、？、；等）
3. 词曲文体校准：识别常见词牌名、辞赋名篇、散文古文名篇，诗经305篇全归入「诗」
4. 诗词序言剥离：剥离诗词开头的题记、小序、创作背景说明，还原正文纯净诗句
5. 输出增强的 clauses.txt.gz 与 poems.json.gz
"""
import gzip
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
CACHE = os.path.join(HERE, ".cache")
ARCHIVE_CACHE = os.path.abspath(os.path.join(ROOT, "..", "feihua-ol-archive", "tools-cache"))
if not os.path.exists(os.path.join(CACHE, "base_clauses.txt.gz")) and os.path.exists(ARCHIVE_CACHE):
    CACHE = ARCHIVE_CACHE
SOURCES = os.path.join(CACHE, "sources")

PUNCT_SPLIT = re.compile(r"([，。！？；：、\n\r]+)")
CJK_CHAR = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FA5\u3007]")

CI_PAI = {
    "念奴娇", "水调歌头", "满江红", "菩萨蛮", "西江月", "浪淘沙", "临江仙", "虞美人",
    "卜算子", "浣溪沙", "清平乐", "鹧鸪天", "定风波", "鹊桥仙", "蝶恋花", "雨霖铃",
    "生查子", "点绛唇", "青玉案", "破阵子", "江城子", "如梦令", "相见欢", "醉花阴",
    "声声慢", "永遇乐", "贺新郎", "贺新凉", "摸鱼儿", "渔家傲", "踏莎行", "南乡子", "长相思",
    "减字木兰花", "昭君怨", "诉衷情", "一剪梅", "八声甘州", "苏幕遮", "桂枝香",
    "望海潮", "摊破浣溪沙", "摊破丑奴儿", "木兰花", "玉楼春", "千秋岁", "御街行",
    "兰陵王", "六丑", "暗香", "疏影", "夜巡粮", "烛影摇红", "洞仙歌", "解语花",
    "沁园春", "采桑子", "忆江南", "望江南", "南歌子", "更漏子", "喜迁莺", "宴山亭",
    "离亭燕", "齐天乐", "夜飞庆", "瑞鹤仙", "小重山", "风入松", "渔父", "阮郎归",
    "忆秦娥", "好事近", "霜天晓角", "诉衷情令", "祝英台近", "醉翁操", "黄鹤楼",
    "蓦山溪", "锦缠道", "行香子", "酷相思", "解连环", "青衫湿", "台城路", "满庭芳",
    "眼儿媚", "乌夜啼", "少年游", "思帝乡", "朝中措", "忆少年", "于中好", "长亭怨慢",
    "江神子", "南柯子", "喜朝天", "薄幸", "西施", "意难忘", "青玉案", "粉蝶儿",
    "钗头凤", "渔歌子", "画堂春", "谒金门", "最高楼", "天仙子", "醉桃源", "河传", "水龙吟", "高阳台", "宴清都", "庆宫春", "惜红衣"
}
QU_KEYWORDS = ["天净沙", "山坡羊", "醉中天", "朝天子", "折桂令", "红绣鞋", "沉醉东风", "喜春来", "落梅风", "拨不断", "叨叨令", "寄生草", "散曲"]
CHU_CI = ["离骚", "九歌", "九章", "天问", "九辩", "招魂", "大招", "远游", "卜居", "渔父", "哀郢", "怀沙", "思美人", "惜往日", "橘颂", "悲回风", "涉江"]
CLASSIC_WEN = ["论语", "孟子", "庄子", "荀子", "史记", "战国策", "左传", "世说新语", "资治通鉴", "国语", "礼记", "尚书", "吕氏春秋", "淮南子", "逍遥游", "劝学", "鸿门宴", "陈涉世家", "曹刿论战", "邹忌", "荆轲", "廉颇蔺相如"]
CLASSIC_AUTHORS = {"孔子", "孟子", "庄子", "荀子", "韩非", "韩非子", "墨子", "列子", "老子", "管仲", "晏子", "左丘明", "司马迁", "班固", "刘向"}

# 诗经 305 篇全集篇名
SHI_JING_SET = {
    "关雎", "葛覃", "卷耳", "樛木", "螽斯", "桃夭", "兔罝", "芣苢", "汉广", "汝坟", "麟之趾",
    "鹊巢", "采蘩", "草虫", "采蘋", "甘棠", "行露", "羔羊", "殷其雷", "摽有梅", "小星", "江有汜", "野有死麇", "何彼襛矣", "驺虞",
    "柏舟", "绿衣", "燕燕", "日月", "终风", "击鼓", "凯风", "雄雉", "匏有苦叶", "谷风", "式微", "微子", "简兮", "泉水", "北门", "北风", "静女", "新台", "二子乘舟",
    "墙有茨", "君子偕老", "桑中", "鹑之奔奔", "定之方中", "蝃蝀", "相鼠", "干旄", "载驰",
    "淇奥", "考槃", "硕人", "氓", "竹竿", "芄兰", "伯兮", "有狐", "木瓜", "河广",
    "黍离", "君子于役", "君子阳阳", "扬之水", "中谷有蓷", "葛藟", "采葛", "大车", "丘中有麻",
    "缁衣", "将仲子", "叔于田", "大叔于田", "清人", "羔裘", "遵大路", "女曰鸡鸣", "有女同车", "山有扶苏", "讬葴", "狡童", "褰裳", "丰", "东门之墠", "风雨", "子衿", "出其东门", "野有蔓草", "溱洧",
    "鸡鸣", "还", "著", "东方之日", "东方未明", "南山", "甫田", "卢令", "敝笱", "载驱", "猗嗟",
    "葛屦", "汾沮洳", "园有桃", "陟岵", "十亩之间", "伐檀", "硕鼠",
    "蟋蟀", "山有枢", "椒聊", "绸缪", "杕杜", "鸨羽", "无衣", "有杕之杜", "葛生", "采苓",
    "车邻", "驷驖", "小戎", "蒹葭", "终南", "黄鸟", "晨风", "渭阳", "权舆",
    "宛丘", "东门之枌", "衡门", "东门之池", "东门之杨", "墓门", "防有鹊巢", "月出", "株林", "泽陂",
    "素冠", "隰有苌楚", "匪风", "蜉蝣", "候人", "鸤鸠", "下泉",
    "七月", "鸱鸮", "东山", "破斧", "伐柯", "九罭", "狼跋",
    "鹿鸣", "四牡", "皇皇者华", "常棣", "伐木", "天保", "采薇", "出车", "鱼丽", "南有嘉鱼", "南山有台", "酬薄", "吉日", "鸿雁", "庭燎", "沔水", "鹤鸣", "祈父", "白驹", "我行其野", "斯干", "无羊", "节南山", "正月", "十月之交", "雨无正", "小旻", "小宛", "小弁", "巧言", "何人斯", "巷伯", "蓼莪", "大东", "四月", "北山", "无将大车", "小明", "鼓钟", "楚茨", "信南山", "大田", "瞻彼洛矣", "裳裳者华", "桑扈", "鸳鸯", "頍弁", "车舝", "弁", "白华", "黍苗", "宾之初筵", "鱼藻", "采菽", "角弓", "菀柳", "都人士", "采绿", "隰桑", "绵蛮", "瓠叶", "渐渐之石", "苕之华", "何草不黄",
    "文王", "大明", "绵", "棫朴", "旱麓", "思齐", "皇矣", "下武", "文王有声", "生民", "渊", "公刘", "泂酌", "卷阿", "民劳", "板", "荡", "抑", "桑柔", "云汉", "崧高", "蒸民", "韩奕", "江汉", "常武", "瞻卬", "召旻",
    "清庙", "维天之命", "维清", "烈文", "天作", "昊天有成命", "我将", "时迈", "执竞", "思文", "臣工", "噫嘻", "振鹭", "丰年", "有瞽", "潜", "雝", "载见", "有客", "武", "闵予小子", "访予落", "敬之", "小毖", "载芟", "良耜", "酌", "桓", "赉", "般",
    "駉", "有駜", "泮水", "閟宫", "那", "烈祖", "玄鸟", "长发", "殷武"
}

# 繁简转换映射（直接复用 data/t2s.json）
with open(os.path.join(DATA, "t2s.json"), "r", encoding="utf-8") as f:
    T2S = json.load(f)

def to_simp(s):
    out = []
    for ch in s:
        out.append(T2S.get(ch, ch))
    return "".join(out)

def clean_html(text):
    text = re.sub(r"<[^>]+>", "\n", text)
    text = text.replace("&nbsp;", " ").replace("&emsp;", " ").replace("\t", " ")
    return text

def strip_preface(text, kind, title):
    """剥离诗词赋开头的题记、小序、创作背景说明，只保留正文诗句"""
    if kind not in ["诗", "词", "曲", "赋"]:
        return text

    t = text.strip()

    # 模式 1: 诗歌/赋/词中以 '其[辞词歌诗]曰' / '[辞词歌诗]曰' 过渡到正文
    # 例如：...遂作斯赋。其辞曰：\n余从京域... 或 歌曰：\n...
    m = re.search(r"^(?:[\s\S]*?)(?:其[辞词歌诗]曰|[辞词歌诗]曰)[：:，。\s]*(?:<br\s*/?>|\n|\r)+", t, re.DOTALL)
    if m:
        after = t[m.end():].strip()
        if len(after) > 10:
            return after

    # 模式 2: 《琵琶行》式 '命曰《...》' / '名曰《...》' / '歌以赠之'
    m2 = re.search(r"^(?:[\s\S]*?)(?:命曰[《〈].*?[〉》]|名曰[《〈].*?[〉》]|题曰[《〈].*?[〉》]|歌以赠之|为作此诗|乃作此诗)[。！\s]*(?:<br\s*/?>|\n|\r)+", t, re.DOTALL)
    if m2:
        after = t[m2.end():].strip()
        if len(after) > 10:
            return after

    # 模式 3: 首段为独立小序（以【序】/小序/序曰/并序 开头，或以 作此词/作此篇/故作此词 等结尾）
    paragraphs = [p.strip() for p in re.split(r"(?:<br\s*/?>|\n|\r)+", t) if p.strip()]
    if len(paragraphs) > 1:
        p0 = paragraphs[0]
        p0_clean = re.sub(r"<[^>]+>", "", p0).strip()
        p0_clean = p0_clean.replace("&nbsp;", "").replace("&emsp;", "").strip()
        p0_clean = re.sub(r"[（(〔\[].*?[)）〕\]]", "", p0_clean).strip()
        is_p0_xu = False
        if re.match(r"^(?:【序】|〔序〕|\[序\]|（序）|序[：:\s曰言云，。]|小序[：:\s曰言云，。]?|并序[：:\s，。]?)", p0_clean):
            is_p0_xu = True
        elif re.search(r"(?:(?:故|因|乃|戏|遂|因命|命|为|聊复|因复)?作此(?:篇|词|歌|诗|曲|调|阕|解)?|为作此(?:词|诗)|作[此一]首|因赋此(?:词|诗)?|赋此|兼怀[^\n<，。]+)[。！]?$", p0_clean):
            is_p0_xu = True

        if is_p0_xu:
            after = "\n".join(paragraphs[1:]).strip()
            if len(after) > 10:
                return after

    return t

def extract_variants(text):
    text = clean_html(text)
    matches = list(re.finditer(r"[（(]([^）)]*?(?:一作|同|通)[：:\s][^）)]*?)[)）]", text))
    if not matches:
        cleaned = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", text)
        return [cleaned]

    # 底本（清除所有括号标记）
    base_text = text
    for m in reversed(matches):
        base_text = base_text[:m.start()] + base_text[m.end():]
    base_text = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", base_text)
    results = [base_text]

    # 异文本：从后往前进行智能词级/句级替换
    var_text = text
    for m in reversed(matches):
        m_start = m.start()
        m_end = m.end()
        inner = m.group(1).strip()
        
        # 1. 尝试整句/半句一作：如 (一作：却道故心人易变) 或 (一作：有美人兮，见之不忘。)
        m_direct = re.match(r"^一作[：:\s]+([\u4e00-\u9fa5，。、？！；\s/]+)$", inner)
        if m_direct:
            alts = [a.strip() for a in re.split(r"[/／或]", m_direct.group(1)) if a.strip()]
            alt = alts[0].rstrip("，。！？；、")
            pre = var_text[:m_start]
            alt_clause_cnt = len(re.split(r"[，。！？；、]", alt))
            m_clauses = list(re.finditer(r"[^，。！？；\n]+", pre))
            if m_clauses:
                target_clauses = m_clauses[-alt_clause_cnt:]
                idx = target_clauses[0].start()
                last_clause = target_clauses[-1]
                end_idx = last_clause.end()
                var_text = var_text[:idx] + alt + var_text[end_idx:m_start] + var_text[m_end:]
                continue

        # 2. 词级一作：如 (穿空 一作：崩云；人生 一作：人间；尊 同：樽)
        sub_items = re.split(r"[；;，,、]", inner)
        replaced_any = False
        var_segment = var_text[:m_start]
        for s in sub_items:
            sm = re.search(r"([\u4e00-\u9fa5]+)\s*(?:一作|同|通)[：:\s]+([\u4e00-\u9fa5]+)", s)
            if sm:
                orig, alt = sm.group(1), sm.group(2)
                idx = var_segment.rfind(orig)
                if idx != -1 and (len(var_segment) - idx - len(orig)) <= 35:
                    var_segment = var_segment[:idx] + alt + var_segment[idx + len(orig):]
                    replaced_any = True
        if replaced_any:
            var_text = var_segment + var_text[m_end:]
        else:
            var_text = var_text[:m_start] + var_text[m_end:]

    var_text = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", var_text)
    if var_text != base_text:
        results.append(var_text)
    return results

def split_clauses_with_puncts(text):
    parts = PUNCT_SPLIT.split(text)
    clauses = []
    puncts = []
    for i in range(0, len(parts), 2):
        raw_c = parts[i].strip()
        clean_c = to_simp("".join(CJK_CHAR.findall(raw_c)))
        if not clean_c or len(clean_c) > 40:
            continue
        punct_str = parts[i + 1] if i + 1 < len(parts) else ""
        if "。" in punct_str:
            p_mark = "。"
        elif "！" in punct_str or "!" in punct_str:
            p_mark = "！"
        elif "？" in punct_str or "?" in punct_str:
            p_mark = "？"
        elif "；" in punct_str or ";" in punct_str:
            p_mark = "；"
        elif "、" in punct_str:
            p_mark = "、"
        else:
            p_mark = "，"
        clauses.append(clean_c)
        puncts.append(p_mark)
    return clauses, "".join(puncts)

def fix_clauses(clauses, puncts_str):
    # 修复常见断句错误：多情应笑 / 我早生华发 -> 多情应笑我 / 早生华发
    new_c = []
    new_p = []
    i = 0
    while i < len(clauses):
        c = clauses[i]
        p = puncts_str[i] if i < len(puncts_str) else "，"
        if c == "多情应笑" and i + 1 < len(clauses) and clauses[i + 1].startswith("我早生华发"):
            new_c.append("多情应笑我")
            new_p.append("，")
            rem = clauses[i + 1][1:]
            p2 = puncts_str[i + 1] if i + 1 < len(puncts_str) else "。"
            new_c.append(rem)
            new_p.append(p2)
            i += 2
            continue
        new_c.append(c)
        new_p.append(p)
        i += 1
    return new_c, "".join(new_p)

def normalize_dynasty(dynasty):
    d = str(dynasty or "").strip()
    if d.lower() == "yuan":
        return "元"
    if any(k in d for k in ["近", "当", "现"]):
        return "现代"
    d = d.replace("代", "").replace("朝", "")
    if d in ["两汉", "汉代", "西汉", "东汉"]:
        return "汉"
    if d in ["南宋", "北宋"]:
        return "宋"
    if d in ["南唐", "后唐", "前蜀", "后蜀", "南汉", "北汉", "吴越", "闽", "楚", "五"]:
        return "五代"
    if d in ["南北朝", "南朝", "北朝"]:
        return "南北"
    return d

CAO_CAO_WORKS = {
    "短歌行", "观沧海", "龟虽寿", "步出夏门行", "蒿里行", "薤露", "薤露行",
    "苦寒行", "度关山", "善哉行", "对酒", "陌上桑", "气出唱", "精列", "董逃歌", "秋胡行"
}

def check_caocao(title, author, content):
    t = (title or "").strip()
    a = (author or "").strip()
    if a == "曹操":
        return "曹操", "汉", "诗"
    if a in ["佚名", "无名氏", "未知", "缺名", "阙名", "待考", ""]:
        for cw in CAO_CAO_WORKS:
            if cw in t:
                return "曹操", "汉", "诗"
        if any(line in content for line in [
            "对酒当歌人生几何", "何以解忧唯有杜康", "山不厌高海不厌深", "老骥伏枥志在千里",
            "烈士暮年壮心不已", "白骨露于野千里无鸡鸣", "东临碣石以观沧海", "神龟虽寿猷有竟时"
        ]):
            return "曹操", "汉", "诗"
    return a, None, None

def is_zaju(title):
    t = (title or "").strip()
    return "杂剧" in t

def guess_kind(title, author, content):
    t = (title or "").strip()
    a = (author or "").strip()

    # 曹操的诗全部归入「诗」
    if a == "曹操":
        return "诗"

    # 1. 诗经与楚辞篇目均归入「诗」
    t_clean = re.sub(r"[（(〔\[].*?[)）〕\]]", "", t).strip()
    if "诗经" in t or any(w in t for w in ["周南", "召南", "邶风", "鄘风", "卫风", "王风", "郑风", "齐风", "魏风", "唐风", "秦风", "陈风", "桧风", "曹风", "豳风", "国风", "小雅", "大雅", "周颂", "鲁颂", "商颂"]):
        return "诗"
    if t_clean in SHI_JING_SET or any(t_clean.startswith(s + "·") or f"·{s}" in t_clean for s in SHI_JING_SET):
        return "诗"
    if (a in ["屈原", "宋玉"] and any(c in t for c in CHU_CI)) or "楚辞" in t or any(c in t for c in CHU_CI):
        return "诗"

    # 2. 辞赋判断：真正的赋（注意排除科举命题诗的「赋得...」）
    if "赋得" not in t:
        if t.endswith("赋") or "·赋" in t or "赋·" in t:
            return "赋"

    # 3. 曲
    if any(q in t for q in QU_KEYWORDS):
        return "曲"

    # 4. 词：识别词牌
    for cp in CI_PAI:
        if cp in t:
            return "词"

    # 检查 · （排除组诗序号 ·其一、·其二 等）
    t_no_num = re.sub(r"·其[一二三四五六七八九十百千万\d]+.*$", "", t)
    if "·" in t_no_num:
        prefix = t_no_num.split("·")[0].strip()
        if prefix in CI_PAI or any(cp in prefix for cp in CI_PAI):
            return "词"
        if not any(w in t_no_num for w in ["论语", "荀子", "孟子", "庄子", "列子", "韩非子", "墨子", "管子", "史记", "汉书"]):
            if any(w in t_no_num for w in ["词", "曲子", "令", "慢", "引", "近", "犯"]):
                return "词"

    if "词" in t or "曲子" in t:
        return "词"

    # 5. 计算五七言规整度（绝句/律诗/歌行）
    lines = [len(c.strip()) for c in re.split(r"[，。！？；：、\n]+", content) if 2 <= len(c.strip()) <= 40]
    reg_ratio = 0
    if lines:
        reg_ratio = sum(1 for L in lines if L in [5, 7]) / len(lines)
        if reg_ratio >= 0.75 and len(lines) >= 4:
            return "诗"

    # 6. 文（散文/骈文/传记/论说）
    if a in CLASSIC_AUTHORS or any(k in t for k in CLASSIC_WEN):
        return "文"

    WEN_ENDINGS = ["记", "说", "序", "铭", "表", "论", "传", "策", "箴", "谏", "疏", "辩", "辨", "解", "原", "议", "赞", "志"]
    for w in WEN_ENDINGS:
        if t.endswith(w) or f"{w}·" in t or f"·{w}" in t:
            return "文"

    if any(t.endswith(s) for s in ["书", "启", "辨", "志", "录"]) and reg_ratio < 0.4:
        return "文"


    return "诗"

def is_preface_or_truncated_duplicate(old_text, gsw_text):
    if old_text == gsw_text:
        return True
    # 若老库内容包含古诗文网精校版正文（老库只是前缀带了序言），予以去重
    if gsw_text in old_text:
        return True
    # 若老库为古诗文网正文因老单字吞食 bug 造成的残缺子序列，予以剔除；真正异文不满足此条件，会安全保留
    if len(old_text) < len(gsw_text):
        diff = len(gsw_text) - len(old_text)
        if diff <= max(10, len(gsw_text) * 0.15):
            it = iter(gsw_text)
            if all(ch in it for ch in old_text):
                return True
    return False

def main():
    t0 = time.time()
    print("=" * 60)
    print("开始增强与重构飞花令诗词数据库...")
    print("=" * 60)

    # 1. 读取固化的纯净基础语料（确保构建幂等）
    base_c = os.path.join(CACHE, "base_clauses.txt.gz")
    base_p = os.path.join(CACHE, "base_poems.json.gz")
    if not (os.path.exists(base_c) and os.path.exists(base_p)):
        print("未找到基础语料缓存 base_clauses.txt.gz，回退到 data 目录...")
        base_c = os.path.join(DATA, "clauses.txt.gz")
        base_p = os.path.join(DATA, "poems.json.gz")

    print(f"1. 正在加载基础语料库 ({os.path.basename(base_c)})...", flush=True)
    with gzip.open(base_c, "rt", encoding="utf-8") as f:
        old_blob = f.read()
    with gzip.open(base_p, "rt", encoding="utf-8") as f:
        old_poems = json.load(f)

    old_clauses = old_blob.split("\n")
    print(f"   基础语料篇数: {len(old_poems)}, 小句数: {len(old_clauses)}")

    # 2. 读取古诗文网数据库并展开异文
    gsw_path = os.path.join(SOURCES, "gushiwen.json.gz")
    if not os.path.exists(gsw_path):
        print("未找到 gushiwen.json.gz，请先下载！")
        return

    print("2. 正在解析古诗文网精校数据库并展开异文与剥离序言...", flush=True)
    with gzip.open(gsw_path, "rt", encoding="utf-8") as f:
        gsw_data = json.load(f)

    all_clauses = []
    meta_poems = []
    gsw_clause_count = 0
    expanded_count = 0
    stripped_preface_count = 0
    seen_gsw_poems = set()
    gsw_ta_map = {}
    gsw_author_map = {}

    for item in gsw_data:
        title = (item.get("title") or "无题").strip()
        if is_zaju(title):
            continue
        author = (item.get("author") or "佚名").strip()
        dynasty = normalize_dynasty(item.get("dynasty") or "唐")
        content = item.get("content") or ""

        # 校准曹操作者与文体
        ca_author, ca_dyn, ca_kind = check_caocao(title, author, content)
        if ca_author:
            author = ca_author
        if ca_dyn:
            dynasty = ca_dyn

        kind = ca_kind or guess_kind(title, author, content)

        # 剥离诗词开头的序言
        clean_content = strip_preface(content, kind, title)
        if clean_content != content:
            stripped_preface_count += 1

        variants = extract_variants(clean_content)

        is_var = len(variants) > 1
        if is_var:
            expanded_count += 1

        for v_idx, var_text in enumerate(variants):
            cs, ps = split_clauses_with_puncts(var_text)
            if not cs:
                continue
            # 纠正断句（如多情应笑我 早生华发）
            cs, ps = fix_clauses(cs, ps)

            # prio: 古诗文网精校名篇设为 5~10（高优先级）
            prio = 10 if not is_var else (5 if v_idx == 0 else 8)
            v_title = title if v_idx == 0 else f"{title}(异文版)"

            meta_poems.append([v_title, author, dynasty, kind, len(cs), prio, ps])
            all_clauses.extend(cs)
            gsw_clause_count += len(cs)
            seen_gsw_poems.add((title, author, "".join(cs)))
            t_key = (title.strip(), author.strip())
            if t_key not in gsw_ta_map:
                gsw_ta_map[t_key] = []
            gsw_ta_map[t_key].append("".join(cs))
            a_key = author.strip()
            if a_key:
                if a_key not in gsw_author_map:
                    gsw_author_map[a_key] = []
                gsw_author_map[a_key].append((title.strip(), "".join(cs)))

    print(f"   古诗文网精校库处理完毕：共提取 {len(meta_poems)} 篇（含异文展开 {expanded_count} 篇，剥离序言 {stripped_preface_count} 篇），小句数: {gsw_clause_count}")

    # 3. 融合原语料库（补充全唐诗/全宋诗冷门覆盖，已收录名篇去重避免冗余）
    print("3. 正在融合原语料库（补充全唐诗/全宋诗冷门覆盖）...", flush=True)
    old_clause_idx = 0
    retained_old_poems = 0
    retained_old_clauses = 0

    for p in old_poems:
        title, author, dynasty, kind, c_count, prio = p[:6]
        cs = old_clauses[old_clause_idx : old_clause_idx + c_count]
        old_clause_idx += c_count
        if not cs or not cs[0]:
            continue

        if is_zaju(title):
            continue

        raw_text = "".join(cs)

        # 朝代规范化（唐宋元明清单字，拼音 yuan 修正）
        dynasty = normalize_dynasty(dynasty)

        # 校准曹操作者与文体
        ca_author, ca_dyn, ca_kind = check_caocao(title, author, raw_text)
        if ca_author:
            author = ca_author
        if ca_dyn:
            dynasty = ca_dyn

        # 补全标点串并纠正断句
        ps_list = ["。" if i % 2 == 1 else "，" for i in range(len(cs))]
        cs, ps = fix_clauses(cs, "".join(ps_list))

        # 去重：若古诗文网已收录该篇目（同标题+同作者，或核心主标题一致）
        t_key = (title.strip(), author.strip())
        core_title = re.split(r'[/／·(（]', title)[0].strip()
        core_t_key = (core_title, author.strip())
        matched_gsw_texts = []
        if t_key in gsw_ta_map:
            matched_gsw_texts.extend(gsw_ta_map[t_key])
        if core_title and core_t_key in gsw_ta_map:
            matched_gsw_texts.extend(gsw_ta_map[core_t_key])

        if matched_gsw_texts:
            is_dup = False
            for gsw_t in matched_gsw_texts:
                if is_preface_or_truncated_duplicate(raw_text, gsw_t):
                    is_dup = True
                    break
                # 精校版正文前 14 个字特征指纹（如「浔阳江头夜送客枫叶荻花秋瑟瑟」）若完全出现在老库中，
                # 说明老库是同首诗多带了序言的低质旧版，直接予以剔除
                if len(gsw_t) >= 14 and gsw_t[:14] in raw_text:
                    is_dup = True
                    break
            if is_dup:
                continue
        elif author.strip() and author.strip() not in ["佚名", "未知", "无名氏", "缺名", "阙名"] and author.strip() in gsw_author_map:
            # 标题微差，但同作者且内容为带序或残缺重复版
            is_dup = False
            for gsw_t, gsw_text in gsw_author_map[author.strip()]:
                if is_preface_or_truncated_duplicate(raw_text, gsw_text):
                    is_dup = True
                    break
            if is_dup:
                continue

        # 校准原库的冷门篇目文体（包含诗经归入「诗」）
        kind = ca_kind or guess_kind(title, author, raw_text)

        # 老库如果含有小序/序曰等前缀或序言终结句，安全切除
        if kind in ["诗", "词", "曲", "赋"] and len(cs) > 4:
            while cs and (cs[0].startswith("小序") or cs[0].startswith("序曰") or cs[0] == "序" or cs[0].startswith("并序") or cs[0].startswith("题记")):
                cs = cs[1:]
                ps = ps[1:]
            # 模式 B: 包含 命曰《...》 / 其辞曰 / 故作此词 / 作此篇 等序言结语
            cut_idx = -1
            for i in range(min(len(cs) - 3, 30)):
                if re.search(r'(?:命曰[《〈]|名曰[《〈]|其[辞词歌诗]曰|[辞词歌诗]曰|作此[篇词诗歌]|故作此|因作此|歌以赠之|为作此词)', cs[i]):
                    cut_idx = i
                    break
            if cut_idx != -1 and (len(cs) - cut_idx - 1) >= 4:
                cs = cs[cut_idx + 1:]
                ps = ps[cut_idx + 1:]
            if not cs:
                continue

        adj_prio = max(100, int(prio or 500))
        meta_poems.append([title, author, dynasty, kind, len(cs), adj_prio, ps])
        all_clauses.extend(cs)
        retained_old_poems += 1
        retained_old_clauses += len(cs)

    print(f"   融合完毕：保留原语料冷门覆盖 {retained_old_poems} 篇，{retained_old_clauses} 句")
    print(f"   全库总计: {len(meta_poems)} 篇，{len(all_clauses)} 句")

    # 4. 压缩写盘
    print("4. 正在压缩写入 data/clauses.txt.gz 与 data/poems.json.gz ...", flush=True)
    blob = "\n".join(all_clauses)
    with gzip.open(os.path.join(DATA, "clauses.txt.gz"), "wb", compresslevel=9) as f:
        f.write(blob.encode("utf-8"))

    with gzip.open(os.path.join(DATA, "poems.json.gz"), "wb", compresslevel=9) as f:
        f.write(json.dumps(meta_poems, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    # 5. 更新元数据
    kinds_stat = {}
    for p in meta_poems:
        kinds_stat[p[3]] = kinds_stat.get(p[3], 0) + 1

    total_chars = sum(len(c) for c in all_clauses)
    meta = {
        "built": time.strftime("%Y-%m-%d %H:%M"),
        "poems": len(meta_poems),
        "clauses": len(all_clauses),
        "chars": total_chars,
        "kinds": kinds_stat,
        "clauses_gz": os.path.getsize(os.path.join(DATA, "clauses.txt.gz")),
        "poems_gz": os.path.getsize(os.path.join(DATA, "poems.json.gz")),
        "secs": round(time.time() - t0, 1),
    }
    with open(os.path.join(DATA, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"\n全部完成！耗时: {meta['secs']} 秒")
    print(f"clauses.txt.gz: {meta['clauses_gz'] / 1048576:.2f} MB")
    print(f"poems.json.gz:   {meta['poems_gz'] / 1048576:.2f} MB")
    print("文体分布:", meta["kinds"])

if __name__ == "__main__":
    main()
