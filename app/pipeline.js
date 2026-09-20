/* ============================================================
 * Elangit · 图片处理管线
 * ------------------------------------------------------------
 * 职责（只做三件事，不碰网络、不碰数据库）：
 *   1. 把用户给的任意图片归一化成「原件」：长边 1600px、保持原始宽高比、
 *      不放大小图、统一 JPEG
 *   2. 从原件里裁出「封面」：按外部给的百分比矩形裁切（矩形由 AI 判断，见下）
 *   3. 从封面生成「卡片缩略图」：长边 400px、JPEG q72
 *
 * 为什么不在这里做裁切判断：
 *   判断「哪块是照片、哪块是文字面板」由 AI 完成（同一次 AI 调用顺带返回
 *   百分比矩形，不额外花钱）。本模块只负责「按矩形裁」，不做启发式猜测——
 *   少一个不可解释的失败来源。
 *   AI 没给矩形、矩形不可信、或矩形等于整图时，封面直接用整图，
 *   并标记 coverSource = 'raw'（对应 PRD F5-8：封面可换回原图）。
 *
 * 为什么多做一步「送模型的图」（makeAiInput）：
 *   1600px 的原件直接丢给模型，耗时会随图片复杂度飙到 30s 以上，且对
 *   判断结果没有增益——实测把送模型的图压到长边 1000px 后，小红书截图
 *   的裁切判断仍然准到 0.2 个百分点（59% vs 人工 58.8%），而耗时明显下降。
 *   所以「存 1600 / 送 1000」是固定策略，收敛在这里，页面不再各自决定。
 *
 * 对外接口：
 *   Elangit.imaging.processAll(sources)            -> [原件...]
 *   Elangit.imaging.makeAiInput(rawItem)           -> { base64, mime, width, height, byteSize }
 *   Elangit.imaging.makeCover(rawItem, rectPct)    -> { cover, thumb, coverSource, cropApplied }
 *   Elangit.imaging.processOne(source, rectPct)    -> { raw, cover, thumb, coverSource, cropApplied }
 *   Elangit.imaging.fromPasteEvent(ev)             -> { files, text }
 * ============================================================ */
(function (global) {
  'use strict';

  var CFG = {
    RAW_LONG_EDGE: 1600,    // 原件长边上限
    RAW_QUALITY: 0.88,      // 原件 JPEG 质量
    THUMB_LONG_EDGE: 400,   // 缩略图长边
    THUMB_QUALITY: 0.72,    // 缩略图 JPEG 质量
    AI_LONG_EDGE: 1000,     // 送模型识别的图，长边上限（不是存储图）
    AI_QUALITY: 0.80,       // 送模型识别的图，JPEG 质量
    MIN_CROP_SIDE_RATIO: 0.25  // 裁出的宽或高小于原图的 25% 时，视为矩形不可信
  };

  /* ---------- 基础工具 ---------- */

  function fitLongEdge(w, h, maxLong) {
    var long = Math.max(w, h);
    if (long <= maxLong) return { width: w, height: h, scaled: false };
    var s = maxLong / long;
    return {
      width: Math.max(1, Math.round(w * s)),
      height: Math.max(1, Math.round(h * s)),
      scaled: true
    };
  }

  function createCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // 统一用白底：截图可能是带透明通道的 PNG，转 JPEG 前必须铺白底，
  // 否则透明区域会变黑。
  function drawOn(canvas, img, sx, sy, sw, sh, dw, dh) {
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    return canvas;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('canvas 导出失败'));
      }, 'image/jpeg', quality);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = function () { reject(fr.error || new Error('读取图片数据失败')); };
      fr.readAsDataURL(blob);
    });
  }

  function decode(source) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(source).catch(function () { return decodeViaImg(source); });
    }
    return decodeViaImg(source);
  }

  function decodeViaImg(source) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(source);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败，可能不是图片格式')); };
      img.src = url;
    });
  }

  function sizeOf(img) {
    return {
      width: img.width || img.naturalWidth,
      height: img.height || img.naturalHeight
    };
  }

  /* ---------- 裁切矩形 ---------- */

  // 把 AI 给的百分比矩形换算成像素矩形。任何可疑情况一律返回 null（=不裁）。
  function normalizeRect(rectPct, W, H) {
    if (!rectPct) return null;
    var l = Number(rectPct.left), t = Number(rectPct.top),
        r = Number(rectPct.right), b = Number(rectPct.bottom);
    if (!isFinite(l) || !isFinite(t) || !isFinite(r) || !isFinite(b)) return null;

    l = Math.min(100, Math.max(0, l));
    t = Math.min(100, Math.max(0, t));
    r = Math.min(100, Math.max(0, r));
    b = Math.min(100, Math.max(0, b));
    if (r <= l || b <= t) return null;

    var x = Math.round(W * l / 100);
    var y = Math.round(H * t / 100);
    var w = Math.round(W * r / 100) - x;
    var h = Math.round(H * b / 100) - y;
    if (w < 1 || h < 1) return null;

    // 裁得太狠说明模型判断多半出错了，宁可退回整图
    if (w < W * CFG.MIN_CROP_SIDE_RATIO || h < H * CFG.MIN_CROP_SIDE_RATIO) return null;
    // 等于整图 = 本来就没打算裁
    if (w >= W && h >= H) return null;

    return { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
  }

  /* ---------- 三步主流程 ---------- */

  // 单张 -> 原件（长边 1600 归一）
  function encodeRaw(img) {
    var s = sizeOf(img);
    var t = fitLongEdge(s.width, s.height, CFG.RAW_LONG_EDGE);
    var canvas = drawOn(createCanvas(t.width, t.height), img, 0, 0, s.width, s.height, t.width, t.height);
    return canvasToBlob(canvas, CFG.RAW_QUALITY).then(function (blob) {
      return blobToBase64(blob).then(function (b64) {
        return {
          canvas: canvas,
          base64: b64,
          mime: 'image/jpeg',
          width: t.width,
          height: t.height,
          byteSize: blob.size,
          sourceWidth: s.width,
          sourceHeight: s.height,
          upscaled: false
        };
      });
    });
  }

  function processRaw(source) {
    return decode(source).then(encodeRaw);
  }

  function processAll(sources) {
    var list = Array.prototype.slice.call(sources || []);
    return Promise.all(list.map(processRaw));
  }

  // 原件 -> 送模型识别的图（长边 1000）。元件本来就小于上限时直接复用，
  // 不重新编码，省一次 canvas 往返。
  function makeAiInput(rawItem) {
    if (!rawItem) return Promise.reject(new Error('makeAiInput 需要原件对象'));
    var long = Math.max(rawItem.width, rawItem.height);
    if (long <= CFG.AI_LONG_EDGE) {
      return Promise.resolve({
        base64: rawItem.base64,
        mime: rawItem.mime,
        width: rawItem.width,
        height: rawItem.height,
        byteSize: rawItem.byteSize,
        reused: true
      });
    }
    var t = fitLongEdge(rawItem.width, rawItem.height, CFG.AI_LONG_EDGE);
    var canvas = drawOn(
      createCanvas(t.width, t.height),
      rawItem.canvas, 0, 0, rawItem.width, rawItem.height, t.width, t.height
    );
    return encodeCanvas(canvas, CFG.AI_QUALITY, t.width, t.height).then(function (r) {
      r.reused = false;
      return r;
    });
  }

  // 从已有原件裁封面 + 生成缩略图
  function makeCover(rawItem, rectPct) {
    var rect = normalizeRect(rectPct, rawItem.width, rawItem.height);
    var coverSource = rect ? 'crop' : 'raw';
    var coverCanvas, coverW, coverH;

    if (rect) {
      coverW = rect.width;
      coverH = rect.height;
      coverCanvas = drawOn(
        createCanvas(coverW, coverH),
        rawItem.canvas,
        rect.left, rect.top, rect.width, rect.height,
        coverW, coverH
      );
    } else {
      coverCanvas = rawItem.canvas;
      coverW = rawItem.width;
      coverH = rawItem.height;
    }

    var t = fitLongEdge(coverW, coverH, CFG.THUMB_LONG_EDGE);
    var thumbCanvas = drawOn(
      createCanvas(t.width, t.height),
      coverCanvas, 0, 0, coverW, coverH, t.width, t.height
    );

    return Promise.all([
      encodeCanvas(coverCanvas, CFG.RAW_QUALITY, coverW, coverH),
      encodeCanvas(thumbCanvas, CFG.THUMB_QUALITY, t.width, t.height)
    ]).then(function (r) {
      return {
        cover: r[0],
        thumb: r[1],
        coverSource: coverSource,
        cropApplied: rect ? {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height
        } : null
      };
    });
  }

  function encodeCanvas(canvas, quality, w, h) {
    return canvasToBlob(canvas, quality).then(function (blob) {
      return blobToBase64(blob).then(function (b64) {
        return { base64: b64, mime: 'image/jpeg', width: w, height: h, byteSize: blob.size };
      });
    });
  }

  // 一步到位：单张图 -> 原件 + 封面 + 缩略图
  function processOne(source, rectPct) {
    return processRaw(source).then(function (raw) {
      return makeCover(raw, rectPct).then(function (c) {
        return {
          raw: raw,
          cover: c.cover,
          thumb: c.thumb,
          coverSource: c.coverSource,
          cropApplied: c.cropApplied
        };
      });
    });
  }

  /* ---------- 录入入口：从粘贴事件里取内容 ---------- */

  // 返回 { files: [File...], text: string }
  // 对应 PRD F1-2：按下粘贴键且剪贴板含图片时直接接收
  function fromPasteEvent(ev) {
    var out = { files: [], text: '' };
    var cb = ev && (ev.clipboardData || ev.originalEvent && ev.originalEvent.clipboardData);
    if (!cb) return out;
    var items = cb.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) out.files.push(f);
      }
    }
    if (!out.files.length) out.text = cb.getData ? (cb.getData('text') || '') : '';
    return out;
  }

  /* ---------- 导出 ---------- */

  global.Elangit = global.Elangit || {};
  global.Elangit.imaging = {
    CFG: CFG,
    fitLongEdge: fitLongEdge,
    normalizeRect: normalizeRect,
    processRaw: processRaw,
    processAll: processAll,
    makeAiInput: makeAiInput,
    makeCover: makeCover,
    processOne: processOne,
    fromPasteEvent: fromPasteEvent
  };
})(window);
