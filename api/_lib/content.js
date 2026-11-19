// Small helpers shared by the three create/read/delete content APIs (share.js, diagram.js,
// archify.js). Underscore directory: not a Vercel function.
import { checkAuthAndRefresh } from '../auth.js';

export const KEEP_UNTIL = '2099-12-31T00:00:00Z';
export const FORMAT_GUIDE_PATH = '/llms.txt';

// `keep: true` on create makes the item never expire. Honoured only for the owner (cookie) or an
// already-validated agent token; anonymous creates can't make permanent rows (abuse/storage).
export function wantsKeep(body, req, res, agentAuth) {
  if (!body || body.keep !== true) return false;
  if (agentAuth && agentAuth.valid) return true;
  return checkAuthAndRefresh(req, res) === true;
}

export function expiryFields(ttlSeconds, keep) {
  return keep
    ? { expires_at: KEEP_UNTIL, pinned: true }
    : { expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(), pinned: false };
}

export function baseUrl(req) {
  const host = req.headers.host || 'mdshare-rileylins-projects.vercel.app';
  const protocol = host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${protocol}://${host}`;
}

// Owner-only DELETE by id. Uses encodeURIComponent like every other PostgREST filter.
export async function deleteRow(table, id) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`, apikey: process.env.SUPABASE_SERVICE_KEY, Prefer: 'return=minimal' },
  });
  if (!res.ok) throw new Error(`Supabase delete failed: ${res.status}`);
}
