// POST /api/share — accepts markdown, returns a shareable URL (public, rate-limited). Always
//   creates a PRIVATE row (is_public: false) — visibility can only be changed via the auth-gated
//   PATCH /api/visibility endpoint, never from this request body.
// GET  /api/share?id=xxx — returns raw markdown. Private unless the owner is authenticated or the
//   row has is_public: true.
// PATCH /api/share — updates content for an existing paste (auth-gated). Never touches is_public.
import { isAuthenticated } from './auth.js';
import { getRow, isVisible, setPrivacyHeaders } from './_lib/access.js';
import { randomBytes } from 'crypto';

// --- Rate Limiting (in-memory, per Vercel serverless instance) ---
// Vercel functions can be cold-started, so this is "best effort" rate limiting.
// For a personal tool this is more than sufficient. Each function instance tracks its own map.
const rateLimitMap = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 50;         // max 50 pastes per IP per hour
const RATE_WINDOW = 60 * 60 * 1000; // 1 hour in ms
const MAX_PASTE_SIZE = 100000; // 100KB max per paste

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  if (entry.count >= RATE_LIMIT) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, retryAfter };
  }
  
  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

// Clean up stale entries periodically (prevent memory leak in long-lived instances)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000); // every 5 min

function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 255) : null;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseSet(id, content, ttlSeconds) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const title = extractTitle(content);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mdshare_pastes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    // Explicit field list (never a body spread): is_public is always false on create, regardless
    // of anything a caller puts in the request body. Making it public requires the authenticated
    // PATCH /api/visibility endpoint.
    body: JSON.stringify({ id, content, expires_at: expiresAt, title, is_public: false }),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status}`);
}

// Note: DELETE/PATCH here are auth-gated (owner-only) and already used encodeURIComponent for
// injection safety before this change. They intentionally do NOT add the strict nanoid-shaped
// isValidId() check that the anonymous-facing GET path below uses, so a pre-existing owner-created
// row with an unusual id (see tests/delete-flow.test.mjs) can still be managed.
async function supabaseDelete(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        Prefer: 'return=minimal',
      },
    }
  );
  if (!res.ok) throw new Error(`Supabase delete failed: ${res.status}`);
}

async function supabaseUpdate(id, content) {
  const title = extractTitle(content);
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/mdshare_pastes?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      // content/title only — is_public is never touched by this route.
      body: JSON.stringify({ content, title }),
    }
  );
  if (!res.ok) throw new Error(`Supabase update failed: ${res.status}`);
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const ALLOWED_ORIGINS = ['https://mdshare-rileylins-projects.vercel.app', 'http://localhost:3000', 'http://localhost:5173'];
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    // Rate limit by IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(ip);
    
    res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT));
    res.setHeader('X-RateLimit-Remaining', String(rateCheck.remaining));
    
    if (!rateCheck.allowed) {
      res.setHeader('Retry-After', String(rateCheck.retryAfter));
      return res.status(429).json({ 
        error: 'Rate limit exceeded. Max 50 pastes per hour.',
        retry_after: rateCheck.retryAfter,
        tip: 'Deploy your own instance for unlimited use: github.com/RileyLin/mdshare'
      });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const markdown = body?.markdown || body?.content || body?.md;
    if (!markdown || typeof markdown !== 'string') {
      return res.status(400).json({ error: 'Missing markdown field' });
    }

    // Size limit
    if (markdown.length > MAX_PASTE_SIZE) {
      return res.status(413).json({ 
        error: `Paste too large. Max ${MAX_PASTE_SIZE / 1000}KB.`,
        tip: 'Deploy your own instance for larger pastes: github.com/RileyLin/mdshare'
      });
    }

    const ttl = Math.min(parseInt(body?.ttl) || 86400, 604800); // max 7 days
    const id = nanoid();

    await supabaseSet(id, markdown, ttl);

    const host = req.headers.host || 'mdshare.vercel.app';
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const url = `${protocol}://${host}/v/${id}`;

    return res.status(200).json({ url, id, expires_in: ttl });
  }

  if (req.method === 'PATCH') {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    const { id, content } = body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });

    await supabaseUpdate(id, content);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const id = req.query?.id || (typeof req.body === 'object' ? req.body?.id : undefined);
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });
    await supabaseDelete(id);
    return res.status(200).json({ ok: true, deleted: id });
  }

  if (req.method === 'GET') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });

    setPrivacyHeaders(res);
    const { row, dbError } = await getRow('mdshare_pastes', id, 'content,expires_at,is_public');
    if (dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
    if (!row || !isVisible(row, req)) return res.status(404).json({ error: 'Not found or expired' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(row.content);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
