/* ============================================================
 * Elangit · 埋点（PRD 第 9 章，任务 8；2026-09-20 修正 A4 口径）
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
 *   E1  item_create_start     打开录入页
 *   E2  item_create_submit    点击提交
 *   E3  ai_process_done       AI 返回（耗时、成功否）
 *   E5  item_create_finish    这条入库完成（**总耗时**，A1 的判据）
 *   E6  search_execute        发起一次检索（搜索 / 抽屉 / 标签）
 *   E7  search_result_click   从检索到点开结果的耗时（明细，供回溯）
 *   E8  search_zero_result    无结果（分类/标签体系是否合理）
 *   E9  session_open          每个自然日一次（A12 连续两周的判据）
 *   E13 cover_replaced        手动换封面（封面裁取质量够不够）
 *   E14 search_attempt_end    **一次检索如何结算**（A4 的分母，2026-09-20 新增）
 *   E15 ai_process_start      识别开始跑（2026-09-22 新增）
 *   E16 ai_process_fail       识别异常退出，带错误原文（2026-09-22 新增）
 *
 * E15 / E16 是补一个观测缺口，不是为了多算一个指标：
 * 原先只有 E3（ai_process_done），于是「从来没开始跑」与「跑了但没回来」
 * 在库里长得一模一样。查 id 46 卡住的原因时正是卡在这里——只能靠猜。
 * 有 E15 之后，缺 E3 但**有** E15 = 跑了没回来（网络/页面/超时）；
 * 连 E15 都没有 = 队列压根没轮到它。两者要修的地方完全不同。
 * E16 只由 runAi 最外层的兜底 catch 记：内层 analyze 的失败会走
 * E3(ok:false)，那是「正常失败」，不缺观测。
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

  // A4 的成功阈值。改这里就等于改验收口径，必须同步改 PRD 与数据页文案。
  var SEARCH_OK_MS = 10000;

  /* ---------- 环境 ---------- */

  function device() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? '手机' : '电脑';
  }

  // 一次浏览一个 id，用来把「同一次浏览里的动作」串起来。
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

  /* ---------- E6 / E7 / E14 检索结算（A4 的分母） ----------
   *
   * 旧实现只记两件互不相干的事：E6「执行了搜索」、E7「点开后过了多久」。
   * 于是 A4 只能在 E7 上算比例 —— 那些**发起检索但根本没点开结果**的次数
   * 一条都留不下。分母被系统性做小，找回成功率被高估；而 A4 要回答的恰恰是
   * 「发起找回时能不能快速找到」，不是「在最终点开的那些里有多快」。
   *
   * 现在把「一次检索」变成必须结算的对象。开一笔，就必须落到三种之一：
   *   found      10 秒内点开了结果
   *   timeout    点开了，但超过 10 秒
   *   abandoned  没点开就又发起下一次检索 / 清空筛选 / 离开页面
   *
   * E6、E7 的语义**不变**（照记），只是都带上同一个 search_id 便于回溯；
   * 结算本身写在新事件 E14 search_attempt_end 上，A4 的分母取它。
   */

  var seq = 0;
  var pageSession = null;
  var open = null;          // 当前未结算的那一笔

  // 必须是**页面会话**级、刷新即换的标识。
  // 不能用 sid()：那是设备级持久值，刷新后仍不变，不同天、不同次的检索
  // 会撞成同一个 id，就没法按次审计了。
  function pageSessionId() {
    if (!pageSession) {
      pageSession = Date.now().toString(36) + '-' + S.newShareToken(4);
    }
    return pageSession;
  }

  // 结算并落库。**先清空 open 再写库**：不清的话，写库这段时间里若又触发一次
  // 结算（比如 visibilitychange 紧跟 pagehide），同一笔会被记两次。
  function settle(outcome, extra) {
    if (!open) return Promise.resolve(false);
    var rec = open;
    open = null;
    var ms = Date.now() - rec.at;
    var c = rec.cond || {};
    return event('search_attempt_end', Object.assign({
      search_id: rec.search_id,
      outcome: outcome,
      ms: ms,
      kind: c.kind,
      q: c.q,
      cat: c.cat,
      tags: c.tags,
      n: c.n,
      total: c.total
    }, extra || {}));
  }

  // 开一笔新检索。**先结算上一笔**——用户又搜了，说明上一次没找到目标。
  // 返回 search_id，调用方把它写进 E6。
  function beginSearch(cond) {
    if (open) settle('abandoned');
    seq++;
    open = {
      search_id: pageSessionId() + '-' + seq,
      at: Date.now(),
      cond: cond || {}
    };
    return open.search_id;
  }

  // 点开结果时先问一句「现在这笔检索过了多久」。不结算，判定交给调用方，
  // 因为调用方还要把 item_id / rank 一起带上。
  function touchSearch() {
    if (!open) return null;
    return { search_id: open.search_id, ms: Date.now() - open.at };
  }

  // 点开结果 → 按耗时判 found / timeout，然后结算。
  // 结算之后 open 就空了，所以**同一次检索里再点第二张卡片不会重复计数**，
  // 分母只增加 1（A4 的判据要求）。
  function resolveSearch(extra) {
    if (!open) return Promise.resolve(false);
    var ms = Date.now() - open.at;
    return settle(ms <= SEARCH_OK_MS ? 'found' : 'timeout', extra);
  }

  // 主动放弃：清空筛选、离开页面。
  function abandonSearch() {
    return settle('abandoned');
  }

  // 离开页面时的兜底结算。
  //
  // ⚠️ **已知限制，不是待修 bug**：浏览器在页面卸载时会取消未完成的 fetch，
  // 所以这里发出的写入**可能根本没到服务端**（同一个坑项目已经踩过一次：
  // 当年 E7 在跳转前发，系统性全丢）。但「没点开就离开」这类事件**只能**
  // 在卸载时触发，没有别的时机。因此 abandoned 会偏少、A4 的分母会略小。
  // 想核对这个偏差有多大，用「同一天 E6 的条数」减去「E14 里非 abandoned 的条数」。
  //
  // 两个都挂上：visibilitychange 覆盖切标签页/切应用（这时候写库来得及），
  // pagehide 覆盖真正关闭/刷新（这时候可能来不及，但聊胜于无）。
  if (global.addEventListener) {
    global.addEventListener('pagehide', function () { abandonSearch(); });
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'hidden') abandonSearch();
      });
    }
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.track = {
    event: event,
    session: session,
    device: device,
    // 检索结算（A4 用这套，别再直接读 E6/E7 算比例）
    SEARCH_OK_MS: SEARCH_OK_MS,
    beginSearch: beginSearch,
    touchSearch: touchSearch,
    resolveSearch: resolveSearch,
    abandonSearch: abandonSearch
  };
})(window);
