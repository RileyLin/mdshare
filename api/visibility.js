// PATCH /api/visibility — owner-only publish/unpublish toggle for paste/diagram/archify.
// Body: { id, kind: 'paste' | 'diagram' | 'archify', is_public: boolean }
//
// This is the ONLY route in the app that may change is_public. Creation (POST) routes build
// explicit Supabase insert payloads and always set is_public: false themselves — they never read
// is_public from the request body, so this endpoint cannot be bypassed by posting is_public on
// create.
import { isAuthenticated, checkAuthAndRefresh } from './auth.js';
import { tableFor, isValidId, patchRow } from './_lib/access.js';

const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });

  // Auth-only: anonymous requests (including the public paste/diagram/archify creation flow)
  // can never flip visibility.
  if (!checkAuthAndRefresh(req, res)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch {}
  }
  body = body || {};

  const { id, kind } = body;
  const table = tableFor(kind);
  if (!table) {
    return res.status(400).json({ error: 'Invalid kind. Must be one of: paste, diagram, archify.' });
  }
  if (!isValidId(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  if (typeof body.is_public !== 'boolean') {
    return res.status(400).json({ error: 'is_public must be a boolean' });
  }

  const result = await patchRow(table, id, { is_public: body.is_public });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error || 'Update failed' });
  }

  return res.status(200).json({ ok: true, id, kind, is_public: body.is_public });
}
