/* ============================================================
 * Elangit · AI 识别层
 * ------------------------------------------------------------
 * 一次调用完成 PRD F2 要求的所有事：摘要、画面描述、图中文字、
 * 抽屉、3–5 个标签、来源平台预判，外加封面裁切矩形（F2-9）。
 *
 * 三个必须守住的约束：
 *   1. 抽屉是**枚举**，模型只能从既有清单里选，不得新建（F2-6）。
 *      提示词里给编号清单，并在解析时再做一次白名单校验——模型越界
 *      时落到兜底抽屉，而不是把新抽屉名写进库。
 *   2. 标签要求优先复用既有标签库，抑制标签发散。
 *   3. 有硬超时。实测同一张图耗时能差 4 倍（3.2–41.7s），
 *      超时必须真中断（SDK 会把 signal 透传给 fetch），
 *      不能只是「放弃等待、请求还在后台跑」。
 * ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.Elangit.config;
  var store = global.Elangit.store;

  /* ---------- 提示词 ---------- */

  var SYSTEM = '你只输出 JSON，不要解释。';

  // 提示词长度直接决定首字延迟——实测同一张图，130 字的提示词首字 5.9s，
  // 1160 字的首字 21.1s。所以这份提示词按「一句一条」写，不写解释性文字，
  // 只保留不可省的约束：抽屉枚举、不得新建、标签优先复用、输出字段。
  //
  // 抽屉的边界判据来自 PRD 4.2.1（首次真实压测得出）：改造类素材按
  // 「改造后的结果功能」归抽屉，改造前的历史属性下沉为标签。
  function buildPrompt(taxonomy, opts) {
    var names = taxonomy.categories.map(function (c) { return c.name; });
    var lines = [
      '素材整理任务。',
      '抽屉（只能选 1 个，不得新建、不得改名）：' + names.join('｜'),
      '判据：改造类按改造后的功能归类，改造前的历史属性放标签。',
      '已有标签（优先复用，不够再新建）：' + (taxonomy.tags.join('、') || '无'),
      '输出 JSON：',
      '{'
    ];
    var fields = [
      '"title":"项目或案例名，专有名词，不超过12字，判不出就给空字符串"',
      '"summary":"一句话摘要，不超过50字"',
      '"caption":"画面描述，无图则为空字符串"',
      '"ocr_text":"图中文字，只留标题与关键信息，不超过200字，无则空字符串"',
      '"category":"上面清单中的抽屉名"',
      '"tags":["3到5个标签"]',
      '"platform":"小红书 或 公众号 或 网页 或 其他"'
    ];
    if (opts.hasImage) {
      fields.push('"photo_rect":{"photo_left":0,"photo_top":0,"photo_right":59,"photo_bottom":100,"layout":"横向并排 或 上下堆叠 或 纯照片"}');
    }
    lines.push(fields.join(',\n'));
    lines.push('}');
    if (opts.hasImage) {
      lines.push('截图通常一侧是作品照片、一侧是白底文字面板，photo_rect 指照片占整图的百分比；整张图就是照片时给 0/0/100/100。');
    }
    if (opts.text) lines.push('【文本】' + opts.text.slice(0, 3000));
    // 网页标题与描述来自服务端抓取（_page_meta.py，2026-09-21 新增）。
    if (opts.pageTitle) lines.push('【网页标题】' + String(opts.pageTitle).slice(0, 200));
    if (opts.pageDesc) lines.push('【网页描述】' + String(opts.pageDesc).slice(0, 500));
    if (opts.url) lines.push('【网址】' + opts.url);
    // 下面这句只在**真的什么都没有**时才给。
    // 原来只要没有粘贴文本就会带上它 —— 于是「只填网址」这一类素材被提示词
    // 主动推向兜底抽屉。首次真实录入实测：4 条落兜底里有 2 条属于「AI 判错」
    // （P1-3，解忧小屋 / Wiedenhofer 本该进「建筑与构筑物」），而它们其实
    // 是有 og:title / og:description 可用的，只是当时没抓。
    if (!opts.text && !opts.pageTitle && !opts.pageDesc && !opts.hasImage) {
      lines.push('【只有网址，判不出就用兜底抽屉】');
    }

    return lines.join('\n');
  }

  /* ---------- 解析 ---------- */

  // 模型偶尔会包一层 ```json 或者多说一句废话，这里做容错提取。
  function extractJson(raw) {
    var s = String(raw || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    if (s.charAt(0) === '{') {
      try { return JSON.parse(s); } catch (e) { /* 继续尝试截取 */ }
    }
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* 放弃 */ }
    }
    throw new Error('模型返回的不是可解析的 JSON：' + s.slice(0, 180));
  }

  var PLATFORMS = ['小红书', '公众号', '网页', '其他'];

  function normalizePlatform(v) {
    var s = String(v || '').trim();
    for (var i = 0; i < PLATFORMS.length; i++) if (s.indexOf(PLATFORMS[i]) >= 0) return PLATFORMS[i];
    if (/xiaohongshu|xhslink/i.test(s)) return '小红书';
    if (/mp\.weixin|weixin\.qq/i.test(s)) return '公众号';
    return s ? '网页' : '其他';
  }

  function normalizeRect(r) {
    if (!r) return null;
    function n(v) { var x = Number(v); return isFinite(x) ? Math.min(100, Math.max(0, x)) : null; }
    var l = n(r.photo_left), t = n(r.photo_top), rr = n(r.photo_right), b = n(r.photo_bottom);
    if (l === null || t === null || rr === null || b === null) return null;
    if (rr <= l || b <= t) return null;
    if (l === 0 && t === 0 && rr === 100 && b === 100) return null; // 等于整图 = 不裁
    return { left: l, top: t, right: rr, bottom: b };
  }

  // 白名单校验：模型必须从既有抽屉里选。越界时落到兜底，并如实告知调用方。
  function normalizeCategory(v, taxonomy) {
    var s = String(v || '').trim();
    var hit = taxonomy.categories.filter(function (c) { return c.name === s; })[0];
    if (hit) return { name: hit.name, corrected: false };
    var loose = taxonomy.categories.filter(function (c) {
      return s && (c.name.indexOf(s) >= 0 || s.indexOf(c.name) >= 0);
    })[0];
    if (loose) return { name: loose.name, corrected: true };
    var fb = taxonomy.categories.filter(function (c) { return c.is_fallback; })[0];
    return { name: fb ? fb.name : cfg.fallbackCategory, corrected: true, outOfList: s || '(空)' };
  }

  function normalizeTags(v) {
    var list = Array.isArray(v) ? v : (v ? [v] : []);
    var seen = {}, out = [];
    list.forEach(function (t) {
      var s = String(t || '').trim().replace(/^#/, '').slice(0, 12);
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    });
    return out.slice(0, 5);
  }

  // 项目名。卡片上只有一行位置（约 15 个汉字），所以限制得比摘要狠。
  // 上限给到 20 字是留冗余：卡片靠 CSS 省略号截，详情页能看到全名。
  // 模型偶尔会把书名号、《》或引号一起带回来，去掉。
  function normalizeTitle(v) {
    var s = String(v || '').trim();
    s = s.replace(/^[《"'「【\[]+/, '').replace(/[》"'」】\]]+$/, '').trim();
    s = s.replace(/\s+/g, ' ');
    return s.slice(0, 20);
  }

  /* ---------- 单次流式调用（analyze 与 detectRect 共用） ---------- */

  // 超时必须是真的中断（SDK 会把 signal 透传给 fetch），不能只是「放弃等待、
  // 请求还在后台跑」。这段原先内联在 analyze 里，detectRect 要用同一套行为，
  // 所以抽出来共用——两处各写一遍，迟早有一处忘了 clearTimeout。
  function streamOnce(opts, promptText, hasImage) {
    var ctrl = new AbortController();
    var timedOut = false;
    var timeoutMs = opts.timeoutMs || cfg.aiTimeoutMs;

    var timer = setTimeout(function () {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);

    var content = [];
    if (hasImage) {
      content.push({ type: 'image_url', image_url: { url: store.toDataUrl(opts.aiImage.mime, opts.aiImage.base64) } });
    }
    content.push({ type: 'text', text: promptText });

    var t0 = Date.now();
    var firstChunkMs = 0;

    return Promise.resolve()
      .then(function () {
        return (async function () {
          var acc = '';
          var stream = store.cloud.llm.chat.completions.create({
            model: opts.model || cfg.aiModel,
            messages: [
              { role: 'system', content: SYSTEM },
              { role: 'user', content: content }
            ],
            stream: true,
            response_format: { type: 'json_object' },
            signal: ctrl.signal
          });
          for await (var chunk of stream) {
            var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
            if (d && d.content) {
              if (!firstChunkMs) firstChunkMs = Date.now() - t0;
              acc += d.content;
            }
          }
          return acc;
        })();
      })
      .then(function (raw) {
        return { text: raw, ms: Date.now() - t0, firstChunkMs: firstChunkMs };
      })
      .catch(function (e) {
        if (timedOut || (e && e.name === 'AbortError')) {
          var err = new Error('识别超过 ' + Math.round(timeoutMs / 1000) + ' 秒未返回，已中断');
          err.code = 'AI_TIMEOUT';
          err.elapsedMs = Date.now() - t0;
          throw err;
        }
        throw e;
      })
      .then(function (v) { clearTimeout(timer); return v; },
            function (e) { clearTimeout(timer); throw e; });
  }

  /* ---------- 主调用 ---------- */

  /**
   * @param {Object} opts
   *   aiImage   {base64, mime}  送模型的图（长边 1000，见 pipeline.makeAiInput）
   *   text      用户粘贴的原文
   *   url       来源网址
   *   pageTitle 服务端抓来的网页标题（可能为空）
   *   pageDesc  服务端抓来的网页描述（可能为空）
   *   taxonomy  {categories, tags}
   * @returns Promise<{title, summary, caption, ocrText, category, categoryCorrected, tags, platform, rect, rawJson, ms, firstChunkMs}>
   */
  function analyze(opts) {
    var taxonomy = opts.taxonomy;
    var hasImage = !!(opts.aiImage && opts.aiImage.base64);
    return streamOnce(
      opts,
      buildPrompt(taxonomy, {
        text: opts.text, url: opts.url, hasImage: hasImage,
        pageTitle: opts.pageTitle, pageDesc: opts.pageDesc
      }),
      hasImage
    ).then(function (r) {
      var p = extractJson(r.text);
      var cat = normalizeCategory(p.category, taxonomy);
      return {
        title: normalizeTitle(p.title),
        summary: String(p.summary || '').trim().slice(0, 120),
        caption: String(p.caption || '').trim(),
        ocrText: String(p.ocr_text || p.ocrText || '').trim(),
        category: cat.name,
        categoryCorrected: cat.corrected,
        categoryOutOfList: cat.outOfList || null,
        tags: normalizeTags(p.tags),
        platform: normalizePlatform(p.platform),
        rect: hasImage ? normalizeRect(p.photo_rect) : null,
        rawJson: p,
        ms: r.ms,
        firstChunkMs: r.firstChunkMs
      };
    });
  }

  /* ---------- 只判裁切矩形（F5-8 第三条兜底要用的补丁） ---------- */

  // 为什么要单独开一个调用：AI 在录入时只为「送进模型的那张图」给过矩形。
  // 用户在详情页换了封面图之后，新图没有矩形；而「按 AI 矩形重裁」原先还硬
  // 要求 cover_index === 0 —— 两条兜底互相堵死，结果是**换了图的封面再也裁不了**
  // （A14 实测踩到：纽约高线公园那条换了第 2 张图当封面，右侧文字面板留在封面上）。
  // 这里对**指定的那一张图**单独问一次，只问矩形，不再问摘要/标签。
  //
  // 提示词刻意写短：实测首字延迟由提示词长度主导（4.3：130 字 5.9s / 1160 字 21.1s），
  // 只问一件事就别把一百件事一起塞进去。
  var RECT_PROMPT = [
    '照片区域定位任务。',
    '截图通常一侧是作品照片、一侧是白底文字面板。',
    '只输出 JSON：{"photo_left":0,"photo_top":0,"photo_right":59,"photo_bottom":100,"layout":"横向并排 或 上下堆叠 或 纯照片"}',
    'photo_* 是照片占整图的百分比；整张图都是照片时给 0/0/100/100。'
  ].join('\n');

  /**
   * @returns Promise<{rect, layout, ms, firstChunkMs, rawJson}>
   *   rect 为 null 表示「整张图就是照片 / 矩形不可信」，调用方应保持整图不裁
   */
  function detectRect(opts) {
    if (!opts.aiImage || !opts.aiImage.base64) {
      return Promise.reject(new Error('没有图片，判不了裁切矩形'));
    }
    return streamOnce(opts, RECT_PROMPT, true).then(function (r) {
      var p = extractJson(r.text);
      return {
        // 容错：模型可能给嵌套的 photo_rect，也可能把四个数直接平铺在顶层
        rect: normalizeRect(p.photo_rect || p),
        layout: String(p.layout || '').trim(),
        rawJson: p,
        ms: r.ms,
        firstChunkMs: r.firstChunkMs
      };
    });
  }

  /* ---------- AI 原值快照 ---------- */

  // 把一次成功识别的结果压成一份「原值」，存进 items.ai_raw。
  //
  // 为什么要单独存：用户改过之后，items 上的字段已经是「用户的值」了，
  // AI 原来给的是什么就再也查不到。但两个地方都要它——
  //   F5-6 来源平台要用黄色虚线框把 AI 的原判显示出来供对照；
  //   F2-8 要算「AI 原值 → 用户改动」的差异（落库在任务 8）。
  // 所以这里不省：AI 说什么，原样留一份。
  //
  // 语义定为「AI 最近一次成功的输出」，重跑会覆盖。理由：重跑是用户主动
  // 触发的一次重新识别，差异基线理应跟着移动，否则「改了多少」会越算越离谱。
  function snapshot(r) {
    return {
      title: r.title || '',
      category: r.category || null,
      categoryCorrected: !!r.categoryCorrected,
      categoryOutOfList: r.categoryOutOfList || null,
      tags: r.tags || [],
      summary: r.summary || '',
      caption: r.caption || '',
      ocrText: r.ocrText || '',
      platform: r.platform || null,
      rect: r.rect || null,
      ms: r.ms || null,
      at: new Date().toISOString()
    };
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.ai = {
    analyze: analyze,
    detectRect: detectRect,
    snapshot: snapshot,
    buildPrompt: buildPrompt,
    extractJson: extractJson,
    normalizeCategory: normalizeCategory,
    normalizeRect: normalizeRect,
    normalizePlatform: normalizePlatform,
    normalizeTags: normalizeTags,
    normalizeTitle: normalizeTitle
  };
})(window);
