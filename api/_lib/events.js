// Production error log (table mdshare_events, migration 008). Two writers:
//   - withErrors(route, handler): wraps every API handler so an uncaught exception is recorded as
//     a server_error and answered with a plain 500 instead of crashing silently.
//   - api/health.js POST: client_error reports sent by /assets/errors.js from browsers.
// The monitor (e2e/release-check.mjs --mode monitor) reads counts back through GET /api/health.
// Recording never throws: monitoring must not take the site down with it.
// Multi-user (2026-11-27): an event row carries the signed-in user it happened to (owner_id via
// tenant.js insertOwned), or no owner; only the monitor reads them, and only as counts.
import { insertOwned, sessionOwner, dbConfigured, gateSession, Refused } from './tenant.js';

export const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 12);

const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

// `owner`: the request's principal (tenant.js sessionOwner) or null.
export async function recordEvent(kind, message, detail, owner = null) {
  if (!dbConfigured()) return false;
  try {
    await insertOwned('mdshare_events', owner, { kind: clip(kind, 40), message: clip(message, 500), detail: detail || null, commit: COMMIT });
    return true;
  } catch {
    return false;
  }
}

// The cookie user of a request, if any, without ever throwing (an event must always be recordable).
function requestOwner(req) {
  try { return req && req.headers ? sessionOwner(req) : null; } catch { return null; }
}

// Every handler: first the kill-switch gate on the session (tenant.js gateSession: a disabled user's
// cookie counts as nobody for this request), then the handler. A Refused (quota, disabled account,
// owner-only) is answered with its status; anything else is a recorded server_error and a plain 500.
export function withErrors(route, handler) {
  return async function wrapped(req, res) {
    try {
      await gateSession(req);
      return await handler(req, res);
    } catch (err) {
      if (err instanceof Refused) {
        if (res && !res.headersSent) {
          if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
          res.status(err.status).json({ error: err.message, ...(err.retryAfter ? { retry_after: err.retryAfter } : {}) });
        }
        return undefined;
      }
      const message = (err && err.message) || String(err);
      console.error(`[server_error] ${route}: ${message}`);
      await recordEvent('server_error', `${route}: ${message}`, { route, method: req && req.method, stack: clip(err && err.stack, 2000) }, requestOwner(req));
      if (res && !res.headersSent) {
        try { res.status(500).json({ error: 'Internal error' }); } catch { /* response already gone */ }
      }
      return undefined;
    }
  };
}
