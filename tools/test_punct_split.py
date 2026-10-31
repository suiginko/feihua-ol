# -*- coding: utf-8 -*-
import re

PUNCT_SPLIT = re.compile(r"([，。！？；：、\n\r]+)")
CJK_CHAR = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FA5\u3007]")

def split_clauses_with_puncts(text):
    parts = PUNCT_SPLIT.split(text)
    clauses = []
    puncts = []
    for i in range(0, len(parts), 2):
        raw_c = parts[i].strip()
        clean_c = "".join(CJK_CHAR.findall(raw_c))
        if len(clean_c) < 2 or len(clean_c) > 40:
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

text = "大江东去，浪淘尽，千古风流人物。故垒西边，人道是，三国周郎赤壁。乱石穿空，惊涛拍岸，卷起千堆雪。江山如画，一时多少豪杰！"
cs, ps = split_clauses_with_puncts(text)
for c, p in zip(cs, ps):
    print(f"  {c} -> {p}")
print("标点串:", ps)
