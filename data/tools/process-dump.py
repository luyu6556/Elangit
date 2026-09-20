#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 _verify_dump.html 导出的 JSON 加工成可读、可还原的数据目录。

产出（全部写进 data/）：
  dump.sql            全库 7 张表的 INSERT（含 id，用 OVERRIDING SYSTEM VALUE 保号）
  items.json          素材的文本字段（不含图片 base64 与封面缩略图，给人/agent 读）
  images/             从 item_images.data_base64 解出来的真实图片文件
  images/_manifest.csv 图片清单（item_id, seq, 尺寸, 字节数, 对应文件）
"""
import base64
import binascii
import csv
import json
import os
import re

DATA_DIR = "/Users/luyu/Documents/Elan git/data"
DUMP = os.path.join(DATA_DIR, "elangit-dump.json")

# 依赖顺序：被引用的表先写（tags.group_id -> tag_groups；item_images.item_id -> items）
WRITE_ORDER = ["categories", "tag_groups", "tags", "settings", "items", "item_images", "events"]

# 有 identity 主键的表（必须 OVERRIDING SYSTEM VALUE 才能写死 id）
IDENTITY = {"categories", "tag_groups", "tags", "items", "item_images", "events"}

# 列类型（来自 information_schema，用于生成正确的 SQL 字面量）
TYPES = {
    "categories": {"id": "int", "user_id": "text", "name": "text", "is_fallback": "bool",
                   "sort_order": "int", "created_at": "ts"},
    "tag_groups": {"id": "int", "user_id": "text", "name": "text", "color": "text",
                   "sort_order": "int", "created_at": "ts", "bg_color": "text"},
    "tags": {"id": "int", "user_id": "text", "name": "text", "group_id": "int", "created_at": "ts"},
    "settings": {"id": "int", "share_enabled": "bool", "share_token": "text", "updated_at": "ts"},
    "items": {"id": "int", "user_id": "text", "source_type": "text", "raw_text": "text",
              "source_platform": "text", "source_url": "text", "ai_summary": "text",
              "ai_caption": "text", "ocr_text": "text", "ai_tags": "text[]", "my_tags": "text[]",
              "category": "text", "cover_thumb": "text", "cover_source": "text",
              "cover_index": "int", "my_note": "text", "status": "text", "share_token": "text",
              "created_at": "ts", "updated_at": "ts", "ai_raw": "jsonb", "ai_title": "text"},
    "item_images": {"id": "int", "item_id": "int", "seq": "int", "mime": "text", "width": "int",
                    "height": "int", "byte_size": "int", "data_base64": "text",
                    "created_at": "ts", "ai_rect": "jsonb"},
    "events": {"id": "int", "user_id": "text", "name": "text", "at": "ts", "props": "jsonb",
               "created_at": "ts"},
}

# 写进 items.json 的字段（跳过两处 base64 大字段）
ITEM_TEXT_FIELDS = ["id", "source_type", "raw_text", "source_platform", "source_url", "ai_title",
                    "ai_summary", "ai_caption", "ocr_text", "ai_tags", "my_tags", "category",
                    "cover_source", "cover_index", "my_note", "status", "share_token",
                    "created_at", "updated_at", "ai_raw"]


def q(v):
    """SQL 文本字面量"""
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def lit(value, t):
    if value is None:
        return "null"
    if t == "int":
        return str(int(value))
    if t == "bool":
        return "true" if value else "false"
    if t == "text":
        return q(value)
    if t == "ts":
        return q(value) + "::timestamptz"
    if t == "jsonb":
        return q(json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value) + "::jsonb"
    if t == "text[]":
        arr = value or []
        return "array[" + ", ".join(q(x) for x in arr) + "]::text[]"
    raise ValueError("unknown type " + t)


def main():
    with open(DUMP, encoding="utf-8") as fh:
        dump = json.load(fh)
    tables = dump["tables"]

    # ---------- dump.sql ----------
    lines = [
        "-- Elangit 数据快照",
        "-- 导出时间：%s" % dump.get("exported_at"),
        "-- 来源端点：%s" % dump.get("endpoint"),
        "-- 生成方式：app/_verify_dump.html 读取全库 → data/ 加工（不经过人工编辑）",
        "--",
        "-- 还原提示：6 张表的 id 是 GENERATED ALWAYS AS IDENTITY，所以 INSERT 必须带",
        "-- OVERRIDING SYSTEM VALUE，否则显式 id 会被拒绝。",
        "-- 先建表（见 schema.sql），再按本文件顺序执行。",
        "",
    ]
    for t in WRITE_ORDER:
        rows = tables.get(t) or []
        lines.append("-- ===== %s（%d 行） =====" % (t, len(rows)))
        if not rows:
            lines.append("-- （空表）")
            lines.append("")
            continue
        cols = list(TYPES[t].keys())
        for row in rows:
            vals = ", ".join(lit(row.get(c), TYPES[t][c]) for c in cols)
            lines.append("insert into %s (%s) %svalues (%s);" % (
                t, ", ".join(cols),
                "overriding system value " if t in IDENTITY else "",
                vals))
        # 重置 identity 序列，否则后续新增会撞号
        if t in IDENTITY:
            lines.append("select setval(pg_get_serial_sequence('%s', 'id'), "
                         "coalesce((select max(id) from %s), 1));" % (t, t))
        lines.append("")
    with open(os.path.join(DATA_DIR, "dump.sql"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")

    # ---------- items.json ----------
    items = []
    for it in (tables.get("items") or []):
        items.append({k: it.get(k) for k in ITEM_TEXT_FIELDS})
    with open(os.path.join(DATA_DIR, "items.json"), "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=2)

    # ---------- images/ ----------
    img_dir = os.path.join(DATA_DIR, "images")
    os.makedirs(img_dir, exist_ok=True)
    manifest = []
    for im in (tables.get("item_images") or []):
        raw = im.get("data_base64") or ""
        # 存的可能是裸 base64，也可能带 data URL 前缀，两种都吃掉
        m = re.match(r"^data:([^;,]+);base64,(.*)$", raw, re.S)
        mime, b64 = (m.group(1), m.group(2)) if m else (im.get("mime") or "image/jpeg", raw)
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "bin")
        name = "item_%s_seq%s.%s" % (im.get("item_id"), im.get("seq"), ext)
        try:
            blob = base64.b64decode(b64)
        except (binascii.Error, ValueError) as e:
            print("解码失败 %s: %s" % (name, e))
            continue
        with open(os.path.join(img_dir, name), "wb") as fh:
            fh.write(blob)
        manifest.append({
            "file": name, "item_id": im.get("item_id"), "seq": im.get("seq"), "mime": mime,
            "width": im.get("width"), "height": im.get("height"),
            "byte_size_db": im.get("byte_size"), "byte_size_file": len(blob),
            "ai_rect": json.dumps(im.get("ai_rect"), ensure_ascii=False) if im.get("ai_rect") else "",
            "created_at": im.get("created_at"),
        })
    with open(os.path.join(img_dir, "_manifest.csv"), "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(manifest[0].keys()) if manifest else ["file"])
        w.writeheader()
        w.writerows(manifest)

    # ---------- 摘要 ----------
    print("dump.sql  %d bytes" % os.path.getsize(os.path.join(DATA_DIR, "dump.sql")))
    print("items.json %d bytes" % os.path.getsize(os.path.join(DATA_DIR, "items.json")))
    print("images     %d 个" % len(manifest))
    for m in manifest:
        print("   %-24s %sx%s  db=%s file=%s" % (m["file"], m["width"], m["height"],
                                                 m["byte_size_db"], m["byte_size_file"]))
    for t in WRITE_ORDER:
        print("表 %-12s %d 行" % (t, len(tables.get(t) or [])))


if __name__ == "__main__":
    main()
