#!/usr/bin/env python3
"""把 app/ 里「该发布的那一份」组装到发布目录（任务 9 的构建步骤）。

为什么需要这一步，而不是直接发布 app/：
  1. app/ 里有一次性验证件（_verify_stats.html、_verify_stats_ui.html、
     _verify_shots/），它们不该出现在公网上（验证台带「连真实库探针」按钮、
     截图是内部页面的画面）。发布工具会把整个目录压缩上传，不做这种筛选。
  2. 发布要求「源码就是唯一真源」这条不变：本脚本只做**挑选与复制**，
     不修改任何被复制的文件内容 —— 发布件与 app/ 逐字节一致（本脚本会自查）。

⚠️ 与 tools/push-to-github.py 的关键差别（两条流水线，别混用）：
  · push-to-github.py  → 公开**仓库**，**必须脱敏**（publishableKey 换成占位符）。
  · 本脚本            → 公开**运行的应用**，**保留真 key**。
    因为 app 是纯前端 + 云端 SDK：浏览器要直接连库，key 必须在页面里；
    分享链接（/s/令牌）要让**收到链接的人**也能读库，所以也不存在
    「只有所有者持有 key」的方案。这是产品架构决定的，不是疏忽。
    代价见 AGENTS.md 第 10 节：库的 RLS 是 anon 全开（R-1），
    拿到 key 即可读写全库；**撤销发布不会收回 key**。

用法：
    python3 tools/build-deploy.py                 # 组装 + 自查
    python3 tools/build-deploy.py --out DIR       # 指定输出目录
"""
import argparse
import hashlib
import os
import shutil
import sys

SRC_APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app")
DEFAULT_OUT = os.path.expanduser("~/Documents/Elangit-部署")

# 发布件就是 app/ 减去这些（前缀匹配，按路径段判断，子目录里的同类也要挡住）
# `_demo_` 是 2026-09-23 加的：首页重构的视觉 Demo（`app/_demo_home.html` 与
# `app/_demo_home_dock.png`）。原来以为「文件名以下划线开头」就会被排除 —— 不是，
# 这条规则只认字面前缀，实测空跑时这两个文件**确实进了发布件**（封面 2.66MB）。
# 教训：排除规则只认它写死的那几个前缀，别按「下划线开头」推断。
EXCLUDE_PREFIX = ("_verify_", "_demo_")
EXCLUDE_DIR_NAME = ("_verify_shots",)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect():
    """返回 [(相对路径, 绝对路径)]，已排除验证件。"""
    picked = []
    for root, dirs, files in os.walk(SRC_APP):
        dirs[:] = [d for d in dirs if not d.startswith(EXCLUDE_PREFIX)
                   and d not in EXCLUDE_DIR_NAME]
        for name in files:
            if name.startswith(EXCLUDE_PREFIX) or name in (".DS_Store",):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, SRC_APP)
            if any(part.startswith(EXCLUDE_PREFIX) for part in rel.split(os.sep)):
                continue
            picked.append((rel, full))
    picked.sort()
    return picked


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    # 防呆：绝不许把输出目录指向源码目录或它的父级
    if out == SRC_APP or SRC_APP.startswith(out + os.sep):
        print("拒绝：输出目录不能包含源码目录 %s" % SRC_APP)
        return 2

    picked = collect()
    if not picked:
        print("没找到任何文件，检查 SRC_APP 是否正确：%s" % SRC_APP)
        return 2

    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)

    print("组装发布件 → %s\n" % out)
    total = 0
    for rel, full in picked:
        dst = os.path.join(out, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(full, dst)
        size = os.path.getsize(full)
        total += size
        print("  %-28s %7d B" % (rel, size))
    print("\n共 %d 个文件，%.1f KB" % (len(picked), total / 1024))

    # ---- 自查 1：逐字节一致（发布件 == app/ 的同一份，未被改动）----
    bad = [rel for rel, full in picked
           if sha256(os.path.join(out, rel)) != sha256(full)]
    print("\n自查① 发布件与 app/ 逐字节一致：%s"
          % ("通过（%d 个文件）" % len(picked) if not bad else "失败 → %s" % bad))

    # ---- 自查 2：验证件没有混进来 ----
    leaked = []
    for root, dirs, files in os.walk(out):
        for name in files + dirs:
            if name.startswith(EXCLUDE_PREFIX) or name in EXCLUDE_DIR_NAME:
                leaked.append(os.path.relpath(os.path.join(root, name), out))
    print("自查② 验证件未混入：%s" % ("通过（0 个）" if not leaked else "失败 → %s" % leaked))

    # ---- 自查 3：key 仍在（这条流水线**要求**保留，脱敏了应用就跑不起来）----
    cfg = os.path.join(out, "config.js")
    has_key = os.path.isfile(cfg) and "wbpk_" in open(cfg, encoding="utf-8").read()
    print("自查③ config.js 保留真 publishableKey：%s"
          % ("是（本流水线要求如此）" if has_key else "否 —— 应用会连不上库，检查是不是误用了脱敏版"))

    print("\n启动命令（平台会给 PORT）：python3 _serve.py")
    print("⚠ 这份发布件里的 key 一旦上线即视为已公开，且**撤销发布不会收回它**。")

    if bad or leaked:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
