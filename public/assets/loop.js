/* mdshare reading loop (owner pages only; api/render.js loads this only when the owner views a
 * document). Three jobs, none of which touch the rendered document in #content:
 *  1. Read receipts: one beacon on open, then scroll depth + active seconds every 30 s and when
 *     the page is hidden. POST /api/doc?action=read.
 *  2. Feedback: select text in the document -> a small bar (Example / Unclear / Wrong / Expand /
 *     Note). The quote, the nearest heading and a little surrounding text go to
 *     POST /api/doc?action=feedback, where the agent that wrote the document picks it up.
 *     A "Feedback" pill lists this document's feedback and its status.
 *  3. Versions: the server renders the version line / banner; this adds the "What changed" diff.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var D = window.MDShareState || {};
  if (D.view !== 'doc' || !D.authed || !D.id) return;
  var content = $('content');
  var zh = ((D.content || '').match(/[\u3400-\u9fff]/g) || []).length > 30;
  var T = zh
    ? { example: '举个例子', unclear: '没看懂', wrong: '这里不对', expand: '展开讲', note: '写一句…', sent: '已记下，Kit 会处理', fail: '没发出去：', notePh: '想让 Kit 怎么改？', send: '发送', cancel: '取消', fb: '反馈', none: '还没有反馈。选中文字就能反馈。', open: '待处理', resolved: '已处理', dismissed: '已忽略', inVer: '新版', diffTitle: '和上一版相比', same: '两版内容一样。', loading: '加载中…', close: '关闭' }
    : { example: 'Example', unclear: 'Unclear', wrong: 'Wrong', expand: 'Expand', note: 'Note…', sent: 'Sent to the author', fail: 'Not sent: ', notePh: 'What should change?', send: 'Send', cancel: 'Cancel', fb: 'Feedback', none: 'No feedback yet. Select text to leave some.', open: 'Open', resolved: 'Resolved', dismissed: 'Dismissed', inVer: 'new version', diffTitle: 'Changes from the previous version', same: 'Both versions are identical.', loading: 'Loading…', close: 'Close' };
  var KINDS = ['example', 'unclear', 'wrong', 'expand', 'note'];
  function toast(m, err) { if (window.MDShareToast) window.MDShareToast(m, err); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  async function post(action, body) {
    var r = await fetch('/api/doc?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
    var j = r.status === 204 ? {} : await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------- 1. Read receipts ----------
  var maxScroll = 0, active = 0, sentActive = 0, sentScroll = -1, lastInput = Date.now();
  function scrollPct() {
    var el = content || document.body, r = el.getBoundingClientRect();
    var total = Math.max(1, r.height - innerHeight * 0.5);
    var seen = Math.min(r.height, innerHeight - r.top);
    return Math.max(0, Math.min(100, Math.round(seen / total * 100)));
  }
  function beacon(open) {
    var body = { id: D.id, scroll: maxScroll, seconds: active - sentActive, open: !!open };
    if (!open && body.seconds <= 0 && maxScroll === sentScroll) return;
    sentActive = active; sentScroll = maxScroll;
    var data = JSON.stringify(body);
    if (!open && navigator.sendBeacon && navigator.sendBeacon('/api/doc?action=read', new Blob([data], { type: 'application/json' }))) return;
    fetch('/api/doc?action=read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: data, keepalive: true }).catch(function () { /* best effort */ });
  }
  ['scroll', 'keydown', 'pointerdown', 'pointermove', 'touchstart', 'wheel'].forEach(function (ev) {
    addEventListener(ev, function () { lastInput = Date.now(); }, { passive: true });
  });
  addEventListener('scroll', function () { maxScroll = Math.max(maxScroll, scrollPct()); }, { passive: true });
  var tick = setInterval(function () {
    if (document.visibilityState === 'visible' && Date.now() - lastInput < 60000) active++;
  }, 1000);
  var flush = setInterval(function () { beacon(false); }, 30000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') beacon(false); });
  addEventListener('pagehide', function () { beacon(false); clearInterval(tick); clearInterval(flush); });
  setTimeout(function () { maxScroll = Math.max(maxScroll, scrollPct()); beacon(true); }, 400);

  // ---------- 2. Feedback ----------
  var bar = document.createElement('div');
  bar.className = 'fb-bar'; bar.id = 'fb-bar'; bar.hidden = true; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', T.fb);
  bar.innerHTML = KINDS.map(function (k) { return '<button type="button" data-kind="' + k + '">' + esc(T[k]) + '</button>'; }).join('') +
    '<form class="fb-note" hidden><textarea rows="3" maxlength="2000" placeholder="' + esc(T.notePh) + '"></textarea><div><button type="button" data-act="cancel">' + esc(T.cancel) + '</button><button type="submit" class="primary">' + esc(T.send) + '</button></div></form>';
  document.body.appendChild(bar);
  var pending = null; // {quote, context, kind}

  function headingText(h) {
    var c = h.cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.anchor'), function (a) { a.remove(); });
    return c.textContent.trim();
  }
  function selectionInfo() {
    var sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !content) return null;
    var range = sel.getRangeAt(0);
    if (!content.contains(range.commonAncestorContainer)) return null;
    var quote = sel.toString().replace(/\s+/g, ' ').trim();
    if (quote.length < 2) return null;
    var full = (content.textContent || '').replace(/\s+/g, ' ');
    var at = full.indexOf(quote.slice(0, 80));
    var heading = '';
    var node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var hs = content.querySelectorAll('h1, h2, h3, h4');
    for (var i = 0; i < hs.length; i++) {
      if (hs[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || hs[i].contains(node)) heading = headingText(hs[i]);
    }
    return {
      quote: quote.slice(0, 1000), rect: range.getBoundingClientRect(),
      context: { heading: heading.slice(0, 200), before: at > 0 ? full.slice(Math.max(0, at - 120), at).trim() : '', after: at >= 0 ? full.slice(at + quote.length, at + quote.length + 120).trim() : '' },
    };
  }
  function place(rect) {
    bar.hidden = false;
    var w = bar.offsetWidth, h = bar.offsetHeight;
    var left = Math.max(8, Math.min(innerWidth - w - 8, rect.left + rect.width / 2 - w / 2));
    var top = rect.top - h - 10;
    if (top < 8) top = rect.bottom + 10;
    bar.style.left = Math.round(left) + 'px';
    bar.style.top = Math.round(Math.min(innerHeight - h - 8, top)) + 'px';
  }
  function hideBar() { bar.hidden = true; bar.querySelector('.fb-note').hidden = true; bar.classList.remove('noting'); }
  var selTimer;
  function onSelect() {
    clearTimeout(selTimer);
    selTimer = setTimeout(function () {
      if (bar.classList.contains('noting')) return;
      var info = selectionInfo();
      if (!info) { hideBar(); pending = null; return; }
      pending = info; place(info.rect);
    }, 120);
  }
  document.addEventListener('selectionchange', onSelect);
  addEventListener('scroll', function () { if (!bar.hidden && !bar.classList.contains('noting')) hideBar(); }, { passive: true });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !bar.hidden) hideBar(); });

  async function send(kind, note) {
    if (!pending) return;
    var body = { id: D.id, kind: kind, quote: pending.quote, note: note || null, context: pending.context };
    hideBar();
    try {
      await post('feedback', body);
      toast(T.sent);
      pending = null;
      var s = getSelection(); if (s) s.removeAllRanges();
      loadFeedback();
    } catch (e) { toast(T.fail + e.message, true); }
  }
  bar.addEventListener('mousedown', function (e) { if (!e.target.closest('textarea')) e.preventDefault(); }); // keep the selection
  bar.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.getAttribute('data-act') === 'cancel') { hideBar(); return; }
    var k = b.getAttribute('data-kind'); if (!k) return;
    if (k === 'note') {
      bar.classList.add('noting'); var f = bar.querySelector('.fb-note'); f.hidden = false;
      place(pending ? pending.rect : bar.getBoundingClientRect()); f.querySelector('textarea').focus(); return;
    }
    send(k, null);
  });
  bar.querySelector('.fb-note').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = this.querySelector('textarea').value.trim(); if (!v) return;
    this.querySelector('textarea').value = '';
    send('note', v);
  });

  // Feedback pill + panel.
  var pill = document.createElement('button');
  pill.type = 'button'; pill.className = 'fb-pill'; pill.id = 'fb-pill'; pill.hidden = true;
  var panel = document.createElement('div');
  panel.className = 'fb-panel'; panel.id = 'fb-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', T.fb);
  document.body.appendChild(pill); document.body.appendChild(panel);
  pill.addEventListener('click', function () { panel.hidden = !panel.hidden; });
  document.addEventListener('click', function (e) { if (!panel.hidden && !panel.contains(e.target) && e.target !== pill) panel.hidden = true; });
  async function loadFeedback() {
    try {
      var r = await fetch('/api/doc?action=feedback&id=' + encodeURIComponent(D.id), { credentials: 'same-origin' });
      if (!r.ok) return;
      var items = (await r.json()).items || [];
      var open = items.filter(function (f) { return f.status === 'open'; }).length;
      pill.hidden = items.length === 0;
      pill.textContent = T.fb + (open ? ' · ' + open + ' ' + T.open : ' · ' + items.length);
      pill.classList.toggle('has-open', open > 0);
      panel.innerHTML = items.length ? items.map(function (f) {
        return '<div class="fb-item" data-status="' + esc(f.status) + '"><div class="fb-head"><b>' + esc(T[f.kind] || f.kind) + '</b><span class="fb-status">' + esc(T[f.status] || f.status) +
          (f.resolved_in ? ' · <a href="/v/' + esc(f.resolved_in) + '">' + esc(T.inVer) + '</a>' : '') + '</span></div>' +
          (f.quote ? '<blockquote>' + esc(f.quote) + '</blockquote>' : '') + (f.note ? '<p>' + esc(f.note) + '</p>' : '') + '</div>';
      }).join('') : '<div class="fb-empty">' + esc(T.none) + '</div>';
    } catch (e) { /* the panel is optional */ }
  }
  loadFeedback();

  // ---------- 3. What changed (version diff) ----------
  function lines(s) { return String(s || '').replace(/\r/g, '').split('\n'); }
  // Line-level LCS diff; falls back to a plain before/after when the documents are very long.
  function diff(a, b) {
    var n = a.length, m = b.length;
    if (n * m > 4e6) return a.map(function (l) { return ['-', l]; }).concat(b.map(function (l) { return ['+', l]; }));
    var dp = []; for (var i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
    for (i = n - 1; i >= 0; i--) for (var j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    var out = []; i = 0; j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', a[i]]); i++; } else { out.push(['+', b[j]]); j++; }
    }
    while (i < n) out.push(['-', a[i++]]);
    while (j < m) out.push(['+', b[j++]]);
    return out;
  }
  function diffHtml(ops) {
    if (!ops.some(function (o) { return o[0] !== ' '; })) return '<p class="fb-empty">' + esc(T.same) + '</p>';
    var keep = ops.map(function () { return false; });
    ops.forEach(function (o, k) { if (o[0] !== ' ') for (var d = -2; d <= 2; d++) if (ops[k + d]) keep[k + d] = true; });
    var html = '', gap = false;
    ops.forEach(function (o, k) {
      if (!keep[k]) { if (!gap) { html += '<div class="d-gap">⋯</div>'; gap = true; } return; }
      gap = false;
      html += '<div class="d-' + (o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : 'ctx') + '"><span>' + (o[0] === ' ' ? '' : o[0]) + '</span>' + (esc(o[1]) || '&nbsp;') + '</div>';
    });
    return html;
  }
  var diffBtn = $('btn-diff');
  if (diffBtn && D.parentId) diffBtn.addEventListener('click', async function () {
    var ov = document.createElement('div');
    ov.className = 'table-overlay diff-overlay'; ov.id = 'diff-overlay'; ov.setAttribute('role', 'dialog');
    ov.innerHTML = '<div class="to-bar"><span class="to-title">' + esc(T.diffTitle) + '</span><button class="btn sm" type="button" data-act="close">' + esc(T.close) + '</button></div><div class="to-body"><div class="diff" id="diff-body">' + esc(T.loading) + '</div></div>';
    document.body.appendChild(ov);
    function close() { ov.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target.closest('[data-act="close"]')) close(); });
    try {
      var r = await fetch('/api/share?id=' + encodeURIComponent(D.parentId), { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      $('diff-body').innerHTML = diffHtml(diff(lines(await r.text()), lines(D.content)));
    } catch (e) { $('diff-body').textContent = T.fail + e.message; }
  });

  window.MDShareLoop = { diff: diff, beacon: beacon };
})();
