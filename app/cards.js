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

    var tags = (it.ai_tags || []).concat(it.my_tags || []);
    // 卡片上只放 3 个标签。为什么是 3 而不是 4：
    // 标签是变宽的（实测 5 字 74px / 4 字 62px / 3 字 51px / 2 字 39px，间距 4px），
    // 而卡片内容宽只有 258px。放 4 个最坏要 249–255px，已经贴死上限——再挂一个
    // 余数必然折行；折行会让标签块从 22px 变成 47px，同一行卡片的标签顶端因此
    // 错开 26px（底端对齐、顶端不齐），看起来就是「没对齐」。
    // 3 个最坏 3×74+8 = 230px，留 28px 给余数，一行永远放得下。
    // 代价是信息量少一个标签，但详情页有全部标签，权衡划算。
    var shownTags = tags.slice(0, 3);
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
          + (it.ai_summary ? esc(it.ai_summary) : (it.raw_text ? esc(it.raw_text.slice(0, 80)) : '（没有文字内容）'))
        + '</div>'
        + '<div class="ctags">' + shownTags.map(function (t) { return tagChip(tax, t, {}); }).join('')
          // 余数不再是一枚胶囊。原来是独立 chip，放不下时它会自己掉到第二行、
          // 孤零零占一整行——那正是用户看到的「+1 占一行」。改成跟随在最后一个
          // 标签后面的灰色小字，不占独立宽度，也就没有「掉行」这回事。
          + (tags.length > 3 ? '<span class="cmore">+' + (tags.length - 3) + '</span>' : '')
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
    emptyHtml: emptyHtml,
    countText: countText
  };
})(window);
