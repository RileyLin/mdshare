// GET /api/pastes — list all pastes for dashboard (auth-gated)
// Returns: id, title, content preview (200 chars), created_at, pinned, expires_at
// Default sort: pinned first, then by created_at desc. ?sort=latest switches to pure
// created_at desc (ignores pinned priority) — a genuine "what's actually newest" view.
// Limit 100 per content table.
//
// Fixed 2026-10-08 (live-production bug report): expiry exclusion used to happen in JS AFTER the
// limit=100 fetch, so an expired-but-not-yet-purged row could still occupy one of the 100 slots
// in the DB query's own ordering, silently crowding out genuinely fresh content once the number
// of (expired-or-not) rows ordered ahead of it exceeded 100. The not-expired-or-pinned filter is
// now a real part of the Supabase query itself (same `or=(expires_at.gt....,pinned.eq.true)`
// shape already used by api/_lib/catalog.js), so `limit=100` now bounds 100 *valid* rows, not up
// to 100 raw rows that may shrink after the fact. The JS `.filter(p => !p.expired)` calls below
// are now a redundant no-op safety net (every row the query returns already satisfies this) —
// kept rather than removed, in case of a brief clock-skew edge case between this request and the
// `now` captured when the Supabase query ran.
//
// Bearer-token catalog mode (added 2026-10-08, AGENT-SEARCH-PLAN.md): when an Authorization
// header is present at all, this route no longer means "owner dashboard listing" — it means
// "agent catalog search/recent", gated on the documents:read scope, and is handled entirely
// separately (see handleAgentCatalog below) before the owner-cookie branch is ever reached. The
// owner-cookie dashboard-listing code beneath that is reached only when there is no Authorization
// header at all.
import { checkAuthAndRefresh } from './auth.js';
import { resolveAgentToken, hasScope } from './_lib/agent-tokens.js';
import { searchCatalog } from './_lib/catalog.js';
import { withErrors } from './_lib/events.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function handleAgentCatalog(req, res, agentAuth) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasScope(agentAuth, 'documents:read')) {
    // Covers both a legacy token (hasScope always false for it) and a scoped token that was never
    // granted documents:read — neither gets any catalog access, matching "no catalog" for every
    // token that doesn't hold this exact scope (AGENT-SEARCH-PLAN.md constraint 2/4).
    return res.status(403).json({ error: 'Token missing documents:read scope' });
  }
  const { q, kind, limit, offset } = req.query || {};
  const result = await searchCatalog({ q, kind, limit, offset });
  return res.status(200).json({ ok: true, ...result });
}

async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Authorization header present at all -> agent-catalog path, never the owner-cookie path below,
  // and never a fallback to anonymous/cookie behavior on an invalid token (fail-closed, same
  // invariant as every other bearer-consuming route in this repo).
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present) {
    if (!agentAuth.valid) return res.status(401).json({ error: 'Invalid or expired token' });
    return handleAgentCatalog(req, res, agentAuth);
  }

  if (!checkAuthAndRefresh(req, res)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 'latest' => pure created_at desc, ignoring pinned priority entirely — a genuine "what's
  // actually newest" view. Anything else (including absent) => existing default (pinned first,
  // then recency). This is a response-shape-preserving additive query param: existing clients
  // that never pass ?sort get byte-identical default behavior (modulo the expiry-before-limit
  // fix above, which only ever adds previously-hidden fresh rows back, never removes anything
  // a client was already correctly seeing).
  const sortLatest = req.query && req.query.sort === 'latest';
  const orderClause = sortLatest ? 'created_at.desc' : 'pinned.desc,created_at.desc';
  const nowIso = new Date().toISOString();
  // Real server-side "not expired, or pinned" filter — nowIso is computed in app code (never
  // user input), so it's always a safe literal even though it's interpolated into the URL.
  const expiryFilter = `or=(expires_at.gt.${encodeURIComponent(nowIso)},pinned.eq.true)`;

  const dbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?select=id,title,content,created_at,pinned,expires_at,is_public&${expiryFilter}&order=${orderClause}&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
      },
    }
  );

  if (!dbRes.ok) {
    const err = await dbRes.text();
    return res.status(500).json({ error: `Supabase error: ${err}` });
  }

  const rows = await dbRes.json();
  const now = new Date();

  const pastes = rows.map(row => {
    const content = row.content || '';
    // Extract title: use stored title if available, else first H1 from content
    let title = row.title;
    if (!title) {
      const m = content.match(/^#\s+(.+)$/m);
      title = m ? m[1].trim() : 'Untitled';
    }
    // Strip markdown syntax for preview
    const preview = content
      .replace(/^#+\s+.+$/gm, '') // remove headings
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/`(.+?)`/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/^\s*[-*>]\s*/gm, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 200);

    const expired = new Date(row.expires_at) < now && !row.pinned;

    return {
      id: row.id,
      title: title || 'Untitled',
      preview,
      created_at: row.created_at,
      pinned: row.pinned || false,
      expires_at: row.expires_at,
      expired,
      is_public: row.is_public === true,
    };
  }).filter(p => !p.expired); // hide expired non-pinned pastes

  // --- Also pull diagrams so the catalog shows both pastes and SVG diagrams ---
  let diagrams = [];
  try {
    const dgRes = await fetch(
      `${SUPABASE_URL}/rest/v1/mdshare_diagrams?select=id,title,markdown,created_at,expires_at,pinned,is_public&${expiryFilter}&order=${orderClause}&limit=100`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );
    if (dgRes.ok) {
      const dgRows = await dgRes.json();
      diagrams = dgRows.map(row => {
        const md = row.markdown || '';
        const preview = md
          .replace(/^#+\s+.+$/gm, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/`(.+?)`/g, '$1')
          .replace(/\n+/g, ' ')
          .trim()
          .slice(0, 200);
        const expired = new Date(row.expires_at) < now && !row.pinned;
        return {
          id: row.id,
          title: row.title || 'Diagram',
          preview: preview || 'SVG diagram',
          created_at: row.created_at,
          pinned: row.pinned || false,
          expires_at: row.expires_at,
          expired,
          kind: 'diagram',
          is_public: row.is_public === true,
        };
      }).filter(d => !d.expired);
    }
  } catch (e) {
    // diagrams table optional — ignore if missing
  }

  // --- Also pull archify diagrams (interactive architecture/workflow/sequence/dataflow/lifecycle) ---
  let archifyItems = [];
  try {
    const arRes = await fetch(
      `${SUPABASE_URL}/rest/v1/mdshare_archify?select=id,title,kind,created_at,expires_at,pinned,is_public&${expiryFilter}&order=${orderClause}&limit=100`,
      { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } }
    );
    if (arRes.ok) {
      const arRows = await arRes.json();
      archifyItems = arRows.map(row => {
        const expired = new Date(row.expires_at) < now && !row.pinned;
        const kindLabel = (row.kind || 'diagram').charAt(0).toUpperCase() + (row.kind || 'diagram').slice(1);
        return {
          id: row.id,
          title: row.title || 'Diagram',
          preview: `Interactive ${kindLabel} diagram`,
          created_at: row.created_at,
          pinned: row.pinned || false,
          expires_at: row.expires_at,
          expired,
          kind: 'archify',
          archifyKind: row.kind || null,
          is_public: row.is_public === true,
        };
      }).filter(a => !a.expired);
    }
  } catch (e) {
    // archify table optional — ignore if missing
  }

  // Merge: pastes (kind=paste) + diagrams (kind=diagram) + archify (kind=archify). Default:
  // pinned first, then newest. ?sort=latest: pure newest-first, ignoring pinned entirely — kept
  // consistent with the per-table order clause above.
  const merged = [
    ...pastes.map(p => ({ ...p, kind: p.kind || 'paste' })),
    ...diagrams,
    ...archifyItems,
  ].sort((a, b) => {
    if (!sortLatest && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(merged);
}

export default withErrors('pastes', handler);
