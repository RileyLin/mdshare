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
  var DIRECTIVES = ['summary', 'stats', 'steps', 'compare', 'cards', 'tabs', 'note', 'tip', 'warning', 'important', 'caution', 'table'];
  var CALLOUT_LABELS = { note: 'Note', tip: 'Tip', warning: 'Warning', important: 'Important', caution: 'Caution' };
  var FRONT_KEYS = { accent: /^(amber|terracotta|teal|indigo)$/, toc: /^(true|false)$/, layout: /^(wide|standard)$/, tables: /^(auto|table|cards|compact)$/ };

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
      if (name === 'table') { tableDirective(box, arg); return; }
      // :::steps reveal [caption]: "reveal" is an option word, the rest is the caption.
      var reveal = name === 'steps' && /^reveal(\s|$)/.test(arg);
      if (reveal) arg = arg.replace(/^reveal\s*/, '');
      if (arg && name !== 'summary') { var title = el('div', 'md-block-title', arg); box.parentNode.insertBefore(title, box); }
      if (name === 'summary') {
        box.className = 'md-summary';
        box.insertBefore(el('div', 'md-label', arg || 'Summary'), box.firstChild);
      } else if (name === 'steps') {
        var list = box.querySelector('ol, ul');
        if (list && reveal && list.tagName === 'OL' && isStepCards(list)) {
          // A bold-led numbered list walks through as numbered step cards.
          list.classList.add('md-steps');
          var st = parseInt(list.getAttribute('start'), 10);
          if (st > 1) list.style.setProperty('--start', String(st - 1));
        } else if (list) {
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
        if (reveal) box.setAttribute('data-reveal', '1');
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
              var show = function () {
                kids(bar).forEach(function (x, j) { x.setAttribute('aria-selected', j === i ? 'true' : 'false'); });
                kids(wrap).forEach(function (x, j) { if (x !== bar) x.hidden = (j - 1) !== i; });
              };
              if (window.MDShareMotion) window.MDShareMotion.transition(show); else show();
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
  // A numbered list of 2-12 items that all start in bold: shown as numbered step cards.
  function isStepCards(ol) {
    var items = kids(ol);
    if (items.length < 2 || items.length > 12) return false;
    return items.every(function (li) {
      var f = li.firstElementChild, first = li.firstChild;
      if (f && f.tagName === 'P') { first = f.firstChild; f = f.firstElementChild; }
      return f && f.tagName === 'STRONG' && first === f && textOf(f).length <= 60;
    });
  }
  function headTitle(h) { return textOf(h).replace(/[：:]\s*$/, '').trim(); }
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

  // Recap card: the LAST "##" section, when it is titled as a recap (要点回顾, Key takeaways, Recap …),
  // becomes a card at the end that answers the summary card at the top. Never 总结/Summary/Conclusion,
  // never a recap heading followed by another section. The heading stays an <h2> (contents, anchor);
  // the card takes the prose under it and stops at tables, code, diagrams and rules.
  var RECAP_RE = /^(要点回顾|记住这几点|记住这三点|关键要点|Key takeaways|Takeaways|Recap|What to remember)$/i;
  function recapCard(root) {
    var all = kids(root), h = null;
    for (var i = all.length - 1; i >= 0 && !h; i--) if (all[i].tagName === 'H2') h = all[i];
    if (!h || !RECAP_RE.test(headTitle(h))) return;
    var body = [];
    for (var n = h.nextElementSibling; n && body.length < 12 && (/^(P|UL|OL|H3|H4|BLOCKQUOTE)$/.test(n.tagName) || n.classList.contains('md-callout')); n = n.nextElementSibling) body.push(n);
    if (!body.length) return;
    var card = el('section', 'md-recap');
    h.parentNode.insertBefore(card, h);
    card.appendChild(h);
    body.forEach(function (b) { card.appendChild(b); });
  }

  // Glossary: a "##" section titled 术语 / 术语表 / 名词解释 / 关键术语 / Glossary / Terms / Key terms whose bullet
  // lists are all "- **TERM**：definition" becomes a tidy card, and the FIRST time each term appears in
  // the body it gets a dotted underline that opens its definition. Text nodes only (TreeWalker +
  // createElement): the readable text is unchanged, and the popover is built on demand outside the
  // document. "**TTS, Text-to-Speech（文本转语音）**" matches TTS, Text-to-Speech or 文本转语音.
  var GLOSSARY_RE = /^(术语|术语表|名词解释|关键术语|Glossary|Terms|Key terms)$/i;
  var GL_SEP = /^\s*[：:—–]\s*/;
  var CJK_CH = new RegExp('[' + CJK + ']');
  var LATIN_EDGE = /[A-Za-z0-9\u00c0-\u024f]/;
  var TERM_SKIP = 'h1, h2, h3, h4, h5, h6, a, code, pre, kbd, samp, abbr, button, summary, th, svg, .mermaid, .md-badge, .md-label, .md-block-title, .md-stat .v, .md-term, .md-glossary, .md-tabbar';
  function glossaryEntry(li) {
    var row = li.firstElementChild && li.firstElementChild.tagName === 'P' && li.firstChild === li.firstElementChild ? li.firstElementChild : li;
    var s = row.firstChild;
    if (!s || s.nodeType !== 1 || s.tagName !== 'STRONG') return null;
    var raw = textOf(s), sepIn = /[：:]$/.test(raw), term = raw.replace(/[：:]$/, '').trim();
    if (!term || term.length > 80) return null;
    var after = s.nextSibling;
    if (!sepIn && !(after && after.nodeType === 3 && GL_SEP.test(after.nodeValue))) return null;
    var def = '';
    for (var n = after; n; n = n.nextSibling) if (!(n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName))) def += n.textContent;
    def = def.replace(GL_SEP, '').replace(/\s+/g, ' ').trim();
    return def ? { row: row, strong: s, term: term, def: def, sepIn: sepIn } : null;
  }
  // Card layout: term | definition. The separator stays in the text (hidden visually).
  function shapeGlossaryRow(e) {
    var row = e.row, s = e.strong, start;
    row.classList.add('md-gl-row');
    if (e.sepIn) {
      var last = s.lastChild, m = last && last.nodeType === 3 ? /[：:]\s*$/.exec(last.nodeValue) : null;
      if (m) { last.nodeValue = last.nodeValue.slice(0, m.index); s.appendChild(el('span', 'md-gl-sep', m[0])); }
      start = s.nextSibling;
    } else {
      var t = s.nextSibling, m2 = GL_SEP.exec(t.nodeValue), sep = el('span', 'md-gl-sep', m2[0]);
      t.nodeValue = t.nodeValue.slice(m2[0].length);
      row.insertBefore(sep, t);
      start = t;
    }
    var def = el('span', 'md-gl-def'), moving = [];
    for (var n = start; n; n = n.nextSibling) { if (n.nodeType === 1 && /^(UL|OL)$/.test(n.tagName)) break; moving.push(n); }
    row.insertBefore(def, start || null);
    moving.forEach(function (x) { def.appendChild(x); });
  }
  function termAliases(term) {
    var inner = [], out = [];
    // The names outside parentheses first ("TTS, Text-to-Speech"), then the ones inside ("文本转语音").
    var rest = term.replace(/[（(]([^（）()]*)[）)]/g, function (_, x) { inner.push(x); return ','; });
    [rest].concat(inner).forEach(function (p) {
      p = p.replace(/\s+[/／]\s+|／|[，、；;]|,(?!\d)/g, '\u0000').replace(new RegExp('([' + CJK + '])/(?=[' + CJK + '])', 'g'), '$1\u0000');
      p.split('\u0000').forEach(function (a) {
        a = a.replace(/\s+/g, ' ').trim();
        if (a.length >= 2 && a.length <= 40 && (/[A-Za-z]/.test(a) || CJK_CH.test(a)) && out.indexOf(a) === -1) out.push(a);
      });
    });
    return out.slice(0, 6);
  }
  // Matching works on tokens: a run of Latin letters/digits, one CJK character, or one other visible
  // character; whitespace between tokens is free (soft line breaks). Names go into a token trie, so
  // the scan is linear in the text however many names share a prefix (an alternation regex was
  // quadratic on "a a a …" glossaries: adversarial review R1). Latin tokens are whole words, so "SM"
  // never matches inside "SMS"; at the edge of a text node the neighbouring text in the same block
  // is checked too ("**SM**S").
  var TOKEN_RE = new RegExp('[A-Za-z0-9\\u00c0-\\u024f]+|[' + CJK + ']|\\S', 'g');
  var TERM_BLOCK = 'p, li, td, th, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, figcaption, summary, pre, div, section';
  function tokenize(s) {
    var out = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s))) out.push({ t: m[0], k: m[0].toLowerCase(), i: m.index, e: m.index + m[0].length });
    return out;
  }
  function trieNode() { return { next: Object.create(null), ends: [] }; }
  function glossary(root) {
    var all = kids(root), h = null;
    for (var i = 0; i < all.length && !h; i++) if (all[i].tagName === 'H2' && GLOSSARY_RE.test(headTitle(all[i]))) h = all[i];
    if (!h) return;
    var run = [], entries = [], lists = 0;
    for (var n = h.nextElementSibling; n && (/^(P|UL|OL|H3|H4|H5|H6|BLOCKQUOTE)$/.test(n.tagName) || n.classList.contains('md-callout')); n = n.nextElementSibling) run.push(n);
    // Every list in the section must be a term list; one ordinary list means it is not a glossary.
    for (var j = 0; j < run.length; j++) {
      if (!/^(UL|OL)$/.test(run[j].tagName)) continue;
      var es = run[j].tagName === 'UL' && run[j].children.length ? kids(run[j]).map(glossaryEntry) : [null];
      if (es.some(function (e) { return !e; })) return;
      lists++;
      entries = entries.concat(es);
    }
    if (!lists) return;
    var card = el('section', 'md-glossary');
    h.parentNode.insertBefore(card, h);
    card.appendChild(h);
    run.forEach(function (x) { if (/^UL$/.test(x.tagName)) x.classList.add('md-glossary-list'); card.appendChild(x); });
    entries.forEach(shapeGlossaryRow);
    markTerms(root, entries.slice(0, 200), h);
  }
  function markTerms(root, entries, head) {
    var trie = trieNode(), names = 0;
    entries.forEach(function (e) {
      termAliases(e.term).forEach(function (a) {
        var toks = tokenize(a).slice(0, 48), node = trie;
        if (!toks.length) return;
        toks.forEach(function (tk) { node = node.next[tk.k] || (node.next[tk.k] = trieNode()); });
        // ALL-CAPS names (TTS, H100) match case-sensitively; others ignore case.
        node.ends.push({ entry: e, cs: !/[a-z]/.test(a), toks: toks.map(function (tk) { return tk.t; }), lead: LATIN_EDGE.test(toks[0].t), tail: LATIN_EDGE.test(toks[toks.length - 1].t) });
        names++;
      });
    });
    if (!names) return;
    // Every text node in order (skipped ones too), so a match at a node's edge can see its neighbours.
    var every = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    while (w.nextNode()) every.push(w.currentNode);
    var blockOf = function (t) { return t.parentElement ? t.parentElement.closest(TERM_BLOCK) : null; };
    var touches = function (i, d) { // does the text right before (d=-1) / after (d=1) node i end/start with a letter?
      var n = every[i + d];
      if (!n || blockOf(n) !== blockOf(every[i])) return false;
      var v = n.nodeValue || '';
      return LATIN_EDGE.test(d < 0 ? v.charAt(v.length - 1) : v.charAt(0));
    };
    var sameCase = function (toks, a, end) { for (var q = 0; q < end.toks.length; q++) if (toks[a + q].t !== end.toks[q]) return false; return true; };
    var left = entries.length;
    for (var i = 0; i < every.length && left > 0; i++) {
      var t = every[i], s = t.nodeValue;
      if (!s.trim() || !t.parentElement || t.parentElement.closest(TERM_SKIP)) continue;
      var toks = tokenize(s), last = 0, frag = null;
      for (var k = 0; k < toks.length && left > 0; k++) {
        var node = trie, best = null, bestEnd = -1;
        for (var j = k; j < toks.length && j - k < 48; j++) {
          node = node.next[toks[j].k];
          if (!node) break;
          for (var x = 0; x < node.ends.length; x++) {
            var end = node.ends[x];
            if (end.cs && !sameCase(toks, k, end)) continue;
            if (end.lead && toks[k].i === 0 && touches(i, -1)) continue;
            if (end.tail && toks[j].e === s.length && touches(i, 1)) continue;
            best = end; bestEnd = j; break; // longest so far; keep walking for a longer one
          }
        }
        if (!best) continue;
        var st = toks[k].i, en = toks[bestEnd].e;
        k = bestEnd; // the longest name owns its words, even when its entry is already marked
        if (best.entry.marked) continue; // first occurrence only
        best.entry.marked = true; left--;
        frag = frag || document.createDocumentFragment();
        frag.appendChild(document.createTextNode(s.slice(last, st)));
        var term = el('span', 'md-term', s.slice(st, en));
        term.setAttribute('role', 'button'); term.tabIndex = 0;
        term.setAttribute('aria-haspopup', 'dialog'); term.setAttribute('aria-expanded', 'false');
        term._mdGloss = { term: best.entry.term, def: best.entry.def, head: head };
        frag.appendChild(term);
        last = en;
      }
      if (frag) { frag.appendChild(document.createTextNode(s.slice(last))); t.parentNode.replaceChild(frag, t); }
    }
    if (entries.some(function (e) { return e.marked; })) bindTerms();
  }

  // The term popover: one at a time, appended to <body> (never inside the document text), fixed
  // next to its term. Hover (mouse) previews it, keyboard focus previews it, a click/tap/Enter pins it
  // (Enter also moves focus into it); Escape, Tab out or a tap outside closes it.
  var termPop = null, termTimer = 0, termBound = false, termRefocus = false;
  function placeTermPop() {
    if (!termPop) return;
    var t = termPop.term, pop = termPop.pop;
    if (!t.isConnected) { closeTermPop(false); return; }
    var rs = t.getClientRects(), first = rs[0] || t.getBoundingClientRect(), last = rs[rs.length - 1] || first;
    var vw = document.documentElement.clientWidth, vh = innerHeight, gap = 8;
    // Never taller than the screen (it scrolls inside); below the term, else above, else as close
    // as fits (a long definition at 160% on a phone, adversarial review R3).
    pop.style.maxHeight = Math.max(120, vh - 2 * gap) + 'px';
    var pw = pop.offsetWidth, ph = pop.offsetHeight, below = vh - last.bottom - 2 * gap, above = first.top - 2 * gap;
    var up = ph > below && (ph <= above || above > below), anchor = up ? first : last;
    var top = up ? first.top - gap - ph : last.bottom + gap;
    pop.style.left = Math.round(Math.max(gap, Math.min(anchor.left, vw - pw - gap))) + 'px';
    pop.style.top = Math.round(Math.max(gap, Math.min(top, vh - gap - ph))) + 'px';
  }
  function openTermPop(t, pinned, focusIn) {
    clearTimeout(termTimer);
    if (termPop && termPop.term === t) { if (pinned) termPop.pinned = true; if (focusIn) termPop.pop.focus(); return; }
    closeTermPop(false);
    var g = t._mdGloss; if (!g) return;
    var zh = !!t.closest('.cjk');
    var pop = el('div', 'md-term-pop'); pop.id = 'md-term-pop'; pop.tabIndex = -1;
    pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-labelledby', 'md-term-pop-t'); pop.setAttribute('aria-describedby', 'md-term-pop-d');
    var title = el('div', 'md-term-pop-t', g.term); title.id = 'md-term-pop-t';
    var def = el('p', 'md-term-pop-d', g.def.length > 260 ? g.def.slice(0, 240) + '…' : g.def); def.id = 'md-term-pop-d';
    pop.appendChild(title); pop.appendChild(def);
    if (g.head && g.head.id) { var a = el('a', 'md-term-pop-all', zh ? '全部术语 →' : 'All terms →'); a.setAttribute('href', '#' + g.head.id); pop.appendChild(a); }
    document.body.appendChild(pop);
    termPop = { term: t, pop: pop, pinned: !!pinned };
    t.setAttribute('aria-expanded', 'true'); t.setAttribute('aria-controls', pop.id);
    placeTermPop();
    if (focusIn) pop.focus();
  }
  function closeTermPop(refocus) {
    clearTimeout(termTimer);
    if (!termPop) return;
    var t = termPop.term;
    termPop.pop.remove();
    termPop = null;
    t.setAttribute('aria-expanded', 'false'); t.removeAttribute('aria-controls');
    if (refocus && t.isConnected) { termRefocus = true; t.focus(); termRefocus = false; }
  }
  function termOf(n) { return n && n.closest ? n.closest('.md-term') : null; }
  function inTermPop(n) { return !!(termPop && n && (termPop.pop.contains(n) || termPop.term.contains(n))); }
  function bindTerms() {
    if (termBound) return;
    termBound = true;
    document.addEventListener('click', function (e) {
      var t = termOf(e.target);
      if (t) { if (termPop && termPop.term === t && termPop.pinned) closeTermPop(false); else openTermPop(t, true, false); return; }
      if (termPop && e.target.closest && e.target.closest('.md-term-pop-all')) {
        // The link jumps to the glossary; focus goes with it (not left on <body>).
        var head = termPop.term._mdGloss && termPop.term._mdGloss.head;
        closeTermPop(false);
        if (head && head.isConnected) { head.tabIndex = -1; head.focus({ preventScroll: true }); }
      }
    });
    document.addEventListener('keydown', function (e) {
      var t = termOf(e.target);
      if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTermPop(t, true, true); return; }
      if (!termPop) return;
      var inside = inTermPop(e.target);
      if (e.key === 'Escape') { closeTermPop(inside); return; }
      if (e.key === 'Tab' && termPop.pop.contains(e.target)) {
        var link = termPop.pop.querySelector('a');
        if (!e.shiftKey && link && e.target !== link) { e.preventDefault(); link.focus(); return; }
        e.preventDefault(); closeTermPop(true);
      }
    });
    document.addEventListener('focusin', function (e) {
      if (termRefocus) return;
      var t = termOf(e.target);
      if (t) {
        var keyboard;
        try { keyboard = t.matches(':focus-visible'); } catch (x) { keyboard = false; }
        if (keyboard) openTermPop(t, false, false);
        return;
      }
      if (termPop && !inTermPop(e.target)) closeTermPop(false);
    });
    document.addEventListener('pointerdown', function (e) { if (termPop && !inTermPop(e.target)) closeTermPop(false); }, true);
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType !== 'mouse') return;
      var t = termOf(e.target);
      if (t) { clearTimeout(termTimer); if (!(termPop && termPop.term === t)) termTimer = setTimeout(function () { openTermPop(t, false, false); }, 140); }
      else if (inTermPop(e.target)) clearTimeout(termTimer);
    });
    document.addEventListener('pointerout', function (e) {
      if (e.pointerType !== 'mouse') return;
      var from = termOf(e.target) || (inTermPop(e.target) ? e.target : null);
      if (!from || termOf(e.relatedTarget) === from || inTermPop(e.relatedTarget)) return;
      clearTimeout(termTimer);
      if (termPop && !termPop.pinned) termTimer = setTimeout(function () { if (termPop && !termPop.pinned) closeTermPop(false); }, 240);
    });
    var raf = 0;
    var follow = function () { if (termPop && !raf) raf = requestAnimationFrame(function () { raf = 0; placeTermPop(); }); };
    addEventListener('scroll', follow, { passive: true, capture: true });
    addEventListener('resize', follow);
  }

  function listRules(root) {
    root.querySelectorAll('ol').forEach(function (ol) {
      if (ol.closest('table, .md-summary, .md-timeline, .md-callout')) return;
      if (!isStepCards(ol)) return;
      ol.classList.add('md-steps');
      var start = parseInt(ol.getAttribute('start'), 10);
      if (start > 1) ol.style.setProperty('--start', String(start - 1));
    });
    root.querySelectorAll('ul').forEach(function (ul) {
      if (ul.closest('table, .md-compare, .md-cards, .md-glossary')) return;
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

  // :::table [cards|table|wide|compact ...] [caption] around one Markdown table. Option words set
  // how the table is shown; every other word is kept as the caption (blocks never drop their text).
  var TABLE_OPTS = { cards: 1, table: 1, wide: 1, compact: 1 };
  function tableDirective(box, arg) {
    var words = arg.split(/\s+/).filter(Boolean), opts = [], caption = [];
    words.forEach(function (w) { (TABLE_OPTS[w.toLowerCase()] ? opts : caption).push(w); });
    var t = box.querySelector('table');
    if (t) {
      opts.forEach(function (o) {
        o = o.toLowerCase();
        if (o === 'cards' || o === 'table') t.setAttribute('data-view', o);
        else t.setAttribute('data-' + o, '1');
      });
      if (caption.length) t.setAttribute('data-caption', caption.join(' '));
    } else if (caption.length || opts.length) {
      box.parentNode.insertBefore(el('div', 'md-block-title', arg), box);
    }
    while (box.firstChild) box.parentNode.insertBefore(box.firstChild, box);
    box.remove();
  }

  // Visual width of text in em: CJK and full-width characters are ~1em, everything else ~0.55em.
  function vlen(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef) ? 1 : 0.55; }
    return n;
  }
  // Longest piece the browser can't break: a Latin word, or a short run of CJK (we don't want
  // fewer than ~4 characters on a line, so a CJK run counts as up to 4em).
  function longestChunk(s) {
    var best = 0;
    (s.match(/[A-Za-z0-9$€£%.,:/@#+_()'’-]+/g) || []).forEach(function (w) { best = Math.max(best, w.length * 0.55); });
    if (/[\u2e80-\u9fff]/.test(s)) best = Math.max(best, Math.min(4, vlen(s)));
    return best;
  }

  var NUM_RE = /^[-+−~≈]?\s?[$¥€£]?\s?\d[\d,.\s]*(%|[kKmMbB]|万|亿|x|×|倍|ms|s|GB|TB|MB)?\+?$/;
  function tables(root, meta) {
    root.querySelectorAll('table').forEach(function (t) {
      if (!t.parentElement.classList.contains('table-wrap')) {
        var w = el('div', 'table-wrap'); t.parentNode.insertBefore(w, t); w.appendChild(t);
      }
      var wrap = t.parentElement;
      if (!wrap.parentElement.classList.contains('table-block')) {
        var block = el('div', 'table-block'); wrap.parentNode.insertBefore(block, wrap); block.appendChild(wrap);
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
      shapeTable(t, rows, heads, ncol, meta || {});
    });
  }

  // Readability: measure each column, give it a sensible minimum and ideal width, keep short
  // columns on one line, label every cell with its header (for the Cards view), and record the
  // table's shape so the page layer (app.js) can widen it, scroll it or show it as cards.
  function shapeTable(t, rows, heads, ncol, meta) {
    var wrap = t.parentElement, block = wrap.parentElement;
    var labels = heads.map(textOf), ideal = 0, textCols = 0, textAvg = 0;
    rows.forEach(function (r) {
      kids(r).forEach(function (td, i) { if (labels[i]) td.setAttribute('data-label', labels[i]); });
    });
    for (var c = 0; c < ncol; c++) {
      var texts = rows.map(function (r) { return r.children[c] ? textOf(r.children[c]) : ''; });
      var lens = texts.map(vlen), max = Math.max.apply(null, lens.concat([0]));
      var avg = lens.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, lens.length);
      var head = heads[c] ? vlen(textOf(heads[c])) * 0.85 : 0; // header font is smaller
      var chunk = Math.max.apply(null, texts.map(longestChunk).concat([0]));
      var isNum = heads[c] ? heads[c].classList.contains('num') : false;
      // short (≤ 8em): never wraps. medium (≤ 16em): at most two lines. long: wraps, but never
      // narrower than a readable chunk; its ideal is about a third of its longest cell.
      var short = max <= 8 || isNum, colIdeal, colMin;
      if (short) { colIdeal = Math.max(max, head); colMin = colIdeal; }
      else if (max <= 16) { colIdeal = Math.max(max, head); colMin = Math.max(max / 2 + 0.6, chunk, head); }
      else {
        colIdeal = Math.min(24, Math.max(12, max / 3, head));
        colMin = Math.min(14, Math.max(7, chunk, head, max / 5));
      }
      if (!short && !isNum) { textCols++; textAvg += avg; }
      if (heads[c]) {
        heads[c].style.setProperty('--min', colMin.toFixed(1));
        heads[c].setAttribute('data-ideal', colIdeal.toFixed(1));
      }
      if (short) {
        if (heads[c]) heads[c].classList.add('nowrap');
        rows.forEach(function (r) { if (r.children[c]) r.children[c].classList.add('nowrap'); });
      }
      ideal += colIdeal + 2; // + cell padding (≈ 28px)
    }
    var firstShort = rows.length && heads[0] && heads[0].classList.contains('nowrap');
    if (firstShort && ncol >= 3) wrap.classList.add('rowhead');
    var textHeavy = textCols >= 2 && textAvg / textCols > 6;
    if (textHeavy) wrap.classList.add('text-heavy');
    // A comparison matrix (features × options, values like "tested", "refused", "✅") repeats a few
    // values across the grid; it's for scanning across, so it stays a table on wide screens.
    var counts = {}, body = [];
    rows.forEach(function (r) { kids(r).slice(1).forEach(function (td) { var k = (textOf(td).split(/[\s(（,，;；]/)[0] || '').toLowerCase(); if (k) { body.push(k); counts[k] = (counts[k] || 0) + 1; } }); });
    var repeated = body.filter(function (k) { return counts[k] >= 3; }).length;
    if (ncol >= 4 && body.length >= 8 && repeated / body.length >= 0.4) wrap.classList.add('matrix');
    if (rows.length > 12 || t.getAttribute('data-compact') || meta.tables === 'compact') wrap.classList.add('compact');
    wrap.setAttribute('data-ideal', ideal.toFixed(1));
    wrap.setAttribute('data-cols', String(ncol));
    var pref = t.getAttribute('data-view') || (meta.tables === 'cards' || meta.tables === 'table' ? meta.tables : '');
    if (pref) block.setAttribute('data-pref', pref);
    if (t.getAttribute('data-wide')) block.setAttribute('data-force-wide', '1');
    if (block.closest('.md-compare, .md-cards, .md-tabs, .md-callout, .md-summary, li, .md-steps-block')) block.setAttribute('data-nested', '1');
    var cap = t.getAttribute('data-caption');
    if (cap && !block.querySelector('.table-caption')) block.insertBefore(el('div', 'table-caption md-block-title', cap), wrap);
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

  // Mermaid: vendored (public/vendor, same bytes as the CDN build), loaded only when a page has a
  // diagram. Every diagram is parsed first; one mermaid can't parse shows its source with a label
  // instead of mermaid's "Syntax error" picture. Colours come from the page's CSS variables, so a
  // diagram matches the warm paper theme in light and dark. Drawn diagrams get an icon-only Expand
  // button (no text, so the readable text of the page is unchanged).
  var MERMAID_SRC = '/vendor/mermaid-11.17.2.min.js';
  var MERMAID_FONT = 'DM Sans, PingFang SC, Hiragino Sans GB, Noto Sans SC, sans-serif';
  var mermaidLoading = null;
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback;
  }
  // House palettes for charts (pie, xychart, quadrant, sankey) and for mindmap/timeline sections.
  // One per theme family: light, dark, and paper (warm sepia, a light-family theme). `strong` is for
  // bars, lines and sankey nodes (the page accent leads), `soft` for pie slices (dark text on them),
  // `tint`/`edge` for mindmap and timeline sections: warm tints, never mermaid's lime or yellow.
  var CHART = {
    light: {
      strong: { terracotta: '#b4532a', teal: '#2f7d79', amber: '#b7791f', indigo: '#4f5bb5', plum: '#8a4f7d', sage: '#5f7f4f', slate: '#3d6b9a', brick: '#a8382f' },
      soft: ['#e7ae92', '#9ccbc6', '#e6c58c', '#b2b8e8', '#d4adc9', '#b6caa4', '#a7c0dd', '#e3a9a2'],
      tint: ['#f5dfd1', '#efdcc6', '#f1dada', '#e8dfd0', '#e9dbe6', '#d9ebe7', '#f3e2cf', '#e3e0f0'],
      edge: ['#cf8d6b', '#c39a6e', '#c98f8f', '#b09c7b', '#ad8aa5', '#7fada6', '#c99b6c', '#9891c4'],
      sliceText: '#1f1b16',
    },
    dark: {
      strong: { terracotta: '#e08a5a', teal: '#6cc0ba', amber: '#e3ae55', indigo: '#9aa4ec', plum: '#c98fbd', sage: '#9cbf8a', slate: '#8fb4dc', brick: '#e6877c' },
      soft: ['#a45c39', '#3e7d78', '#9c7633', '#5c66ad', '#87597e', '#5f7c50', '#4f7299', '#9d4d45'],
      tint: ['#4a2f1f', '#46351f', '#472b2c', '#3d3322', '#412d40', '#233a36', '#47351f', '#322f45'],
      edge: ['#b06c44', '#a47b4f', '#a65f5f', '#8f7a56', '#93708c', '#4f8b83', '#a97a49', '#7c76ab'],
      sliceText: '#fbf6ee',
    },
    paper: {
      strong: { terracotta: '#a54b25', teal: '#2b716d', amber: '#a66d1a', indigo: '#475199', plum: '#7d466f', sage: '#566f44', slate: '#375f8a', brick: '#973128' },
      soft: ['#e0a283', '#92bdb8', '#dcb87b', '#a8aedc', '#c9a1bf', '#abbf98', '#9db4d1', '#d99b94'],
      tint: ['#efd6c3', '#e8cfb6', '#ebd2cf', '#e3d5bf', '#e2d0db', '#d2e2db', '#edd6bb', '#dcd6e8'],
      edge: ['#c07f5c', '#b48a5d', '#bb8080', '#a38e6c', '#a07e98', '#6f9f98', '#bb8c5c', '#8a83b8'],
      sliceText: '#2a2118',
    },
  };
  var TABLEAU10 = ['#4e79a7', '#f28e2c', '#e15759', '#76b7b2', '#59a14f', '#edc949', '#af7aa1', '#ff9da7', '#9c755f', '#bab0ab'];
  function themeFamily() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' ? 'dark' : t === 'paper' ? 'paper' : 'light';
  }
  function chartColors(fam) {
    var p = CHART[fam] || CHART.light, accent = document.documentElement.getAttribute('data-accent');
    var lead = p.strong[accent] ? accent : 'terracotta';
    var strong = [p.strong[lead]].concat(Object.keys(p.strong).filter(function (k) { return k !== lead; }).map(function (k) { return p.strong[k]; }));
    return { strong: strong, soft: p.soft, tint: p.tint, edge: p.edge, sliceText: p.sliceText };
  }
  // avail: the drawing width inside a diagram frame (px). Charts drawn at a fixed size by mermaid
  // (xychart, quadrant, sankey) are drawn at that width, so their labels keep their real size on a
  // phone instead of being scaled down to ~50%; a narrow pie puts its legend underneath.
  function mermaidConfig(avail) {
    var fam = themeFamily(), dark = fam === 'dark', c = chartColors(fam);
    var card = cssVar('--card', dark ? '#221d17' : '#fffdf9'), ink = cssVar('--ink', dark ? '#efe8dc' : '#1f1b16');
    var line = cssVar('--line-2', dark ? '#463d31' : '#d9d0c0'), muted = cssVar('--ink-3', dark ? '#988d7c' : '#857b6c');
    var soft = cssVar('--accent-soft', dark ? '#3a2619' : '#f6e6dc'), accent = cssVar('--accent', dark ? '#e08a5a' : '#b4532a');
    var paper2 = cssVar('--paper-2', dark ? '#1f1b15' : '#f1ece2'), ink2 = cssVar('--ink-2', dark ? '#cfc5b4' : '#4a4339');
    var card2 = cssVar('--card-2', dark ? '#1d1913' : '#fbf8f2'), accentInk = cssVar('--accent-ink', dark ? '#f0a77c' : '#8f3d1b');
    var w = Math.max(280, Math.min(720, Math.round(avail > 0 ? avail : 640))), narrow = w < 520;
    var tv = {
      background: card, mainBkg: card, primaryColor: card, primaryTextColor: ink, primaryBorderColor: line,
      secondaryColor: soft, secondaryBorderColor: accent, secondaryTextColor: ink,
      tertiaryColor: paper2, tertiaryBorderColor: line, tertiaryTextColor: ink,
      lineColor: muted, textColor: ink, nodeTextColor: ink, edgeLabelBackground: card, clusterBkg: paper2, clusterBorder: line,
      noteBkgColor: cssVar('--warn-soft', dark ? '#2e2414' : '#fbefd9'), noteBorderColor: cssVar('--warn-line', dark ? '#4d3b1d' : '#efd5a6'), noteTextColor: ink,
      actorBkg: card, actorBorder: line, actorTextColor: ink, signalColor: muted, signalTextColor: ink,
      fontSize: '15px',
      // pie
      pieStrokeColor: card, pieStrokeWidth: '2px', pieOuterStrokeColor: line, pieOuterStrokeWidth: '1px', pieOpacity: '1',
      pieTitleTextColor: ink, pieTitleTextSize: narrow ? '23px' : '20px', pieSectionTextColor: c.sliceText, pieSectionTextSize: narrow ? '19px' : '15px',
      pieLegendTextColor: ink2, pieLegendTextSize: narrow ? '20px' : '15px',
      // quadrantChart: the top-right quadrant (quadrant-1) is the one people look for first.
      quadrant1Fill: soft, quadrant2Fill: paper2, quadrant3Fill: card2, quadrant4Fill: paper2,
      quadrant1TextFill: accentInk, quadrant2TextFill: ink2, quadrant3TextFill: muted, quadrant4TextFill: ink2,
      quadrantPointFill: accent, quadrantPointTextFill: ink, quadrantXAxisTextFill: muted, quadrantYAxisTextFill: muted,
      quadrantInternalBorderStrokeFill: line, quadrantExternalBorderStrokeFill: line, quadrantTitleFill: ink,
      xyChart: {
        backgroundColor: card, titleColor: ink, dataLabelColor: ink, legendTextColor: ink2,
        xAxisTitleColor: muted, xAxisLabelColor: ink2, xAxisTickColor: line, xAxisLineColor: line,
        yAxisTitleColor: muted, yAxisLabelColor: ink2, yAxisTickColor: line, yAxisLineColor: line,
        plotColorPalette: c.strong.join(','),
      },
      // mindmap root and gitGraph main branch
      git0: accent, gitBranchLabel0: card, gitInv0: card,
    };
    for (var i = 0; i < 12; i++) {
      tv['pie' + (i + 1)] = c.soft[i % c.soft.length];
      // cScale0 is the mindmap root / first timeline section; sections cycle through warm tints.
      tv['cScale' + i] = c.tint[i % c.tint.length];
      tv['cScaleLabel' + i] = ink;
      tv['cScaleInv' + i] = c.edge[i % c.edge.length];
      tv['cScalePeer' + i] = c.edge[i % c.edge.length];
    }
    return {
      startOnLoad: false, securityLevel: 'strict', theme: 'base', darkMode: dark,
      fontFamily: MERMAID_FONT,
      themeVariables: tv,
      flowchart: { curve: 'basis', padding: 14, useMaxWidth: false }, sequence: { useMaxWidth: false }, gantt: { useMaxWidth: false },
      xyChart: {
        width: w, height: Math.round(Math.max(280, Math.min(400, w * 0.62))), titleFontSize: 17, titlePadding: 12,
        xAxis: { labelFontSize: 13, titleFontSize: 13, tickWidth: 1, axisLineWidth: 1 }, yAxis: { labelFontSize: 12, titleFontSize: 13, tickWidth: 1, axisLineWidth: 1 },
      },
      quadrantChart: {
        chartWidth: Math.min(500, w), chartHeight: Math.min(500, w), titleFontSize: 17, quadrantLabelFontSize: narrow ? 13 : 15,
        pointLabelFontSize: 13, pointRadius: 6, xAxisLabelFontSize: 13, yAxisLabelFontSize: 13, quadrantExternalBorderStrokeWidth: 1,
      },
      pie: { textPosition: 0.72, legendPosition: narrow ? 'bottom' : 'right' },
      sankey: { width: Math.min(640, w), height: Math.round(Math.max(260, Math.min(420, w * 0.62))), linkColor: 'gradient', nodeAlignment: 'justify', showValues: true },
      timeline: { taskFontFamily: MERMAID_FONT, taskFontSize: 14, leftMargin: 40, taskMargin: 30 },
      mindmap: { padding: 12, maxNodeWidth: narrow ? 150 : 200 },
    };
  }
  // Sankey takes its node colours from d3's Tableau 10, not from the theme: map them to the house
  // palette after drawing (attributes of our own freshly drawn svg; no markup is parsed).
  function recolorSankey(svg) {
    var fam = themeFamily(), strong = chartColors(fam).strong, map = {};
    TABLEAU10.forEach(function (hex, i) { map[hex] = strong[i % strong.length]; });
    Array.prototype.forEach.call(svg.querySelectorAll('[fill], [stroke], [stop-color]'), function (e) {
      ['fill', 'stroke', 'stop-color'].forEach(function (a) {
        var v = (e.getAttribute(a) || '').toLowerCase();
        if (map[v]) e.setAttribute(a, map[v]);
      });
    });
    // Links are blended with "multiply", which turns them black on a dark page.
    if (fam === 'dark') Array.prototype.forEach.call(svg.querySelectorAll('g.link'), function (g) { g.style.mixBlendMode = 'normal'; });
  }
  // Timeline: mermaid draws its axis, guide lines and arrow in the label colour (near-black) and
  // brightens event boxes with a filter (pale yellow). Quiet lines; events a lighter shade of their
  // section (solid, so the guide line behind them doesn't show through the text).
  function mixRgb(rgb, hex, t) {
    var a = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || ''), b = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!a || !b) return '';
    var out = [1, 2, 3].map(function (i) { return Math.round(+a[i] * (1 - t) + parseInt(b[i], 16) * t); });
    return 'rgb(' + out.join(', ') + ')';
  }
  function tuneTimeline(svg) {
    var dark = themeFamily() === 'dark', quiet = cssVar('--ink-4', dark ? '#6c6253' : '#b3a999'), card = cssVar('--card', dark ? '#221d17' : '#fffdf9');
    Array.prototype.forEach.call(svg.querySelectorAll('.lineWrapper line'), function (l) { l.style.stroke = quiet; });
    Array.prototype.forEach.call(svg.querySelectorAll('marker path'), function (p) { p.style.fill = quiet; p.style.stroke = quiet; });
    Array.prototype.forEach.call(svg.querySelectorAll('.eventWrapper'), function (g) {
      g.style.filter = 'none';
      Array.prototype.forEach.call(g.querySelectorAll('.node-bkg'), function (b) { var f = mixRgb(getComputedStyle(b).fill, card, 0.5); if (f) b.style.fill = f; });
    });
  }
  function mermaidFail(n) {
    n.classList.remove('mermaid-drawn');
    n.classList.add('mermaid-failed');
    n.textContent = n.getAttribute('data-src') || n.textContent;
  }
  function isErrorSvg(n) {
    return !!n.querySelector('svg[aria-roledescription="error"], .error-icon') || /Syntax error in text/.test(n.textContent || '');
  }
  function diagramExpand(n) {
    if (n.querySelector('.diagram-expand')) return;
    var b = el('button', 'diagram-expand'); b.type = 'button';
    b.setAttribute('aria-label', 'Expand diagram'); b.title = 'Expand';
    b.addEventListener('click', function () {
      var svg = n.querySelector('svg'); if (!svg) return;
      var ov = el('div', 'table-overlay diagram-overlay'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Diagram');
      var bar = el('div', 'to-bar'); var close = el('button', 'btn sm', 'Close'); close.type = 'button';
      bar.appendChild(el('span', 'to-title', 'Diagram')); bar.appendChild(close);
      var body = el('div', 'to-body diagram-canvas'); var copy = svg.cloneNode(true);
      copy.removeAttribute('style'); copy.style.maxWidth = 'none';
      body.appendChild(copy); ov.appendChild(bar); ov.appendChild(body); document.body.appendChild(ov);
      var done = function () { ov.remove(); document.removeEventListener('keydown', onKey); b.focus(); };
      var onKey = function (e) { if (e.key === 'Escape') done(); };
      document.addEventListener('keydown', onKey);
      close.addEventListener('click', done);
      close.focus();
    });
    n.appendChild(b);
  }
  function turnFlow(src) { return src.replace(/^(\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph))[ \t]+(LR|RL)\b/, '$1 TD'); }
  // Width of the drawing area inside a diagram frame (the frame minus its padding).
  function frameWidth(n) {
    var cs = getComputedStyle(n);
    return (n.clientWidth || 0) - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  }
  // The size mermaid drew a diagram at. Charts with useMaxWidth have width="100%" and their real
  // width in max-width / the viewBox; reading parseFloat("100%") as 100px hid every wide chart.
  function naturalWidth(svg) {
    if (!svg) return 0;
    var wa = svg.getAttribute('width') || '';
    var w = /%\s*$/.test(wa) ? 0 : parseFloat(wa);
    if (!w) { var mw = /max-width:\s*([\d.]+)px/.exec(svg.getAttribute('style') || ''); w = mw ? parseFloat(mw[1]) : 0; }
    if (!w && svg.viewBox && svg.viewBox.baseVal) w = svg.viewBox.baseVal.width || 0;
    return w;
  }
  function mermaidRun(root) {
    var nodes = Array.prototype.slice.call(root.querySelectorAll('.mermaid:not([data-done])'));
    if (!nodes.length) return;
    var go = function () {
      var m = window.mermaid;
      try { var avail = 0; nodes.forEach(function (n) { avail = Math.max(avail, frameWidth(n)); }); m.initialize(mermaidConfig(avail)); } catch (e) { nodes.forEach(mermaidFail); return; }
      nodes.forEach(function (n) { n.setAttribute('data-done', '1'); });
      // On a phone a left-to-right flowchart is drawn top-to-bottom instead, so it fits the
      // screen. View time only: data-src (what's stored, and what a failure shows) is unchanged.
      var narrow = (root.clientWidth || innerWidth) < 600;
      Promise.all(nodes.map(function (n) {
        var src = n.getAttribute('data-src') || '';
        if (narrow) {
          var turned = turnFlow(src);
          if (turned !== src) { n.textContent = turned; n.setAttribute('data-turned', '1'); src = turned; }
        }
        return Promise.resolve().then(function () { return m.parse(src, { suppressErrors: true }); })
          .then(function (ok) { if (!ok) { mermaidFail(n); return null; } return n; }, function () { mermaidFail(n); return null; });
      })).then(function (parsed) {
        var good = parsed.filter(Boolean);
        if (!good.length) return;
        var draw = function (list) { return Promise.resolve(m.run({ nodes: list, suppressErrors: true })).catch(function () { /* checked below */ }); };
        var natural = function (n) { return naturalWidth(n.querySelector('svg')); };
        return draw(good).then(function () {
          // A left-to-right flowchart that doesn't fit the column (it would shrink below 80%) is
          // redrawn top-to-bottom, at any screen width. View time only; data-src is unchanged.
          var retry = good.filter(function (n) {
            if (n.getAttribute('data-turned') || !n.querySelector('svg') || isErrorSvg(n)) return false;
            var w = natural(n); if (!w || !n.clientWidth || w <= n.clientWidth / 0.8) return false;
            var src = n.getAttribute('data-src') || '', turned = turnFlow(src);
            if (turned === src) return false;
            n.removeAttribute('data-processed'); n.textContent = turned; n.setAttribute('data-turned', '1');
            return true;
          });
          return retry.length ? draw(retry) : null;
        }).then(function () {
          good.forEach(function (n) {
            if (!n.querySelector('svg') || isErrorSvg(n)) { mermaidFail(n); return; }
            n.classList.add('mermaid-drawn');
            // The svg sits in its own scroller so the Expand button stays put. A diagram that would
            // still shrink below ~65% of its drawn size keeps its size and scrolls sideways inside
            // its frame (the page never does); Expand shows it whole.
            var svg = n.querySelector('svg'), w = natural(n), kind = svg.getAttribute('aria-roledescription') || '';
            if (kind === 'sankey') recolorSankey(svg);
            if (kind === 'timeline') tuneTimeline(svg);
            var sc = el('div', 'diagram-scroll'); n.insertBefore(sc, svg); sc.appendChild(svg);
            if (w && n.clientWidth && w > n.clientWidth / 0.65) {
              n.classList.add('diagram-wide');
              // A chart drawn with width="100%" would still shrink to the frame: pin its drawn size.
              if (/%\s*$/.test(svg.getAttribute('width') || '')) svg.style.width = Math.ceil(w) + 'px';
              // A mindmap grows from its centre: start the frame there, not at the left edge.
              if (kind === 'mindmap') sc.scrollLeft = Math.max(0, (sc.scrollWidth - sc.clientWidth) / 2);
            }
            diagramExpand(n);
          });
        });
      }).catch(function () { nodes.forEach(function (n) { if (!n.classList.contains('mermaid-drawn')) mermaidFail(n); }); });
    };
    if (window.mermaid) return go();
    if (!mermaidLoading) {
      mermaidLoading = new Promise(function (resolve) {
        var s = document.createElement('script');
        s.src = MERMAID_SRC;
        s.onload = resolve; s.onerror = resolve;
        document.head.appendChild(s);
      });
    }
    mermaidLoading.then(function () { if (window.mermaid) go(); else nodes.forEach(mermaidFail); });
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
      acceptNode: function (n) { return n.parentElement.closest('code, pre, a, abbr, h1, h2, h3, h4, .md-badge, th, .md-term, .md-glossary') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
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

  // Motion, only under html.motion-ok (PREFS_BOOT in api/_lib/ui.js sets it when the reader's Motion
  // switch is on, the OS doesn't ask for reduced motion and IntersectionObserver exists; app.js keeps
  // it current). Top-level blocks that start below the screen rise 8px and fade in over 220ms as
  // they arrive; lists and card grids bring their first 8 children in 35ms apart. A block already on
  // screen when the page opens (or next to a #link target) is never hidden, nothing is hidden without
  // JS, print shows everything, and the classes go once a block has arrived.
  var RV_MS = 220, RV_STEP = 35, RV_MAX = 8, revealIO = null, revealRoot = null;
  function motionOn() { return document.documentElement.classList.contains('motion-ok') && 'IntersectionObserver' in window; }
  function staggerKids(c) {
    if (/^(UL|OL)$/.test(c.tagName) || /(^|\s)md-(stats|cards|compare)(\s|$)/.test(c.className)) return kids(c);
    var tl = c.classList.contains('md-steps-block') && c.querySelector('.md-timeline');
    return tl ? kids(tl) : null;
  }
  function hashTarget() {
    var h = location.hash.slice(1);
    if (!h) return null;
    var id;
    try { id = decodeURIComponent(h); } catch (e) { id = h; /* malformed escape: use it as written */ }
    return document.getElementById(id);
  }
  function settle(c) {
    c.classList.remove('rv', 'rv-group', 'rv-in');
    Array.prototype.forEach.call(c.querySelectorAll('.rv-k'), function (k) { k.classList.remove('rv-k'); k.style.removeProperty('--rv-d'); });
  }
  function arrive(c) {
    var n = c.classList.contains('rv-group') ? Math.min(c.querySelectorAll('.rv-k').length, RV_MAX) : 1;
    c.classList.add('rv-in');
    Array.prototype.forEach.call(c.querySelectorAll('.md-stat .v'), countUp);
    setTimeout(function () { settle(c); }, RV_MS + Math.max(0, n - 1) * RV_STEP + 80);
  }
  function motion(root) {
    if (revealIO) { revealIO.disconnect(); revealIO = null; }
    if (!motionOn()) return;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var target = hashTarget(), near = target && root.contains(target) ? target.getBoundingClientRect().top : null;
    revealIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { revealIO.unobserve(e.target); arrive(e.target); } });
    }, { rootMargin: '0px 0px -6% 0px' });
    revealRoot = root;
    // Measure every block first, then mark: interleaving reads and class writes would restyle the
    // page once per block on a long document.
    var blocks = kids(root), rects = blocks.map(function (c) { return c.getBoundingClientRect(); });
    blocks.forEach(function (c, i) {
      var r = rects[i];
      var onScreen = (r.bottom > 0 && r.top < vh) || (near !== null && r.bottom > near - vh && r.top < near + vh);
      if (onScreen) { Array.prototype.forEach.call(c.querySelectorAll('.md-stat .v'), countUp); return; }
      var group = staggerKids(c);
      if (group && group.length) {
        c.classList.add('rv-group');
        group.forEach(function (k, j) { k.classList.add('rv-k'); k.style.setProperty('--rv-d', Math.min(j, RV_MAX - 1) * RV_STEP + 'ms'); });
      } else {
        c.classList.add('rv');
      }
      revealIO.observe(c);
    });
  }

  // :::stats count-up: once, when the card is first on screen, 600ms ease-out from 0. Only a value
  // with exactly one number animates ("$140.6M", "+1,252%", "25,000", "1.2万", "3x"); a year, a
  // "Q3"-style label, a range or a date stays still. It ends on the original text, exactly, and
  // stops at once if motion is switched off or the page is printed.
  var COUNT_MS = 600, counting = [];
  function countable(text) {
    var m = /^(\D*?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\D*)$/.exec(text);
    if (!m || /[A-Za-z]$/.test(m[1])) return null;
    if (!m[3] && /^(1[5-9]|2[01])\d\d$/.test(m[2])) return null;
    var target = parseFloat(m[2].replace(/,/g, '') + (m[3] || ''));
    return target > 0 ? { pre: m[1], post: m[4], target: target, decimals: m[3] ? m[3].length - 1 : 0, comma: m[2].indexOf(',') > -1 } : null;
  }
  function countUp(v) {
    if (!v || v.getAttribute('data-counted') || !motionOn()) return;
    v.setAttribute('data-counted', '1');
    var text = v.textContent, c = countable(text);
    if (!c) return;
    var job = { v: v, text: text }, t0 = null;
    function fmt(x) {
      var s = x.toFixed(c.decimals);
      if (c.comma) { var p = s.split('.'); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = p.join('.'); }
      return c.pre + s + c.post;
    }
    function end() { v.textContent = text; var i = counting.indexOf(job); if (i >= 0) counting.splice(i, 1); }
    function step(ts) {
      if (job.stop || !motionOn()) { end(); return; }
      if (t0 === null) t0 = ts;
      var k = Math.min(1, (ts - t0) / COUNT_MS);
      if (k >= 1) { end(); return; }
      v.textContent = fmt(c.target * (1 - Math.pow(1 - k, 3)));
      requestAnimationFrame(step);
    }
    counting.push(job);
    v.textContent = fmt(0);
    requestAnimationFrame(step);
  }
  window.addEventListener('beforeprint', function () { counting.slice().forEach(function (j) { j.stop = true; j.v.textContent = j.text; }); });

  function isCjk(root) {
    var s = (root.textContent || '').slice(0, 4000), n = 0;
    for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); if (c >= 0x3400 && c <= 0x9fff) n++; }
    return n > 60 && n / Math.max(1, s.replace(/\s/g, '').length) > 0.2;
  }

  // :::steps reveal — show step 1, then one more per "Next step (2/N)"; "Show all" opens the rest.
  // Hidden steps use a screen-only class: printing (and the no-JS page) shows every step. The step
  // that appears animates only when the page allows motion (html.motion-ok; never with reduced
  // motion). Focus stays on Next, and moves to the last step when the controls go away.
  var revealSeq = 0;
  function stepReveal(root, zh, prefix) {
    root.querySelectorAll('.md-steps-block[data-reveal]').forEach(function (block) {
      var list = block.querySelector('ol.md-timeline, ol.md-steps'), items = list ? kids(list) : [];
      if (items.length < 2 || block.querySelector('.md-reveal-bar')) return;
      var shown = 1, n = items.length;
      list.id = list.id || (prefix || '') + 'md-steps-' + (++revealSeq);
      list.setAttribute('aria-live', 'polite');
      block.classList.add('md-reveal');
      items.forEach(function (li, i) { if (i > 0) li.classList.add('md-step-hidden'); });
      var bar = el('div', 'md-reveal-bar');
      var next = el('button', 'btn sm md-reveal-next'); next.type = 'button'; next.setAttribute('aria-controls', list.id);
      var all = el('button', 'linkish md-reveal-all', zh ? '全部展开' : 'Show all'); all.type = 'button'; all.setAttribute('aria-controls', list.id);
      var label = function () { next.textContent = (zh ? '下一步 (' : 'Next step (') + (shown + 1) + '/' + n + ')'; };
      var show = function (li) { li.classList.remove('md-step-hidden'); li.classList.add('md-step-in'); };
      var finish = function (focusTo) {
        bar.remove(); block.classList.add('md-revealed');
        if (focusTo) { focusTo.tabIndex = -1; focusTo.focus({ preventScroll: true }); }
      };
      next.addEventListener('click', function () {
        show(items[shown]); shown++;
        if (shown >= n) finish(items[n - 1]); else label();
      });
      all.addEventListener('click', function () {
        var first = items[shown];
        for (; shown < n; shown++) show(items[shown]);
        finish(first);
      });
      label();
      bar.appendChild(next); bar.appendChild(all);
      block.appendChild(bar);
    });
  }

  function enhance(root, opts) {
    opts = opts || {};
    if (termPop && !termPop.term.isConnected) closeTermPop(false);
    buildDirectives(root);
    callouts(root);
    subheads(root);
    summaryCard(root);
    recapCard(root);
    glossary(root);
    listRules(root);
    tables(root, opts.meta);
    codeBlocks(root, opts);
    links(root);
    if (opts.gloss) glosses(root);
    headings(root, opts);
    var zh = isCjk(root);
    if (zh) root.classList.add('cjk');
    stepReveal(root, zh, opts.idPrefix);
    mermaidRun(root);
    if (opts.motion) motion(root);
  }

  function render(md, target, opts) {
    opts = opts || {};
    if (revealIO && target === revealRoot) { revealIO.disconnect(); revealIO = null; }
    var out = toHtml(md);
    if (termPop && target.contains(termPop.term)) closeTermPop(false);
    target.innerHTML = out.html;
    if (opts.classic) return out.meta;
    enhance(target, Object.assign({ meta: out.meta }, opts));
    return out.meta;
  }

  window.MDShareRender = { render: render, toHtml: toHtml, enhance: enhance, splitFrontmatter: splitFrontmatter, rerunMermaid: mermaidRun };
})();
