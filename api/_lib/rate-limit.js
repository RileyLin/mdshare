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

export function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}
