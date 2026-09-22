-- ============================================================
-- Elangit 数据库结构（2026-09-20 从线上库实际导出，非手写）
-- ------------------------------------------------------------
-- 平台：WorkBuddy 云服务 Database 模块（PostgreSQL + PostgREST 风格 API）
-- 应用：wbapp_az0Z1pxT1CjCvbUNffduqc
-- 端点：https://elangit.app.workbuddy.host
--
-- 这份 DDL 与线上库一致，可直接用于重建。执行顺序：先建 7 张表，再建索引与策略，
-- 最后灌数据（dump.sql）。
--
-- ★ 两条容易漏的门（漏了会得到形似「策略失效」的 42501）：
--   1. GRANT 和 CREATE POLICY 是两道独立的门。只写策略不 GRANT，匿名角色连表都碰不到。
--   2. 6 张表的 id 是 GENERATED ALWAYS AS IDENTITY，灌数据必须带 OVERRIDING SYSTEM VALUE。
-- ============================================================

-- ---------- 1. categories（抽屉：封闭集合，AI 只能从中选一个） ----------
create table categories (
  id          bigint generated always as identity primary key,
  user_id     text not null default 'local-owner',
  name        text not null,
  is_fallback boolean not null default false,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint categories_name_key unique (name)
);

-- ---------- 2. tag_groups（标签用途分组；颜色存在分组上，标签自己不配色） ----------
create table tag_groups (
  id         bigint generated always as identity primary key,
  user_id    text not null default 'local-owner',
  name       text not null,
  color      text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  bg_color   text,
  constraint tag_groups_name_key unique (name)
);

-- ---------- 3. tags（标签库；AI 的枚举来源，优先复用而不是新建） ----------
create table tags (
  id         bigint generated always as identity primary key,
  user_id    text not null default 'local-owner',
  name       text not null,
  group_id   bigint references tag_groups (id),
  created_at timestamptz not null default now(),
  constraint tags_name_key unique (name)
);

-- ---------- 4. settings（单条记录，id 恒为 1；收藏夹分享的总开关） ----------
-- 注意：这里没有、也从来没有口令哈希。所有者保护是纯前端的（见技术方案第 6 章）。
create table settings (
  id            smallint primary key default 1,
  share_enabled boolean not null default false,
  share_token   text,
  updated_at    timestamptz not null default now(),
  constraint settings_id_check check (id = 1)
);

-- ---------- 5. items（素材主表） ----------
-- cover_thumb 是 400px 缩略图（data URL），只给列表页用；图片本体在 item_images。
-- 这个拆分是为了「列表页一次查 20 条不会顺带拉下几十 MB 原图」。
create table items (
  id              bigint generated always as identity primary key,
  user_id         text not null default 'local-owner',
  source_type     text not null default 'mixed',
  raw_text        text,
  source_platform text,
  source_url      text,
  ai_summary      text,
  ai_caption      text,
  ocr_text        text,
  ai_tags         text[] not null default '{}',
  my_tags         text[] not null default '{}',
  category        text,
  cover_thumb     text,
  cover_source    text not null default 'crop',
  cover_index     integer not null default 0,
  my_note         text,
  status          text not null default 'pending',
  share_token     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  ai_raw          jsonb,
  ai_title        text,
  -- 2026-09-21 新增：只填网址时服务端抓来的原文标题 / 描述（_page_meta.py）。
  -- 落库是为了「重跑 AI 时能复用」：AI 排在入库之后异步跑，页面刷新后 pending
  -- 条目重新排队，那时内存里已经没有抓取结果了。page_title 同时进轻量索引，
  -- 让「搜工作室名 / 项目原名」有效。
  page_title      text,
  page_desc       text,
  -- 2026-09-22 新增，同上一条的理由，但装的是**正文**：AI 摘要原先只能看到
  -- og:title / og:description，而后者在 gooood 这类站上是每篇都一样的客套模板，
  -- 于是摘要只能把标题念一遍（线上 id=28 实测）。正文落库只为了重跑时能复用，
  -- **不进索引**（几千字，进索引会把列表页的查询撑大，检索价值也不高）。
  page_text       text,
  -- 2026-09-22 新增：「理念 / 做法 / 效果」三段式的设计说明总结，给人读的
  -- （判断要不要点进原文）。首页卡片用的是 ai_summary 那一句短摘要。
  -- 与 ai_summary 分开而不是加长它：卡片上只显示两行（约 24 字），
  -- 加长后卡片看到的是三段里的第一段，扫列表时反而认不出是哪条。
  ai_digest       text
);

-- ---------- 6. item_images（图片本体，base64 直接存库） ----------
-- 为什么用 base64 存库而不是对象存储：平台 Storage 只对已登录用户开放，
-- 与「不做账号体系 + 只读分享给外人」冲突。代价与体积实测见技术方案 3.6。
create table item_images (
  id          bigint generated always as identity primary key,
  item_id     bigint not null references items (id) on delete cascade,
  seq         integer not null default 0,
  mime        text not null default 'image/jpeg',
  width       integer,
  height      integer,
  byte_size   integer,
  data_base64 text not null,
  created_at  timestamptz not null default now(),
  ai_rect     jsonb,
  constraint item_images_item_id_seq_key unique (item_id, seq)
);

-- ---------- 7. events（埋点，任务 8 新增） ----------
-- 只记「不可派生」的过程量：耗时 / 搜索行为 / 会话 / 换封面。
-- E4/E11/E12 能从 ai_raw 与现值直接算出来，所以刻意不写事件（见技术方案 3.8）。
create table events (
  id         bigint generated always as identity primary key,
  user_id    text not null default 'local-owner',
  name       text not null,
  at         timestamptz not null default now(),
  props      jsonb,
  created_at timestamptz not null default now()
);

-- ---------- 索引 ----------
create index items_created_at_idx on items (created_at desc);
create index items_category_idx   on items (category);
create index item_images_item_id_idx on item_images (item_id);
create index tags_group_id_idx    on tags (group_id);
create index events_at_desc       on events (at desc);

-- ---------- 权限与行级安全 ----------
-- 两道门都要开：GRANT（能不能碰这张表）+ POLICY（能碰哪些行）。
-- 这里策略一律 USING(true)，是刻意的：不做账号体系，所有者保护退化为纯前端门禁
-- （R-1 已接受这个降级）。它拦的是误操作与路人，不是攻击者。
grant select, insert, update, delete on categories, tag_groups, tags, settings,
      items, item_images, events to anon, authenticated;

alter table categories  enable row level security;
alter table tag_groups  enable row level security;
alter table tags        enable row level security;
alter table settings    enable row level security;
alter table items       enable row level security;
alter table item_images enable row level security;
alter table events      enable row level security;

create policy categories_all  on categories  for all using (true) with check (true);
create policy tag_groups_all  on tag_groups  for all using (true) with check (true);
create policy tags_all        on tags        for all using (true) with check (true);
create policy settings_all    on settings    for all using (true) with check (true);
create policy items_all       on items       for all using (true) with check (true);
create policy item_images_all on item_images for all using (true) with check (true);
create policy events_all      on events      for all using (true) with check (true);
