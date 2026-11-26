// Raw Markdown for agents: the one read path behind /raw/:id (api/share.js GET) and /v/:id when the
// request carries a Bearer token or asks for text/markdown (api/render.js). Same rules on both
// URLs: the owner, a public document, a documents:read token, or the token that created the row.
// scripts/check-invariants.mjs "markdown-route-gating" keeps both routes on sendRawMarkdown().
//
// Failures say what to do. A 401 carries WWW-Authenticate: Bearer, a one-line hint and the guide
// link. A credential sent the wrong way (x-api-key header, ?key= query) is refused before any
// lookup with a hint to use Authorization: Bearer. A request that may not read a document gets
// the same 404 for an existing and a missing id, so nothing reveals that an id exists.
// Underscore directory: not a Vercel function.
import { checkAuthAndRefresh } from '../auth.js';
import { getRow, isVisible, setPrivacyHeaders } from './access.js';
import { parseBearer, resolveAgentToken, hasScope } from './agent-tokens.js';
import { baseUrl, FORMAT_GUIDE_PATH } from './content.js';

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

// 401 with WWW-Authenticate and a hint. `error` stays the short message older clients match on.
export function authHint(req, res, { error, hint, status = 401, scope }) {
  res.setHeader('WWW-Authenticate', `Bearer realm="mdshare"${scope ? `, scope="${scope}"` : ''}`);
  return res.status(status).json({ error, hint, guide: `${baseUrl(req)}${FORMAT_GUIDE_PATH}` });
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

// Should /v/:id answer with Markdown instead of the page? Any Bearer header or misplaced key (an
// agent: it gets Markdown or an actionable error), or the owner asking for text/markdown.
// Everything else keeps the HTML page / sign-in gate exactly as before.
export function wantsMarkdown(req, res) {
  if (parseBearer(req) || apiKeyMisuse(req)) return true;
  return acceptsMarkdown(req) && checkAuthAndRefresh(req, res) === true;
}

export async function sendRawMarkdown(req, res, { contentType = 'text/plain; charset=utf-8' } = {}) {
  setPrivacyHeaders(res);
  res.setHeader('Vary', 'Accept, Authorization, Cookie');
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  if (apiKeyMisuse(req)) return authHint(req, res, { error: 'Unsupported credential', hint: HINTS.misplaced });

  // A present-but-invalid Bearer is a hard 401, never a fallback to the owner/public check.
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present && !agentAuth.valid) return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid });

  const { row, dbError } = await getRow('mdshare_pastes', id, 'content,expires_at,is_public,created_by_token');
  if (dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
  // documents:read (library-wide read, scoped tokens only) widens visibility to any row, not just
  // rows this exact token created; a legacy token's hasScope() is always false, so it keeps the
  // own-row-only check it always had.
  const agentOwns = !!(agentAuth.valid && row && (hasScope(agentAuth, 'documents:read') || row.created_by_token === agentAuth.id));
  if (!row || !isVisible(row, req, res, { agentOwns })) {
    // Same body for a missing id and an existing one this request may not read.
    const hint = agentAuth.valid ? HINTS.notReadable : (checkAuthAndRefresh(req, res) ? undefined : HINTS.missing);
    return res.status(404).json({ error: 'Not found or expired', hint, guide: `${baseUrl(req)}${FORMAT_GUIDE_PATH}` });
  }
  res.setHeader('Content-Type', contentType);
  return res.status(200).send(row.content);
}
