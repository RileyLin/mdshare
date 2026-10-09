// POST /api/archify — accepts a full archify-rendered interactive HTML + markdown explainer (+
// kind, title, ir). Always creates a PRIVATE row (is_public: false) — visibility can only be
// changed via the auth-gated PATCH /api/visibility endpoint, never from this request body.
// GET  /api/archify?id=xxx — returns raw IR JSON. Private unless the owner is authenticated or the
// row has is_public: true.
//
// Design (revised per Ryan, Jul 23): /a/:id is a NORMAL mdshare page — same structure as /d/:id
// (diagram on top + markdown explainer below + Pin + Save-to-Notion). The diagram at the top keeps
// archify's FULL interactivity (hover-to-trace, route probe, pan/zoom, theme toggle) by embedding the
// self-contained archify HTML in a sandboxed iframe (see api/archify-render.js) inside the mdshare
// .svg-frame. The markdown explainer renders below in mdshare's own warm-paper Notes styling.
//
// We store: html (full self-contained archify doc, powers the interactive iframe),
// markdown (the explainer rendered below), ir (source of truth, re-renderable), kind, title.

import { randomBytes } from 'crypto';
import { getRow, isVisible, setPrivacyHeaders } from './_lib/access.js';
import { resolveAgentToken, hasScope, isLegacyToken } from './_lib/agent-tokens.js';
function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const VALID_KINDS = ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'];

async function supabaseSet({ id, kind, ir, html, markdown, title, ttlSeconds, createdByToken }) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mdshare_archify`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      id, kind, ir: ir || null, html, markdown: markdown || null,
      // is_public is always false on create, regardless of anything in the request body.
      // created_by_token comes only from a server-validated bearer token, never the request body.
      title: title || 'Diagram', expires_at: expiresAt, is_public: false, created_by_token: createdByToken || null,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} — ${text}`);
  }
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const kind = body?.kind;
    if (!kind || !VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `Missing/invalid kind. Must be one of: ${VALID_KINDS.join(', ')}` });
    }

    const html = typeof body?.html === 'string' ? body.html : null;
    if (!html || !html.includes('<svg')) {
      return res.status(400).json({ error: 'Missing html (full archify-rendered interactive document)' });
    }

    let ir = body?.ir;
    if (typeof ir === 'string') { try { ir = JSON.parse(ir); } catch { ir = null; } }

    const markdown = typeof body?.markdown === 'string' ? body.markdown : null;
    const title = body?.title || ir?.meta?.title || 'Diagram';
    const ttl = Math.min(parseInt(body?.ttl) || 604800, 2592000); // default 7d, max 30d
    const id = nanoid();

    await supabaseSet({ id, kind, ir, html, markdown, title, ttlSeconds: ttl, createdByToken: agentAuth.valid ? agentAuth.id : null });

    const host = req.headers.host || 'mdshare.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const url = `${protocol}://${host}/a/${id}`;

    return res.status(200).json({ url, id, kind, expires_in: ttl });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const agentAuth = await resolveAgentToken(req);
    if (agentAuth.present && !agentAuth.valid) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    setPrivacyHeaders(res);
    const { row, dbError } = await getRow('mdshare_archify', id, 'ir,kind,title,expires_at,is_public,created_by_token');
    if (dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
    const agentOwns = !!(agentAuth.valid && row && (hasScope(agentAuth, 'documents:read') || row.created_by_token === agentAuth.id));
    if (!row || !isVisible(row, req, res, { agentOwns })) return res.status(404).json({ error: 'Not found or expired' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.json({ kind: row.kind, title: row.title, ir: row.ir });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
