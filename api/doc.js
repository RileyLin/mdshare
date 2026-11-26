// /api/doc — the reading loop around a document (migration 009). Owner + agent surface:
//   POST ?action=read      owner only. Read receipt beacon {id, scroll 0-100, seconds, open}. 204.
//   GET  ?action=reads     owner | activity:read. ?ids=a,b,c  or  ?unread=1&days=7
//   POST ?action=feedback  owner only. {id, kind, quote, note, context} -> {ok, feedback}
//   GET  ?action=feedback  owner | activity:read. ?id=<doc>  and/or  ?status=open|resolved|dismissed
//   POST ?action=resolve   owner | activity:write. {ids, status, resolved_in}
//   GET  ?action=versions  owner | documents:read. ?id=<doc> -> oldest..newest chain
//   GET  ?action=search    owner | documents:read. ?q=<text>&limit&offset -> titles + snippets
//                          (api/_lib/search.js: one rpc call, the text never enters a filter string;
//                          SEARCH_RATE_LIMIT a minute per token, or per IP for the owner session -> 429)
//   GET  ?action=collection   owner | documents:read. No slug: every collection with counts;
//                          ?slug=<slug>: its table of contents (api/_lib/collections.js, 3 queries)
//   POST ?action=collection   owner | documents:write or documents:publish (tokens: rows they created).
//                          {id, collection: <slug>|null} for the document's whole version family
//   POST ?action=translation  same auth. {id, translation_of: <id>|null, lang?: zh|en}; the target is
//                          gated like a version parent (canUseParent)
// Every action is declared in ACTIONS with its `auth`; scripts/check-invariants.mjs fails if one
// isn't. This file never writes directly: activity writes go through api/_lib/activity.js (activity
// tables only) and metadata writes through api/_lib/collections.js patchMeta (lang, translation_of,
// collection only), so nothing here can change stored content, visibility or expiry.
import { getRow, isValidId, setPrivacyHeaders } from './_lib/access.js';
import { resolveAgentToken } from './_lib/agent-tokens.js';
import { parseJsonBody } from './_lib/body.js';
import { withErrors } from './_lib/events.js';
import { validateSearch, searchDocs } from './_lib/search.js';
import { refusalHint, authHint, HINTS } from './_lib/raw.js';
import { rateLimiter, clientIp } from './_lib/rate-limit.js';
import {
  allowed, recordRead, listReads, validateFeedback, createFeedback, listFeedback, resolveFeedback, versionChain, FEEDBACK_STATUSES,
  canUseParent, translationFields, translationRoot, parseLang,
} from './_lib/activity.js';
import { parseCollection, SLUG_HINT, canEditMeta, familyFilter, patchMeta, listCollections, collectionToc } from './_lib/collections.js';

// Search is the costly read (a LIKE scan over every row for a short query): cap each credential.
export const SEARCH_RATE_LIMIT = 60;
const searchRate = rateLimiter({ limit: SEARCH_RATE_LIMIT, windowMs: 60 * 1000 });

const ACTIONS = {
  read: {
    auth: 'owner', httpMethod: 'POST', silent: true,
    async run({ body }) {
      if (!isValidId(body.id)) return [400, { error: 'Missing or invalid id' }];
      const { row, dbError } = await getRow('mdshare_pastes', body.id, 'id,expires_at');
      if (dbError) return [503, { error: 'Temporarily unavailable' }];
      if (!row) return [404, { error: 'Not found or expired' }];
      await recordRead(body.id, { scroll: body.scroll, seconds: body.seconds, open: body.open === true });
      return [204, null];
    },
  },
  reads: {
    auth: 'owner|activity:read', httpMethod: 'GET',
    async run({ query }) {
      if (query.unread === '1' || query.unread === 'true') return [200, { items: await listReads({ unread: true, days: Number(query.days) || 7 }) }];
      const ids = String(query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return [400, { error: 'Pass ids=a,b,c or unread=1' }];
      return [200, { items: await listReads({ ids }) }];
    },
  },
  feedback: {
    auth: { POST: 'owner', GET: 'owner|activity:read' }, httpMethod: ['POST', 'GET'],
    async run({ method, body, query }) {
      if (method === 'GET') {
        const docId = query.id ? String(query.id) : null;
        if (docId && !isValidId(docId)) return [400, { error: 'Invalid id' }];
        const status = query.status ? String(query.status) : null;
        if (status && !FEEDBACK_STATUSES.includes(status)) return [400, { error: `status must be one of ${FEEDBACK_STATUSES.join(', ')}` }];
        return [200, { items: await listFeedback({ docId, status }) }];
      }
      const v = validateFeedback(body);
      if (v.error) return [400, { error: v.error }];
      const { row, dbError } = await getRow('mdshare_pastes', v.value.doc_id, 'id,expires_at');
      if (dbError) return [503, { error: 'Temporarily unavailable' }];
      if (!row) return [404, { error: 'Not found or expired' }];
      return [200, { ok: true, feedback: await createFeedback(v.value) }];
    },
  },
  resolve: {
    auth: 'owner|activity:write', httpMethod: 'POST',
    async run({ body }) {
      const r = await resolveFeedback({ ids: body.ids || body.id, status: body.status || 'resolved', resolvedIn: body.resolved_in ?? null });
      return r.error ? [400, { error: r.error }] : [200, { ok: true, ...r }];
    },
  },
  versions: {
    auth: 'owner|documents:read', httpMethod: 'GET',
    async run({ query }) {
      if (!isValidId(query.id)) return [400, { error: 'Missing or invalid id' }];
      const chain = await versionChain(String(query.id));
      return chain ? [200, { id: query.id, versions: chain }] : [404, { error: 'Not found' }];
    },
  },
  search: {
    auth: 'owner|documents:read', httpMethod: 'GET',
    async run({ query, req, res, agentAuth }) {
      const v = validateSearch(query);
      if (v.error) return [400, { error: v.error }];
      const rate = searchRate.check(agentAuth.valid ? `token:${agentAuth.id}` : `owner:${clientIp(req)}`);
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfter));
        return [429, { error: `Too many searches: at most ${SEARCH_RATE_LIMIT} a minute. Retry in ${rate.retryAfter}s.`, retry_after: rate.retryAfter }];
      }
      const r = await searchDocs(v.value);
      return r.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, r];
    },
  },
  collection: {
    auth: { GET: 'owner|documents:read', POST: 'owner|documents:write,documents:publish' }, httpMethod: ['GET', 'POST'],
    async run({ method, body, query, req, res, agentAuth }) {
      if (method === 'GET') {
        if (query.slug === undefined || query.slug === '') {
          const all = await listCollections();
          return all.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, { collections: all.items }];
        }
        const slug = parseCollection(query.slug);
        if (!slug) return [400, { error: SLUG_HINT }];
        const toc = await collectionToc(slug);
        return toc.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, { slug, items: toc.items, truncated: toc.truncated, url: `/c/${slug}` }];
      }
      const coll = parseCollection(body.collection);
      if (coll === undefined || body.collection === undefined) return [400, { error: `${SLUG_HINT}; send "collection": null to remove it` }];
      const e = await canEditMeta(body.id, req, res, agentAuth);
      if (!e.ok) return [e.status, { error: e.error }];
      const w = await patchMeta(familyFilter(e.row, e.owner ? null : agentAuth.id), { collection: coll });
      return w.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, { ok: true, id: e.row.id, collection: coll, updated: w.ids }];
    },
  },
  translation: {
    auth: 'owner|documents:write,documents:publish', httpMethod: 'POST',
    async run({ body, req, res, agentAuth }) {
      const lang = parseLang(body.lang);
      if (lang === undefined) return [400, { error: 'lang must be "zh" or "en"' }];
      const e = await canEditMeta(body.id, req, res, agentAuth);
      if (!e.ok) return [e.status, { error: e.error }];
      const patch = lang ? { lang } : {};
      if (body.translation_of === null) patch.translation_of = null;
      else if (body.translation_of !== undefined) {
        const t = await canUseParent(body.translation_of, req, res, agentAuth);
        if (t.dbError) return [503, { error: 'Temporarily unavailable' }];
        if (!t.ok) return [404, { error: 'translation_of not found, expired, or not readable with this credential' }];
        const own = e.row.root_id || e.row.id;
        const link = translationFields(t.row).translation_of;
        if ((t.row.root_id || t.row.id) === own || link === own) return [400, { error: 'translation_of is this document or already its translation; link the translation to the original instead' }];
        const myLang = lang || e.row.lang;
        if (!myLang) return [400, { error: 'This document has no lang yet: send "lang": "zh" or "en" with the link' }];
        if (t.row.lang && t.row.lang === myLang) return [400, { error: `translation_of is already a ${myLang} document; set lang to the other language` }];
        patch.translation_of = link;
      }
      if (!Object.keys(patch).length) return [400, { error: 'Send translation_of (an id, or null to unlink) and/or lang' }];
      const w = await patchMeta(familyFilter(e.row, e.owner ? null : agentAuth.id), patch);
      return w.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, { ok: true, id: e.row.id, ...patch, group: patch.translation_of === undefined ? translationRoot(e.row) : (patch.translation_of || null), updated: w.ids }];
    },
  },
};

async function handler(req, res) {
  setPrivacyHeaders(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const body = req.method === 'POST' ? (parseJsonBody(req.body) || {}) : {};
  const name = String((req.query && req.query.action) || body.action || '');
  const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  if (!action) return res.status(400).json({ error: `Unknown action. Use one of: ${Object.keys(ACTIONS).join(', ')}`, guide: '/llms.txt' });
  const methods = Array.isArray(action.httpMethod) ? action.httpMethod : [action.httpMethod];
  if (!methods.includes(req.method)) return res.status(405).json({ error: `${name} takes ${methods.join(' or ')}` });

  const auth = typeof action.auth === 'string' ? action.auth : action.auth[req.method];
  const scope = auth.includes('|') ? auth.split('|')[1].split(',').join(' ') : null;
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present && !agentAuth.valid) return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid, scope });
  if (!allowed(auth, req, res, agentAuth)) {
    // The read beacon answers 204 either way, so a page can't tell who is signed in from it.
    if (action.silent) return res.status(204).end();
    if (agentAuth.valid) return res.status(403).json({ error: `This token needs the ${String(scope).split(' ').join(' or ')} scope`, guide: '/llms.txt' });
    // Refused anyway: a token sent as x-api-key / ?key= only changes the hint (api/_lib/raw.js refusalHint).
    return authHint(req, res, { error: scope ? `Sign in as the owner, or send Authorization: Bearer <token> with the ${scope} scope` : 'Owner only', hint: refusalHint(req, HINTS.missing), scope });
  }

  const [status, payload] = await action.run({ method: req.method, body, query: req.query || {}, req, res, agentAuth });
  if (payload === null) return res.status(status).end();
  return res.status(status).json(payload);
}

export const _ACTIONS = ACTIONS;
export default withErrors('doc', handler);
