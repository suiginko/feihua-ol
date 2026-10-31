# -*- coding: utf-8 -*-
"""测试新的 guess_kind 分类算法在古诗文网数据库上的表现。"""
import gzip
import json
import re

CI_PAI = {
    "念奴娇", "水调歌头", "满江红", "菩萨蛮", "西江月", "浪淘沙", "临江仙", "虞美人",
    "卜算子", "浣溪沙", "清平乐", "鹧鸪天", "定风波", "鹊桥仙", "蝶恋花", "雨霖铃",
    "生查子", "点绛唇", "青玉案", "破阵子", "江城子", "如梦令", "相见欢", "醉花阴",
    "声声慢", "永遇乐", "贺新郎", "摸鱼儿", "渔家傲", "踏莎行", "南乡子", "长相思",
    "减字木兰花", "昭君怨", "诉衷情", "一剪梅", "八声甘州", "苏幕遮", "桂枝香",
    "望海潮", "摊破浣溪沙", "摊破丑奴儿", "木兰花", "玉楼春", "千秋岁", "御街行",
    "兰陵王", "六丑", "暗香", "疏影", "夜巡粮", "烛影摇红", "洞仙歌", "解语花"
}

WEN_KEYWORDS = ["记", "说", "序", "铭", "表", "论", "书", "传", "策", "箴", "谏", "疏", "辩", "辨", "解", "原", "议", "启", "赞", "志", "录"]
QU_KEYWORDS = ["天净沙", "山坡羊", "醉中天", "朝天子", "折桂令", "红绣鞋", "沉醉东风", "喜春来", "落梅风", "拨不断", "叨叨令", "寄生草", "散曲", "杂剧"]
CHU_CI = ["离骚", "九歌", "九章", "天问", "九辩", "招魂", "大招", "远游", "卜居", "渔父"]

def guess_kind(title, author, content):
    t = title or ""
    a = author or ""
    
    # 1. 赋优先
    if "赋" in t or (a in ["屈原", "宋玉"] and any(c in t for c in CHU_CI)):
        return "赋"
        
    # 2. 曲
    if any(q in t for q in QU_KEYWORDS):
        return "曲"
        
    # 3. 词
    for cp in CI_PAI:
        if cp in t:
            return "词"
    if "·" in t and not any(w in t for w in ["论语", "荀子", "孟子", "庄子", "列子", "韩非子", "墨子", "管子"]):
        return "词"
    if "词" in t or "曲子" in t:
        return "词"
        
    # 4. 文（散文/骈文/记/序/表/论等）
    for w in WEN_KEYWORDS:
        if t.endswith(w) or f"{w}·" in t or f"·{w}" in t or f"{w}并序" in t:
            return "文"
            
    if any(k in t for k in ["论语", "孟子", "庄子", "荀子", "史记", "战国策", "左传", "世说新语", "资治通鉴", "国语", "礼记", "尚书"]):
        return "文"
        
    # 根据小句句长统计：如果绝大多数都是五言七言，属于诗；否则长短错落的大段是文
    lines = [len(c.strip()) for c in re.split(r"[，。！？；：、\n]+", content) if 2 <= len(c.strip()) <= 40]
    if lines:
        reg_ratio = sum(1 for L in lines if L in [5, 7]) / len(lines)
        if reg_ratio < 0.35 and len(lines) >= 8:
            return "文"

    return "诗"

# 测试统计
f = gzip.open("tools/.cache/sources/gushiwen.json.gz", "rt", encoding="utf-8")
d = json.load(f)
stat = {}
for p in d:
    k = guess_kind(p.get("title", ""), p.get("author", ""), p.get("content", ""))
    stat[k] = stat.get(k, 0) + 1
print("文体分类分布:", stat)

# 抽查典型
samples = [
    ("赤壁赋", "苏轼"),
    ("滕王阁序", "王勃"),
    ("岳阳楼记", "范仲淹"),
    ("师说", "韩愈"),
    ("阿房宫赋", "杜牧"),
    ("念奴娇·赤壁怀古", "苏轼"),
    ("天净沙·秋思", "马致远"),
    ("登高", "杜甫"),
    ("离骚", "屈原"),
]
for t, a in samples:
    k = guess_kind(t, a, "")
    print(f"  《{t}》（{a}） -> {k}")
