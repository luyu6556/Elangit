/* ============================================================
 * Elangit · AI 队列（库侧，页面无关）
 * ------------------------------------------------------------
 * 为什么要有它：见 `docs/10-问题台账.md` B-001。
 *
 * 原先 AI 任务只活在 **录入页 add.html 的内存数组**里（aiQueue / drainAi）。
 * 用户点完「收进灵感库」去做别的事，页面一关，这个数组随进程消失，
 * 而库里那条已经是 status='pending' —— 于是界面永远显示「识别中」，
 * 实际上**没有任何进程在跑**，也没有任何手动出口（retry() 只认 failed）。
 *
 * 根治办法是让 **pending 本身就是队列**：它记在数据库里，谁打开页面都能
 * 接着跑。要做到这一点必须解决两个并发问题，否则会退化成「重复消耗」：
 *
 *   1. 两个页面同时看见同一条 pending → 都去跑 → AI 被调两次。
 *      用**乐观锁领取**：UPDATE ... WHERE id=? AND ai_lease_until IS NULL，
 *      抢到行才算拿到执行权（2026-09-24 实测：第一次 1 行，第二次 0 行）。
 *   2. 跑到一半页面崩了，租约永远不释放 → 这条再也没人敢碰。
 *      给租约一个**到期时间**（LEASE_MS）：超过就视为上一个执行者已死，
 *      任何页面都可以接管（实测 lt 条件：未过期 0 行，已过期 1 行）。
 *
 * 「更多 ascertain」的三条边界，写在这里是因为它们不显眼但会咬人：
 *   - **必须用 `.is(col, null)` 而不是 `.eq(col, null)`**。后者会被拼成
 *     `ai_lease_until=eq.null`，服务端报 22007
 *     （invalid input syntax for type timestamp）。
 *   - 租约时长必须 **大于 AI 超时**（config.aiTimeoutMs = 90s），否则一次
 *     正常的慢调用跑完之前，租约就先过期、被别人抢走了。这里给 150s。
 *   - 失败同样要释放租约并 attempts+1：累到 MAX_ATTEMPTS 就落 enteredFile
 *     failed（「待补」），界面上才有重试入口。
 * ============================================================ */
(function (global) {
  'use strict';

  var IMG = global.Elangit.imaging;
  var AI = global.Elangit.ai;
  var S = global.Elangit.store;
  var cfg = global.Elangit.config;

  // 租约时长 > AI 超时（90s）+ 写回余量。改小会让正常慢调用被别人抢走。
  var LEASE_MS = 150000;
  // 试满这么多次仍没跑出来，就不再自动重试——界面上落「待补」，由人决定。
  var MAX_ATTEMPTS = 3;
  // 一次 sweep 最多处理多少条。AI 是串行的，一次扫太多会把页面拖住。
  var SWEEP_LIMIT = 20;

  var raws = {};        // itemId -> {cover}：解码出来的原件，本页内复用
  var held = {};        // itemId -> true：本页当前占着的租约
  var listeners = [];   // 跑完通知页面刷新
  var sweeping = false;

  function isOwner() {
    var a = global.Elangit.auth;
    return !!(a && a.isOwner());
  }

  function track() { return global.Elangit.track; }

  function ev(name, props) {
    var T = track();
    if (!T || !T.event) return;
    try { T.event(name, props); } catch (e) { /* 埋点是旁路，绝不上抛 */ }
  }

  function notify(id, item) {
    listeners.forEach(function (fn) {
      try { fn(id, item); } catch (e) { console.warn('[aiQueue] 订阅回调出错：' + (e && e.message)); }
    });
  }

  /** 订阅「某条跑完了」。返回取消订阅的函数。 */
  function subscribe(fn) {
    listeners.push(fn);
    return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
  }

  /* ---------- 领取 / 释放（乐观锁） ---------- */

  function leaseUntil() { return new Date(Date.now() + LEASE_MS).toISOString(); }

  /**
   * 抢占一条 pending 的执行权。
   * @returns Promise<row|null>  null 表示被别人占着（这一轮跳过即可，不是错误）
   */
  function claim(id) {
    if (!isOwner()) return Promise.resolve(null);
    return S.claimAi(id, leaseUntil()).catch(function () { return null; })
      .then(function (row) {
        if (row) held[id] = true;
        return row;
      });
  }

  // 接管「上一个执行者已死」的那条：租约还在，但已经过期。
  function steal(id) {
    if (!isOwner()) return Promise.resolve(null);
    return S.stealAi(id, leaseUntil(), new Date().toISOString()).catch(function () { return null; })
      .then(function (row) {
        if (row) held[id] = true;
        return row;
      });
  }

  /** 写回结果并释放租约。patch 里不要自己带 ai_lease_until / ai_attempts。 */
  function release(id, patch, attempts) {
    var body = Object.assign({}, patch);
    body.ai_lease_until = null;
    body.ai_attempts = (attempts || 0) + 1;
    delete held[id];
    return S.updateItem(id, body).then(function (saved) {
      notify(id, saved);
      return saved;
    });
  }

  // 只清租约（不用写业务结果的那几种情况，比如「判断已有结果、不动库」）
  function dropLease(id, attempts) {
    delete held[id];
    return S.updateItem(id, { ai_lease_until: null, ai_attempts: (attempts || 0) + 1 })
      .catch(function (e) { console.warn('[aiQueue] 租约没释放：' + S.describe(e)); });
  }

  /* ---------- 原件：内存没有就从库里的 1600px 原件重新解码 ---------- */

  function ensureRaw(itemId, item) {
    if (raws[itemId] && raws[itemId].cover) return Promise.resolve(raws[itemId].cover);
    return S.getImages(itemId).then(function (imgs) {
      // 没有图**不是错误**：只填网址的素材本来就没有本地图。
      // 原先这里 throw 让外层 catch 成 null，效果一样但语义是「出错」——
      // B-001 那条卡住的素材就是 has_image=false，把它当成一条错误注解会误导人。
      if (!imgs.length) return null;
      var idx = (item && item.cover_index) || 0;
      var img = imgs[Math.min(idx, imgs.length - 1)];
      return fetch(S.toDataUrl(img.mime, img.data_base64))
        .then(function (r) { return r.blob(); })
        .then(IMG.processRaw)
        .then(function (raw) { raws[itemId] = { cover: raw }; return raw; });
    });
  }

  function rememberRaw(itemId, raw) {
    if (raw) raws[itemId] = { cover: raw };
  }

  // “有可用结果”不能只看摘要或标签：详情页还可能保留项目名、设计说明总结、
  // 画面描述或 OCR。重跑异常时，任一项存在都说明不能把整条素材降成 failed。
  function hasAiResult(item) {
    return !!(item && (item.ai_title || item.ai_summary || item.ai_digest || item.ai_caption || item.ocr_text
      || (item.ai_tags && item.ai_tags.length)));
  }

  /* ---------- 跑一条 ---------- */

  /**
   * 完整跑一条 AI：领租约 → 取原件 → 调模型 → 写回 → 放租约。
   * 任一环节异常都会落到素材上（failed / 保持已有结果），不往上抛。
   * @param {number} id
   * @param {object} [hint] 可选的已知片段。**不作数据来源**：素材内容一律
   *       重新读一次（见 execute 里的说明），留这个参数只是为了调用方表达
   *       「我已经读过它了」，将来若要省这次查询，得先保证这份是全字段行。
   * @returns Promise<{claimed:boolean, status:string|null, saved:object|null, info:object|null}>
   */
  function run(id, hint) {
    // 认领有**两条路**，顺序不能反，也一个都不能少：
    //   claim 只认「租约是 NULL」的（从来没被认领过 / 上一个执行者正常收尾）；
    //   steal 只认「租约已过期」的（上一个执行者死了，租约没人放）。
    // 两者的 WHERE 条件**互斥**，缺任何一个都会留下一类没人管的孤儿：
    //   少了 steal → 页面崩过一次的素材，租约停在过去某个时刻，既不是 NULL 也没人在跑，
    //                于是谁都抢不到、永远停在 pending（B-003，2026-09-24 线上 id=49 实测）；
    //   少了 claim → 刚录进来的那条（租约本来就是 NULL）压根没人认领。
    return claim(id).then(function (row) {
      if (row) return execute(id, row, hint).then(function (r) {
        return Object.assign({ claimed: true, how: 'claim' }, r);
      });
      return steal(id).then(function (stolen) {
        if (!stolen) return { claimed: false, status: null, saved: null, info: null };
        return execute(id, stolen, hint).then(function (r) {
          return Object.assign({ claimed: true, how: 'steal' }, r);
        });
      });
    });
  }

  function execute(id, row, hint) {
    var attempts = row ? (row.ai_attempts || 0) : 0;
    var hasImg = false;
    var item = null;

    // 这里**必须**重新读一次完整行，不能用 claim/listPending 回来的那一份。
    // 那两份 select 只取了 id/status/ai_lease_until/ai_attempts（队列调度用不着别的），
    // 拿它当素材用，page_title / page_desc / page_text / raw_text 全是空——
    // 于是模型只收到一串 URL，吐回来一份全空的 JSON（标题/摘要/总结全空），
    // 而 status 照样被标成 done。2026-09-24 第一次跑 id=48 就踩到：ai_raw.ms=13969
    // 一切正常，结果五个字段全空。
    // 教训：「谁的队列视图」和「模型的输入」不是同一份数据，
    // 调度用的精简快照永远不能拿去当 AI 的输入。
    return S.fetchItem(id)
      .then(function (it) {
        item = it;
        return ensureRaw(id, it);
      })
      .then(function (coverRaw) {
        hasImg = !!coverRaw;
        // E15 放在这里而不是函数开头：has_image 要等原件读完才知道。
        // 它的用途正是「从来没开始跑」与「跑了但没回来」的分界（B-001 取证时
        // 全靠它），所以这个字段宁可晚一拍，也不能写个假的 false 进去。
        ev('ai_process_start', { item_id: id, has_image: hasImg, via: 'queue' });
        var aiImageJob = coverRaw ? IMG.makeAiInput(coverRaw) : Promise.resolve(null);
        return aiImageJob.then(function (aiImage) {
          return S.loadTaxonomy().then(function (tax) {
            return AI.analyze({
              aiImage: aiImage,
              text: (item && item.raw_text) || '',
              url: (item && item.source_url) || '',
              // 抓到的网页标题 / 描述 / 正文：只填网址的素材模型只能看到一串 URL，
              // 分类判错多半出在这里（见 add.html 里同三条注释的来源）。
              pageTitle: (item && item.page_title) || '',
              pageDesc: (item && item.page_desc) || '',
              pageText: (item && item.page_text) || '',
              taxonomy: tax
            });
          });
        });
      })
      .then(function (r) {
        var patch = { status: 'done' };
        // 名字为空时不写 null：卡片上「没有名字」和「名字是空的」要能区分开，
        // 用空串表示「AI 判不出」，null 表示「这一列从来没被填过」。
        patch.ai_title = r.title || '';
        patch.ai_summary = r.summary;
        patch.ai_digest = r.digest || '';
        patch.ai_caption = r.caption;
        patch.ocr_text = r.ocrText;
        patch.ai_tags = r.tags;
        if (r.platform && !(item && item.source_platform)) patch.source_platform = r.platform;
        if (r.category) patch.category = r.category;
        patch.ai_raw = AI.snapshot(r);
        var local = { ms: r.ms, firstChunkMs: r.firstChunkMs, rect: r.rect, via: 'queue' };

        // AI 给了可信矩形就重裁封面；矩形不可信时保持整图（封面不因 AI 而变差）
        var cropJob = r.rect
          ? ensureRaw(id, item).then(function (cr) { return cr ? IMG.makeCover(cr, r.rect) : null; })
          : Promise.resolve(null);
        return cropJob.then(function (c) {
          if (c && c.coverSource === 'crop') {
            patch.cover_thumb = c.thumb.base64;
            patch.cover_source = 'crop';
          }
          var info = {
            ms: r.ms, firstChunkMs: r.firstChunkMs, rect: local.rect,
            categoryCorrected: r.categoryCorrected, outOfList: r.categoryOutOfList
          };
          return release(id, patch, attempts).then(function (saved) {
            saveRect(id, saved, item, local.rect);
            ev('ai_process_done', {
              item_id: id, ok: true, ms: info.ms, ttft_ms: info.firstChunkMs,
              got_rect: !!local.rect, had_image: hasImg, via: 'queue'
            });
            return { status: 'done', saved: saved, info: info };
          });
        });
      })
      .catch(function (e) {
        var hasResult = hasAiResult(item);
        // 失败原因分两类：超时（有明确降级说明）与其它错误（给原文）。
        // 与 add.html 原先的行为一致，别把它简化成一个字段——界面上的文案靠它分支。
        var info = {
          error: (e && e.code === 'AI_TIMEOUT') ? 'timeout' : '',
          msg: S.describe(e),
          retryFailed: hasResult
        };
        ev('ai_process_fail', {
          item_id: id, where: 'aiQueue.execute', msg: info.msg,
          had_result: hasResult, via: 'queue'
        });
        // 已有结果的重跑失败不能把好结果标成失败（与 add.html 里同一条判据）；
        // 这时候不动 status，只放租约、只累加次数。
        if (hasResult) {
          return dropLease(id, attempts).then(function () {
            return { status: 'done', saved: null, info: info };
          });
        }
        return release(id, { status: 'failed' }, attempts).then(function (saved) {
          notify(id, saved);
          return { status: 'failed', saved: saved, info: info };
        }).catch(function (e2) {
          console.warn('[aiQueue] 失败状态没写进库：' + S.describe(e2));
          return { status: 'failed', saved: null, info: info };
        });
      });
  }

  // 矩形按**图**存一份。只留 items.ai_raw.rect 是不够的：那只对应「送进模型的
  // 那一张」，用户换封面图之后那张新图就没有矩形可用（A14 实测踩到）。
  function saveRect(id, saved, item, rect) {
    if (!rect) return;
    var seq = (saved && saved.cover_index) || (item && item.cover_index) || 0;
    S.setImageRect(id, seq, rect).catch(function (e) {
      // 存矩形失败不能让这次识别看起来失败——AI 的结果已经写进 items 了。
      console.warn('[aiQueue] 裁切矩形没存上：' + S.describe(e));
    });
  }

  /* ---------- 扫描：任何页面打开都能接着跑 ---------- */

  /**
   * 扫库里所有卡住的 pending：
   *   - 租约空闲       → 直接领
   *   - 租约已过期     → 接管（上一个执行者多半已经关页了，这正是 B-001）
   *   - attempts 用尽  → 判死成 failed，界面上给「待补 / 重跑」出口
   * @returns Promise<{scanned, ran, dead}>
   */
  function sweep() {
    if (!isOwner() || sweeping) return Promise.resolve({ scanned: 0, ran: 0, dead: 0, skipped: true });
    sweeping = true;
    return S.listPendingAi(SWEEP_LIMIT).then(function (rows) {
      var now = Date.now();
      var todo = [], dead = [];
      rows.forEach(function (r) {
        var leasedUntil = r.ai_lease_until ? Date.parse(r.ai_lease_until) : 0;
        var busy = r.ai_lease_until && leasedUntil > now;
        if (busy) return;                                  // 别的页面正在跑，别碰
        if ((r.ai_attempts || 0) >= MAX_ATTEMPTS) { dead.push(r); return; }
        todo.push(r);
      });
      var deadJobs = dead.map(function (r) {
        return S.updateItem(r.id, { status: 'failed', ai_lease_until: null })
          .then(function (saved) { notify(r.id, saved); return true; })
          .catch(function () { return false; });
      });
      // 串行：AI 调用本身是串行的，多条一起发只会互相抬首字延迟。
      var chain = Promise.resolve();
      var ran = 0;
      var how = {};
      todo.forEach(function (r) {
        chain = chain.then(function () {
          return run(r.id, r).then(function (res) {
            if (res.claimed) { ran++; how[res.how] = (how[res.how] || 0) + 1; }
            return res;
          });
        });
      });
      return chain.then(function () {
        return Promise.all(deadJobs);
      }).then(function () {
        // how 里带认领方式（claim / steal）是给诊断用的：线上要能一眼看出
        // 「这条是被正常认领的，还是从死掉的执行者手里接管来的」。
        return { scanned: rows.length, ran: ran, dead: dead.length, how: how, skipped: false };
      });
    }).catch(function (e) {
      console.warn('[aiQueue] 扫描失败：' + S.describe(e));
      return { scanned: 0, ran: 0, dead: 0, error: S.describe(e) };
    }).then(function (r) {
      sweeping = false;
      return r;
    });
  }

  /**
   * 给普通页面用的一行入口：加载后延迟几秒扫一次库。
   * 为什么要延迟：sweep 是写操作（认领租约），不能抢首屏的渲染，
   * 而用户真正在意的卡面在 1 秒内就该出来。
   * @param {{delay?:number, onResult?:function}} [opts]
   */
  function autoSweep(opts) {
    opts = opts || {};
    var delay = typeof opts.delay === 'number' ? opts.delay : 2500;
    function go() {
      if (!isOwner()) return;          // 访客态不碰队列：认领租约是写操作
      sweep().then(function (r) {
        if (opts.onResult) { try { opts.onResult(r); } catch (e) { /* 旁路 */ } }
      });
    }
    if (document.readyState === 'complete') setTimeout(go, delay);
    else global.addEventListener('load', function () { setTimeout(go, delay); });
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.aiQueue = {
    subscribe: subscribe,
    claim: claim,
    steal: steal,
    release: release,
    autoSweep: autoSweep,
    ensureRaw: ensureRaw,
    rememberRaw: rememberRaw,
    hasAiResult: hasAiResult,
    run: run,
    sweep: sweep,
    isOwner: isOwner,
    constants: { LEASE_MS: LEASE_MS, MAX_ATTEMPTS: MAX_ATTEMPTS, SWEEP_LIMIT: SWEEP_LIMIT }
  };
})(window);
