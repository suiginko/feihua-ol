# -*- coding: utf-8 -*-
"""把原始语料清洗成服务端可直接加载的三件产物（data/ 下）：

  data/clauses.txt.gz   每行一个「句」，按诗篇顺序排列（同一首诗的句子连续）
  data/poems.json.gz    [[标题, 作者, 朝代, 文体, 句数], ...]  与 clauses 顺序一一对应
  data/meta.json        统计信息（句数、字数、各文体数量、构建时间）

清洗规则：
  1. 去掉校勘夹注：全角/半角括号里的「一作：…」「通：…」等内容
  2. 按标点切句
  3. 繁体 → 简体（zhconv，短语级），但 **乾 / 徵 例外**：这两个字在简体里仍然独立存在
     （乾坤、宫商角徵羽），无脑折叠会把「乾坤」变成「干坤」——这就是旧版误判的根因。
  4. **不去重**：同一句在多首诗里重复出现是常态（集句、化用、异文底本），
     从诗篇里删掉重复句会把整首诗打成筛子 —— 《饮湖上初晴后雨》就只剩前两句，
     《观书》丢了「胸次全无一点尘」，于是「欲把西湖比西子，淡妆浓抹总相宜」这种
     真句永远判不出来。出处不靠删除来保证，改由 judge.js 的 prio 打分挑最可信的一处
     （僧人转引垫底 → 朝代早者优先 → 诗>词>曲>赋>文，见 prio_of()）。
"""
import gzip
import json
import os
import re
import sys
import time

import zhconv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "tools", ".cache", "src")
OUT = os.path.join(ROOT, "data")

CJK = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FA5\u3007]")
SPLIT = re.compile(r"[^\u3400-\u4DBF\u4E00-\u9FA5\u3007]+")
PAREN = re.compile(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]")

# 简体里依然独立存在的繁体字：绝不能折叠
EXEMPT = {"乾": "\uE000", "徵": "\uE001"}
BACK = {v: k for k, v in EXEMPT.items()}

# 诗与词同级：名句常被宋人拟作抢先收录，同级时按语料顺序（选本、全唐在前）定出处
KIND_RANK = {"诗": 1, "词": 1, "曲": 2, "赋": 3, "文": 4}

# 朝代先后：同一句被后人转引时，原文多半更早。这是「落霞与孤鹜齐飞」这类
# 名句被释家偈颂抢走出处的解药（王勃·唐 早于 释普度·宋）。
DYNASTY_ORDER = {
    "先秦": 0, "周": 0, "西周": 0, "春秋": 0, "战国": 0,
    "秦": 1, "汉": 2, "两汉": 2, "汉代": 2, "东汉": 2, "西汉": 2,
    "三国": 3, "魏": 3, "蜀": 3, "吴": 3, "魏晋": 3, "晋": 3,
    "南北朝": 4, "南朝": 4, "北朝": 4, "宋（南朝）": 4,
    "隋": 5, "唐": 6, "唐代": 6, "唐朝": 6,
    "五代": 7, "五代十国": 7, "南唐": 7, "后蜀": 7,
    "宋": 8, "宋代": 8, "北宋": 8, "南宋": 8,
    "元": 9, "元代": 9, "yuan": 9,
    "明": 10, "明代": 10, "清": 11, "清代": 11, "近现代": 12, "当代": 12,
}
DYNASTY_MAX = 13


def to_simp(s):
    for k, v in EXEMPT.items():
        s = s.replace(k, v)
    s = zhconv.convert(s, "zh-cn")
    for v, k in BACK.items():
        s = s.replace(v, k)
    return s


def clauses_of(text):
    text = PAREN.sub("", text)
    text = to_simp(text)
    out = []
    for part in SPLIT.split(text):
        if 2 <= len(part) <= 40:
            out.append(part)
    return out


def texts_of(obj):
    for k in ("paragraphs", "para", "content", "clauses"):
        v = obj.get(k)
        if isinstance(v, list):
            return [x for x in v if isinstance(x, str)]
        if isinstance(v, str):
            return [v]
    return []


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return rows


def poem(title, author, dynasty, kind, text):
    return {
        "t": (title or "").strip() or "无题",
        "a": (author or "").strip() or "佚名",
        "d": dynasty or "",
        "k": kind,
        "x": text,
    }


def collect():
    """顺序很关键：同一句在多处出现时，去重按「先到先得」，所以把
    选本 / 全唐诗 排在前面，出处才给得对（否则名句会被宋人的拟作抢走）。"""
    poems = []

    # 1) 选本：宋词三百首
    path = os.path.join(SRC, "songci300.json")
    if os.path.exists(path):
        n = 0
        for p in read_json(path):
            ps = texts_of(p)
            if ps:
                poems.append(poem(p.get("rhythmic") or p.get("title"), p.get("author"), "宋", "词", "\n".join(ps)))
                n += 1
        print("  宋词三百首 %d 首" % n, flush=True)

    # 2) 全唐诗
    st = os.path.join(SRC, "zhcn")
    if os.path.isdir(st):
        n = 0
        for fn in sorted(f for f in os.listdir(st) if ".tang." in f):
            for p in read_json(os.path.join(st, fn)):
                ps = texts_of(p)
                if ps:
                    poems.append(poem(p.get("title"), p.get("author"), "唐", "诗", "\n".join(ps)))
                    n += 1
        print("  全唐诗 %d 首" % n, flush=True)

    # 3) 先秦汉魏
    simple = [
        ("shijing.json", "诗", "先秦"),
        ("chuci.json", "赋", "先秦"),
        ("caocao.json", "诗", "汉"),
    ]
    for fn, kind, dyn in simple:
        path = os.path.join(SRC, fn)
        if not os.path.exists(path):
            continue
        rows = read_json(path)
        if isinstance(rows, dict):
            rows = [rows]
        n = 0
        for p in rows:
            if not isinstance(p, dict):
                continue
            ps = texts_of(p)
            if not ps:
                continue
            poems.append(poem(p.get("title") or p.get("rhythmic") or p.get("chapter"),
                              p.get("author") or p.get("writer"),
                              p.get("dynasty") or dyn, kind, "\n".join(ps)))
            n += 1
        print("  %-14s %d 首" % (fn, n), flush=True)

    # 4) 全宋诗
    if os.path.isdir(st):
        n = 0
        for fn in sorted(f for f in os.listdir(st) if ".song." in f):
            for p in read_json(os.path.join(st, fn)):
                ps = texts_of(p)
                if ps:
                    poems.append(poem(p.get("title"), p.get("author"), "宋", "诗", "\n".join(ps)))
                    n += 1
        print("  全宋诗 %d 首" % n, flush=True)

    # 5) 宋词全集
    n = 0
    for fn in sorted(f for f in os.listdir(SRC) if f.startswith("ci_ci.song.") and f.endswith(".json")):
        for p in read_json(os.path.join(SRC, fn)):
            ps = texts_of(p)
            if ps:
                poems.append(poem(p.get("rhythmic") or p.get("title"), p.get("author"), "宋", "词", "\n".join(ps)))
                n += 1
    print("  全宋词 %d 首" % n, flush=True)

    # 6) 元曲 / 清词 / 五代
    for fn, kind, dyn in [("yuanqu.json", "曲", "元"), ("nalan.json", "词", "清"), ("nantang.json", "词", "五代")]:
        path = os.path.join(SRC, fn)
        if not os.path.exists(path):
            continue
        rows = read_json(path)
        if isinstance(rows, dict):
            rows = [rows]
        n = 0
        for p in rows:
            if not isinstance(p, dict):
                continue
            ps = texts_of(p)
            if not ps:
                continue
            poems.append(poem(p.get("title") or p.get("rhythmic") or p.get("chapter"),
                              p.get("author") or p.get("writer"),
                              p.get("dynasty") or dyn, kind, "\n".join(ps)))
            n += 1
        print("  %-14s %d 首" % (fn, n), flush=True)

    for fn in sorted(f for f in os.listdir(SRC) if f.startswith("huajian_")):
        rows = read_json(os.path.join(SRC, fn))
        for p in rows if isinstance(rows, list) else []:
            ps = texts_of(p)
            if ps:
                poems.append(poem(p.get("title"), p.get("author"), "五代", "词", "\n".join(ps)))
    print("  花间集 %d 首" % len([p for p in poems if p["d"] == "五代"]), flush=True)

    # 7) 古文 10000 篇（含赋、骈文、散文）
    nw = 0
    gfiles = sorted(f for f in os.listdir(SRC) if f.startswith("guwen") and f.endswith(".json"))
    for fn in gfiles:
        path = os.path.join(SRC, fn)
        for p in read_jsonl(path):
            ps = texts_of(p)
            if not ps:
                continue
            tags = p.get("type") or []
            if isinstance(tags, str):
                tags = [tags]
            title = p.get("title") or ""
            text = "\n".join(ps)
            poems.append(poem(title, p.get("writer"), p.get("dynasty"), guess_kind(title, tags, text, p.get("writer"), p.get("dynasty")), text))
            nw += 1
    print("  古文 %d 篇" % nw, flush=True)
    return poems


def build_t2s(path):
    """生成「单字繁→简」表给 Node 端用；乾/徵 例外（它们在简体里仍是独立字）。"""
    out = {}
    for cp in range(0x3400, 0xA000):
        ch = chr(cp)
        if ch in EXEMPT:
            continue
        s = zhconv.convert(ch, "zh-cn")
        if len(s) == 1 and s != ch and s not in BACK:
            out[ch] = s
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    print("繁简表 %d 字 → %s" % (len(out), path), flush=True)
    return len(out)


def dynasty_rank(d):
    d = (d or "").strip()
    if d in DYNASTY_ORDER:
        return DYNASTY_ORDER[d]
    for k, v in DYNASTY_ORDER.items():
        if k and k in d:
            return v
    return DYNASTY_MAX


def prio_of(p):
    """出处的可信度（越小越好）。同一句只保留一个出处，优先级靠这个键决定。

    1) 僧人偈頌/赞（作者以「释」开头）：这类文本里塞满了对前人名句的化用与直引，
       《达磨大师赞》就凭一个 4 字整句抢走了苏轼「大江东去」的出处 → 一律垫底。
    2) 朝代早的优先：原文早于转引，「落霞与孤鹜齐飞」因此归王勃而非宋人偈颂。
    3) 文体：诗=词 > 曲 > 赋 > 文（名句多出自诗词，引用标注也更自然）。
    返回一个可比较的整数，同时写进 poems 元数据给 Node 端排序用。
    """
    monk = 1 if (p["a"] or "").startswith(("释", "僧")) else 0
    return monk * 10000 + dynasty_rank(p["d"]) * 100 + KIND_RANK.get(p["k"], 9)


def guess_kind(title, tags, text, author=None, dynasty=None):
    """古文库里混着诗、词、曲、赋、散文。
    优化分类规则：
    1. 标题含「赋」或标签含「赋」-> 赋；
    2. 词牌名或「·」连接词作 -> 词；
    3. 散曲曲牌 -> 曲；
    4. 李贺存作、乐府诗歌体裁标识（歌/行/引/吟/操/篇/绝句/乐府等）或五七言主体 -> 诗；
    5. 其余散文 -> 文。"""
    title = title or ""
    tags_str = " ".join(str(t) for t in tags)
    if "赋" in title or "赋" in tags_str:
        return "赋"
    if author == "李贺":
        return "诗"

    CIPAI = (
        "水龙吟", "金缕曲", "满江红", "念奴娇", "菩萨蛮", "西江月", "浣溪沙", "鹧鸪天", "蝶恋花", "浪淘沙",
        "渔家傲", "临江仙", "定风波", "江城子", "虞美人", "卜算子", "青玉案", "清平乐", "忆江南", "长相思",
        "点绛唇", "南歌子", "生查子", "醉花阴", "声声慢", "雨霖铃", "六州歌头", "贺新郎", "踏莎行", "齐天乐",
        "摸鱼儿", "八声甘州", "高阳台", "木兰花", "天仙子", "风入松", "相见欢", "乌夜啼", "如梦令", "永遇乐",
        "暗香", "疏影", "双双燕", "柳梢青"
    )
    QUPAI = (
        "天净沙", "沉醉东风", "山坡羊", "折桂令", "清江引", "凭阑人", "寨儿令", "落梅风", "红绣鞋", "喜春来", "叨叨令"
    )
    POEM_KW = ("歌", "引", "吟", "行", "谣", "弄", "操", "调", "篇", "绝句", "律诗", "古风", "乐府", "竹枝词", "杨柳枝", "琴歌")
    PROSE_KW = ("序", "记", "传", "铭", "表", "碑", "书", "论", "赞", "说", "策", "箴", "辩", "戒", "题", "辨", "疏", "志", "跋")

    if any(q in title for q in QUPAI) or "曲" in tags_str or (dynasty == "元" and "·" in title):
        return "曲"
    if any(c in title for c in CIPAI) or "词" in tags_str or ("·" in title and not any(k in title for k in PROSE_KW)):
        return "词"
    if (any(k in title for k in POEM_KW) or ("诗" in title and "集序" not in title)) and not any(k in title for k in PROSE_KW):
        return "诗"

    cs = [c for c in clauses_of(text) if len(c) >= 4]
    if not cs:
        return "文"
    if all(len(c) == 5 for c in cs) or all(len(c) == 7 for c in cs):
        return "诗"
    if sum(1 for c in cs if len(c) in (5, 7)) >= 0.8 * len(cs):
        return "诗"
    return "文"


def main():
    os.makedirs(OUT, exist_ok=True)
    build_t2s(os.path.join(OUT, "t2s.json"))
    t0 = time.time()
    print("收集语料…", flush=True)
    poems = collect()
    print("合计 %d 篇，开始切句去重…" % len(poems), flush=True)

    order = []
    poem_lines = []
    for idx, p in enumerate(poems):
        cs = clauses_of(p["x"])
        for c in cs:
            order.append((c, idx))
        poem_lines.append(len(cs))

    total_chars = sum(len(c) for c, _ in order)
    print("切句完成 %d 条，总字数 %d（%.1f MB 原文）" % (len(order), total_chars, total_chars * 3 / 1048576), flush=True)

    blob = "\n".join(c for c, _ in order)
    # 必须走二进制写：Windows 下文本模式会把 \n 翻成 \r\n，整张语料表就废了
    with gzip.open(os.path.join(OUT, "clauses.txt.gz"), "wb", compresslevel=9) as fh:
        fh.write(blob.encode("utf-8"))

    # 第 6 列是出处可信度（越小越好），judge.js 用它给「片段命中」挑出处
    meta_poems = [[p["t"], p["a"], p["d"], p["k"], poem_lines[i], prio_of(p)] for i, p in enumerate(poems)]
    with gzip.open(os.path.join(OUT, "poems.json.gz"), "wb", compresslevel=9) as fh:
        fh.write(json.dumps(meta_poems, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

    kinds = {}
    for p in poems:
        kinds[p["k"]] = kinds.get(p["k"], 0) + 1
    meta = {
        "built": time.strftime("%Y-%m-%d %H:%M"),
        "poems": len(meta_poems),
        "clauses": len(order),
        "chars": total_chars,
        "kinds": kinds,
        "clauses_gz": os.path.getsize(os.path.join(OUT, "clauses.txt.gz")),
        "poems_gz": os.path.getsize(os.path.join(OUT, "poems.json.gz")),
        "secs": round(time.time() - t0, 1),
    }
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
