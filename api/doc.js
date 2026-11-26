// /api/doc — the reading loop around a document (migration 009). Owner + agent surface:
//   POST ?action=read      owner only. Read receipt beacon {id, scroll 0-100, seconds, open}. 204.
//   GET  ?action=reads     owner | activity:read. ?ids=a,b,c  or  ?unread=1&days=7
//   POST ?action=feedback  owner only. {id, kind, quote, note, context} -> {ok, feedback}
//   GET  ?action=feedback  owner | activity:read. ?id=<doc>  and/or  ?status=open|resolved|dismissed
//   POST ?action=resolve   owner | activity:write. {ids, status, resolved_in}
//   GET  ?action=versions  owner | documents:read. ?id=<doc> -> oldest..newest chain
//   GET  ?action=search    owner | documents:read. ?q=<text>&limit&offset -> titles + snippets
//                          (api/_lib/search.js: one rpc call, the text never enters a filter string)
// Every action is declared in ACTIONS with its `auth`; scripts/check-invariants.mjs fails if one
// isn't. This file never writes directly (all writes go through api/_lib/activity.js, which only
// accepts the activity tables), so nothing here can change stored content or visibility.
import { getRow, isValidId, setPrivacyHeaders } from './_lib/access.js';
import { resolveAgentToken } from './_lib/agent-tokens.js';
import { parseJsonBody } from './_lib/body.js';
import { withErrors } from './_lib/events.js';
import { validateSearch, searchDocs } from './_lib/search.js';
import { apiKeyMisuse, authHint, HINTS } from './_lib/raw.js';
import {
  allowed, recordRead, listReads, validateFeedback, createFeedback, listFeedback, resolveFeedback, versionChain, FEEDBACK_STATUSES,
} from './_lib/activity.js';

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
    async run({ query }) {
      const v = validateSearch(query);
      if (v.error) return [400, { error: v.error }];
      const r = await searchDocs(v.value);
      return r.dbError ? [503, { error: 'Temporarily unavailable' }] : [200, r];
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
  const scope = auth.includes('|') ? auth.split('|')[1] : null;
  // A token sent as x-api-key / ?key= is not a credential here; say how to send it (api/_lib/raw.js).
  if (!action.silent && apiKeyMisuse(req)) return authHint(req, res, { error: 'Unsupported credential', hint: HINTS.misplaced, scope });
  const agentAuth = await resolveAgentToken(req);
  if (agentAuth.present && !agentAuth.valid) return authHint(req, res, { error: 'Invalid or expired token', hint: HINTS.invalid, scope });
  if (!allowed(auth, req, res, agentAuth)) {
    // The read beacon answers 204 either way, so a page can't tell who is signed in from it.
    if (action.silent) return res.status(204).end();
    if (agentAuth.valid) return res.status(403).json({ error: `This token needs the ${scope} scope`, guide: '/llms.txt' });
    return authHint(req, res, { error: scope ? `Sign in as the owner, or send Authorization: Bearer <token> with the ${scope} scope` : 'Owner only', hint: HINTS.missing, scope });
  }

  const [status, payload] = await action.run({ method: req.method, body, query: req.query || {} });
  if (payload === null) return res.status(status).end();
  return res.status(status).json(payload);
}

export const _ACTIONS = ACTIONS;
export default withErrors('doc', handler);
