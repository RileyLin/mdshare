// Raw Markdown for agents: the one read path behind /raw/:id (api/share.js GET) and /v/:id when the
// request carries a Bearer token or asks for text/markdown (api/render.js). Same rules on both
// URLs: the signed-in user who owns it, a public document, or a token of that user with
// documents:read or that created the row (access.js tokenCanRead).
// scripts/check-invariants.mjs "markdown-route-gating" keeps both routes on sendRawMarkdown().
//
// Failures say what to do. A 401 carries WWW-Authenticate: Bearer, a one-line hint and the guide
// link (always the canonical site, never the request's Host header). A credential sent the wrong
// way (x-api-key header, ?key= query) is only ever extra hint text on a request that is already
// refused: it never changes the answer for the owner, a valid Bearer or a public document
// (adversarial review 2026-11-26), so refusalHint() is called only after visibility was decided.
// A request that may not read a document gets the same 404 for an existing and a missing id, so
// nothing reveals that an id exists.
// Underscore directory: not a Vercel function.
import { checkAuthAndRefresh } from './session.js';
import { isVisible, setPrivacyHeaders, setUserContentHeaders, tokenCanRead } from './access.js';
import { parseBearer, resolveAgentToken } from './agent-tokens.js';
import { readForView } from './tenant.js';
import { guideUrl } from './content.js';

export const HINTS = {
  invalid: 'Check the token (Settings → API tokens on this site) and send it as Authorization: Bearer <token>.',
  misplaced: 'Send the token as Authorization: Bearer <token>; x-api-key headers and ?key= query parameters are not read.',
  missing: 'Sign in as the owner, or send Authorization: Bearer <token>.',
  notReadable: 'Private documents need the owner session or a token with documents:read (a token can always read documents it created).',
};

const MISPLACED_HEADERS = ['x-api-key', 'api-key', 'apikey', 'x-mdshare-token'];
const MISPLACED_QUERY = ['key', 'api_key', 'apikey', 'token', 'access_token'];

// A credential sent somewhere other than the Authorization header (and no Bearer header at all).
export function apiKeyMisuse(req) {
  if (parseBearer(req)) return false;
  const h = (req && req.headers) || {};
  const q = (req && req.query) || {};
  return MISPLACED_HEADERS.some((k) => typeof h[k] === 'string' && h[k].trim() !== '') || MISPLACED_QUERY.some((k) => typeof q[k] === 'string' && q[k] !== '');
}

// The hint for a request that is being refused anyway: say how to send the token when one was sent
// the wrong way, otherwise `fallback`. Only call this on a refusal path, after the owner session,
// the Bearer token and the document's visibility were checked (invariant "agent-auth-hints").
export function refusalHint(req, fallback) {
  return apiKeyMisuse(req) ? HINTS.misplaced : fallback;
}

// 401 with WWW-Authenticate and a hint. `error` stays the short message older clients match on.
export function authHint(req, res, { error, hint, status = 401, scope }) {
  res.setHeader('WWW-Authenticate', `Bearer realm="mdshare"${scope ? `, scope="${scope}"` : ''}`);
  return res.status(status).json({ error, hint, guide: guideUrl(req) });
}

// Accept header lists text/markdown at least as strongly as text/html.
export function acceptsMarkdown(req) {
  const accept = String((req && req.headers && req.headers.accept) || '').toLowerCase();
  const q = (type) => {
    for (const part of accept.split(',')) {
      const [t, ...params] = part.trim().split(';');
      if (t.trim() !== type) continue;
      const qp = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const v = qp ? Number(qp.slice(2)) : 1;
      return Number.isFinite(v) ? v : 0;
    }
    return -1;
  };
  const md = q('text/markdown');
  return md > 0 && md >= q('text/html');
}

// Should /v/:id answer with Markdown instead of the page? Any Bearer header (an agent: it gets
// Markdown or an actionable error), or the owner asking for text/markdown. Everything else,
// including a stray ?token= or x-api-key, keeps the HTML page / sign-in gate exactly as before.
export function wantsMarkdown(req, res) {
  if (parseBearer(req)) return true;
  return acceptsMarkdown(req) && checkAuthAndRefresh(req, res) === true;
}

export async function sendRawMarkdown(req, res, { contentType = 'text/plain; charset=utf-8' } = {}) {
  setPrivacyHeaders(res);
  setUserContentHeaders(res);
  res.setHeader('Vary', 'Accept, Authorization, Cookie');
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  // A present-but-invalid Bearer is a hard 401, never a fallback to the owner/public check.
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present && !agentAuth.valid) return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid });

  const { row, dbError } = await readForView('mdshare_pastes', id, 'content,expires_at,is_public,created_by_token');
  if (dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
  // documents:read widens a token's reach to its own user's whole library (not just rows this exact
  // token created), never to another user's; a legacy token keeps the own-row-only floor.
  const agentOwns = tokenCanRead(agentAuth, row);
  if (!row || !isVisible(row, req, res, { agentOwns })) {
    // Same body for a missing id and an existing one this request may not read.
    const hint = agentAuth.valid ? HINTS.notReadable : (checkAuthAndRefresh(req, res) ? undefined : refusalHint(req, HINTS.missing));
    return res.status(404).json({ error: 'Not found or expired', hint, guide: guideUrl(req) });
  }
  res.setHeader('Content-Type', contentType);
  return res.status(200).send(row.content);
}
