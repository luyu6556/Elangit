/* ============================================================
 * Elangit · 报表的门槛与统计（数据页专用，2026-09-20 新增）
 * ------------------------------------------------------------
 * 为什么单独一个模块、而不是写在 stats.html 里：
 *   数据页的渲染函数是 IIFE 私有的，一次性验证台拿不到它们 ——
 *   于是「19 条时不该出现均值」这类临界判据只能靠肉眼看，
 *   而肉眼看不出「平均值取的是最早 20 条还是最新 20 条」。
 *   抽成纯函数之后，_verify_stats.html 才能真的断言。
 *
 * 这个模块只做两件事：**算样本窗口**、**判样本够不够**。不碰 DOM。
 *
 * 边界（不要越界）：
 *   · 「AI 原值 vs 现值」的比较规则一律来自 diff.js，本模块不复制一份。
 *     两处各写一套，迟早出现「详情页说改了 3 处、数据页说 2 处」。
 *   · 不在这里画表、不拼 HTML —— 排版留给 stats.html。
 * ============================================================ */
(function (global) {
  'use strict';

  // 每条验收的合格样本量（PRD 第 10 章 + 10.1）。
  // 改这里等于改验收口径，必须同步改 PRD 的验收表与数据页的文案。
  var GATES = {
    A1: 20,     // 录入耗时：前 20 条完成录入
    A2: 50,     // AI 标签可用率：前 50 个有 AI 原值的素材
    A4: 10,     // 找回效率：10 次检索
    A13: 30,    // 抽屉复盘：前 30 条素材
    A12: 14     // 持续使用：连续 14 个自然日
  };

  // A4 的成功阈值（与 track.js 的 SEARCH_OK_MS 必须一致）。
  var SEARCH_OK_MS = 10000;

  function gateOk(n, need) { return n >= need; }

  // 统一的「样本不足」文案。任何面板不到门槛都走这里，不允许各自写一句 ——
  // 措辞一致才不会被读成两种意思。
  function gateText(n, need) {
    return '样本不足（' + n + ' / ' + need + '）';
  }

  function mean(a) {
    return a && a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null;
  }
  function median(a) {
    if (!a || !a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // 通用：取**最早** N 个满足条件的样本。
  // 输入必须已按时间正序（reportItems 是正序，loadFirstEvents 也是正序）。
  // 取「最早 N 个满足条件的」而不是「最早 N 条里挑满足条件的」：后者在混入
  // 旧素材时分母会随旧素材数量漂移，A2 的 50 条就不是 50 条了。
  function firstN(list, n, pred) {
    var out = [], i;
    for (i = 0; i < (list || []).length && out.length < n; i++) {
      if (!pred || pred(list[i])) out.push(list[i]);
    }
    return out;
  }

  /* ---------- A1：录入耗时 ---------- */

  // A1 的样本窗口要「最早 20 条**符合口径**的事件」，所以查询要多取一些，
  // 用来吸收被过滤掉的（旧口径样本、ms 缺失样本）。样本窗口是查询的属性，
  // 不能在渲染层补救：窗口错了，均值就是另一个数，而且看不出错。
  function a1Fetch() { return GATES.A1 * 3; }

  // events 由 store.loadFirstEvents('item_create_finish', a1Fetch()) 取回。
  //
  // 只认 ms_from === 'input' 的样本（2026-09-21 改，P0-1）。旧口径（没有 ms_from，
  // 或 ms_from === 'page'）量的是「从打开录入页到入库」的累计值：一次会话连录
  // 多条时它会累加，实测 16 条连录得到 27.8s→45.5s 单调递增，而真实提交只花
  // 200ms 上下。两种口径的数不可比，**宁可不计，也不要把不可比的数掺进均值**。
  function a1(events) {
    var need = GATES.A1;
    var ms = (events || [])
      .filter(function (e) { return e && e.props && e.props.ms_from === 'input'; })
      .map(function (e) { return Number(e.props.ms) || 0; })
      .filter(function (x) { return x > 0; });
    var sample = ms.slice(0, need);
    return {
      n: sample.length,
      need: need,
      ok: gateOk(sample.length, need),
      text: gateText(sample.length, need),
      mean: mean(sample),
      median: median(sample),
      max: sample.length ? Math.max.apply(null, sample) : null
    };
  }

  /* ---------- A2：AI 标签可用率 ---------- */

  // 单个字段的可用率。**分母是「AI 真的产出过这个字段」的样本数**（P0-2）。
  // 产出样本为 0 → 这个字段在这里根本无从判断，按「样本不足」处理，不给百分比。
  // need 默认取 A2 的门槛：整张表与表里每一行用同一个门槛，读起来才一致，
  // 也才不会出现「2 个样本 100%」这种数字。
  function fieldRate(f, need) {
    need = need || GATES.A2;
    var produced = f ? f.produced : 0;
    if (!produced) return { ok: false, n: 0, need: need, text: gateText(0, need), rate: null };
    var ok = gateOk(produced, need);
    return {
      ok: ok,
      n: produced,
      need: need,
      text: ok ? null : gateText(produced, need),
      rate: ok ? f.kept / produced : null
    };
  }

  function a2(items, diff) {
    var need = GATES.A2;
    var s = diff.summary(items || [], { firstN: need });
    var tags = fieldRate(s.byField.tags, need);
    return {
      n: s.withRaw,                 // 进表级的样本数（≤ 50）
      need: need,
      ok: gateOk(s.withRaw, need),
      text: gateText(s.withRaw, need),
      summary: s,
      rate: tags.rate,              // null = 「标签」这一行的产出样本还不够
      rateText: tags.text,
      fieldRate: fieldRate
    };
  }

  /* ---------- A4：找回效率 ---------- */

  // attempts 是 E14 search_attempt_end 的记录（内部按时间正序传入）。
  // 成功 = outcome === 'found' 且 ms ≤ 10 秒；**其余一律算失败**。
  // timeout 与 abandoned 分开报：前者是「能找到但不够快」，后者是「发起了却没
  // 找到」——要修的东西不同（一个是排序/筛选，一个是检索能力本身）。
  function a4(attempts) {
    var need = GATES.A4;
    var list = attempts || [];
    var found = 0, timeout = 0, abandoned = 0, other = 0;
    var okMs = [], allMs = [];

    list.forEach(function (e) {
      var p = (e && e.props) || {};
      var ms = Number(p.ms) || 0;
      if (ms > 0 && p.outcome !== 'abandoned') allMs.push(ms);
      if (p.outcome === 'found' && ms > 0 && ms <= SEARCH_OK_MS) { found++; okMs.push(ms); }
      else if (p.outcome === 'timeout') timeout++;
      else if (p.outcome === 'abandoned') abandoned++;
      else other++;                  // 缺 outcome、或 found 但 ms 异常，都算失败
    });

    return {
      n: list.length,
      need: need,
      ok: gateOk(list.length, need),
      text: gateText(list.length, need),
      found: found, timeout: timeout, abandoned: abandoned, other: other,
      rate: list.length ? found / list.length : null,
      medianMs: median(okMs),        // 只看成功那些有多快
      meanMs: mean(allMs),           // 点开过的（found + timeout）平均耗时
      okMs: SEARCH_OK_MS
    };
  }

  /* ---------- A13：抽屉复盘 ---------- */

  // 素材数够 30 只是「可以复盘了」，**不等于复盘做过了**。
  // 数据页读不到 docs/构建记录.md，所以正确状态是「待人工复盘」而不是「达标」。
  function a13(items) {
    var n = (items || []).length;
    var need = GATES.A13;
    return { n: n, need: need, enough: gateOk(n, need), text: gateText(n, need) };
  }

  /* ---------- 兜底抽屉占比 ---------- */

  function fallback(items, fallbackName) {
    var need = GATES.A13;
    var all = items || [];
    var hit = all.filter(function (it) { return it.category === fallbackName; }).length;
    return {
      n: all.length,
      need: need,
      enough: gateOk(all.length, need),
      text: gateText(all.length, need),
      hit: hit,
      rate: all.length ? hit / all.length : null
    };
  }

  /* ---------- A12：连续天数 ---------- */

  function a12(streak) {
    var need = GATES.A12;
    return {
      n: streak || 0,
      need: need,
      ok: gateOk(streak || 0, need),
      text: gateText(streak || 0, need)
    };
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.stats = {
    GATES: GATES,
    SEARCH_OK_MS: SEARCH_OK_MS,
    gateOk: gateOk,
    gateText: gateText,
    firstN: firstN,
    mean: mean,
    median: median,
    a1Fetch: a1Fetch,
    a1: a1,
    a2: a2,
    fieldRate: fieldRate,
    a4: a4,
    a13: a13,
    a12: a12,
    fallback: fallback
  };
})(window);
