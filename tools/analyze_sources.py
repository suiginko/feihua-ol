# -*- coding: utf-8 -*-
"""分析已下载的古诗文网全量数据库及课标数据库。
重点分析：
1. 数据结构与规模统计（首数、朝代分布）
2. 经典异文版本收录情况（「樯橹」vs「强虏」、「天生我材」vs「天生吾徒」、「浑不怕」vs「全不怕」等）
3. 注释/译文/校勘中是否含有版本差异提示
4. 与现有语料库的互补性
"""
import gzip
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
SOURCES = os.path.join(CACHE, "sources")

def analyze_gushiwen():
    gz_path = os.path.join(SOURCES, "gushiwen.json.gz")
    if not os.path.exists(gz_path):
        print(f"未找到 {gz_path}")
        return

    print("=" * 60)
    print("正在解压并分析古诗文网全量数据库 (gushiwen.json.gz)...")
    print("=" * 60)

    with gzip.open(gz_path, "rt", encoding="utf-8") as f:
        data = json.load(f)

    total_poems = len(data)
    print(f"1. 总篇数: {total_poems} 篇")

    # 字段展示
    sample = data[0] if data else {}
    print(f"2. 记录字段: {list(sample.keys())}")
    
    # 朝代分布统计
    dynasties = {}
    has_sons = 0
    for p in data:
        dyn = p.get("dynasty", "未知").strip() or "未知"
        dynasties[dyn] = dynasties.get(dyn, 0) + 1
        if p.get("sons"):
            has_sons += 1

    print("\n3. 朝代分布（前 12 大朝代）:")
    sorted_dyn = sorted(dynasties.items(), key=lambda x: x[1], reverse=True)
    for dyn, count in sorted_dyn[:12]:
        pct = count / total_poems * 100
        print(f"   {dyn:8s}: {count:6d} 首 ({pct:.1f}%)")

    print(f"\n4. 包含鉴赏/注释/出处详情 (sons) 的篇目数: {has_sons} 篇 ({has_sons / total_poems * 100:.1f}%)")

    # 经典名句版本检索分析
    print("\n" + "=" * 60)
    print("5. 典型版本异文专项检索:")
    print("=" * 60)

    test_queries = [
        ("樯橹灰飞烟灭", "强虏灰飞烟灭", "苏轼·念奴娇·赤壁怀古"),
        ("天生我材必有用", "天生吾徒有俊才", "李白·将进酒"),
        ("粉骨碎身浑不怕", "粉骨碎身全不怕", "于谦·石灰吟"),
        ("起舞弄清影", "起舞弄倩影", "苏轼·水调歌头"),
        ("一骑红尘妃子笑", "一骑红尘妃子嗔", "杜牧·过华清宫"),
        ("同是天涯沦落人", "共是天涯沦落人", "白居易·琵琶行"),
    ]

    for ver_a, ver_b, title_desc in test_queries:
        hits_a = []
        hits_b = []
        for p in data:
            c = p.get("content", "")
            if ver_a in c:
                hits_a.append(p)
            if ver_b in c:
                hits_b.append(p)

        print(f"\n【{title_desc}】:")
        print(f"   版本 A「{ver_a}」: 命中了 {len(hits_a)} 篇")
        for h in hits_a[:2]:
            print(f"      - {h.get('author')}《{h.get('title')}》（{h.get('dynasty')}）")
            # 打印包含该句的前后上下文
            content = h.get("content", "")
            idx = content.find(ver_a)
            ctx = content[max(0, idx - 10): min(len(content), idx + len(ver_a) + 10)].replace("\n", " ")
            print(f"        正文片段: ...{ctx}...")

        print(f"   版本 B「{ver_b}」: 命中了 {len(hits_b)} 篇")
        for h in hits_b[:2]:
            print(f"      - {h.get('author')}《{h.get('title')}》（{h.get('dynasty')}）")
            content = h.get("content", "")
            idx = content.find(ver_b)
            ctx = content[max(0, idx - 10): min(len(content), idx + len(ver_b) + 10)].replace("\n", " ")
            print(f"        正文片段: ...{ctx}...")

    # 深入查看《念奴娇·赤壁怀古》的详细记录
    print("\n" + "=" * 60)
    print("6. 深入查看《念奴娇·赤壁怀古》在古诗文网库中的完整记录与注释:")
    print("=" * 60)
    for p in data:
        if "赤壁怀古" in p.get("title", "") and "苏轼" in p.get("author", ""):
            print(f"标题: {p.get('title')}")
            print(f"作者: {p.get('author')} ({p.get('dynasty')})")
            print(f"正文: {p.get('content')}")
            sons = p.get("sons", [])
            print(f"关联注释/鉴赏条数: {len(sons)}")
            # 检查注释里是否有提异文
            for s in sons:
                stitle = s.get("title", "") if isinstance(s, dict) else ""
                scontent = s.get("content", "") if isinstance(s, dict) else str(s)
                if "樯橹" in scontent or "强虏" in scontent or "一作" in scontent:
                    print(f"   [注释条目] {stitle}")
                    # 摘录提及一作/异文的部分
                    for line in scontent.split("\n"):
                        if any(w in line for w in ["樯橹", "强虏", "一作"]):
                            print(f"     > {line[:120]}")
            break

def analyze_gaokao():
    p_path = os.path.join(SOURCES, "gaokao_poetry.json")
    if not os.path.exists(p_path):
        return
    print("\n" + "=" * 60)
    print("7. 分析高考/新课标必背篇目 (gaokao_poetry.json):")
    print("=" * 60)
    with open(p_path, "r", encoding="utf-8") as f:
        gdata = json.load(f)
    print(f"篇数: {len(gdata)} 篇")
    for p in gdata:
        if "赤壁" in p.get("title", "") or "念奴娇" in p.get("title", ""):
            print(f"篇目: 《{p.get('title')}》 作者: {p.get('author')}")
            c = p.get("content", "")
            if "樯橹" in c:
                print("  正文包含: 樯橹灰飞烟灭")
            if "强虏" in c:
                print("  正文包含: 强虏灰飞烟灭")

if __name__ == "__main__":
    analyze_gushiwen()
    analyze_gaokao()
