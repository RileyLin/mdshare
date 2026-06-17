// PATCH /api/pin — pin/unpin paste(s) or diagram(s) [auth-gated]
// Supports:
//   single:  { id, type, pinned? }            (pinned defaults true; backward compat)
//   batch:   { items: [{ id, type }], pinned? }
// Pinning extends expires_at to 2099 + sets pinned=true.
// Unpinning sets pinned=false (expires_at left as-is; pinned items already pushed to 2099).
import { isAuthenticated } from './auth.js';

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

  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  body = body || {};

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
