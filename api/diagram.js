// POST /api/diagram — accepts SVG (+ optional markdown), returns a shareable URL. Always creates
//   a PRIVATE row (is_public: false) — visibility can only be changed via the auth-gated
//   PATCH /api/visibility endpoint, never from this request body.
// GET  /api/diagram?id=xxx — returns raw SVG with USER_CONTENT_CSP (sandbox, no script; sanitised on
//   write by api/_lib/tenant.js too). Private unless the signed-in user owns it, a token of
//   that user may read it (tokenCanRead), or the row has is_public: true. DELETE: own rows only.

import { randomBytes } from 'crypto';
import { wantsKeep, expiryFields, baseUrl, FORMAT_GUIDE_PATH, CREATES_PER_HOUR, MAX_PASTE_SIZE } from './_lib/content.js';
import { rateLimiter, clientIp } from './_lib/rate-limit.js';
import { isVisible, setPrivacyHeaders, setUserContentHeaders, tokenCanRead } from './_lib/access.js';
import { creatorOf, sessionOwner, readForView, insertOwned, deleteOwned } from './_lib/tenant.js';
import { parseJsonBody } from './_lib/body.js';
import { resolveAgentToken, hasScope, isLegacyToken } from './_lib/agent-tokens.js';
import { withErrors } from './_lib/events.js';
// Creates per IP and hour, like POST /api/share (ADV-MU-B 4: diagram and archify had no limit).
const CREATE_LIMIT = rateLimiter({ limit: CREATES_PER_HOUR, windowMs: 60 * 60 * 1000 });

function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

async function supabaseSet(me, id, svg, title, markdown, ttlSeconds, createdByToken, keep) {
  const { expires_at: expiresAt, pinned } = expiryFields(ttlSeconds, keep);
  // Explicit field list: is_public is always false on create regardless of the request body.
  // created_by_token comes only from a server-validated bearer token, never the request body;
  // owner_id from `me` (creatorOf(req)) inside insertOwned().
  await insertOwned('mdshare_diagrams', me, { id, svg, title: title || 'Diagram', markdown: markdown || null, expires_at: expiresAt, pinned, is_public: false, created_by_token: createdByToken || null });
}

async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const agentAuth = await resolveAgentToken(req);
    if (agentAuth.present && !agentAuth.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    // Scoped tokens need documents:write to create; legacy tokens (scopes === null) are
    // unaffected — see api/share.js for the full rationale (AGENT-SEARCH-PLAN.md constraint 3).
    if (agentAuth.valid && !isLegacyToken(agentAuth) && !hasScope(agentAuth, 'documents:write')) {
      return res.status(403).json({ error: 'Token missing documents:write scope' });
    }

    const rate = CREATE_LIMIT.check(clientIp(req));
    res.setHeader('X-RateLimit-Limit', String(CREATE_LIMIT.limit));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      return res.status(429).json({ error: `Rate limit exceeded. Max ${CREATE_LIMIT.limit} diagrams per hour.`, retry_after: rate.retryAfter });
    }

    let body = parseJsonBody(req.body);

    const svg = body?.svg;
    if (!svg || typeof svg !== 'string') {
      return res.status(400).json({ error: 'Missing svg field' });
    }

    // Basic SVG validation
    if (!svg.trim().startsWith('<svg') && !svg.trim().startsWith('<?xml')) {
      return res.status(400).json({ error: 'svg field must be valid SVG markup' });
    }

    const title = body?.title || 'Diagram';
    const markdown = body?.markdown || null; // optional companion writeup
    // The same size cap as a paste, for the SVG and for the companion Markdown.
    if (svg.length > MAX_PASTE_SIZE || (typeof markdown === 'string' && markdown.length > MAX_PASTE_SIZE)) {
      return res.status(413).json({ error: `Diagram too large. Max ${MAX_PASTE_SIZE / 1000}KB of SVG and ${MAX_PASTE_SIZE / 1000}KB of Markdown.` });
    }
    const ttl = Math.min(parseInt(body?.ttl) || 86400, 604800); // max 7 days
    const id = nanoid();

    const keep = wantsKeep(body, req, res, agentAuth);
    await supabaseSet(creatorOf(req, res, agentAuth), id, svg, title, markdown, ttl, agentAuth.valid ? agentAuth.id : null, keep);

    const base = baseUrl(req);
    return res.status(200).json({ url: `${base}/d/${id}`, id, expires_in: keep ? null : ttl, kept: keep, format_guide: `${base}${FORMAT_GUIDE_PATH}` });
  }

  if (req.method === 'DELETE') {
    const me = sessionOwner(req, res);
    if (!me) return res.status(401).json({ error: 'Unauthorized' });
    const id = req.query?.id;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });
    await deleteOwned('mdshare_diagrams', me, id);
    return res.status(200).json({ ok: true, deleted: id });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const agentAuth = await resolveAgentToken(req);
    if (agentAuth.present && !agentAuth.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    setPrivacyHeaders(res);
    // Raw SVG opened as a page must not run script on this origin (ADV-MU-A F1): sandbox CSP.
    setUserContentHeaders(res);
    const { row, dbError } = await readForView('mdshare_diagrams', id, 'svg,expires_at,is_public,created_by_token');
    if (dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
    const agentOwns = tokenCanRead(agentAuth, row);
    if (!row || !isVisible(row, req, res, { agentOwns })) return res.status(404).json({ error: 'Not found or expired' });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    return res.send(row.svg);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrors('diagram', handler);
