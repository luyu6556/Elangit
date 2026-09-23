/* ============================================================
 * Elangit · 项目灵感筛选（一期）页面逻辑
 * ------------------------------------------------------------
 * 四个页面共用这一份脚本，各自只调用自己的 init：
 *   app/projects/index.html    → initList()       项目列表
 *   app/projects/workspace.html→ initWorkspace()  项目工作台
 *   app/projects/deck.html     → initDeck()       单个项目的快速翻阅
 *   app/index.html             → initHome()       全库翻阅首页（内部调 initDeck({home:true})）
 * 放一份的理由和 cards.js 一样：项目名归一、标签挑选、素材外观、牌堆手感
 * 这些都是**同一条规则**，有两份拷贝就一定会漂移。首页与项目翻阅页只差
 * 三件事 ——「队列从哪来」「收藏写到哪」「详情链接的 base 与 from」。
 *
 * 三条硬边界（来自 PRD 5.3 与交接单 §5）：
 *   1. 不直接连数据库。所有读写走 Elangit.store，新增写操作自动被 guard() 挡住。
 *   2. 不往 items 写任何东西。项目关系只存在 projects / project_items。
 *   3. 不读 item_images.data_base64。翻阅队列用 loadIndex()（纯文本索引），
 *      卡面用 cardsByIds()（400px 缩略图）。
 *
 * 依赖加载顺序：config.js → auth.js → cards.js → store.js → ownerbar.js → 本文件。
 * ============================================================ */
(function (global) {
  'use strict';

  var S = global.Elangit.store,
      A = global.Elangit.auth,
      C = global.Elangit.cards,
      OB = global.Elangit.ownerBar;

  var TAX = null;                       // 抽屉与标签库（懒加载后缓存）
  var PID = 0;                          // 当前项目 ID（工作台／翻阅页）
  var PROJECT = null;                   // 当前项目行

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return C.esc(s); }
  function fmtErr(e) { return S.describe(e); }

  // 只用正则取参数，不引 URLSearchParams：三个页面都只有两三个短参数，
  // 而 URLSearchParams 在极老的 WebView 里缺席过一次（本项目要覆盖旧手机）。
  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(global.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function qsNum(name, dflt) {
    var v = Number(qs(name));
    return isFinite(v) && v >= 0 ? v : dflt;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 2600);
  }

  var HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path '
    + 'd="M12 20.1c-.32 0-.63-.11-.88-.32C7.4 16.6 3.9 14 3.9 10.5 3.9 8.1 5.85 6.2 8.2 6.2'
    + 'c1.42 0 2.75.68 3.8 1.83 1.05-1.15 2.38-1.83 3.8-1.83 2.35 0 4.3 1.9 4.3 4.3'
    + '0 3.5-3.5 6.1-7.22 9.28-.25.21-.56.32-.88.32Z"/></svg>';

  /* ============================================================
   * 一、共用小件
   * ============================================================ */

  // 「留空 = 未命名项目」的规矩只在 store.js 一处（projectName）。页面不复制它，
  // 只负责在界面上把这件事说清楚——所以这里只写提示文案，不做归一。
  function pickerHtml(selected) {
    var sel = selected || [];
    if (!TAX || !TAX.tags || !TAX.tags.length) {
      return '<div class="picknone">标签库还是空的。先去灵感库给几条素材打上标签，这里就有得选了。</div>';
    }
    return TAX.tags.map(function (t) {
      return C.tagChip(TAX, t, { on: sel.indexOf(t) >= 0 });
    }).join('');
  }

  function pickedTags(wrap) {
    if (!wrap) return [];
    return [].slice.call(wrap.querySelectorAll('.chip.on')).map(function (el) {
      return el.getAttribute('data-tag');
    });
  }

  // 新建与编辑共用同一份表单。分开写两份的话，「留空会存成未命名项目」
  // 这类提示只要改漏一处，新建和编辑就会给出不一样的说法。
  function formHtml(p, opts) {
    p = p || {};
    opts = opts || {};
    return ''
      + '<label class="fl" for="pName">项目名称（可以留空）</label>'
      + '<input class="inp" id="pName" maxlength="80" autocomplete="off"'
      + ' placeholder="例如：南沙湾国际滨水活力区" value="' + esc(p.name === '未命名项目' ? '' : (p.name || '')) + '">'
      + '<label class="fl" for="pBrief">初步构思（可以留空）</label>'
      + '<textarea class="inp" id="pBrief" placeholder="这个项目想解决什么、想找哪一类参考">'
      + esc(p.brief || '') + '</textarea>'
      + '<label class="fl">默认筛选标签（一个都不选＝翻阅全库；选多个＝命中其中任一个就出现）</label>'
      + '<div class="pickwrap" id="pTags">' + pickerHtml(p.filter_tags) + '</div>'
      + '<div class="foot">'
        + '<span class="hint">' + esc(opts.hint || '名称留空会存成「未命名项目」。') + '</span>'
        + '<button class="btn ghost sm" type="button" data-act="form-cancel">取消</button>'
        + '<button class="btn sm" type="button" data-act="' + (opts.act || 'form-save') + '">'
        + esc(opts.label || '保存') + '</button>'
      + '</div>';
  }

  function readForm() {
    var wrap = $('pTags');
    return {
      name: $('pName') ? $('pName').value : '',
      brief: $('pBrief') ? $('pBrief').value : '',
      filter_tags: pickedTags(wrap)
    };
  }

  function statusBadge(p) {
    return p.status === 'archived' ? '<span class="proj-status archived">已归档</span>' : '';
  }

  // 标签挑选的点击代理。挂在 document 上而不是容器上：容器会被 innerHTML 重画，
  // 逐次重挂监听是最容易漏的一类 bug（cards.js 的标签行拖动也踩过同一个坑）。
  document.addEventListener('click', function (e) {
    var chip = e.target.closest && e.target.closest('.pickwrap .chip');
    if (!chip) return;
    var wrap = chip.parentNode;
    if (!wrap || !wrap.classList.contains('pickwrap')) return;
    chip.classList.toggle('on');
  });

  /* ============================================================
   * 二、项目列表（projects/index.html）
   * ============================================================ */

  function initList() {
    var listBox = $('list'), formPanel = $('formPanel'), formBody = $('formBody');
    var st = { projects: [], counts: {}, confirming: 0, formOpen: false, busy: false };

    function load() {
      return Promise.all([S.loadTaxonomy()]).then(function (r) {
        TAX = r[0];
        return S.listProjects();
      }).then(function (rows) {
        st.projects = rows || [];
        // 每个项目的已收藏数。一次一发 listProjectItems，不做聚合查询的理由：
        // store.js 没有「按项目分组计数」的方法，而单用户工具的项目数是个位数，
        // 并发十来个轻量查询比新增一个数据层方法便宜（改动面小得多）。
        // 项目数真的上百时再回来加聚合，并记在修改记录里。
        return Promise.all(st.projects.map(function (p) {
          return S.listProjectItems(p.id).then(function (its) {
            st.counts[p.id] = its.length;
          }, function () { st.counts[p.id] = null; });
        }));
      }).then(render);
    }

    function rowHtml(p) {
      var n = st.counts[p.id];
      var count = n == null ? '已收藏数读不到' : '已收藏 <span class="cnum">' + n + '</span> 条';
      var tags = p.filter_tags || [];
      return '<div class="proj-row' + (p.status === 'archived' ? ' is-archived' : '') + '" data-id="' + p.id + '">'
        + '<div class="pmain">'
          + '<div class="pname"><a href="workspace.html?project=' + p.id + '">'
            + esc(p.name || '未命名项目') + '</a>' + statusBadge(p) + '</div>'
          + '<div class="pmeta"><span>' + count + '</span>'
            + '<span>建立于 ' + esc(C.fmtTime(p.created_at)) + '</span></div>'
          + (p.brief ? '<div class="pbrief">' + esc(p.brief) + '</div>' : '')
          + (tags.length ? '<div class="ptags chips">'
              + tags.map(function (t) { return C.tagChip(TAX, t, {}); }).join('') + '</div>' : '')
        + '</div>'
        + '<div class="pacts">'
          + '<a class="linkbtn" href="deck.html?project=' + p.id + '">快速翻阅</a>'
          + '<a class="linkbtn" href="workspace.html?project=' + p.id + '">工作台</a>'
          + '<button class="linkbtn owner-only" type="button" data-act="archive" data-id="' + p.id + '">'
            + (p.status === 'archived' ? '恢复' : '归档') + '</button>'
          + '<button class="linkbtn owner-only" type="button" data-act="del" data-id="' + p.id + '">删除</button>'
        + '</div>'
        + (st.confirming === p.id ? confirmHtml(p) : '')
      + '</div>';
    }

    function confirmHtml(p) {
      return '<div class="pconfirm">'
        + '<span class="warn">确认删除「' + esc(p.name || '未命名项目')
          + '」？只删这个项目和它的素材关联，素材本身一条都不会动。</span>'
        + '<button class="btn ghost sm" type="button" data-act="del-cancel">取消</button>'
        + '<button class="btn del sm" type="button" data-act="del-go" data-id="' + p.id + '">确认删除</button>'
      + '</div>';
    }

    function render() {
      var active = st.projects.filter(function (p) { return p.status !== 'archived'; });
      var arch = st.projects.filter(function (p) { return p.status === 'archived'; });
      var head = '';
      if (!st.projects.length) {
        head = '<div class="emptystate"><b>还没有项目</b>建一个，把散在库里的案例往一个方向收一收</div>';
      } else {
        head = (active.length ? active.map(rowHtml).join('') : '')
          + (arch.length
              ? '<div class="proj-crumb" style="margin:18px 0 0">已归档 ' + arch.length + ' 个</div>'
                + arch.map(rowHtml).join('')
              : '');
      }
      listBox.innerHTML = '<div class="proj-list">' + head + '</div>';
      $('hdrNote').textContent = st.projects.length ? '共 ' + st.projects.length + ' 个项目' : '还没有项目';
    }

    function openForm() {
      st.formOpen = true;
      formPanel.classList.add('on');
      formBody.innerHTML = formHtml({}, {
        act: 'form-save', label: '建立项目',
        hint: '名称留空会存成「未命名项目」。标签只决定翻阅时的默认范围，不改素材。'
      });
      var n = $('pName');
      if (n) n.focus();
    }
    function closeForm() {
      st.formOpen = false;
      formPanel.classList.remove('on');
      formBody.innerHTML = '';
    }

    function save() {
      if (st.busy) return;
      st.busy = true;
      var v = readForm();
      S.createProject(v).then(function (p) {
        st.busy = false;
        closeForm();
        toast('已建立「' + p.name + '」');
        return load().then(function () { global.location.href = 'workspace.html?project=' + p.id; });
      }).catch(function (e) {
        st.busy = false;
        toast('建立失败：' + fmtErr(e));
      });
    }

    formPanel.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'form-cancel') closeForm();
      if (b.getAttribute('data-act') === 'form-save') save();
    });

    $('newBtn').addEventListener('click', function () {
      if (!A.isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能建项目'); return; }
      if (st.formOpen) closeForm(); else openForm();
    });

    listBox.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act'), id = Number(b.getAttribute('data-id'));

      if (act === 'del') { st.confirming = id; render(); return; }
      if (act === 'del-cancel') { st.confirming = 0; render(); return; }
      if (act === 'del-go') {
        S.deleteProject(id).then(function () {
          st.confirming = 0;
          toast('项目已删除，素材没有动');
          return load();
        }).catch(function (err) { toast('删除失败：' + fmtErr(err)); });
        return;
      }
      if (act === 'archive') {
        var p = st.projects.filter(function (x) { return x.id === id; })[0];
        var back = p && p.status === 'archived';
        (back ? S.restoreProject(id) : S.archiveProject(id)).then(function () {
          toast(back ? '已恢复为进行中' : '已归档，仍在列表里');
          return load();
        }).catch(function (err) { toast((back ? '恢复' : '归档') + '失败：' + fmtErr(err)); });
        return;
      }
    });

    // 锁定之后打开的编辑表单要收起来：表单属于所有者态，留着它会让访客
    // 对着一张点不动的表。
    global.Elangit.onOwnerChange = function () {
      closeForm();
      st.confirming = 0;
      render();
    };

    OB.mount();
    load().catch(function (e) {
      listBox.innerHTML = '<div class="errcard">读项目列表失败：' + esc(fmtErr(e)) + '</div>';
      $('hdrNote').textContent = '';
    });
  }

  /* ============================================================
   * 三、项目工作台（projects/workspace.html）
   * ============================================================ */

  function initWorkspace() {
    PID = qsNum('project', 0);
    var st = { items: [], thumbs: {}, index: {}, confirming: false, editOpen: false, busy: false };

    if (!PID) {
      $('wsErr').style.display = '';
      $('wsErr').textContent = '地址里没有项目编号（应该形如 workspace.html?project=1）。从项目列表点进来。';
      $('grid').style.display = 'none';
      OB.mount();
      return;
    }

    function load() {
      return Promise.all([
        S.loadTaxonomy(), S.fetchProject(PID), S.listProjectItems(PID), S.loadIndex()
      ]).then(function (r) {
        TAX = r[0];
        PROJECT = r[1];
        if (!PROJECT) throw new Error('库里没有 #' + PID + ' 这个项目，可能已经被删了。');
        var links = r[2] || [];
        st.index = {};
        (r[3] || []).forEach(function (it) { st.index[it.id] = it; });
        // 已收藏素材 = 关联表顺序 ∩ items 里还存在的行。
        // 原素材被删过的话关联行会被级联删掉，这里再过滤一次是为了防
        // 「关联还在、items 已经读不到」的中间态——那种卡片点开就是死链（P3-4）。
        st.items = links.map(function (l) { return st.index[l.item_id]; })
          .filter(Boolean);
        return S.cardsByIds(st.items.map(function (it) { return it.id; }));
      }).then(function (rows) {
        (rows || []).forEach(function (r2) { st.thumbs[r2.id] = r2; });
        render();
      });
    }

    function briefHtml() {
      return PROJECT.brief
        ? '<div class="proj-brief">' + esc(PROJECT.brief) + '</div>'
        : '<div class="proj-brief empty">还没有写构思。</div>';
    }

    function tagsHtml() {
      var t = PROJECT.filter_tags || [];
      if (!t.length) return '<div class="picknone">没有选标签 —— 快速翻阅会走全库。</div>';
      return '<div class="chips">' + t.map(function (x) { return C.tagChip(TAX, x, {}); }).join('') + '</div>';
    }

    // Markdown 是下载给项目主人留档的纯文本，不复用 esc()：后者是 HTML
    // 转义，写进 .md 会把「&」变成肉眼可见的 &amp;。这里仅收平换行，避免
    // 任一素材的多行字段意外打断标题、列表等 Markdown 结构。
    function mdLine(value, fallback) {
      var s = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
      return s || (fallback || '【未填写】');
    }

    function mdParagraph(value, fallback) {
      var s = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
      return s || (fallback || '【未填写】');
    }

    // `ai_digest` 是已经经过严格契约校验的「理念／做法／效果」三段总结。
    // 导出时只忠实保留它；为空就写「无」，绝不能回退到摘要、图像描述、原文或备注
    // 假装存在一段设计说明。给每一行补两个空格，让它稳定属于 Markdown 的同一条目。
    function mdDigest(value) {
      var s = String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
      if (!s) return '  无';
      return s.split('\n').map(function (line) {
        return '  ' + line.trim();
      }).filter(function (line) { return line.trim(); }).join('\n') || '  无';
    }

    function markdownForProject() {
      var tags = (PROJECT.filter_tags || []).map(function (tag) { return mdLine(tag); });
      var out = [
        '# ' + mdLine(PROJECT.name, '未命名项目'),
        '',
        '## 项目构思',
        mdParagraph(PROJECT.brief, '【未填写】'),
        '',
        '## 筛选标签',
        tags.length ? tags.map(function (tag) { return '- ' + tag; }).join('\n') : '【未选择｜快速翻阅默认全库】',
        '',
        '## 项目素材集（' + st.items.length + ' 条）'
      ];
      if (!st.items.length) {
        out.push('', '【暂无已收藏素材】');
        return out.join('\n') + '\n';
      }
      st.items.forEach(function (it, index) {
        var itemTags = [];
        (it.my_tags || []).concat(it.ai_tags || []).forEach(function (tag) {
          tag = mdLine(tag, '');
          if (tag && itemTags.indexOf(tag) < 0) itemTags.push(tag);
        });
        out.push(
          '',
          '### ' + (index + 1) + '. ' + mdLine(it.ai_title || it.page_title, '未命名素材'),
          '- 抽屉：' + mdLine(it.category),
          '- 标签：' + (itemTags.length ? itemTags.join('、') : '【未填写】'),
          '- 摘要：' + mdLine(it.ai_summary, '无'),
          '- 设计说明总结：\n' + mdDigest(it.ai_digest),
          '- 来源：' + mdLine(it.source_platform)
        );
        if (it.source_url) out.push('- 原文：' + String(it.source_url).trim());
      });
      return out.join('\n') + '\n';
    }

    function exportMarkdown() {
      if (!A.isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能导出'); return; }
      var safeName = mdLine(PROJECT.name, '未命名项目')
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 60) || '未命名项目';
      var blob = new Blob([markdownForProject()], { type: 'text/markdown;charset=utf-8' });
      var href = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = href;
      link.download = safeName + '-项目素材集.md';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // click 已把 Blob 交给浏览器下载队列；下一轮事件循环后即可释放临时 URL。
      global.setTimeout(function () { URL.revokeObjectURL(href); }, 0);
      toast('Markdown 已开始下载');
    }

    function cardActions(it) {
      // 复用 cards.js 的卡片，但操作条换成项目自己的三个动作。
      // 不写第二份卡片解释（PRD 5.2）：信息顺序、标签配色、摘要口径都还是那一份。
      return '<button class="linkbtn" type="button" data-act="uncollect" data-id="' + it.id + '">取消收藏</button>'
        + '<a class="linkbtn" href="../item.html?id=' + it.id + '">看详情</a>'
        + '<span class="sp"></span>'
        + '<span class="whandle" data-handle="1" role="button" tabindex="0" title="按住拖动，调整在本项目里的顺序">⠿ 排序</span>';
    }

    function render() {
      $('wsName').innerHTML = esc(PROJECT.name || '未命名项目') + statusBadge(PROJECT);
      $('wsBrief').innerHTML = briefHtml();
      $('wsTags').innerHTML = tagsHtml();
      $('wsCount').innerHTML = '已收藏 <b>' + st.items.length + '</b> 条';
      $('hdrNote').textContent = PROJECT.name || '未命名项目';
      document.title = (PROJECT.name || '未命名项目') + ' · 工作台 · Elangit';
      // 顶部这几颗按钮的文案随项目状态走：归档过的那颗要变成「恢复」，
      // 而不是让人对着一个已经归档的项目再点一次归档。
      var archived = PROJECT.status === 'archived';
      $('deckLink').href = 'deck.html?project=' + PID;
      $('archiveBtn').textContent = archived ? '恢复为进行中' : '归档';
      $('delWarn').textContent = '确认删除「' + (PROJECT.name || '未命名项目')
        + '」？只删这个项目和它的素材关联，素材本身一条都不会动。';

      var grid = $('grid');
      if (!st.items.length) {
        grid.style.display = 'none';
        $('wsEmpty').style.display = '';
        $('wsEmpty').innerHTML = '<b>这个项目还没有收藏素材</b>'
          + '去快速翻阅，遇到合适的点右下角爱心收进来'
          + '<div style="margin-top:16px"><a class="btn sm" href="deck.html?project=' + PID + '">开始翻阅</a></div>';
        $('reorderHint').style.display = 'none';
      } else {
        grid.style.display = '';
        $('wsEmpty').style.display = 'none';
        $('reorderHint').style.display = st.items.length > 1 ? '' : 'none';
        grid.innerHTML = st.items.map(function (it) {
          return '<div class="witem" data-id="' + it.id + '">'
            + C.cardHtml(it, st.thumbs[it.id] || {}, TAX, {
                openAct: 'open', actions: cardActions(it)
              })
            + '</div>';
        }).join('');
        C.refreshTagScroll(grid);
      }
      renderEdit();
    }

    function renderEdit() {
      var panel = $('editPanel');
      if (!st.editOpen) { panel.classList.remove('on'); $('editBody').innerHTML = ''; return; }
      panel.classList.add('on');
      $('editBody').innerHTML = formHtml(PROJECT, {
        act: 'edit-save', label: '保存修改',
        hint: '标签只决定翻阅范围，不会动素材本身。'
      });
    }

    function saveEdit() {
      if (st.busy) return;
      st.busy = true;
      var v = readForm();
      S.updateProject(PID, v).then(function () {
        st.busy = false;
        st.editOpen = false;
        toast('已保存');
        return load();
      }).catch(function (e) {
        st.busy = false;
        toast('保存失败：' + fmtErr(e));
      });
    }

    function uncollect(itemId) {
      S.removeProjectItem(PID, itemId).then(function () {
        toast('已从本项目移除，素材还在库里');
        return load();
      }).catch(function (e) { toast('取消收藏失败：' + fmtErr(e)); });
    }

    function archive(back) {
      (back ? S.restoreProject(PID) : S.archiveProject(PID)).then(function () {
        toast(back ? '已恢复为进行中' : '已归档，仍在项目列表里');
        return load();
      }).catch(function (e) { toast('操作失败：' + fmtErr(e)); });
    }

    function removeProject() {
      S.deleteProject(PID).then(function () {
        global.location.href = 'index.html';
      }).catch(function (e) { toast('删除失败：' + fmtErr(e)); });
    }

    /* ---------- 拖拽排序（P3-5） ---------- */
    // 把手拖、而不是整张卡拖。整卡拖必须和「点卡进详情」抢同一个手势，
    // 而工作台的卡片流在窄屏是要上下滚的 —— 一旦把指针手势拿来做排序，
    // 滚动就会变得不可靠。把手只占一小块，代价是用户要多按准一点。
    var drag = null, reorderedAt = 0;
    var grid = $('grid');

    grid.addEventListener('pointerdown', function (e) {
      var h = e.target.closest && e.target.closest('.whandle');
      if (!h) return;
      var item = h.closest('.witem');
      if (!item) return;
      var kids = grid.querySelectorAll('.witem');
      if (kids.length < 2) return;
      e.preventDefault();
      drag = {
        el: item, pid: e.pointerId, moved: false,
        order: [].slice.call(kids).map(function (x) { return Number(x.getAttribute('data-id')); })
      };
      item.classList.add('dragging');
    });

    global.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.pid) return;
      drag.moved = true;
      // .dragging 上有 pointer-events:none，所以下面这一下能「穿过」被拖的卡，
      // 命中它底下的目标卡 —— 否则被拖的卡永远挡在指针和落点之间。
      var under = document.elementFromPoint(e.clientX, e.clientY);
      var target = under && under.closest ? under.closest('.witem') : null;
      if (!target || target === drag.el || !grid.contains(target)) return;
      var r = target.getBoundingClientRect();
      var before = (e.clientY < r.top) ? true
        : (e.clientY > r.bottom) ? false
        : (e.clientX < r.left + r.width / 2);
      if (before) grid.insertBefore(drag.el, target);
      else target.after(drag.el);
    });

    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.pid)) return;
      var d = drag; drag = null;
      d.el.classList.remove('dragging');
      if (!d.moved) return;                       // 没动过 = 只是点了一下把手，不当排序
      reorderedAt = Date.now();
      var ids = [].slice.call(grid.querySelectorAll('.witem'))
        .map(function (x) { return Number(x.getAttribute('data-id')); });
      if (ids.join(',') === d.order.join(',')) return;
      S.rewriteProjectItemOrder(PID, ids).then(function () {
        // 导出直接读 st.items。拖拽只会先挪 DOM；写入成功后也要同步这份
        // 内存顺序，否则用户刚排完就点导出，会得到刷新前的旧排列。
        st.items.sort(function (a, b2) {
          return ids.indexOf(a.id) - ids.indexOf(b2.id);
        });
        toast('顺序已保存');
      }).catch(function (err) {
        toast('排序没存上：' + fmtErr(err));
        // 存不上就退回原顺序，别让界面显示一个库里并不存在的排列。
        st.items.sort(function (a, b2) {
          return d.order.indexOf(a.id) - d.order.indexOf(b2.id);
        });
        render();
      });
    }
    global.addEventListener('pointerup', endDrag);
    global.addEventListener('pointercancel', endDrag);

    /* ---------- 事件 ---------- */
    $('editBtn').addEventListener('click', function () {
      if (!A.isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能改'); return; }
      st.editOpen = !st.editOpen;
      renderEdit();
      if (st.editOpen) { var n = $('pName'); if (n) n.focus(); }
    });
    $('exportBtn').addEventListener('click', exportMarkdown);
    $('archiveBtn').addEventListener('click', function () {
      archive(PROJECT.status === 'archived');
    });
    $('delBtn').addEventListener('click', function () {
      $('delConfirm').style.display = '';
      $('delBtn').disabled = true;
    });
    $('delCancel').addEventListener('click', function () {
      $('delConfirm').style.display = 'none';
      $('delBtn').disabled = false;
    });
    $('delGo').addEventListener('click', removeProject);

    $('editPanel').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.getAttribute('data-act') === 'form-cancel') { st.editOpen = false; renderEdit(); }
      if (b.getAttribute('data-act') === 'edit-save') saveEdit();
    });

    // 卡片点击：截图按钮与普通链接先让路（与首页同一套优先级），
    // 然后是「取消收藏」，最后才是「点卡体进详情」。
    document.addEventListener('click', function (e) {
      if (reorderedAt && Date.now() - reorderedAt < 400) {
        if (e.target.closest && e.target.closest('.witem')) {
          e.stopPropagation(); e.preventDefault(); reorderedAt = 0; return;
        }
      }
      var inner = e.target.closest('[data-act="shot"], a');
      if (inner) {
        if (inner.getAttribute('data-act') === 'shot') {
          global.location.href = '../item.html?id=' + inner.getAttribute('data-id');
          e.preventDefault();
        }
        return;
      }
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'uncollect') { uncollect(Number(b.getAttribute('data-id'))); return; }
      if (act === 'open') { global.location.href = '../item.html?id=' + b.getAttribute('data-id'); }
    });

    global.Elangit.onOwnerChange = function () {
      st.editOpen = false;
      $('delConfirm').style.display = 'none';
      $('delBtn').disabled = false;
      render();
    };

    OB.mount();
    load().catch(function (e) {
      $('wsErr').style.display = '';
      $('wsErr').textContent = '读项目失败：' + fmtErr(e);
      $('grid').style.display = 'none';
    });
  }

  /* ============================================================
   * 四、快速翻阅牌堆（projects/deck.html）
   * ============================================================ */

  var BAND = 4;            // 每侧最多摆 4 层。规格要求「至少 3 层」，多一层是留给
                           // 跟手过程中「下一层正在浮上来」的那一瞬间。
  var MIN_FLICK = 12;      // 走速度判定时至少要位移这么多像素（见 onUp 的说明）
  // 超过这个位移就确定「用户在拖动」而不是「在点按」。它同时管两件事：
  // ① 吞掉随后那个 click（原来写死的 5）；② 复位翻面 —— 翻面只存在于静止态，
  // 一旦开始拖就回到正面，所以「复位」必然发生在任何一次翻页之前（P2-11）。
  var MOVED_PX = 5;
  // 惯性滑行的物理参数（2026-09-23：一次滑动连续翻动）。
  //   INERTIA_MIN   —— 松手/停滚时速度低于这个值（px/ms）就不进入惯性，直接按
  //                    「按格数兑现 / 回弹」收尾。0.3 px/ms = 300px/s：再低的话
  //                    中速滑动也带惯性尾巴，真机感受是「刹不住」；300px/s 起
  //                    才是明确的「甩」。
  //   INERTIA_FRICT —— 每毫秒的速度衰减系数，接近 1 就滑得远、接近 0 就立刻停。
  //                    0.997 ≈ 每秒衰减到 0.997^1000 ≈ 5%，一次快甩约滑 2~4 格后停。
  //   INERTIA_STOP  —— 速度降到这个值（px/ms）以下就结束滑行，snap 回整格。
  var INERTIA_MIN = 0.3;
  var INERTIA_FRICT = 0.995;
  var INERTIA_STOP = 0.05;
  // 初速度上限（px/ms）。速度采样是「位移÷帧间隔」，帧间隔很短时会算出一个
  // 离谱的瞬时速度（触控板一条大 deltaX、dt 只有十几毫秒），不封顶的话一次
  // 手势能滑飞十几张。1.0 px/ms ≈ 1 屏/秒，配上 INERTIA_FRICT=0.995 一次快甩
  // 约滑 2~4 张就停——这是「流畅但别一下冲到底」的上限（旧 2.0 会一次甩十几张，
  // 用户真机报「翻卡片速度太快」）。
  var INERTIA_VMAX = 1.0;
  // 设计说明总结的标签行。与 ai.js 的 DIGEST_LABELS、item.html 的 DIGEST_LINE
  // 是同一条约定（「理念/做法/效果」三项）；这里再写一份是因为 deck 页不加载
  // item.html 的内联脚本。容错规则同 item.html：认得出标签就加粗，
  // **认不出就整行当普通文字，绝不替模型编一个「理念：」上去**。
  var DIGEST_LINE = /^(理念|做法|效果)\s*[：:]\s*([\s\S]*)$/;
  var DETAIL_SVG = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
    + '<path d="M7 17 17 7M9 7h8v8" stroke="currentColor" stroke-width="1.9"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var deck = null;         // 牌堆状态（initDeck 里建）
  // 牌堆有两个宿主（2026-09-23 首页重构加入第二个）：
  //   · 项目翻阅页 `projects/deck.html?project=N` —— 队列按该项目标签过滤，爱心写进该项目；
  //   · 应用首页 `index.html` —— 队列是**全库**，爱心写进「当前项目」，没选项目时先弹选择层。
  // **引擎只有这一份**：拖拽、滚轮连续滚动、翻面、命中分流、节点复用全部不分叉；
  // 分叉的只有三件事 ——「队列从哪来」「收藏写到哪」「详情链接的 base 与 from」。
  // 不要为了首页另写第二套（两套一定会在手感和修复上漂移）。
  var HOME = false;        // 本次装配是不是首页
  var CUR = null;          // 首页的「当前项目」行（项目翻阅页恒等于 PROJECT）

  function initDeck(opts) {
    var o = opts || {};
    HOME = !!o.home;
    PID = HOME ? 0 : qsNum('project', 0);
    // 详情页 / 录入页相对本页的路径前缀：项目翻阅页在 projects/ 下一层，首页在根。
    var BASE = HOME ? '' : '../';
    var cardsBox = $('cards');
    var d = {
      queue: [], index: 0, dragX: 0, dragging: false, vel: 0,
      nodes: [], thumbs: {}, asked: {}, collected: {}, order: [], inflight: {}, movedAt: 0,
      index0: {}, index0count: 0,
      // 惯性滚动状态（2026-09-23：用户要「一次滑动连续翻动、松手惯性滑、按住即停」）。
      // inertia: { raf, v, t } —— v 是 px/ms 的横向速度，t 是上一帧时间戳。
      // 与拖拽的 d.vel 分开：拖拽里的 vel 是「这一下甩得多快」的瞬时样本，惯性是
      // 松手后由它启动的一段自主滑行。
      inertia: null,
      geom: { cw: 336, step: 82, shrink: .055, fade: .15 }
    };
    deck = d;

    // 手机翻阅页是一个完整舞台，不应让页面本身跟着上下走：用户横滑时只需
    // 面对牌堆，纵向的轻微抖动不能把整页带离卡片。背面的长总结仍在自己的
    // .dc-dg 内滚动；桌面或转到宽屏时立刻撤销锁定，不影响其它页面。
    function syncMobileDeckLock() {
      var locked = global.innerWidth <= 640;
      document.body.classList.toggle('deck-mobile-lock', locked);
    }
    syncMobileDeckLock();
    global.addEventListener('resize', syncMobileDeckLock);

    /* ---------- 几何：参数在 CSS，算在这里 ---------- */
    function readGeom() {
      var cs = global.getComputedStyle(cardsBox);
      function px(name, dflt) {
        var v = parseFloat(cs.getPropertyValue(name));
        return isFinite(v) && v > 0 ? v : dflt;
      }
      function unit(name, dflt) {
        var v = parseFloat(cs.getPropertyValue(name));
        return isFinite(v) ? v : dflt;
      }
      d.geom.cw = px('--deck-cw', d.geom.cw);
      d.geom.step = px('--deck-step', d.geom.step);
      d.geom.shrink = unit('--deck-shrink', d.geom.shrink);
      d.geom.fade = unit('--deck-fade', d.geom.fade);
    }

    /* ---------- 队列：按项目标签过滤（P2-10：命中任一即可，是「或」不是「与」） ---------- */
    // 注意这里刻意不复用 cards.matches()：灵感库的标签筛选是「与」（点得越多范围越窄），
    // 项目翻阅是「或」。同一个函数名底下两种语义，混用会让「选了 3 个标签却什么都没有」
    // 这种最难查的现象出现。
    function tagMatch(it, tags) {
      if (!tags || !tags.length) return true;
      var all = (it.ai_tags || []).concat(it.my_tags || []);
      for (var i = 0; i < tags.length; i++) if (all.indexOf(tags[i]) >= 0) return true;
      return false;
    }

    /* ---------- 卡片内容 ---------- */
    function thumbKey(id) {
      var t = d.thumbs[id];
      if (!t) return 'x';                    // 还没问过
      return t.cover_thumb ? '1' : '0';      // 问过了：有缩略图 / 确实没有
    }

    // 背面主体：设计说明总结。空态只陈述事实 —— 翻阅用的索引列里没有 page_text /
    // ai_raw，所以这一层**判不出**「AI 答了但三项没给全被丢弃」与「AI 压根没答」的
    // 区别，那两种原因只有详情页说得准。宁可少说一句，也不在这里猜一个原因
    // （把一个编的原因摆在断言它可信的位置上，比没有原因更糟）。
    function digestRows(it) {
      var v = String(it.ai_digest || '').trim();
      if (!v) {
        return '<div class="dc-dgempty"><b>这条没有设计说明总结</b>'
          + '可能是没抓到可读的网页正文，也可能是 AI 没按「理念 / 做法 / 效果」'
          + '三项给全。右下角「详情」里能看到具体原因。</div>';
      }
      return v.split('\n').map(function (ln) {
        ln = String(ln).trim();
        if (!ln) return '';
        var m = DIGEST_LINE.exec(ln);
        return m
          ? '<div class="dc-dgrow"><b>' + esc(m[1]) + '</b><span>' + esc(m[2]) + '</span></div>'
          : '<div class="dc-dgrow"><span>' + esc(ln) + '</span></div>';
      }).join('');
    }

    function deckCardHtml(it, th) {
      var cover = th && th.cover_thumb;
      var tags = (it.ai_tags || []).concat(it.my_tags || []);
      var title = (it.ai_title || '').trim();
      var on = !!d.collected[it.id];

      var thumb;
      if (cover) {
        thumb = '<img src="' + S.toDataUrl('image/jpeg', cover) + '" alt="">';
      } else {
        var msg = it.source_url ? '这条来自原文链接<br>没抓到封面，点开可看原文'
                                : '这条没有配图<br>纯文本素材照样进库';
        thumb = '<div class="dc-nocover"><p>' + msg + '</p></div>';
      }

      // 正面＝认人：封面 + 标题 + 摘要 + 标签 + 收藏。
      var front = '<div class="dc-thumb">' + thumb
          + (it.source_platform ? '<span class="plat">' + esc(it.source_platform) + '</span>' : '')
          + (it.status === 'pending' ? '<span class="stag st pending"><span class="spin"></span>识别中</span>' : '')
          + (it.status === 'failed' ? '<span class="stag st failed">待补</span>' : '')
        + '</div>'
        + '<div class="dc-body">'
          + '<div class="dc-title' + (title ? '' : ' noname') + '">' + (title ? esc(title) : '未命名') + '</div>'
          + '<div class="dc-sum">'
            + (it.ai_summary ? esc(it.ai_summary)
               : (it.raw_text ? esc(it.raw_text.slice(0, 120)) : '（没有文字内容）'))
          + '</div>'
          + '<div class="dc-tags">' + tags.map(function (t) { return C.tagChip(TAX, t, {}); }).join('') + '</div>'
        + '</div>'
        + '<div class="dc-foot">'
          + '<div class="dc-meta"><span>' + esc(it.category || '未归类') + '</span>'
            + '<span class="dc-date">' + esc(C.fmtTime(it.created_at)) + '</span></div>'
          + '<button class="dc-heart' + (on ? ' on' : '') + '" type="button"'
            + ' aria-pressed="' + (on ? 'true' : 'false') + '"'
            + ' aria-label="' + (on ? '取消收藏' : '收藏到本项目') + '"'
            + ' title="' + (on ? '已收藏 · 再点取消' : '收藏到本项目') + '">' + HEART_SVG + '</button>'
        + '</div>';

      // 背面＝阅读：整张卡都给文字（不放封面，见 projects.css 里的长度依据），
      // 右下角是进详情的唯一入口 —— 正面那个位置的爱心在这里换成「详情」。
      var back = '<div class="dc-bhead">'
            + '<div class="dc-btitle' + (title ? '' : ' noname') + '">' + (title ? esc(title) : '未命名') + '</div>'
            + '<div class="dc-bkick">设计说明总结</div>'
          + '</div>'
          + '<div class="dc-dg">' + digestRows(it) + '</div>'
          + '<div class="dc-bfoot">'
            + '<div class="dc-meta"><span>' + esc(it.category || '未归类') + '</span>'
              + '<span class="dc-date">' + esc(C.fmtTime(it.created_at)) + '</span></div>'
            + '<button class="dc-detail" type="button" title="打开详情页（原文、原图、编辑）">'
              + '详情' + DETAIL_SVG + '</button>'
          + '</div>';

      // 两面都画出来、都留在 DOM 里，靠 backface-visibility 决定谁可见。
      // 未翻面时背面标 aria-hidden，免得读屏把看不见的那一面也念一遍。
      return '<div class="dc-flip">'
          + '<div class="dc-face dc-front">' + front + '</div>'
          + '<div class="dc-face dc-back" aria-hidden="true">' + back + '</div>'
        + '</div>';
    }

    /* ---------- 翻面（P2-11，2026-09-23） ---------- */
    // 翻面状态记在 CSS 类上，不额外存一份 JS 状态：牌的 DOM 会被复用，
    // 两份状态一定会漂移（类还在、变量没了，或者反过来）。
    function isFlipped(el) { return !!el && el.classList.contains('flipped'); }

    // 正中央那张卡的 DOM 节点。翻面只对它有语义 —— 侧卡是「前后还有素材」的
    // 表达，规格 4.2 不给它们操作。
    function centerEl() {
      var n = d.nodes.filter(function (x) { return x.qi === d.index; })[0];
      return n ? n.el : null;
    }

    // noanim=true 用于「拖拽中复位」：那一下必须是瞬时的。若还播 .46s 的翻转，
    // 用户看到的是「卡片一边横移一边慢慢转回来」，像卡在两层之间。
    function setFlipped(el, on, noanim) {
      var fl = el.querySelector('.dc-flip');
      if (noanim && fl) {
        fl.classList.add('noanim');
        // 过渡被禁用的这段时间里把 transform 采纳掉，再恢复过渡属性；
        // 否则摘类那一次重算会把「rotateY(180deg) → none」判成一次新的过渡。
        void fl.offsetHeight;
      }
      el.classList.toggle('flipped', !!on);
      if (noanim && fl) global.requestAnimationFrame(function () { fl.classList.remove('noanim'); });
      var f = el.querySelector('.dc-front'), b = el.querySelector('.dc-back');
      if (f) f.setAttribute('aria-hidden', on ? 'true' : 'false');
      if (b) b.setAttribute('aria-hidden', on ? 'false' : 'true');
      el.setAttribute('aria-expanded', on ? 'true' : 'false');
      el.setAttribute('aria-label', on ? '收起设计说明总结' : '展开设计说明总结');
      syncTabs();     // 换了一面，可聚焦的按钮也跟着换（爱心 / 详情）
    }

    function renderNode(n) {
      var it = d.queue[n.qi];
      if (!it) { n.el.style.display = 'none'; n.itemId = 0; n.key = ''; n.btns = []; return; }
      var key = it.id + ':' + thumbKey(it.id);
      if (n.itemId === it.id && n.key === key) return;   // 内容与缩略图都没变，别动 DOM
      // **只有换素材才复位，同一条素材的重画要保留用户翻到的面。**
      // 缩略图是异步到的（cardsByIds 往返）：翻到背面之后它一回来就会重画一次，
      // 原来那句无条件 setFlipped(false) 会把用户刚翻开的背面无声地弹回正面 ——
      // 表现为「点了卡片没反应」，而且重试第二次就好了（图已经缓存过）。
      var same = n.itemId === it.id && isFlipped(n.el);
      n.itemId = it.id;
      n.key = key;
      n.el.setAttribute('data-item', String(it.id));
      n.el.innerHTML = deckCardHtml(it, d.thumbs[it.id]);
      // 缓存两面里的按钮：layout()/syncTabs() 每帧要按「是不是中央卡、当前哪一面」
      // 设它们的 tabIndex，在拖拽时每条 pointermove 都 querySelectorAll 一次没必要。
      n.btns = [].slice.call(n.el.querySelectorAll('.dc-heart,.dc-detail'));
      n.el.style.display = '';
      // 重画之后必须再调一次 setFlipped：新 DOM 上两面 aria-hidden 是「正面可见」的
      // 初值，不同步就会出现「类说在背面、aria 说在正面」。恒为瞬时（noanim）——
      // 这一下用户不该看到任何转动。节点被回收给另一条素材时 itemId 已被清零，
      // 所以 same 必为 false，仍会老老实实回到正面。
      // 顺序：先 display 再 setFlipped，因为 setFlipped 里的 syncTabs 要读 display。
      setFlipped(n.el, same, true);
    }

    // 窗口 = [index-BAND, index+BAND]。节点复用而不是每次重画九张：
    // 重画会让图重新解码、也会打断正在跑的过渡动画。
    function syncNodes() {
      var winStart = d.index - BAND, winEnd = d.index + BAND;
      var taken = {}, free = [];
      d.nodes.forEach(function (n) {
        if (n.qi >= winStart && n.qi <= winEnd && taken[n.qi] === undefined) taken[n.qi] = n;
        else free.push(n);
      });
      for (var q = winStart; q <= winEnd; q++) {
        var n = taken[q];
        if (!n) {
          n = free.shift();
          if (!n) break;
          n.qi = q;
          // 回收来的节点要先瞬移到位再恢复过渡，否则它会从牌堆一端「飞」到另一端。
          n.el.classList.add('noanim');
          (function (node) {
            global.requestAnimationFrame(function () { node.el.classList.remove('noanim'); });
          })(n);
        }
        n.el.style.display = '';
        renderNode(n);
      }
      free.forEach(function (n, k) {
        n.qi = winEnd + 1 + k;      // 停在窗口外，位置算出来也在视野外
        n.el.style.display = 'none';
        n.itemId = 0; n.key = ''; n.btns = [];
      });
    }

    function layout() {
      var v = d.dragX / d.geom.step;
      for (var i = 0; i < d.nodes.length; i++) {
        var n = d.nodes[i];
        if (n.el.style.display === 'none') continue;
        var e = (n.qi - d.index) + v;
        var ae = Math.abs(e);
        var s = 1 - ae * d.geom.shrink; if (s < .2) s = .2;
        var op = 1 - ae * d.geom.fade; if (op < 0) op = 0;
        n.el.style.transform = 'translateX(calc(-50% + ' + (e * d.geom.step).toFixed(2) + 'px))'
          + ' scale(' + s.toFixed(4) + ')';
        n.el.style.opacity = op.toFixed(3);
        n.el.style.zIndex = String(1000 - Math.round(ae * 100));
        // 这里**不再**给卡片写 pointer-events。卡片是透明的盒子、两个面把它盖满，
        // 真正的命中目标永远是「当前可见的那一面」（见 projects.css 的 .dc-face 段）。
        // 之前写过 `pointerEvents = center ? 'auto' : 'none'`，是个谎：面的 auto 会
        // 覆盖祖先的 none，侧卡照旧能接到点击 —— 实测就是「点侧卡也会翻面」。
        // 现在侧卡**故意**可点：点它是「我要看这一张」，由 click 处理器滚过去（goTo）。
        var center = ae < .5;
        n.el.tabIndex = center ? 0 : -1;
      }
      syncTabs();
    }

    // 可聚焦范围必须和「看得见 + 点得到」的范围一致，否则键盘用户会依次停在
    // 8 张看不见的侧卡上、或者停在翻到背面时正面那颗爱心上（那一面已经
    // pointer-events:none，但按钮仍在 Tab 序列里）。这条以前没人管，
    // 本轮加卡片键盘翻面时一起对齐（P2-11）。
    function syncTabs() {
      for (var i = 0; i < d.nodes.length; i++) {
        var n = d.nodes[i];
        var hidden = n.el.style.display === 'none';
        var flipped = n.el.classList.contains('flipped');
        for (var bi = 0; bi < n.btns.length; bi++) {
          var bEl = n.btns[bi];
          var onFront = bEl.classList.contains('dc-heart');
          var reachable = !hidden && n.qi === d.index && (onFront ? !flipped : flipped);
          bEl.tabIndex = reachable ? 0 : -1;
        }
      }
    }

    function ensureThumbs() {
      var need = [];
      for (var q = d.index - BAND; q <= d.index + BAND; q++) {
        var it = d.queue[q];
        if (it && !d.thumbs[it.id] && !d.asked[it.id]) { d.asked[it.id] = 1; need.push(it.id); }
      }
      if (!need.length) return;
      S.cardsByIds(need).then(function (rows) {
        (rows || []).forEach(function (r) { d.thumbs[r.id] = r; });
        need.forEach(function (id) { if (!d.thumbs[id]) d.thumbs[id] = {}; });
        syncNodes(); layout(); syncHearts();
      }).catch(function () {
        // 缩略图读不到不该挡住翻阅：卡片退化成「没有配图」的文案，其余照常。
        need.forEach(function (id) { if (!d.thumbs[id]) d.thumbs[id] = {}; });
        syncNodes(); layout();
      });
    }

    function syncHearts() {
      // 文案必须说真话：首页可能还没有「当前项目」，那时点下去是弹选择层，
      // 不是「收藏到本项目」。同一个词在两处指不同的东西，是最难查的一类错
      // （用户按字面理解去点，得到的却是另一个行为）。
      var to = HOME
        ? (CUR ? '收藏到「' + (CUR.name || '未命名项目') + '」' : '收藏到项目…')
        : '收藏到本项目';
      d.nodes.forEach(function (n) {
        if (!n.itemId) return;
        var h = n.el.querySelector('.dc-heart');
        if (!h) return;
        var on = !!d.collected[n.itemId];
        h.classList.toggle('on', on);
        h.setAttribute('aria-pressed', on ? 'true' : 'false');
        h.setAttribute('aria-label', on ? '取消收藏' : to);
        h.title = on ? '已收藏 · 再点取消' : to;
      });
    }

    function paint() {
      var total = d.queue.length;
      $('prog').textContent = total ? '第 ' + (d.index + 1) + ' / ' + total + ' 张' : '';
      $('prevBtn').disabled = d.index <= 0;
      $('nextBtn').disabled = d.index >= total - 1;
      var cn = d.order.length;
      $('dcount').innerHTML = '<b>' + cn + '</b> 条';
      $('mcount').textContent = '已收藏 ' + cn;
      $('dlist').innerHTML = d.order.map(function (id) {
        var it = d.index0[id];
        if (!it) return '';
        return '<button type="button" data-goto="' + id + '" title="'
          + esc(it.ai_title || '未命名') + '">' + esc(it.ai_title || '未命名') + '</button>';
      }).join('') || '<div class="dstat">还没有收藏。看到合适的，点卡片右下角的爱心。</div>';
    }

    // 跳到队列里的任意一张。三个入口共用它：拖拽松手、右下角上一张/下一张按钮、
    // 点旁侧卡。「先复位再翻页」（P2-11）的复位就写在这里 —— 唯一出入口，绕不过去。
    // 超界的目标 **clamp 到边界**而不是放弃：手机上拖了 2 格但队列只剩 1 张时，
    // 旧版直接 rebind（一张不翻、卡弹回原地），用户的感受是「拖了却没反应」。
    // 按钮/侧卡两个入口传进来的本来就是有效值，clamp 对它们没有影响。
    function goTo(ni) {
      if (ni < 0) ni = 0;
      if (ni > d.queue.length - 1) ni = d.queue.length - 1;
      if (ni === d.index) { rebind(); return; }
      var ce = centerEl();
      if (isFlipped(ce)) setFlipped(ce, false, true);
      d.index = ni;
      d.dragX = 0;
      cardsBox.classList.remove('dragging');
      syncNodes(); layout(); paint(); ensureThumbs();
    }
    function commit(dir) { goTo(d.index + dir); }
    function rebind() {
      d.dragX = 0;
      d.dragging = false;
      cardsBox.classList.remove('dragging');
      layout(); paint();
    }

    /* ---------- 惯性滑行（2026-09-23：一次滑动连续翻动） ---------- */
    // 松手 / 停滚时，若还有横向速度，就启动一段自主滑行：每帧按摩擦衰减速度、
    // 累积位移、走满一格就翻一张，速度降到阈值以下再 snap 回整格。手指/鼠标
    // 按下（onDown）或滚轮再次介入（wheel）都会立刻打断它，做到「按住即停」。
    function stopInertia() {
      if (!d.inertia) return;
      var raf = d.inertia.raf;
      if (raf) global.cancelAnimationFrame(raf);
      d.inertia = null;
    }
    function startInertia(v) {
      // v 单位 px/ms。方向由符号定；进入循环前先确保牌堆停在「整格余量」的
      // 起点上（dragX 已经是相对当前 index 的余量，见 onUp / wheelEnd 的调用点）。
      stopInertia();
      var s = v < 0 ? -1 : 1;
      var a = Math.abs(v);
      if (a > INERTIA_VMAX) a = INERTIA_VMAX;
      d.inertia = { v: a, s: s, t: 0, raf: 0 };
      var step = d.geom.step;
      // 滑行全程关过渡（卡片位置每帧由 layout 直写，关掉 .34s 过渡才跟手连续）。
      cardsBox.classList.add('dragging');
      function frame(ts) {
        var it = d.inertia;
        if (!it) return;                     // 已被打断
        var dt = it.t ? (ts - it.t) : 16;    // 首帧按 16ms 估算，避免 dt=0 算不出位移
        it.t = ts;
        it.v *= Math.pow(INERTIA_FRICT, dt); // 指数衰减，帧率无关
        if (it.v < INERTIA_STOP) { finishInertia(); return; }
        var dx = it.s * it.v * dt;
        d.dragX += dx;
        var pages = Math.trunc(d.dragX / step);
        if (pages !== 0) {
          var ni = d.index - pages;         // dragX<0（向左滑）→ pages<0 → index 变大
          var clamped = false;
          if (ni < 0) { ni = 0; clamped = true; }
          if (ni > d.queue.length - 1) { ni = d.queue.length - 1; clamped = true; }
          if (ni !== d.index) {
            d.dragX -= (d.index - ni) * step;  // 只消费真正翻过去的格数
            d.index = ni;
            syncNodes(); paint(); ensureThumbs();
          } else if (clamped) {
            // 已经滑到队尾（第一张或最后一张），再没有更多可翻：清余量并立即收尾。
            // 旧版这里 d.dragX=0 后继续循环，it.v 仍 > STOP 每帧又 += dx 又 clamp 回 0，
            // dragX 在 0 附近高频振荡，卡片在最后一张上反复抽动。
            d.dragX = 0;
            finishInertia();
            return;
          }
        }
        layout();
        it.raf = global.requestAnimationFrame(frame);
      }
      // 收尾：就近吸附，瞬时（noanim）。**不能走 rebind()**——rebind 会移除
      // .dragging 恢复 .34s 过渡，把「滑到两张中间的小数余量」慢慢弹回，真机看
      // 到的就是「卡片抽一下、像跳回前一张」。吸附必须在关过渡的状态下瞬时落位。
      function finishInertia() {
        if (d.inertia) {
          var r = d.inertia.raf;
          if (r) global.cancelAnimationFrame(r);
          d.inertia = null;
        }
        snap();
      }
      d.inertia.raf = global.requestAnimationFrame(frame);
    }
    // 惯性收尾的「就近吸附」：余量过半就顺方向补完一格（翻一张），不足半格就
    // 回到当前格。与拖拽/滚轮的收尾共用一个方向语义，但这里是**瞬时**的。
    // 注意：只清余量、改 index，最后 layout 时仍在 .dragging（关过渡）状态下，
    // 落位是瞬时的，之后调用方（如 wheelEnd）会各自恢复过渡。
    function snap() {
      var step = d.geom.step;
      var pages = Math.trunc(d.dragX / step);
      var rem = d.dragX - pages * step;       // 已走满的整格内的小数余量
      if (Math.abs(rem) >= step * .5) pages += (rem < 0 ? -1 : 1);  // 过半补一格
      if (pages !== 0) {
        var ni = d.index - pages;
        if (ni < 0) ni = 0;
        if (ni > d.queue.length - 1) ni = d.queue.length - 1;
        if (ni !== d.index) {
          d.index = ni;
          syncNodes(); paint(); ensureThumbs();
        }
      }
      d.dragX = 0;
      cardsBox.classList.remove('dragging');
      layout();
    }

    /* ---------- 跟手拖拽 ---------- */
    var pid = null, startX = 0, lastX = 0, lastT = 0;

    // 阻尼曲线：|dx| ≤ free 时 1:1 跟手；之后以指数曲线逐步减速，趋近 limit。
    // 旧版是硬截到 cap，手指还在走、牌却在同一位置顶死；这里不在任何一个
    // 像素点骤停，越拖越慢、最后自然靠近边界，手机长滑才会像翻页而非撞墙。
    function rubber(dx, free, k, limit) {
      var s = dx < 0 ? -1 : 1;
      var a = Math.abs(dx);
      if (a <= free) return dx;
      var range = Math.max(limit - free, 1);
      return s * (free + range * (1 - Math.exp(-((a - free) * k) / range)));
    }

    function onDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (d.queue.length < 2) return;
      if (e.target.closest && e.target.closest('.dc-heart')) return;   // 爱心自己处理
      pid = e.pointerId;
      // 手指/鼠标按下时打断惯性滑行（「按住即停」），并清掉挂着的滚轮手势：否则松手后
      // 130ms，那个定时器会拿着「上一次滚轮的位移」再 commit 一次，变成一次莫名其妙的翻页。
      stopInertia();
      if (wheelTimer) { clearTimeout(wheelTimer); wheelTimer = null; }
      wAcc = 0;
      d.dragging = true; d.dragX = 0; d.vel = 0;
      startX = lastX = e.clientX; lastT = Date.now();
      // 松手速度用「最近 120ms 的位移 ÷ 时间」算，不用最后一个采样点：
      // 真机上（尤其 iOS）手指松开前会自然减速，最后 8ms 窗口的瞬时速度远低于
      // 滑动主体的速度，惯性因此时强时弱。维护一个滚动样本窗口，松手时取窗口
      // 两端的平均，把「松手前的减速」平均掉。
      d.samples = [{ t: lastT, x: e.clientX }];
      cardsBox.classList.add('dragging');
      e.preventDefault();
    }
    function onMove(e) {
      if (!d.dragging || e.pointerId !== pid) return;
      var now = Date.now();
      var dt = now - lastT;
      // 速度样本只在 dt ≥ 8ms 时更新。理由：dt 很小时（合成事件里甚至是 0）
      // 会算出一个巨大的瞬时速度，把「手指轻轻一碰」判成甩动。
      if (dt >= 8) { d.vel = (e.clientX - lastX) / dt; lastX = e.clientX; lastT = now; }
      // 120ms 滚动窗口：每次 move 都推样本，扔掉太老的。松手时用窗口两端算平均速度。
      d.samples.push({ t: now, x: e.clientX });
      while (d.samples.length > 2 && now - d.samples[0].t > 120) d.samples.shift();
      // 位移不再硬截。原来截在 step×1.15 —— 手机档（step 44）就只有 52.9px，手指
      // 横移 5 毫米左右卡片就顶住不动了，用户真机实测的评价是「手感很钝」。
      // 现在改成：一格之内 1:1 跟手，超出后渐进减速并自然趋近三格距离。
      // 没有硬封顶，因此长滑不会在某个位置突然卡住；但阻尼仍会兜住「别把牌
      // 堆甩出屏幕」的边界。
      d.dragX = rubber(e.clientX - startX, d.geom.step, .4, d.geom.step * 3);
      // 位移一过 MOVED_PX 就确定「这是在拖，不是点」。此刻把翻面复位（瞬时），
      // 于是「先复位再翻页」天然成立：复位发生在判定翻页之前，而且拖动全程
      // 看到的都是正面。代价是「翻面状态下轻碰一下也会回到正面」——但 MOVED_PX
      // 是 5px，正常的点按碰不到，只有真的拖了才会。
      if (Math.abs(d.dragX) > MOVED_PX) {
        var ce = centerEl();
        if (isFlipped(ce)) setFlipped(ce, false, true);
      }
      layout();
    }
    // 松手速度：优先用 120ms 窗口的平均（抗「松手前减速」），窗口太短退回瞬时值。
    function flickVel() {
      var s = d.samples || [];
      if (s.length < 2) return d.vel || 0;
      var a = s[0], b = s[s.length - 1];
      var dt = b.t - a.t;
      if (dt < 16) return d.vel || 0;
      return (b.x - a.x) / dt;
    }
    function onUp(e) {
      if (!d.dragging || e.pointerId !== pid) return;
      d.dragging = false; pid = null;
      var dx = d.dragX;
      var dist = Math.abs(dx);
      var velNow = flickVel();
      // 手指真实走过的格数（用原始位移，不用 rubber 后的 dragX）：拖 2 格就该翻
      // 2 张。旧版松手只 commit 1 格，拖过的多余格数凭空消失——录屏实测就是
      // 「卡已经拖到下一张中央、松手却只翻一张弹回去」，这是「真机不对」的主因。
      var raw = Math.abs(e.clientX - startX);
      var pages = Math.max(1, Math.trunc(raw / d.geom.step));
      cardsBox.classList.remove('dragging');
      // 阈值：位移过了一格的 30%，或「甩」得够快。
      // 速度那一档额外要求 MIN_FLICK 的最小位移——没有它的话，手抖几个像素
      // 也会被当成甩动而翻页（速度是位移÷时间，位移小并不妨碍它很大）。
      // 两档都只用一个符号决定方向，左右完全对称，所以回弹感天然一致（P2-2b）。
      var far = dist >= d.geom.step * .3;
      var fast = dist >= MIN_FLICK && Math.abs(velNow) >= .38;
      var dir = 0;
      if (far || fast) {
        if (dx !== 0) dir = dx < 0 ? 1 : -1;
        else dir = velNow < 0 ? 1 : -1;
      }
      if (dist > MOVED_PX) d.movedAt = Date.now();     // 这一下手要吞掉随后的 click
      // 惯性：甩得够快（且方向明确）时，先按「拖过的格数」兑现，再从松手速度
      // 继续滑；否则维持原来的「翻格 / 回弹」收尾。惯性只认「有速度的甩动」，
      // 位移够大但手指是慢慢拖过去的（无速度）仍走老路径，不凭空多滑。
      if (dist >= MIN_FLICK && Math.abs(velNow) >= INERTIA_MIN) {
        if (dir) goTo(d.index + dir * pages);
        startInertia(velNow);
        return;
      }
      if (dir) goTo(d.index + dir * pages); else rebind();
    }
    function onCancel(e) {
      if (!d.dragging || e.pointerId !== pid) return;
      pid = null;
      rebind();
    }

    // 监听挂在 window 上、而不是用 setPointerCapture：
    //   ① 合成事件（验证台里要模拟拖拽）拿不到有效的 pointerId，capture 会抛；
    //   ② 手指滑出卡片区域时 window 一样收得到 pointermove。
    cardsBox.addEventListener('pointerdown', onDown);
    global.addEventListener('pointermove', onMove);
    global.addEventListener('pointerup', onUp);
    global.addEventListener('pointercancel', onCancel);

    /* ---------- 触控板 / 鼠标横向滚动 = 翻页（P2-2 的桌面等价操作） ---------- */
    // macOS 触控板双指左右滑发的是 **wheel 事件（deltaX）**，不是 pointer 拖拽，
    // 所以上面那套 pointerdown/move/up 完全收不到它。
    //
    // 2026-09-23 第二版。第一版把滚轮当成「一次甩动」：按 0.55 折算、位移用
    // rubber 封顶在 step×2、等 130ms 空闲再判一次翻页。用户实测报「不跟手、
    // 滑不过去」，用 CDP 打真实 wheel 量出来三条都成立：
    //   ① 跟手比只有 0.55，且随位移迅速掉到 0.31（40px→22px / 260px→106px）；
    //   ② 手指累计走 520px，牌堆在 164px 处**顶死不动**（撞 rubber 上限）；
    //   ③ 一次手势只翻一张卡。合起来才是「不跟手」+「滑不过去」。
    // 这一版把它当**连续滚动**（滚轮本来就是连续的），不再当甩动：
    //   · 位移 1:1 跟手，不封顶、不放大 —— deltaX 多少像素，牌堆就走多少像素；
    //   · 每走满一格（`--deck-step`，桌面 82px）就**当场**翻一张，余量留给下一张；
    //   · 不足一格的余量在空闲时回弹（与拖拽的「未达阈值回弹」同一个收尾）；
    //   · 惯性继续按同样的比例翻 —— 那是连续滚动的应有行为，不是 bug。
    var WHEEL_SCALE = 1;    // deltaX → 位移。1:1 才叫跟手（第一版 0.55 是「打折跟手」）。
                            // 想让一次手势翻得慢些就调小这个数（0.5 ≈ 手指走两格才翻一张）。
    var WHEEL_IDLE = 130;   // 多久没有新的 wheel 就当作手势结束（ms）
    var wAcc = 0, wheelTimer = null, wVel = 0, wLastX = 0, wLastT = 0;
    var stage = $('stage');

    function wheelEnd() {
      wheelTimer = null;
      cardsBox.classList.remove('dragging');
      wAcc = 0;
      // 停滚时若还有横向速度，接一段惯性滑行（触控板松手的那一下惯性）。速度采样
      // 在 wheel 处理里累积，这里判「够不够快、方向是否横向」，够就交给 startInertia。
      if (Math.abs(wVel) >= INERTIA_MIN) {
        var wv = wVel;
        wVel = 0;
        startInertia(wv);
        return;
      }
      wVel = 0;
      rebind();             // 不足一格的余量回弹到整格（翻页已经在滚的过程中发生了）
    }

    stage.addEventListener('wheel', function (e) {
      if (d.queue.length < 2) return;
      if (d.dragging) return;                       // 真手指在拖时不抢
      stopInertia();                                 // 滚轮再次介入 = 打断滑行（按住即停的桌面等价）
      var dx = e.deltaX, dy = e.deltaY;
      // deltaMode：0=像素（触控板）／1=行（部分鼠标）／2=页。统一折成像素。
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
      else if (e.deltaMode === 2) { dx *= 400; dy *= 400; }
      // 竖着滚就交给页面（背面那段长总结也要能滚）。判据是比较，不是固定阈值。
      if (Math.abs(dx) <= Math.abs(dy)) { wVel = 0; return; }
      e.preventDefault();                            // 顺手挡掉 Chrome 双指前进/后退

      var step = d.geom.step;
      // 滚轮速度采样：px/ms。dt 很小时会算出巨大瞬时速度，所以只在 dt ≥ 8ms 时更新
      // （与拖拽 onMove 同一套防抖理由）。
      var wnow = Date.now();
      if (wnow - wLastT >= 8) { wVel = (dx * WHEEL_SCALE) / (wnow - wLastT); wLastT = wnow; }
      wAcc += dx * WHEEL_SCALE;
      // 走满几格就翻几张。dx<0（向左滑）→ pages<0 → index 变大 → 看后面的素材。
      var pages = Math.trunc(wAcc / step);
      if (pages !== 0) {
        var ni = d.index - pages;
        if (ni < 0) ni = 0;
        if (ni > d.queue.length - 1) ni = d.queue.length - 1;
        if (ni !== d.index) {
          // 「先复位再翻页」（P2-11）：动的是静止态的牌堆，翻面必须先收掉。
          var wce = centerEl();
          if (isFlipped(wce)) setFlipped(wce, false, true);
          wAcc -= (d.index - ni) * step;             // 只消费真正翻过去的格数
          d.index = ni;
        } else {
          wAcc = 0;                                  // 已经到队列尽头，余量清零
        }
      }
      // 跟手期间关过渡（否则每帧都在追上一帧）。注意：翻页发生在一格刚好走满的
      // 那一刻，位移与新 index 互相抵消，所以关掉过渡也不会跳（位置是连续的）。
      d.dragX = wAcc;
      cardsBox.classList.add('dragging');
      if (pages !== 0) { syncNodes(); paint(); ensureThumbs(); }
      layout();
      if (wheelTimer) clearTimeout(wheelTimer);
      wheelTimer = setTimeout(wheelEnd, WHEEL_IDLE);
    }, { passive: false });

    // 详情页认这几个参数：回到同一个宿主、同一张卡（P2-6）。
    // 首页与项目翻阅页的差别只有「from 是谁」和「带不带 pid」：项目页带 pid
    // （回该项目），首页不带（全局牌堆与项目无关）。
    function openDetail(card) {
      var id = Number(card.getAttribute('data-item'));
      if (!id) return;
      var q = HOME ? '&from=home' : '&from=deck&pid=' + PID;
      global.location.href = BASE + 'item.html?id=' + id + q + '&i=' + d.index;
    }

    // 节点 → 队列序号。牌的 DOM 会被回收复用，所以按「哪个节点」反查，别按 data-item。
    function qiOf(card) {
      for (var i = 0; i < d.nodes.length; i++) if (d.nodes[i].el === card) return d.nodes[i].qi;
      return -1;
    }

    cardsBox.addEventListener('click', function (e) {
      var card = e.target.closest && e.target.closest('.d-card');
      if (!card) return;
      var qi = qiOf(card);
      var isCenter = qi === d.index;
      // 显式按钮（爱心／详情）只认中央卡，且排在「吞掉拖动后那一下 click」之前 ——
      // 否则刚拖完 400ms 内点它会没反应。
      var heart = isCenter && e.target.closest ? e.target.closest('.dc-heart') : null;
      if (heart) { toggleHeart(heart); return; }
      var det = isCenter && e.target.closest ? e.target.closest('.dc-detail') : null;
      if (det) { openDetail(card); return; }
      if (d.movedAt && Date.now() - d.movedAt < 400) { d.movedAt = 0; return; }
      // 旁侧卡 = 「我要看这一张」：把牌堆滚过去，**不翻它**。侧卡的两个面都只有
      // 一层意义（前面／后面还有素材，见规格 4.1），没有正反面可言。
      // 这条以前漏了，而侧卡又因为「面的 pointer-events:auto 覆盖了卡片的 none」
      // 仍然可点，点击就落到下面那句上 —— 用户实测表现：「点侧卡也会翻面，还翻不回来」。
      if (!isCenter) { if (qi >= 0) goTo(qi); return; }
      // 中央卡：点卡体＝翻面／翻回来（P2-4 改）。点卡体不再进详情。
      setFlipped(card, !isFlipped(card), false);
    });

    // 键盘等价操作：焦点在卡上时 Enter / 空格翻面。焦点在「详情」或爱心上时
    // 不拦——那两个是原生 button，浏览器自己会发 click。
    cardsBox.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (e.target !== e.target.closest('.d-card')) return;
      e.preventDefault();
      setFlipped(e.target, !isFlipped(e.target), false);
    });

    /* ---------- 收藏 / 取消收藏 ---------- */
    // 关键约束：store.saveProjectItem **不是幂等的**——同一条素材第二次写会撞
    // 唯一约束（DATABASE_23505）。所以同一个 itemId 只允许一个写入在飞，
    // 期间按钮 disabled。23505 若还是发生了（本地已收藏状态过期），把它
    // 当成「其实已经收藏了」处理，重新同步而不是报错。
    // 收藏写进哪个项目：项目翻阅页恒为 PROJECT；首页是用户选的「当前项目」。
    // 首页还没选项目时**不得静默收藏**（H0-4）—— 把选择权交回去（弹层），
    // 用户选完/建完再回来重放这一下点击。
    function heartTarget() { return HOME ? CUR : PROJECT; }

    function toggleHeart(btn) {
      var card = btn.closest('.d-card');
      var id = card && Number(card.getAttribute('data-item'));
      if (!id) return;
      if (!A.isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能收藏'); return; }
      if (d.inflight[id]) return;

      var T = heartTarget();
      if (!T) {
        if (o.onNeedProject) o.onNeedProject(id);
        else toast('先选一个项目，才能把这条收进去');
        return;
      }

      var was = !!d.collected[id];
      d.inflight[id] = 1;
      btn.disabled = true;

      // 先翻界面再发请求：点了立刻有反馈（P2-8 要求「明显反馈」），
      // 失败再翻回来。等 300ms 的往返回来才动，用户会以为没点到。
      if (was) delete d.collected[id]; else d.collected[id] = true;
      btn.classList.toggle('on', !was);
      btn.classList.remove('pop');
      void btn.offsetWidth;
      btn.classList.add('pop');
      toast(was ? '已取消收藏' : '已收藏到「' + (T.name || '未命名项目') + '」');

      var p = was ? S.removeProjectItem(T.id, id) : S.saveProjectItem(T.id, id);
      p.then(function () {
        if (was) {
          var k = d.order.indexOf(id);
          if (k >= 0) d.order.splice(k, 1);
        } else if (d.order.indexOf(id) < 0) {
          d.order.push(id);        // store 里新收藏的 sort_order 恒为「最大 +1」，所以排在最后
        }
      }, function (e) {
        var dup = /23505|duplicate key/i.test(String((e && e.message) || '') + String((e && e.details) || ''));
        if (dup && !was) {
          if (d.order.indexOf(id) < 0) d.order.push(id);   // 库里的确已经有了：跟上它
          toast('这一条早就在这个项目里了');
        } else {
          if (was) d.collected[id] = true; else delete d.collected[id];   // 翻回原状
          toast((was ? '取消收藏失败：' : '收藏失败：') + fmtErr(e));
        }
      }).then(function () {
        d.inflight[id] = 0;
        btn.disabled = false;
        syncHearts(); paint();
      });
    }

    /* ---------- 页面装配 ---------- */
    function emptyState() {
      var box = $('deckEmpty');
      $('cards').style.display = 'none';
      $('deckfoot').style.display = 'none';
      box.style.display = '';
      // 首页的牌堆就是全库、不过任何标签，所以「翻不出东西」只有一种原因：
      // 素材库本身是空的。这里没有工作台可回，也不该提「改筛选标签」——
      // 首页压根没有标签这回事，提了就是引导用户去找一个不存在的入口。
      if (HOME) {
        box.innerHTML = '<b>素材库还是空的</b>先收几条素材进来，这里才有得翻。'
          + '<div class="fthex"><a class="btn sm" href="' + BASE + 'add.html">收进一条灵感</a></div>';
        return;
      }
      var tags = (PROJECT.filter_tags || []);
      if (!d.index0count) {
        box.innerHTML = '<b>灵感库还是空的</b>先收几条素材进来，这里才有得翻。'
          + '<div class="fthex"><a class="btn sm" href="../add.html">收进一条灵感</a></div>';
      } else if (!d.queue.length) {
        box.innerHTML = '<b>这批标签下没有素材</b>'
          + '当前项目的筛选标签是：' + tags.map(function (t) { return esc(t); }).join('、')
          + '。库里没有素材命中其中任何一个。'
          + '<div class="fthex">'
            + '<a class="btn ghost sm" href="workspace.html?project=' + PID + '">回去改筛选标签</a>'
          + '</div>';
      } else {
        box.innerHTML = '<b>没有可翻阅的素材</b>'
          + '<div class="fthex"><a class="btn ghost sm" href="workspace.html?project=' + PID + '">回到工作台</a></div>';
      }
    }

    /* ---------- 头部：两种宿主唯一的差别集中在 applyHeader 里 ---------- */
    function applyHeader() {
      var P = HOME ? CUR : PROJECT;
      if (HOME && !P) {
        // 首页还没选「当前项目」。这几行不是装饰：此时爱心写不出去（H0-4），
        // 头部必须明说「未选择项目」，而不是借一个空名字假装有项目。
        $('dname').textContent = '未选择项目';
        $('dname2').textContent = '未选择项目';
        $('dname2').setAttribute('href', 'projects/index.html');
        $('hdrNote').textContent = '全库翻阅';
        $('dbrief').innerHTML = '<span class="empty">首页翻的是整个素材库。'
          + '点右下角爱心时会先让你选一个项目，之后的收藏就写进它。</span>';
        $('dtags').innerHTML = '<div class="picknone">还没选项目 · 点爱心时再选</div>';
        document.title = 'Elangit · 全库翻阅';
        return;
      }
      var name = (P && P.name) || '未命名项目';
      $('dname').textContent = name;
      $('dname2').textContent = name;
      if (HOME) {
        // 「当前项目」是首页的**临时**状态（不跨刷新，与 P2-9 同一条精神），
        // 它只活在这一次浏览里，所以这里不指向任何「正在看某个项目」的页面。
        $('dname2').setAttribute('href', 'projects/index.html');
      } else {
        $('dname2').setAttribute('href', 'workspace.html?project=' + PID);
      }
      $('hdrNote').textContent = name;
      $('dbrief').innerHTML = P.brief
        ? esc(P.brief) : '<span class="empty">还没有写构思。</span>';
      var tags = P.filter_tags || [];
      var chips = tags.length
        ? '<div class="chips">' + tags.map(function (t) { return C.tagChip(TAX, t, {}); }).join('') + '</div>'
        : '';
      if (HOME) {
        $('dtags').innerHTML = '<div class="picknone">收藏会写进「' + esc(name)
          + '」；首页翻的是全库，不按标签筛。</div>' + chips;
        document.title = 'Elangit · 全库翻阅';
      } else {
        $('dtags').innerHTML = chips || '<div class="picknone">没有选标签 · 翻阅全库</div>';
        document.title = name + ' · 快速翻阅 · Elangit';
      }
    }

    /* ---------- 首页专用：选 / 换 / 清空「当前项目」 ---------- */
    // cur=null 表示回到「未选择项目」。项目翻阅页调用它是空操作（返回已决 Promise）。
    function setCurrentProject(cur) {
      if (!HOME) return Promise.resolve(null);
      CUR = cur || null;
      d.curId = CUR ? CUR.id : 0;
      applyHeader();
      if (!CUR) {
        d.order = [];
        d.collected = {};
        syncHearts(); paint();
        return Promise.resolve(null);
      }
      // 换了收藏目标，爱心状态必须整套跟着换。否则在 A 项目里收藏过的素材切到 B
      // 之后还亮着，而 B 里其实没有它 —— 用户一点反而收到「早就收藏过了」。
      return S.listProjectItems(CUR.id).then(function (links) {
        d.order = (links || []).map(function (l) { return l.item_id; })
          .filter(function (id) { return !!d.index0[id]; });
        d.collected = {};
        d.order.forEach(function (id) { d.collected[id] = true; });
        syncHearts(); paint();
        return CUR;
      }).catch(function (e) {
        // 读不到就按「一条都没收」继续走，但要说出来：空着爱心与「本就没收藏」
        // 在界面上长得一样，不说就没法区分（同 ai_digest 那条原则）。
        d.order = [];
        d.collected = {};
        syncHearts(); paint();
        toast('读「' + (CUR.name || '未命名项目') + '」已收藏失败：' + fmtErr(e));
        return CUR;
      });
    }

    // 选择层选完项目后「重放那一下点击」。不合成 DOM 事件：直接走同一条写入
    // 路径（toggleHeart），否则「点爱心」这件事就有了两个入口，改一处必漏另一处。
    // 但语义是**保证收藏**，不是「翻转收藏状态」：弹层之前那一下点击发生时还没有
    // 当前项目，爱心必然是空心，用户的意思只有一个 —— 把这条收进去。若选中的项目
    // 里本来就有它，setCurrentProject 已经把它标成已收藏，这时再走 toggleHeart 就
    // 成了**取消收藏**：用户想收藏，结果东西被删出项目（验证台第一遍跑出来就是
    // 「3 → 2」）。所以先看已收藏就收手，并把「本来就有」说出来 —— 空着爱心与
    // 「本就没收藏」长得一样，不说用户分不清。
    function collectItem(id) {
      var n = null;
      for (var i = 0; i < d.nodes.length; i++) {
        if (d.nodes[i].itemId === id) { n = d.nodes[i]; break; }
      }
      if (!n) { toast('这一张已经翻过去了，滚回它再点爱心'); return; }
      if (d.collected[id]) {
        toast('「' + ((CUR && CUR.name) || '未命名项目') + '」里本来就有这一条');
        return;
      }
      var h = n.el.querySelector('.dc-heart');
      if (h) toggleHeart(h);
    }

    function getCurrentProject() { return CUR; }

    // 首页要用的三个入口挂到 deck 上：initDeck 的闭包在它返回之后依然活着，
    // 但模块级只能通过 deck 这个引用摸进去（deck 是 initDeck 里建的）。
    // 同时把 home / curId 记在 deck 上，验证台的 __deck() 才看得到。
    d.home = HOME;
    d.curId = 0;
    d.api = {
      setCurrentProject: setCurrentProject,
      collectItem: collectItem,
      getCurrentProject: getCurrentProject
    };

    /* ---------- 首帧装配：建九张卡并摆好 ---------- */
    // 两个宿主共用。里面藏着「收口必须同步」那个坑（见下方注释），抄第二份
    // 就等于给这个坑留第二个入口。
    function mountCards() {
      d.nodes = [];
      cardsBox.innerHTML = '';
      // 首次装配不配音效：卡的 CSS 默认 transform 是 none，而 layout() 会把它设成
      // translateX(calc(-50% + 0px))。若不禁用过渡，整叠牌会从「右偏半张卡宽」
      // （336/2=168px）在 .34s 里滑到居中——每次进翻阅页、含从详情页返回，都会
      // 滑一次。PRD 只要求拖拽/回弹/翻页有过渡，没有入场动效，这一滑是意外产物。
      cardsBox.classList.add('booting');
      for (var k = -BAND; k <= BAND; k++) {
        var el = document.createElement('div');
        el.className = 'd-card';
        cardsBox.appendChild(el);
        d.nodes.push({ el: el, qi: k, itemId: 0, key: '', btns: [] });
      }
      readGeom();
      // syncHearts 必须在这里跟着 syncNodes 一起跑：syncNodes 刚给每张牌定下
      // itemId，而 deckCardHtml 生成时写死的 title 是「收藏到本项目」—— 首页
      // 压根没有「本项目」。等缩略图回来才刷（原来只挂在 ensureThumbs 里）
      // 会让首帧到那一刻之间，爱心的提示与 aria-label 都是错的
      // （实测：那句话说了 0.2~0.8 秒，屏幕阅读器念到的就是它）。
      syncNodes(); layout(); syncHearts(); paint(); ensureThumbs();
      // 收口必须是**同步**的，不能等下一帧再摘类。原因：readGeom() 里的
      // getComputedStyle 已经强制过一次样式解析，那一次卡上的 transform 还是
      // none；若此刻仍带着过渡属性，后面任何一次重算都会把「none → 目标值」
      // 判成一次变更并打上 .34s 过渡（实测能只减半偏移，消不掉）。
      // 这里主动逼一次同步解析：让最终 transform 在过渡被禁用的状态下就被采纳，
      // 之后再摘类只是改 transition 属性、transform 不变，不会触发过渡。
      void cardsBox.offsetHeight;
      cardsBox.classList.remove('booting');
      $('deckNotes').textContent = d.queue.length === 1
        ? (HOME ? '素材库里只有这 1 条。' : '库里只有这 1 条符合当前筛选。') : '';
    }

    function boot() {
      // 首页：牌堆 = 全库，这一步不碰 projects / project_items（收藏态要等用户
      // 选了「当前项目」才去读，见 setCurrentProject）。
      if (HOME) {
        return Promise.all([S.loadTaxonomy(), S.loadIndex()]).then(function (r) {
          TAX = r[0];
          var all = r[1] || [];
          d.index0count = all.length;
          d.index0 = {};
          all.forEach(function (it) { d.index0[it.id] = it; });
          d.queue = all;          // 首页不过滤标签：先看见整个库有什么
          d.order = [];
          d.collected = {};
          // 进度不落库（P2-9）：只有「从详情页返回」会带上 i，其余一律从 0 开始。
          var wantH = qsNum('i', 0);
          d.index = Math.min(Math.max(0, wantH), Math.max(0, d.queue.length - 1));
          applyHeader();
          if (!d.queue.length) { emptyState(); return; }
          mountCards();
        });
      }
      if (!PID) {
        return Promise.reject(new Error(
          '地址里没有项目编号（应该形如 deck.html?project=1）。从项目列表或工作台点进来。'));
      }
      return Promise.all([S.loadTaxonomy(), S.fetchProject(PID), S.listProjectItems(PID), S.loadIndex()])
        .then(function (r) {
          TAX = r[0];
          PROJECT = r[1];
          if (!PROJECT) throw new Error('库里没有 #' + PID + ' 这个项目，可能已经被删了。');
          var links = r[2] || [];
          var all = r[3] || [];
          d.index0count = all.length;
          d.index0 = {};
          all.forEach(function (it) { d.index0[it.id] = it; });

          // 已收藏集合：关联表 ∩ items。库里已经删掉的素材不出现在列表里（P3-4）。
          d.order = links.map(function (l) { return l.item_id; })
            .filter(function (id) { return !!d.index0[id]; });
          d.collected = {};
          d.order.forEach(function (id) { d.collected[id] = true; });

          var tags = PROJECT.filter_tags || [];
          d.queue = all.filter(function (it) { return tagMatch(it, tags); });

          // 进度不落库（P2-9）：只有「从详情页返回」会带上 i，其余一律从 0 开始。
          var want = qsNum('i', 0);
          d.index = Math.min(Math.max(0, want), Math.max(0, d.queue.length - 1));

          // 头部（项目名 / 构思 / 标签 / 标题）统一交给 applyHeader：
          // 首页选「当前项目」之后要重画同一批元素，写两份一定漂移。
          applyHeader();

          if (!d.queue.length) { emptyState(); return; }
          mountCards();
        });
    }

    $('prevBtn').addEventListener('click', function () { commit(-1); });
    $('nextBtn').addEventListener('click', function () { commit(1); });
    $('dlist').addEventListener('click', function (e) {
      var b = e.target.closest('[data-goto]');
      if (!b) return;
      var id = Number(b.getAttribute('data-goto'));
      var k = d.queue.map(function (x) { return x.id; }).indexOf(id);
      if (k < 0) { toast('这一条不在当前筛选范围里，改标签后才能翻到'); return; }
      d.index = k; rebind();
    });
    // 桌面端的等价键盘操作（P2-2）。焦点在输入框里时不抢。
    document.addEventListener('keydown', function (e) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'ArrowLeft') { commit(-1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { commit(1); e.preventDefault(); }
    });
    // 转屏／改窗口宽度会换一套几何参数（CSS 里的媒体查询），必须重读并重排。
    global.addEventListener('resize', function () { readGeom(); layout(); });
    global.Elangit.onOwnerChange = function () {};

    OB.mount();
    boot().catch(function (e) {
      $('deErr').style.display = '';
      $('deErr').textContent = (HOME ? '读素材库失败：' : '读项目失败：') + fmtErr(e);
      $('cards').style.display = 'none';
      $('deckfoot').style.display = 'none';
    });
  }

  /* ============================================================
   * 五、首页 · 全库翻阅的非牌堆部分（根入口 index.html）
   * ------------------------------------------------------------
   * 牌堆本身在 initDeck({home:true}) 里装配（第四个宿主参数），这里只做
   * 首页独有的两件事：顶栏两个动作（新建项目 / 添加素材是纯链接）与
   * 「收藏到哪个项目」浮层。
   *
   * 浮层为什么必须存在（H0-4）：首页没有天然的项目上下文，爱心写不出去。
   * 静默收进「某个默认项目」是这里最坏的做法 —— 用户以为只是收藏，
   * 实际把素材塞进了上一次碰过的项目里，而且要翻到那个项目才发现。
   * 所以没有当前项目时不写库，先把选择权交回用户。
   * ============================================================ */

  function initHome() {
    // 通过对外对象拿 initDeck / setCurrentProject / collectItem：它们定义在
    // 本文件里，但 initDeck 的那几个入口活在 initDeck 的闭包里，只有这一条路。
    // 调用时对象已建好（initHome 由页面在脚本末尾调用），所以这里是安全的。
    var API = global.Elangit.projects;

    var picker = $('picker'), pList = $('pList'), pArch = $('pArch'), pMore = $('pMore'),
        pForm = $('pForm'), pNewRow = $('pNewRow'), pName = $('pName'), pNote = $('pNote');

    var pending = 0;     // 这次打开浮层是为了收藏哪一条（0 = 只是新建 / 切换项目）
    var rows = [];       // 最近一次读到的项目行
    var counts = {};     // 每个项目的已收藏数
    var archOpen = false;
    var busy = false;

    function isOwner() { return A.isOwner(); }

    function rowHtml(p) {
      var n = counts[p.id];
      var cnt = n == null ? '收藏数读不到' : '已收藏 ' + n + ' 条';
      return '<button class="hsel-p' + (p.status === 'archived' ? ' is-archived' : '') + '"'
        + ' type="button" data-pid="' + p.id + '">'
        + '<span class="pn">' + esc(p.name || '未命名项目') + '</span>'
        + statusBadge(p)
        + '<span class="pc">' + cnt + '</span>'
        + '</button>';
    }

    function loadProjects() {
      pList.innerHTML = '<div class="hsel-loading">读取项目…</div>';
      pArch.innerHTML = '';
      return S.listProjects().then(function (list) {
        rows = list || [];
        // 每个项目的已收藏数：一次一发 listProjectItems。理由与项目列表页一致
        // （store.js 没有「按项目分组计数」，单用户工具的项目数是个位数）。
        return Promise.all(rows.map(function (p) {
          return S.listProjectItems(p.id).then(function (its) {
            counts[p.id] = (its || []).length;
          }, function () { counts[p.id] = null; });
        }));
      }).then(render).catch(function (e) {
        pList.innerHTML = '<div class="hsel-loading">读项目失败：' + esc(fmtErr(e)) + '</div>';
      });
    }

    function render() {
      var act = rows.filter(function (p) { return p.status !== 'archived'; });
      var arch = rows.filter(function (p) { return p.status === 'archived'; });
      if (!rows.length) {
        pList.innerHTML = '<div class="hsel-loading">还没有项目。新建一个，'
          + '把想收的素材往一个方向收一收。</div>';
      } else if (!act.length) {
        // 项目全归档了。这时仍然要能选（往归档项目里补素材是合理操作），
        // 但必须说清楚「进行中的一个都没有」，否则用户会以为列表坏了。
        pList.innerHTML = '<div class="hsel-loading">进行中的项目一个都没有，'
          + '已归档的 ' + arch.length + ' 个在下面。</div>';
      } else {
        pList.innerHTML = act.map(rowHtml).join('');
      }
      if (arch.length) {
        pMore.hidden = false;
        pMore.textContent = archOpen
          ? '收起已归档项目' : '显示已归档项目（' + arch.length + '）';
        pMore.setAttribute('aria-expanded', archOpen ? 'true' : 'false');
        pArch.hidden = !archOpen;
        pArch.innerHTML = archOpen ? arch.map(rowHtml).join('') : '';
      } else {
        pMore.hidden = true;
        pArch.hidden = true;
        pArch.innerHTML = '';
      }
    }

    function openPicker(itemId, withForm) {
      pending = itemId || 0;
      archOpen = false;
      pForm.hidden = !withForm;
      pNewRow.hidden = !!withForm;
      pName.value = '';
      pNote.textContent = pending
        ? '这一条先没有收藏 —— 因为还没选项目。选一个已有的，或新建一个；'
          + '选好之后这一条就收进它。'
        : '选一个项目作为「当前项目」：之后的收藏都写进它。'
          + '首页翻的仍是整个素材库，不受这个选择影响。';
      picker.classList.add('on');
      picker.setAttribute('aria-hidden', 'false');
      loadProjects();
    }

    function closePicker() {
      picker.classList.remove('on');
      picker.setAttribute('aria-hidden', 'true');
      pending = 0;
      busy = false;
    }

    function choose(pid) {
      if (busy) return;
      var p = rows.filter(function (x) { return x.id === pid; })[0];
      if (!p) return;
      busy = true;
      var item = pending;                 // closePicker() 会清掉 pending，先留一份
      closePicker();
      API.setCurrentProject(p).then(function () {
        toast('当前项目：' + (p.name || '未命名项目'));
        if (item) API.collectItem(item);  // 选完重放那一下爱心（走同一条写入路径）
      }).catch(function (e) {
        toast('切换项目失败：' + fmtErr(e));
      }).then(function () { busy = false; });
    }

    function create() {
      if (busy) return;
      if (!isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能建项目'); return; }
      busy = true;
      var item = pending;
      // 名称留空的归一化在 store 里（projectPatch → projectName），页面不复刻这份规则。
      S.createProject({ name: pName.value }).then(function (p) {
        rows.push(p);
        counts[p.id] = 0;
        closePicker();
        return API.setCurrentProject(p).then(function () {
          toast('已建立「' + (p.name || '未命名项目') + '」，并且是当前项目');
          if (item) API.collectItem(item);
        });
      }).catch(function (e) {
        toast('建立失败：' + fmtErr(e));
      }).then(function () { busy = false; });
    }

    picker.addEventListener('click', function (e) {
      if (e.target === picker) { closePicker(); return; }        // 点遮罩 = 关
      if (e.target.closest('#pMore')) { archOpen = !archOpen; render(); return; }
      if (e.target.closest('#pNew')) {
        pForm.hidden = false; pNewRow.hidden = true; pName.focus(); return;
      }
      if (e.target.closest('#pCancel')) {
        pForm.hidden = true; pNewRow.hidden = false; return;
      }
      if (e.target.closest('#pGo')) { create(); return; }
      var p = e.target.closest('[data-pid]');
      if (p) choose(Number(p.getAttribute('data-pid')));
    });

    // Esc 关浮层。牌堆那边只管 ← →，两边不冲突。
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && picker.classList.contains('on')) closePicker();
    });

    // 顶栏「新建项目」：打开同一个浮层，但直接展开命名输入 ——
    // 「新建」和「收藏时新建」共用一套创建逻辑，只差要不要重放那次收藏。
    $('newBtn').addEventListener('click', function () {
      if (!isOwner()) { toast('只读浏览：点右上角「解锁编辑」后才能建项目'); return; }
      openPicker(0, true);
      pName.focus();
    });
    var sw = $('pickBtn'), sw2 = $('pickBtn2');
    if (sw) sw.addEventListener('click', function () { openPicker(0, false); });
    if (sw2) sw2.addEventListener('click', function () { openPicker(0, false); });

    API.initDeck({
      home: true,
      onNeedProject: function (id) { openPicker(id, false); }
    });
  }

  /* ============================================================
   * 对外接口
   * ============================================================ */
  global.Elangit = global.Elangit || {};
  global.Elangit.projects = {
    initList: initList,
    initWorkspace: initWorkspace,
    initDeck: initDeck,
    // 根入口 index.html（全库翻阅首页）。它内部会自己调用 initDeck({home:true})。
    initHome: initHome,
    // 首页专用（index.html）。三个都只在 initDeck({home:true}) 之后才有意义：
    //   setCurrentProject(p) —— 选定 / 切换 / 清空「当前项目」（p 传 null 清空）；
    //   collectItem(id)      —— 选择层选完项目后重放那一下爱心（走同一条写入路径）；
    //   getCurrentProject()  —— 读回当前项目行（选择层自己也要知道现在选的是谁）。
    // 项目翻阅页调用它们全是空操作，不会改行为。
    setCurrentProject: function (p) {
      return deck && deck.api ? deck.api.setCurrentProject(p) : Promise.resolve(null);
    },
    collectItem: function (id) { if (deck && deck.api) deck.api.collectItem(id); },
    getCurrentProject: function () { return deck && deck.api ? deck.api.getCurrentProject() : null; },
    // 一次性验证台（_verify_projects.html / _verify_home_ui.html）用的只读探针。
    // 只读、不改状态，且验证页本身带 _verify_ 前缀，不会进发布件。
    __deck: function () {
      if (!deck) return null;
      return {
        // home / cur 是 2026-09-23 首页重构加的：验证台要靠它判「这次装配的
        // 是哪个宿主」「当前项目是谁」。只增不改，老断言读的字段一律原样保留。
        home: !!deck.home,
        cur: deck.curId,
        index: deck.index,
        total: deck.queue.length,
        geom: { cw: deck.geom.cw, step: deck.geom.step, shrink: deck.geom.shrink, fade: deck.geom.fade },
        queue: deck.queue.map(function (it) { return it.id; }),
        // 正面/背面的状态直接读 DOM 上的类，不另存一份（见 setFlipped 的说明）。
        // 验证台要判「拖动后有没有复位」，读这个比读 opacity 之类的视觉特征可靠。
        flipped: (function () {
          var n = deck.nodes.filter(function (x) { return x.qi === deck.index; })[0];
          return !!n && n.el.classList.contains('flipped');
        })(),
        collected: Object.keys(deck.collected).map(Number),
        order: deck.order.slice(),
        nodes: deck.nodes.map(function (n) {
          var r = n.el.getBoundingClientRect();
          return {
            qi: n.qi, itemId: n.itemId || 0, hidden: n.el.style.display === 'none',
            opacity: Number(n.el.style.opacity), z: Number(n.el.style.zIndex) || 0,
            cx: r.left + r.width / 2, top: r.top, w: r.width, h: r.height
          };
        })
      };
    }
  };
})(window);
