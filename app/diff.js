/* ============================================================
 * Elangit · 改动对照（F2-8）
 * ------------------------------------------------------------
 * 一个地方回答一个问题：**相对 AI 给的原值，现在改了什么**。
 *
 * 为什么单独一个模块、而不是各页各写一遍：详情页要逐字段列出来给用户看，
 * 数据页要按字段算「修改率」（A2 的判据）。两处若各写一份比较规则，迟早出现
 * 「详情页说改了 3 处、数据页说 2 处」——同一份数据两个答案，比没这功能更糟。
 *
 * 为什么不是事件流：差异是**当前状态的函数**。ai_raw 存着 AI 当时说了什么，
 * items 上是现在是什么，一比就是差异。存成事件流反而多一份会漂移的副本
 * （改两次就得靠顺序才拼得出"现在的差异"），而直接对比永远不会不一致。
 * ============================================================ */
(function (global) {
  'use strict';

  function s(v) { return v == null ? '' : String(v).trim(); }

  // 逐字段对照，返回**全部**受检字段（含没改的），调用方自己过滤。
  //
  // 比哪六个：F2-8 关心的是「用户改了 AI 的结论」，所以只比会被用户改动的
  // AI 字段。my_tags / my_note / raw_text 不在内——它们本来就是用户自己的东西，
  // 没有一个「AI 原值」可对照。
  function fields(it) {
    var ai = it && it.ai_raw;
    if (!ai) return null;              // 没有原值，无从对照（v7 之前的旧素材）

    var out = [
      { key: 'title', label: '项目名称', before: s(ai.title), after: s(it.ai_title) },
      { key: 'summary', label: '摘要', before: s(ai.summary), after: s(it.ai_summary) },
      // 三段总结（2026-09-22）。它也要能算「AI 原值 → 我改了什么」：
      // 这是判断这套 digest 到底可不可用的唯一依据（A2 的分母靠它）。
      { key: 'digest', label: '设计说明总结', before: s(ai.digest), after: s(it.ai_digest) },
      { key: 'caption', label: '画面描述', before: s(ai.caption), after: s(it.ai_caption) },
      { key: 'ocr_text', label: '图中文字', before: s(ai.ocrText), after: s(it.ocr_text) },
      { key: 'category', label: '抽屉', before: s(ai.category), after: s(it.category) },
      { key: 'platform', label: '来源平台', before: s(ai.platform), after: s(it.source_platform) },
      // 标签只比 ai_tags 这一列：my_tags 是用户自己加的，不是对 AI 的否定
      {
        key: 'tags',
        label: '标签（AI 那一列）',
        before: (ai.tags || []).join('、'),
        after: (it.ai_tags || []).join('、')
      }
    ];
    out.forEach(function (f) { f.changed = f.before !== f.after; });
    return out;
  }

  function changed(it) {
    var all = fields(it);
    return all ? all.filter(function (f) { return f.changed; }) : null;
  }

  // 聚合：按字段算「改过的条数 / **AI 真的产出过这个字段**的条数」。
  //
  // 把样本量一并返回，是因为分母 3 和分母 50 的读法完全不同 —— A2 那条
  // 「≥70%」在 3 个样本上毫无意义。报表必须自己说清自己站在多少样本上，
  // 不能只吐一个百分比让人误读。
  //
  // opts.firstN（2026-09-20 新增）：PRD A2 的判据是「**前 50 条**」，不是「全部」。
  // 传入 firstN 时，先取最早的 N 个**有原值**的样本再聚合。
  // 注意 withoutRaw 仍按**传入的全量**算：它回答的是「库里一共多少条、
  // 其中多少条没有原值」，若也缩到 N 条，那句「还有 N 条旧素材没有原值」就变成错的。
  // 取「最早 N 个有原值的」而不是「前 N 条里挑有原值的」：后者在有旧素材混入时
  // 样本数会不足 N，A2 的分母就随旧素材数量漂移了。
  //
  // 分母的定义（2026-09-21 修正，P0-2）：**只算 AI 在该字段真的产出过非空内容的样本**。
  // 原实现把「AI 返回空字符串」也算进分母，于是空值对空值判成 changed=false，
  // 被计成「没被改过 = 可用」——「AI 什么都没给」被读成了「AI 给的东西可用」。
  // 首次真实录入实测：16 条里一条图都没有、caption / ocr_text 全是空串，
  // 而报表把这两个字段的可用率显示成 100%。这是**会自我实现的假通过**。
  // 现在字段里同时给出 produced（进分母的）与 empty（AI 没产出的，不进分母），
  // 让调用方能说出「这个 100% 是站在几个样本上」。
  function summary(items, opts) {
    var all = items || [];
    var withRawAll = all.filter(function (it) { return !!it.ai_raw; });
    var firstN = opts && opts.firstN;
    var withRaw = firstN ? withRawAll.slice(0, firstN) : withRawAll;
    var byField = {};

    withRaw.forEach(function (it) {
      fields(it).forEach(function (f) {
        if (!byField[f.key]) {
          byField[f.key] = { key: f.key, label: f.label, changed: 0, kept: 0, produced: 0, empty: 0 };
        }
        var cell = byField[f.key];
        if (f.before === '') { cell.empty++; return; }   // AI 没产出 → 不进这个字段的分母
        cell.produced++;
        if (f.changed) cell.changed++; else cell.kept++;
      });
    });

    return {
      total: all.length,
      withRaw: withRaw.length,
      withRawAll: withRawAll.length,
      withoutRaw: all.length - withRawAll.length,
      firstN: firstN || null,
      anyChanged: withRaw.filter(function (it) { return changed(it).length > 0; }).length,
      byField: byField
    };
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.diff = { fields: fields, changed: changed, summary: summary };
})(window);
