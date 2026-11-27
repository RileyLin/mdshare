// Small helpers shared by the three create/read/delete content APIs (share.js, diagram.js,
// archify.js). Underscore directory: not a Vercel function.
import { checkAuthAndRefresh } from './session.js';

export const KEEP_UNTIL = '2099-12-31T00:00:00Z';

// Create limits shared by the three create routes (ADV-MU-B 4, 2026-11-27): per IP and per hour,
// and the size of one paste or diagram (characters of its text fields). Archify HTML is a whole
// self-contained page (~600 KB each in production), so only an anonymous archify create is held to
// MAX_PASTE_SIZE; a signed-in one may be up to MAX_ARCHIFY_SIZE.
export const CREATES_PER_HOUR = 50;
export const MAX_PASTE_SIZE = 100000;
export const MAX_ARCHIFY_SIZE = 2000000;
export const FORMAT_GUIDE_PATH = '/llms.txt';

// `keep: true` on create makes the item never expire. Honoured only for a signed-in user (cookie;
// the row is theirs) or an already-validated agent token; anonymous creates can't make permanent
// rows (abuse/storage).
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

// Links inside error/hint bodies (the guide) point at the canonical site, or at a loopback dev
// server; never at whatever Host header the request sent (adversarial review 2026-11-26).
export const SITE_ORIGIN = 'https://mdshare-rileylins-projects.vercel.app';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
export function siteOrigin(req) {
  const host = String((req && req.headers && req.headers.host) || '');
  return LOOPBACK_HOST.test(host) ? `http://${host}` : SITE_ORIGIN;
}
export const guideUrl = (req) => `${siteOrigin(req)}${FORMAT_GUIDE_PATH}`;

export function baseUrl(req) {
  const host = req.headers.host || new URL(SITE_ORIGIN).host;
  const protocol = host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${protocol}://${host}`;
}
