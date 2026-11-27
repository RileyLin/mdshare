// Shared visibility + Supabase access helpers for mdshare content routes.
// Underscore-prefixed directory: Vercel does not expose files under api/_lib/* as their own
// routes, so this is safe to import from without creating an extra public endpoint.
import { privateGatePage, hiddenGatePage, hiddenSignedInPage } from './ui.js';
import { sessionOwner, tokenOwner, owns, isValidId, CONTENT_TABLES } from './tenant.js';
import { hasScope } from './agent-tokens.js';

// Row reads and writes moved to api/_lib/tenant.js (multi-user, 2026-11-27); isValidId lives there.
export { isValidId };

const TABLES = {
  paste: 'mdshare_pastes',
  diagram: 'mdshare_diagrams',
  archify: 'mdshare_archify',
};

export function tableFor(kind) {
  return TABLES[kind] && CONTENT_TABLES.includes(TABLES[kind]) ? TABLES[kind] : null;
}

// Visibility rule: the signed-in user who owns the row (owner_id, api/_lib/tenant.js) can always
// see it. Everyone else — anonymous, or any other signed-in user — only if is_public === true. A
// missing row is never visible. This is the single choke point every render/raw/IR route must call
// before returning content.
//
// Pass `res` when it's available so a still-valid legacy-format cookie gets silently upgraded on
// this same request (api/_lib/session.js). `opts.agentOwns` (4th param) is the bearer-token branch,
// computed with tokenCanRead() below: the token's own user owns the row, and the token holds
// documents:read or created the row itself. HTML render routes take no tokens and omit `opts`.
export function isVisible(row, req, res, opts) {
  if (!row) return false;
  if (owns(sessionOwner(req, res), row)) return true;
  if (row.is_public === true) return true;
  if (opts && opts.agentOwns === true) return true;
  return false;
}

// May this valid agent token read `row` even when it is private? Only a row of the token's own user,
// and then with documents:read (that user's library) or when the token created the row. A legacy
// token's hasScope() is always false, so it keeps the own-rows-only floor.
export function tokenCanRead(agentAuth, row) {
  if (!agentAuth || agentAuth.valid !== true || !row) return false;
  if (!owns(tokenOwner(agentAuth), row)) return false;
  return hasScope(agentAuth, 'documents:read') || (!!row.created_by_token && row.created_by_token === agentAuth.id);
}

// Is the signed-in browser user this row's owner? (Owner controls on /v, /d, /a.)
export function viewerOwns(row, req, res) {
  return owns(sessionOwner(req, res), row);
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

// Raw user content on the main origin (GET /api/diagram SVG, raw Markdown, archify IR JSON): even
// if a browser opens it as a top-level document, it runs no script and gets an opaque origin, so it
// can't use the reader's mdshare cookie (ADV-MU-A F1: a stored SVG <script> read the victim's library).
// The archify HTML route has its own sandboxed policy that keeps its scripts (api/archify-html.js).
export const USER_CONTENT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
export function setUserContentHeaders(res) {
  res.setHeader('Content-Security-Policy', USER_CONTENT_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

// Shown instead of content when an item exists but is private and the requester is not the
// owner. Reloads the exact same URL after a successful login — same-origin by construction,
// since it never takes a redirect target from the client. No title/content is ever included.
// `hint` (api/_lib/raw.js refusalHint) is extra, escaped text for an agent that sent its token the wrong way.
export function privateGateHtml({ hint } = {}) {
  return privateGatePage({ hint });
}

// /v, /d, /a when isVisible() said no (or there is no row): the same status and page for a missing,
// expired or someone else's private document, chosen only by who is asking (ui.js hiddenGatePage).
// Returns [status, html]. `hint` (api/_lib/raw.js refusalHint) is extra, escaped agent text.
export function notVisibleHtml(req, res, { what = 'document', hint } = {}) {
  return sessionOwner(req, res) ? [404, hiddenSignedInPage(what)] : [401, hiddenGatePage({ what, hint })];
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
