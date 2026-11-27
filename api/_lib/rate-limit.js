// In-memory fixed-window rate limiter, the same best-effort scheme as api/share.js, api/auth.js and
// api/health.js: each serverless instance counts on its own, which bounds a tight loop from one
// credential without any database work. Underscore directory: not a Vercel function.
export function rateLimiter({ limit, windowMs }) {
  const hits = new Map(); // key -> { count, resetAt }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }, Math.max(windowMs, 60 * 1000));
  sweep.unref?.();
  return {
    limit,
    // { allowed, remaining, retryAfter (seconds, when refused) }. Counts only allowed calls.
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now > entry.resetAt) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: limit - 1 };
      }
      if (entry.count >= limit) return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
      entry.count += 1;
      return { allowed: true, remaining: limit - entry.count };
    },
  };
}

// The client address every per-IP limit is keyed on (sign-up, entry links, password login, creates,
// client errors, doc reads). The one place that reads these headers (invariant "client-ip-one-helper").
//
// Trust boundary: a header is only as good as the proxy that set it. On Vercel (this app's only
// deployment) the edge sets x-vercel-forwarded-for and x-real-ip to the connecting client and
// overwrites any value the client sent; it also overwrites x-forwarded-for (no trusted-proxy add-on).
// A proxy chain APPENDS to x-forwarded-for, so its first hop is whatever the client wrote and only
// the last hop was added by the proxy nearest to us: never key on the first hop (ADV-MU-B 1). Order:
// x-vercel-forwarded-for, x-real-ip, the last x-forwarded-for hop, the socket address.
// Self-hosting or putting another CDN in front of Vercel moves the boundary: that proxy must set
// x-real-ip itself (overwriting the client's), or a client can pick its own rate-limit key.
const lastHop = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || '';
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const ip = lastHop(h['x-vercel-forwarded-for']) || lastHop(h['x-real-ip']) || lastHop(h['x-forwarded-for']) || req?.socket?.remoteAddress || 'unknown';
  return String(ip).slice(0, 64);
}
