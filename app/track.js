/* ============================================================
 * Elangit · 埋点（PRD 第 9 章，任务 8）
 * ------------------------------------------------------------
 * 目的不是运营，是验证 PRD 1.2 的核心假设、并让项目拿得出真实使用数据。
 * 所以只记「不可派生」的那几件——判断标准是：这件事能不能从库里的
 * **当前状态**算出来？
 *
 *   E4  改了哪些 AI 字段   -> 能。items.ai_raw 对比现值就是差异（F2-8）
 *   E11 落进兜底抽屉       -> 能。category 等于兜底抽屉名即是
 *   E12 手动更正来源平台   -> 能。ai_raw.platform 对比 source_platform
 *   E10 访客访问分享       -> 与 F6-6 同一个问题：访客要能写库才能记，
 *                             而库对匿名开放 → 数字可被刷，不可信。不做。
 *
 * 必须记事件流的是过程量（耗时、搜索行为、会话），状态里留不下痕迹：
 *   E1 item_create_start    打开录入页
 *   E2 item_create_submit   点击提交
 *   E3 ai_process_done      AI 返回（耗时、成功否）
 *   E5 item_create_finish   这条入库完成（**总耗时**，A1 的判据）
 *   E6 search_execute       执行搜索/筛选
 *   E7 search_result_click  从搜索到点击的耗时（A4 的判据）
 *   E8 search_zero_result   无结果（分类/标签体系是否合理）
 *   E9 session_open         每个自然日一次（A12 连续两周的判据）
 *   E13 cover_replaced      手动换封面（封面裁取质量够不够）
 *
 * 三条自律：
 *   1. **埋点是旁路。** 任何一次记录失败都只 console.warn，绝不弹错、
 *      绝不 reject 到调用方——为了记一笔数据把用户的操作弄坏，是本末倒置。
 *   2. **只有所有者才记。** store 的写操作本来就走同一道门禁（F7-1），
 *      这里再挡一道，免得访客态反复报错刷控制台。分享页不加载本模块。
 *   3. **不记可派生的东西。** 少一处写入，就少一处会漂移的副本。
 * ============================================================ */
(function (global) {
  'use strict';

  var S = global.Elangit.store;
  var SID_KEY = 'elangit.sid';
  var SES_KEY = 'elangit.track.lastSessionDay';

  /* ---------- 环境 ---------- */

  function device() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '手机' : '电脑';
  }

  // 一次浏览一个 id，用来把「搜索→点击」这类配对串起来。
  // 不追求唯一性，只求同一台设备的不同次浏览不混。
  function sid() {
    try {
      var v = global.localStorage.getItem(SID_KEY);
      if (!v) {
        v = S.newShareToken(8);
        global.localStorage.setItem(SID_KEY, v);
      }
      return v;
    } catch (e) { return null; }
  }

  function isOwner() {
    var a = global.Elangit.auth;
    return !!(a && a.isOwner());
  }

  /* ---------- 记一笔 ---------- */

  function event(name, props) {
    if (!isOwner()) return Promise.resolve(false);
    var body = Object.assign({ sid: sid(), device: device() }, props || {});
    return S.insertEvent(name, body).then(function () { return true; })
      .catch(function (e) {
        // 只说一句，不打断任何流程。埋点不该有机会让界面出错。
        console.warn('[track] ' + name + ' 记录失败（不影响功能）：' + S.describe(e));
        return false;
      });
  }

  /* ---------- E9 会话 ---------- */

  // 本地日期，不是 UTC。用户看的是自己的日历，「今天」必须和他的一致，
  // 否则晚上 8 点之后（UTC 还是前一天）录的会被算到前一天，A12 的连续天数就错了。
  function todayKey() {
    var x = new Date();
    return x.getFullYear() + '-'
      + ('0' + (x.getMonth() + 1)).slice(-2) + '-'
      + ('0' + x.getDate()).slice(-2);
  }

  // 每个自然日只记一次。判据放本机（localStorage）而不是服务端：
  // 服务端要判「今天开过没有」得多一次查询，而这里只想回答「有没有掉零」。
  //
  // 两个顺序都踩过坑，所以写清楚：
  //   1. **先看身份再碰 localStorage。** 最初是先写标记、后调 event()，而 event()
  //      遇到访客会直接返回 false —— 于是访客打开一次页面，当天的标记就已经落下了，
  //      之后所有者再打开也不会记。E9 就这么丢了一天。
  //   2. **标记只在写成功之后落。** 先标记的话，一次网络失败就等于当天再也补不上；
  //      而 A12 数的是「有没有掉零」，丢一天的代价比多试几次大得多。
  function session() {
    if (!isOwner()) return Promise.resolve(false);

    var day = todayKey();
    try {
      if (global.localStorage.getItem(SES_KEY) === day) return Promise.resolve(false);
    } catch (e) { /* 读不到就每次都记，只是多几行，不影响正确性 */ }

    return event('session_open', {}).then(function (ok) {
      if (ok) {
        try { global.localStorage.setItem(SES_KEY, day); } catch (e) { /* 同上 */ }
      }
      return ok;
    });
  }

  /* ---------- E6/E7 搜索配对 ---------- */

  // 「从搜索到点击的耗时」是一次浏览内的过程量，记内存即可：
  // 刷新页面就没了也无妨，PRD E7 要的只是这个间隔。
  var lastSearchAt = 0;
  var lastSearchSeq = 0;

  function markSearch() {
    lastSearchAt = Date.now();
    lastSearchSeq++;
    return lastSearchSeq;
  }

  function sinceSearch() {
    if (!lastSearchAt) return null;
    return { ms: Date.now() - lastSearchAt, search_seq: lastSearchSeq };
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.track = {
    event: event,
    session: session,
    markSearch: markSearch,
    sinceSearch: sinceSearch,
    device: device
  };
})(window);
