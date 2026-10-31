# -*- coding: utf-8 -*-
"""下载语料 → tools/.cache/src/（已存在则跳过）。

用 codeload 整包下载再挑文件，比逐文件 raw.githubusercontent 快一个数量级。
  A. chinese-poetry-zhCN  : 全唐诗 57k + 全宋诗 26 万（已简体）
  B. chinese-poetry       : 宋词 / 元曲 / 诗经 / 楚辞 / 五代 / 纳兰 / 曹操
  C. chinese-gushiwen     : 古文 10000 篇（含赋、骈文、散文），JSONL
"""
import os
import re
import sys
import tarfile
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
SRC = os.path.join(CACHE, "src")
os.makedirs(SRC, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 feihua-ol/1.0"}
PKGS = {
    "zhcn.tar.gz": "https://codeload.github.com/chinese-poetry/chinese-poetry-zhCN/tar.gz/refs/heads/master",
    "main.tar.gz": "https://codeload.github.com/chinese-poetry/chinese-poetry/tar.gz/refs/heads/master",
    "gsw.tar.gz": "https://codeload.github.com/aopao/chinese-gushiwen/tar.gz/refs/heads/master",
}


def download(name, url):
    dest = os.path.join(CACHE, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 100000:
        print("  %-14s 已存在 %.1f MB" % (name, os.path.getsize(dest) / 1048576), flush=True)
        return dest
    tmp = dest + ".part"
    print("  下载 %s …" % name, flush=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        while True:
            buf = r.read(1 << 18)
            if not buf:
                break
            f.write(buf)
    os.replace(tmp, dest)
    print("  %-14s %.1f MB" % (name, os.path.getsize(dest) / 1048576), flush=True)
    return dest


def extract(pkg, rules):
    """rules: [(正则, 目标文件名模板)]，模板里 {base} / {1} 可用。"""
    path = os.path.join(CACHE, pkg)
    n = 0
    with tarfile.open(path, "r:gz") as tf:
        for m in tf:
            if not m.isfile():
                continue
            for pat, tpl in rules:
                mm = re.search(pat, m.name)
                if not mm:
                    continue
                base = os.path.basename(m.name)
                g1 = mm.group(1) if mm.groups() else ""
                out = os.path.join(SRC, tpl.replace("{base}", base).replace("{1}", g1))
                if os.path.exists(out) and os.path.getsize(out) > 0:
                    break
                with open(out, "wb") as f:
                    f.write(tf.extractfile(m).read())
                n += 1
                break
    print("  %-14s 解出 %d 个文件" % (pkg, n), flush=True)


def main():
    for name, url in PKGS.items():
        download(name, url)

    extract("zhcn.tar.gz", [
        (r"/poet\.tang\.\d+\.json$", "zhcn/{base}"),
        (r"/poet\.song\.\d+\.json$", "zhcn/{base}"),
    ])
    extract("main.tar.gz", [
        (r"/宋词/ci\.song\.\d+\.json$", "ci_{base}"),
        (r"/宋词/宋词三百首\.json$", "songci300.json"),
        (r"/元曲/yuanqu\.json$", "yuanqu.json"),
        (r"/诗经/shijing\.json$", "shijing.json"),
        (r"/楚辞/chuci\.json$", "chuci.json"),
        (r"/曹操诗集/caocao\.json$", "caocao.json"),
        (r"/纳兰性德/[^/]+\.json$", "nalan.json"),
        (r"/五代诗词/nantang/poetrys\.json$", "nantang.json"),
        (r"/五代诗词/huajianji/(huajianji-[^/]+\.json)$", "huajian_{1}"),
    ])
    extract("gsw.tar.gz", [
        (r"/guwen/guwen\d+-\d+\.json$", "{base}"),
    ])
    print("完成，src 共 %d 个文件" % len(os.listdir(SRC)), flush=True)


if __name__ == "__main__":
    sys.exit(main())
