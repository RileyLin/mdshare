/* mdshare page behaviour: reading preferences, popovers, share/keep, edit, delete, TOC/progress.
 * Server pages embed their state in <script type="application/json" id="mdshare-data">. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  var dataEl = $('mdshare-data');
  var D = dataEl ? JSON.parse(dataEl.textContent) : {};
  window.MDShareState = D;

  // ---------- Toast ----------
  var toastTimer;
  function toast(msg, err) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  window.MDShareToast = toast;

  // ---------- Preferences ----------
  // Reading preferences live in localStorage on this device. PREFS_BOOT (api/_lib/ui.js) puts them
  // on <html> before first paint: data-theme, --zoom, data-width, data-font, data-leading,
  // data-motion="off" and the class motion-ok. This keeps them in step when they change. The Aa menu
  // and Settings → Reading (library.js) use the same control ids, so every page follows either.
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };
  // name: [key, default, allowed values]. The defaults are the reading experience before any choice.
  var PREFS = {
    theme: ['mdshare-theme', 'system', ['system', 'light', 'paper', 'dark']],
    width: ['mdshare-width', 'standard', ['standard', 'wide']],
    font: ['mdshare-font', 'sans', ['sans', 'serif']],
    tables: ['mdshare-tables', 'auto', ['auto', 'table', 'cards']],
    leading: ['mdshare-leading', 'comfortable', ['compact', 'comfortable', 'loose']],
    motion: ['mdshare-motion', 'on', ['on', 'off']],
    gloss: ['mdshare-gloss', 'off', ['on', 'off']],
  };
  function pref(name) { var p = PREFS[name], v = store.get(p[0]); return p[2].indexOf(v) >= 0 ? v : p[1]; }
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  var reducedMq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  function themePref() { return pref('theme'); }
  var themeColors = Array.prototype.map.call(document.querySelectorAll('meta[name="theme-color"]'), function (m) { return [m, m.getAttribute('content')]; });
  function applyTheme() {
    var p = themePref(), t = p === 'system' ? (mq && mq.matches ? 'dark' : 'light') : p;
    var changed = root.getAttribute('data-theme') !== t;
    root.setAttribute('data-theme', t);
    setSeg('theme-seg', p);
    // The browser (and Telegram) toolbar follows an explicit choice; System keeps the <head> pair.
    var bg = p === 'system' ? '' : getComputedStyle(root).getPropertyValue('--paper').trim();
    themeColors.forEach(function (x) { x[0].setAttribute('content', bg || x[1]); });
    if (changed && window.MDShareRender && $('content')) rerender();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (themePref() === 'system') applyTheme(); });
  // Motion is on unless the reader switched it off or the OS asks for reduced motion (that always
  // wins). motion-ok is what render.js checks before hiding anything for a reveal.
  function motionAllowed() { return pref('motion') === 'on' && !(reducedMq && reducedMq.matches) && 'IntersectionObserver' in window; }
  function applyMotion() {
    root.classList.toggle('motion-ok', motionAllowed());
    if (pref('motion') === 'off') root.setAttribute('data-motion', 'off'); else root.removeAttribute('data-motion');
    var reduced = !!(reducedMq && reducedMq.matches), sw = $('motion-toggle'), note = $('motion-note');
    if (sw) { sw.checked = pref('motion') === 'on' && !reduced; sw.disabled = reduced; }
    if (note) {
      if (!note.hasAttribute('data-text')) note.setAttribute('data-text', note.textContent);
      note.textContent = reduced ? 'Off: this device asks for reduced motion' : note.getAttribute('data-text');
    }
  }
  if (reducedMq && reducedMq.addEventListener) reducedMq.addEventListener('change', applyMotion);
  // A visible switch (theme, Table/Cards, tabs) cross-fades with the View Transitions API when motion
  // is on and the browser has it, otherwise it happens at once. The browser still runs `change`
  // when it skips a transition (another one started, the tab is hidden); it then rejects `ready`,
  // which is expected and needs no handling beyond that.
  function withTransition(change) {
    if (!document.startViewTransition || !root.classList.contains('motion-ok')) { change(); return; }
    var t = document.startViewTransition(change);
    if (t && t.ready) t.ready.catch(function () { /* skipped: the change itself still ran */ });
  }
  window.MDShareMotion = { transition: withTransition, on: function () { return root.classList.contains('motion-ok'); } };
  function zoom() { var z = parseFloat(store.get('mdshare-zoom')); return z >= 0.85 && z <= 1.6 ? z : 1; }
  function setZoom(z) {
    z = Math.min(1.6, Math.max(0.85, Math.round(z * 100) / 100));
    store.set('mdshare-zoom', String(z)); root.style.setProperty('--zoom', z);
    var o = $('zoom-val'); if (o) o.textContent = Math.round(z * 100) + '%';
  }
  function setSeg(id, v) {
    var seg = $(id); if (!seg) return;
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-v') === v ? 'true' : 'false'); });
  }
  // Binding is idempotent (data-bound), so Settings can build its panel and call bind() before or
  // after boot; every call also re-syncs what the controls show.
  function once(el) { if (!el || el.getAttribute('data-bound')) return false; el.setAttribute('data-bound', '1'); return true; }
  function bindSeg(id, name, apply) {
    var seg = $(id); if (!seg) return;
    setSeg(id, pref(name));
    if (!once(seg)) return;
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      store.set(PREFS[name][0], b.getAttribute('data-v')); setSeg(id, b.getAttribute('data-v')); apply(b.getAttribute('data-v'));
    });
  }
  function applyWidth(v) { if (v === 'wide') root.setAttribute('data-width', 'wide'); else root.removeAttribute('data-width'); }
  function applyFont(v) { if (v === 'serif') root.setAttribute('data-font', 'serif'); else root.removeAttribute('data-font'); }
  function applyLeading(v) { if (v === 'compact' || v === 'loose') root.setAttribute('data-leading', v); else root.removeAttribute('data-leading'); }
  function applyTables() {
    Array.prototype.forEach.call(document.querySelectorAll('.table-block[data-view-user]'), function (b) { b.removeAttribute('data-view-user'); });
    if (layoutTables.run) layoutTables.run();
  }
  function bindPrefs() {
    bindSeg('theme-seg', 'theme', function () { withTransition(applyTheme); });
    bindSeg('width-seg', 'width', applyWidth);
    bindSeg('font-seg', 'font', applyFont);
    bindSeg('leading-seg', 'leading', applyLeading);
    bindSeg('tables-seg', 'tables', applyTables);
    var o = $('zoom-val'); if (o) o.textContent = Math.round(zoom() * 100) + '%';
    var zi = $('zoom-in'), zo = $('zoom-out'), zr = $('zoom-reset');
    if (once(zi)) zi.addEventListener('click', function () { setZoom(zoom() + 0.1); });
    if (once(zo)) zo.addEventListener('click', function () { setZoom(zoom() - 0.1); });
    if (once(zr)) zr.addEventListener('click', function () { setZoom(1); });
    var g = $('gloss-toggle');
    if (g) g.checked = pref('gloss') === 'on';
    if (once(g)) g.addEventListener('change', function () { store.set('mdshare-gloss', g.checked ? 'on' : 'off'); rerender(); });
    var m = $('motion-toggle');
    if (once(m)) m.addEventListener('change', function () { store.set('mdshare-motion', m.checked ? 'on' : 'off'); applyMotion(); });
    applyMotion();
  }
  // Settings → Reading → Reset: every reading preference back to its default on this device.
  function resetPrefs() {
    var hadGloss = pref('gloss') === 'on';
    Object.keys(PREFS).forEach(function (n) { store.del(PREFS[n][0]); });
    setZoom(1);
    applyWidth('standard'); applyFont('sans'); applyLeading('comfortable'); applyTables();
    withTransition(applyTheme);
    if (hadGloss) rerender();
    bindPrefs();
  }
  window.MDSharePrefs = { get: pref, bind: bindPrefs, reset: resetPrefs };
  function initPrefs() {
    applyTheme();
    setZoom(zoom());
    bindPrefs();
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || document.body.classList.contains('editing')) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(zoom() + 0.1); }
      else if (e.key === '-') { e.preventDefault(); setZoom(zoom() - 0.1); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    });
  }

  // ---------- Popovers ----------
  var openPop = null;
  function closePop() {
    if (!openPop) return;
    openPop.pop.classList.remove('open');
    openPop.btn.setAttribute('aria-expanded', 'false');
    openPop = null;
  }
  function togglePop(btn, popId) {
    var pop = $(popId); if (!pop) return;
    if (openPop && openPop.pop === pop) return closePop();
    closePop();
    pop.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
    openPop = { pop: pop, btn: btn };
  }
  function bindPop(btnId, popId, alsoBtnId) {
    var b = $(btnId); if (b) b.addEventListener('click', function (e) { e.stopPropagation(); togglePop(b, popId); });
    var b2 = alsoBtnId && $(alsoBtnId); if (b2) b2.addEventListener('click', function (e) { e.stopPropagation(); togglePop(b || b2, popId); });
  }
  document.addEventListener('click', function (e) { if (openPop && !openPop.pop.contains(e.target)) closePop(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });
  window.MDSharePop = { bind: bindPop, close: closePop };

  // ---------- Status, share, keep ----------
  function relExpiry(iso) {
    var ms = new Date(iso) - Date.now();
    if (!(ms > 0)) return 'soon';
    var h = ms / 3600000;
    if (h < 1) return 'in <1h';
    if (h < 48) return 'in ' + Math.round(h) + 'h';
    return 'in ' + Math.round(h / 24) + 'd';
  }
  function fmtDate(iso) { try { return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (e) { return iso; } }
  function autoKeepOn() { return store.get('mdshare-autokeep') !== 'off'; }
  function syncStatus() {
    var pill = $('status-pill'); if (!pill) return;
    pill.classList.toggle('public', !!D.isPublic); pill.classList.toggle('private', !D.isPublic);
    $('status-text').innerHTML = (D.isPublic ? 'Public' : 'Private') + '<span class="long"> · ' + (D.kept ? 'Kept' : 'expires ' + relExpiry(D.expiresAt)) + '</span>';
    pill.title = D.kept ? 'Kept forever' : 'Expires ' + fmtDate(D.expiresAt);
    var pub = $('public-toggle'), keep = $('keep-toggle');
    if (pub) pub.checked = !!D.isPublic;
    if (keep) keep.checked = !!D.kept;
    var sub = $('share-sub'); if (sub) sub.textContent = D.isPublic ? 'Anyone with the link can view it.' : 'Only you can see this. Others get a sign-in page.';
    var ks = $('keep-sub'); if (ks) ks.textContent = D.kept ? 'Never expires.' : ('Expires ' + fmtDate(D.expiresAt) + '.' + (autoKeepOn() ? ' Turns on when you publish.' : ''));
    var lb = $('linkbox'); if (lb) lb.classList.toggle('disabled', !D.isPublic);
  }
  function shareUrl() { return location.origin + location.pathname; }
  async function api(url, opts) {
    var res = await fetch(url, opts);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok && res.status !== 207) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }
  async function setPublic(on) {
    var pub = $('public-toggle'); pub.disabled = true;
    var wantKeep = on && !D.kept && autoKeepOn();
    try {
      var body = await api('/api/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ id: D.id, kind: D.kind, is_public: on }, wantKeep ? { keep: true } : {})) });
      D.isPublic = on;
      if (body.kept) { D.kept = true; if (body.expires_at) D.expiresAt = body.expires_at; }
      toast(on ? (body.kept && wantKeep ? 'Public, and kept forever' : 'Public: anyone with the link can view') : 'Private again: the link now asks for sign-in');
    } catch (e) { toast('Could not update sharing: ' + e.message, true); }
    pub.disabled = false; syncStatus();
  }
  async function setKeep(on) {
    var keep = $('keep-toggle'); keep.disabled = true;
    try {
      var body = await api('/api/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: D.id, type: D.kind, pinned: on }) });
      D.kept = on; if (body.expires_at) D.expiresAt = body.expires_at;
      toast(on ? 'Kept forever' : 'No longer kept: expires ' + fmtDate(D.expiresAt));
    } catch (e) { toast('Could not update: ' + e.message, true); }
    keep.disabled = false; syncStatus();
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); return true; }
    catch (e) {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (x) { /* ignore */ }
      ta.remove(); toast(ok ? okMsg : 'Copy failed: select and copy manually', !ok); return ok;
    }
  }
  function initOwner() {
    if (!$('status-pill')) return;
    bindPop('status-pill', 'share-pop', 'btn-share');
    bindPop('btn-more', 'more-pop');
    var url = $('share-url'); if (url) url.value = shareUrl();
    $('public-toggle').addEventListener('change', function (e) { setPublic(e.target.checked); });
    $('keep-toggle').addEventListener('change', function (e) { setKeep(e.target.checked); });
    syncStatus();
    setInterval(syncStatus, 60000);
    var dl = $('btn-download'); if (dl) dl.addEventListener('click', function () { closePop(); downloadMd(); });
    var pdf = $('btn-pdf'); if (pdf) pdf.addEventListener('click', function () { closePop(); exportPdf(); });
    var cp = $('btn-copy'); if (cp) cp.addEventListener('click', function () { closePop(); copyText(D.content || '', 'Markdown copied'); });
    var del = $('btn-delete'); if (del) del.addEventListener('click', function () { closePop(); deleteItem(); });
    var ed = $('btn-edit'); if (ed) ed.addEventListener('click', enterEdit);
  }
  function initCopyLink() {
    var b = $('btn-copy-link'); if (b) b.addEventListener('click', function () { copyText(shareUrl(), D.isPublic || !D.authed ? 'Link copied' : 'Link copied (private: others will see a sign-in page)'); });
  }
  function fileName() { return ((D.title || ('mdshare-' + D.id)).replace(/[^\p{L}\p{N}_\-. ]/gu, '_').trim() || 'mdshare') + '.md'; }
  function downloadMd() {
    var blob = new Blob([D.content || ''], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName();
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportPdf() {
    var t = document.title; document.title = (D.title || 'mdshare');
    window.print(); setTimeout(function () { document.title = t; }, 1000);
  }
  var DELETE_URL = { paste: '/api/share?id=', diagram: '/api/diagram?id=', archify: '/api/archify?id=' };
  async function deleteItem() {
    var what = D.kind === 'paste' ? 'document' : D.kind;
    if (!window.confirm('Delete this ' + what + ' permanently? This cannot be undone.')) return;
    try {
      await api(DELETE_URL[D.kind] + encodeURIComponent(D.id), { method: 'DELETE' });
      toast('Deleted');
      window.location.replace('/dashboard?deleted=1');
    } catch (e) { toast('Delete failed: ' + e.message, true); }
  }

  // ---------- Document rendering, TOC, progress ----------
  var docMeta = {};
  function renderOpts(extra) {
    return Object.assign({ gloss: pref('gloss') === 'on', motion: true }, extra || {});
  }
  // The date line and the phone contents sit right under the title, inside #content. Lift them
  // out before re-rendering so innerHTML doesn't destroy them.
  var chrome = {};
  function stashChrome(c) {
    chrome.meta = chrome.meta || $('doc-meta'); chrome.mob = chrome.mob || $('toc-mobile');
    [chrome.mob, chrome.meta].forEach(function (n) { if (n && c.contains(n)) c.parentNode.insertBefore(n, c); });
  }
  function rerender() {
    var c = $('content'); if (!c || D.content == null) return;
    stashChrome(c);
    var y = window.scrollY;
    docMeta = MDShareRender.render(D.content, c, renderOpts({ motion: false })) || {};
    afterRender(c); window.scrollTo(0, y);
  }
  function renderDoc() {
    var c = $('content'); if (!c || D.content == null || !window.MDShareRender) return;
    stashChrome(c);
    docMeta = MDShareRender.render(D.content, c, renderOpts()) || {};
    afterRender(c);
  }
  function afterRender(c) {
    if (docMeta.accent && docMeta.accent !== 'terracotta') root.setAttribute('data-accent', docMeta.accent); else root.removeAttribute('data-accent');
    if (docMeta.layout === 'wide' && !store.get('mdshare-width')) root.setAttribute('data-width', 'wide');
    var h1 = c.querySelector('h1');
    var crumb = $('crumb-title'); if (crumb && h1) crumb.textContent = h1.textContent;
    if (h1) D.title = h1.textContent.trim();
    var meta = chrome.meta || $('doc-meta');
    if (meta) {
      var txt = c.textContent || '', cjk = (txt.match(/[\u3400-\u9fff]/g) || []).length, words = (txt.replace(/[\u3400-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
      var mins = Math.max(1, Math.round(cjk / 400 + words / 220));
      var parts = [];
      if (D.createdAt) parts.push(new Date(D.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(D.createdAt).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }));
      parts.push(mins + ' min read');
      meta.innerHTML = parts.map(function (p) { return '<span>' + p + '</span>'; }).join('<span class="sep">·</span>');
      if (h1) h1.parentNode.insertBefore(meta, h1.nextSibling);
      var mob = chrome.mob || $('toc-mobile'); if (mob && meta.parentNode) meta.parentNode.insertBefore(mob, meta.nextSibling);
    }
    buildToc(c);
    layoutTables(c);
  }

  // ---------- Tables: widen, scroll, cards, expand, copy ----------
  // render.js measured each table (data-ideal in cell-em, data-cols, text-heavy, data-pref).
  // Here we use the real page: widen a table into free space beside the column, decide Table vs
  // Cards, and add a small toolbar. Reader choices win over the author's; nothing is persisted per
  // table, the Aa setting is.
  var tableSeq = 0;
  function tablePref() { return pref('tables'); }
  function cellPx(wrap) {
    var t = wrap.querySelector('table'); if (!t) return 15;
    return parseFloat(getComputedStyle(t).fontSize) || 15;
  }
  function chooseView(block, wrap, avail) {
    block.removeAttribute('data-auto');
    if (block.getAttribute('data-view-user')) return block.getAttribute('data-view-user');
    var g = tablePref(); if (g !== 'auto') return g;
    var author = block.getAttribute('data-pref'); if (author) return author;
    block.setAttribute('data-auto', '1');
    var cols = +wrap.getAttribute('data-cols') || 0;
    if (avail < 600 && cols >= 3 && (wrap.classList.contains('text-heavy') || cols >= 4)) return 'cards';
    return 'table';
  }
  function placeTable(block, art) {
    var wrap = block.querySelector('.table-wrap'); if (!wrap) return;
    block.style.marginLeft = block.style.marginRight = '';
    block.classList.remove('is-wide');
    var artBox = art.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    var view = chooseView(block, wrap, artBox.width);
    wrap.setAttribute('data-view', view);
    setPressed(block, view);
    if (view === 'table' && !block.getAttribute('data-nested') && !block.closest('.table-overlay')) {
      var want = (+wrap.getAttribute('data-ideal') || 0) * cellPx(wrap) + 2;
      if (block.getAttribute('data-force-wide')) want = Math.max(want, vw);
      var extra = want - artBox.width;
      if (extra > 24) {
        var toc = $('toc'), side = toc && getComputedStyle(toc).display !== 'none';
        var gutter = Math.max(16, Math.min(40, vw * 0.03));
        var right = Math.max(0, vw - artBox.right - gutter), left = side ? 0 : Math.max(0, artBox.left - gutter);
        var cap = Math.max(0, 1600 - artBox.width);
        extra = Math.min(extra, cap, side ? right : left + right);
        if (extra > 24) {
          var r = side ? extra : Math.min(right, extra / 2 + Math.max(0, extra / 2 - left));
          var l = side ? 0 : extra - r;
          block.style.marginRight = -Math.round(r) + 'px';
          block.style.marginLeft = -Math.round(l) + 'px';
          block.classList.add('is-wide');
        }
      }
    }
    var scrolls = view === 'table' && wrap.scrollWidth > wrap.clientWidth + 2;
    // A text-heavy table that still doesn't fit (it would scroll, or some cell needs 5+ lines)
    // reads better as cards. Only when the view was chosen automatically; data tables keep scrolling.
    if (block.getAttribute('data-auto') && wrap.classList.contains('text-heavy') && !wrap.classList.contains('matrix') && !block.closest('.table-overlay') && view === 'table' && (scrolls || maxCellLines(wrap) >= 5)) {
      view = 'cards'; scrolls = false;
      wrap.setAttribute('data-view', view); setPressed(block, view);
      block.style.marginLeft = block.style.marginRight = ''; block.classList.remove('is-wide');
    }
    wrap.classList.toggle('scrolls', scrolls);
    wrap.classList.toggle('at-end', !scrolls || wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2);
  }
  function maxCellLines(wrap) {
    var worst = 0, rg = document.createRange();
    Array.prototype.forEach.call(wrap.querySelectorAll('tbody td'), function (td) {
      rg.selectNodeContents(td);
      var tops = {}, n = 0;
      Array.prototype.forEach.call(rg.getClientRects(), function (r) { var k = Math.round(r.top); if (r.width > 0 && !tops[k]) { tops[k] = 1; n++; } });
      if (n > worst) worst = n;
    });
    return worst;
  }
  function setPressed(block, view) {
    Array.prototype.forEach.call(block.querySelectorAll('.table-tools [data-view]'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false'); });
  }
  function tableTsv(t) {
    return Array.prototype.map.call(t.querySelectorAll('tr'), function (tr) {
      return Array.prototype.map.call(tr.children, function (cell) { return (cell.textContent || '').replace(/[\t\r\n]+/g, ' ').trim(); }).join('\t');
    }).join('\n');
  }
  // Small, simple tables are already easy to read; a toolbar would only be noise.
  function isSmallTable(block, wrap, t) {
    if (block.getAttribute('data-pref') || block.getAttribute('data-force-wide') || wrap.classList.contains('text-heavy')) return false;
    return (+wrap.getAttribute('data-cols') || 0) <= 3 && t.querySelectorAll('tbody tr').length <= 8;
  }
  function addTableTools(block) {
    if (block.querySelector('.table-tools')) return;
    var wrap = block.querySelector('.table-wrap'), t = wrap && wrap.querySelector('table'); if (!t) return;
    if (isSmallTable(block, wrap, t)) return;
    var id = 'tbl-' + (++tableSeq);
    wrap.id = id;
    var bar = document.createElement('div');
    bar.className = 'table-tools';
    bar.innerHTML = '<div class="seg sm" role="group" aria-label="Table view"><button type="button" data-view="table" aria-controls="' + id + '">Table</button><button type="button" data-view="cards" aria-controls="' + id + '">Cards</button></div>' +
      '<button type="button" class="tt-btn" data-act="expand" aria-controls="' + id + '" title="Open full screen">⤢ Expand</button>' +
      '<button type="button" class="tt-btn" data-act="copy" title="Copy for a spreadsheet">Copy</button>';
    var cap = block.querySelector('.table-caption');
    if (cap) { cap.parentNode.insertBefore(bar, cap.nextSibling); block.classList.add('has-caption'); } else block.insertBefore(bar, wrap);
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.getAttribute('data-view')) { block.setAttribute('data-view-user', b.getAttribute('data-view')); placeTable(block, articleOf(block)); return; }
      if (b.getAttribute('data-act') === 'copy') { copyText(tableTsv(t), 'Table copied. Paste it into a spreadsheet.'); return; }
      if (b.getAttribute('data-act') === 'expand') expandTable(block);
    });
    wrap.addEventListener('scroll', function () { wrap.classList.toggle('at-end', wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2); }, { passive: true });
  }
  function articleOf(block) { return block.closest('.prose') || block.parentElement; }
  function expandTable(block) {
    var ph = document.createComment('table'), overlay = document.createElement('div');
    overlay.className = 'table-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Table');
    overlay.innerHTML = '<div class="to-bar"><span class="to-title"></span><button type="button" class="btn sm" data-act="close">Close  Esc</button></div><div class="to-body prose"></div>';
    var cap = block.querySelector('.table-caption'), h = null;
    if (!cap) { var n = block.previousElementSibling; while (n && !/^H[1-4]$/.test(n.tagName)) n = n.previousElementSibling; h = n; }
    var hText = '';
    if (h) { var hc = h.cloneNode(true); Array.prototype.forEach.call(hc.querySelectorAll('.anchor'), function (a) { a.remove(); }); hText = hc.textContent.trim(); }
    overlay.querySelector('.to-title').textContent = cap ? cap.textContent : (hText || 'Table');
    block.parentNode.insertBefore(ph, block);
    overlay.querySelector('.to-body').appendChild(block);
    document.body.appendChild(overlay);
    document.body.classList.add('overlay-open');
    var prev = block.getAttribute('data-view-user');
    block.setAttribute('data-view-user', 'table');
    placeTable(block, overlay.querySelector('.to-body'));
    function close() {
      document.removeEventListener('keydown', onKey);
      if (prev) block.setAttribute('data-view-user', prev); else block.removeAttribute('data-view-user');
      ph.parentNode.insertBefore(block, ph); ph.remove(); overlay.remove();
      document.body.classList.remove('overlay-open');
      placeTable(block, articleOf(block));
      var b = block.querySelector('[data-act="expand"]'); if (b) b.focus();
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay || e.target.closest('[data-act="close"]')) close(); });
    overlay.querySelector('[data-act="close"]').focus();
  }
  var tableRO = null;
  function layoutTables(c) {
    var blocks = Array.prototype.slice.call(c.querySelectorAll('.table-block'));
    if (!blocks.length) return;
    blocks.forEach(function (b) { if (!b.getAttribute('data-nested')) addTableTools(b); });
    var run = function () { blocks.forEach(function (b) { if (b.isConnected && !b.closest('.table-overlay')) placeTable(b, articleOf(b)); }); };
    run();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    if (tableRO) tableRO.disconnect();
    if (window.ResizeObserver) { var pending = 0; tableRO = new ResizeObserver(function () { cancelAnimationFrame(pending); pending = requestAnimationFrame(run); }); tableRO.observe(c); tableRO.observe(document.documentElement); }
    layoutTables.run = run;
  }
  var spy = null;
  function buildToc(c) {
    var side = $('toc'), mob = $('toc-mobile');
    if (!side) return;
    // Headings inside blocks (compare columns, cards, tabs, callouts) are labels, not sections.
    var inBlock = function (h) { return !!h.closest('.md-compare, .md-cards, .md-tabs, .md-callout, .md-summary, .md-steps-block'); };
    var hs = Array.prototype.slice.call(c.querySelectorAll('h2, h3')).filter(function (h) { return !inBlock(h); });
    var h2s = hs.filter(function (h) { return h.tagName === 'H2'; });
    if (h2s.length < 3 && hs.length < 4) hs = hs.concat(Array.prototype.slice.call(c.querySelectorAll('h4.md-sub'))).sort(function (a, b) { return a.compareDocumentPosition(b) & 4 ? -1 : 1; });
    var show = docMeta.toc !== 'false' && (h2s.length >= 3 || (hs.length >= 4 && (c.textContent || '').length > 2500));
    side.hidden = !show; if (mob) mob.hidden = !show;
    if (spy) { spy.disconnect(); spy = null; }
    if (!show) return;
    var html = '';
    hs.forEach(function (h) {
      var label = (h.textContent || '').replace(/^#/, '').trim();
      html += '<a href="#' + h.id + '" class="' + (h.tagName === 'H2' ? 'l2' : 'l3') + '" data-id="' + h.id + '">' + label.replace(/</g, '&lt;') + '</a>';
    });
    side.innerHTML = '<div class="toc-h">Contents</div>' + html;
    if (mob) mob.querySelector('nav').innerHTML = html;
    var links = side.querySelectorAll('a');
    var vis = {};
    spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) { vis[e.target.id] = e.isIntersecting ? e.boundingClientRect.top : undefined; });
      var current = null;
      for (var i = 0; i < hs.length; i++) { if (hs[i].getBoundingClientRect().top < 140) current = hs[i].id; }
      if (!current && hs[0]) current = hs[0].id;
      Array.prototype.forEach.call(links, function (a) { a.classList.toggle('on', a.getAttribute('data-id') === current); });
    }, { rootMargin: '-80px 0px -60% 0px' });
    hs.forEach(function (h) { spy.observe(h); });
  }
  function initProgress() {
    var bar = $('progress'), top = $('to-top');
    if (!bar && !top) return;
    var tick = false;
    function upd() {
      tick = false;
      var max = document.documentElement.scrollHeight - innerHeight;
      var p = max > 0 ? Math.min(1, scrollY / max) : 0;
      if (bar) bar.style.setProperty('--p', p.toFixed(4));
      if (top) top.classList.toggle('show', scrollY > 900);
    }
    addEventListener('scroll', function () { if (!tick) { tick = true; requestAnimationFrame(upd); } }, { passive: true });
    upd();
    if (top) top.addEventListener('click', function () { scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  // ---------- Editing (documents) ----------
  var previewTimer = null;
  function enterEdit() {
    var ta = $('md-editor'); if (!ta) return;
    ta.value = D.content || '';
    MDShareRender.render(ta.value, $('preview-content'), { motion: false, anchors: false, idPrefix: 'pv-' });
    document.body.classList.add('editing');
    ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0;
  }
  function cancelEdit() {
    if ($('md-editor').value !== (D.content || '') && !window.confirm('Discard your changes?')) return;
    document.body.classList.remove('editing');
  }
  async function saveEdit() {
    var btn = $('btn-save-edit'), next = $('md-editor').value;
    if (!next.trim()) { toast('A document can’t be empty', true); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await api('/api/share', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: D.id, content: next }) });
      D.content = next;
      renderDoc();
      document.body.classList.remove('editing');
      toast('Saved');
    } catch (e) { toast('Save failed: ' + e.message, true); }
    btn.disabled = false; btn.textContent = 'Save';
  }
  function initEditor() {
    var ta = $('md-editor'); if (!ta) return;
    ta.addEventListener('input', function () {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(function () { MDShareRender.render(ta.value, $('preview-content'), { motion: false, anchors: false, idPrefix: 'pv-' }); }, 160);
    });
    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveEdit(); }
      else if (e.key === 'Escape') { cancelEdit(); }
      else if (e.key === 'Tab') { e.preventDefault(); var s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    });
    $('btn-cancel').addEventListener('click', cancelEdit);
    $('btn-save-edit').addEventListener('click', saveEdit);
  }

  // ---------- Diagram page ----------
  function initDiagram() {
    var frame = $('svg-frame'); if (!frame || !window.DOMPurify) return;
    var svg = D.svg || '';
    frame.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject'], FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'] });
    var svgEl = frame.querySelector('svg'), rect = svgEl && svgEl.querySelector('rect');
    var fill = rect ? (rect.getAttribute('fill') || '').toLowerCase() : '';
    if (/^(#f|#e|white|#fff)/.test(fill)) frame.classList.add('light-bg');
    var notes = $('content');
    if (notes && D.content) MDShareRender.render(D.content, notes, renderOpts());
  }

  function boot() {
    initPrefs();
    bindPop('btn-aa', 'aa-pop');
    initOwner();
    initCopyLink();
    if (D.view === 'doc') { renderDoc(); initProgress(); initEditor(); }
    if (D.view === 'diagram') initDiagram();
    if (/[?&]deleted=1/.test(location.search)) toast('Deleted');
  }
  window.MDShareApp = { renderDoc: renderDoc, initProgress: initProgress };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
