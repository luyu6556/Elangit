> **说明**：本仓库是「Elan git」工作区的**公开快照副本** —— 上线前已做脱敏（凭据换成占位符、
> 联系方式去除），且**不含**数据快照与私密资料。下文凡提到「本地磁盘那份」，指的是作者机器
> 上的工作区，不在本仓库内。

# data/ · 数据库快照

**快照时间**：2026-09-20（`schema.sql` 于 2026-09-23 补入两张新表，见下）
**来源**：线上库（应用 `wbapp_az0Z1pxT1CjCvbUNffduqc`，端点 `https://elangit.app.workbuddy.host`）
**生成方式**：`app/_verify_dump.html` 用应用自己的 SDK 读出全库的表（那次是 7 张）→ POST 给本机接收端落盘 → 再用脚本加工成下面的文件。**中间没有人工编辑，也没有经过任何模型的上下文。**

---

## 文件

| 文件 | 内容 | 大小 |
|---|---|---|
| `schema.sql` | **9 张表**的 DDL + 索引 + GRANT + RLS 策略。前 7 张**从线上库实际导出**；后 2 张（`projects`／`project_items`，2026-09-23 项目灵感筛选一期）是按 `migrations/2026-09-23-project-inspiration-phase1.sql` 在线上执行并回读后补写的 | ~11 KB |
| `dump.sql` | 全库数据的 INSERT（含 `id`）。含 `items.cover_thumb` 与图片 base64，所以偏大 | ~975 KB |
| `items.json` | 素材的**文本字段**（不含图片与缩略图），给人/agent 直接读 | ~4 KB |
| `images/` | 从 `item_images.data_base64` 解出来的 3 个真实图片文件 | ~670 KB |
| `images/_manifest.csv` | 图片清单：item_id、seq、尺寸、字节数、`ai_rect`、创建时间 | — |
| `elangit-dump.json` | 原始导出（页面直出的 JSON，上面几个文件都从它加工而来） | ~950 KB |
| `originals/` | 用户提供的两张原始截图（当年验证 AI 裁切精度用的） | ~1.1 MB |
| `tools/` | 生成这份快照的三个脚本（见下） | ~13 KB |

**为什么 base64 换成真图片另存一份**：`dump.sql` 里的图是 base64 文本，人和 agent 都读不了；解成 `.jpg` 之后可以直接用系统的图片查看器看，也方便对比「AI 裁出来的封面」和「原图」的差别。

---

## `tools/`：这份快照是怎么生成的（可复现）

顺序跑三步，**数据全程不经过任何模型的上下文**（这一点是刻意的：库里的图片 base64 约 0.9MB，若先打印到对话再转存会灌进几十万 token）：

```bash
# 1. 起接收端（后台），它只做一件事：把 POST 上来的 JSON 写进 data/
python3 recv.py "<.../Elan git/data>" 8792

# 2. 起应用自己的本地服务，然后在浏览器打开「导出台」点一下按钮
cd app && python3 _serve.py        # http://127.0.0.1:8791
#   打开 http://127.0.0.1:8791/_verify_dump.html  → 点「开始导出」
#   页面会用应用自己的 SDK 读出全库的表（当时 7 张），POST 给 127.0.0.1:8792

# 3. 加工成 dump.sql / items.json / images/
python3 process-dump.py            # 注意：脚本里的 DATA_DIR 写死了路径，换机器要改
```

（`export-all.html` 是导出台的存档副本；应用工作区里的 `app/_verify_dump.html` 是同一份。）

---

## 还原步骤

```bash
psql "$DATABASE_URL" -f schema.sql      # 1. 建表 + 索引 + 权限 + 策略
psql "$DATABASE_URL" -f dump.sql        # 2. 灌数据
```

⚠️ **两个必须知道的坑**：

1. **7 张表的 `id` 是 `GENERATED ALWAYS AS IDENTITY`**（categories / tag_groups / tags / items / item_images / events，以及 2026-09-23 新增的 projects）。显式写 `id` 必须带 `OVERRIDING SYSTEM VALUE`，否则会被拒绝。`dump.sql` 里每条 INSERT 已经带了。
2. **灌完数据要 `setval` 重置 identity 序列**，否则后续新增会从 1 开始撞号。`dump.sql` 每个表末尾已附 `select setval(...)`。
3. **`dump.sql` 里没有 `projects`／`project_items` 的数据**（这两张表是快照之后才建的）。按上面顺序还原出来的库里，这两张表是空的——这是正确的，不是漏灌。

（`settings` 表例外：它的 `id` 是 `smallint default 1` 且有 `check (id = 1)`，不是 identity。`project_items` 也没有 `id` 列，主键是 `(project_id, item_id)`。）

---

## 快照内容

| 表 | 行数 | 说明 |
|---|---|---|
| `items` | 3 | 素材。全部 `ai_raw` 为 NULL（该列 v7 才加，早于它录入的素材没有原值快照） |
| `item_images` | 3 | 图片本体（base64） |
| `categories` | 6 | 抽屉（封闭集合，最后一条是兜底抽屉「其他 / 待归类」） |
| `tag_groups` | 5 | 标签用途分组（颜色存在分组上，标签自己不配色） |
| `tags` | 32 | 起始标签库（AI 的枚举来源） |
| `settings` | 1 | 收藏夹分享的总开关与令牌 |
| `events` | 1 | 埋点。只记不可派生的过程量 |

**注意**：`events` 只有 1 行不是因为埋点没做，而是因为验收期间产生的测试事件已经清空了——那是刻意的，避免让数据页把 QA 的动作当成使用数据。真实使用起来之后它会自己长出来。

**2026-09-23 之后线上另有 `projects`／`project_items` 两张表**（项目灵感筛选一期），本快照导出于它们建立之前，所以不在这份 dump 里；它们的结构已补进 `schema.sql`。证据见 `features/项目灵感筛选/项目修改记录.md` #014 与 `docs/构建记录.md` #039。

---

## 安全提示

`schema.sql` 里的 RLS 策略一律是 `USING (true)` / `WITH CHECK (true)`，也就是**拿到 `endpoint` + `publishableKey` 就能读写这个库**。这是「不做账号体系」的必然结果（R-1 已接受），不是遗漏。

那两个值本来就随每个页面发给访客，所以**公开仓库不会额外泄漏什么**——但反过来说，**这个库本身不构成隐私边界**。要真正的隔离，得先有账号体系（v2）。
