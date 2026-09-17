/*!
 * ask-doclinks.js — 把课程正文里的文献引用变成可点击的跳转链接
 *
 * 设计前提：**lesson 的 HTML 源文件一行都不改**。
 * 服务端在返回 HTML 时注入本脚本 + 一份文献索引（window.__DOC_LINKS__），
 * 由本脚本在浏览器里就地识别引用、包成 <a>。禁用 JS 时正文原样呈现。
 *
 * 识别两类引用：
 *   ① 编号：`[书1]` `[综述2]` `[论文3]` `[文献4]` `文献 5`
 *      —— 编号语义来自工作区 `参考文献/简介.md` 的 `## N. 标题` 顺序，
 *         由服务端推导成「编号 → PDF」表，不需要手工配置。
 *   ② 标题：文献标题/文件名的完整出现（如 `Optical Measurement of Surface Topography`）
 *
 * 若引用后面紧跟章节标记（`Ch.9` / `§1.2` / `第 9 章` / `第 4.1 节`），
 * 会连章节一起带过去（`&ch=9`），由 PDF 阅读页用它自己的书签定位。
 */
(function () {
  'use strict';

  var DOCS = window.__DOC_LINKS__ || [];
  if (!DOCS.length) return;
  if (window.__ASK_DOCLINKS_LOADED__) return;
  window.__ASK_DOCLINKS_LOADED__ = true;

  var byNum = {};
  DOCS.forEach(function (d) { byNum[d.n] = d; });

  var SKIP_ANCESTOR = 'a, code, pre, script, style, textarea, .askx-drawer, .askx-card, .askx-bubble';

  /* ---------------------------------------------------------------- */
  /* 样式                                                              */
  /* ---------------------------------------------------------------- */

  function injectCSS() {
    var css = [
      '.askx-doclink{color:inherit;text-decoration:none;',
      'border-bottom:1px dashed rgba(140,47,31,.45);cursor:pointer}',
      '.askx-doclink:hover{background:rgba(140,47,31,.07);border-bottom-color:#8c2f1f}',
      '.askx-doclink::after{content:"\\2197";font-size:.7em;vertical-align:super;',
      'margin-left:1px;color:#8c2f1f;opacity:.6}',
      '.askx-doclink:hover::after{opacity:1}',
    ].join('');
    var el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  /* ---------------------------------------------------------------- */
  /* 匹配                                                              */
  /* ---------------------------------------------------------------- */

  /** 引用后面紧跟的章节标记 —— 只在很近的距离内找，避免把远处的"第 3 章"算进来 */
  function chapterAfter(text, end) {
    var tail = text.slice(end, end + 10);
    var m = /^\s*(?:Ch\.|Chapter)\s*(\d{1,2})/i.exec(tail);
    if (m) return m[1];
    m = /^\s*\u00a7\s*(\d{1,2}(?:\.\d{1,2})?)/.exec(tail);
    if (m) return m[1];
    m = /^\s*第\s*(\d{1,2}(?:\.\d{1,2})?)\s*[章节课]/.exec(tail);
    if (m) return m[1];
    return '';
  }

  function findHits(text) {
    var hits = [];

    // ① 带方括号的编号：[书1] [综述2] [论文3]
    var re1 = /\[(?:书|论文|综述|文献|文章|报告)\s*(\d{1,2})\]/g;
    var m;
    while ((m = re1.exec(text))) {
      var d = byNum[Number(m[1])];
      if (d) hits.push({ start: m.index, end: m.index + m[0].length, doc: d, ch: chapterAfter(text, m.index + m[0].length) });
    }

    // ② 不带方括号：文献 5 / 论文 3
    //    末尾的否定断言是为了排除「文献 5 篇」这种量词用法
    var re2 = /(?:文献|论文|综述|书)\s?(\d{1,2})(?![0-9])(?![篇个条种类项张份])/g;
    while ((m = re2.exec(text))) {
      var d2 = byNum[Number(m[1])];
      if (d2) hits.push({ start: m.index, end: m.index + m[0].length, doc: d2, ch: chapterAfter(text, m.index + m[0].length) });
    }

    // ③ 完整标题（文件名或简介.md 的正式标题）
    DOCS.forEach(function (d) {
      [d.title, d.label].forEach(function (k) {
        if (!k || k.length < 8) return;
        var i = text.indexOf(k);
        while (i >= 0) {
          hits.push({ start: i, end: i + k.length, doc: d, ch: chapterAfter(text, i + k.length) });
          i = text.indexOf(k, i + k.length);
        }
      });
    });

    if (!hits.length) return [];

    // 按起点排序，重叠的取最长（例如标题里已含编号时只保留一个）
    hits.sort(function (a, b) {
      return a.start - b.start || (b.end - b.start) - (a.end - a.start);
    });
    var out = [];
    var lastEnd = -1;
    hits.forEach(function (h) {
      if (h.start >= lastEnd) {
        out.push(h);
        lastEnd = h.end;
      }
    });
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* DOM 改写                                                          */
  /* ---------------------------------------------------------------- */

  function hrefFor(h) {
    var url = h.doc.url;
    if (!h.ch) return url;
    var q = url.indexOf('?') >= 0 ? '&' : '?';
    // 服务端已从全文里解析出该章的起始页 → 直接带精确页码过去
    var exact = h.doc.chapters && h.doc.chapters[String(Number(h.ch))];
    if (exact) return url + q + 'page=' + exact + '&ch=' + encodeURIComponent(h.ch);
    // 没有页码表就只带章节号，交给阅读页用它自己的书签去尝试匹配
    return url + q + 'ch=' + encodeURIComponent(h.ch);
  }

  function applyHits(node, hits) {
    var parent = node.parentNode;
    if (!parent) return;
    var rest = node;
    var offset = 0;
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      var start = h.start - offset;
      if (start < 0) continue;
      // 依次切出「匹配段」，再把剩下的继续处理
      var mid = rest.splitText(start);
      var tail = mid.splitText(h.end - h.start);

      var a = document.createElement('a');
      a.className = 'askx-doclink';
      a.textContent = mid.nodeValue;
      a.setAttribute('href', hrefFor(h));
      a.setAttribute('data-doc', h.doc.rel);
      if (h.ch) a.setAttribute('data-ch', h.ch);
      a.title = h.ch
        ? '打开《' + h.doc.title + '》并跳到第 ' + h.ch + ' 章'
        : '打开《' + h.doc.title + '》';
      parent.replaceChild(a, mid);

      rest = tail;
      offset = h.end;
    }
  }

  function collectTextNodes(root) {
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest && p.closest(SKIP_ANCESTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function run() {
    injectCSS();

    var root = document.querySelector('.wrap, article, main, .content, .lesson') || document.body;
    // 先收集再改写 —— 避免边遍历边动 DOM
    var nodes = collectTextNodes(root);

    var count = 0;
    var touched = [];
    nodes.forEach(function (n) {
      var hits = findHits(n.nodeValue);
      if (!hits.length) return;
      touched.push({ node: n, hits: hits });
      count += hits.length;
    });
    touched.forEach(function (t) { applyHits(t.node, t.hits); });

    window.__ASK_DOCLINKS_STATS__ = { linked: count, scanned: nodes.length };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
