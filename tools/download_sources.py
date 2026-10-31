# -*- coding: utf-8 -*-
"""下载备选高质量诗词数据库到 tools/.cache/sources/ 以便对比分析。
包含：
1. 古诗文网 10.8 万首全量数据库 (gushiwen.json.gz, ~49.7MB)
2. 高考/课标精校必背诗文 (gaokao_poetry.json)
"""
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache")
OUT = os.path.join(CACHE, "sources")
os.makedirs(OUT, exist_ok=True)

SOURCES = [
    {
        "name": "gushiwen.json.gz",
        "desc": "古诗文网 10.8 万首全量精校库",
        "url": "https://raw.githubusercontent.com/yht050511/gushiwen/main/gushiwen.json.gz",
        "expected_mb": 49.7,
    },
    {
        "name": "gaokao_poetry.json",
        "desc": "高考与新课标必背 60 篇精校篇目",
        "url": "https://raw.githubusercontent.com/clover-tree/gaokao-poetry/master/poetry.json",
        "expected_mb": 0.2,
    },
    {
        "name": "gaokao_sentences.json",
        "desc": "高考与新课标逐句切分版本",
        "url": "https://raw.githubusercontent.com/clover-tree/gaokao-poetry/master/sentences.json",
        "expected_mb": 0.3,
    }
]

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

def download_file(item):
    dest = os.path.join(OUT, item["name"])
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        sz_mb = os.path.getsize(dest) / 1048576
        print(f"[已存在] {item['desc']} ({item['name']}) - 大小: {sz_mb:.2f} MB")
        return dest

    print(f"[开始下载] {item['desc']} ({item['name']}) -> {item['url']}")
    tmp = dest + ".tmp"
    req = urllib.request.Request(item["url"], headers=UA)
    
    t0 = time.time()
    last_print = t0
    downloaded = 0
    with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
        total = resp.headers.get("Content-Length")
        total = int(total) if total and total.isdigit() else 0
        while True:
            chunk = resp.read(1 << 19) # 512 KB
            if not chunk:
                break
            f.write(chunk)
            downloaded += len(chunk)
            now = time.time()
            if now - last_print > 1.5:
                last_print = now
                if total > 0:
                    pct = downloaded / total * 100
                    print(f"  下载中: {downloaded / 1048576:.1f} MB / {total / 1048576:.1f} MB ({pct:.1f}%) ...", flush=True)
                else:
                    print(f"  下载中: {downloaded / 1048576:.1f} MB ...", flush=True)
                    
    os.replace(tmp, dest)
    total_mb = os.path.getsize(dest) / 1048576
    cost = time.time() - t0
    print(f"[下载完成] {item['name']} - 大小: {total_mb:.2f} MB, 耗时: {cost:.1f}s\n", flush=True)
    return dest

def main():
    print("=" * 60)
    print("开始下载备选诗词数据库源...")
    print("=" * 60)
    for s in SOURCES:
        try:
            download_file(s)
        except Exception as e:
            print(f"[下载失败] {s['name']}: {e}\n", flush=True)

if __name__ == "__main__":
    main()
