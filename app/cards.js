/* ============================================================
 * Elangit · 素材外观的公共渲染
 * ------------------------------------------------------------
 * 抽出来的原因很具体：素材卡片的信息顺序（抽屉 + 日期同一行 →
 * 项目名 → 摘要 + 标签 → 操作条）是**用户按自己扫读习惯指定的**，
 * 侧栏配色又是设计令牌。这两样一旦出现第二份拷贝，改一处忘一处
 * 就会让「灵感库」和「分享页」长得不一样——而分享页恰恰是给外人
 * 看的那一面，最不该跟主站不一致。
 *
 * 这里只做「把一条素材变成 HTML」，不碰网络、不碰状态、不碰权限。
 * 因此 index.html（私有）与 share.html（只读分享）可以共用同一份。
 *
 * 对外接口：
 *   Elangit.cards.esc / fmtTime / toDataUrl
 *   Elangit.cards.tagChip(tax, name, {on, count})
 *   Elangit.cards.counts(index)                       -> {cat:{}, tag:{}}
 *   Elangit.cards.navCatsHtml(tax, index, activeCat)
 *   Elangit.cards.navTagsHtml(tax, index, activeTags)
 *   Elangit.cards.cardHtml(it, thumbRow, tax, {openAct})
 *   Elangit.cards.haystack(it) / matches(it, {cat, tags, q})
 *   Elangit.cards.refreshTagScroll(root)              重算标签行「能不能滚」（含拖动）
 *   Elangit.cards.emptyHtml(indexLen, filtering)
 *   Elangit.cards.countText(shown, total)
 * ============================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(iso, withTime) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var m = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
    var s = d.getFullYear() + '-' + m + '-' + dd;
    if (withTime) s += ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return s;
  }

  function toDataUrl(mime, base64) {
    return 'data:' + (mime || 'image/jpeg') + ';base64,' + base64;
  }

  /* ---------- 标签 ---------- */

  // 颜色存在分组上，不存标签上（PRD Q-E：按用途分组、同组同色）
  function tagStyle(tax, name) {
    var c = (tax && tax.tagColor && tax.tagColor[name]) || null;
    return c ? 'color:' + c.c + ';background:' + c.bg : 'color:var(--ink-2);background:#F1EFEB';
  }

  function tagChip(tax, name, o) {
    o = o || {};
    return '<span class="chip' + (o.on ? ' on' : '') + '" data-tag="' + esc(name) + '" style="' + tagStyle(tax, name) + '">'
      + esc(name) + (typeof o.count === 'number' ? '<span class="c">' + o.count + '</span>' : '') + '</span>';
  }

  function counts(index) {
    var cat = {}, tag = {};
    (index || []).forEach(function (it) {
      cat[it.category || ''] = (cat[it.category || ''] || 0) + 1;
      (it.ai_tags || []).concat(it.my_tags || []).forEach(function (t) {
        tag[t] = (tag[t] || 0) + 1;
      });
    });
    return { cat: cat, tag: tag };
  }

  function navCatsHtml(tax, index, activeCat) {
    var cc = counts(index).cat;
    // 空抽屉不显示（PRD 第 8 章）；但当前选中的一定保留，
    // 否则选中之后它就消失了，没法取消。
    var cats = (tax.categories || []).filter(function (c) {
      return cc[c.name] || activeCat === c.name;
    });
    var html = '<button class="nav-item' + (activeCat === '全部' ? ' on' : '') + '" data-cat="全部">'
      + '<span class="n">全部素材</span><span class="c">' + (index || []).length + '</span></button>';
    return html + cats.map(function (c) {
      return '<button class="nav-item' + (activeCat === c.name ? ' on' : '') + '" data-cat="' + esc(c.name) + '">'
        + '<span class="n">' + esc(c.name) + '</span><span class="c">' + (cc[c.name] || 0) + '</span></button>';
    }).join('');
  }

  function navTagsHtml(tax, index, activeTags) {
    var tc = counts(index).tag;
    activeTags = activeTags || [];
    var has = function (t) { return tc[t] || activeTags.indexOf(t) >= 0; };

    var groups = (tax.groups || []).filter(function (g) {
      return (tax.tags || []).some(function (t) {
        var c = tax.tagColor[t];
        return c && c.group === g.name && has(t);
      });
    });

    var html = groups.map(function (g) {
      var tags = (tax.tags || []).filter(function (t) {
        var c = tax.tagColor[t];
        return c && c.group === g.name && has(t);
      });
      return '<div class="taggroup"><h4><i style="background:' + g.color + '"></i>' + esc(g.name) + '</h4>'
        + '<div class="chips">'
        + tags.map(function (t) { return tagChip(tax, t, { on: activeTags.indexOf(t) >= 0, count: tc[t] }); }).join('')
        + '</div></div>';
    }).join('');

    // AI 新造的标签只写在素材上、不进标签库（技术方案 3.5：标签是开放集合，
    // 存名字免一次写入）。但那样它们既没有颜色、也不会出现在侧栏，结果是
    // 「刚存的内容按标签筛不到」——F4-3 会静默漏掉。所以单独列一组。
    // 附带好处：这一组同时就是标签发散的观察窗，A13 复盘时直接看它。
    var dict = {};
    (tax.tags || []).forEach(function (t) { dict[t] = 1; });
    var orphans = Object.keys(tc).filter(function (t) { return !dict[t]; })
      .sort(function (a, b) { return tc[b] - tc[a]; });
    if (orphans.length) {
      html += '<div class="taggroup"><h4><i style="background:#918D84"></i>未分组（AI 新造）</h4>'
        + '<div class="chips">'
        + orphans.map(function (t) { return tagChip(tax, t, { on: activeTags.indexOf(t) >= 0, count: tc[t] }); }).join('')
        + '</div></div>';
    }
    return html;
  }

  /* ---------- 卡片 ---------- */

  function cardHtml(it, thumbRow, tax, opts) {
    ensureTagScroll();      // 幂等：第一次渲染卡片时把标签行拖动接上
    opts = opts || {};
    var c = thumbRow || {};
    var hasThumb = !!c.cover_thumb;
    var plat = it.source_platform
      || (c.source_platform ? c.source_platform : '');   // 索引里没带平台时用卡片行兜底

    var thumb;
    if (hasThumb) {
      // 缩略图这里刻意不再挂点击事件：一张卡片上两个大点击区
      // （图 = 看原图、其余 = 进详情）会让人猜不准。统一为「点卡片进详情」，
      // 看原图走显式按钮（F5-7 要求的是「有入口」，不是「图本身是入口」）。
      thumb = '<div class="cthumb">'
        + '<img src="' + toDataUrl('image/jpeg', c.cover_thumb) + '" alt="" loading="lazy">'
        + (plat ? '<span class="plat">' + esc(plat) + '</span>' : '')
        + (it.status === 'pending' ? '<span class="stag st pending"><span class="spin"></span>识别中</span>' : '')
        + (it.status === 'failed' ? '<span class="stag st failed">待补</span>' : '')
        + '</div>';
    } else if (it.status === 'pending') {
      thumb = '<div class="cthumb notxt"><p><span class="spin"></span> 正在读这条素材…</p></div>';
    } else if (it.source_url) {
      // 存了链接但没抓到封面（P1-1）。文案要说清「不是坏了」并指路原文——
      // 原来这里和无图素材共用一句话，于是整整一屏灰块看着像加载失败。
      thumb = '<div class="cthumb notxt"><p>这条来自原文链接<br>没抓到封面，可点开看原文</p></div>';
    } else {
      // F3-2：无图也要出卡片，不能是空白占位
      thumb = '<div class="cthumb notxt"><p>这条没有配图<br>纯文本素材照样进库</p></div>';
    }

    // 卡片上放**全部**标签，单行不换行、超宽时横向滚动（2026-09-22 第二版）。
    //
    // 上一版是「只放 3 个 + 灰色 +N」，理由是「3 个最坏 230px，留 28px 给余数，
    // 一行永远放得下」。那个算术没错，但**结论错了**：折行确实要防，可防法不该是
    // 把标签丢掉——用户看不到第 4、5 个标签，于是报「标签被遮挡」。
    //
    // 现在改成：标签全放，`.ctags` 单行 `overflow-x:auto`。卡片高度因此恒为 22px，
    // 与标签个数无关（折行错位的问题一样解决了），而藏起来的标签**滑一下就能看到**。
    // 「还有更多」的提示交给右边缘渐隐（见 style.css 的 `.ctags.can-scroll`），
    // 不再塞一个 `+N`——它和被滑出来的那几个是同一批东西，重复表达只会更乱。
    var tags = (it.ai_tags || []).concat(it.my_tags || []);
    var title = (it.ai_title || '').trim();
    var act = opts.openAct || 'open';

    return '<div class="card" data-id="' + it.id + '" data-act="' + act + '" title="点卡片看详情">'
      + thumb
      // 抽屉 + 收藏日期同一行；日期原来在底部操作条，是用户按扫读习惯挪上来的
      + '<div class="crow-cat"><span>' + esc(it.category || '未归类') + '</span>'
        + '<span class="sp"></span>'
        + '<span class="date">' + esc(fmtTime(it.created_at)) + '</span>'
      + '</div>'
      // 项目名。AI 判不出就留着这一行显示「未命名」而不是把它藏起来——
      // 藏起来的话，卡片上就没有任何提示告诉你去补一个名字。
      + '<div class="ctitle' + (title ? '' : ' noname') + '">'
        + (title ? esc(title) : '未命名') + '</div>'
      + '<div class="cbody">'
        + '<div class="csum' + (it.ai_summary ? '' : ' empty') + '">'
          // 没拿到 AI 摘要时拿 raw_text 顶一下。60 字不是字数（2026-09-22 第三轮）：
          // 之前是 80，3 行放不下（实测 xhs 链接那条 86 字被压到第 4 行，被截掉一半
          // 看着像"坏了"）；60 字=3 行下差不多放满，截不断。
          + (it.ai_summary ? esc(it.ai_summary) : (it.raw_text ? esc(it.raw_text.slice(0, 60)) : '（没有文字内容）'))
        + '</div>'
        + '<div class="ctags">' + tags.map(function (t) { return tagChip(tax, t, {}); }).join('')
        + '</div>'
      + '</div>'
      + '<div class="cmrow">'
        + (opts.actions != null ? opts.actions : cardActions(it, c, opts))
      + '</div>'
    + '</div>';
  }

  // 卡片底部操作条。两种形态都收在这一处，页面不自己拼按钮——
  // 否则「私有视图有看原图、分享视图忘了去掉」这类差异会散落各处。
  function cardActions(it, c, opts) {
    if (opts.readOnly) return '<span class="muted">只读分享 · 点卡片看详情</span>';
    // cover_source === 'link' 的封面是从原文网页抓来的图，库里**没有**原件：
    // 「看原始截图」点开只会得到「这条没有图片」（openShot 读的是 item_images）。
    // 所以按封面来源决定给不给这个按钮，而不是只要有缩略图就给。
    var hasOriginals = c.cover_thumb && c.cover_source !== 'link';
    return (hasOriginals ? '<button class="linkbtn" data-act="shot" data-id="' + it.id + '">看原始截图</button>' : '')
      + (it.source_url ? '<a class="linkbtn" href="' + esc(it.source_url) + '" target="_blank" rel="noopener">原文</a>' : '')
      + (c.cover_thumb || it.source_url ? '' : '<span class="muted">没有原图也没有链接</span>');
  }

  /* ---------- 卡片标签行的横向滚动（2026-09-22） ---------- */

  // 为什么需要这一段：`.ctags` 现在是 overflow-x:auto。触摸屏的横向滑动浏览器
  // 本来就给了，不用管；但**桌面鼠标没有横向滚动手势**——滚轮滚的是页面纵向，
  // 于是后面的标签在电脑上根本够不着。这里只补浏览器没给的那两件事：
  //   1. 鼠标按住标签行左右拖 = 改 scrollLeft；
  //   2. 拖动之后那一下 click 必须丢掉，否则鼠标一滑，卡片就跳进详情页。
  //      （卡片点击是 document 冒泡阶段代理的，见 index.html；hover 高亮与
  //      整块点击区让这个冲突变成必然，不是理论风险。）
  //
  // 为什么**不**接管触摸：触摸端若 preventDefault，会跟浏览器原生惯性滚动打架，
  // 而且 iOS 在开始滚动后会发 pointercancel、不再给 pointermove，写一半更脆。
  // 交给 `overflow-x:auto` 原生处理，行为与系统一致。
  var DRAG_SLOP = 6;      // 位移小于此值算「点」，不接管，免得吃掉正常点击
  var draggedAt = 0;      // 最近一次拖动松手的时间，用来吞掉紧随其后的 click
  var tagScrollBound = false;

  function syncTags(el) {
    var over = el.scrollWidth - el.clientWidth;
    el.classList.toggle('can-scroll', over > 1);
    el.classList.toggle('at-start', el.scrollLeft <= 1);
    el.classList.toggle('at-end', over > 1 && el.scrollLeft >= over - 1);
  }

  // root 必须是**包含** .ctags 的祖先（拖动时传 el.parentNode）
  function refreshTagScroll(root) {
    if (!root) return;
    var list = root.querySelectorAll ? root.querySelectorAll('.ctags') : [];
    for (var i = 0; i < list.length; i++) syncTags(list[i]);
  }

  // 为什么要 MutationObserver，而不是让各页面渲染完自己调一次：
  // 卡片是「整块 innerHTML 重画」的（搜索、切筛选、翻页都会重画），
  // 每处重画都得记得调一次同步——漏掉一处，那一屏的标签就没有渐隐提示。
  // 这里只处理**新增节点**里的 .ctags，不做全页重算：全页重算会在每帧对
  // 每张卡强制一次布局（20 张卡 = 20 次），而卡片重画的频率并不低。
  //
  // 由 cardHtml 首次调用时装上（见函数末尾）。这样 index / share / stats
  // 三个页面都不用各自记得接一次——少一个「新页面忘了接」的失败模式。
  function ensureTagScroll() {
    if (tagScrollBound || !document.body) return;
    tagScrollBound = true;

    var el = null, startX = 0, startLeft = 0, moved = false;

    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      var box = e.target.closest && e.target.closest('.ctags');
      if (!box) return;
      if (box.scrollWidth - box.clientWidth <= 1) return;   // 没得滚就别接管
      el = box; startX = e.clientX; startLeft = box.scrollLeft; moved = false;
      box.classList.add('dragging');
      e.preventDefault();                                   // 否则一拖就是整片文字选中
    });

    document.addEventListener('pointermove', function (e) {
      if (!el || e.pointerType !== 'mouse') return;
      var dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_SLOP) return;
      moved = true;
      el.scrollLeft = startLeft - dx;
      syncTags(el);
    });

    function endDrag() {
      if (!el) return;
      el.classList.remove('dragging');
      if (moved) draggedAt = Date.now();
      el = null; moved = false;
    }
    document.addEventListener('pointerup', endDrag);
    document.addEventListener('pointercancel', endDrag);

    // 触摸端横滑由浏览器原生滚动（不能 preventDefault），但仍需标记它是一次
    // 横向浏览而不是「点卡片」。否则少量机型会在原生滚动结束后补发 click，
    // 冒泡到素材卡后打开详情，用户感觉成了「一滑标签就触发卡片」。
    var touch = null;
    document.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      var box = e.target.closest && e.target.closest('.ctags');
      if (!box || box.scrollWidth - box.clientWidth <= 1) return;
      touch = { pid: e.pointerId, x: e.clientX, moved: false };
    });
    document.addEventListener('pointermove', function (e) {
      if (!touch || e.pointerId !== touch.pid) return;
      if (Math.abs(e.clientX - touch.x) >= DRAG_SLOP) touch.moved = true;
    });
    function endTouch(e) {
      if (!touch || e.pointerId !== touch.pid) return;
      if (touch.moved) draggedAt = Date.now();
      touch = null;
    }
    document.addEventListener('pointerup', endTouch);
    document.addEventListener('pointercancel', endTouch);

    // 捕获阶段拦下拖动之后的那一下 click。用捕获而不是冒泡：index.html 的
    // 卡片点击挂在 document 冒泡阶段，同层同阶段时谁先跑由注册顺序决定，
    // 靠顺序太脆；捕获必然先于冒泡，与注册顺序无关。
    document.addEventListener('click', function (e) {
      if (!draggedAt || Date.now() - draggedAt > 400) return;
      draggedAt = 0;
      e.stopPropagation();
      e.preventDefault();
    }, true);

    // 原生滚动（触摸端）也要更新渐隐。scroll 事件不冒泡，但**捕获阶段**能拿到，
    // 所以在 document 上捕获。缺这一条的话：手指滑到最右，`at-end` 不会被置上，
    // 右边缘渐隐一直挂着——最后一个标签看着像被切掉了，而它其实是完整的。
    document.addEventListener('scroll', function (e) {
      var t = e.target;
      if (t && t.classList && t.classList.contains('ctags')) syncTags(t);
    }, true);

    // 换列数/转屏之后「能不能滚」会变，重算一次
    global.addEventListener('resize', function () { refreshTagScroll(document); });

    if (global.MutationObserver) {
      new MutationObserver(function (recs) {
        for (var i = 0; i < recs.length; i++) {
          var added = recs[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n.nodeType !== 1) continue;
            if (n.classList && n.classList.contains('ctags')) syncTags(n);
            else refreshTagScroll(n);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  /* ---------- 检索 ---------- */

  function haystack(it) {
    if (it._hay != null) return it._hay;
    // page_title 也进来：存链接的素材，原文标题里有 AI 收敛掉的信息（作者、地点），
    // 「搜工作室名」是这套库的真实用法。ai_digest（设计说明总结，2026-09-22）
    // 同理：正文里的做法与材料名大多落在那里，搜「夯土」「模块化」该命中它。
    it._hay = [it.ai_title, it.page_title, it.ai_summary, it.ai_digest, it.ai_caption, it.ocr_text,
      it.raw_text, it.my_note,
      it.category, (it.ai_tags || []).join(' '), (it.my_tags || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    return it._hay;
  }

  function matches(it, f) {
    if (f.cat && f.cat !== '全部' && it.category !== f.cat) return false;
    if (f.tags && f.tags.length) {
      var all = (it.ai_tags || []).concat(it.my_tags || []);
      // 多标签之间是「与」——界面稿一致：点得越多，范围越窄
      for (var i = 0; i < f.tags.length; i++) if (all.indexOf(f.tags[i]) < 0) return false;
    }
    if (f.q) {
      if (haystack(it).indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  function emptyHtml(indexLen, filtering, opts) {
    opts = opts || {};
    if (!indexLen) {
      return opts.canAdd
        ? '<b>灵感库还是空的</b>存下第一条，从这里开始积累'
          + '<div style="margin-top:16px"><a class="btn sm" href="add.html">收进第一条灵感</a></div>'
        : '<b>还没有可看的内容</b>等所有者收进第一条素材，这里就有东西了';
    }
    return '<b>没找到</b>试试换个词，或者清空筛选条件'
      + '<div style="margin-top:16px"><button class="btn ghost sm" data-act="reset">清空筛选</button></div>';
  }

  function countText(shown, total) {
    if (!shown) return '';
    return shown < total ? '显示 ' + shown + ' / 共 ' + total + ' 条' : total + ' 条';
  }

  /* ---------- 窄屏的「更多筛选」开关（2026-09-22） ---------- */

  // 为什么放在这个共用模块里：index.html 与 share.html 的侧栏结构完全相同，
  // 各写一份的话迟早只有一边记得改（分享页是给外人看的那一面，最不该不一致）。
  // 桌面端这颗按钮被 CSS 隐藏，这里只是把点击接上，不做任何尺寸判断 ——
  // 「什么时候显示」交给媒体查询一处决定，不在这里再写一个断点。
  function wireFilterToggle() {
    var btn = document.getElementById('filtToggle');
    if (!btn) return;
    var aside = btn.closest('aside');
    if (!aside) return;
    btn.addEventListener('click', function () {
      var open = aside.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // 收起后标签是看不见的，但筛选还在生效 —— 把「已选 N」显示在开关上，
  // 否则用户看着被筛过的结果却找不到原因。
  function setFiltCount(n) {
    var el = document.getElementById('filtCount');
    if (el) el.textContent = n ? '· 已选 ' + n + ' 个标签' : '';
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.cards = {
    esc: esc,
    fmtTime: fmtTime,
    toDataUrl: toDataUrl,
    tagChip: tagChip,
    counts: counts,
    navCatsHtml: navCatsHtml,
    navTagsHtml: navTagsHtml,
    cardHtml: cardHtml,
    haystack: haystack,
    matches: matches,
    wireFilterToggle: wireFilterToggle,
    setFiltCount: setFiltCount,
    refreshTagScroll: refreshTagScroll,
    emptyHtml: emptyHtml,
    countText: countText
  };
})(window);
