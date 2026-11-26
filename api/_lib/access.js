// Shared visibility + Supabase access helpers for mdshare content routes.
// Underscore-prefixed directory: Vercel does not expose files under api/_lib/* as their own
// routes, so this is safe to import from without creating an extra public endpoint.
import { isAuthenticated, checkAuthAndRefresh } from '../auth.js';
import { privateGatePage } from './ui.js';

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
// `opts.agentOwns` (optional 4th param) is an additional OR-branch used by the raw content GET
// routes (api/share.js, api/diagram.js, api/archify.js) for per-agent bearer tokens: a token may
// read back only the exact rows it itself created (see api/_lib/agent-tokens.js). Omitting `opts`
// entirely — every call site until the bearer-token feature was added, and every HTML-chrome
// render route (render.js/diagram-render.js/archify-render.js/archify-html.js), which do not
// support bearer tokens at all — is byte-identical to the original two-branch check.
export function isVisible(row, req, res, opts) {
  if (!row) return false;
  if (res) {
    if (checkAuthAndRefresh(req, res)) return true;
  } else if (isAuthenticated(req)) {
    return true;
  }
  if (row.is_public === true) return true;
  if (opts && opts.agentOwns === true) return true;
  return false;
}

// Applied to every render/raw response (public and private alike): keep share links out of
// search indexes, don't leak share-id-bearing URLs via the Referer header on outbound links, and
// never let a cache serve a stale public/private state after a visibility toggle.
export function setPrivacyHeaders(res) {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'private, no-store');
  // Stored content is served as text/plain, text/markdown or HTML; never let a browser guess another type.
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Shown instead of content when an item exists but is private and the requester is not the
// owner. Reloads the exact same URL after a successful login — same-origin by construction,
// since it never takes a redirect target from the client. No title/content is ever included.
// `hint` (api/_lib/raw.js refusalHint) is extra, escaped text for an agent that sent its token the wrong way.
export function privateGateHtml({ hint } = {}) {
  return privateGatePage({ hint });
}

// A row is "kept" (never expires) when pinned; legacy pinned rows were pushed to 2099.
export function isKept(row) {
  return !!row && (row.pinned === true || (typeof row.expires_at === 'string' && row.expires_at >= '2099'));
}

// Pre-redesign "Share publicly / Stop sharing" control. Only the classic view still uses it
// (api/_lib/classic.js); the current pages use the share panel in /assets/app.js.
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
        var res = await fetch('/api/pin', {
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
