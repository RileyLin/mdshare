// Shared visibility + Supabase access helpers for mdshare content routes.
// Underscore-prefixed directory: Vercel does not expose files under api/_lib/* as their own
// routes, so this is safe to import from without creating an extra public endpoint.
import { isAuthenticated, checkAuthAndRefresh } from '../auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// mdshare ids are nanoid(10) drawn from the base64url alphabet [A-Za-z0-9_-]. Reject anything
// else before it reaches a PostgREST filter string built by string interpolation.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

const TABLES = {
  paste: 'mdshare_pastes',
  diagram: 'mdshare_diagrams',
  archify: 'mdshare_archify',
};

export function tableFor(kind) {
  return TABLES[kind] || null;
}

/**
 * Fetch one row by id from a content table.
 * Returns one of:
 *   { row }                      — found (may still be expired-checked by caller via row.expires_at)
 *   { row: null }                — missing, expired, or invalid id (safe to treat as "not found")
 *   { row: null, dbError: true } — Supabase itself errored; caller MUST fail closed (never public)
 */
export async function getRow(table, id, select) {
  if (!isValidId(id)) return { row: null };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=${select}`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );
    if (!res.ok) return { row: null, dbError: true };
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return { row: null };
    const row = rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) return { row: null };
    return { row };
  } catch {
    return { row: null, dbError: true };
  }
}

/**
 * Patch a row (currently only used for the is_public toggle). Returns
 * { ok: true, row } or { ok: false, status, error }.
 */
export async function patchRow(table, id, patch) {
  if (!isValidId(id)) return { ok: false, status: 400, error: 'Invalid id' };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${SUPABASE_KEY}`,
          apikey: SUPABASE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    );
    if (!res.ok) return { ok: false, status: 502, error: await res.text() };
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, status: 404, error: 'Not found' };
    return { ok: true, row: rows[0] };
  } catch (e) {
    return { ok: false, status: 502, error: String((e && e.message) || e) };
  }
}

// Visibility rule: the owner (authenticated) can always see their own content. Everyone else can
// only see it if is_public === true. A missing row is never visible. This is the single choke
// point every render/raw/IR route must call before returning content.
//
// Pass `res` when it's available (every HTTP handler has one) so an owner on a still-valid
// legacy-format cookie gets silently upgraded to a fresh v2 session cookie on this same request
// (see checkAuthAndRefresh in auth.js) — no re-login, no extra step. `res` is optional: omitting
// it (e.g. in tests) falls back to a plain isAuthenticated() check with no side effect.
export function isVisible(row, req, res) {
  if (!row) return false;
  if (res) return checkAuthAndRefresh(req, res) || row.is_public === true;
  return isAuthenticated(req) || row.is_public === true;
}

// Applied to every render/raw response (public and private alike): keep share links out of
// search indexes, don't leak share-id-bearing URLs via the Referer header on outbound links, and
// never let a cache serve a stale public/private state after a visibility toggle.
export function setPrivacyHeaders(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
}

// Shown instead of content when an item exists but is private and the requester is not the
// owner. Reloads the exact same URL after a successful login — same-origin by construction,
// since it never takes a redirect target from the client. No title/content is ever included.
export function privateGateHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Private — mdshare</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', sans-serif; background: oklch(97.5% 0.005 80); color: oklch(16% 0.01 260); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { width: 100%; max-width: 360px; background: #fff; border: 1px solid oklch(86% 0.01 80); border-radius: 16px; padding: 40px 36px; box-shadow: 0 2px 8px oklch(0% 0 0 / 0.05), 0 12px 40px oklch(0% 0 0 / 0.07); }
    .wordmark { font-family: 'Instrument Serif', serif; font-size: 1.3rem; display: flex; align-items: center; gap: 8px; margin-bottom: 12px; text-decoration: none; color: inherit; }
    .wordmark-dot { width: 7px; height: 7px; border-radius: 50%; background: oklch(52% 0.18 250); display: inline-block; }
    h1 { font-size: 1rem; font-weight: 600; margin-bottom: 6px; }
    p { font-size: 13px; color: oklch(38% 0.015 260); margin-bottom: 20px; line-height: 1.5; }
    .label { display: block; font-size: 12px; font-weight: 500; color: oklch(56% 0.01 260); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px; }
    .input { width: 100%; padding: 10px 14px; font-size: 15px; background: oklch(97.5% 0.005 80); border: 1px solid oklch(86% 0.01 80); border-radius: 9px; outline: none; }
    .input:focus { border-color: oklch(52% 0.18 250); }
    .btn { width: 100%; margin-top: 16px; padding: 11px 20px; font-size: 14px; font-weight: 500; color: #fff; background: oklch(52% 0.18 250); border: none; border-radius: 9px; cursor: pointer; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error-msg { margin-top: 12px; font-size: 13px; color: oklch(52% 0.2 25); text-align: center; min-height: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <a class="wordmark" href="/"><span class="wordmark-dot"></span>mdshare</a>
    <h1>This content is private</h1>
    <p>Sign in as the owner to view it. If it's ever shared publicly, this link will work for anyone without signing in.</p>
    <label class="label" for="pwd">Password</label>
    <input class="input" type="password" id="pwd" placeholder="••••••••" autocomplete="current-password" autofocus>
    <button class="btn" id="submit-btn" onclick="login()">Sign in</button>
    <p class="error-msg" id="err"></p>
  </div>
  <script>
    document.getElementById('pwd').addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
    async function login() {
      const pwd = document.getElementById('pwd').value;
      const btn = document.getElementById('submit-btn');
      const err = document.getElementById('err');
      if (!pwd) return;
      btn.disabled = true; btn.textContent = 'Signing in…'; err.textContent = '';
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd }),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          err.textContent = 'Wrong password';
          btn.disabled = false; btn.textContent = 'Sign in';
          document.getElementById('pwd').select();
        }
      } catch (e) {
        err.textContent = 'Network error — try again';
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    }
  <\/script>
</body>
</html>`;
}

// Owner-only "Share publicly / Stop sharing" control, shared verbatim across render.js,
// diagram-render.js, and archify-render.js so the three pages behave identically.
export function visibilityControlHtml(isPublic) {
  return `<span class="badge" id="visibility-badge" style="${isPublic ? '' : 'color:var(--ink-3);background:transparent;border-color:var(--border)'}">${isPublic ? 'public' : 'private'}</span>
      <button class="btn" id="btn-visibility" onclick="toggleVisibility()">${isPublic ? '🌐 Stop sharing' : '🔒 Share publicly'}</button>`;
}

export function visibilityControlScript(id, kind, isPublic) {
  return `
    var VIS_ID = ${JSON.stringify(id)};
    var VIS_KIND = ${JSON.stringify(kind)};
    var isPublicState = ${JSON.stringify(!!isPublic)};
    function updateVisibilityUI() {
      var badge = document.getElementById('visibility-badge');
      var btn = document.getElementById('btn-visibility');
      if (!badge || !btn) return;
      badge.textContent = isPublicState ? 'public' : 'private';
      badge.style.color = isPublicState ? '' : 'var(--ink-3)';
      badge.style.background = isPublicState ? '' : 'transparent';
      badge.style.borderColor = isPublicState ? '' : 'var(--border)';
      btn.textContent = isPublicState ? '🌐 Stop sharing' : '🔒 Share publicly';
    }
    async function toggleVisibility() {
      var makingPublic = !isPublicState;
      var msg = makingPublic
        ? 'Share this publicly? Anyone with the link will be able to view it — no sign-in required.'
        : 'Stop sharing? The public link will stop working immediately.';
      if (!window.confirm(msg)) return;
      var btn = document.getElementById('btn-visibility');
      btn.disabled = true;
      try {
        var res = await fetch('/api/visibility', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: VIS_ID, kind: VIS_KIND, is_public: makingPublic }),
        });
        if (!res.ok) throw new Error(await res.text());
        isPublicState = makingPublic;
        updateVisibilityUI();
      } catch (e) {
        alert('Failed to update sharing: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }
    updateVisibilityUI();
  `;
}
