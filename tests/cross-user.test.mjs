// The cross-user matrix (multi-user beta P2, 2026-11-27; PLAN.md "cross-user matrix"): every route
// × {A cookie, A v2 cookie, A token, B cookie, B token, C cookie, C token, D cookie, D token,
// anonymous} × {A private, A public, B private, C private, D public, expired} against a fresh
// database for every single call. C is a freshly signed-up user (P3); D is a disabled one, whose
// cookie must act exactly like no cookie, whose token exactly like an unknown token, and whose
// documents (public ones too) exactly like missing ones, for everyone including D. For each call:
//   1. no leak: the response never contains a marker (title, body, svg, html, feedback quote, token
//      name, or the id) of a row the caller doesn't own, except the public document it asked for;
//   2. missing == forbidden: on a row the caller doesn't own (and on any expired row a content route
//      serves) the answer is byte-identical to the answer for an id that never existed (ids and
//      timestamps normalised), so nothing reveals existence; a public document's page is exactly
//      what an anonymous reader gets (no owner controls, no private versions/translations);
//   3. no cross-user writes: every row the caller doesn't own is unchanged afterwards.
// Positive controls prove the matrix isn't vacuous (owners do see and change their own rows), and
// the list routes (library, catalog, search, collections, reads, feedback, tokens) return exactly
// the caller's own rows and counts. A planted B row that points into A's version family, A's
// translation group and A's collection must never show up on A's pages or anyone's lists.
import test from 'node:test';
import assert from 'node:assert/strict';
import { useFakeDb, responseRecorder, userCookie } from './_fakedb.mjs';

process.env.MDSHARE_PASSWORD = 'test-password';
process.env.MDSHARE_HMAC_SECRET = 'test-hmac-secret';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';

const db = await useFakeDb();
const { default: render } = await import('../api/render.js');
const { default: share } = await import('../api/share.js');
const { default: diagram } = await import('../api/diagram.js');
const { default: archify } = await import('../api/archify.js');
const { default: archifyRender } = await import('../api/archify-render.js');
const { default: archifyHtml } = await import('../api/archify-html.js');
const { default: pastes } = await import('../api/pastes.js');
const { default: pin } = await import('../api/pin.js');
const { default: doc } = await import('../api/doc.js');
const { default: auth } = await import('../api/auth.js');
const { default: dashboard } = await import('../api/dashboard.js');
const { sha256Hex, ALLOWED_SCOPES } = await import('../api/_lib/agent-tokens.js');
const { signSessionToken } = await import('../api/_lib/session.js');
test.after(() => db.close());

// ---------- Two users and their rows ----------
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2001-01-01T00:00:00Z';
const RAW = { 1: 'mds_matrix_token_user_A_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 2: 'mds_matrix_token_user_B_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 3: 'mds_matrix_token_user_C_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', 4: 'mds_matrix_token_user_D_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' };
const BOGUS = 'mds_matrix_token_nobody_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
// Users besides #1 (seeded by the fake on every reset): B, C (fresh sign-up), D (disabled).
const USERS = [{ id: 2, label: 'B' }, { id: 3, label: 'C fresh' }, { id: 4, label: 'D', disabled: true }];
const DISABLED = new Set([4]);
const TOKEN_OF = { 1: 'tok_userA1', 2: 'tok_userB1', 3: 'tok_userC1', 4: 'tok_userD1' };
const FEEDBACK_OF = { 1: 'fb_Apriv0001', 2: 'fb_Bpriv0001', 3: 'fb_Cpriv0001', 4: 'fb_Dpub00001' };
const mk = (key, what) => `mk_${key}_${what}`;
const paste = (key, id, owner, extra = {}) => ({ table: 'mdshare_pastes', key, id, owner, row: { id, owner_id: owner, title: `${mk(key, 'title')} zebra`, content: `# ${mk(key, 'title')} zebra\n\n${mk(key, 'body')} zebra`, is_public: false, expires_at: FUTURE, pinned: false, created_at: '2026-11-20T00:00:00Z', ...extra } });
const diag = (key, id, owner, extra = {}) => ({ table: 'mdshare_diagrams', key, id, owner, row: { id, owner_id: owner, title: mk(key, 'title'), svg: `<svg><text>${mk(key, 'svg')}</text></svg>`, markdown: `${mk(key, 'body')} zebra`, is_public: false, expires_at: FUTURE, pinned: false, ...extra } });
const arch = (key, id, owner, extra = {}) => ({ table: 'mdshare_archify', key, id, owner, row: { id, owner_id: owner, kind: 'architecture', title: mk(key, 'title'), html: `<!DOCTYPE html><html><body><svg></svg>${mk(key, 'html')}</body></html>`, ir: { meta: { title: mk(key, 'ir') } }, markdown: mk(key, 'body'), is_public: false, expires_at: FUTURE, pinned: false, ...extra } });

const ROWS = [
  paste('aPriv', 'aPrivPaste', 1, { created_by_token: 'tok_userA1', collection: 'shared', lang: 'en' }),
  paste('aPrivV2', 'aPrivVer02', 1, { parent_id: 'aPrivPaste', root_id: 'aPrivPaste', version_no: 2, collection: 'shared', lang: 'en', created_at: '2026-11-21T00:00:00Z' }),
  paste('aPub', 'aPubPaste1', 1, { is_public: true, lang: 'zh', translation_of: 'aPrivPaste', collection: 'alpha-only' }),
  paste('aMine', 'aMinePaste', 1, { created_by_token: 'tok_userA1', lang: 'en' }),
  paste('aExp', 'aExpPaste1', 1, { expires_at: PAST, collection: 'shared' }),
  paste('bPriv', 'bPrivPaste', 2, { created_by_token: 'tok_userB1', collection: 'shared', lang: 'en' }),
  paste('bMine', 'bMinePaste', 2, { created_by_token: 'tok_userB1', lang: 'en' }),
  // Planted: a public B row claiming to be the newer version and the English translation of A's
  // documents, in A's collection slug. It must never surface on A's pages or anyone else's lists.
  paste('bSneak', 'bSneakPst1', 2, { is_public: true, parent_id: 'aPubPaste1', root_id: 'aPubPaste1', version_no: 9, translation_of: 'aPrivPaste', lang: 'en', collection: 'alpha-only', created_at: '2026-11-25T00:00:00Z' }),
  diag('aPrivD', 'aPrivDiagr', 1, { created_by_token: 'tok_userA1' }),
  diag('aPubD', 'aPubDiagr1', 1, { is_public: true }),
  diag('aExpD', 'aExpDiagr1', 1, { expires_at: PAST }),
  diag('bPrivD', 'bPrivDiagr', 2, { created_by_token: 'tok_userB1' }),
  arch('aPrivX', 'aPrivArchi', 1, { created_by_token: 'tok_userA1' }),
  arch('aPubX', 'aPubArchi1', 1, { is_public: true }),
  arch('aExpX', 'aExpArchi1', 1, { expires_at: PAST }),
  arch('bPrivX', 'bPrivArchi', 2, { created_by_token: 'tok_userB1' }),
  paste('cPriv', 'cPrivPaste', 3, { created_by_token: 'tok_userC1', collection: 'shared', lang: 'en' }),
  paste('cMine', 'cMinePaste', 3, { created_by_token: 'tok_userC1', lang: 'en' }),
  diag('cPrivD', 'cPrivDiagr', 3, { created_by_token: 'tok_userC1' }),
  arch('cPrivX', 'cPrivArchi', 3, { created_by_token: 'tok_userC1' }),
  // D is disabled: even its public documents must answer like missing ones.
  paste('dPub', 'dPubPaste1', 4, { is_public: true, created_by_token: 'tok_userD1', collection: 'shared', lang: 'en' }),
  paste('dMine', 'dMinePaste', 4, { created_by_token: 'tok_userD1', lang: 'en' }),
  diag('dPubD', 'dPubDiagr1', 4, { is_public: true, created_by_token: 'tok_userD1' }),
  arch('dPubX', 'dPubArchi1', 4, { is_public: true, created_by_token: 'tok_userD1' }),
  { table: 'mdshare_feedback', key: 'fbA', id: 'fb_Apriv0001', owner: 1, row: { id: 'fb_Apriv0001', owner_id: 1, doc_id: 'aPrivPaste', kind: 'note', quote: mk('fbA', 'quote'), note: mk('fbA', 'note'), status: 'open' } },
  { table: 'mdshare_feedback', key: 'fbB', id: 'fb_Bpriv0001', owner: 2, row: { id: 'fb_Bpriv0001', owner_id: 2, doc_id: 'bPrivPaste', kind: 'note', quote: mk('fbB', 'quote'), note: mk('fbB', 'note'), status: 'open' } },
  { table: 'mdshare_reads', key: 'readA', id: 'aPrivPaste', owner: 1, row: { doc_id: 'aPrivPaste', owner_id: 1, open_count: 3, max_scroll: 41 } },
  { table: 'mdshare_reads', key: 'readB', id: 'bPrivPaste', owner: 2, row: { doc_id: 'bPrivPaste', owner_id: 2, open_count: 7, max_scroll: 77 } },
  { table: 'mdshare_feedback', key: 'fbC', id: 'fb_Cpriv0001', owner: 3, row: { id: 'fb_Cpriv0001', owner_id: 3, doc_id: 'cPrivPaste', kind: 'note', quote: mk('fbC', 'quote'), note: mk('fbC', 'note'), status: 'open' } },
  { table: 'mdshare_feedback', key: 'fbD', id: 'fb_Dpub00001', owner: 4, row: { id: 'fb_Dpub00001', owner_id: 4, doc_id: 'dPubPaste1', kind: 'note', quote: mk('fbD', 'quote'), note: mk('fbD', 'note'), status: 'open' } },
  { table: 'mdshare_reads', key: 'readC', id: 'cPrivPaste', owner: 3, row: { doc_id: 'cPrivPaste', owner_id: 3, open_count: 2, max_scroll: 22 } },
  { table: 'mdshare_reads', key: 'readD', id: 'dPubPaste1', owner: 4, row: { doc_id: 'dPubPaste1', owner_id: 4, open_count: 4, max_scroll: 44 } },
  { table: 'mdshare_agent_tokens', key: 'tokA', id: 'tok_userA1', owner: 1, row: { id: 'tok_userA1', owner_id: 1, name: mk('tokA', 'name'), token_hash: sha256Hex(RAW[1]), scopes: ALLOWED_SCOPES, expires_at: FUTURE } },
  { table: 'mdshare_agent_tokens', key: 'tokB', id: 'tok_userB1', owner: 2, row: { id: 'tok_userB1', owner_id: 2, name: mk('tokB', 'name'), token_hash: sha256Hex(RAW[2]), scopes: ALLOWED_SCOPES, expires_at: FUTURE } },
  // C's token is what sign-up issues (no publish:any); D's is as strong as A's, and must still be a 401.
  { table: 'mdshare_agent_tokens', key: 'tokC', id: 'tok_userC1', owner: 3, row: { id: 'tok_userC1', owner_id: 3, name: mk('tokC', 'name'), token_hash: sha256Hex(RAW[3]), scopes: ['documents:read', 'documents:write', 'documents:publish'], expires_at: FUTURE } },
  { table: 'mdshare_agent_tokens', key: 'tokD', id: 'tok_userD1', owner: 4, row: { id: 'tok_userD1', owner_id: 4, name: mk('tokD', 'name'), token_hash: sha256Hex(RAW[4]), scopes: ALLOWED_SCOPES, expires_at: FUTURE } },
];
const byId = new Map(ROWS.map((r) => [r.id + r.table, r]));
const isPublic = (r) => r.row.is_public === true;
const isExpired = (r) => r.row.expires_at === PAST;
const ownerDisabled = (r) => DISABLED.has(r.owner);
// Whose rows a caller really acts for: nobody for a disabled user.
const effUid = (who) => (who.disabled ? null : who.uid);

function reseed() {
  db.sb.reset();
  for (const u of USERS) db.sb.seed('mdshare_users', structuredClone(u));
  for (const r of ROWS) db.sb.seed(r.table, structuredClone(r.row));
}
const snapshot = () => structuredClone(db.sb.tables);

// ---------- Who is asking ----------
const A_COOKIE = await userCookie(1);
const B_COOKIE = await userCookie(2);
const C_COOKIE = await userCookie(3);
const D_COOKIE = await userCookie(4);
const bearer = (raw) => ['Bea', 'rer'].join('') + ' ' + raw;
const A_V2 = `mdshare_auth=${encodeURIComponent(signSessionToken(Math.floor(Date.now() / 1000) + 3600))}`;
const WHO = [
  { name: 'A cookie', uid: 1, via: 'cookie', headers: { cookie: A_COOKIE } },
  { name: 'A v2 cookie', uid: 1, via: 'cookie', headers: { cookie: A_V2 } },
  { name: 'A token', uid: 1, via: 'token', headers: { authorization: `Bearer ${RAW[1]}` } },
  { name: 'B cookie', uid: 2, via: 'cookie', headers: { cookie: B_COOKIE } },
  { name: 'B token', uid: 2, via: 'token', headers: { authorization: `Bearer ${RAW[2]}` } },
  { name: 'C cookie', uid: 3, via: 'cookie', headers: { cookie: C_COOKIE } },
  { name: 'C token', uid: 3, via: 'token', headers: { authorization: bearer(RAW[3]) } },
  { name: 'D cookie (disabled)', uid: 4, via: 'cookie', disabled: true, headers: { cookie: D_COOKIE } },
  { name: 'D token (disabled)', uid: 4, via: 'token', disabled: true, headers: { authorization: bearer(RAW[4]) } },
  { name: 'anonymous', uid: null, via: 'none', headers: {} },
].map((w, i) => ({ ...w, ip: `10.200.${i}.1` }));
const ANON = WHO.find((w) => w.via === 'none');
// What a disabled caller must be indistinguishable from: no cookie at all, or a token that never existed.
const BOGUS_TOKEN = { name: 'unknown token', uid: null, via: 'token', headers: { authorization: bearer(BOGUS) }, ip: '10.200.99.1' };
const lookalike = (who) => (who.via === 'cookie' ? ANON : BOGUS_TOKEN);

// ---------- Targets ----------
// For each target class, the id used per kind of route. "missing" ids never exist.
const TARGETS = {
  'A private': { paste: 'aPrivPaste', diagram: 'aPrivDiagr', archify: 'aPrivArchi', feedback: 'fb_Apriv0001', token: 'tok_userA1' },
  'A public': { paste: 'aPubPaste1', diagram: 'aPubDiagr1', archify: 'aPubArchi1', feedback: 'fb_Apub00001', token: 'tok_nopub01' },
  'B private': { paste: 'bPrivPaste', diagram: 'bPrivDiagr', archify: 'bPrivArchi', feedback: 'fb_Bpriv0001', token: 'tok_userB1' },
  'C private': { paste: 'cPrivPaste', diagram: 'cPrivDiagr', archify: 'cPrivArchi', feedback: 'fb_Cpriv0001', token: 'tok_userC1' },
  'D public (disabled)': { paste: 'dPubPaste1', diagram: 'dPubDiagr1', archify: 'dPubArchi1', feedback: 'fb_Dpub00001', token: 'tok_userD1' },
  expired: { paste: 'aExpPaste1', diagram: 'aExpDiagr1', archify: 'aExpArchi1', feedback: 'fb_Aexp00001', token: 'tok_noexp01' },
};
const MISSING = { paste: 'zzMissing1', diagram: 'zzMissing2', archify: 'zzMissing3', feedback: 'fb_missing01', token: 'tok_missing' };
const TABLE_OF = { paste: 'mdshare_pastes', diagram: 'mdshare_diagrams', archify: 'mdshare_archify', feedback: 'mdshare_feedback', token: 'mdshare_agent_tokens' };
const rowFor = (kind, id) => byId.get(id + TABLE_OF[kind]) || null;
const mineFor = (who) => ({ 1: 'aMinePaste', 2: 'bMinePaste', 3: 'cMinePaste', 4: 'dMinePaste' }[who.uid] || 'zzNobody01');

// ---------- Routes ----------
// view: a content read that serves a public row to anyone (then it must equal the anonymous view).
const R = (name, kind, build, opts = {}) => ({ name, kind, build, ...opts });
const TARGET_ROUTES = [
  R('GET /v/:id', 'paste', (id) => [render, { query: { id } }], { view: true, bearer: true }),
  R('GET /v/:id?as=reader', 'paste', (id) => [render, { query: { id, as: 'reader' } }], { view: true, bearer: true }),
  R('GET /v/:id?classic=1', 'paste', (id) => [render, { query: { id, classic: '1' } }], { view: true, bearer: true }),
  // A signed-in caller asking for Markdown gets it (a public row's text), anonymous gets the page.
  R('GET /v/:id Accept: text/markdown', 'paste', (id) => [render, { query: { id }, headers: { accept: 'text/markdown' } }], { view: true, anonForm: false, bearer: true }),
  R('GET /raw/:id', 'paste', (id) => [share, { method: 'GET', query: { id } }], { view: true, bearer: true }),
  R('PATCH /api/share (edit)', 'paste', (id) => [share, { method: 'PATCH', body: { id, content: '# pwned' } }]),
  R('DELETE /api/share', 'paste', (id) => [share, { method: 'DELETE', query: { id } }]),
  R('POST /api/share parent', 'paste', (id) => [share, { method: 'POST', body: { markdown: '# new version', parent: id } }]),
  R('POST /api/share translation_of', 'paste', (id) => [share, { method: 'POST', body: { markdown: '# 译文', lang: 'zh', translation_of: id } }]),
  R('PATCH /api/pin publish paste', 'paste', (id) => [pin, { method: 'PATCH', body: { id, kind: 'paste', is_public: true, keep: true } }]),
  R('PATCH /api/pin unpublish paste', 'paste', (id) => [pin, { method: 'PATCH', body: { id, kind: 'paste', is_public: false } }]),
  R('PATCH /api/pin keep', 'paste', (id) => [pin, { method: 'PATCH', body: { id, type: 'paste', pinned: true } }]),
  R('PATCH /api/pin unkeep batch', 'paste', (id) => [pin, { method: 'PATCH', body: { items: [{ id, type: 'paste' }], pinned: false } }]),
  R('POST doc read', 'paste', (id) => [doc, { method: 'POST', query: { action: 'read' }, body: { id, scroll: 50, seconds: 5, open: true } }]),
  R('GET doc reads ids', 'paste', (id) => [doc, { method: 'GET', query: { action: 'reads', ids: id } }]),
  R('GET doc feedback id', 'paste', (id) => [doc, { method: 'GET', query: { action: 'feedback', id } }]),
  R('POST doc feedback', 'paste', (id) => [doc, { method: 'POST', query: { action: 'feedback' }, body: { id, kind: 'note', note: 'a planted note' } }]),
  R('GET doc versions', 'paste', (id) => [doc, { method: 'GET', query: { action: 'versions', id } }]),
  R('POST doc collection', 'paste', (id) => [doc, { method: 'POST', query: { action: 'collection' }, body: { id, collection: 'stolen' } }]),
  R('POST doc translation lang', 'paste', (id) => [doc, { method: 'POST', query: { action: 'translation' }, body: { id, lang: 'zh' } }]),
  R('POST doc translation link to target', 'paste', (id, who) => [doc, { method: 'POST', query: { action: 'translation' }, body: { id: mineFor(who), translation_of: id, lang: 'zh' } }]),
  R('POST doc resolve', 'feedback', (id) => [doc, { method: 'POST', query: { action: 'resolve' }, body: { ids: [id], status: 'resolved' } }]),
  R('GET /d/:id', 'diagram', (id) => [render, { query: { id, kind: 'diagram' } }], { view: true }),
  R('GET /api/diagram', 'diagram', (id) => [diagram, { method: 'GET', query: { id } }], { view: true, bearer: true }),
  R('DELETE /api/diagram', 'diagram', (id) => [diagram, { method: 'DELETE', query: { id } }]),
  R('PATCH /api/pin publish diagram', 'diagram', (id) => [pin, { method: 'PATCH', body: { id, kind: 'diagram', is_public: true } }]),
  R('PATCH /api/pin keep diagram', 'diagram', (id) => [pin, { method: 'PATCH', body: { id, type: 'diagram', pinned: true } }]),
  R('GET /a/:id', 'archify', (id) => [archifyRender, { query: { id } }], { view: true }),
  R('GET /api/archify-html', 'archify', (id) => [archifyHtml, { query: { id } }], { view: true }),
  R('GET /api/archify', 'archify', (id) => [archify, { method: 'GET', query: { id } }], { view: true, bearer: true }),
  R('DELETE /api/archify', 'archify', (id) => [archify, { method: 'DELETE', query: { id } }]),
  R('PATCH /api/pin publish archify', 'archify', (id) => [pin, { method: 'PATCH', body: { id, kind: 'archify', is_public: true } }]),
  R('DELETE /api/auth revoke_token', 'token', (id) => [auth, { method: 'DELETE', body: { action: 'revoke_token', id } }]),
];

async function call(who, [handler, req]) {
  const res = responseRecorder();
  await handler({ method: 'GET', query: {}, body: undefined, ...req, headers: { ...who.headers, ...(req.headers || {}) }, socket: { remoteAddress: who.ip } }, res);
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body ?? null);
  return { status: res.statusCode, text, type: res.headers['content-type'] || '' };
}

// Markers of every row `who` doesn't own (allowed: the public row it asked for, on a view route).
// A value stored in the caller's own row is the caller's data, not a leak (the planted B row names
// A's ids in its root_id/translation_of; B's own collection page may echo them as a group key).
function forbiddenMarkers(who, allowed) {
  const me = effUid(who);
  const ownText = JSON.stringify(ROWS.filter((r) => r.owner === me).map((r) => r.row));
  const out = [];
  for (const r of ROWS) {
    if (r.owner === me || r === allowed) continue;
    out.push(r.id, ...(JSON.stringify(r.row).match(/mk_[A-Za-z0-9]+_[a-z]+/g) || []));
  }
  return [...new Set(out)].filter((m) => !ownText.includes(m));
}
function assertNoLeak(label, who, resp, allowed, echoed) {
  const bad = forbiddenMarkers(who, allowed).filter((m) => m !== echoed && resp.text.includes(m));
  assert.deepEqual(bad, [], `${label}: leaked ${bad.join(', ')} (status ${resp.status})\n${resp.text.slice(0, 600)}`);
}
const norm = (resp, ids) => {
  let t = resp.text;
  for (const id of ids) t = t.split(id).join('<ID>');
  return { status: resp.status, type: resp.type, text: t.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>') };
};
// Rows `who` doesn't own must be unchanged (inserts of new rows are fine).
function assertNoForeignWrites(label, who, before) {
  for (const [table, rows] of Object.entries(before)) {
    for (const row of rows) {
      if (row.owner_id !== undefined && row.owner_id === effUid(who)) continue;
      const key = row.id ?? row.doc_id;
      const now = db.sb.tables[table].find((x) => (x.id ?? x.doc_id) === key);
      // last_used_at: the fire-and-forget touch of the caller's own token may land after a reseed.
      const strip = (x) => (x && table === 'mdshare_agent_tokens' ? { ...x, last_used_at: null } : x);
      assert.deepEqual(strip(now), strip(row), `${label}: ${table} row ${key} (owner ${row.owner_id}) was changed or deleted`);
    }
  }
}

let cases = 0;
let positives = 0;
let sameAsMissing = 0;
let sameAsAnon = 0;
let sameAsDisabledLookalike = 0;
test('matrix: every route x every caller x every target — no leak, missing == forbidden, no foreign writes', async () => {
  for (const route of TARGET_ROUTES) {
    for (const who of WHO) {
      reseed();
      const missingResp = await call(who, route.build(MISSING[route.kind], who));
      for (const [tname, ids] of Object.entries(TARGETS)) {
        const id = ids[route.kind];
        const row = rowFor(route.kind, id);
        const label = `${route.name} as ${who.name} on ${tname}`;
        reseed();
        const before = snapshot();
        const resp = await call(who, route.build(id, who));
        cases++;
        const allowed = route.view && row && isPublic(row) && !isExpired(row) && !ownerDisabled(row) ? row : null;
        assertNoLeak(label, who, resp, allowed, id);
        assertNoForeignWrites(label, who, before);
        if (who.disabled) {
          // A disabled user's cookie is no cookie, its token an unknown token: byte for byte.
          reseed();
          const like = lookalike(who);
          const other = await call(like, route.build(id, like));
          assert.deepEqual(norm(resp, [id]), norm(other, [id]), `${label}: differs from ${like.name}`);
          sameAsDisabledLookalike++;
          continue; // no cookie / an unknown token are themselves covered by the anonymous rows and the 401 tests
        }
        const own = row && row.owner === effUid(who);
        if (allowed && !own) {
          // A public row the caller doesn't own: readable, and for a browser session exactly the
          // anonymous reader's view (a Bearer on /v gets the Markdown form of the same row).
          assert.equal(resp.status, 200, `${label}: a public document is readable`);
          if (who.via === 'cookie' && route.anonForm !== false) {
            reseed();
            const anon = await call(ANON, route.build(id, ANON));
            assert.deepEqual(norm(resp, [id]), norm(anon, [id]), `${label}: differs from the anonymous view`);
            sameAsAnon++;
          }
        } else if (!own || (isExpired(row) && route.view)) {
          assert.deepEqual(norm(resp, [id]), norm(missingResp, [MISSING[route.kind]]), `${label}: differs from a missing id`);
          sameAsMissing++;
        } else if (route.view && (who.via === 'cookie' || (who.via === 'token' && route.bearer))) {
          assert.ok(resp.status === 200, `${label}: the owner reads their own row (status ${resp.status})`);
          positives++;
        }
      }
    }
  }
  assert.ok(cases >= TARGET_ROUTES.length * WHO.length * 4, `ran ${cases} cases`);
  assert.ok(positives > 40, `owners read their own rows in ${positives} cases`);
  assert.ok(sameAsDisabledLookalike >= TARGET_ROUTES.length * 2 * Object.keys(TARGETS).length, 'every disabled-caller case was compared');
  console.log(`cross-user matrix: ${cases} cases (${TARGET_ROUTES.length} routes x ${WHO.length} callers x ${Object.keys(TARGETS).length} targets), ${sameAsMissing} identical to a missing id, ${sameAsAnon} identical to the anonymous view, ${sameAsDisabledLookalike} disabled-user calls identical to no cookie / an unknown token, ${positives} owner reads`);
});

// ---------- Positive controls: the matrix is not vacuous ----------
test('owners see and change their own rows (positive controls)', async () => {
  reseed();
  const [aC, , aT, bC, bT] = WHO;
  assert.match((await call(aC, [render, { query: { id: 'aPrivPaste' } }])).text, /mk_aPriv_body/);
  assert.match((await call(WHO[1], [render, { query: { id: 'aPrivPaste' } }])).text, /mk_aPriv_body/, 'a pre-multi-user v2 cookie is still user #1');
  assert.match((await call(aT, [share, { method: 'GET', query: { id: 'aPrivPaste' } }])).text, /mk_aPriv_body/);
  assert.match((await call(bC, [render, { query: { id: 'bPrivPaste' } }])).text, /mk_bPriv_body/);
  assert.match((await call(bT, [share, { method: 'GET', query: { id: 'bPrivPaste' } }])).text, /mk_bPriv_body/);
  const ownerPage = (await call(aC, [render, { query: { id: 'aPrivPaste' } }])).text;
  assert.match(ownerPage, /id="status-pill"/, 'owner controls on the own page');
  assert.match(ownerPage, /mk_aPrivV2_title/, "the owner's newer-version banner");
  const bOnAPub = (await call(bC, [render, { query: { id: 'aPubPaste1' } }])).text;
  assert.doesNotMatch(bOnAPub, /id="status-pill"/, "another signed-in user gets the reader view, not owner controls");
  assert.match((await call(bC, [pin, { method: 'PATCH', body: { id: 'bPrivPaste', kind: 'paste', is_public: true } }])).text, /"ok":true/);
  assert.equal(db.sb.tables.mdshare_pastes.find((r) => r.id === 'bPrivPaste').is_public, true);
  const del = await call(aC, [share, { method: 'DELETE', query: { id: 'aMinePaste' } }]);
  assert.equal(del.status, 200);
  assert.equal(db.sb.tables.mdshare_pastes.some((r) => r.id === 'aMinePaste'), false);
});

// ---------- Lists: exactly the caller's own rows and counts ----------
const liveOwned = (uid, table) => ROWS.filter((r) => r.table === table && r.owner === uid && !isExpired(r)).map((r) => r.id).sort();
const zebraTotal = (uid) => ROWS.filter((r) => r.table === 'mdshare_pastes' && r.owner === uid && !isExpired(r)).length;

test('lists: library, catalog, search, collections, reads, feedback, tokens are the caller\'s own', async () => {
  for (const who of WHO) {
    reseed();
    const L = async (label, req, handler) => {
      const resp = await call(who, [handler, req]);
      assertNoLeak(`${label} as ${who.name}`, who, resp, null, null);
      return resp;
    };
    const lib = await L('GET /api/pastes', { method: 'GET', query: {} }, pastes);
    const cat = await L('GET /api/pastes bearer catalog', { method: 'GET', query: { q: 'zebra', limit: '50' } }, pastes);
    const search = await L('GET doc search', { method: 'GET', query: { action: 'search', q: 'zebra', limit: '50' } }, doc);
    const colls = await L('GET doc collection', { method: 'GET', query: { action: 'collection' } }, doc);
    const shared = await L('GET doc collection shared', { method: 'GET', query: { action: 'collection', slug: 'shared' } }, doc);
    const alpha = await L('GET doc collection alpha-only', { method: 'GET', query: { action: 'collection', slug: 'alpha-only' } }, doc);
    const unread = await L('GET doc reads unread', { method: 'GET', query: { action: 'reads', unread: '1', days: '30' } }, doc);
    const fb = await L('GET doc feedback', { method: 'GET', query: { action: 'feedback' } }, doc);
    const toks = await L('GET auth tokens', { method: 'GET', query: { action: 'tokens' } }, auth);
    const whoami = await L('GET auth whoami', { method: 'GET', query: { action: 'whoami' } }, auth);
    await L('GET /c', { query: { kind: 'collection' } }, render);
    const cShared = await L('GET /c/shared', { query: { kind: 'collection', slug: 'shared' } }, render);
    const cAlpha = await L('GET /c/alpha-only', { query: { kind: 'collection', slug: 'alpha-only' } }, render);
    await L('GET /dashboard', { query: {} }, dashboard);
    await L('GET /settings', { query: { view: 'settings' } }, dashboard);

    if (who.via === 'cookie' && !who.disabled) {
      const items = JSON.parse(lib.text);
      const got = (k) => items.filter((i) => i.kind === k).map((i) => i.id).sort();
      assert.deepEqual(got('paste'), liveOwned(who.uid, 'mdshare_pastes'), `${who.name}: library documents`);
      assert.deepEqual(got('diagram'), liveOwned(who.uid, 'mdshare_diagrams'), `${who.name}: library diagrams`);
      assert.deepEqual(got('archify'), liveOwned(who.uid, 'mdshare_archify'), `${who.name}: library archify`);
      assert.deepEqual(JSON.parse(toks.text).tokens.map((t) => t.id), [TOKEN_OF[who.uid]], `${who.name}: Settings lists only their own tokens`);
      const has = (slug) => ROWS.some((r) => r.owner === who.uid && r.table === 'mdshare_pastes' && r.row.collection === slug && !isExpired(r));
      assert.equal(cShared.status, has('shared') ? 200 : 404);
      assert.equal(cAlpha.status, has('alpha-only') ? 200 : 404, `${who.name}: /c/alpha-only exists only for users with documents in it`);
    }
    if (who.via === 'token' && !who.disabled) {
      // Catalog search for "zebra": title/content (documents), title/markdown (diagrams); archify rows have none.
      const c = JSON.parse(cat.text);
      assert.deepEqual(c.items.map((i) => i.id).sort(), [...liveOwned(who.uid, 'mdshare_pastes'), ...liveOwned(who.uid, 'mdshare_diagrams')].sort(), `${who.name}: catalog`);
      assert.equal(JSON.parse(whoami.text).user_id, who.uid);
    }
    if (effUid(who) !== null) {
      const s = JSON.parse(search.text);
      assert.equal(s.total, zebraTotal(who.uid), `${who.name}: search total counts only their documents`);
      const counts = Object.fromEntries(JSON.parse(colls.text).collections.map((c) => [c.slug, c.count]));
      const expectCounts = {};
      for (const r of ROWS) if (r.table === 'mdshare_pastes' && r.owner === who.uid && !isExpired(r) && r.row.collection) (expectCounts[r.row.collection] ||= new Set()).add(r.row.translation_of || r.row.root_id || r.id);
      assert.deepEqual(counts, Object.fromEntries(Object.entries(expectCounts).map(([k, v]) => [k, v.size])), `${who.name}: collection counts`);
      assert.ok(JSON.parse(shared.text).items.every((e) => e.links.every((l) => ROWS.find((r) => r.id === l.id).owner === who.uid)));
      assert.ok((JSON.parse(alpha.text).items || []).every((e) => e.links.every((l) => ROWS.find((r) => r.id === l.id).owner === who.uid)));
      // C's token is a sign-up token (documents:* only): read receipts and feedback are refused.
      const activity = who.via !== 'token' || ROWS.find((r) => r.id === TOKEN_OF[who.uid]).row.scopes.includes('activity:read');
      if (!activity) assert.deepEqual([unread.status, fb.status], [403, 403], `${who.name}: no activity:read`);
      else {
        assert.ok(JSON.parse(unread.text).items.every((d) => ROWS.find((r) => r.id === d.id).owner === who.uid), `${who.name}: ${unread.status} ${unread.text}`);
        assert.deepEqual(JSON.parse(fb.text).items.map((f) => f.id), [FEEDBACK_OF[who.uid]]);
      }
    } else {
      for (const r of [lib, cat, search, colls, toks, whoami]) assert.ok(r.status === 401 || r.status === 403, `${who.name}: list refused (${r.status})`);
    }
  }
});

test('creates are owned by the caller (anonymous: the site owner), never by a body field', async () => {
  for (const who of WHO) {
    reseed();
    const body = { markdown: `# made by ${who.name}`, owner_id: 2, user_id: 2, owner: 2 };
    const made = [
      ['mdshare_pastes', await call(who, [share, { method: 'POST', body }])],
      ['mdshare_diagrams', await call(who, [diagram, { method: 'POST', body: { ...body, svg: '<svg></svg>' } }])],
      ['mdshare_archify', await call(who, [archify, { method: 'POST', body: { ...body, kind: 'workflow', html: '<html><svg></svg></html>' } }])],
    ];
    if (who.disabled) {
      // Never filed under anyone: a disabled cookie is refused (not an anonymous create for user #1), its token is a 401.
      for (const [table, resp] of made) {
        assert.equal(resp.status, who.via === 'cookie' ? 403 : 401, `${who.name} creates in ${table}: ${resp.text}`);
        assert.equal(db.sb.tables[table].length, ROWS.filter((r) => r.table === table).length, `${who.name}: nothing was created in ${table}`);
      }
      continue;
    }
    for (const [table, resp] of made) {
      assert.equal(resp.status, 200, `${who.name} creates in ${table}: ${resp.text}`);
      const row = db.sb.tables[table].find((r) => r.id === JSON.parse(resp.text).id);
      assert.equal(row.owner_id, who.uid ?? 1, `${who.name}: ${table} row owner`);
      assert.equal(row.is_public, false);
    }
    if (who.uid !== null) {
      // The new document is in the creator's library and nobody else's.
      const other = WHO.find((w) => w.via === 'cookie' && w.uid !== who.uid);
      const mine = WHO.find((w) => w.via === 'cookie' && w.uid === who.uid);
      const id = JSON.parse(made[0][1].text).id;
      assert.ok(JSON.parse((await call(mine, [pastes, { method: 'GET', query: {} }])).text).some((i) => i.id === id));
      assert.ok(!JSON.parse((await call(other, [pastes, { method: 'GET', query: {} }])).text).some((i) => i.id === id));
    }
  }
});

test('the owner (user #1) sees exactly the single-user counts for every pre-existing row', async () => {
  reseed();
  // Before multi-user every row was user #1's; the backfill made it so. A's library therefore holds
  // every live row that isn't B's, i.e. exactly what the single-user library listed.
  const items = JSON.parse((await call(WHO[0], [pastes, { method: 'GET', query: {} }])).text);
  const singleUser = ROWS.filter((r) => ['mdshare_pastes', 'mdshare_diagrams', 'mdshare_archify'].includes(r.table) && r.owner === 1 && !isExpired(r)).length;
  assert.equal(items.length, singleUser);
});
