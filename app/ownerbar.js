/* ============================================================
 * Elangit · 顶栏上的所有者开关
 * ------------------------------------------------------------
 * 三页（灵感库 / 收进灵感 / 素材详情）都要显示「现在是不是所有者」，
 * 所以抽到这里，避免三份重复逻辑。
 *
 * 它做两件事：
 *   1. 在 <body> 上打 is-owner / is-visitor 类。所有「只有所有者能看见」
 *      的东西在 style.css 里统一挂 .owner-only，页面不用各自判断权限——
 *      少一个页面漏判权限的机会（F5-4）。
 *   2. 提供一个就地解锁的输入行。用 window.prompt 会阻塞页面、
 *      也没法自动化测试，所以做成内联的。
 * ============================================================ */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  var lockTick = null;   // 锁定倒计时的定时器。必须是模块级：paint() 会换掉
                         // 顶栏的整块 HTML，局部变量管不住它，会漏出一个
                         // 永远在跑的定时器。

  function paint() {
    if (lockTick) { clearInterval(lockTick); lockTick = null; }
    var auth = global.Elangit.auth;
    var box = document.getElementById('ownerBar');
    if (!box) return;
    document.body.classList.toggle('is-owner', auth.isOwner());
    document.body.classList.toggle('is-visitor', !auth.isOwner());

    if (auth.isOwner()) {
      box.innerHTML = '<span class="own on">所有者 · 可编辑</span>'
        + '<button class="btn ghost sm" id="ownLock">退出</button>';
      document.getElementById('ownLock').addEventListener('click', function () {
        auth.lock();
        paint();
        if (global.Elangit.onOwnerChange) global.Elangit.onOwnerChange();
      });
    } else {
      box.innerHTML = '<span class="own">只读浏览</span>'
        + '<button class="btn ghost sm" id="ownUnlock">解锁编辑</button>';
      document.getElementById('ownUnlock').addEventListener('click', openForm);
    }
  }

  function openForm() {
    var box = document.getElementById('ownerBar');
    box.innerHTML = '<input class="ownpass" id="ownPass" type="password" placeholder="所有者口令" autocomplete="off">'
      + '<button class="btn sm" id="ownGo">确定</button>'
      + '<button class="btn ghost sm" id="ownCancel">取消</button>'
      + '<span class="ownerr" id="ownErr"></span>';
    var inp = document.getElementById('ownPass');
    inp.focus();
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') closeForm();
    });
    document.getElementById('ownGo').addEventListener('click', submit);
    document.getElementById('ownCancel').addEventListener('click', closeForm);

    // 锁定期内进来：直接显示还剩多久，并且每秒走一次。
    // 不做倒计时的话，用户会反复点「确定」怀疑是不是坏了（F7-3 的思路：
    // 被拒绝要说清原因，不能静默失败）。
    function refreshLock() {
      var a = global.Elangit.auth;
      var left = a.lockRemaining();
      var go = document.getElementById('ownGo');
      var err = document.getElementById('ownErr');
      if (!go || !err) return;
      if (left > 0) {
        go.disabled = true;
        inp.disabled = true;
        err.textContent = '已锁定，请 ' + left + ' 秒后再试';
        if (!lockTick) lockTick = setInterval(refreshLock, 1000);
      } else {
        go.disabled = false;
        inp.disabled = false;
        if (lockTick) { clearInterval(lockTick); lockTick = null; }
        if (err.textContent.indexOf('已锁定') === 0) err.textContent = '';
      }
    }
    if (global.Elangit.auth.lockRemaining() > 0) refreshLock();

    function closeForm() {
      if (lockTick) { clearInterval(lockTick); lockTick = null; }
      paint();
    }

    function submit() {
      var a = global.Elangit.auth;
      var v = inp.value;
      var err = document.getElementById('ownErr');
      err.textContent = '';

      if (a.lockRemaining() > 0) { refreshLock(); return; }

      a.unlock(v).then(function (ok) {
        if (ok) {
          closeForm();
          if (global.Elangit.onOwnerChange) global.Elangit.onOwnerChange();
          return;
        }
        if (a.lockRemaining() > 0) { refreshLock(); return; }
        // 把「还剩几次」说出来，用户才知道这个门禁是按次数算的
        var left = a.maxFails - a.failCount();
        err.textContent = '口令不对，还可以试 ' + left + ' 次';
        inp.select();
      }).catch(function (e) {
        err.textContent = (e && e.message) || '解锁失败';
      });
    }
  }

  function mount() { paint(); }

  global.Elangit = global.Elangit || {};
  global.Elangit.ownerBar = { mount: mount, paint: paint, esc: esc };
})(window);
