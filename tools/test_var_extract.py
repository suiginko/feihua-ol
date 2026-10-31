# -*- coding: utf-8 -*-
"""测试异文展开算法与带标点切句逻辑。"""
import re

PAREN_VAR = re.compile(r"[（(]([\u4e00-\u9fa5]+)\s*(?:一作|同)[：:]\s*([\u4e00-\u9fa5]+)[)）]")

def clean_html(text):
    text = re.sub(r"<[^>]+>", "\n", text)
    text = text.replace("&nbsp;", " ").replace("&emsp;", " ")
    return text

def extract_variants(text):
    """从包含 '(A 一作：B)' 的文本中，提取主版本文本和替换后的异文版本文本列表。"""
    text = clean_html(text)
    # 查找所有异文标记
    matches = list(PAREN_VAR.finditer(text))
    if not matches:
        # 没有异文标记，清理掉普通括号注释后返回原样
        cleaned = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", text)
        return [cleaned]

    # 版本 1：主文本（直接删除所有括号异文注）
    base_text = PAREN_VAR.sub("", text)
    base_text = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", base_text)
    results = [base_text]

    # 版本 2：异文版本（将 A 替换为 B）
    # 对每个匹配项，尝试生成替换版本
    var_text = text
    for m in reversed(matches):
        orig_word = m.group(1)
        alt_word = m.group(2)
        span_start = m.start()
        span_end = m.end()
        # 往前找 orig_word
        pre_ctx = var_text[:span_start]
        idx = pre_ctx.rfind(orig_word)
        if idx != -1 and (span_start - idx - len(orig_word)) <= 15:
            # 找到紧邻的前文，替换为 alt_word，并删掉括号
            var_text = var_text[:idx] + alt_word + var_text[idx + len(orig_word):span_start] + var_text[span_end:]
        else:
            var_text = var_text[:span_start] + var_text[span_end:]

    var_text = re.sub(r"[（(〔\[][^（()）〔〕\[\]]*[)）〕\]]", "", var_text)
    if var_text != base_text:
        results.append(var_text)
    return results

# 典型测试
sample = "大江东去，浪淘尽，千古风流人物。故垒西边，人道是，三国周郎赤壁。乱石穿空，惊涛拍岸，卷起千堆雪。(穿空 一作：崩云)江山如画，一时多少豪杰。遥想公瑾当年，小乔初嫁了，雄姿英发。羽扇纶巾，谈笑间，樯橹灰飞烟灭。(樯橹 一作：强虏)故国神游，多情应笑我，早生华发。人生如梦，一尊还酹江月。(人生 一作：人间；尊 同：樽)"

variants = extract_variants(sample)
print("展开版本数:", len(variants))
print("\n[版本 1 - 通行本]:")
print(variants[0])
print("\n[版本 2 - 异文本]:")
print(variants[1])

print("\n包含樯橹?", "樯橹灰飞烟灭" in variants[0])
print("包含强虏?", "强虏灰飞烟灭" in variants[1])
print("包含崩云?", "乱石崩云" in variants[1])
