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

  // 网页正文送进模型的字数上限（2026-09-22）。
  //
  // 定 6000 而不是更小：三段式总结的「效果」写在设计说明的**末尾**，
  // 从中间截断会正好把「效果」砍掉——那是最值得看的一段。
  // 实测存量 4 篇 gooood 文章抽出来的正文是 3,304–5,363 字，6000 能整篇装下。
  //
  // 这是全提示词里最大的一块，直接顶高首字延迟（见上面的实测），
  // 所以这个值必须跟着实测的耗时调，不能凭感觉改。
  var BODY_LIMIT = 6000;

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
      // 45 字（2026-09-22 由 50 收紧）：卡片摘要是 3 行、13px、内容宽 258px，
      // 一行的上限约 19 个汉字，3 行约 57 字。50 是「理论放得下」，
      // 45 留出标点与半角字符的余量——实测 46–48 字那几条会压到第 3 行末尾，
      // 差一两个字就被截断，而被截断的摘要比没有摘要更糟（读着像坏了）。
      // 这里只改**要求**，不把代码的兜底截断收死：见下面 analyze 里的 slice。
      '"summary":"一句话摘要，不超过45字"',
      // digest 是 2026-09-22 新增的第二份总结，与 summary 分工不同：
      //   summary 给列表卡片用（只显示两行），所以必须短、且要能认出是哪条项目；
      //   digest  给详情页用，回答「这份设计说明讲了什么、值不值得点进原文」。
      // 格式定死成三行带标签，是因为界面按行渲染、按标签加粗，格式漂了就渲染不出来。
      // 「不是设计项目就留空」不是可选项：存量里就有奖项榜单页（id=8），
      // 对它硬编「理念/做法/效果」只会得到一段像模像样的假话。
      '"digest":"网页正文的三段总结，固定三行，每行依次以「理念：」「做法：」「效果：」开头，'
        + '每行一句，整段不超过120字。看的人要凭它判断值不值得点进原文，'
        + '所以写具体做法与达到的效果，不要重复项目名。'
        + '没有网页正文、或这条不是设计项目（新闻、榜单、合集、工具页）时给空字符串"',
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
    // 正文（2026-09-22 新增）。放在描述之后、网址之前：它是最大的一块，
    // 而「网页描述」在 gooood 上是每篇都一样的客套话，靠它写不出 digest。
    if (opts.pageText) lines.push('【网页正文】' + String(opts.pageText).slice(0, BODY_LIMIT));
    if (opts.url) lines.push('【网址】' + opts.url);
    // 下面这句只在**真的什么都没有**时才给。
    // 原来只要没有粘贴文本就会带上它 —— 于是「只填网址」这一类素材被提示词
    // 主动推向兜底抽屉。首次真实录入实测：4 条落兜底里有 2 条属于「AI 判错」
    // （P1-3，解忧小屋 / Wiedenhofer 本该进「建筑与构筑物」），而它们其实
    // 是有 og:title / og:description 可用的，只是当时没抓。
    if (!opts.text && !opts.pageTitle && !opts.pageDesc && !opts.pageText && !opts.hasImage) {
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

  // 三段总结（digest）的**严格校验**（2026-09-22 第二轮改）。
  //
  // 上一版对「连标签都没有、只有一整段」的输出是**原样返回**的，理由是「不给模型
  // 没做过的分类硬贴标签」。理由没错，结论错了：原样返回等于让模型的闲聊/无关回答
  // 以「设计说明总结」的身份落进 ai_digest，并在详情页与访客分享页渲染出来 ——
  // **界面说它是设计总结，它不是**。这是本项目最忌讳的一类错（把没有信号读成有信号），
  // 比空着更糟：空着至少是诚实的。按 PRD F2-12，这里只接受约定格式，其余一律空串。
  //
  // 契约（改这里要连 PRD F2-12 一起改）：
  //   1. 「理念 / 做法 / 效果」三项**齐全**、每项都有非空内容，才算合规；
  //   2. 顺序不要求 —— 标签本身就是对应关系，**乱序时重排**，不丢弃；
  //   3. 缺任意一项、或一个标签都没有 → 不合规，返回空串；
  //   4. 不合规时把原文交给调用方（`rejected`），由 analyze 留给 `ai_raw.digestRaw`
  //      备查 —— 本函数只做纯文本判断，不产生副作用。
  //
  // 为什么「重排」可以、「补标签」不可以：三个标签齐全，说明模型确实做过这三项判断，
  // 只是顺序或换行不合约定，重排不引入任何新信息；缺标签时无法知道缺的那段属于哪一项，
  // 补上就是替模型编一个它没给过的判断。
  //
  // 已知未做的：PRD 说整段 ≤120 字，这里只按 300 字截断（沿上一版），
  // 不校验 120 —— 实测库里已有一条 150 字（id=15），见构建记录 #027。
  var DIGEST_LABELS = ['理念', '做法', '效果'];
  var DIGEST_LINE = /^(理念|做法|效果)\s*[：:]\s*([\s\S]*)$/;
  // 三段挤成一行时的分隔符，只去首尾（中间的是正文，不能动）
  var DIGEST_EDGE = /^[\s｜|/、,，;；]+|[\s｜|/、,，;；]+$/g;
  var DIGEST_MAX = 300;
  var DIGEST_RAW_MAX = 500;

  // 返回 { text, rejected }：text = 合规时的三行文本；rejected = 不合规且模型确实
  // 给了内容时的原文（供留痕），其余情况为空串。
  function parseDigest(v) {
    if (v == null) return { text: '', rejected: '' };
    var isArr = Object.prototype.toString.call(v) === '[object Array]';
    var rawAll = (isArr
      ? v.map(function (x) { return String(x == null ? '' : x); }).join('\n')
      : String(v)).replace(/\r/g, '').trim();
    if (!rawAll) return { text: '', rejected: '' };

    // 有换行就按行切；只有一行时才按那三个标签词切（三段挤成一行 / 数组）
    var parts = rawAll.indexOf('\n') >= 0
      ? rawAll.split('\n')
      : rawAll.split(/(?=理念\s*[：:]|做法\s*[：:]|效果\s*[：:])/);

    var hit = {};      // 标签 → 内容：顺序在这一步被抹平，下面按固定顺序拼回
    parts.forEach(function (p) {
      p = String(p).trim().replace(/^[-—•*\s]+/, '').trim();
      if (!p) return;
      var m = DIGEST_LINE.exec(p);
      if (!m) return;                                  // 不带标签的行（客套话等）丢掉
      var body = m[2].trim().replace(DIGEST_EDGE, '').trim();
      if (!body) return;                               // 有标签但没内容 → 当作没写
      if (!hit[m[1]]) hit[m[1]] = body;                // 同一标签重复出现时取第一份
    });

    var missing = DIGEST_LABELS.filter(function (k) { return !hit[k]; });
    if (missing.length) {
      return { text: '', rejected: rawAll.slice(0, DIGEST_RAW_MAX) };
    }
    return {
      text: DIGEST_LABELS.map(function (k) { return k + '：' + hit[k]; })
        .join('\n').slice(0, DIGEST_MAX),
      rejected: ''
    };
  }

  function normalizeDigest(v) { return parseDigest(v).text; }

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
   * @returns Promise<{title, summary, digest, digestRaw, caption, ocrText, category, categoryCorrected, tags, platform, rect, rawJson, ms, firstChunkMs}>
   */
  function analyze(opts) {
    var taxonomy = opts.taxonomy;
    var hasImage = !!(opts.aiImage && opts.aiImage.base64);
    return streamOnce(
      opts,
      buildPrompt(taxonomy, {
        text: opts.text, url: opts.url, hasImage: hasImage,
        pageTitle: opts.pageTitle, pageDesc: opts.pageDesc, pageText: opts.pageText
      }),
      hasImage
    ).then(function (r) {
      var p = extractJson(r.text);
      var cat = normalizeCategory(p.category, taxonomy);
      var dg = parseDigest(p.digest);
      return {
        title: normalizeTitle(p.title),
        // 兜底截断从 120 收到 60（2026-09-22）。为什么不直接收到 45：
        // 提示词里已经要求 ≤45，这里再硬砍到 45 的话，模型偶尔写成 52 字，
        // 卡片上就会是一句话被从中间切掉——**比超长更难读**。
        // 60 的定位是「兜住明显失控的输出」，不是「执行 45 这条规则」；
        // 规则由提示词执行，这里只保证不会出现 300 字的段落。
        summary: String(p.summary || '').trim().slice(0, 60),
        digest: dg.text,
        // 被严格校验判为不合规、因而丢弃的原文（为空表示没这回事）。
        // 为什么要留：模型答了、但格式不对时，界面只显示「没有总结」，
        // 事后查不出到底是「模型没给」还是「给了被我丢了」。
        // 另注：ai_raw.digest 与 items.ai_digest 写入时同源（都是 dg.text），
        // 所以丢弃后 diff.js 的 produced 也不计 —— 不会把「系统丢弃」算成「用户改过」。
        digestRaw: dg.rejected,
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
      digest: r.digest || '',
      // 不合规被丢弃的原文（2026-09-22 第二轮）。它是**诊断信息**，不是 AI 的判断结果：
      // 详情页拿它把空态归因说准（有正文 + 有它 = 答了但不合规，而不是「判为非设计项目」）。
      // 不写进 ai_digest，也不进 A2 的分母。
      digestRaw: r.digestRaw || '',
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
    normalizeDigest: normalizeDigest,
    parseDigest: parseDigest,
    normalizeTitle: normalizeTitle
  };
})(window);
