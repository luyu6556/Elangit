/* ============================================================
 * Elangit · 数据访问层
 * ------------------------------------------------------------
 * 只负责跟云端数据库说话：抽屉/标签库、素材、图片。
 * 不含任何界面逻辑，也不含 AI 调用（那在 ai.js）。
 *
 * 表结构见技术方案 3.1 / 3.2。两个要点：
 *   1. 图片本体在 item_images，不跟 items 同一行——否则列表页一次
 *      查 20 条就会顺带拉下几十 MB 的图。
 *   2. items.cover_thumb 是 400px 缩略图，列表页只取它。
 * ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.Elangit.config;
  var cloud = global.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: cfg.endpoint,
    publishableKey: cfg.publishableKey
  });

  // 所有写操作都从这里过一道门（PRD F7-1：未通过口令我方应拒绝一切写操作）。
  // 放在这一层而不是各个页面里，是为了不漏：将来新增写入口时自动被挡住。
  function guard() {
    var auth = global.Elangit.auth;
    return auth ? auth.requireOwner() : Promise.resolve();
  }

  var ITEM_COLS = [
    'id', 'status', 'category', 'ai_title', 'ai_summary', 'ai_caption', 'ocr_text',
    'ai_tags', 'my_tags', 'raw_text', 'source_platform', 'source_url',
    'my_note', 'cover_thumb', 'cover_source', 'cover_index',
    // page_title / page_desc：只填网址时服务端抓来的原文标题与描述（2026-09-21 新增）。
    // 落库的理由不是「留个记录」，是**重跑 AI 时要能复用**：AI 排在入库之后异步跑，
    // 页面刷新后 pending 的条目会重新排队，那时内存里已经没有抓取结果了。
    'page_title', 'page_desc',
    // page_text / ai_digest（2026-09-22 新增）：
    //   page_text  = 抓到的网页**正文**，理由与上一条完全相同（重跑时要复用）。
    //                 几千字，所以只进 ITEM_COLS，不进索引。
    //   ai_digest  = 「理念/做法/效果」三段总结，给人读的。进索引是为了搜索命中。
    'page_text', 'ai_digest',
    // share_token 也带上：详情页要显示「这条分享出去了没有」，
    // 少了它就只能另发一次查询（任务 7）
    'share_token',
    'source_type', 'created_at', 'updated_at', 'ai_raw'
  ].join(',');

  function describe(err) {
    if (!err) return '未知错误';
    return [err.message, err.details, err.hint, err.code ? 'code=' + err.code : '']
      .filter(Boolean).join(' | ') || String(err);
  }

  function unwrap(res, what) {
    if (res && res.error) throw new Error(what + '失败：' + describe(res.error));
    return res;
  }

  /* ---------- 抽屉与标签库（AI 的枚举来源） ---------- */

  var taxonomyCache = null;

  function loadTaxonomy(force) {
    if (taxonomyCache && !force) return Promise.resolve(taxonomyCache);
    return Promise.all([
      cloud.database.from('categories').select('name,is_fallback,sort_order').order('sort_order', { ascending: true }),
      cloud.database.from('tags').select('name,group_id'),
      cloud.database.from('tag_groups').select('id,name,color,bg_color,sort_order').order('sort_order', { ascending: true })
    ]).then(function (r) {
      unwrap(r[0], '读抽屉');
      unwrap(r[1], '读标签');
      unwrap(r[2], '读标签分组');
      var groups = r[2].data || [];
      var byId = {};
      groups.forEach(function (g) { byId[g.id] = g; });
      // 颜色存在分组上，标签自己不带颜色（PRD Q-E：按用途分组、同组同色）
      var color = {};
      (r[1].data || []).forEach(function (t) {
        var g = byId[t.group_id];
        if (g) color[t.name] = { c: g.color, bg: g.bg_color, group: g.name };
      });
      taxonomyCache = {
        categories: r[0].data || [],
        tags: (r[1].data || []).map(function (t) { return t.name; }),
        groups: groups,
        tagColor: color
      };
      return taxonomyCache;
    });
  }

  /* ---------- 素材 ---------- */

  function createItem(row) {
    return guard().then(function () {
      return cloud.database.from('items').insert(row).select(ITEM_COLS);
    })
      .then(function (r) {
        unwrap(r, '建素材');
        var item = r.data && r.data[0];
        if (!item) throw new Error('建素材失败：数据库没有返回新建的行');
        return item;
      });
  }

  function updateItem(id, patch) {
    var body = Object.assign({}, patch);
    body.updated_at = new Date().toISOString();
    return guard().then(function () {
      return cloud.database.from('items').update(body).eq('id', id).select(ITEM_COLS);
    }).then(function (r) {
      unwrap(r, '更新素材');
      return r.data && r.data[0];
    });
  }

  function fetchItem(id) {
    return cloud.database.from('items').select(ITEM_COLS).eq('id', id).limit(1)
      .then(function (r) {
        unwrap(r, '读素材');
        return r.data && r.data[0];
      });
  }

  function recentItems(limit) {
    return cloud.database.from('items').select(ITEM_COLS)
      .order('created_at', { ascending: false }).limit(limit || cfg.recentLimit)
      .then(function (r) {
        unwrap(r, '读素材列表');
        return r.data || [];
      });
  }

  function deleteItem(id) {
    // 先删图片再删主行。实测库里 item_images.item_id 是有 ON DELETE CASCADE 的，
    // 所以顺序反了也不会留下孤儿图片——这里保留显式顺序是防备那条外键将来被去掉
    // （删主行成功、删图片失败会更难查，因为前者已经不可逆了）。
    return guard()
      .then(function () {
        return cloud.database.from('item_images').delete().eq('item_id', id).select('id');
      })
      .then(function (r) {
        unwrap(r, '删除素材图片');
        return cloud.database.from('items').delete().eq('id', id).select('id');
      })
      .then(function (r) { unwrap(r, '删除素材'); return true; });
  }

  /* ---------- 图片 ---------- */

  function addImages(itemId, images) {
    if (!images.length) return Promise.resolve([]);
    var rows = images.map(function (img, i) {
      return {
        item_id: itemId,
        seq: typeof img.seq === 'number' ? img.seq : i,
        mime: img.mime || 'image/jpeg',
        width: img.width,
        height: img.height,
        byte_size: img.byteSize,
        data_base64: img.base64
      };
    });
    return guard()
      .then(function () {
        return cloud.database.from('item_images').insert(rows).select('id,seq');
      })
      .then(function (r) { unwrap(r, '存图片'); return r.data || []; });
  }

  function getImages(itemId) {
    return cloud.database.from('item_images')
      .select('seq,mime,width,height,byte_size,data_base64,ai_rect')
      .eq('item_id', itemId).order('seq', { ascending: true })
      .then(function (r) { unwrap(r, '读图片'); return r.data || []; });
  }

  // 把「这一张图被 AI 判过的主体矩形」按图存下来（2026-09-20 新增）。
  //
  // 为什么要按图存、而不是只留 items.ai_raw.rect：ai_raw.rect 是「送进模型那张图」
  // 的矩形，一旦用户在详情页换了封面图，那条记录就对不上新图了。按 seq 存一份，
  // 「按 AI 矩形重裁」才能对任意一张封面图都成立（F5-8 第三条兜底）。
  function setImageRect(itemId, seq, rect) {
    return guard().then(function () {
      return cloud.database.from('item_images')
        .update({ ai_rect: rect })
        .eq('item_id', itemId).eq('seq', seq)
        .select('id,seq,ai_rect');
    }).then(function (r) {
      unwrap(r, '存裁切矩形');
      var row = (r.data || [])[0];
      if (!row) throw new Error('存裁切矩形失败：没有匹配到第 ' + seq + ' 张图');
      return row;
    });
  }

  function countImages(itemId) {
    return cloud.database.from('item_images').select('id').eq('item_id', itemId)
      .then(function (r) {
        unwrap(r, '数图片');
        return (r.data || []).length;
      });
  }

  /* ---------- 素材库（浏览与检索用） ---------- */

  // 轻量索引：所有素材的**文本字段 + 分类 + 标签**，刻意不取 cover_thumb。
  // 一次拉完，之后侧栏计数与关键词检索都在本地做，不再走网络——
  // 代价是条目很多时这一个请求会变大：按实测单条约 1KB，
  // 300 条约 300KB 可接受；若将来超过 1MB，就该改成服务端检索（PostgREST 支持
  // or + ilike + contains + range，已实测可用）。
  var INDEX_COLS = [
    'id', 'status', 'category', 'ai_title', 'ai_tags', 'my_tags', 'ai_summary', 'ai_caption',
    'ocr_text', 'raw_text', 'my_note', 'source_platform', 'source_url',
    // page_title 进索引是为了让「搜工作室名 / 项目原名」有效——存链接进来的素材，
    // 原文标题里往往有 AI 收敛后丢掉的信息（作者、地点）。page_desc 不进：
    // 它更长而信息密度低，检索价值被 ai_summary 覆盖了。
    'page_title',
    // ai_digest 进索引（2026-09-22）：它是「设计说明总结」，正文里的做法与材料名
    // 大多落在这里，搜「夯土」「模块化」这类词该命中它。
    // page_text（正文几千字）**不进**：理由同 page_desc，而且它会把列表页查询撑大。
    'ai_digest',
    'source_type', 'cover_source', 'cover_index', 'created_at'
  ].join(',');

  function loadIndex() {
    return cloud.database.from('items').select(INDEX_COLS)
      .order('created_at', { ascending: false })
      .then(function (r) { unwrap(r, '读素材索引'); return r.data || []; });
  }

  // 卡片只取 400px 缩略图，按 id 批量取——这就是当初把缩略图单独放在
  // items 上的原因：列表页不会顺带把 1600px 原图拉下来。
  function cardsByIds(ids) {
    if (!ids || !ids.length) return Promise.resolve([]);
    return cloud.database.from('items')
      .select('id,cover_thumb,cover_source,status,category')
      .in('id', ids)
      .then(function (r) { unwrap(r, '读卡片缩略图'); return r.data || []; });
  }

  /* ---------- 项目灵感筛选（一期） ---------- */

  // 项目与素材保持两张独立表：items 是素材唯一真值，不能写项目 ID、收藏状态
  // 或项目内排序。这里也刻意不取 item_images.data_base64；翻阅页应先用
  // loadIndex()，再用 cardsByIds() 按需补 400px 卡面。
  var PROJECT_COLS = 'id,user_id,name,brief,filter_tags,status,created_at,updated_at';
  var PROJECT_ITEM_COLS = 'project_id,item_id,saved_at,sort_order';

  // PostgreSQL 的 default 只在省略列时生效，传空串会原样写进 name。因此所有
  // 项目写入入口都在这里归一化，页面不需要也不允许各自复制这条规则。
  function projectName(value) {
    var name = value == null ? '' : String(value).trim();
    return name || '未命名项目';
  }

  function projectTags(value) {
    if (!Array.isArray(value)) return [];
    var seen = {};
    return value.map(function (tag) { return String(tag == null ? '' : tag).trim(); })
      .filter(function (tag) {
        if (!tag || seen[tag]) return false;
        seen[tag] = true;
        return true;
      });
  }

  function projectPatch(patch, creating) {
    var source = patch || {};
    var body = {};
    if (creating || Object.prototype.hasOwnProperty.call(source, 'name')) body.name = projectName(source.name);
    if (Object.prototype.hasOwnProperty.call(source, 'brief')) body.brief = source.brief == null ? null : String(source.brief);
    if (creating || Object.prototype.hasOwnProperty.call(source, 'filter_tags')) body.filter_tags = projectTags(source.filter_tags);
    if (Object.prototype.hasOwnProperty.call(source, 'status')) {
      if (source.status !== 'active' && source.status !== 'archived') throw new Error('项目状态无效');
      body.status = source.status;
    }
    return body;
  }

  function listProjects() {
    return cloud.database.from('projects').select(PROJECT_COLS)
      .order('status', { ascending: true }).order('updated_at', { ascending: false })
      .then(function (r) { unwrap(r, '读项目列表'); return r.data || []; });
  }

  function fetchProject(id) {
    return cloud.database.from('projects').select(PROJECT_COLS).eq('id', id).limit(1)
      .then(function (r) {
        unwrap(r, '读项目');
        return (r.data || [])[0] || null;
      });
  }

  function createProject(row) {
    var body = projectPatch(row, true);
    if (!body.status) body.status = 'active';
    return guard().then(function () {
      return cloud.database.from('projects').insert(body).select(PROJECT_COLS);
    }).then(function (r) {
      unwrap(r, '建项目');
      var project = (r.data || [])[0];
      if (!project) throw new Error('建项目失败：数据库没有返回新建的行');
      return project;
    });
  }

  function updateProject(id, patch) {
    var body = projectPatch(patch, false);
    body.updated_at = new Date().toISOString();
    return guard().then(function () {
      return cloud.database.from('projects').update(body).eq('id', id).select(PROJECT_COLS);
    }).then(function (r) {
      unwrap(r, '更新项目');
      return (r.data || [])[0] || null;
    });
  }

  function archiveProject(id) { return updateProject(id, { status: 'archived' }); }
  function restoreProject(id) { return updateProject(id, { status: 'active' }); }

  function deleteProject(id) {
    return guard().then(function () {
      // project_items 的 project_id 是 ON DELETE CASCADE；删项目只会删关联，不会碰 items。
      return cloud.database.from('projects').delete().eq('id', id).select('id');
    }).then(function (r) { unwrap(r, '删除项目'); return true; });
  }

  function listProjectItems(projectId) {
    return cloud.database.from('project_items').select(PROJECT_ITEM_COLS).eq('project_id', projectId)
      .order('sort_order', { ascending: true }).order('saved_at', { ascending: false })
      .then(function (r) { unwrap(r, '读项目素材'); return r.data || []; });
  }

  function saveProjectItem(projectId, itemId) {
    return guard().then(function () {
      // 单用户产品仍要显式读取最大序号，避免新收藏与手动排序混用时回到 0。
      return listProjectItems(projectId);
    }).then(function (rows) {
      var last = rows.reduce(function (max, row) { return Math.max(max, Number(row.sort_order) || 0); }, -1);
      return cloud.database.from('project_items')
        .insert({ project_id: projectId, item_id: itemId, sort_order: last + 1 })
        .select(PROJECT_ITEM_COLS);
    }).then(function (r) {
      unwrap(r, '收藏项目素材');
      var row = (r.data || [])[0];
      if (!row) throw new Error('收藏项目素材失败：数据库没有返回新建的关联');
      return row;
    });
  }

  function removeProjectItem(projectId, itemId) {
    return guard().then(function () {
      return cloud.database.from('project_items').delete()
        .eq('project_id', projectId).eq('item_id', itemId).select(PROJECT_ITEM_COLS);
    }).then(function (r) { unwrap(r, '取消项目收藏'); return true; });
  }

  function rewriteProjectItemOrder(projectId, itemIds) {
    if (!Array.isArray(itemIds) || !itemIds.length) {
      return listProjectItems(projectId).then(function (rows) {
        if (rows.length) throw new Error('项目排序不完整：不能用空数组覆盖已有素材');
        return [];
      });
    }
    var unique = {};
    itemIds.forEach(function (id) {
      if (id == null || unique[id]) throw new Error('项目排序无效：素材 ID 不能为空或重复');
      unique[id] = true;
    });
    return guard().then(function () {
      return listProjectItems(projectId);
    }).then(function (rows) {
      if (rows.length !== itemIds.length || rows.some(function (row) { return !unique[row.item_id]; })) {
        throw new Error('项目排序不完整：必须一次提交该项目全部素材且不能增删关联');
      }
      var byId = {};
      rows.forEach(function (row) { byId[row.item_id] = row; });
      var body = itemIds.map(function (itemId, index) {
        return {
          project_id: projectId,
          item_id: itemId,
          // 批量 upsert 是一条数据库写入，避免逐行改 sort_order 产生短暂重复序号。
          saved_at: byId[itemId].saved_at,
          sort_order: index
        };
      });
      return cloud.database.from('project_items')
        .upsert(body, { onConflict: 'project_id,item_id' }).select(PROJECT_ITEM_COLS);
    }).then(function (r) {
      unwrap(r, '重排项目素材');
      return r.data || [];
    });
  }

  /* ---------- 分享（任务 7 / F6） ---------- */

  // settings 是单条记录（id 恒为 1）。**读不加门禁**：分享页要先读它才能判断
  // 令牌是否有效，而分享页的读者就是访客。注意它里面没有任何秘密——
  // 口令哈希从来没进过这张表（见 auth.js 顶部说明）。
  function getSettings() {
    return cloud.database.from('settings')
      .select('share_enabled,share_token')
      .eq('id', 1).limit(1)
      .then(function (r) {
        unwrap(r, '读设置');
        return (r.data || [])[0] || null;
      });
  }

  function updateSettings(patch) {
    var body = Object.assign({}, patch, { updated_at: new Date().toISOString() });
    return guard().then(function () {
      return cloud.database.from('settings').update(body).eq('id', 1).select('share_enabled,share_token');
    }).then(function (r) {
      unwrap(r, '更新设置');
      return (r.data || [])[0] || null;
    });
  }

  // 单条分享：按令牌取，**只返回这一条**（F6-2 / A7）。
  // 用 .eq('share_token', t) 而不是先查全表再过滤——过滤写错一次就会把
  // 别的素材一起发出去，而查询条件写错只会查不到。
  function fetchItemByShareToken(token) {
    if (!token) return Promise.resolve(null);
    return cloud.database.from('items').select(ITEM_COLS)
      .eq('share_token', token).limit(1)
      .then(function (r) {
        unwrap(r, '读分享素材');
        return (r.data || [])[0] || null;
      });
  }

  /* ---------- 埋点（任务 8 / PRD 第 9 章） ---------- */

  // 只记「不可派生」的事件。判断标准：这件事能不能从库里的**当前状态**算出来？
  //   E4 改了哪些 AI 字段  -> 能（items.ai_raw 对比现值，就是 F2-8 的差异）
  //   E11 落进兜底抽屉     -> 能（category 等于兜底抽屉名）
  //   E12 手动更正来源平台 -> 能（ai_raw.platform 对比 source_platform）
  // 这类一律不写事件，用时现算——少一处写入就少一处会漂移的副本。
  // 反之「耗时 / 搜索行为 / 会话」是过程量，状态里留不下痕迹，必须记。
  function insertEvent(name, props) {
    return guard().then(function () {
      return cloud.database.from('events').insert({ name: name, props: props || null }).select('id,at');
    }).then(function (r) {
      unwrap(r, '记埋点');
      return (r.data || [])[0] || null;
    });
  }

  function loadEvents(names, sinceIso) {
    var q = cloud.database.from('events').select('name,at,props');
    if (names && names.length) q = q.in('name', names);
    if (sinceIso) q = q.gte('at', sinceIso);
    return q.order('at', { ascending: false }).limit(2000)
      .then(function (r) { unwrap(r, '读埋点'); return r.data || []; });
  }

  // 取某个事件**最早**的 N 条（2026-09-20 新增，为修正 A1 的样本窗口）。
  //
  // 为什么必须单独一个方法、不能在 loadEvents 的结果上截取：
  // loadEvents 有两个硬限制——只看最近 60 天、最多 2000 条——而且是**倒序**返回。
  // 在它上面 slice(0, 20) 拿到的是「最近 60 天内最新的 20 条」，不是 PRD 要的
  // 「最早的 20 条」。样本窗口是**查询的属性**，不能在渲染层补救：
  // 一旦顺序或窗口错了，均值就是另一个数，而且看不出错。
  function loadFirstEvents(name, limit) {
    return cloud.database.from('events').select('name,at,props')
      .eq('name', name)
      .order('at', { ascending: true })
      .limit(limit || 20)
      .then(function (r) { unwrap(r, '读埋点（最早）'); return r.data || []; });
  }

  // 报表用的素材全量：只取算指标要的列，**不带图片**。
  // ai_raw 必须带上——F2-8 的差异、E4/E11/E12 的派生全靠它。
  //
  // ⚠️ ai_summary / ai_caption / ocr_text / ai_digest 也必须带上（2026-09-20 修正，2026-09-22 补 ai_digest）：
  // diff.fields() 拿它们跟 ai_raw 里的原值对比，而这几列正是 A2 字段表的行。
  // 少了它们，after 恒为空字符串 —— 于是「只要 AI 出过这段文字就算被改过」，
  // 可用率恒为 0%。不报错、但数字全错，是最难被发现的那种 bug。
  // 这几列只有数据页要用（列表页走 ITEM_COLS），加在这里不影响别处。
  var REPORT_COLS = [
    'id', 'category', 'ai_title', 'ai_summary', 'ai_caption', 'ocr_text',
    'ai_digest', 'ai_tags', 'my_tags', 'source_platform',
    'cover_source', 'cover_index', 'status', 'created_at', 'ai_raw'
  ].join(',');

  function reportItems() {
    return cloud.database.from('items').select(REPORT_COLS)
      .order('created_at', { ascending: true })
      .then(function (r) { unwrap(r, '读报表数据'); return r.data || []; });
  }

  /* ---------- 杂项 ---------- */

  // 分享令牌。原来的实现用 Math.random + 时间戳，作为「随手猜一下」的
  // 门槛够用，但它同时是「拿到链接就能看」的唯一凭据，值得用系统随机源。
  // crypto.getRandomValues 在非安全上下文里可能缺失，所以留了退路。
  var TOKEN_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';   // 去掉易混的 l/o/0/1
  function newShareToken(len) {
    len = len || 16;
    var out = '', i;
    if (global.crypto && global.crypto.getRandomValues) {
      var buf = new Uint8Array(len);
      global.crypto.getRandomValues(buf);
      for (i = 0; i < len; i++) out += TOKEN_CHARS[buf[i] % TOKEN_CHARS.length];
      return out;
    }
    for (i = 0; i < len; i++) out += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
    return out + Date.now().toString(36);
  }

  function toDataUrl(mime, base64) {
    return 'data:' + (mime || 'image/jpeg') + ';base64,' + base64;
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.store = {
    cloud: cloud,
    describe: describe,
    loadTaxonomy: loadTaxonomy,
    createItem: createItem,
    updateItem: updateItem,
    fetchItem: fetchItem,
    recentItems: recentItems,
    deleteItem: deleteItem,
    addImages: addImages,
    getImages: getImages,
    setImageRect: setImageRect,
    countImages: countImages,
    loadIndex: loadIndex,
    cardsByIds: cardsByIds,
    listProjects: listProjects,
    fetchProject: fetchProject,
    createProject: createProject,
    updateProject: updateProject,
    archiveProject: archiveProject,
    restoreProject: restoreProject,
    deleteProject: deleteProject,
    listProjectItems: listProjectItems,
    saveProjectItem: saveProjectItem,
    removeProjectItem: removeProjectItem,
    rewriteProjectItemOrder: rewriteProjectItemOrder,
    getSettings: getSettings,
    updateSettings: updateSettings,
    fetchItemByShareToken: fetchItemByShareToken,
    insertEvent: insertEvent,
    loadEvents: loadEvents,
    loadFirstEvents: loadFirstEvents,
    reportItems: reportItems,
    newShareToken: newShareToken,
    toDataUrl: toDataUrl
  };
})(window);
