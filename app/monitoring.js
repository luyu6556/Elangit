/* ============================================================
 * Elangit · 管理员报表的事件展示与导出规则
 * ------------------------------------------------------------
 * 不计算 PRD 验收指标（那仍只在 stats.js / diff.js）。
 * 此模块只负责筛选、有限字段摘要与 CSV 安全编码；绝不返回 props 全量。
 * ============================================================ */
(function (global) {
  'use strict';

  var MISSING = '__missing__';
  var SAFE_FIELDS = {
    search_execute: ['kind', 'has_query', 'query_length', 'has_filter', 'filter_count', 'result_count', 'total_count'],
    search_zero_result: ['kind', 'has_query', 'query_length', 'has_filter', 'filter_count', 'result_count', 'total_count'],
    search_attempt_end: ['kind', 'outcome', 'has_query', 'query_length', 'filtered', 'result_count', 'total_count', 'ms'],
    search_result_click: ['ms', 'rank'],
    item_create_submit: ['picked', 'has_text'],
    item_create_finish: ['ms', 'ms_from'],
    ai_process_start: ['has_image'],
    ai_process_done: ['ok'],
    ai_process_fail: ['where'],
    cover_replaced: ['reason', 'rect_fresh']
  };

  function propsOf(event) {
    return event && event.props && typeof event.props === 'object' ? event.props : {};
  }

  function dimension(event, key) {
    var value = propsOf(event)[key];
    return value == null || value === '' ? '' : String(value);
  }

  function displayDimension(event, key) {
    var value = dimension(event, key);
    return value || '未记录';
  }

  // 日期统一按 Asia/Shanghai（UTC+08:00，无夏令时）分组和筛选。
  function dayKey(value) {
    var time = new Date(value).getTime();
    if (!isFinite(time)) return '';
    var d = new Date(time + 8 * 60 * 60 * 1000);
    return d.getUTCFullYear() + '-'
      + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-'
      + ('0' + d.getUTCDate()).slice(-2);
  }

  function filterEvents(events, filters) {
    var f = filters || {};
    return (events || []).filter(function (event) {
      var day = dayKey(event.at);
      if (f.from && (!day || day < f.from)) return false;
      if (f.to && (!day || day > f.to)) return false;
      if (f.name && event.name !== f.name) return false;
      var checks = ['page', 'device', 'channel'];
      for (var i = 0; i < checks.length; i++) {
        var key = checks[i], wanted = f[key];
        if (!wanted) continue;
        var actual = dimension(event, key);
        if (wanted === MISSING ? !!actual : actual !== wanted) return false;
      }
      return true;
    });
  }

  function safeSummary(event) {
    var p = propsOf(event), name = event && event.name;
    var keys = Object.prototype.hasOwnProperty.call(SAFE_FIELDS, name) ? SAFE_FIELDS[name] : [];
    return keys.filter(function (key) {
      return p[key] != null && p[key] !== '';
    }).map(function (key) {
      var value = p[key];
      if (typeof value === 'boolean') value = value ? '是' : '否';
      return key + '=' + String(value);
    }).join('；');
  }

  function eventCsvRows(events) {
    return (events || []).map(function (event) {
      var time = event.at ? new Date(event.at) : null;
      return [
        event.id,
        dayKey(event.at),
        time && isFinite(time.getTime()) ? time.toISOString() : '',
        event.name || '',
        dimension(event, 'page'),
        dimension(event, 'event_version'),
        dimension(event, 'device'),
        dimension(event, 'channel'),
        safeSummary(event)
      ];
    });
  }

  function dailyRows(events) {
    var groups = Object.create(null);
    (events || []).forEach(function (event) {
      var day = dayKey(event.at), name = String(event.name || '');
      if (!day) return;
      var key = day + '\u0000' + name;
      if (!groups[key]) groups[key] = { day: day, name: name, count: 0 };
      groups[key].count++;
    });
    return Object.keys(groups).map(function (key) { return groups[key]; })
      .sort(function (a, b) {
        return a.day < b.day ? -1 : a.day > b.day ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      }).map(function (row) { return [row.day, row.name, row.count]; });
  }

  function csvCell(value) {
    if (value == null) value = '';
    var text = String(value);
    // Excel/Calc 会执行以 =、+、-、@ 开头的文本；先加单引号，再做标准 CSV 引号转义。
    if (/^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function toCsv(headers, rows) {
    return '\uFEFF' + [headers].concat(rows || []).map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n');
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.monitoring = {
    MISSING: MISSING,
    dayKey: dayKey,
    dimension: dimension,
    displayDimension: displayDimension,
    filterEvents: filterEvents,
    safeSummary: safeSummary,
    eventCsvRows: eventCsvRows,
    dailyRows: dailyRows,
    toCsv: toCsv
  };
})(window);
