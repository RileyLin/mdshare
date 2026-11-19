// Production error log (table mdshare_events, migration 008). Two writers:
//   - withErrors(route, handler): wraps every API handler so an uncaught exception is recorded as
//     a server_error and answered with a plain 500 instead of crashing silently.
//   - api/health.js POST: client_error reports sent by /assets/errors.js from browsers.
// The monitor (e2e/release-check.mjs --mode monitor) reads counts back through GET /api/health.
// Recording never throws: monitoring must not take the site down with it.

export const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 12);

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

export async function recordEvent(kind, message, detail) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return false;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/mdshare_events`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        apikey: process.env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ kind: clip(kind, 40), message: clip(message, 500), detail: detail || null, commit: COMMIT }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export function withErrors(route, handler) {
  return async function wrapped(req, res) {
    try {
      return await handler(req, res);
    } catch (err) {
      const message = (err && err.message) || String(err);
      console.error(`[server_error] ${route}: ${message}`);
      await recordEvent('server_error', `${route}: ${message}`, { route, method: req && req.method, stack: clip(err && err.stack, 2000) });
      if (res && !res.headersSent) {
        try { res.status(500).json({ error: 'Internal error' }); } catch { /* response already gone */ }
      }
      return undefined;
    }
  };
}
