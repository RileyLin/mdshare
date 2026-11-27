// In-memory Supabase for unit tests: starts e2e/fake-supabase.mjs and points global.fetch at it
// through node:http (so this sandbox's egress proxy, which wraps undici fetch, is never involved).
// Every request is recorded in `calls` so tests can assert what was (and wasn't) written.
import http from 'node:http';
import { startFakeSupabase } from '../e2e/fake-supabase.mjs';

export async function useFakeDb() {
  const sb = await startFakeSupabase({});
  const calls = [];
  const original = global.fetch;
  process.env.SUPABASE_URL = sb.url;
  global.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
    const u = new URL(String(url));
    const method = opts.method || 'GET';
    calls.push({ method, path: u.pathname, query: u.search, body: opts.body ? JSON.parse(opts.body) : null });
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text, json: async () => JSON.parse(text || 'null') });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
  return {
    sb,
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    async close() { global.fetch = original; await sb.close(); },
  };
}

export function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    json(value) { this.body = value; return this; },
    send(value) { this.body = value; return this; },
    end() { return this; },
  };
}

// Users (multi-user beta, migration 013). Lazy imports: tests set process.env before loading api/*.
// userCookie(uid): a valid v3 session cookie header value for user `uid` (user #1 is the owner,
// whose password login issues the same). asUser(uid): that user's tenant.js principal, for calling
// library functions (createToken, ...) directly.
export async function userCookie(uid) {
  const { signUserSession } = await import('../api/_lib/session.js');
  return `mdshare_auth=${encodeURIComponent(signUserSession(uid, Math.floor(Date.now() / 1000) + 3600))}`;
}

export async function asUser(uid = 1) {
  const { sessionOwner } = await import('../api/_lib/tenant.js');
  return sessionOwner({ headers: { cookie: await userCookie(uid) } });
}
