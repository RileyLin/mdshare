/* Library (/dashboard) and Settings (/settings). Owner-only pages; every call below is cookie-auth. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var toast = function (m, e) { if (window.MDShareToast) window.MDShareToast(m, e); };
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } } };
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  async function api(url, opts) {
    var res = await fetch(url, opts);
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok && res.status !== 207) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }
  function json(method, body) { return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  function ago(iso) {
    var d = new Date(iso), diff = Date.now() - d;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  }
  function left(iso) {
    var h = (new Date(iso) - Date.now()) / 3600000;
    if (h <= 0) return 'expiring';
    if (h < 1) return '<1h left';
    if (h < 48) return Math.round(h) + 'h left';
    return Math.round(h / 24) + 'd left';
  }
  var HREF = { paste: '/v/', diagram: '/d/', archify: '/a/' };
  var ICON = { paste: '¶', diagram: '◈', archify: '⌗' };
  var KIND_LABEL = { paste: 'Doc', diagram: 'Diagram', archify: 'Archify' };
  var DELETE_URL = { paste: '/api/share?id=', diagram: '/api/diagram?id=', archify: '/api/archify?id=' };

  // ===================== Library =====================
  var items = [], filter = 'all', type = 'any', query = '', selected = new Map();
  function kept(p) { return !!p.pinned || (typeof p.expires_at === 'string' && p.expires_at >= '2099'); }
  function soon(p) { return !kept(p) && (new Date(p.expires_at) - Date.now()) < 48 * 3600000; }
  function matches(p) {
    if (type !== 'any' && p.kind !== type) return false;
    if (filter === 'kept' && !kept(p)) return false;
    if (filter === 'public' && !p.is_public) return false;
    if (filter === 'soon' && !soon(p)) return false;
    if (query) { var q = query.toLowerCase(); if ((p.title || '').toLowerCase().indexOf(q) < 0 && (p.preview || '').toLowerCase().indexOf(q) < 0) return false; }
    return true;
  }
  // Server previews are a plain slice of the source; drop syntax a reader shouldn't see.
  function cleanPreview(s) {
    return String(s || '')
      .replace(/^-{2,}\s*(?:(?:accent|toc|layout):\s*[\w-]+\s*)+-{2,}\s*/, '')
      .replace(/:::\s*[a-z]*/g, ' ').replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, ' ')
      .replace(/\{(up|down|accent)\}/g, '').replace(/:badge\[([^\]]*)\](\{\w+\})?/g, '$1').replace(/==([^=]+)==/g, '$1')
      .replace(/\s+/g, ' ').trim();
  }
  function row(p) {
    var k = kept(p), sel = selected.has(p.id);
    var tags = (p.is_public ? '<span class="tag public">Public</span>' : '') + (k ? '<span class="tag kept">⭐ Kept</span>' : '<span class="tag' + (soon(p) ? ' soon' : '') + '">' + left(p.expires_at) + '</span>');
    var kindTag = p.kind !== 'paste' ? '<span class="tag kind">' + esc(p.kind === 'archify' && p.archifyKind ? p.archifyKind : KIND_LABEL[p.kind]) + '</span>' : '';
    return '<a class="lib-row' + (sel ? ' sel' : '') + '" href="' + HREF[p.kind] + encodeURIComponent(p.id) + '" data-id="' + esc(p.id) + '">' +
      '<span class="cb"><input type="checkbox" aria-label="Select ' + esc(p.title) + '"' + (sel ? ' checked' : '') + '></span>' +
      '<span class="kind-ic ' + p.kind + '" aria-hidden="true">' + ICON[p.kind] + '</span>' +
      '<span class="main"><span class="title"><b>' + esc(p.title || 'Untitled') + '</b>' + kindTag + '</span>' +
      (p.preview ? '<span class="preview" style="display:block">' + esc(cleanPreview(p.preview)) + '</span>' : '') + '</span>' +
      '<span class="side"><span class="acts">' +
        '<button class="btn sm" type="button" data-act="copy">Copy link</button>' +
        '<button class="btn sm" type="button" data-act="public">' + (p.is_public ? 'Unpublish' : 'Publish') + '</button>' +
        '<button class="btn sm" type="button" data-act="keep">' + (k ? 'Unkeep' : '⭐ Keep') + '</button>' +
      '</span>' + tags + '<span class="when">' + ago(p.created_at) + '</span></span></a>';
  }
  function render() {
    var list = $('lib-list'); if (!list) return;
    var shown = items.filter(matches);
    var counts = { all: items.length, kept: items.filter(kept).length, public: items.filter(function (p) { return p.is_public; }).length, soon: items.filter(soon).length };
    Object.keys(counts).forEach(function (k) { var n = document.querySelector('[data-count="' + k + '"]'); if (n) n.textContent = counts[k] ? String(counts[k]) : ''; });
    var sum = $('lib-summary');
    if (sum) sum.textContent = items.length ? (items.length + ' item' + (items.length === 1 ? '' : 's') + ' · ' + counts.kept + ' kept · ' + counts.public + ' public') : 'Nothing here yet.';
    list.setAttribute('aria-busy', 'false');
    if (!items.length) { list.innerHTML = '<div class="lib-empty"><b>Your library is empty</b>Write something on the <a href="/#new">home page</a>, or let an agent publish through the API.</div>'; return; }
    if (!shown.length) { list.innerHTML = '<div class="lib-empty"><b>No matches</b>' + (query ? 'Nothing matches “' + esc(query) + '”.' : 'Nothing in this view.') + '</div>'; return; }
    list.innerHTML = shown.map(row).join('');
  }
  function syncBatch() {
    var bar = $('batch-bar'); if (!bar) return;
    $('batch-count').textContent = selected.size + ' selected';
    bar.classList.toggle('show', selected.size > 0);
    document.body.classList.toggle('selecting', selected.size > 0);
  }
  function find(id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; }
  async function setKeep(list, on) {
    var body = await api('/api/pin', json('PATCH', { items: list.map(function (p) { return { id: p.id, type: p.kind }; }), pinned: on }));
    var failed = {}; (body.failed || []).forEach(function (f) { failed[f.id] = true; });
    var expires = on ? '2099-12-31T00:00:00Z' : new Date(Date.now() + 7 * 864e5).toISOString();
    list.forEach(function (p) { if (!failed[p.id]) { p.pinned = on; p.expires_at = expires; } });
    return list.length - Object.keys(failed).length;
  }
  async function setPublic(list, on) {
    var autoKeep = store.get('mdshare-autokeep') !== 'off', ok = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      try {
        var withKeep = on && autoKeep && !kept(p);
        var b = await api('/api/pin', json('PATCH', Object.assign({ id: p.id, kind: p.kind, is_public: on }, withKeep ? { keep: true } : {})));
        p.is_public = on; if (b.kept) { p.pinned = true; p.expires_at = b.expires_at; }
        ok++;
      } catch (e) { /* counted below */ }
    }
    return ok;
  }
  async function remove(list) {
    var ok = 0;
    for (var i = 0; i < list.length; i++) {
      try { await api(DELETE_URL[list[i].kind] + encodeURIComponent(list[i].id), { method: 'DELETE' }); ok++; items = items.filter(function (x) { return x.id !== list[i].id; }); }
      catch (e) { /* counted below */ }
    }
    return ok;
  }
  function plural(n) { return n + ' item' + (n === 1 ? '' : 's'); }
  async function batch(kind) {
    var list = Array.from(selected.values()).map(function (s) { return find(s.id); }).filter(Boolean);
    if (!list.length) return;
    var bar = $('batch-bar'); bar.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var n;
      if (kind === 'keep' || kind === 'unkeep') { n = await setKeep(list, kind === 'keep'); toast((kind === 'keep' ? 'Kept ' : 'Unkept ') + plural(n)); }
      else if (kind === 'public' || kind === 'private') { n = await setPublic(list, kind === 'public'); toast((kind === 'public' ? 'Published ' : 'Made private: ') + plural(n) + (n < list.length ? ' (' + (list.length - n) + ' failed)' : ''), n < list.length); }
      else if (kind === 'delete') {
        if (!window.confirm('Delete ' + plural(list.length) + ' permanently? This cannot be undone.')) return;
        n = await remove(list); toast('Deleted ' + plural(n) + (n < list.length ? ' (' + (list.length - n) + ' failed)' : ''), n < list.length);
      }
      selected.clear();
    } catch (e) { toast('Failed: ' + e.message, true); }
    finally { bar.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); render(); syncBatch(); }
  }
  async function rowAction(p, act, btn) {
    btn.disabled = true;
    try {
      if (act === 'copy') {
        await navigator.clipboard.writeText(location.origin + HREF[p.kind] + p.id);
        toast(p.is_public ? 'Link copied' : 'Link copied (private: others will see a sign-in page)');
      } else if (act === 'keep') { var on = !kept(p); await setKeep([p], on); toast(on ? 'Kept forever' : 'Unkept: expires in 7 days'); }
      else if (act === 'public') { var pub = !p.is_public; if (await setPublic([p], pub)) toast(pub ? (kept(p) ? 'Published and kept' : 'Published') : 'Made private'); else toast('Could not update sharing', true); }
    } catch (e) { toast('Failed: ' + e.message, true); }
    btn.disabled = false; render();
  }
  function initLibrary() {
    var list = $('lib-list'); if (!list) return;
    list.addEventListener('click', function (e) {
      var r = e.target.closest('.lib-row'); if (!r) return;
      var p = find(r.getAttribute('data-id')); if (!p) return;
      var act = e.target.closest('[data-act]');
      if (act) { e.preventDefault(); rowAction(p, act.getAttribute('data-act'), act); return; }
      var cb = e.target.closest('.cb');
      if (cb || selected.size > 0) {
        e.preventDefault();
        if (selected.has(p.id)) selected.delete(p.id); else selected.set(p.id, { id: p.id });
        r.classList.toggle('sel', selected.has(p.id));
        r.querySelector('.cb input').checked = selected.has(p.id);
        syncBatch();
      }
    });
    function seg(id, set) {
      var s = $(id); if (!s) return;
      s.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-v]'); if (!b) return;
        s.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        set(b.getAttribute('data-v')); render();
      });
    }
    seg('filter-seg', function (v) { filter = v; });
    seg('type-seg', function (v) { type = v; });
    var t; $('search').addEventListener('input', function (e) { clearTimeout(t); t = setTimeout(function () { query = e.target.value.trim(); render(); }, 120); });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); $('search').focus(); }
      if (e.key === 'Escape' && selected.size) { selected.clear(); render(); syncBatch(); }
    });
    [['b-keep', 'keep'], ['b-unkeep', 'unkeep'], ['b-public', 'public'], ['b-private', 'private'], ['b-delete', 'delete']].forEach(function (x) { $(x[0]).addEventListener('click', function () { batch(x[1]); }); });
    $('b-clear').addEventListener('click', function () { selected.clear(); render(); syncBatch(); });
    api('/api/pastes', {}).then(function (data) { items = Array.isArray(data) ? data : []; render(); }).catch(function (e) {
      list.innerHTML = '<div class="lib-empty"><b>Couldn’t load your library</b>' + esc(e.message) + '</div>';
    });
  }

  // ===================== Settings =====================
  var lastToken = '';
  function tokenRow(t) {
    var scopes = !Array.isArray(t.scopes) ? '<span class="tag">legacy: create + own-read</span>'
      : (!t.scopes.length ? '<span class="tag">no scopes: own-read only</span>' : t.scopes.map(function (s) { return '<span class="tag scope">' + esc(s) + '</span>'; }).join(''));
    return '<div class="token-row"><div class="main"><div class="name">' + esc(t.name) + '<span class="tag ' + esc(t.status) + '">' + esc(t.status) + '</span></div>' +
      '<div class="meta"><span>created ' + ago(t.created_at) + '</span><span>' + (t.expires_at ? 'expires ' + new Date(t.expires_at).toLocaleDateString() : 'never expires') + '</span><span>' + (t.last_used_at ? 'last used ' + ago(t.last_used_at) : 'never used') + '</span></div>' +
      '<div class="scopes">' + scopes + '</div></div>' +
      (t.status === 'active' ? '<button class="btn sm danger" type="button" data-revoke="' + esc(t.id) + '">Revoke</button>' : '') + '</div>';
  }
  async function loadTokens() {
    var list = $('tokens-list');
    try {
      var data = await api('/api/auth?action=tokens', {});
      var tokens = data.tokens || [];
      $('tokens-count').textContent = String(tokens.length);
      list.innerHTML = tokens.length ? tokens.map(tokenRow).join('') : '<div class="lib-empty">No tokens yet. Create one for an agent or script.</div>';
    } catch (e) { list.innerHTML = '<div class="lib-empty">Couldn’t load tokens: ' + esc(e.message) + '</div>'; }
  }
  function onLegacy() {
    var legacy = $('scope-legacy').checked;
    ['scope-read', 'scope-write', 'scope-publish', 'scope-publish-any'].forEach(function (id) { $(id).disabled = legacy; });
    $('scope-row').style.opacity = legacy ? '0.45' : '1';
  }
  async function createToken() {
    var name = $('new-token-name').value.trim(), btn = $('btn-create-token');
    if (!name) { toast('Give the token a name', true); $('new-token-name').focus(); return; }
    btn.disabled = true;
    try {
      // Explicit scopes always, unless "Legacy" is checked (then the field is omitted entirely).
      var payload = { action: 'create_token', name: name };
      var days = $('new-token-days').value;
      if (days === 'never') payload.never_expires = true; else payload.expires_in_days = Number(days);
      if (!$('scope-legacy').checked) {
        payload.scopes = [['documents:read', 'scope-read'], ['documents:write', 'scope-write'], ['documents:publish', 'scope-publish'], ['documents:publish:any', 'scope-publish-any']]
          .filter(function (x) { return $(x[1]).checked; }).map(function (x) { return x[0]; });
      }
      var data = await api('/api/auth', json('POST', payload));
      lastToken = data.token;
      $('new-token-value').textContent = data.token;
      $('new-token-reveal').hidden = false;
      $('new-token-name').value = '';
      $('scope-legacy').checked = false; $('scope-read').checked = true; $('scope-write').checked = false; $('scope-publish').checked = false; $('scope-publish-any').checked = false; onLegacy();
      toast('Token created. Copy it now');
      loadTokens();
    } catch (e) { toast('Failed: ' + e.message, true); }
    btn.disabled = false;
  }
  function initSettings() {
    if (!$('settings')) return;
    var ak = $('pref-autokeep');
    ak.checked = store.get('mdshare-autokeep') !== 'off';
    ak.addEventListener('change', function () { store.set('mdshare-autokeep', ak.checked ? 'on' : 'off'); toast(ak.checked ? 'Publishing will keep documents' : 'Publishing won’t change expiry'); });
    $('api-base-example').textContent = location.origin + '/api/…';
    $('scope-legacy').addEventListener('change', onLegacy);
    $('btn-create-token').addEventListener('click', createToken);
    $('new-token-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') createToken(); });
    $('btn-copy-token').addEventListener('click', function () { if (lastToken) navigator.clipboard.writeText(lastToken).then(function () { toast('Copied'); }, function () { toast('Copy failed: select it manually', true); }); });
    $('tokens-list').addEventListener('click', async function (e) {
      var b = e.target.closest('[data-revoke]'); if (!b) return;
      if (!window.confirm('Revoke this token? Anything using it gets 401s immediately.')) return;
      b.disabled = true; b.textContent = 'Revoking…';
      try { await api('/api/auth', json('DELETE', { action: 'revoke_token', id: b.getAttribute('data-revoke') })); toast('Token revoked'); loadTokens(); }
      catch (err) { toast('Failed: ' + err.message, true); b.disabled = false; b.textContent = 'Revoke'; }
    });
    $('btn-signout').addEventListener('click', async function () {
      try { await api('/api/auth', json('POST', { action: 'logout' })); } catch (e) { /* cookie may already be gone */ }
      location.href = '/';
    });
    loadTokens();
  }

  initLibrary();
  initSettings();
})();
