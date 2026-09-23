-- Elangit｜项目灵感筛选 · 第一期迁移
-- 日期：2026-09-23
-- 状态：✅ 已于 2026-09-23 在线上库执行完毕（应用 wbapp_az0Z1pxT1CjCvbUNffduqc）。
--       文末三组回读全部通过，data/schema.sql 已同步为 9 张表。
--       证据见 features/项目灵感筛选/项目修改记录.md #014 与 docs/构建记录.md #039。
--
-- ⚠️ 执行方式（下次做 DDL 前先看这条）：平台 SQL 通道**单次只接受一条语句**，
--    所以下面的 begin; … commit; 是**逐条拆开执行的，迁移没有原子性**；
--    create table / create index / create policy 都不幂等（无 if not exists）。
--    重跑前必须先按文末回读确认已完成到哪一步，再决定续跑哪些语句。
--
-- 不可动边界：不 ALTER items，不复制图片，不改全局收藏夹／单条分享。
-- 项目与既有素材只通过 project_items 关联。

begin;

-- ---------- 8. projects（设计项目） ----------
create table projects (
  id          bigint generated always as identity primary key,
  user_id     text not null default 'local-owner',
  -- 页面将空输入归一为「未命名项目」；默认值防止其他写入入口遗漏该规则。
  name        text not null default '未命名项目',
  brief       text,
  -- 从既有 tags.name 选择，保留文本而不是 tag id：现有 items.ai_tags / my_tags
  -- 同样使用 text[]，翻阅时可直接按标签名做任一匹配。
  filter_tags text[] not null default '{}',
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint projects_status_check check (status in ('active', 'archived'))
);

-- ---------- 9. project_items（项目与素材的多对多关系） ----------
create table project_items (
  project_id bigint not null references projects (id) on delete cascade,
  item_id    bigint not null references items (id) on delete cascade,
  saved_at   timestamptz not null default now(),
  -- 只定义项目内顺序；同一素材进入另一项目时拥有独立顺序。
  sort_order integer not null default 0,
  primary key (project_id, item_id)
);

-- 工作台按状态／新旧排序，项目素材集按手动顺序读取；item 索引用于查「被哪些项目引用」。
create index projects_status_updated_idx on projects (status, updated_at desc);
create index project_items_project_order_idx on project_items (project_id, sort_order, saved_at desc);
create index project_items_item_id_idx on project_items (item_id);

-- 与既有七张表一致：无账号体系下由前端 guard() 拦截写操作，数据库 policy
-- 保持 anon / authenticated 可读写的已接受降级模型。GRANT 与 RLS 是两道独立门。
grant select, insert, update, delete on projects, project_items to anon, authenticated;

alter table projects enable row level security;
alter table project_items enable row level security;

create policy projects_all on projects for all using (true) with check (true);
create policy project_items_all on project_items for all using (true) with check (true);

commit;

-- ---------- 执行后回读（逐条运行，不要与上方迁移混跑） ----------
-- 1) 结构：应返回 projects / project_items 两行。
-- select tablename from pg_tables where schemaname = 'public'
--   and tablename in ('projects', 'project_items') order by tablename;
--
-- 2) 约束：projects 应有 status 检查；project_items 应有复合主键和两个 cascade 外键。
-- select conrelid::regclass as table_name, conname, pg_get_constraintdef(oid) as definition
-- from pg_constraint
-- where conrelid in ('projects'::regclass, 'project_items'::regclass)
-- order by table_name, conname;
--
-- 3) 权限／RLS：两张表均须 RLS=true，且 anon 有 select / insert / update / delete 权限。
-- select c.relname, c.relrowsecurity
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relname in ('projects', 'project_items');
-- select table_name, privilege_type
-- from information_schema.role_table_grants
-- where grantee = 'anon' and table_name in ('projects', 'project_items')
-- order by table_name, privilege_type;
