# -*- coding: utf-8 -*-
"""从原主持台 HTML 里导出字库常量 → data/chars.js

主持台的 300 字池是按《全唐诗》字频统计出来的，OL 版沿用同一套，
这样两个版本的棋盘手感一致。额外字池的权重也一并搬过来。
"""
import json
import os
import re

OLD = r"C:\Users\Hg\WorkBuddy\2026-10-16-20-18-16\飞花斯普拉遁-主持台.html"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def grab(src, name):
    """常量可能是多段字符串用 + 拼接的，取到分号为止再把所有字面量接起来。"""
    m = re.search(name + r"\s*=\s*([\s\S]*?);", src)
    if not m:
        raise SystemExit("找不到 " + name)
    parts = re.findall(r'"([^"]*)"', m.group(1))
    return "".join(parts)


def main():
    with open(OLD, encoding="utf-8") as fh:
        src = fh.read()
    pool = grab(src, "var POOL_STR")
    extra = grab(src, "var EXTRA_STR")
    wt = grab(src, "var EXTRA_WT_STR")
    weights = [int(x) for x in re.split(r"[,\s]+", wt) if x.strip()]
    assert len(pool) == 300, len(pool)
    assert len(extra) == len(weights), (len(extra), len(weights))

    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "chars.js")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("// 由 tools/export_chars.py 生成，勿手改（源：飞花斯普拉遁-主持台.html）\n")
        fh.write("module.exports = {\n")
        fh.write('  POOL: %s,\n' % json.dumps(pool, ensure_ascii=False))
        fh.write('  EXTRA: %s,\n' % json.dumps(extra, ensure_ascii=False))
        fh.write("  EXTRA_WT: [%s]\n" % ",".join(str(w) for w in weights))
        fh.write("};\n")
    print("pool=%d extra=%d → %s" % (len(pool), len(extra), path))


if __name__ == "__main__":
    main()
