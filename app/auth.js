/* ============================================================
 * Elangit · 所有者门禁
 * ------------------------------------------------------------
 * 只回答一个问题：**现在这个人是不是所有者**。
 *
 * 为什么是这个形态（不要指望它防住决心足够的人）：
 *   网站部署到公网后，任何知道网址的人都能打开它。R-1 的结论是
 *   「接受前端口令的降级」——不上账号体系，用最低成本机制兜住
 *   「随手点进来的人改不了、删不掉」，仅此而已。
 *   因此口令的哈希写在前端，解锁状态记在 localStorage。它拦的是
 *   误操作与路人，不是攻击者。真正不可逆的操作（任务 9 的发布）
 *   会单独拿同意，不依赖这里。
 *
 * 为什么是 SHA-256 而不是明文比对：
 *   明文会随页面源码直接暴露，哈希至少让它不能一眼读到。
 *   对短口令来说哈希可被穷举，这是已知且已接受的代价。
 *
 * 依赖 secure context：crypto.subtle 只在 https 或 localhost 下可用。
 * 本地开发走 127.0.0.1（被浏览器视为安全上下文），所以能跑；
 * 但用局域网 IP 打开会拿不到 crypto.subtle —— 那时 unlock 会明确报错，
 * 不会静静地「永远解锁不了」。
 *
 * 对外接口：
 *   Elangit.auth.isOwner()            -> boolean（同步，随时可问）
 *   Elangit.auth.unlock(pass)         -> Promise<boolean>
 *   Elangit.auth.lock()               -> void
 *   Elangit.auth.lockRemaining()      -> number（秒，0 表示没被锁）
 *   Elangit.auth.failCount()          -> number（锁定周期内已错几次）
 *   Elangit.auth.onChange(fn)         -> 解除函数
 *   Elangit.auth.requireOwner()       -> Promise<void>，非所有者时 reject（写操作前调用）
 * ============================================================ */
(function (global) {
  'use strict';

  var cfg = global.Elangit.config;
  var KEY = 'elangit.owner';
  var FAIL_KEY = 'elangit.owner.fails';
  var LOCK_KEY = 'elangit.owner.lockUntil';
  var listeners = [];

  /* ---------- F7-4 频率限制 ---------- */
  // 连错 5 次锁 60 秒（2026-09-20 与用户确认的数字）。
  //
  // 计数与锁定时间都写 localStorage，**刷新页面不能绕过**——否则这个限制
  // 只要按一下 F5 就失效了，等于没做。
  //
  // 它的真实强度要说清楚：这是**纯前端**限制。清掉浏览器数据、或直接在
  // 控制台调 unlock，都能重置。它拦的是「手滑反复试同一个错口令」，
  // 不是破解。真要有服务端级限制，得先有账号体系（v2）。
  //
  // 用户只指定了「5 次 / 60 秒」这一档，**没有做递增惩罚**（比如第二次锁 10 分钟）：
  // 多出来的档位是我没被要求的行为，不做。将来想加，改 MAX_FAILS / LOCK_MS 即可。
  var MAX_FAILS = 5;
  var LOCK_MS = 60 * 1000;

  function num(key, dflt) {
    try {
      var v = global.localStorage.getItem(key);
      return v == null ? dflt : (Number(v) || 0);
    } catch (e) { return dflt; }
  }
  function setNum(key, v) {
    try {
      if (v) global.localStorage.setItem(key, String(v));
      else global.localStorage.removeItem(key);
    } catch (e) { /* 存不进去只影响本机限制，不影响功能 */ }
  }

  function lockRemaining() {
    var left = num(LOCK_KEY, 0) - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }
  function failCount() { return num(FAIL_KEY, 0); }
  function clearLimit() { setNum(FAIL_KEY, 0); setNum(LOCK_KEY, 0); }

  function readFlag() {
    try { return global.localStorage.getItem(KEY) === '1'; }
    catch (e) { return false; }   // 隐私模式下 localStorage 会抛，当作未解锁
  }

  function writeFlag(on) {
    try {
      if (on) global.localStorage.setItem(KEY, '1');
      else global.localStorage.removeItem(KEY);
    } catch (e) { /* 存不进去就只影响本次会话的记忆，不影响功能 */ }
  }

  var owner = readFlag();

  function isOwner() { return owner; }

  function setOwner(on) {
    owner = !!on;
    writeFlag(owner);
    listeners.forEach(function (fn) {
      try { fn(owner); } catch (e) { /* 一个监听器出错不影响其他 */ }
    });
  }

  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function sha256hex(text) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error(
        '当前环境拿不到加密接口（crypto.subtle 只在 https 或 localhost 可用）。'
        + '请换用 https 地址或 127.0.0.1 打开。'
      ));
    }
    var bytes = new TextEncoder().encode(text);
    return global.crypto.subtle.digest('SHA-256', bytes).then(toHex);
  }

  function unlock(pass) {
    // 锁定期内连哈希都不算：既省一次计算，也让「锁定」这件事在代码里
    // 是显式的一步，而不是靠界面自觉不去调用。
    if (lockRemaining() > 0) return Promise.resolve(false);

    return sha256hex(String(pass == null ? '' : pass)).then(function (h) {
      var ok = !!cfg.ownerPasscodeHash && h === cfg.ownerPasscodeHash;
      if (ok) {
        clearLimit();
        setOwner(true);
        return true;
      }
      var fails = failCount() + 1;
      if (fails >= MAX_FAILS) {
        // 触到上限：开始锁，并把计数清零——锁是这一轮的结束，
        // 解锁之后重新从 0 开始数。
        setNum(LOCK_KEY, Date.now() + LOCK_MS);
        setNum(FAIL_KEY, 0);
      } else {
        setNum(FAIL_KEY, fails);
      }
      return false;
    });
  }

  function lock() { setOwner(false); }

  function onChange(fn) {
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // 写操作前的守门。把「不是所有者」变成一个明确的拒绝，
  // 而不是让它悄悄写进去（对应 F7-1 / F7-3）。
  function requireOwner() {
    if (owner) return Promise.resolve();
    return Promise.reject(new Error('需要所有者身份：点右上角「解锁编辑」输入口令。'));
  }

  global.Elangit = global.Elangit || {};
  global.Elangit.auth = {
    isOwner: isOwner,
    unlock: unlock,
    lock: lock,
    lockRemaining: lockRemaining,
    failCount: failCount,
    maxFails: MAX_FAILS,
    lockMs: LOCK_MS,
    onChange: onChange,
    requireOwner: requireOwner,
    sha256hex: sha256hex
  };
})(window);
