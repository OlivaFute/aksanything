/*!
 * pdf-reader.js — PDF 阅读页的渲染引擎
 *
 * 职责（P1）：
 *   1. 用 pdf.js 把 PDF 渲染成「canvas（可见）+ textLayer（真实 DOM span）」
 *   2. 按需渲染 —— 只为进入视口附近的页建 canvas，几百页也不卡
 *   3. 页码指示与缩放
 *
 * 为什么不用浏览器内置阅读器：内置阅读器的 PDF 内容在插件层，页面 JS 读不到
 * 任何文字（实测 getSelection() 恒为空串）。pdf.js 的文本层是真实 DOM，
 * 划词、选区、注入脚本都正常 —— 这是唯一能让「划词提问」在 PDF 上工作的方式。
 *
 * 加载顺序约定：本文件必须在 ask-ai.js 之前加载，P2 会在这里注册
 * window.__ASK_ADAPTER__，让划词组件知道怎么在 PDF 里取章节与段落。
 */
(function () {
  'use strict';

  var DOC = window.__PDF_DOC__;
  var view = document.getElementById('pdfx-view');
  var pageLabel = document.getElementById('pdfx-page');
  var zoomLabel = document.getElementById('pdfx-zoom');
  var prevBtn = document.getElementById('pdfx-prev');
  var nextBtn = document.getElementById('pdfx-next');
  var tocBody = document.getElementById('pdfx-toc-body');
  var tocPanel = document.getElementById('pdfx-toc');
  var tocBtn = document.getElementById('pdfx-toc-btn');
  var tocMask = document.getElementById('pdfx-mask');
  var tocTitle = document.getElementById('pdfx-toc-title');

  var BASE_SCALE = 1.35;
  var MIN_SCALE = 0.4;
  var MAX_SCALE = 4;

  var pdf = null;
  var scale = BASE_SCALE;
  var baseSize = { w: 0, h: 0 };
  var boxes = [];
  var pageState = {};   // 页码 -> 'busy' | 'done'
  var current = 1;
  var observer = null;
  var scrollBound = false;

  function message(html) {
    view.innerHTML = '<div class="pdfx-msg">' + html + '</div>';
  }

  function setLabel() {
    if (!pdf) return;
    pageLabel.textContent = current + ' / ' + pdf.numPages;
    zoomLabel.textContent = Math.round((scale / BASE_SCALE) * 100) + '%';
    prevBtn.disabled = current <= 1;
    nextBtn.disabled = current >= pdf.numPages;
  }

  /** 建出所有页的占位容器：高度先算好，滚动条与总高度才是对的 */
  function layout() {
    view.innerHTML = '';
    boxes = [];
    pageState = {};
    var w = Math.floor(baseSize.w * scale);
    var h = Math.floor(baseSize.h * scale);
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= pdf.numPages; i++) {
      var box = document.createElement('div');
      box.className = 'pdfx-page-box';
      box.dataset.page = String(i);
      box.style.width = w + 'px';
      box.style.height = h + 'px';
      box.innerHTML = '<div class="pdfx-ph">' + i + '</div>';
      frag.appendChild(box);
      boxes.push(box);
    }
    view.appendChild(frag);
  }

  /**
   * 把某一页画到 canvas 上，返回该页的 viewport。
   *
   * 像素尺寸按**渲染那一刻的 devicePixelRatio** 决定 —— 这正是「缩放网页后变模糊」的根源：
   * 网页缩放会改变 dpr，但已经画好的 canvas 不会自己重画，浏览器只能把旧位图拉伸，
   * 于是发虚。所以这里把「画 canvas」单独抽出来，dpr 变化时对已渲染的页重跑一遍（见 checkDpr）。
   */
  async function paintCanvas(n, box) {
    var page = await pdf.getPage(n);
    var vp = page.getViewport({ scale: scale });
    var dpr = window.devicePixelRatio || 1;

    var old = box.querySelector('canvas');
    if (old) old.parentNode.removeChild(old);

    var canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = Math.floor(vp.width) + 'px';
    canvas.style.height = Math.floor(vp.height) + 'px';
    box.insertBefore(canvas, box.firstChild);

    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    return vp;
  }

  async function renderPage(n) {
    if (pageState[n]) return;
    pageState[n] = 'busy';
    var box = boxes[n - 1];
    if (!box) return;
    try {
      var vp = await paintCanvas(n, box);

      // 文本层：透明 span 精确覆盖在 canvas 上，划词靠的就是它
      var page = await pdf.getPage(n);
      var tc = await page.getTextContent();
      var tl = document.createElement('div');
      tl.className = 'pdfx-text';
      tl.style.width = Math.floor(vp.width) + 'px';
      tl.style.height = Math.floor(vp.height) + 'px';
      // 必须设置：pdf.js 3.x 靠它计算 span 位置，缺了会全堆在原点、一个字都选不中
      tl.style.setProperty('--scale-factor', String(scale));
      box.appendChild(tl);
      await pdfjsLib.renderTextLayer({
        textContent: tc,
        container: tl,
        viewport: vp,
        textDivs: [],
      }).promise;

      var ph = box.querySelector('.pdfx-ph');
      if (ph) ph.parentNode.removeChild(ph);

      // 扫描件（无文本层）在这里就能看出来
      if (n === 1 && (tl.querySelectorAll('span').length === 0 || tl.textContent.trim().length < 10)) {
        window.__PDF_NO_TEXT__ = true;
        var warn = document.createElement('div');
        warn.className = 'pdfx-msg';
        warn.style.margin = '0 auto 16px';
        warn.innerHTML =
          '<b>这份 PDF 没有文本层</b>（多半是扫描件或纯图片导出）。画面可以正常阅读，' +
          '但无法划词提问 —— 需要先做 OCR 才能取到文字。';
        view.insertBefore(warn, view.firstChild);
      }

      pageState[n] = 'done';
    } catch (e) {
      pageState[n] = 'busy'; // 允许重试
      console.warn('第 ' + n + ' 页渲染失败', e);
    }
  }

  function updateCurrent() {
    if (!pdf) return;
    var anchor = window.scrollY + 46 + 60;
    var n = 1;
    for (var i = 0; i < boxes.length; i++) {
      if (boxes[i].offsetTop <= anchor) n = i + 1;
      else break;
    }
    if (n !== current) {
      current = n;
      setLabel();
      highlightToc();
    }
    // 供上下文层取「当前页」
    window.__PDF_CURRENT_PAGE__ = n;
  }

  function observe() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) renderPage(Number(en.target.dataset.page));
        });
        updateCurrent();
      },
      { rootMargin: '400px 0px' }
    );
    boxes.forEach(function (b) { observer.observe(b); });

    if (!scrollBound) {
      scrollBound = true;
      var ticking = false;
      window.addEventListener('scroll', function () {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(function () { ticking = false; updateCurrent(); });
      }, { passive: true });
    }
  }

  function goPage(n) {
    n = Math.max(1, Math.min(pdf.numPages, n));
    var box = boxes[n - 1];
    if (box) window.scrollTo({ top: Math.max(0, box.offsetTop - 46 - 24), behavior: 'smooth' });
  }

  async function setScale(next) {
    next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    if (Math.abs(next - scale) < 0.001) return;
    var keep = current;
    scale = next;
    layout();
    observe();
    updateCurrent();
    setLabel();
    var box = boxes[keep - 1];
    if (box) window.scrollTo(0, Math.max(0, box.offsetTop - 46 - 24));
  }

  function bindTools() {
    prevBtn.addEventListener('click', function () { goPage(current - 1); });
    nextBtn.addEventListener('click', function () { goPage(current + 1); });
    document.getElementById('pdfx-zoom-in').addEventListener('click', function () { setScale(scale * 1.25); });
    document.getElementById('pdfx-zoom-out').addEventListener('click', function () { setScale(scale / 1.25); });
    document.addEventListener('keydown', function (e) {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      // 目录开着时 Esc 只收目录，不要连带把提问抽屉也关了
      if (e.key === 'Escape' && tocPanel && tocPanel.classList.contains('open')) {
        closeToc();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        return;
      }
      if (e.key === 'PageDown' || (e.key === 'ArrowRight' && e.altKey)) goPage(current + 1);
      if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.altKey)) goPage(current - 1);
    });
  }

  /* ================================================================ */
  /* 网页缩放（devicePixelRatio 变化）后重画                            */
  /* ================================================================ */
  /* 浏览器缩放（Ctrl +/−、Ctrl 滚轮、触控板捏合）会改变 devicePixelRatio。
     canvas 是按「画它的那一刻」的 dpr 决定的像素密度，之后不会自己重画 ——
     浏览器只能把旧位图拉伸到新密度，于是就发虚。
     文本层不受影响（span 位置是 CSS 像素），所以这里只重画 canvas。 */

  var lastDpr = window.devicePixelRatio || 1;
  var dprTimer = null;

  function checkDpr() {
    var dpr = window.devicePixelRatio || 1;
    if (Math.abs(dpr - lastDpr) < 0.01) return;
    lastDpr = dpr;
    clearTimeout(dprTimer);
    dprTimer = setTimeout(repaintRendered, 220); // 连续缩放时只跑最后一次
  }

  async function repaintRendered() {
    if (!pdf) return;
    for (var n = 1; n <= pdf.numPages; n++) {
      if (pageState[n] !== 'done') continue;
      var box = boxes[n - 1];
      if (!box || !box.querySelector('canvas')) continue;
      try {
        await paintCanvas(n, box);
      } catch (e) {
        /* 单页失败不影响其他页 */
      }
    }
  }

  /** resize 是主力；matchMedia 兜住「视口尺寸没变但 dpr 变了」的情况 */
  function bindDprWatch() {
    window.addEventListener('resize', checkDpr, { passive: true });
    if (!window.matchMedia) return;
    var attach = function () {
      var dpr = window.devicePixelRatio || 1;
      var mq;
      try {
        mq = window.matchMedia('(resolution: ' + dpr + 'dppx)');
      } catch (e) {
        return;
      }
      var onChange = function () {
        checkDpr();
        attach(); // dpr 变了，重新绑到新分辨率
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange, { once: true });
      else if (mq.addListener) mq.addListener(onChange);
    };
    attach();
  }

  async function boot() {
    if (!DOC || !DOC.url) {
      message('<b>缺少 PDF 参数。</b>这个页面需要通过 <code>/pdf?file=…</code> 打开。');
      return;
    }
    if (typeof pdfjsLib === 'undefined') {
      message('<b>pdf.js 未能加载。</b>请确认 <code>assets/pdfjs/</code> 下有 pdf.min.js 与 pdf.worker.min.js。');
      return;
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/pdf.worker.min.js';
    try {
      pdf = await pdfjsLib.getDocument({ url: DOC.url }).promise;
    } catch (e) {
      message('<b>无法打开这份 PDF：</b>' + String(e && e.message ? e.message : e) +
        '<br>请检查文件是否还存在、是否被其他程序占用。');
      return;
    }
    var p1 = await pdf.getPage(1);
    var vp = p1.getViewport({ scale: 1 });
    baseSize = { w: vp.width, h: vp.height };
    scale = BASE_SCALE;
    layout();
    observe();
    updateCurrent();
    setLabel();
    bindTools();
    bindDprWatch();
    bindToc();
    window.__PDF_READY__ = { pages: pdf.numPages, title: DOC.title };
    // 书签异步加载，不阻塞首屏。加载完成后：section() 才有真实章节名、
    // 目录侧栏才能渲染、&ch= 跳章才有依据。
    loadOutline().then(applyChapterParam);
  }

  /* ================================================================ */
  /* 划词适配器                                                        */
  /* ================================================================ */
  /* ask-ai.js 要从文档里读三样东西：正文根节点、当前章节、选区所在段落。
     PDF 里既没有 <h2> 也没有 <p>，所以：
       章节 → PDF 自带的书签（outline），拿不到就退化成「第 N 页」
       段落 → 文本层 span 的坐标聚合（PDF 的文本层是逐行逐词的碎 span，没有段落标签）
     这个对象要在 ask-ai.js 之前挂好，脚本顺序已在 pdf-viewer.html 里定死。 */

  var outline = []; // 展平 [{ title, page, level }]：section() 判定与目录高亮用
  var outlineTree = []; // 树 [{ title, page, items }]：侧栏渲染用

  /** 把书签的 dest 解析成页码（dest 形如 [pageRef, {name:'XYZ'}, ...]） */
  async function destToPage(dest) {
    try {
      var d = dest;
      if (typeof d === 'string') d = await pdf.getDestination(d);
      if (!Array.isArray(d) || !d.length) return null;
      var first = d[0];
      if (first && typeof first === 'object') return (await pdf.getPageIndex(first)) + 1;
      if (typeof first === 'number') return first + 1;
    } catch (e) {
      /* 有些 PDF 的 dest 不规范，忽略即可 */
    }
    return null;
  }

  async function loadOutline() {
    try {
      var raw = await pdf.getOutline();
      if (!raw || !raw.length) {
        renderToc();
        return;
      }

      // 递归展开子书签：章节会细化到 3.1.2 这种层级，匹配"当前在第几章"时越细越准。
      // 上限 400 条是性能兜底（实测 200 条解析耗时 <0.5s，且完全是异步、不阻塞渲染）。
      var flat = [];
      var guard = 0;
      async function walk(items, level) {
        var out = [];
        for (var i = 0; i < items.length && guard < 400; i++) {
          var it = items[i];
          if (!it) continue;
          guard++;
          var node = { title: String(it.title || '').trim() || '(无标题)', items: [] };
          var p = await destToPage(it.dest);
          if (p) {
            node.page = p;
            flat.push({ title: node.title, page: p, level: level });
          }
          if (it.items && it.items.length) node.items = await walk(it.items, level + 1);
          out.push(node);
        }
        return out;
      }
      outlineTree = await walk(raw, 0);

      flat.sort(function (a, b) {
        return a.page - b.page || a.level - b.level;
      });
      outline = flat;
      renderToc();
    } catch (e) {
      outline = [];
      outlineTree = [];
      renderToc();
    }
  }

  function sectionTitle() {
    if (!outline.length) return '第 ' + current + ' 页';
    var cur = '';
    for (var i = 0; i < outline.length; i++) {
      if (outline[i].page <= current) cur = outline[i].title;
      else break;
    }
    return cur || '第 ' + current + ' 页';
  }

  /* ================================================================ */
  /* 目录侧栏（按 PDF 书签跳章节）                                     */
  /* ================================================================ */

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function renderToc() {
    if (!tocBody) return;
    if (!outline.length) {
      tocBody.innerHTML =
        '<div class="pdfx-toc-empty">这份 PDF 没有内嵌书签，无法按章节跳转。' +
        '<br>用页码按钮或直接滚动浏览即可。</div>';
      tocBtn.disabled = true;
      return;
    }
    var html = '';
    outline.forEach(function (o, i) {
      var pad = 13 + (o.level || 0) * 13;
      html +=
        '<button type="button" class="pdfx-toc-item" data-i="' + i + '" data-page="' + o.page + '"' +
        ' style="padding-left:' + pad + 'px">' +
        '<span class="pdfx-toc-pg">' + o.page + '</span>' +
        escHtml(o.title) +
        '</button>';
    });
    tocBody.innerHTML = html;
    tocBtn.disabled = false;
    tocTitle.textContent = '文献目录 · ' + outline.length + ' 条';
    highlightToc();
  }

  function openToc() {
    tocPanel.classList.add('open');
    tocBtn.classList.add('on');
    tocMask.classList.add('on');
    tocPanel.setAttribute('aria-hidden', 'false');
    highlightToc();
  }

  function closeToc() {
    tocPanel.classList.remove('open');
    tocBtn.classList.remove('on');
    tocMask.classList.remove('on');
    tocPanel.setAttribute('aria-hidden', 'true');
  }

  function toggleToc() {
    if (tocPanel.classList.contains('open')) closeToc();
    else openToc();
  }

  /** 把当前章节标出来，并让它保持可见 */
  function highlightToc() {
    if (!tocBody || !outline.length) return;
    var idx = -1;
    for (var i = 0; i < outline.length; i++) {
      if (outline[i].page <= current) idx = i;
      else break;
    }
    var items = tocBody.querySelectorAll('.pdfx-toc-item');
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('cur', j === idx);
    if (!tocPanel.classList.contains('open')) return;
    var curEl = idx >= 0 ? items[idx] : null;
    if (!curEl) return;
    var top = curEl.offsetTop;
    var h = tocBody.clientHeight;
    if (top < tocBody.scrollTop || top > tocBody.scrollTop + h - 34) {
      tocBody.scrollTop = Math.max(0, top - h / 2);
    }
  }

  function bindToc() {
    if (!tocBtn || !tocBody) return;
    tocBtn.addEventListener('click', toggleToc);
    document.getElementById('pdfx-toc-close').addEventListener('click', closeToc);
    tocMask.addEventListener('click', closeToc);
    tocBody.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.pdfx-toc-item') : null;
      if (!b) return;
      var p = Number(b.getAttribute('data-page'));
      if (p > 0) {
        goPage(p);
        closeToc();
      }
    });
  }

  /* ---------------- 从 URL 的 &ch= 跳到某一章 ---------------- */

  /**
   * 把课程正文里的章节标记（`Ch.9` / `§1.2` / `第 9 章`）解析成页码。
   *
   * 只认「书签标题里就带这个编号」的情况 —— 例如中文论文的书签是「4.1 双帧解调」。
   * **刻意不猜**：早期版本试过"跳过前置页后数第 N 条书签"，结果把「第 9 章」定位到
   * 第 19 页（真实位置是第 198 页），差 179 页还提示成功 —— 那比不跳更糟。
   * 现在解析不出就返回 0，由调用方降级成「打开目录让他自己选」。
   *
   * 外文书的章号（正文里是「9   Coherence Scanning Interferometry」这种形态）
   * 由服务端从全文里解析成精确页码，前端通过链接的 `&page=` 直接带过来。
   */
  function resolveChapter(ch) {
    if (!ch || !outline.length) return 0;
    var want = String(ch).trim();
    if (!want) return 0;
    var safe = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var i;

    // ① 标题本身就以这个编号开头，如「9. Introduction」「4.1 双帧解调」
    var head = new RegExp('^\\s*' + safe + '(?:\\.|\\s|、|:|：|$)', 'i');
    for (i = 0; i < outline.length; i++) {
      if (head.test(outline[i].title)) return outline[i].page;
    }
    // ② 标题里含这个编号，如「Chapter 9 xxx」「第 9 章 xxx」
    var inside = new RegExp('(?:^|[^0-9])' + safe + '(?:\\.|\\s|、|:|：|章|节)', 'i');
    for (i = 0; i < outline.length; i++) {
      if (inside.test(outline[i].title)) return outline[i].page;
    }
    return 0; // 解析不出就不猜
  }

  function toast(msg) {
    var el = document.createElement('div');
    el.className = 'pdfx-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add('on'); }, 20);
    setTimeout(function () {
      el.classList.remove('on');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 6000);
  }

  function applyChapterParam() {
    var sp;
    try {
      sp = new URLSearchParams(location.search);
    } catch (e) {
      return; // 老浏览器不支持 URLSearchParams，忽略跳转参数即可
    }
    var ch = sp.get('ch');
    var pageParam = Number(sp.get('page')) || 0;

    // ① 服务端已从全文里解析出精确页码 —— 最可靠，直接用
    if (pageParam > 0) {
      goPage(pageParam);
      toast('已跳到第 ' + pageParam + ' 页' + (ch ? '（第 ' + ch + ' 章）' : ''));
      return;
    }

    if (!ch) return;

    // ② 退而用 PDF 书签里带编号的项去匹配（中文论文的书签常带编号）
    if (outline.length) {
      var p = resolveChapter(ch);
      if (p > 0) {
        goPage(p);
        toast('已跳到第 ' + ch + ' 章（第 ' + p + ' 页）');
        return;
      }
      // ③ 定位不到就把目录打开让他自己挑 —— 比猜一个错页码好
      openToc();
      toast('未能自动定位「第 ' + ch + ' 章」，已打开目录，请在其中选择。');
    } else {
      toast('这份 PDF 没有书签，无法定位到第 ' + ch + ' 章。');
    }
  }

  function pageBoxOf(node) {
    if (!node) return null;
    if (node.nodeType === 3) node = node.parentNode;
    var guard = 0;
    while (node && node !== document.body && guard++ < 30) {
      if (node.classList && node.classList.contains('pdfx-page-box')) return node;
      node = node.parentNode;
    }
    return null;
  }

  /**
   * 取「选区所在的整段」。
   * 原理：以选区的水平中心定「栏」（防双栏论文把左右栏串成一行），
   * 取同一 y 带的 span 当当前行，再沿 y 扩展 —— 行距正常就并入，
   * 遇到空行（间距超过约 1.75 倍行高）就停。
   */
  function blockOfRange(range) {
    var box = pageBoxOf(range.commonAncestorContainer);
    if (!box) return '';
    var tl = box.querySelector('.pdfx-text');
    if (!tl) return '';

    // ---- 收集本页所有可见 span ----
    var all = [];
    var nodes = tl.querySelectorAll('span');
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].textContent;
      if (!t || !t.trim()) continue;
      var rc = nodes[i].getBoundingClientRect();
      if (!rc.width && !rc.height) continue;
      all.push({ el: nodes[i], t: t, r: rc, cy: (rc.top + rc.bottom) / 2 });
    }
    if (!all.length) return '';

    var sel = range.getBoundingClientRect();
    if (!sel.width && !sel.height) return '';

    // 行高：与选区纵向相交的那些 span 的高度中位数
    var lineH = 12;
    var touching = all.filter(function (o) { return !(o.r.bottom < sel.top || o.r.top > sel.bottom); });
    if (touching.length) {
      var hs = touching.map(function (o) { return o.r.height; }).sort(function (a, b) { return a - b; });
      lineH = hs[Math.floor(hs.length / 2)] || 12;
    }
    if (!(lineH > 0)) lineH = 12;

    // ---- ① 按 y 把 span 聚成「行」 ----
    var sorted = all.slice().sort(function (a, b) { return a.cy - b.cy || a.r.left - b.r.left; });
    var rows = [];
    sorted.forEach(function (o) {
      var last = rows[rows.length - 1];
      if (last && Math.abs(o.cy - last.cy) <= lineH * 0.55) {
        last.items.push(o);
        var sum = 0;
        for (var k = 0; k < last.items.length; k++) sum += last.items[k].cy;
        last.cy = sum / last.items.length;
      } else {
        rows.push({ cy: o.cy, items: [o] });
      }
    });

    // ---- ② 找中缝，据此把每行切成「栏段」 ----
    //
    // 不能用「相邻 span 间隙 > 阈值」来判断栏缝：左栏每行的结尾位置都在变
    // （实测左栏右边界在 30%~49.5% 之间浮动，而行末标点还会把 span 边界再往外撑），
    // 用固定阈值会出现「刚好差 1px 没切开」的漏判。
    //
    // 改成**全页列投影**：把页宽切成细桶统计覆盖率，中缝是唯一一条贯穿整页的低覆盖带。
    // 有了中缝位置，再按「span 中心在中缝哪一侧」分行，就稳定多了。
    var boxBr = box.getBoundingClientRect();
    var pageW = boxBr.width;
    var boxLeft = boxBr.left;

    var gutterX = (function findGutter() {
      if (!(pageW > 80) || all.length < 8) return null;
      var NB = Math.max(60, Math.round(pageW / 4)); // 约 4px 一桶
      var cover = new Array(NB).fill(0);
      for (var i = 0; i < all.length; i++) {
        var a = Math.floor(((all[i].r.left - boxLeft) / pageW) * NB);
        var b = Math.floor(((all[i].r.right - boxLeft) / pageW) * NB);
        if (a < 0) a = 0;
        if (b > NB - 1) b = NB - 1;
        for (var j = a; j <= b; j++) cover[j]++;
      }
      // 只在中部找：太靠边的是页边距或栏内缩进，不是中缝
      var lo = Math.floor(NB * 0.3);
      var hi = Math.ceil(NB * 0.7);
      var cut = Math.max(1, Math.round(all.length * 0.06)); // 覆盖率低于 6% 视为空白
      var best = null;
      var cur = null;
      for (var k = lo; k <= hi; k++) {
        if (cover[k] < cut) {
          if (!cur) cur = { from: k, to: k };
          else cur.to = k;
        } else if (cur) {
          if (!best || cur.to - cur.from > best.to - best.from) best = cur;
          cur = null;
        }
      }
      if (cur && (!best || cur.to - cur.from > best.to - best.from)) best = cur;
      if (!best) return null; // 没有贯穿页面的空白带 → 单栏
      // 太窄的空白带可能只是词间空隙，不算中缝
      if ((best.to - best.from) / NB < 0.015) return null;
      return boxLeft + (((best.from + best.to) / 2) / NB) * pageW;
    })();

    // 跨界处如果几乎连在一起，说明这行是通栏（标题/图注），不该被切开
    var joinGap = lineH * 1.2;

    rows.forEach(function (row) {
      row.items.sort(function (a, b) { return a.r.left - b.r.left; });
      if (gutterX === null) {
        row.segs = [row.items];
        return;
      }
      var L = [];
      var R = [];
      row.items.forEach(function (o) {
        if ((o.r.left + o.r.right) / 2 > gutterX) R.push(o);
        else L.push(o);
      });
      if (!L.length) {
        row.segs = [R];
      } else if (!R.length) {
        row.segs = [L];
      } else if (R[0].r.left - L[L.length - 1].r.right <= joinGap) {
        row.segs = [L.concat(R)]; // 通栏
      } else {
        row.segs = [L, R];
      }
    });

    function rangeOfSeg(seg) {
      var lo = Infinity;
      var hi = -Infinity;
      for (var k = 0; k < seg.length; k++) {
        if (seg[k].r.left < lo) lo = seg[k].r.left;
        if (seg[k].r.right > hi) hi = seg[k].r.right;
      }
      return [lo, hi];
    }

    // ---- ③ 定位选区所在的行 + 栏段 ----
    var selCy = (sel.top + sel.bottom) / 2;
    var selCx = (sel.left + sel.right) / 2;
    var anchorRow = null;
    var anchorSeg = 0;

    var cand = rows.filter(function (row) {
      var top = Infinity;
      var bot = -Infinity;
      for (var k = 0; k < row.items.length; k++) {
        if (row.items[k].r.top < top) top = row.items[k].r.top;
        if (row.items[k].r.bottom > bot) bot = row.items[k].r.bottom;
      }
      return !(bot < sel.top - lineH * 0.5 || top > sel.bottom + lineH * 0.5);
    });
    if (!cand.length) return '';

    for (var ri = 0; ri < cand.length && !anchorRow; ri++) {
      for (var si = 0; si < cand[ri].segs.length; si++) {
        var sr = rangeOfSeg(cand[ri].segs[si]);
        if (selCx >= sr[0] - lineH && selCx <= sr[1] + lineH) {
          anchorRow = cand[ri];
          anchorSeg = si;
          break;
        }
      }
    }
    if (!anchorRow) {
      anchorRow = cand[0];
      anchorSeg = 0;
    }

    // ---- ④ 自适应行距：拿本页相邻行间距的中位数当「正常行距」 ----
    var dY = [];
    for (var q = 1; q < rows.length; q++) {
      var d = rows[q].cy - rows[q - 1].cy;
      if (d > 1 && d < lineH * 4) dY.push(d);
    }
    dY.sort(function (a, b) { return a - b; });
    var normalGap = dY.length ? dY[Math.floor(dY.length / 2)] : lineH * 1.4;
    // 段落边界：行距明显大于正常行距（空行/换块）
    var maxGap = Math.max(normalGap * 1.45, lineH * 1.15);

    // ---- ⑤ 以锚点为种子，向上下扩展到段落边界 ----
    var out = anchorRow.segs[anchorSeg].slice();
    var seedRange = rangeOfSeg(anchorRow.segs[anchorSeg]);
    var xLo = seedRange[0];
    var xHi = seedRange[1];

    // 同栏判定：有中缝时**严格按中缝分侧**。
    // 不能用「x 区间重叠」—— 左栏行末的右边界与右栏左边界可能只差十几像素
    // （实测 409px vs 430px），容差稍大就会互相够到，右栏段落里就混进左栏内容。
    var anchorIsRight = gutterX !== null && (xLo + xHi) / 2 > gutterX;
    function sameCol(seg) {
      var rr = rangeOfSeg(seg);
      if (gutterX !== null) {
        return ((rr[0] + rr[1]) / 2 > gutterX) === anchorIsRight;
      }
      return rr[0] < xHi + lineH * 2 && rr[1] > xLo - lineH * 2;
    }

    var rowIdx = rows.indexOf(anchorRow);
    function expand(dir) {
      var prevCy = anchorRow.cy;
      var j = rowIdx + dir;
      var guard = 0;
      while (j >= 0 && j < rows.length && guard++ < 80) {
        var row = rows[j];
        if (Math.abs(row.cy - prevCy) > maxGap) break; // 大间距 = 段落边界
        var picked = null;
        for (var s = 0; s < row.segs.length; s++) {
          if (sameCol(row.segs[s])) {
            picked = row.segs[s];
            break;
          }
        }
        if (!picked) break; // 这一行没有同栏内容 → 段落结束
        for (var m = 0; m < picked.length; m++) out.push(picked[m]);
        var pr = rangeOfSeg(picked);
        if (pr[0] < xLo) xLo = pr[0];
        if (pr[1] > xHi) xHi = pr[1];
        prevCy = row.cy;
        j += dir;
      }
    }
    expand(-1);
    expand(1);

    // ---- ⑥ 按行输出 ----
    out.sort(function (a, b) { return a.r.top - b.r.top || a.r.left - b.r.left; });
    var lines = [];
    var curLine = [];
    var curTop = null;
    out.forEach(function (o) {
      if (curTop === null || Math.abs(o.r.top - curTop) < lineH * 0.6) {
        if (curTop === null) curTop = o.r.top;
        curLine.push(o);
      } else {
        lines.push(curLine);
        curLine = [o];
        curTop = o.r.top;
      }
    });
    if (curLine.length) lines.push(curLine);

    return lines
      .map(function (ln) {
        ln.sort(function (a, b) { return a.r.left - b.r.left; });
        return ln.map(function (o) { return o.t; }).join(' ');
      })
      .join('\n')
      .replace(/[ \t]{2,}/g, ' ')
      // 中文的 span 切得很碎，行内 join(' ') 会在汉字之间塞空格，去掉它们
      .replace(/(?<=[\u4e00-\u9fa5]) (?=[\u4e00-\u9fa5，。；：、（）《》“”])/g, '')
      .replace(/(?<=[，。；：、（）《》“”]) (?=[\u4e00-\u9fa5])/g, '')
      .trim();
  }

  window.__ASK_ADAPTER__ = {
    docKind: 'pdf',
    locator: function () { return current; },
    root: function () { return document.getElementById('pdfx-view'); },
    section: sectionTitle,
    block: blockOfRange,
  };

  window.__PDF_READER__ = {
    get pdf() { return pdf; },
    get outline() { return outline; },
    get page() { return current; },
    get scale() { return scale; },
    goPage: goPage,
    setScale: setScale,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
