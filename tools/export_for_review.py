# -*- coding: utf-8 -*-
"""将飞花令全量数据库导出为人类可读文本到独立文件夹 export_review/ 中，
方便用户按分类、按朝代、按名篇与版本异文进行详尽审阅。
"""
import gzip
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
OUT_DIR = os.path.join(ROOT, "export_review")

def main():
    t0 = time.time()
    print("=" * 60)
    print("开始导出当前数据库为审阅文本...")
    print("=" * 60)

    os.makedirs(OUT_DIR, exist_ok=True)

    print("1. 正在加载 data/clauses.txt.gz 与 data/poems.json.gz ...", flush=True)
    with gzip.open(os.path.join(DATA, "clauses.txt.gz"), "rt", encoding="utf-8") as f:
        clauses = f.read().split("\n")
    with gzip.open(os.path.join(DATA, "poems.json.gz"), "rt", encoding="utf-8") as f:
        poems = json.load(f)

    total_poems = len(poems)
    total_clauses = len(clauses)
    print(f"   共 {total_poems} 篇，{total_clauses} 小句")

    # 准备文件句柄
    # 1. 异文与精选对照
    f_var = open(os.path.join(OUT_DIR, "01_精选名篇与版本异文_对照审阅.txt"), "w", encoding="utf-8")
    # 2. 文体分卷
    f_wen = open(os.path.join(OUT_DIR, "02_文_散文骈文史传.txt"), "w", encoding="utf-8")
    f_fu = open(os.path.join(OUT_DIR, "03_赋_辞赋骈赋名篇.txt"), "w", encoding="utf-8")
    f_qu = open(os.path.join(OUT_DIR, "04_曲_散曲套数名篇.txt"), "w", encoding="utf-8")
    f_ci = open(os.path.join(OUT_DIR, "05_词_宋词词牌名篇.txt"), "w", encoding="utf-8")

    # 诗分朝代子目录
    shi_dir = os.path.join(OUT_DIR, "06_诗_各朝代分卷")
    os.makedirs(shi_dir, exist_ok=True)
    f_shi_early = open(os.path.join(shi_dir, "诗_01_先秦汉魏晋南北朝.txt"), "w", encoding="utf-8")
    f_shi_tang = open(os.path.join(shi_dir, "诗_02_唐代.txt"), "w", encoding="utf-8")
    f_shi_song = open(os.path.join(shi_dir, "诗_03_宋代.txt"), "w", encoding="utf-8")
    f_shi_late = open(os.path.join(shi_dir, "诗_04_金元明清现代.txt"), "w", encoding="utf-8")

    # 全量单行总表（方便全库关键字检索）
    f_full_lines = open(os.path.join(OUT_DIR, "全库一览_一行一篇_可全局检索.txt"), "w", encoding="utf-8")

    # 识别带异文版本的标题集合，把异文版和对应的正本都写入 f_var
    var_titles = set()
    for p in poems:
        if "(异文版)" in p[0]:
            base_t = p[0].replace("(异文版)", "")
            var_titles.add(base_t)
            var_titles.add(p[0])

    print("2. 正在还原诗篇全文并分卷写盘...", flush=True)

    idx = 0
    counts = {
        "var": 0, "wen": 0, "fu": 0, "qu": 0, "ci": 0,
        "shi_early": 0, "shi_tang": 0, "shi_song": 0, "shi_late": 0
    }

    for p in poems:
        title, author, dynasty, kind, cnt, prio = p[:6]
        ps = p[6] if len(p) > 6 else ""
        cs = clauses[idx : idx + cnt]
        idx += cnt

        # 组装还原带标点的自然诗文（标点若省略则按默认交替推导）
        parts = []
        for i in range(cnt):
            pch = ps[i] if i < len(ps) else ("。" if i % 2 == 1 else "，")
            parts.append(cs[i] + pch)
        full_text = "".join(parts)

        # 写入全库单行检索表
        f_full_lines.write(f"【{title}】\t{author}\t{dynasty}\t{kind}\t{full_text}\n")

        # 格式化人类可读段落
        entry = (
            f"【标题】{title}\n"
            f"【作者】{author}    【朝代】{dynasty}    【文体】{kind}\n"
            f"【正文】{full_text}\n"
            f"{'-' * 60}\n"
        )

        # 1. 异文对照
        if title in var_titles or "(异文版)" in title:
            f_var.write(entry)
            counts["var"] += 1

        # 2. 按文体分发
        if kind == "文":
            f_wen.write(entry)
            counts["wen"] += 1
        elif kind == "赋":
            f_fu.write(entry)
            counts["fu"] += 1
        elif kind == "曲":
            f_qu.write(entry)
            counts["qu"] += 1
        elif kind == "词":
            f_ci.write(entry)
            counts["ci"] += 1
        else:
            # 诗：按朝代细分
            if dynasty in ["先秦", "汉", "两汉", "魏晋", "南北朝", "南北", "隋"]:
                f_shi_early.write(entry)
                counts["shi_early"] += 1
            elif dynasty == "唐":
                f_shi_tang.write(entry)
                counts["shi_tang"] += 1
            elif dynasty == "宋":
                f_shi_song.write(entry)
                counts["shi_song"] += 1
            else:
                f_shi_late.write(entry)
                counts["shi_late"] += 1

    # 关闭文件
    f_var.close()
    f_wen.close()
    f_fu.close()
    f_qu.close()
    f_ci.close()
    f_shi_early.close()
    f_shi_tang.close()
    f_shi_song.close()
    f_shi_late.close()
    f_full_lines.close()

    # 3. 编写审阅说明文档
    readme_content = f"""# 飞花令数据库审阅目录说明 (export_review)

导出时间：{time.strftime("%Y-%m-%d %H:%M:%S")}
全库统计：共 {total_poems} 篇，{total_clauses} 小句，文体包括诗、词、曲、赋、文五大类。

## 一、文件结构与说明

1. 01_精选名篇与版本异文_对照审阅.txt ({counts['var']} 篇)
   - 包含展开异文的名篇及其对应通行本（如《念奴娇·赤壁怀古》与异文版、《木兰花》与异文版、《静夜思》通行本与全唐诗底本对照等）。
   - 重点审阅：通篇文字替换是否自然、标点切分是否准确。

2. 02_文_散文骈文史传.txt ({counts['wen']} 篇)
   - 包含先秦诸子百家散文（《逍遥游》《劝学》《师说》《出师表》等）、史传（《鸿门宴》《廉颇蔺相如列传》）及唐宋八大家散文（《岳阳楼记》《滕王阁序》等）。
   - 已剔除南戏戏文大剧本。

3. 03_赋_辞赋骈赋名篇.txt ({counts['fu']} 篇)
   - 包含辞赋名篇（如《赤壁赋》《阿房宫赋》《登楼赋》《洛神赋》《秋声赋》等）。
   - 重复《三都赋》长篇副本已合并。

4. 04_曲_散曲套数名篇.txt ({counts['qu']} 篇)
   - 包含马致远《天净沙·秋思》、关汉卿等元散曲、套数名作，已彻底剔除元杂剧剧本。

5. 05_词_宋词词牌名篇.txt ({counts['ci']} 篇)
   - 包含全部宋词词牌名作（《念奴娇》《水调歌头》《满江红》《雨霖铃》等）。

6. 06_诗_各朝代分卷/
   - 诗_01_先秦汉魏晋南北朝.txt ({counts['shi_early']} 篇)：《诗经》《楚辞》、汉魏乐府及曹操经典名篇（作者均已确认为曹操，南北朝名称已纠正）。
   - 诗_02_唐代.txt ({counts['shi_tang']} 篇)：全唐诗精华与唐绝句律诗。
   - 诗_03_宋代.txt ({counts['shi_song']} 篇)：全宋诗浩瀚库藏。
   - 诗_04_金元明清现代.txt ({counts['shi_late']} 篇)：元明清近现代诗作（朝代已统一为单字元、明、清）。

7. 全库一览_一行一篇_可全局检索.txt
   - 全库 {total_poems} 篇的一行式汇总（标题\\t作者\\t朝代\\t文体\\t带标点全文）。
   - 可在任何文本编辑器中按 Ctrl+F 瞬间检索任何诗句或诗人。

## 二、最新完成的优化与修复清单

- [x] 朝代名称规范：「南北」已全面纠正为标准「南北朝」，唐宋元明清统一单字。
- [x] 剧本类长文彻底剔除：去除了 180 部元杂剧剧本及 8 部南戏戏文大剧本（《荆钗记》《琵琶记》等），减负 27 万小句。
- [x] 重复长赋清理：左思《三都赋》等重复大赋副本已合并去重。
- [x] 异文对扩充与副本合并：VAR_PAIRS 扩充了 33 组正字法与版本用字（如剪/翦、虾/蛤、缘/姻等），安全消减 4,500+ 篇冗余副本。
- [x] 多情应笑我 早生华发：已修复为标准切分，杜绝「多情应笑 / 我早生华发」。
- [x] 曹操诗作归属：汉乐府经典名篇（《短歌行》《观沧海》《龟虽寿》等）作者确认为「曹操」，文体归为「诗」。
- [x] 楚辞归属：屈原、宋玉及《离骚》《九歌》《天问》等已归入「诗」。
"""

    with open(os.path.join(OUT_DIR, "README_审阅说明.txt"), "w", encoding="utf-8") as f:
        f.write(readme_content)

    print(f"\n导出完成！耗时: {round(time.time() - t0, 1)} 秒")
    print(f"输出目录: {OUT_DIR}")
    for k, v in counts.items():
        print(f"   {k}: {v} 篇")

if __name__ == "__main__":
    main()
