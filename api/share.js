// POST /api/share — accepts markdown, returns a shareable URL (public, rate-limited). Always
//   creates a PRIVATE row (is_public: false) — visibility can only be changed via the auth-gated
//   PATCH /api/visibility endpoint, never from this request body.
// GET  /api/share?id=xxx (/raw/:id) — returns raw markdown through api/_lib/raw.js, the same read
//   path /v/:id uses for Bearer requests: owner, public, documents:read token, or the token's own row.
// PATCH /api/share — updates content for an existing paste (auth-gated). Never touches is_public.
import { checkAuthAndRefresh } from './auth.js';
import { sendRawMarkdown, authHint, HINTS } from './_lib/raw.js';
import { parseJsonBody } from './_lib/body.js';
import { resolveAgentToken, hasScope, isLegacyToken } from './_lib/agent-tokens.js';
import { randomBytes } from 'crypto';
import { wantsKeep, expiryFields, baseUrl, guideUrl, FORMAT_GUIDE_PATH } from './_lib/content.js';
import { withErrors } from './_lib/events.js';
import { lintMarkdown } from './_lib/lint.js';
import { canUseParent, versionFields, translationFields, parseLang, detectLang } from './_lib/activity.js';
import { parseCollection, SLUG_HINT } from './_lib/collections.js';

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
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000); // every 5 min
rateLimitCleanup.unref?.();

function nanoid(size = 10) {
  return randomBytes(size).toString('base64url').slice(0, size);
}

function extractTitle(markdown) {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].trim().slice(0, 255) : null;
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function supabaseSet(id, content, ttlSeconds, createdByToken, keep, links = {}) {
  const { expires_at: expiresAt, pinned } = expiryFields(ttlSeconds, keep);
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
    // PATCH /api/visibility endpoint. created_by_token is set only from a server-validated bearer
    // token (see handler below) — never read from the request body either.
    // parent_id/root_id/version_no/origin come from the handler after canUseParent()/cleanOrigin()
    // (migrations 009, 010). root_id + version_no are stored so reads never walk the chain.
    // lang/translation_of/collection (migration 012): translation_of only from translationFields()
    // of a row canUseParent() allowed, or inherited from the gated parent ("translation-gated").
    body: JSON.stringify({ id, content, expires_at: expiresAt, pinned, title, is_public: false, created_by_token: createdByToken || null, parent_id: links.parentId || null, root_id: links.rootId || null, version_no: links.versionNo || null, origin: links.origin || null, lang: links.lang || null, translation_of: links.translationOf || null, collection: links.collection || null }),
  });
  if (!res.ok) throw new Error(`Supabase insert failed: ${res.status}`);
}

// Note: DELETE/PATCH here are auth-gated (owner-only) and already used encodeURIComponent for
// injection safety before this change. They intentionally do NOT add the strict nanoid-shaped
// isValidId() check that the anonymous-facing GET path below uses, so a pre-existing owner-created
// row with an unusual id (see tests/delete-flow.test.mjs) can still be managed.
function cleanOrigin(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, 200);
  return /^[\w:.@/#+-]{1,200}$/.test(s) ? s : null;
}

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

async function handler(req, res) {
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
    // Per-agent bearer tokens (api/_lib/agent-tokens.js): absent Authorization header -> unchanged
    // anonymous-create path below. Present-but-invalid (malformed/unknown/revoked/expired) -> hard
    // 401, never a silent fallback to anonymous creation.
    const agentAuth = await resolveAgentToken(req);
    if (agentAuth.present && !agentAuth.valid) {
      return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid });
    }
    // Scoped tokens (added 2026-10-08): a token minted with an explicit `scopes` array needs
    // documents:write to create. A legacy token (scopes === null, i.e. every token that predates
    // this change, or a new one deliberately issued without a `scopes` field) is completely
    // unaffected by this check — isLegacyToken() short-circuits it, preserving unconditional
    // create exactly as before (AGENT-SEARCH-PLAN.md constraint 3).
    if (agentAuth.valid && !isLegacyToken(agentAuth) && !hasScope(agentAuth, 'documents:write')) {
      return res.status(403).json({ error: 'Token missing documents:write scope' });
    }

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

    let body = parseJsonBody(req.body);

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

    const keep = wantsKeep(body, req, res, agentAuth);
    const trusted = agentAuth.valid || checkAuthAndRefresh(req, res) === true;

    // Versions: `parent` makes this document the next version of an existing one. Only the owner
    // or a token that can read the parent may do it (canUseParent); otherwise 404, never a silent
    // unlinked create, so an agent learns its revision did not link. A new version keeps the
    // parent's language, translation link and collection unless the request sets them.
    let parentId = null;
    let version = {};
    let inherited = {};
    if (body?.parent != null) {
      const p = await canUseParent(body.parent, req, res, agentAuth);
      if (p.dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
      if (!p.ok) return res.status(404).json({ error: 'parent not found, expired, or not readable with this credential', guide: guideUrl(req) });
      parentId = p.row.id;
      version = versionFields(p.row);
      inherited = { lang: p.row.lang || null, translationOf: p.row.translation_of || null, collection: p.row.collection || null };
    }

    // Languages (migration 012): `lang` zh|en, and `translation_of` links this document to the same
    // text in the other language. Linking is gated exactly like `parent` (canUseParent: owner,
    // documents:read, or the token's own row; never because the target is public).
    const lang = parseLang(body?.lang);
    if (lang === undefined) return res.status(400).json({ error: 'lang must be "zh" or "en"', guide: guideUrl(req) });
    let docLang = lang || inherited.lang || null;
    let translationOf = inherited.translationOf || null;
    let targetCollection = null;
    if (body?.translation_of != null) {
      const t = await canUseParent(body.translation_of, req, res, agentAuth);
      if (t.dbError) return res.status(503).json({ error: 'Temporarily unavailable' });
      if (!t.ok) return res.status(404).json({ error: 'translation_of not found, expired, or not readable with this credential', guide: guideUrl(req) });
      if (version.root_id && (t.row.root_id || t.row.id) === version.root_id) return res.status(400).json({ error: 'translation_of is a version of this same document; use parent for a revision' });
      docLang = docLang || detectLang(markdown);
      if (t.row.lang && t.row.lang === docLang) return res.status(400).json({ error: `translation_of is already a ${docLang} document; set lang to the other language` });
      translationOf = translationFields(t.row).translation_of;
      targetCollection = t.row.collection || null;
    }

    // Collections: honoured for the owner or a valid token (like origin); anonymous creates can't
    // put documents into the owner's collections. Versions and translations inherit it.
    const coll = parseCollection(body?.collection);
    if (coll === undefined) return res.status(400).json({ error: SLUG_HINT, guide: guideUrl(req) });
    const collection = trusted ? (coll || inherited.collection || targetCollection || null) : null;

    // Where feedback on this document should be sent (an agent's session or chat id). Stored only
    // for the owner or a valid token; anonymous creates can't plant routing data.
    const origin = trusted ? cleanOrigin(body?.origin) : null;

    await supabaseSet(id, markdown, ttl, agentAuth.valid ? agentAuth.id : null, keep, { parentId, rootId: version.root_id, versionNo: version.version_no, origin, lang: docLang, translationOf, collection });

    const base = baseUrl(req);
    const out = { url: `${base}/v/${id}`, id, expires_in: keep ? null : ttl, kept: keep, format_guide: `${base}${FORMAT_GUIDE_PATH}`, checks: lintMarkdown(markdown) };
    if (body?.keep === true && !keep) out.keep_ignored = 'keep:true needs the owner session or an agent token (Authorization: Bearer <token>); this document expires normally.';
    if (parentId) out.parent = parentId;
    if (origin) out.origin = origin;
    if (docLang) out.lang = docLang;
    if (translationOf) out.translation_of = translationOf;
    if (collection) out.collection = collection;
    if (coll && !trusted) out.collection_ignored = 'collection needs the owner session or an agent token (Authorization: Bearer <token>); this document is in no collection.';
    return res.status(200).json(out);
  }

  if (req.method === 'PATCH') {
    if (!checkAuthAndRefresh(req, res)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let body = parseJsonBody(req.body);

    const { id, content } = body || {};
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'Missing content' });

    await supabaseUpdate(id, content);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!checkAuthAndRefresh(req, res)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const id = req.query?.id || (typeof req.body === 'object' ? req.body?.id : undefined);
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing id' });
    await supabaseDelete(id);
    return res.status(200).json({ ok: true, deleted: id });
  }

  // Raw Markdown: the same read path as /v/:id with a Bearer token (api/_lib/raw.js).
  if (req.method === 'GET') return sendRawMarkdown(req, res);

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrors('share', handler);
