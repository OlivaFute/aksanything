/*!
 * ask-ai.js — teach 教学工作区的划词提问组件
 *
 * 用法（服务端模式下无需手动引用，ask-server.mjs 会自动注入）：
 *   <script src="../assets/ask-ai.js"></script>
 *
 * 依赖 window.__ASK__（由服务端注入）提供 { token, lesson, endpoint }。
 * 若在 file:// 下打开，会自动向 http://127.0.0.1:8899/api/state 取运行参数。
 *
 * 划词后浮出四个动作：
 *   解释这个词 — 就地弹出可拖动卡片，标题是这个词，正文是定义（不进抽屉）
 *   解释这段   — 进右侧抽屉，深入浅出讲清选段
 *   引用       — 把选中的这一段追加到提问框的引用区
 *   新建问题   — 新开一个划词追问任务（抽屉左侧 tab 里多一个）
 *
 * 抽屉左侧竖排 tab 用来在多个追问任务之间切换，每个任务的引用与对话历史互相独立。
 * Ctrl+K 开合抽屉；Esc 关闭。
 */
(function () {
  'use strict';
  if (window.__ASK_AI_LOADED__) return;
  window.__ASK_AI_LOADED__ = true;

  var BOOT = window.__ASK__ || {};
  var ORIGIN = BOOT.origin || (location.protocol === 'file:' ? 'http://127.0.0.1:8899' : '');
  var ENDPOINT = BOOT.endpoint || ORIGIN + '/api/ask';
  var EXPORT_URL = BOOT.exportUrl || ORIGIN + '/api/export';
  var TOKEN = BOOT.token || '';
  var LESSON = BOOT.lesson || (location.pathname.match(/\/([^/]+\.html)$/) || [])[1] || '';
  var HL_SUPPORTED = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;

  var taskSeq = 0;
  var state = {
    selection: '',
    paragraph: '',
    section: '',
    sourceFrom: 'lesson',
    selectionRect: null,
    cardId: null,
    // 所有问过的节点（含已关闭的）。关卡片只是收起视图，节点留在树里，可从提问树恢复。
    nodes: [],
    treeOpen: false, // 左下角提问树面板是否展开
    collapsed: {}, // 折叠状态：{ nodeId: true }
    tasks: [],
    activeId: '',
    streaming: false,
    catalog: [],
    providerLabel: '',
    lessonMode: 'full',
    askedRanges: [],
    seq: 0,
  };

  /* ================================================================ */
  /* 样式                                                              */
  /* ================================================================ */

  var CSS_TEXT = [
    /* 划词气泡 —— z-index 必须高于抽屉(3000)和卡片(2900)，
       否则在它们内部划词时气泡会被盖住 */
    '.askx-bubble{position:absolute;z-index:2147483600;display:none;align-items:center;',
    'background:#1a1a1a;color:#fdfcfa;border-radius:6px;padding:4px 3px;',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:12.5px;line-height:1;',
    'box-shadow:0 4px 16px rgba(0,0,0,.2);white-space:nowrap}',
    '.askx-bubble.on{display:inline-flex}',
    '.askx-bubble button{background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:5px 8px;border-radius:4px}',
    '.askx-bubble button:hover{background:rgba(255,255,255,.18)}',
    '.askx-bubble .sep{width:1px;height:12px;background:rgba(255,255,255,.26)}',

    /* 就地定义卡片 —— 支持多层，子卡片从父卡片右下长出 */
    '.askx-card{position:fixed;z-index:2147482900;width:min(340px,92vw);max-height:78vh;',
    'background:#fdfcfa;border:1px solid #d8d5cd;border-radius:8px;overflow:hidden;',
    'box-shadow:0 10px 34px rgba(0,0,0,.14);font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
    'color:#1a1a1a;display:flex;flex-direction:column}',
    '.askx-card-head{display:flex;align-items:center;gap:7px;padding:9px 10px 9px 11px;',
    'background:#f4f2ed;border-bottom:1px solid #e6e3db;cursor:move;user-select:none;flex:0 0 auto}',
    '.askx-card-lv{flex:0 0 auto;width:3px;height:15px;border-radius:2px;background:#b4b2a9}',
    '.askx-card.lv1 .askx-card-lv{background:#8c2f1f}',
    '.askx-card.lv2 .askx-card-lv{background:#1d5c48}',
    '.askx-card.lv3 .askx-card-lv{background:#8a5a12}',
    '.askx-card-child{flex:0 0 auto;font-size:11px;color:#b4b2a9;font-family:ui-monospace,Menlo,monospace}',
    '.askx-card-title{font-size:14.5px;font-weight:600;flex:1;min-width:0;overflow:hidden;',
    'text-overflow:ellipsis;white-space:nowrap;letter-spacing:.01em}',
    '.askx-card-x{background:none;border:0;font-size:16px;line-height:1;color:#8a877f;cursor:pointer;',
    'padding:1px 5px;border-radius:3px}',
    '.askx-card-x:hover{background:#e6e3db;color:#1a1a1a}',
    '.askx-card-body{padding:12px 14px;font-size:13px;line-height:1.7;overflow-y:auto;flex:1 1 auto;min-height:0}',
    '.askx-card-body p{margin:0 0 8px}.askx-card-body p:last-child{margin-bottom:0}',
    '.askx-card-body ul,.askx-card-body ol{margin:0 0 8px;padding-left:18px}',
    '.askx-card-body li{margin-bottom:4px}',
    '.askx-card-body code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:#f4f2ed;',
    'border:1px solid #e6e3db;border-radius:3px;padding:0 4px}',
    '.askx-card-body strong{font-weight:600}',
    '.askx-card-body h4{margin:10px 0 5px;font-size:12.5px;font-weight:600;color:#4a4a4a}',
    '.askx-card-foot{border-top:1px solid #ece9e2;padding:6px 10px;display:flex;gap:6px;align-items:center;flex:0 0 auto}',
    '.askx-card-foot button{background:none;border:1px solid #e0ddd4;border-radius:3px;font-size:11px;',
    'color:#767676;cursor:pointer;padding:2px 8px;font-family:inherit}',
    '.askx-card-foot button:hover{border-color:#b4b2a9;color:#1a1a1a}',
    '.askx-card-foot button[data-c="deep"]{border-color:#dccdb6;color:#8a5a12}',
    '.askx-card-foot button[data-c="deep"]:hover{background:#faf0dd;border-color:#8a5a12}',
    '.askx-card-foot button:disabled{opacity:.45;cursor:default}',
    '.askx-card-foot .askx-card-hint{margin-left:auto;font-size:10.5px;color:#b4b2a9}',
    /* ---------- 左下角：提问树入口 + 向上弹出的面板 ---------- */
    '.askx-tree-btn{position:fixed;left:22px;bottom:22px;z-index:2147482700;width:50px;height:50px;',
    'border-radius:50%;border:1px solid #d8d5cd;background:#fdfcfa;cursor:pointer;padding:0;',
    'box-shadow:0 4px 16px rgba(0,0,0,.13);display:flex;align-items:center;justify-content:center;',
    'font-size:19px;line-height:1;transition:transform .14s ease,box-shadow .14s ease}',
    '.askx-tree-btn:hover{transform:translateY(-2px);box-shadow:0 7px 20px rgba(0,0,0,.17)}',
    '.askx-tree-btn[data-empty="1"]{opacity:.42}',
    '.askx-tree-badge{position:absolute;top:-4px;right:-4px;min-width:19px;height:19px;border-radius:10px;',
    'background:#8c2f1f;color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;',
    'justify-content:center;padding:0 5px;font-family:ui-monospace,Menlo,monospace}',
    '.askx-tree{position:fixed;left:22px;bottom:84px;z-index:2147482750;width:min(350px,86vw);',
    'max-height:min(62vh,540px);display:none;flex-direction:column;background:#fdfcfa;',
    'border:1px solid #d8d5cd;border-radius:10px;box-shadow:0 12px 38px rgba(0,0,0,.16);',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1a1a1a;overflow:hidden}',
    '.askx-tree.on{display:flex;animation:askx-pop .16s ease-out}',
    '@keyframes askx-pop{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',
    '.askx-tree-head{display:flex;align-items:center;gap:8px;padding:10px 8px 10px 13px;background:#f4f2ed;',
    'border-bottom:1px solid #e6e3db;flex:0 0 auto}',
    '.askx-tree-head b{font-size:13px;font-weight:600;flex:1;min-width:0}',
    '.askx-tree-head .askx-tree-sub{font-size:11px;color:#a09d95;font-family:ui-monospace,Menlo,monospace;font-weight:400}',
    '.askx-tree-head button{background:none;border:0;font-size:16px;line-height:1;color:#8a877f;',
    'cursor:pointer;padding:1px 6px;border-radius:3px}',
    '.askx-tree-head button:hover{background:#e6e3db;color:#1a1a1a}',
    '.askx-tree-body{overflow-y:auto;padding:7px 5px 9px;flex:1 1 auto;min-height:0}',
    '.askx-tree-empty{padding:24px 16px;text-align:center;color:#a09d95;font-size:12.5px;line-height:1.8}',
    '.askx-tn{display:flex;align-items:flex-start;gap:5px;padding:3px 7px;border-radius:4px;cursor:pointer;',
    'font-size:12.5px;line-height:1.55;user-select:none}',
    '.askx-tn:hover{background:#f4f2ed}',
    '.askx-tn[data-open="1"]{background:#faf4f0}',
    '.askx-tn-tri{flex:0 0 12px;width:12px;text-align:center;color:#b4b2a9;font-size:9px;margin-top:4px}',
    '.askx-tn-tri[data-leaf="1"]{visibility:hidden}',
    '.askx-tn-dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;background:#c9c6bd;margin-top:5px}',
    '.askx-tn[data-open="1"] .askx-tn-dot{background:#1d5c48}',
    '.askx-tn-dot.lv1{background:#e0d5c8}',
    '.askx-tn[data-open="1"] .askx-tn-dot.lv1{background:#8c2f1f}',
    '.askx-tn-dot.lv2{background:#cfe0d8}',
    '.askx-tn[data-open="1"] .askx-tn-dot.lv2{background:#2d7a5f}',
    '.askx-tn-txt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.askx-tn[data-open="1"] .askx-tn-txt{font-weight:600}',
    '.askx-tn-tag{flex:0 0 auto;font-size:10px;color:#b4b2a9;font-family:ui-monospace,Menlo,monospace}',
    '.askx-tree-foot{border-top:1px solid #ece9e2;padding:7px 11px;flex:0 0 auto;display:flex;',
    'align-items:center;gap:7px;font-size:11px;color:#a09d95}',
    '.askx-tree-foot .askx-sp{flex:1}',
    '.askx-tree-foot button{background:none;border:1px solid #e0ddd4;border-radius:3px;font-size:11px;',
    'color:#767676;cursor:pointer;padding:2px 8px;font-family:inherit}',
    '.askx-tree-foot button:hover{border-color:#b4b2a9;color:#1a1a1a}',
    '@keyframes askx-blink{50%{opacity:0}}',

    /* 抽屉 */
    '.askx-drawer{position:fixed;top:0;right:0;bottom:0;width:min(460px,95vw);z-index:2147483000;',
    'background:#fdfcfa;border-left:1px solid #d8d5cd;display:flex;flex-direction:column;',
    'transform:translateX(103%);transition:transform .26s cubic-bezier(.4,0,.2,1);',
    'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1a1a1a;',
    'box-shadow:-10px 0 30px rgba(0,0,0,.07)}',
    '.askx-drawer.open{transform:none}',
    '.askx-head{display:flex;align-items:center;gap:10px;padding:13px 14px 10px;border-bottom:1px solid #ece9e2;flex:0 0 auto}',
    '.askx-head h3{margin:0;font-size:14px;font-weight:600}',
    '.askx-head .prov{margin-left:auto;font-size:11px;color:#8a877f;font-family:ui-monospace,Menlo,monospace;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}',
    '.askx-x{background:none;border:0;font-size:19px;line-height:1;color:#8a877f;cursor:pointer;padding:2px 4px;border-radius:3px}',
    '.askx-x:hover{background:#f1efe8;color:#1a1a1a}',

    /* 左侧竖排 tab */
    '.askx-body{flex:1;display:flex;min-height:0}',
    '.askx-tabs{flex:0 0 44px;border-right:1px solid #ece9e2;background:#f8f6f2;',
    'display:flex;flex-direction:column;align-items:center;gap:6px;padding:9px 0;overflow-y:auto}',
    '.askx-tab{width:28px;height:28px;flex:0 0 auto;border:1px solid #ddd9d0;border-radius:6px;background:#fdfcfa;',
    'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#767676;cursor:pointer;position:relative;',
    'display:flex;align-items:center;justify-content:center;padding:0}',
    '.askx-tab:hover{border-color:#b4b2a9;color:#1a1a1a}',
    '.askx-tab.on{background:#1a1a1a;border-color:#1a1a1a;color:#fdfcfa;font-weight:600}',
    '.askx-tab .dot{position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;',
    'background:#8c2f1f;border:1.5px solid #f8f6f2}',
    '.askx-tab.add{color:#8c2f1f;border-style:dashed;font-size:15px}',
    '.askx-tab.add:hover{background:#f6edea;border-color:#8c2f1f}',
    '.askx-pane{flex:1;display:flex;flex-direction:column;min-width:0}',

    /* 引用区 */
    '.askx-quotes{flex:0 0 auto;padding:0 14px;max-height:132px;overflow-y:auto}',
    '.askx-quote-item{display:flex;gap:7px;align-items:flex-start;background:#f4f2ed;border-left:2px solid #b4b2a9;',
    'border-radius:0 4px 4px 0;padding:6px 8px;margin-top:8px;font-size:11.5px;line-height:1.5;color:#6d6a63}',
    '.askx-quote-item span{flex:1;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.askx-quote-item button{background:none;border:0;color:#a09d95;cursor:pointer;font-size:13px;line-height:1;padding:0 2px}',
    '.askx-quote-item button:hover{color:#8c2f1f}',

    '.askx-meta{padding:9px 14px 0;font-size:11.5px;color:#8a877f;flex:0 0 auto}',
    '.askx-chips{display:flex;flex-wrap:wrap;gap:4px;padding:7px 14px 10px;border-bottom:1px solid #ece9e2;flex:0 0 auto}',
    '.askx-chip{font-size:10.5px;padding:2px 7px;border-radius:3px;background:#e9f0ec;color:#1d5c48;letter-spacing:.02em}',
    '.askx-chip.off{background:#f1efe8;color:#8a877f}',

    '.askx-thread{flex:1;overflow-y:auto;padding:13px 14px 8px;scroll-behavior:smooth}',
    '.askx-empty{color:#8a877f;font-size:13px;line-height:1.7;padding:14px 2px}',
    '.askx-empty kbd{font-family:ui-monospace,Menlo,monospace;background:#f1efe8;border:1px solid #e0ddd4;border-radius:3px;padding:1px 5px;font-size:11px}',

    '.askx-item{margin-bottom:17px}',
    '.askx-q{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}',
    '.askx-q .no{flex:0 0 auto;width:17px;height:17px;border-radius:50%;background:#1a1a1a;color:#fdfcfa;',
    'font-size:10.5px;line-height:17px;text-align:center;font-family:ui-monospace,Menlo,monospace;margin-top:1px}',
    '.askx-q .txt{font-size:13.5px;line-height:1.55;font-weight:600}',
    '.askx-a{margin-left:25px;font-size:13.5px;line-height:1.72;word-break:break-word}',
    '.askx-a.err{color:#8c2f1f;background:#f6edea;border-radius:4px;padding:9px 12px;font-size:12.5px;white-space:pre-wrap}',
    '.askx-a p{margin:0 0 9px}.askx-a p:last-child{margin-bottom:0}',
    '.askx-a ul,.askx-a ol{margin:0 0 9px;padding-left:20px}',
    '.askx-a li{margin-bottom:4px}',
    '.askx-a code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88em;background:#f4f2ed;',
    'border:1px solid #e6e3db;border-radius:3px;padding:0 4px}',
    '.askx-a pre{background:#f4f2ed;border:1px solid #e6e3db;border-left:3px solid #b4b2a9;border-radius:4px;',
    'padding:10px 12px;overflow-x:auto;margin:0 0 9px}',
    '.askx-a pre code{background:none;border:0;padding:0;font-size:12px}',
    '.askx-a table{width:100%;border-collapse:collapse;font-size:12.5px;margin:0 0 10px}',
    '.askx-a th{text-align:left;border-bottom:1.5px solid #1a1a1a;padding:5px 8px 4px 0;font-size:11.5px;color:#767676}',
    '.askx-a td{border-bottom:1px solid #e6e3db;padding:6px 8px 6px 0;vertical-align:top}',
    '.askx-a strong{font-weight:600}',
    '.askx-a .askx-math-block{display:block;margin:8px 0;overflow-x:auto}',
    '.askx-a .katex{font-size:1.02em}',
    '.askx-a .katex-display{margin:0}',
    '.askx-card-body .askx-math-block{display:block;margin:6px 0;overflow-x:auto}',
    '.askx-caret{display:inline-block;width:7px;height:14px;background:#1a1a1a;vertical-align:-2px;',
    'margin-left:2px;animation:askx-blink 1s steps(2,start) infinite}',

    '.askx-acts{display:flex;gap:6px;margin:8px 0 0 25px;opacity:0;transition:opacity .15s}',
    '.askx-item:hover .askx-acts{opacity:1}',
    '.askx-acts button{background:none;border:1px solid #e0ddd4;border-radius:3px;font-size:11px;',
    'color:#767676;cursor:pointer;padding:2px 7px;font-family:inherit}',
    '.askx-acts button:hover{border-color:#b4b2a9;color:#1a1a1a}',

    '.askx-foot{border-top:1px solid #ece9e2;padding:10px 13px 12px;background:#fdfcfa;flex:0 0 auto}',
    '.askx-quick{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}',
    '.askx-quick button{background:#f4f2ed;border:1px solid #e6e3db;border-radius:3px;font-size:11.5px;',
    'color:#4a4a4a;cursor:pointer;padding:3px 9px;font-family:inherit}',
    '.askx-quick button:hover{background:#ece9e2;border-color:#d8d5cd}',
    '.askx-inrow{display:flex;gap:8px;align-items:flex-end}',
    '.askx-inrow textarea{flex:1;resize:none;border:1px solid #d8d5cd;border-radius:5px;padding:9px 11px;',
    'font-family:inherit;font-size:13.5px;line-height:1.5;color:#1a1a1a;background:#fff;outline:none;min-height:40px;max-height:150px}',
    '.askx-inrow textarea:focus{border-color:#8c2f1f;box-shadow:0 0 0 2px rgba(140,47,31,.09)}',
    '.askx-send{background:#8c2f1f;color:#fdfcfa;border:0;border-radius:5px;padding:10px 15px;font-size:13px;',
    'cursor:pointer;font-family:inherit;font-weight:500;flex:0 0 auto}',
    '.askx-send:disabled{background:#d8d5cd;cursor:not-allowed}',
    '.askx-send:hover:not(:disabled){background:#7a2819}',
    '.askx-hint{font-size:11px;color:#a09d95;margin-top:6px}',
    '.askx-hint.alert{color:#8c2f1f}',

    '@media (min-width:1200px){body.askx-open{padding-right:460px;transition:padding-right .26s cubic-bezier(.4,0,.2,1)}}',
    '::highlight(askx-sel){background:rgba(140,47,31,.16);text-decoration:underline;text-decoration-color:rgba(140,47,31,.5)}',
    '::highlight(askx-asked){background:rgba(29,92,72,.13)}',
    '@media print{.askx-drawer,.askx-bubble,.askx-card{display:none!important}body.askx-open{padding-right:0!important}}',
  ].join('');

  function injectCSS() {
    var s = document.createElement('style');
    s.id = 'askx-style';
    s.textContent = CSS_TEXT;
    document.head.appendChild(s);
  }

  /* ================================================================ */
  /* 工具                                                              */
  /* ================================================================ */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function q(sel, root) {
    return (root || document).querySelector(sel);
  }

  var ARTICLE_SEL = '.wrap, article, main, .content, .lesson';

  /* ================================================================ */
  /* 文档适配器                                                        */
  /* ================================================================ */
  /* 组件要从文档里读三件事：正文根节点、当前章节、选区所在段落。
     HTML lesson 有现成的语义标签可依；PDF 的文本层没有，需要另一套取法。
     把这些差异收进一个适配器对象，页面脚本可以预先塞入 window.__ASK_ADAPTER__
     来替换 —— 组件自身不再判断文档类型，两条链互不干扰。
     约束：必须在 ask-ai.js 之前设置好，首次使用时就会读取（并缓存）。 */
  var LESSON_ADAPTER = {
    /** 文档类型：HTML 课 */
    docKind: 'lesson',

    /** 文档内的位置标识（PDF 用它传页码；HTML 没有这个概念，恒为 0） */
    locator: function () { return 0 },

    /** 正文根节点 */
    root: function () {
      return q(ARTICLE_SEL) || document.body;
    },

    /** 当前阅读位置所在的章节标题 */
    section: function () {
      var hs = document.querySelectorAll('h2');
      var y = window.scrollY + 140;
      var cur = '';
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].getBoundingClientRect().top + window.scrollY <= y) cur = hs[i].textContent.trim();
        else break;
      }
      return cur || (q('h1') ? q('h1').textContent.trim() : '');
    },

    /** 选区所在的整段文字 */
    block: function (range) {
      var n = range.commonAncestorContainer;
      if (n.nodeType === 3) n = n.parentNode;
      var depth = 0;
      while (n && n !== document.body && depth < 8) {
        var tag = n.tagName;
        if (tag === 'P' || tag === 'LI' || tag === 'TD' || tag === 'BLOCKQUOTE' || tag === 'H2' || tag === 'H3') {
          return (n.innerText || n.textContent || '').trim();
        }
        n = n.parentNode;
        depth++;
      }
      return '';
    },
  };

  var ADAPTER = null;
  function adapter() {
    if (!ADAPTER) ADAPTER = window.__ASK_ADAPTER__ || LESSON_ADAPTER;
    return ADAPTER;
  }

  // 下面三个是适配器的转发层：调用点保持原样，行为由当前适配器决定。
  function articleRoot() { return adapter().root(); }
  function currentSection() { return adapter().section(); }
  function enclosingBlock(range) { return adapter().block(range); }

  /**
   * 给请求体补上「当前文档」的标识字段。
   * lesson / docKind / page 都交给适配器决定 —— 组件本身不需要知道
   * 自己是在读 HTML 课还是 PDF 文献。
   */
  function withDoc(body) {
    var a = adapter();
    body.lesson = LESSON;
    body.docKind = a.docKind || 'lesson';
    body.page = a.locator ? a.locator() : 0;
    return body;
  }

  /** 选区落在哪张卡片里（没有则返回 null） */
  function cardAt(node) {
    for (var i = 0; i < state.nodes.length; i++) {
      var el = state.nodes[i].el;
      if (el && el.contains(node)) return state.nodes[i];
    }
    return null;
  }

  /** 正文、卡片、抽屉里的文字都可以划选。 */
  function inSelectableZone(node) {
    var root = articleRoot();
    if (root && root.contains(node)) return true;
    if (cardAt(node)) return true;
    if (drawer && drawer.contains(node)) return true;
    return false;
  }

  /** 这次划词来自哪里 —— 后续要告诉模型引用的出处，否则它会在课里找不到。 */
  function zoneOf(node) {
    if (cardAt(node)) return 'card';
    if (drawer && drawer.contains(node)) return 'drawer';
    return 'lesson';
  }

  /* 章节判定与段落提取已移入适配器：见上方 LESSON_ADAPTER.section / .block。 */

  /** 只排除真正的控件和 quiz 选项；卡片、抽屉里的文字一律允许划选。 */
  function isInteractive(node) {
    var n = node.nodeType === 3 ? node.parentNode : node;
    var d = 0;
    while (n && n !== document.body && d < 8) {
      var t = n.tagName;
      if (t === 'BUTTON' || t === 'TEXTAREA' || t === 'INPUT' || t === 'SELECT') return true;
      if (n.classList && n.classList.contains('quiz')) return true;
      n = n.parentNode;
      d++;
    }
    return false;
  }

  function clip(s, n) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  /* ================================================================ */
  /* 极简 Markdown + 公式                                              */
  /* ================================================================ */

  var KATEX_VER = '0.16.9';
  var katexPromise = null;

  function mathSpan(tex, display) {
    var cls = display ? 'askx-math askx-math-block' : 'askx-math';
    var raw = display ? '$$' + tex + '$$' : '$' + tex + '$';
    return '<span class="' + cls + '" data-tex="' + esc(tex) + '">' + esc(raw) + '</span>';
  }

  /**
   * 加载 KaTeX。优先用工作区内的 assets/katex/（离线可用、加载快），
   * 本地没有才退回 CDN。
   */
  function ensureKatex() {
    if (katexPromise) return katexPromise;
    katexPromise = new Promise(function (resolve) {
      if (window.katex) return resolve(true);

      var LOCAL = '/assets/katex/';
      var CDN = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VER + '/dist/';

      function load(base, onFail) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = base + 'katex.min.css';
        document.head.appendChild(css);
        var js = document.createElement('script');
        js.src = base + 'katex.min.js';
        js.onload = function () { resolve(!!window.katex); };
        js.onerror = function () { if (onFail) onFail(); };
        document.head.appendChild(js);
      }

      load(LOCAL, function () { load(CDN, null); });
      setTimeout(function () { resolve(!!window.katex); }, 6000);
    });
    return katexPromise;
  }

  function renderMath(root) {
    if (!root) return;
    var nodes = root.querySelectorAll('.askx-math');
    if (!nodes.length) return;
    ensureKatex().then(function (ok) {
      if (!ok || !window.katex) return; // 离线或 CDN 不可达：保留 $...$ 原文
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (!el.parentNode || el.getAttribute('data-rendered') === '1') continue;
        try {
          window.katex.render(el.getAttribute('data-tex') || '', el, {
            throwOnError: false,
            displayMode: el.classList.contains('askx-math-block'),
          });
          el.setAttribute('data-rendered', '1');
        } catch (e) { /* 保留原文 */ }
      }
    });
  }

  function inline(md) {
    var s = md;
    s = s.replace(/`([^`]+)`/g, function (_, c) { return '\u0000C\u0000' + esc(c) + '\u0000/c\u0000'; });
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\u0000C\u0000([\s\S]*?)\u0000\/c\u0000/g, function (_, c) { return '<code>' + c + '</code>'; });
    return s;
  }

  function renderMarkdown(md) {
    var blocks = [];
    var maths = [];
    var src = String(md).replace(/\r\n/g, '\n');

    src = src.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
      return '\u0001BLOCK' + (blocks.length - 1) + '\u0001';
    });

    src = src.replace(/\$\$([\s\S]+?)\$\$/g, function (_, tex) {
      maths.push(mathSpan(tex.trim(), true));
      return '\u0001MATH' + (maths.length - 1) + '\u0001';
    });
    src = src.replace(/\$([^$\n]+?)\$/g, function (_, tex) {
      maths.push(mathSpan(tex.trim(), false));
      return '\u0001MATH' + (maths.length - 1) + '\u0001';
    });

    var lines = src.split('\n');
    var out = [];
    var i = 0;

    while (i < lines.length) {
      var t = lines[i].trim();

      if (/^\u0001BLOCK\d+\u0001$/.test(t)) { out.push(blocks[Number(t.replace(/\D/g, ''))]); i++; continue; }
      if (!t) { i++; continue; }

      if (/^#{1,6}\s/.test(t)) {
        out.push('<p><strong>' + inline(t.replace(/^#+\s*/, '')) + '</strong></p>');
        i++;
        continue;
      }

      if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        var head = t.split('|').slice(1, -1);
        var rows = [];
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          rows.push(lines[i].trim().split('|').slice(1, -1));
          i++;
        }
        var html = '<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c.trim()) + '</th>'; }).join('') + '</tr></thead><tbody>';
        html += rows.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + inline(c.trim()) + '</td>'; }).join('') + '</tr>';
        }).join('');
        out.push(html + '</tbody></table>');
        continue;
      }

      if (/^([-*+]|\d+\.)\s/.test(t)) {
        var ordered = /^\d+\./.test(t);
        var items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].trim().replace(/^([-*+]|\d+\.)\s+/, '')) + '</li>');
          i++;
        }
        out.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>');
        continue;
      }

      if (/^>\s?/.test(t)) {
        var quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quote.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push('<p style="border-left:2px solid #d8d5cd;padding-left:10px;color:#6d6a63">' + inline(quote.join(' ')) + '</p>');
        continue;
      }

      var para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||\u0001BLOCK)/.test(lines[i].trim())
      ) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
    }

    var final = out.join('');
    final = final.replace(/\u0001BLOCK(\d+)\u0001/g, function (_, n) { return blocks[Number(n)]; });
    final = final.replace(/\u0001MATH(\d+)\u0001/g, function (_, n) { return maths[Number(n)]; });
    return final;
  }

  /* ================================================================ */
  /* 高亮                                                              */
  /* ================================================================ */

  function markAsked(range) {
    if (!HL_SUPPORTED) return;
    state.askedRanges.push(range.cloneRange());
    if (state.askedRanges.length > 200) state.askedRanges.shift();
    var h = new Highlight();
    state.askedRanges.forEach(function (r) {
      try { h.add(r); } catch (e) { /* 失效 range 忽略 */ }
    });
    CSS.highlights.set('askx-asked', h);
  }

  function setSelHighlight(range) {
    if (!HL_SUPPORTED) return;
    if (range) {
      var h = new Highlight();
      h.add(range);
      CSS.highlights.set('askx-sel', h);
    } else {
      CSS.highlights.delete('askx-sel');
    }
  }

  /* ================================================================ */
  /* SSE 请求                                                          */
  /* ================================================================ */

  async function ensureToken() {
    if (TOKEN) return TOKEN;
    var st = await fetch(ORIGIN + '/api/state').then(function (r) { return r.json(); });
    TOKEN = st.token;
    return TOKEN;
  }

  /**
   * 发一次提问，流式回调。
   * onDelta 增量文本；onText 整段替换；onStatus 状态提示。
   */
  async function streamAsk(payload, handlers) {
    await ensureToken();
    var resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ask-token': TOKEN },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error('请求失败 ' + resp.status + (resp.status === 401 ? '（token 失效，刷新页面重试）' : ''));
    }

    var reader = resp.body.getReader();
    var dec = new TextDecoder('utf-8');
    var buf = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      var cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        var block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        var ls = block.split('\n');
        for (var k = 0; k < ls.length; k++) {
          if (ls[k].indexOf('data:') !== 0) continue;
          var ev;
          try { ev = JSON.parse(ls[k].slice(5)); } catch (e) { continue; }
          if (ev.t === 'delta' && handlers.onDelta) handlers.onDelta(ev.v);
          else if (ev.t === 'text' && handlers.onText) handlers.onText(ev.v);
          else if (ev.t === 'status' && handlers.onStatus) handlers.onStatus(ev.v);
          else if (ev.t === 'log' && handlers.onLog) handlers.onLog(ev.v);
          else if (ev.t === 'error' && handlers.onError) handlers.onError(ev);
        }
      }
    }
  }

  function exportQA(payload) {
    if (!TOKEN) return;
    fetch(EXPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ask-token': TOKEN },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  /* ================================================================ */
  /* DOM 骨架                                                          */
  /* ================================================================ */

  var bubble, drawer, thread, chips, meta, input, sendBtn, hintEl, tabsEl, quotesEl, paneEl;
  var treeBtn, treePanel, treeBody, treeBadge;

  function buildUI() {
    bubble = document.createElement('div');
    bubble.className = 'askx-bubble';
    bubble.innerHTML = [
      '<button data-a="define">解释这个词</button><span class="sep"></span>',
      '<button data-a="explain">解释这段</button><span class="sep"></span>',
      '<button data-a="quote">引用</button><span class="sep"></span>',
      '<button data-a="new">新建问题</button>',
    ].join('');
    document.body.appendChild(bubble);

    drawer = document.createElement('div');
    drawer.className = 'askx-drawer';
    drawer.innerHTML = [
      '<div class="askx-head">',
      '<h3>划词提问</h3>',
      '<span class="prov" id="askx-prov"></span>',
      '<button class="askx-x" title="关闭（Esc）">&times;</button>',
      '</div>',
      '<div class="askx-body">',
      '<div class="askx-tabs" id="askx-tabs"></div>',
      '<div class="askx-pane">',
      '<div class="askx-meta" id="askx-meta"></div>',
      '<div class="askx-chips" id="askx-chips"></div>',
      '<div class="askx-quotes" id="askx-quotes"></div>',
      '<div class="askx-thread" id="askx-thread"></div>',
      '<div class="askx-foot">',
      '<div class="askx-quick">',
      '<button data-q="explain">深入浅出解释这段</button>',
      '<button data-q="why">为什么要这样设计</button>',
      '<button data-q="example">举个具体例子</button>',
      '</div>',
      '<div class="askx-inrow">',
      '<textarea id="askx-in" rows="1" placeholder="继续追问…（Enter 发送，Shift+Enter 换行）"></textarea>',
      '<button class="askx-send" id="askx-send">发送</button>',
      '</div>',
      '<div class="askx-hint" id="askx-hint"></div>',
      '</div>',
      '</div>',
      '</div>',
    ].join('');
    document.body.appendChild(drawer);

    thread = q('#askx-thread');
    chips = q('#askx-chips');
    meta = q('#askx-meta');
    input = q('#askx-in');
    sendBtn = q('#askx-send');
    hintEl = q('#askx-hint');
    tabsEl = q('#askx-tabs');
    quotesEl = q('#askx-quotes');
    paneEl = q('.askx-pane');

    q('.askx-x', drawer).addEventListener('click', closeDrawer);

    /* ---------- 左下角：提问树入口 ---------- */
    treeBtn = document.createElement('button');
    treeBtn.className = 'askx-tree-btn';
    treeBtn.type = 'button';
    treeBtn.title = '提问树：本课划过的词都在这里，点一下就能重新打开';
    treeBtn.innerHTML = '&#127795;<span class="askx-tree-badge" style="display:none"></span>';
    document.body.appendChild(treeBtn);
    treeBadge = q('.askx-tree-badge', treeBtn);

    treePanel = document.createElement('div');
    treePanel.className = 'askx-tree';
    treePanel.innerHTML = [
      '<div class="askx-tree-head">',
      '<b>提问树<span class="askx-tree-sub"></span></b>',
      '<button class="askx-tree-x" title="收起">&times;</button>',
      '</div>',
      '<div class="askx-tree-body"></div>',
      '<div class="askx-tree-foot">',
      '<span>点节点即可重新打开</span>',
      '<span class="askx-sp"></span>',
      '<button class="askx-tree-expand">全部折叠</button>',
      '<button class="askx-tree-clear">清空</button>',
      '</div>',
    ].join('');
    document.body.appendChild(treePanel);
    treeBody = q('.askx-tree-body', treePanel);

    treeBtn.addEventListener('click', function () {
      state.treeOpen = !state.treeOpen;
      treePanel.classList.toggle('on', state.treeOpen);
      if (state.treeOpen) renderTree();
    });
    q('.askx-tree-x', treePanel).addEventListener('click', function () {
      state.treeOpen = false;
      treePanel.classList.remove('on');
    });
    q('.askx-tree-clear', treePanel).addEventListener('click', function () {
      if (!state.nodes.length) return;
      if (!window.confirm('清空本课的提问树？已打开的卡片会一起收起，本地存档也会删除，无法恢复。')) return;
      closeAllCards();
      state.nodes = [];
      state.collapsed = {};
      clearTreeStorage();
      renderTree();
    });
    q('.askx-tree-expand', treePanel).addEventListener('click', function () {
      var someOpen = state.nodes.some(function (n) { return !state.collapsed[n.id]; });
      if (someOpen) {
        state.nodes.forEach(function (n) { state.collapsed[n.id] = true; });
        this.textContent = '全部展开';
      } else {
        state.collapsed = {};
        this.textContent = '全部折叠';
      }
      saveTreeSoon();
      renderTree();
    });

    drawer.querySelectorAll('.askx-quick button').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-q');
        if (kind === 'explain') {
          send('explain');
        } else if (kind === 'why') {
          input.value = '为什么要这样设计？如果不这样做会有什么后果？';
          input.focus();
        } else {
          input.value = '给一个具体一点的例子或数字，帮我建立直觉。';
          input.focus();
        }
      });
    });

    sendBtn.addEventListener('click', function () { send('qa'); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send('qa');
      }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(150, input.scrollHeight) + 'px';
    });

    bubble.addEventListener('mousedown', function (e) { e.preventDefault(); });
    bubble.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      if (a === 'define') explainTerm();
      else if (a === 'explain') { openDrawer(); addQuote(state.selection); send('explain'); }
      else if (a === 'quote') { openDrawer(); addQuote(state.selection); input.focus(); }
      else if (a === 'new') { openDrawer(); createTask(state.selection); }
    });

    quoteDraftTick();
  }

  /* 卡片拖动 */
  function makeDraggable(box, handle) {
    var dx = 0, dy = 0, dragging = false;

    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('.askx-card-x')) return;
      dragging = true;
      var r = box.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      box.style.transition = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var w = box.offsetWidth, h = box.offsetHeight;
      box.style.left = Math.max(4, Math.min(e.clientX - dx, window.innerWidth - w - 4)) + 'px';
      box.style.top = Math.max(4, Math.min(e.clientY - dy, window.innerHeight - h - 4)) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  }

  /* ================================================================ */
  /* 任务（tab）管理                                                    */
  /* ================================================================ */

  function newTaskObj(quote) {
    taskSeq += 1;
    return {
      id: 't' + taskSeq,
      no: taskSeq,
      quotes: quote ? [String(quote)] : [],
      history: [],
      steps: 0,
    };
  }

  function ensureFirstTask() {
    if (!state.tasks.length) {
      state.tasks.push(newTaskObj(''));
      state.activeId = state.tasks[0].id;
    }
  }

  function activeTask() {
    ensureFirstTask();
    for (var i = 0; i < state.tasks.length; i++) {
      if (state.tasks[i].id === state.activeId) return state.tasks[i];
    }
    state.activeId = state.tasks[0].id;
    return state.tasks[0];
  }

  function createTask(quote) {
    var t = newTaskObj(quote);
    state.tasks.push(t);
    state.activeId = t.id;
    renderTabs();
    renderQuotes();
    renderThread();
    updateMeta();
    input.focus();
    return t;
  }

  function switchTask(id) {
    state.activeId = id;
    renderTabs();
    renderQuotes();
    renderThread();
    updateMeta();
  }

  function renderTabs() {
    if (!tabsEl) return;
    var html = state.tasks.map(function (t) {
      var label = t.quotes.length ? clip(t.quotes[0], 18) : '未引用';
      return '<button class="askx-tab' + (t.id === state.activeId ? ' on' : '') + '" data-t="' + t.id + '" ' +
        'title="任务 ' + t.no + '：' + esc(label) + '（点击切换）">' + t.no +
        (t.steps ? '<span class="dot"></span>' : '') + '</button>';
    }).join('');
    html += '<button class="askx-tab add" data-t="__new" title="新建一个划词追问任务">+</button>';
    tabsEl.innerHTML = html;

    tabsEl.querySelectorAll('.askx-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-t');
        if (id === '__new') createTask('');
        else switchTask(id);
      });
    });
  }

  function addQuote(text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    var t = activeTask();
    if (t.quotes.indexOf(text) >= 0) return false;
    t.quotes.push(text);
    renderQuotes();
    renderTabs();
    updateMeta();
    return true;
  }

  function renderQuotes() {
    if (!quotesEl) return;
    var t = activeTask();
    if (!t.quotes.length) { quotesEl.innerHTML = ''; return; }
    quotesEl.innerHTML = t.quotes.map(function (s, i) {
      return '<div class="askx-quote-item"><span>' + esc(s) + '</span>' +
        '<button data-i="' + i + '" title="移除这条引用">&times;</button></div>';
    }).join('');
    quotesEl.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        activeTask().quotes.splice(Number(b.getAttribute('data-i')), 1);
        renderQuotes();
        renderTabs();
        updateMeta();
      });
    });
  }

  function quoteDraftTick() { /* 预留：引用草稿同步 */ }

  /* ================================================================ */
  /* 面板渲染                                                          */
  /* ================================================================ */

  function renderThread() {
    var t = activeTask();
    if (!t.history.length) {
      thread.innerHTML =
        '<div class="askx-empty">' +
        (t.quotes.length
          ? '这个任务已引用 ' + t.quotes.length + ' 段原文。<br>直接回车问「' + '深入浅出解释这段' + '」，或自己写问题。'
          : '在正文里选中文字，用浮动气泡的四个动作：<br>' +
            '<b>解释这个词</b> 就地弹卡片 · <b>解释这段</b> 进这里细讲<br>' +
            '<b>引用</b> 把选段挂到提问框 · <b>新建问题</b> 另起一个追问任务') +
        '</div>';
      return;
    }
    thread.innerHTML = '';
    for (var i = 0; i < t.history.length; i++) {
      var h = t.history[i];
      if (h.role === 'user') {
        appendQABlock(h.question, h.answer, h.index, h.selection);
      }
    }
    thread.scrollTop = thread.scrollHeight;
  }

  function appendQABlock(question, answer, index, selection, streaming) {
    var el = document.createElement('div');
    el.className = 'askx-item';
    el.innerHTML =
      '<div class="askx-q"><span class="no">' + index + '</span><span class="txt">' + esc(question) + '</span></div>' +
      (selection ? '<div class="askx-quote-item" style="margin:7px 0 9px 25px"><span>' + esc(selection) + '</span></div>' : '') +
      '<div class="askx-a"></div>' +
      '<div class="askx-acts"><button data-act="copy">复制</button><button data-act="reuse">引为引用</button></div>';
    thread.appendChild(el);

    var aEl = el.querySelector('.askx-a');
    el.querySelector('[data-act="copy"]').addEventListener('click', function () {
      navigator.clipboard.writeText(aEl.innerText || '').then(function () {
        el.querySelector('[data-act="copy"]').textContent = '已复制';
      });
    });
    el.querySelector('[data-act="reuse"]').addEventListener('click', function () {
      addQuote(aEl.innerText);
      el.querySelector('[data-act="reuse"]').textContent = '已引用';
    });

    if (!streaming) {
      aEl.innerHTML = answer ? renderMarkdown(answer) : '';
      renderMath(aEl);
    }
    thread.scrollTop = thread.scrollHeight;
    return aEl;
  }

  function updateMeta() {
    var t = activeTask();
    var sec = state.section || currentSection();
    meta.textContent = (LESSON ? LESSON.replace(/\.html$/, '') : '未识别课程') + (sec ? '　·　' + sec : '');
    var lc = state.lessonMode === 'section' ? '当前章节' : '整课全文';
    chips.innerHTML =
      '<span class="askx-chip">MISSION</span>' +
      '<span class="askx-chip">课程目录 ' + state.catalog.length + '</span>' +
      '<span class="askx-chip">' + lc + '</span>' +
      '<span class="askx-chip' + (t.quotes.length ? '' : ' off') + '">引用 ' + t.quotes.length + '</span>' +
      '<span class="askx-chip off">任务 ' + t.no + '/' + state.tasks.length + '</span>';
  }

  function hint(msg, isAlert) {
    hintEl.textContent = msg || '';
    hintEl.className = 'askx-hint' + (isAlert ? ' alert' : '');
  }

  /* ================================================================ */
  /* 抽屉 / 卡片 开合                                                   */
  /* ================================================================ */

  function openDrawer() {
    drawer.classList.add('open');
    document.body.classList.add('askx-open');
    ensureFirstTask();
    renderTabs();
    updateMeta();
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    document.body.classList.remove('askx-open');
  }

  /* ================================================================ */
  /* 卡片管理（多实例 + 父子层级）                                      */
  /* ================================================================ */

  var cardSeq = 0;
  var CARD_LIMIT = 5;

  function findCard(id) {
    for (var i = 0; i < state.nodes.length; i++) if (state.nodes[i].id === id) return state.nodes[i];
    return null;
  }

  /** 收集某张卡片的全部后代 */
  function cardDescendants(id) {
    var out = [];
    var stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      for (var i = 0; i < state.nodes.length; i++) {
        if (state.nodes[i].parentId === cur) {
          out.push(state.nodes[i]);
          stack.push(state.nodes[i].id);
        }
      }
    }
    return out;
  }

  /** 当前打开着的节点 */
  function openNodes() {
    return state.nodes.filter(function (n) {
      return !!n.el;
    });
  }

  function detach(n) {
    if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
    n.el = null;
  }

  /**
   * 收起卡片视图。**节点本身留在提问树里**（可随时从树面板恢复），
   * 所以这里只摘 DOM，不碰 state.nodes。cascade !== false 时连后代一起收起。
   */
  function closeCard(c, cascade) {
    if (typeof c === 'string') c = findCard(c);
    if (!c) return;
    var targets = [c];
    if (cascade !== false) targets = targets.concat(cardDescendants(c.id));
    targets.forEach(detach);
    renderTree();
  }

  /** 收起全部卡片（节点仍保留在树里） */
  function closeAllCards() {
    state.nodes.slice().forEach(detach);
    renderTree();
  }

  /** 从树里彻底删除一个节点（连同后代），不可恢复 */
  function removeNode(n) {
    if (typeof n === 'string') n = findCard(n);
    if (!n) return;
    var doomed = [n].concat(cardDescendants(n.id));
    doomed.forEach(detach);
    state.nodes = state.nodes.filter(function (x) {
      return doomed.indexOf(x) === -1;
    });
    saveTreeSoon();
    renderTree();
  }

  /** 打开着的卡片过多时收起最旧的（节点保留） */
  function trimCards() {
    var open = openNodes();
    while (open.length > CARD_LIMIT) closeCard(open.shift(), true);
  }

  function clampX(x, w) {
    return Math.max(6, Math.min(x, window.innerWidth - w - 6));
  }

  function clampY(y, h) {
    return Math.max(6, Math.min(y, window.innerHeight - h - 6));
  }

  /**
   * 定位卡片。
   * 有 anchor（划词位置）时：优先浮在选区上方，空间不够就放下方。
   * 有 parentId 时：从父卡片右下角长出来，直观体现树状关系。
   */
  function layoutCard(c, anchor) {
    var el = c.el;
    var w = el.offsetWidth || 340;
    var h = el.offsetHeight || 170;
    var left, top;

    var parent = c.parentId ? findCard(c.parentId) : null;
    if (parent && parent.el) {
      var pr = parent.el.getBoundingClientRect();
      left = pr.right - 40;
      top = pr.top + 46;
    } else if (anchor) {
      left = anchor.left + anchor.width / 2 - w / 2;
      top = anchor.top - h - 10;
      if (top < 10) top = anchor.bottom + 10;
    } else {
      left = (window.innerWidth - w) / 2;
      top = 70;
    }

    // 同层已打开的卡片错开一点，避免完全叠住
    var sameLevel = openNodes().filter(function (x) {
      return x !== c && x.level === c.level;
    }).length;
    left += sameLevel * 18;
    top += sameLevel * 14;

    el.style.left = clampX(left, w) + 'px';
    el.style.top = clampY(top, h) + 'px';
  }

  /** 卡片内容被填充后可能变高，避免被推出屏幕 */
  function keepCardInViewport(c) {
    var el = c.el;
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 6) {
      el.style.top = clampY(window.innerHeight - el.offsetHeight - 6, el.offsetHeight) + 'px';
    }
  }

  /* ================================================================ */
  /* 提问树持久化（localStorage，按课程分开存）                          */
  /* ================================================================ */

  var TREE_KEY_PREFIX = 'askx:tree:';
  var TREE_VER = 1;
  var saveTimer = null;

  function treeKey() {
    return TREE_KEY_PREFIX + (LESSON || 'unknown');
  }

  function serializeNodes(keepDeep) {
    return state.nodes.map(function (n) {
      return {
        id: n.id,
        term: n.term,
        rawTerm: n.rawTerm,
        level: n.level,
        parentId: n.parentId,
        brief: n.brief,
        deep: keepDeep ? n.deep : '',
        view: keepDeep ? n.view : 'brief',
        at: n.at,
      };
    });
  }

  /** 只存数据，不存 DOM（el）与瞬时态（busy）。写不动就降级，绝不抛错。 */
  function saveTreeNow() {
    saveTimer = null;
    if (!state.nodes.length) {
      try {
        localStorage.removeItem(treeKey());
      } catch (e) {
        /* ignore */
      }
      return;
    }
    var base = { v: TREE_VER, seq: cardSeq, collapsed: state.collapsed };
    try {
      localStorage.setItem(treeKey(), JSON.stringify(Object.assign({ nodes: serializeNodes(true) }, base)));
    } catch (e) {
      // 多半是超配额：退一步只留简版
      try {
        localStorage.setItem(treeKey(), JSON.stringify(Object.assign({ nodes: serializeNodes(false) }, base)));
      } catch (e2) {
        /* 放弃持久化，不影响本次使用 */
      }
    }
  }

  /** 防抖保存：详细版回答上千字，频繁写入会拖慢渲染 */
  function saveTreeSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveTreeNow, 400);
  }

  function loadTree() {
    var raw = null;
    try {
      raw = localStorage.getItem(treeKey());
    } catch (e) {
      return;
    }
    if (!raw) return;
    var d;
    try {
      d = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!d || d.v !== TREE_VER || !Array.isArray(d.nodes)) return;

    cardSeq = Math.max(cardSeq, Number(d.seq) || 0);
    state.collapsed = d.collapsed && typeof d.collapsed === 'object' ? d.collapsed : {};
    state.nodes = d.nodes
      .filter(function (n) {
        return n && n.id && n.term;
      })
      .map(function (n) {
        return {
          id: n.id,
          term: n.term,
          rawTerm: n.rawTerm || n.term,
          level: n.level || 0,
          parentId: n.parentId || null,
          brief: n.brief || '',
          deep: n.deep || '',
          view: n.view || 'brief',
          busy: false,
          el: null, // 全部以「收起」状态恢复，从树里点开
          at: n.at || Date.now(),
        };
      });

    // 父节点已不在的孤儿节点挂回根，否则树渲染时会整枝消失
    var ids = {};
    state.nodes.forEach(function (n) {
      ids[n.id] = 1;
    });
    state.nodes.forEach(function (n) {
      if (n.parentId && !ids[n.parentId]) n.parentId = null;
    });
  }

  function clearTreeStorage() {
    try {
      localStorage.removeItem(treeKey());
    } catch (e) {
      /* ignore */
    }
  }

  /* ================================================================ */
  /* 提问树面板（左下角入口 → 向上弹出的缩进折叠列表）                    */
  /* ================================================================ */

  function childrenOf(parentId) {
    return state.nodes.filter(function (n) {
      return n.parentId === parentId;
    });
  }

  function renderTree() {
    if (!treeBody) return;

    var total = state.nodes.length;
    var openCount = openNodes().length;

    if (treeBadge) {
      treeBadge.style.display = total ? 'flex' : 'none';
      treeBadge.textContent = String(total);
    }
    if (treeBtn) treeBtn.dataset.empty = total ? '0' : '1';
    var sub = treePanel && treePanel.querySelector('.askx-tree-sub');
    if (sub) sub.textContent = total ? '  ' + total + ' 个 · ' + openCount + ' 打开中' : '';

    if (!total) {
      treeBody.innerHTML =
        '<div class="askx-tree-empty">这一课还没有划过词。<br>在正文里选一段文字，点「解释这个词」就会出现在这里。</div>';
      return;
    }

    var html = '';
    (function walk(parentId, depth) {
      childrenOf(parentId).forEach(function (n) {
        var kids = childrenOf(n.id);
        var isCollapsed = !!state.collapsed[n.id];
        var isOpen = !!n.el;
        html +=
          '<div class="askx-tn' +
          (n.level ? ' lv' + n.level : '') +
          '" data-id="' +
          n.id +
          '" data-open="' +
          (isOpen ? '1' : '0') +
          '" style="padding-left:' +
          (7 + depth * 15) +
          'px" title="' +
          esc(n.term) +
          '">' +
          '<span class="askx-tn-tri"' +
          (kids.length ? '' : ' data-leaf="1"') +
          '>' +
          (isCollapsed ? '&#9654;' : '&#9660;') +
          '</span>' +
          '<span class="askx-tn-dot' +
          (n.level ? ' lv' + n.level : '') +
          '"></span>' +
          '<span class="askx-tn-txt">' +
          esc(n.term) +
          '</span>' +
          (n.deep ? '<span class="askx-tn-tag">详</span>' : '') +
          '</div>';
        if (!isCollapsed) walk(n.id, depth + 1);
      });
    })(null, 0);

    treeBody.innerHTML = html;

    if (!treeBody.dataset.bound) {
      treeBody.dataset.bound = '1';
      treeBody.addEventListener('click', function (e) {
        var row = e.target.closest ? e.target.closest('.askx-tn') : null;
        if (!row) return;
        var n = findCard(row.dataset.id);
        if (!n) return;
        if (e.target.closest('[data-tri]')) {
          if (childrenOf(n.id).length) {
            state.collapsed[n.id] = !state.collapsed[n.id];
            saveTreeSoon();
            renderTree();
          }
          return;
        }
        reopenNode(n);
      });
    }
  }

  /** 从提问树重新打开一个节点的卡片；已打开则提到最前并闪一下。 */
  function reopenNode(n) {
    if (n.el) {
      n.el.style.zIndex = String(2147482900 + openNodes().length * 5);
      if (n.el.animate) {
        n.el.animate(
          [{ boxShadow: '0 0 0 3px rgba(140,47,31,.4)' }, { boxShadow: '0 10px 34px rgba(0,0,0,.14)' }],
          { duration: 640 }
        );
      }
    } else {
      // 根节点给个占位锚点，让它出现在视口中上部
      var anchor = n.parentId ? null : { left: window.innerWidth / 2 - 170, top: 170, width: 0, bottom: 170 };
      attachCard(n, anchor);
    }
    renderTree();
  }

  /* ================================================================ */
  /* 动作一：解释这个词（就地卡片）                                      */
  /* ================================================================ */

  var TERM_MAX = 30;

  function cardHTML(c) {
    return [
      '<div class="askx-card-head">',
      '<span class="askx-card-lv"></span>',
      c.level > 0 ? '<span class="askx-card-child">└</span>' : '',
      '<span class="askx-card-title"></span>',
      '<button class="askx-card-x" title="收起卡片（可从左下角提问树找回）">&times;</button>',
      '</div>',
      '<div class="askx-card-body"></div>',
      '<div class="askx-card-foot">',
      '<button data-c="deep">深入解释</button>',
      '<button data-c="copy">复制</button>',
      '<button data-c="toDrawer">转入追问</button>',
      '<span class="askx-card-hint">可拖动</span>',
      '</div>',
    ].join('');
  }

  /**
   * 新建一张定义卡片。
   * 若选区来自另一张卡片内部（parentId 非空），新卡片会挂在它下面，
   * 位置也从父卡片右下长出，形成可见的树状关系。
   */
  /** 只建数据节点，不建 DOM。 */
  function newNode(term, parentId) {
    var parent = parentId ? findCard(parentId) : null;
    var n = {
      id: 'c' + ++cardSeq,
      term: clip(term, TERM_MAX),
      rawTerm: term,
      level: parent ? Math.min(parent.level + 1, 3) : 0,
      parentId: parent ? parent.id : null,
      brief: '',
      deep: '',
      view: 'brief',
      busy: false,
      el: null,
      at: Date.now(),
    };
    state.nodes.push(n);
    saveTreeSoon();
    return n;
  }

  /** 把节点渲染成浮层卡片。已打开的话只把它提到最前。 */
  function attachCard(n, anchor) {
    if (n.el) {
      n.el.style.zIndex = String(2147482900 + openNodes().length * 5);
      return n;
    }
    n.el = document.createElement('div');
    n.el.className = 'askx-card' + (n.level ? ' lv' + n.level : '');
    n.el.innerHTML = cardHTML(n);
    q('.askx-card-title', n.el).textContent = n.term;
    document.body.appendChild(n.el);
    bindCard(n);
    // 从提问树恢复时，内容已经在节点里了，直接回填
    if (n.brief || n.deep) {
      setCardBody(n, renderMarkdown(n.view === 'deep' && n.deep ? n.deep : n.brief), false);
      setCardBusy(n, false);
    }
    layoutCard(n, anchor);
    trimCards();
    renderTree();
    return n;
  }

  /** 新建一张卡片：建节点 + 立刻渲染出来。 */
  function createCard(term, parentId, anchor) {
    var n = newNode(term, parentId);
    attachCard(n, anchor);
    return n;
  }

  function bindCard(c) {
    q('.askx-card-x', c.el).addEventListener('click', function () {
      closeCard(c, true);
    });
    makeDraggable(c.el, q('.askx-card-head', c.el));

    c.el.querySelector('[data-c="deep"]').addEventListener('click', function () {
      toggleDeep(c);
    });
    c.el.querySelector('[data-c="copy"]').addEventListener('click', function () {
      navigator.clipboard.writeText(q('.askx-card-body', c.el).innerText || '');
      var b = c.el.querySelector('[data-c="copy"]');
      b.textContent = '已复制';
      setTimeout(function () {
        b.textContent = '复制';
      }, 1200);
    });
    c.el.querySelector('[data-c="toDrawer"]').addEventListener('click', function () {
      var body = q('.askx-card-body', c.el).innerText;
      openDrawer();
      addQuote(c.term);
      var t = activeTask();
      t.history.push({
        role: 'user',
        index: ++state.seq,
        question: '解释「' + c.term + '」',
        selection: c.term,
        answer: body,
        quotes: [c.term],
        mode: 'define',
      });
      t.steps += 1;
      renderThread();
      renderTabs();
      updateMeta();
    });
  }

  function setCardBody(c, html, streaming) {
    var bodyEl = q('.askx-card-body', c.el);
    if (!bodyEl) return;
    bodyEl.innerHTML = html + (streaming ? '<span class="askx-caret"></span>' : '');
    if (!streaming) renderMath(bodyEl);
  }

  function setCardBusy(c, busy, label) {
    c.busy = busy;
    // 卡片可能已被收起（节点还在树里），此时没有 DOM 可更新
    if (!c.el) return;
    var b = c.el.querySelector('[data-c="deep"]');
    if (!b) return;
    b.disabled = busy;
    b.textContent = busy ? label || '生成中…' : c.view === 'deep' ? '返回简版' : '深入解释';
  }

  /** 跑一次定义请求，结果写进卡片。deep=true 走详细版提示词。 */
  async function runCardRequest(c, deep) {
    var acc = '';
    var lastPaint = null;
    function paint() {
      if (lastPaint === acc) return;
      lastPaint = acc;
      var bodyEl = q('.askx-card-body', c.el);
      if (!bodyEl) return;
      // 流式期间用纯文本快速渲染：长回答下每 240ms 做一次 Markdown 解析会拖住
      // 事件循环，反过来拖慢 SSE 读取。结束后再一次性做格式化渲染。
      bodyEl.innerHTML =
        '<span style="white-space:pre-wrap">' + esc(acc) + '</span><span class="askx-caret"></span>';
      keepCardInViewport(c);
    }
    var ticker = setInterval(paint, 240);

    try {
      await streamAsk(
        withDoc({
          mode: deep ? 'defineDeep' : 'define',
          section: state.section || currentSection(),
          selection: c.rawTerm,
          paragraph: state.paragraph,
          quotes: [c.rawTerm],
          sourceFrom: state.sourceFrom,
        }),
        {
          onDelta: function (d) { acc += d; },
          onText: function (t) { acc = t; },
          onStatus: function (s) {
            if (!acc) setCardBody(c, '<span style="color:#8a877f">' + esc(s) + '</span>', false);
          },
          onError: function (ev) {
            acc = '';
            setCardBody(c, '<div class="askx-a err">' + esc('失败：' + ev.v) + '</div>', false);
          },
        }
      );
    } catch (err) {
      setCardBody(c, '<div class="askx-a err">' + esc('失败：' + err.message) + '</div>', false);
    } finally {
      clearInterval(ticker);
      if (acc) {
        if (deep) c.deep = acc;
        else c.brief = acc;
        setCardBody(c, renderMarkdown(acc), false);
        saveTreeSoon(); // 内容落盘，刷新后仍能恢复
      } else if (!q('.askx-a', c.el)) {
        setCardBody(c, '<em style="color:#8a877f">（空回答）</em>', false);
      }
      keepCardInViewport(c);
    }
    return acc;
  }

  /** 简版 ↔ 详细版切换。详细版没生成过就先请求一次，之后再切是瞬时的。 */
  async function toggleDeep(c) {
    if (c.busy) return;
    if (c.view === 'deep') {
      c.view = 'brief';
      setCardBody(c, c.brief ? renderMarkdown(c.brief) : '<em style="color:#8a877f">（还没有简版）</em>', false);
      setCardBusy(c, false);
      return;
    }
    if (c.deep) {
      c.view = 'deep';
      setCardBody(c, renderMarkdown(c.deep), false);
      setCardBusy(c, false);
      return;
    }
    c.view = 'deep';
    setCardBusy(c, true, '生成中…');
    setCardBody(c, '<span style="color:#8a877f">正在深入解释「' + esc(c.term) + '」…</span>', true);
    await runCardRequest(c, true);
    setCardBusy(c, false);
  }

  /** 动作一：解释这个词 —— 以当前选区开一张卡片（选区若在卡片内则形成子树）。 */
  function explainTerm() {
    var term = state.selection;
    if (!term) return;
    var c = createCard(term, state.cardId || null, state.selectionRect || null);
    setCardBody(
      c,
      '<span style="color:#8a877f">正在解释「' + esc(c.term) + '」…</span><span class="askx-caret"></span>',
      false
    );
    runCardRequest(c, false).then(function () {
      setCardBusy(c, false);
    });
  }

  /* ================================================================ */
  /* 动作二：解释这段 / 自由追问                                        */
  /* ================================================================ */

  async function send(mode) {
    if (state.streaming) return;
    var t = activeTask();

    var question = input.value.trim();
    if (mode === 'qa' && !question) {
      if (!t.quotes.length) {
        hint('先划一段文字并点「引用」，或者直接写问题。', true);
        return;
      }
      question = '深入浅出地解释我引用的内容。';
    }
    if (mode === 'explain' && !t.quotes.length) {
      hint('还没有引用任何原文，先在正文里划一段。', true);
      return;
    }

    state.streaming = true;
    sendBtn.disabled = true;
    state.seq += 1;
    var index = state.seq;
    var quoteSnapshot = t.quotes.slice();

    var entry = {
      role: 'user',
      index: index,
      question: mode === 'explain' ? '深入浅出解释这段' : question,
      selection: quoteSnapshot.length ? quoteSnapshot[0] : '',
      answer: '',
      quotes: quoteSnapshot,
      mode: mode,
      sourceFrom: state.sourceFrom,
    };
    t.history.push(entry);
    t.steps += 1;
    renderTabs();

    var aEl = appendQABlock(entry.question, '', index, entry.selection, true);
    input.value = '';
    input.style.height = 'auto';
    hint('');

    var acc = '';
    var lastPaint = null;
    function paint() {
      if (aEl.dataset.done) return;
      if (lastPaint === acc) return;
      lastPaint = acc;
      // 同卡片：流式期间用纯文本，避免长回答下 Markdown 解析拖慢 SSE
      aEl.innerHTML = '<span style="white-space:pre-wrap">' + esc(acc) + '</span><span class="askx-caret"></span>';
      thread.scrollTop = thread.scrollHeight;
    }
    var ticker = setInterval(paint, 260);

    try {
      await streamAsk(
        withDoc({
          mode: mode,
          section: state.section || currentSection(),
          selection: quoteSnapshot[0] || '',
          quotes: quoteSnapshot,
          paragraph: state.paragraph,
          sourceFrom: entry.sourceFrom,
          question: question,
          history: t.history.slice(0, -1).slice(-8).map(function (h) {
            return { role: h.role, content: h.role === 'user' ? h.question : h.answer };
          }),
        }),
        {
          onDelta: function (d) { acc += d; },
          onText: function (x) { acc = x; },
          onStatus: function (s) { hint(s); },
          onLog: function (s) { hint(s); },
          onError: function (ev) {
            aEl.dataset.done = '1';
            aEl.classList.add('err');
            aEl.textContent = '提问失败：' + ev.v + (ev.hint ? '\n\n（hint: ' + ev.hint + '）' : '');
          },
        }
      );
    } catch (err) {
      aEl.dataset.done = '1';
      aEl.classList.add('err');
      aEl.textContent = '提问失败：' + err.message;
    } finally {
      clearInterval(ticker);
      if (!aEl.dataset.done) {
        aEl.dataset.done = '1';
        aEl.innerHTML = renderMarkdown(acc) || '<em style="color:#8a877f">（空回答）</em>';
        renderMath(aEl);
      }
      entry.answer = acc;
      state.streaming = false;
      sendBtn.disabled = false;
      updateMeta();
      thread.scrollTop = thread.scrollHeight;

      if (acc) {
        exportQA(withDoc({
          section: entry.selection ? state.section || currentSection() : '',
          selection: entry.quotes.join(' / '),
          question: entry.question,
          answer: acc,
        }));
      }
    }
  }

  /* ================================================================ */
  /* 选区捕获与气泡                                                     */
  /* ================================================================ */

  /** 「不能被气泡挡住」的区域：所有卡片的标题栏 + 抽屉的头与尾 */
  function chromeZones() {
    var zones = [];
    state.nodes.forEach(function (c) {
      var ch = q('.askx-card-head', c.el);
      if (ch) zones.push(ch.getBoundingClientRect());
    });
    if (drawer && drawer.classList.contains('open')) {
      var dh = q('.askx-head', drawer);
      if (dh) zones.push(dh.getBoundingClientRect());
      var df = q('.askx-foot', drawer);
      if (df) zones.push(df.getBoundingClientRect());
    }
    return zones;
  }

  function rectHit(z, x, y, w, h) {
    return !(x + w < z.left || x > z.right || y + h < z.top || y > z.bottom);
  }

  /**
   * 气泡优先浮在**选区上方**（最符合直觉）。
   * 若会挡住卡片标题栏或抽屉的头/尾，先尝试横向平移避开；
   * 左右都塞不下才退到选区下方。
   */
  function showBubble(range) {
    var r = range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return;
    bubble.classList.add('on');

    var w = bubble.offsetWidth || 300;
    var h = bubble.offsetHeight || 30;

    var aboveY = r.top - h - 10;
    var belowY = r.bottom + 10;
    var y = aboveY < 6 ? belowY : aboveY;
    var x = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));

    var zones = chromeZones();
    for (var i = 0; i < zones.length; i++) {
      if (!rectHit(zones[i], x, y, w, h)) continue;
      var leftTry = zones[i].left - w - 10;
      var rightTry = zones[i].right + 10;
      if (leftTry >= 6) x = leftTry;
      else if (rightTry + w <= window.innerWidth - 6) x = rightTry;
      else if (y === aboveY) y = belowY;
    }

    bubble.style.left = window.scrollX + x + 'px';
    bubble.style.top = window.scrollY + Math.max(6, y) + 'px';
  }

  function hideBubble() {
    if (bubble) bubble.classList.remove('on');
  }

  function captureSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    var text = sel.toString().trim();
    if (text.length < 2) return false;
    var range = sel.getRangeAt(0);
    var anchor = range.commonAncestorContainer;
    if (!inSelectableZone(anchor)) return false;
    if (isInteractive(anchor)) return false;

    state.selection = text;
    state.sourceFrom = zoneOf(anchor);
    state.selectionRect = range.getBoundingClientRect();
    var hostCard = cardAt(anchor);
    state.cardId = hostCard ? hostCard.id : null;
    // 只有正文里的选区才有「所在段落」这层上下文
    state.paragraph = state.sourceFrom === 'lesson' ? enclosingBlock(range) : '';
    state.section = currentSection();
    setSelHighlight(range);
    showBubble(range);
    return true;
  }

  document.addEventListener('mouseup', function (e) {
    // 抽屉和卡片里的选区不再被排除 —— 它们的内容同样可以划词提问
    if (bubble && bubble.contains(e.target)) return;
    setTimeout(function () {
      if (!captureSelection()) hideBubble();
    }, 10);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (state.treeOpen) {
        state.treeOpen = false;
        treePanel.classList.remove('on');
        e.preventDefault();
        return;
      }
      // 注意用 openNodes()：节点是长期保留的，按 state.nodes 判断会永远为真
      if (openNodes().length) {
        closeAllCards();
        e.preventDefault();
        return;
      }
      if (drawer.classList.contains('open')) {
        closeDrawer();
        e.preventDefault();
        return;
      }
      hideBubble();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      captureSelection();
      if (drawer.classList.contains('open')) closeDrawer();
      else openDrawer();
    }
  });

  // 捕获阶段监听所有滚动（含卡片、抽屉内部），避免气泡停在原地而文字已滚走
  document.addEventListener('scroll', hideBubble, { passive: true, capture: true });
  document.addEventListener('selectionchange', function () {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideBubble();
      setSelHighlight(null);
    }
  });

  /* ================================================================ */
  /* 启动                                                              */
  /* ================================================================ */

  async function boot() {
    injectCSS();
    buildUI();
    loadTree(); // 恢复本课已存的提问树（节点以「收起」状态回来，从树里点开）
    renderTree();
    ensureFirstTask();
    renderTabs();
    renderThread();
    try {
      var st = await fetch(ORIGIN + '/api/state' + (BOOT.docKind === 'pdf' ? '?kind=pdf' : '')).then(function (r) { return r.json(); });
      state.catalog = st.catalog || [];
      state.lessonMode = st.lessonMode || 'full';
      if (st.token) TOKEN = TOKEN || st.token;
      if (!LESSON) LESSON = location.pathname.split('/').pop();
      q('#askx-prov').textContent = (st.providerLabel || st.provider || '') + (st.model ? ' · ' + st.model : '');
    } catch (e) {
      hint('无法连接本地服务（' + ORIGIN + '）。请先运行 node tools/ask-server.mjs', true);
    }
    updateMeta();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__askAI = {
    open: openDrawer,
    close: closeDrawer,
    define: explainTerm,
    state: state,
    newTask: createTask,
    nodes: function () { return state.nodes; },
    openNodes: openNodes,
    closeAllCards: closeAllCards,
    showTree: function (on) {
      state.treeOpen = on !== false;
      treePanel.classList.toggle('on', state.treeOpen);
      renderTree();
    },
    reopen: function (id) {
      var n = findCard(id);
      if (n) reopenNode(n);
    },
  };
})();
