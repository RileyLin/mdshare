// /api/health
//   GET                      -> { ok, commit, db } — public liveness + which commit is live. The release
//                               check waits for `commit` to match the commit it just shipped.
//   GET  ?events=1&since=<minutes>, header x-monitor-key: <MDSHARE_MONITOR_KEY>
//                            -> error counts and recent messages for the monitor. 404 without the key.
//   POST { type: 'client_error', message, source, line, col, page }
//                            -> records a browser error (from /assets/errors.js). Rate-limited, size-capped,
//                               no cookies or document content stored.
import { timingSafeEqual } from 'crypto';
import { parseJsonBody } from './_lib/body.js';
import { recordEvent, withErrors, COMMIT } from './_lib/events.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const hits = new Map(); // ip -> { n, reset }
const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now > v.reset) hits.delete(k); }, 10 * 60 * 1000);
sweep.unref?.();
function allow(ip) {
  const now = Date.now(), h = hits.get(ip);
  if (!h || now > h.reset) { hits.set(ip, { n: 1, reset: now + 10 * 60 * 1000 }); return true; }
  h.n += 1;
  return h.n <= 30;
}

function keyOk(given) {
  const want = process.env.MDSHARE_MONITOR_KEY || '';
  if (!want || typeof given !== 'string' || given.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));
// Keep the path only: query strings and fragments can carry tokens or search text, and document
// ids are replaced by :id so the error log never says which document someone was reading.
const pathOnly = (u) => {
  try { return new URL(String(u), 'https://x').pathname.replace(/^\/(v|d|a|raw)\/[^/]+/, '/$1/:id').slice(0, 200); } catch { return null; }
};

async function dbPing() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/mdshare_pastes?select=id&limit=1`, { headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY } });
    return r.ok ? 'ok' : `error ${r.status}`;
  } catch (e) {
    return 'unreachable';
  }
}

async function eventSummary(sinceMinutes) {
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
  const r = await fetch(`${SUPABASE_URL}/rest/v1/mdshare_events?select=kind,message,commit,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=500`, {
    headers: { Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY },
  });
  if (!r.ok) return { error: `events query failed: ${r.status}` };
  const rows = await r.json();
  const counts = {}, top = {};
  for (const e of rows) {
    counts[e.kind] = (counts[e.kind] || 0) + 1;
    const k = `${e.kind}: ${e.message}`;
    top[k] = (top[k] || 0) + 1;
  }
  return { since, total: rows.length, counts, top: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([m, n]) => ({ n, m })) };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'GET') {
    if (req.query && req.query.events) {
      if (!keyOk(req.headers['x-monitor-key'])) return res.status(404).json({ error: 'Not found' });
      const minutes = Math.min(Math.max(parseInt(req.query.since, 10) || 60, 1), 7 * 24 * 60);
      return res.status(200).json({ commit: COMMIT, ...(await eventSummary(minutes)) });
    }
    const db = await dbPing();
    return res.status(db === 'ok' ? 200 : 503).json({ ok: db === 'ok', commit: COMMIT, db });
  }

  if (req.method === 'POST') {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    if (!allow(ip)) return res.status(429).end();
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw.length > 4096) return res.status(413).end();
    const body = parseJsonBody(req.body) || {};
    if (body.type !== 'client_error' || typeof body.message !== 'string') return res.status(400).json({ error: 'Expected { type: "client_error", message }' });
    await recordEvent('client_error', clip(body.message, 300), {
      source: pathOnly(body.source), line: Number(body.line) || null, col: Number(body.col) || null,
      page: pathOnly(body.page), stack: clip(body.stack, 1500),
    });
    return res.status(204).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrors('health', handler);
