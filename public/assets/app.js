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
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function themePref() { return store.get('mdshare-theme') || 'system'; }
  function applyTheme() {
    var p = themePref(), t = p === 'system' ? (mq && mq.matches ? 'dark' : 'light') : p;
    var changed = root.getAttribute('data-theme') !== t;
    root.setAttribute('data-theme', t);
    setSeg('theme-seg', p);
    if (changed && window.MDShareRender && $('content')) rerender();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (themePref() === 'system') applyTheme(); });
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
  function bindSeg(id, key, fallback, apply) {
    var seg = $(id); if (!seg) return;
    setSeg(id, store.get(key) || fallback);
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]'); if (!b) return;
      store.set(key, b.getAttribute('data-v')); setSeg(id, b.getAttribute('data-v')); apply(b.getAttribute('data-v'));
    });
  }
  function initPrefs() {
    applyTheme();
    setZoom(zoom());
    bindSeg('theme-seg', 'mdshare-theme', 'system', applyTheme);
    bindSeg('width-seg', 'mdshare-width', 'standard', function (v) { if (v === 'wide') root.setAttribute('data-width', 'wide'); else root.removeAttribute('data-width'); });
    bindSeg('font-seg', 'mdshare-font', 'sans', function (v) { if (v === 'serif') root.setAttribute('data-font', 'serif'); else root.removeAttribute('data-font'); });
    var zi = $('zoom-in'), zo = $('zoom-out'), zr = $('zoom-reset');
    if (zi) zi.addEventListener('click', function () { setZoom(zoom() + 0.1); });
    if (zo) zo.addEventListener('click', function () { setZoom(zoom() - 0.1); });
    if (zr) zr.addEventListener('click', function () { setZoom(1); });
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || document.body.classList.contains('editing')) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); setZoom(zoom() + 0.1); }
      else if (e.key === '-') { e.preventDefault(); setZoom(zoom() - 0.1); }
      else if (e.key === '0') { e.preventDefault(); setZoom(1); }
    });
    var g = $('gloss-toggle');
    if (g) {
      g.checked = store.get('mdshare-gloss') === 'on';
      g.addEventListener('change', function () { store.set('mdshare-gloss', g.checked ? 'on' : 'off'); rerender(); });
    }
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
    return Object.assign({ gloss: store.get('mdshare-gloss') === 'on', motion: true }, extra || {});
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
