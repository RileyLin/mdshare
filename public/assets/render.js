/* mdshare renderer: Markdown -> sanitized HTML -> enhanced document.
 *
 * Retrofit contract: stored Markdown is never rewritten. Everything here happens at view time, and
 * every automatic rule fires only on a clear pattern; anything it doesn't recognise renders as
 * plain Markdown always did. The optional syntax (:::blocks, ==mark==, :badge[...], > [!NOTE],
 * frontmatter) is a superset of Markdown and degrades to readable text on GitHub or in plain text.
 * See /guide for the authoring guide and /llms.txt for the agent-facing version.
 */
(function () {
  'use strict';
  var CJK = '\u3400-\u9fff\uf900-\ufaff';
  var DIRECTIVES = ['summary', 'stats', 'steps', 'compare', 'cards', 'tabs', 'note', 'tip', 'warning', 'important', 'caution'];
  var CALLOUT_LABELS = { note: 'Note', tip: 'Tip', warning: 'Warning', important: 'Important', caution: 'Caution' };
  var FRONT_KEYS = { accent: /^(amber|terracotta|teal|indigo)$/, toc: /^(true|false)$/, layout: /^(wide|standard)$/ };

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- Frontmatter: only a leading block whose every line is a known `key: value` pair. An old
  // document that merely starts with a horizontal rule is left untouched.
  function splitFrontmatter(md) {
    var m = /^---[ \t]*\r?\n([\s\S]{0,600}?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
    if (!m) return { meta: {}, body: md };
    var meta = {};
    var lines = m[1].split(/\r?\n/).filter(function (l) { return l.trim(); });
    if (!lines.length) return { meta: {}, body: md };
    for (var i = 0; i < lines.length; i++) {
      var kv = /^\s*([a-z]+)\s*:\s*([\w-]+)\s*$/.exec(lines[i]);
      if (!kv || !FRONT_KEYS[kv[1]] || !FRONT_KEYS[kv[1]].test(kv[2])) return { meta: {}, body: md };
      meta[kv[1]] = kv[2];
    }
    return { meta: meta, body: md.slice(m[0].length) };
  }

  var BADGE_COLORS = /^(green|red|amber|blue|accent|gray)$/;
  function autoBadgeColor(t) {
    if (/(done|live|shipped|ok|pass|ready|已上线|完成|已完成|通过|上线|✅)/i.test(t)) return 'green';
    if (/(blocked|fail|risk|down|bug|阻塞|失败|风险|下线)/i.test(t)) return 'red';
    if (/(wip|in progress|pending|beta|next|todo|进行中|待定|下一步|测试中)/i.test(t)) return 'amber';
    if (/(new|新)/i.test(t)) return 'accent';
    return '';
  }

  var configured = false;
  function configure() {
    if (configured || !window.marked) return;
    configured = true;
    var container = {
      name: 'mdContainer', level: 'block',
      start: function (src) { var m = /(^|\n):::[a-z]/.exec(src); return m ? m.index + m[1].length : undefined; },
      tokenizer: function (src) {
        var m = /^:::([a-z]+)(?:[ \t]+([^\n]*))?\n([\s\S]*?)\n:::[ \t]*(?:\n+|$)/.exec(src);
        if (!m || DIRECTIVES.indexOf(m[1]) === -1) return undefined;
        return { type: 'mdContainer', raw: m[0], name: m[1], arg: (m[2] || '').trim(), body: m[3], tokens: this.lexer.blockTokens(m[3], []) };
      },
      renderer: function (t) {
        var inner = this.parser.parse(t.tokens);
        if (CALLOUT_LABELS[t.name]) {
          return '<div class="md-callout ' + t.name + '"><div class="md-label">' + esc(t.arg || CALLOUT_LABELS[t.name]) + '</div>' + inner + '</div>\n';
        }
        if (t.name === 'stats') {
          var cells = t.body.split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (l) {
            var tone = '';
            l = l.replace(/\s*\{(up|down|accent)\}\s*$/, function (_, x) { tone = x; return ''; });
            var parts = l.split('|');
            var v = (parts.shift() || '').trim();
            var lab = parts.join('|').trim();
            return '<div class="md-stat' + (tone ? ' ' + tone : '') + '"><span class="v">' + esc(v) + '</span>' +
              (lab ? '<span class="l">' + marked.parseInline(lab) + '</span>' : '') + '</div>';
          });
          return (t.arg ? '<div class="md-block-title">' + esc(t.arg) + '</div>' : '') + '<div class="md-stats">' + cells.join('') + '</div>\n';
        }
        return '<div class="md-dir" data-dir="' + t.name + '" data-arg="' + esc(t.arg) + '">' + inner + '</div>\n';
      },
    };
    var markExt = {
      name: 'mdMark', level: 'inline',
      start: function (src) { var i = src.indexOf('=='); return i < 0 ? undefined : i; },
      tokenizer: function (src, tokens) {
        // ==text== only: never part of a longer run of = signs ("===CHAT===", "a == b").
        var prev = tokens && tokens.length ? tokens[tokens.length - 1].raw : '';
        if (/=$/.test(prev)) return undefined;
        var m = /^==([^=\s](?:[^=\n]{0,198}[^=\s])?)==(?!=)/.exec(src);
        if (m) return { type: 'mdMark', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
      },
      renderer: function (t) { return '<mark>' + this.parser.parseInline(t.tokens) + '</mark>'; },
    };
    var badgeExt = {
      name: 'mdBadge', level: 'inline',
      start: function (src) { var i = src.indexOf(':badge['); return i < 0 ? undefined : i; },
      tokenizer: function (src) {
        var m = /^:badge\[([^\]\n]{1,40})\](?:\{([a-z]+)\})?/.exec(src);
        if (m) return { type: 'mdBadge', raw: m[0], text: m[1], color: m[2] && BADGE_COLORS.test(m[2]) ? m[2] : autoBadgeColor(m[1]) };
      },
      renderer: function (t) { return '<span class="md-badge' + (t.color && t.color !== 'gray' ? ' ' + t.color : '') + '">' + esc(t.text) + '</span>'; },
    };
    var renderer = {
      table: function (header, body) {
        return '<div class="table-wrap"><table><thead>' + header + '</thead><tbody>' + body + '</tbody></table></div>\n';
      },
    };
    marked.use({ gfm: true, breaks: false, renderer: renderer, extensions: [container, markExt, badgeExt] });
  }

  function toHtml(md) {
    configure();
    var fm = splitFrontmatter(String(md == null ? '' : md));
    var html = window.marked ? marked.parse(fm.body) : '<pre>' + esc(fm.body) + '</pre>';
    var clean = window.DOMPurify ? DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : esc(fm.body);
    return { html: clean, meta: fm.meta };
  }

  // ---------- Enhancement rules (DOM, after sanitising) ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function kids(node) { return Array.prototype.slice.call(node.children); }
  function textOf(n) { return (n.textContent || '').replace(/\s+/g, ' ').trim(); }

  function splitBySubheads(box) {
    // Group children of a directive into sections, one per ###/#### heading (or one section).
    var sections = [], cur = null;
    kids(box).forEach(function (c) {
      if (/^H[2-4]$/.test(c.tagName)) { cur = { title: textOf(c), head: c, nodes: [] }; sections.push(cur); }
      else { if (!cur) { cur = { title: '', head: null, nodes: [] }; sections.push(cur); } cur.nodes.push(c); }
    });
    return sections;
  }

  function buildDirectives(root) {
    root.querySelectorAll('.md-dir').forEach(function (box) {
      var name = box.getAttribute('data-dir'), arg = box.getAttribute('data-arg') || '';
      // Every block keeps its argument: summary uses it as the card label, the others show it as
      // a small title above the block (the fuzzer caught ":::compare Pricing" dropping "Pricing").
      if (arg && name !== 'summary') { var title = el('div', 'md-block-title', arg); box.parentNode.insertBefore(title, box); }
      if (name === 'summary') {
        box.className = 'md-summary';
        box.insertBefore(el('div', 'md-label', arg || 'Summary'), box.firstChild);
      } else if (name === 'steps') {
        var list = box.querySelector('ol, ul');
        if (list) {
          var ol = el('ol', 'md-timeline');
          kids(list).forEach(function (li) {
            var item = el('li');
            while (li.firstChild) item.appendChild(li.firstChild);
            var cb = item.querySelector('input[type=checkbox]');
            if (cb) { if (cb.checked) item.classList.add('done'); cb.remove(); }
            ol.appendChild(item);
          });
          list.replaceWith(ol);
        }
        box.className = 'md-steps-block';
      } else if (name === 'compare' || name === 'cards' || name === 'tabs') {
        var secs = splitBySubheads(box);
        var wrap = el('div', 'md-' + name);
        secs.forEach(function (s) {
          var sec = el('section');
          if (s.head) sec.appendChild(s.head);
          s.nodes.forEach(function (n) { sec.appendChild(n); });
          sec.setAttribute('data-title', s.title);
          wrap.appendChild(sec);
        });
        if (name === 'tabs') {
          var bar = el('div', 'md-tabbar');
          bar.setAttribute('role', 'tablist');
          kids(wrap).forEach(function (sec, i) {
            var b = el('button', null, sec.getAttribute('data-title') || ('Tab ' + (i + 1)));
            b.type = 'button'; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
            sec.hidden = i !== 0;
            b.addEventListener('click', function () {
              kids(bar).forEach(function (x, j) { x.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
              kids(wrap).forEach(function (x, j) { if (x !== bar) x.hidden = (j - 1) !== i; });
            });
            bar.appendChild(b);
          });
          wrap.insertBefore(bar, wrap.firstChild);
        }
        box.replaceWith(wrap);
      }
    });
  }

  var ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;
  var AUTO_CALLOUT = /^(注意|警告|提示|重要|小贴士|Note|Tip|Warning|Important|Caution|Heads[- ]up)\s*[：:]\s*/i;
  var AUTO_KIND = { '注意': 'warning', '警告': 'warning', '提示': 'tip', '小贴士': 'tip', '重要': 'important', note: 'note', tip: 'tip', warning: 'warning', important: 'important', caution: 'caution', 'heads-up': 'warning', 'heads up': 'warning' };
  function stripLeadingText(p, re) {
    // Remove a leading pattern that may be split across a <strong> and a text node.
    var first = p.firstChild;
    if (first && first.nodeType === 1 && first.tagName === 'STRONG' && re.test(first.textContent + (first.nextSibling && first.nextSibling.nodeType === 3 ? first.nextSibling.nodeValue : ''))) {
      var combined = first.textContent + (first.nextSibling && first.nextSibling.nodeType === 3 ? first.nextSibling.nodeValue : '');
      var rest = combined.replace(re, '');
      if (first.nextSibling && first.nextSibling.nodeType === 3) first.nextSibling.remove();
      first.replaceWith(document.createTextNode(rest));
      return;
    }
    if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(re, '');
  }
  function callouts(root) {
    root.querySelectorAll('blockquote').forEach(function (bq) {
      var p = bq.firstElementChild;
      if (!p || p.tagName !== 'P') return;
      var t = p.textContent.replace(/^\s+/, '');
      var kind = null, label = null, m;
      if ((m = ALERT.exec(t))) { kind = m[1].toLowerCase(); label = CALLOUT_LABELS[kind]; stripLeadingText(p, ALERT); }
      else if ((m = AUTO_CALLOUT.exec(t))) { kind = AUTO_KIND[m[1].toLowerCase()] || AUTO_KIND[m[1]] || 'note'; label = m[1]; stripLeadingText(p, AUTO_CALLOUT); }
      if (!kind) return;
      var box = el('div', 'md-callout ' + kind);
      box.appendChild(el('div', 'md-label', label));
      while (bq.firstChild) box.appendChild(bq.firstChild);
      if (p.firstChild && p.firstChild.nodeType === 3) p.firstChild.nodeValue = p.firstChild.nodeValue.replace(/^\s+/, '');
      if (!textOf(p) && !p.querySelector('img')) p.remove();
      bq.replaceWith(box);
    });
  }

  function subheads(root) {
    kids(root).forEach(function (p) {
      if (p.tagName !== 'P') return;
      var s = p.firstChild;
      if (!s || s.nodeType !== 1 || s.tagName !== 'STRONG') return;
      var label = textOf(s);
      if (!label || label.length > 40) return;
      var after = s.nextSibling;
      if (p.childNodes.length === 1 || (p.childNodes.length === 2 && after && after.nodeType === 3 && !after.nodeValue.trim())) {
        var h = el('h4', 'md-sub', label.replace(/[：:]\s*$/, ''));
        p.replaceWith(h);
      } else if (after && after.nodeType === 3 && /^[ \t]*\n/.test(after.nodeValue)) {
        var h2 = el('h4', 'md-sub', label.replace(/[：:]\s*$/, ''));
        after.nodeValue = after.nodeValue.replace(/^[ \t]*\n\s*/, '');
        s.remove();
        p.parentNode.insertBefore(h2, p);
      } else if (after && after.nodeType === 1 && after.tagName === 'BR') {
        var h3 = el('h4', 'md-sub', label.replace(/[：:]\s*$/, ''));
        s.remove(); after.remove();
        p.parentNode.insertBefore(h3, p);
      }
    });
  }

  var SUMMARY_RE = /^(一句话结论|一句话总结|一句话|核心结论|结论|总结|摘要|TL;?DR|Bottom line|Summary|Key takeaways?)$/i;
  function summaryCard(root) {
    var all = kids(root);
    var h2Count = 0;
    for (var i = 0; i < all.length && i < 14; i++) {
      var n = all[i];
      if (n.tagName === 'H2') h2Count++;
      if (h2Count > 1) return;
      if (!/^H[2-4]$/.test(n.tagName)) continue;
      if (!SUMMARY_RE.test(textOf(n).replace(/[：:]\s*$/, ''))) continue;
      // Absorb only the prose right under the heading (paragraphs and lists, at most 3); stop at
      // anything else so tables, callouts or blocks stay where the author put them.
      var body = [];
      for (var j = i + 1; j < all.length && /^(P|UL|OL)$/.test(all[j].tagName) && body.length < 3; j++) body.push(all[j]);
      if (!body.length) return;
      var card = el('div', 'md-summary');
      card.appendChild(el('div', 'md-label', textOf(n).replace(/[：:]\s*$/, '')));
      n.replaceWith(card);
      body.forEach(function (b) { card.appendChild(b); });
      return;
    }
  }

  function listRules(root) {
    root.querySelectorAll('ol').forEach(function (ol) {
      if (ol.closest('table, .md-summary, .md-timeline, .md-callout')) return;
      var items = kids(ol);
      if (items.length < 2 || items.length > 12) return;
      var ok = items.every(function (li) {
        var f = li.firstElementChild, first = li.firstChild;
        if (f && f.tagName === 'P') { first = f.firstChild; f = f.firstElementChild; }
        return f && f.tagName === 'STRONG' && first === f && textOf(f).length <= 60;
      });
      if (!ok) return;
      ol.classList.add('md-steps');
      var start = parseInt(ol.getAttribute('start'), 10);
      if (start > 1) ol.style.setProperty('--start', String(start - 1));
    });
    root.querySelectorAll('ul').forEach(function (ul) {
      if (ul.closest('table, .md-compare, .md-cards')) return;
      var items = kids(ul);
      if (items.length < 2) return;
      var ok = items.every(function (li) {
        var f = li.firstChild;
        if (!f || f.nodeType !== 1 || f.tagName !== 'STRONG') return false;
        var nx = f.nextSibling;
        var lead = (nx && nx.nodeType === 3 ? nx.nodeValue : '') || '';
        return /^\s*[：:—–-]/.test(lead) || /[：:]$/.test(f.textContent.trim());
      });
      if (ok) ul.classList.add('md-keys');
    });
  }

  var NUM_RE = /^[-+−~≈]?\s?[$¥€£]?\s?\d[\d,.\s]*(%|[kKmMbB]|万|亿|x|×|倍|ms|s|GB|TB|MB)?\+?$/;
  function tables(root) {
    root.querySelectorAll('table').forEach(function (t) {
      if (!t.parentElement.classList.contains('table-wrap')) {
        var w = el('div', 'table-wrap'); t.parentNode.insertBefore(w, t); w.appendChild(t);
      }
      var rows = Array.prototype.slice.call(t.querySelectorAll('tbody tr'));
      var heads = Array.prototype.slice.call(t.querySelectorAll('thead th'));
      var ncol = heads.length || (rows[0] ? rows[0].children.length : 0);
      for (var c = 0; c < ncol; c++) {
        var cells = rows.map(function (r) { return r.children[c]; }).filter(Boolean);
        var filled = cells.filter(function (td) { var s = textOf(td); return s && !/^(✅|✔|☑|❌|✖|⛔|⚠|🟡)/.test(s); });
        var nums = filled.filter(function (td) { return NUM_RE.test(textOf(td)); });
        if (filled.length >= 2 && nums.length / filled.length >= 0.75) {
          cells.forEach(function (td) { td.classList.add('num'); });
          if (heads[c]) heads[c].classList.add('num');
        }
      }
      t.querySelectorAll('td').forEach(function (td) {
        var s = textOf(td);
        if (/^(✅|✔️?|☑️)/.test(s)) td.classList.add('t-ok');
        else if (/^(❌|✖️?|⛔)/.test(s)) td.classList.add('t-bad');
        else if (/^(⚠️?|🟡)/.test(s)) td.classList.add('t-warn');
      });
    });
  }

  function codeBlocks(root, opts) {
    root.querySelectorAll('pre > code').forEach(function (code) {
      var pre = code.parentElement;
      if (pre.parentElement && pre.parentElement.classList.contains('code-block')) return;
      var m = /language-([\w+#.-]+)/.exec(code.className || '');
      var lang = m ? m[1] : '';
      if (lang === 'mermaid') {
        var div = el('div', 'mermaid'); div.setAttribute('data-src', code.textContent); div.textContent = code.textContent;
        pre.replaceWith(div); return;
      }
      var box = el('div', 'code-block');
      var head = el('div', 'code-head');
      head.appendChild(el('span', null, lang || 'text'));
      var btn = el('button', 'code-copy', 'Copy'); btn.type = 'button';
      btn.addEventListener('click', function () {
        var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1600); };
        if (navigator.clipboard) navigator.clipboard.writeText(code.textContent).then(done, function () { btn.textContent = 'Failed'; });
      });
      head.appendChild(btn);
      pre.parentNode.insertBefore(box, pre);
      box.appendChild(head); box.appendChild(pre);
      if (window.hljs && opts.highlight !== false) {
        try {
          if (lang && hljs.getLanguage(lang)) { code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); }
          else if (!lang && code.textContent.length < 20000) { var r = hljs.highlightAuto(code.textContent); if (r.relevance > 6) { code.innerHTML = r.value; code.classList.add('hljs'); } }
        } catch (e) { /* leave plain */ }
      }
    });
  }

  var mermaidLoading = null;
  function mermaidRun(root) {
    var nodes = root.querySelectorAll('.mermaid:not([data-done])');
    if (!nodes.length) return;
    var go = function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      try {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'DM Sans, PingFang SC, sans-serif' });
        nodes.forEach(function (n) { n.setAttribute('data-done', '1'); });
        // mermaid.run rejects (with a plain object) on a diagram it can't parse. Catch it so a bad
        // diagram never becomes an uncaught error, and show the source instead of a broken picture.
        Promise.resolve(window.mermaid.run({ nodes: nodes, suppressErrors: true })).catch(function () {
          nodes.forEach(function (n) {
            if (n.querySelector('svg') && !/Syntax error|error-icon/i.test(n.innerHTML)) return;
            n.classList.add('mermaid-failed');
            n.textContent = n.getAttribute('data-src') || n.textContent;
          });
        });
      } catch (e) { /* the source text stays visible */ }
    };
    if (window.mermaid) return go();
    if (!mermaidLoading) {
      mermaidLoading = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';
        s.onload = resolve; s.onerror = resolve;
        document.head.appendChild(s);
      });
    }
    mermaidLoading.then(function () { if (window.mermaid) go(); });
  }

  function slug(s, used) {
    var base = s.toLowerCase().replace(/[^\w\u3400-\u9fff\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'section';
    var id = base, i = 2;
    while (used[id]) id = base + '-' + (i++);
    used[id] = true;
    return id;
  }
  function headings(root, opts) {
    var used = {};
    root.querySelectorAll('h1, h2, h3, h4').forEach(function (h) {
      if (!h.id) h.id = (opts.idPrefix || '') + slug(textOf(h), used);
      if (h.tagName !== 'H1' && opts.anchors !== false) {
        var a = el('a', 'anchor', '#'); a.href = '#' + h.id; a.setAttribute('aria-label', 'Link to this section');
        h.insertBefore(a, h.firstChild);
      }
    });
  }

  function links(root) {
    root.querySelectorAll('a[href]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) && a.host !== location.host) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    });
    root.querySelectorAll('img').forEach(function (img) { img.loading = 'lazy'; img.decoding = 'async'; });
    root.querySelectorAll('li > input[type=checkbox]').forEach(function (cb) { cb.parentElement.classList.add('task'); });
  }

  // Term hints (opt-in): "lint 规则（静态检查规则：…）" -> term with a dotted underline and the
  // explanation in a tooltip. Conservative on purpose; off unless the reader turns it on.
  var GLOSS = new RegExp('([A-Za-z][A-Za-z0-9.+/#-]*(?: [A-Za-z0-9.+/#-]+){0,3}(?: ?(?:规则|工具|框架|协议|接口|模型|测试|函数|服务|平台|系统))?)（([^（）]{4,80})）', 'g');
  var GLOSS_SKIP = /^(含|包括|见|如|例如|比如|即|注|约|共|原文|幻灯片|来源)|["“”「」『』]/;
  function glosses(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.parentElement.closest('code, pre, a, abbr, h1, h2, h3, h4, .md-badge, th') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
    });
    var list = [];
    while (walker.nextNode()) list.push(walker.currentNode);
    var cjk = new RegExp('[' + CJK + ']');
    list.forEach(function (t) {
      var s = t.nodeValue;
      GLOSS.lastIndex = 0;
      if (!GLOSS.test(s)) return;
      GLOSS.lastIndex = 0;
      var frag = document.createDocumentFragment(), last = 0, m, changed = false;
      while ((m = GLOSS.exec(s))) {
        if (!cjk.test(m[2]) || GLOSS_SKIP.test(m[2])) continue;
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        var ab = el('abbr', 'md-gloss', m[1]); ab.tabIndex = 0;
        ab.appendChild(el('span', 'md-tip', m[2]));
        frag.appendChild(ab);
        last = GLOSS.lastIndex; changed = true;
      }
      if (!changed) return;
      frag.appendChild(document.createTextNode(s.slice(last)));
      t.replaceWith(frag);
    });
  }

  function motion(root) {
    if (!('IntersectionObserver' in window) || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    root.classList.add('motion');
    var targets = [];
    kids(root).forEach(function (c, i) {
      if (/^(md-stats|md-cards|md-compare)$/.test(c.className) || c.classList.contains('md-steps')) {
        kids(c).forEach(function (k, j) { k.classList.add('rv'); k.style.setProperty('--d', Math.min(j, 8) * 70 + 'ms'); targets.push(k); });
      } else {
        c.classList.add('rv');
        if (i < 6) c.style.setProperty('--d', i * 90 + 'ms');
        targets.push(c);
      }
    });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
        if (e.target.classList.contains('md-stat')) countUp(e.target.querySelector('.v'));
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    targets.forEach(function (t) { io.observe(t); });
  }

  function countUp(v) {
    if (!v || v.getAttribute('data-counted')) return;
    v.setAttribute('data-counted', '1');
    var text = v.textContent, m = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(text);
    if (!m) return;
    var target = parseFloat(m[2].replace(/,/g, '')), decimals = (m[2].split('.')[1] || '').length, comma = m[2].indexOf(',') > -1;
    if (!isFinite(target) || target === 0) return;
    var t0 = null, dur = 900;
    function fmt(x) { var s = x.toFixed(decimals); if (comma) { var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); } return m[1] + s + m[3]; }
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      v.textContent = fmt(target * e);
      if (k < 1) requestAnimationFrame(step); else v.textContent = text;
    }
    requestAnimationFrame(step);
  }

  function isCjk(root) {
    var s = (root.textContent || '').slice(0, 4000), n = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 0x3400 && c <= 0x9fff) n++; }
    return n > 60 && n / Math.max(1, s.replace(/\s/g, '').length) > 0.2;
  }

  function enhance(root, opts) {
    opts = opts || {};
    buildDirectives(root);
    callouts(root);
    subheads(root);
    summaryCard(root);
    listRules(root);
    tables(root);
    codeBlocks(root, opts);
    links(root);
    if (opts.gloss) glosses(root);
    headings(root, opts);
    if (isCjk(root)) root.classList.add('cjk');
    mermaidRun(root);
    if (opts.motion) motion(root);
  }

  function render(md, target, opts) {
    opts = opts || {};
    var out = toHtml(md);
    target.innerHTML = out.html;
    if (opts.classic) return out.meta;
    enhance(target, opts);
    return out.meta;
  }

  window.MDShareRender = { render: render, toHtml: toHtml, enhance: enhance, splitFrontmatter: splitFrontmatter, rerunMermaid: mermaidRun };
})();
