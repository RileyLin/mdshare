// PATCH /api/pin — pin/unpin paste(s) or diagram(s) [auth-gated]
// Supports:
//   single:  { id, type, pinned? }            (pinned defaults true; backward compat)
//   batch:   { items: [{ id, type }], pinned? }
// Pinning extends expires_at to 2099 + sets pinned=true.
// Unpinning sets pinned=false (expires_at left as-is; pinned items already pushed to 2099).
//
// Also handles PATCH /api/visibility's job (merged in here 2026-09-22 to stay under Vercel
// Hobby's 12-serverless-function cap — same auth gate, same PATCH method, disjoint body shape:
// visibility requests carry { id, kind, is_public: boolean } (no `type`/`pinned`), pin requests
// carry { id|items, type, pinned } (no `kind`/`is_public`), so dispatch-by-shape is unambiguous.
// This is the ONLY code path that may set is_public; POST create routes never read it from the
// request body (see api/share.js, api/diagram.js, api/archify.js).
import { isAuthenticated, checkAuthAndRefresh } from './auth.js';
import { tableFor, isValidId, patchRow } from './_lib/access.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function setPinned(id, type, pinned) {
  const table = type === 'diagram' ? 'mdshare_diagrams' : 'mdshare_pastes';
  const patch = pinned
    ? { expires_at: '2099-12-31T00:00:00Z', pinned: true }
    : { pinned: false };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }
  );
  return r.ok ? { id, ok: true } : { id, ok: false, error: await r.text() };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  if (!checkAuthAndRefresh(req, res)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  body = body || {};

  // Visibility-toggle shape: { id, kind, is_public } — formerly api/visibility.js. Dispatch on
  // `kind` presence alone (not is_public's type) so an invalid is_public value still gets the
  // correct 400 validation error below instead of silently falling through to pin logic.
  if (body.kind !== undefined) {
    const table = tableFor(body.kind);
    if (!table) {
      return res.status(400).json({ error: 'Invalid kind. Must be one of: paste, diagram, archify.' });
    }
    if (!isValidId(body.id)) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (typeof body.is_public !== 'boolean') {
      return res.status(400).json({ error: 'is_public must be a boolean' });
    }
    const result = await patchRow(table, body.id, { is_public: body.is_public });
    if (!result.ok) {
      return res.status(result.status || 500).json({ error: result.error || 'Update failed' });
    }
    return res.status(200).json({ ok: true, id: body.id, kind: body.kind, is_public: body.is_public });
  }

  // pinned defaults to true (pin). Pass pinned:false to unpin.
  const pinned = body.pinned === undefined ? true : !!body.pinned;

  // Normalize to a list of {id, type}
  let items = [];
  if (Array.isArray(body.items) && body.items.length) {
    items = body.items;
  } else if (body.id) {
    items = [{ id: body.id, type: body.type }];
  }

  items = items.filter(it => it && typeof it.id === 'string' && it.id.length);
  if (!items.length) {
    return res.status(400).json({ error: 'Missing id(s)' });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: 'Too many items (max 100)' });
  }

  const results = await Promise.all(items.map(it => setPinned(it.id, it.type, pinned)));
  const failed = results.filter(r => !r.ok);

  if (failed.length) {
    return res.status(failed.length === results.length ? 500 : 207).json({
      ok: false,
      pinned,
      succeeded: results.length - failed.length,
      failed,
    });
  }

  return res.status(200).json({ ok: true, pinned, count: results.length });
}
