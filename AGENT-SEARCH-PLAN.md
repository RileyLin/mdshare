# Agent-native scoped catalog search/read/create + explicit publish — implementation plan

Parent instruction (2026-10-08): implement machine-native, authenticated, cross-machine
search/read/create for mdshare agent (bearer) tokens, plus explicit scoped publishing, on top of
the existing additive bearer-token layer (`AGENT-AUTH-PLAN.md`, commit `8b01a3b`, migration 005 —
**not yet applied** to the live DB per that plan's own success criteria). This plan is additive to
that one, not a replacement; everything in `AGENT-AUTH-PLAN.md` about the existing token model
stays true and unchanged for tokens that predate this change.

**No deploy, no migration apply, no production credentials, no push.** Parent is separately
inspecting live deployment/credentials. This session only edits files in this working tree, runs
local tests, and commits (no push).

## Baseline (verified before writing any code)

- `git status --porcelain` — clean, nothing uncommitted.
- `api/*.js` — exactly 12 files (the Vercel Hobby function cap). Confirmed by `ls api/*.js`.
- `node --test --test-force-exit tests/*.test.mjs` — **65/65 passing** before any change in this
  session. This is the regression baseline every later test run in this plan is compared against.
- Existing bearer-token model (read `AGENT-AUTH-PLAN.md` + `api/_lib/agent-tokens.js` +
  `api/_lib/access.js` for the full picture): a token has no `scopes` concept at all today. Any
  valid token can (a) create via `POST /api/share|diagram|archify` (always private, attributed via
  `created_by_token`), and (b) read back, via the raw `GET` on those same three routes, only the
  exact rows it itself created (`isVisible(..., {agentOwns})`). It cannot list/search a catalog,
  cannot read any other row (owner's or another token's), cannot toggle `is_public`, cannot
  mint/revoke tokens. `api/pastes.js` (dashboard listing) and `api/pin.js` (pin + visibility
  toggle, merged 2026-09-22) are both still owner-cookie-only — no bearer support at all today.

## Hard constraints carried forward

1. **12-function cap.** `api/` is already at 12 files. No new top-level `api/*.js` file. New
   capability goes into: (a) existing route files (extending them), and (b) new files under
   `api/_lib/` (not routed by Vercel — same precedent as `access.js`/`agent-tokens.js`).
2. **No silent privilege escalation for pre-existing tokens.** Every row already in
   `mdshare_agent_tokens` has no `scopes` value (the column doesn't exist yet). After migration
   006 adds a nullable `scopes text[]` column, every one of those rows reads back `scopes: null`.
   `null` scopes = **legacy** token: behavior is **exactly** today's — unconditional create,
   unconditional own-row read, no catalog, no publish, nothing new, no code path even inspects
   `scopes` for a legacy token's create/own-read floor. This is enforced structurally (branch on
   `scopes === null`), not by a flag that could be mis-set.
3. **New tokens are scoped and explicit.** The owner-only issuance endpoint/UI now accepts a
   `scopes` array (subset of `documents:read`, `documents:write`, `documents:publish`). A newly
   created token with `scopes` omitted entirely from the request still gets the legacy shape
   (`scopes: null` in the DB) — i.e. "don't pass scopes" == "give me the old simple
   create+own-read token", preserving every existing caller/script of `create_token` byte-for-byte.
   A token created **with** an explicit `scopes` array (even `[]`) is a **scoped** token: its
   permissions come *only* from that array, nothing implicit beyond the universal own-row-read
   floor described next.
4. **Own-row read is a universal floor, not a scope.** Both legacy and scoped tokens can always
   read back a row they themselves created (`created_by_token` match) — this was already true and
   isn't one of the three new scopes, so it isn't gated by any of them. `documents:read` is
   strictly additive on top of this floor: it grants reading *any* owner row (not just the token's
   own) and is required for any catalog search/recent access at all.
5. **Fail-closed invariant, preserved everywhere new code touches auth:** a present-but-invalid
   (malformed/unknown/revoked/expired) `Authorization` header is always `401`, before any Supabase
   write/read call, never a fallback to cookie or anonymous behavior. A *valid* token lacking a
   required scope is `403` (authenticated, not authorized) — distinct status code, never silently
   treated as anonymous or as the owner.
6. **No caching** of anything scope/identity-dependent. Every new/changed response that depends on
   auth state sets `Cache-Control: private, no-store` (or `no-store`), matching the existing
   convention in `access.js#setPrivacyHeaders` and `api/pastes.js`.
7. **No delete, no token mint/revoke via bearer, ever.** There is no `documents:delete` scope and
   none is added. `create_token`/`revoke_token`/`tokens` listing in `api/auth.js` stay
   `checkAuthAndRefresh` (owner-cookie)-only; this plan never adds a bearer path to those three
   branches.

## Scope model (concrete)

Three explicit scope strings, stored as a `text[]` column on `mdshare_agent_tokens`:

| Scope | Grants (beyond the universal own-row-read + create floor each applies to) |
|---|---|
| `documents:read` | Read **any** owner row (not just own) via the raw `GET` routes; required for any catalog search/recent/list access at all. |
| `documents:write` | **For scoped tokens only** (see constraint 3): required to `POST` (create) via `share`/`diagram`/`archify`. Legacy tokens keep unconditional create regardless of this scope — it has no effect on them. |
| `documents:publish` | Toggle `is_public` via `PATCH /api/pin` (visibility-shape body), but **only on rows the token itself created** (`created_by_token` match) — explicitly *not* "publish anything in the owner's library", even though `documents:read` is library-wide. This asymmetry is intentional and documented inline + in `CLAUDE.md`: a token can only ever flip visibility on its own output, never on the owner's or another token's content, regardless of scope. |

Legacy token (`scopes === null`): create + own-row-read, unconditionally, exactly as today. No
catalog, no publish — same as today, just now expressible as "has none of the three scopes".

## Files

### New
- **`migrations/006_add_agent_token_scopes.sql`** — additive: `ALTER TABLE mdshare_agent_tokens ADD
  COLUMN IF NOT EXISTS scopes text[];` (nullable, no default — existing rows read back `null` =
  legacy, per constraint 2). **Not applied by this session.**
- **`api/_lib/catalog.js`** — new leaf module (no routing exposure, same `_lib` convention):
  - `sanitizeSearchTerm(q)` — bounds length (≤200 chars), strips/neutralizes characters that are
    structurally significant to the PostgREST filter grammar when building an `ilike` pattern
    (`,` `(` `)` `*` are replaced with a space — PostgREST's own `and=(...)/or=(...)` grouping and
    comma-separated condition list, plus the `*`-is-wildcard mapping to SQL `%`, make these
    dangerous if passed through raw) and SQL `ILIKE` wildcard characters `%`/`_` (escaped with a
    leading backslash so a search for a literal `%`/`_` doesn't become an unintended wildcard).
    Returns `null` for an empty/whitespace-only result (treated as "no search term" → recent mode).
  - `clampPagination({limit, offset})` — coerces to integers, clamps `limit` to `[1, 50]` and
    `offset` to `[0, 5000]`; non-numeric/garbage input (e.g. `"abc"`, negative, `Infinity`) falls
    back to the nearest bound rather than ever reaching the Supabase URL unvalidated.
  - `buildIlikeOr(columns, sanitizedTerm)` — builds a `or=(col1.ilike.*term*,col2.ilike.*term*)`
    PostgREST filter fragment from an already-sanitized term (never called with raw user input).
  - `searchCatalog({ q, kind, limit, offset })` — orchestrates up to 3 parallel Supabase REST
    fetches (one per content table, or just the one requested kind), each with: the real
    server-side `ilike` OR-filter (title + the kind's body column) when `q` is present, a real
    server-side not-expired-or-pinned filter (`or=(expires_at.gt.<serverComputedNowISO>,pinned.eq.
    true)` — the "now" value is computed in app code, never user input, so it's a safe literal),
    and a real server-side `limit`/`offset`. Only a bounded per-table result set is ever fetched —
    never "fetch latest 100, then filter in JS" like the existing `api/pastes.js` dashboard path.
    Merges the (at most 3 × limit) rows, sorts by `created_at desc`, truncates to the requested
    `limit`, and returns `{ items, limit, offset, has_more }`. Documents in its header comment the
    one known limitation: when `kind` is `all` (the default), pagination is a best-effort merge
    across 3 independently-paginated tables, not one global offset — exact/real pagination holds
    when a single `kind` is requested. This is spelled out again in `AGENT-SEARCH-RESULT.md`.
- **`mcp/bin/mdshare-cli.mjs`** — new standalone, dependency-free (just `fetch`/`fs`, no MCP SDK)
  portable CLI, usable from any machine with Node ≥18 and no MCP client. Subcommands: `status`
  (bearer introspection), `search`/`recent` (catalog), `read <id> --kind K`, `create <kind>
  <file>`, `publish <id> --kind K --public true|false`. Token resolution: `MDSHARE_AGENT_TOKEN` env
  var, or `MDSHARE_AGENT_TOKEN_FILE` env var / `--token-file <path>` flag (file content, trimmed).
  **No `--token` flag of any kind** — a secret must never be accepted as a CLI argument (visible in
  `ps`, shell history) per the parent instruction; env/file only. Never logs the resolved token
  value anywhere (not even in `--help`/error paths). All output is JSON to stdout; errors go to
  stderr with a non-zero exit code and never include the token.
- **`tests/catalog.test.mjs`** — new test file: sanitizer unit tests (search/pagination injection
  payloads), `api/pastes.js` bearer-catalog-mode integration tests (scope gate, expired exclusion,
  pagination bounds, kind filter, cross-token visibility via `documents:read`).
- **`tests/scopes.test.mjs`** — new test file: legacy-token-unchanged regression, scope isolation
  (write-only / read-only / publish-only tokens each denied the other two capabilities),
  cross-token read via `documents:read`, denied publish (no scope, wrong scope, not-own-row),
  `whoami` introspection (valid/invalid/absent token).
- **`AGENT-SEARCH-PLAN.md`** — this file.
- **`AGENT-SEARCH-RESULT.md`** — written after implementation + tests, per parent instruction.

### Modified
- **`api/_lib/agent-tokens.js`**:
  - `resolveAgentToken` — `select=` gains `,scopes`; the returned `valid:true` object gains
    `scopes` (the raw DB value: `null` for legacy, an array for scoped).
  - New: `hasScope(tokenResult, scope)` → `Array.isArray(tokenResult.scopes) &&
    tokenResult.scopes.includes(scope)` (legacy/`null` → always `false`, so legacy tokens never
    pass a scope check — they rely solely on the unconditional floors instead).
  - New: `isLegacyToken(tokenResult)` → `tokenResult.scopes == null` (readability wrapper to make
    every call site's intent explicit instead of inline `scopes === null` checks).
  - `createToken({ name, expiresInDays, scopes })` — new optional `scopes` param. `undefined`
    (not passed at all) → inserted row omits `scopes` → DB default `null` → legacy token (preserves
    every existing caller). An array (validated by the caller, `api/auth.js`, before this function
    is reached — see below) → inserted verbatim.
  - `listTokens()` — `select=` and the mapped return object both gain `scopes`.
  - `ALLOWED_SCOPES` exported constant: `['documents:read', 'documents:write',
    'documents:publish']`.
- **`api/auth.js`**:
  - `POST {action:'create_token'}` — validates an optional `scopes` field: if present, must be an
    array of ≤3 strings each drawn from `ALLOWED_SCOPES` (unknown value → `400`, before touching
    Supabase); deduped; passed through to `createToken`. If the field is absent, `scopes` is not
    passed at all (→ legacy token, per constraint 3).
  - `GET {action:'tokens'}` — unchanged auth gate; response rows now include `scopes` (never
    `token_hash`, same as before) so the owner dashboard can show per-token permissions.
  - New: `GET {action:'whoami'}` — **bearer-only**, no owner cookie involved or accepted. Resolves
    `Authorization` via `resolveAgentToken`; absent header → `401` (there's no "self" to introspect
    without a token — this route has no anonymous meaning); present-but-invalid → `401` (same
    fail-closed rule as every other route); valid → `200 { ok:true, id, name, legacy, scopes:
    scopes ?? [], expires_at }` (never the hash, never any other token's data). Sets
    `Cache-Control: no-store`.
  - No change to the owner-cookie-only create_token/revoke_token/tokens gates — bearer tokens still
    cannot reach any of those three branches (constraint 7).
- **`api/share.js`, `api/diagram.js`, `api/archify.js`**:
  - `POST`: after the existing "present-but-invalid → 401" check, add — only when
    `agentAuth.valid`: if the token is **scoped** (not legacy) and lacks `documents:write`, `403`
    before any Supabase insert (mirrors the existing "insert never called" assertion style already
    in `tests/agent-auth.test.mjs`). Legacy tokens are completely unaffected (constraint 3) — no new
    branch even evaluates for them beyond the `isLegacyToken` check itself.
  - `GET`: compute `agentOwns` as `hasScope(agentAuth, 'documents:read') || (own-row match)` instead
    of just the own-row match — i.e. a token with the library-wide read scope sees exactly what the
    owner would see for that row (`isVisible`'s existing owner-OR-public-OR-opts.agentOwns branches
    are untouched; only the value computed for `agentOwns` changes). A **legacy** token's `agentOwns`
    is unaffected (its `hasScope` call is always `false`), so its visibility is still exactly
    own-row-only, unchanged.
- **`api/pastes.js`** (dashboard listing today; gains a second, bearer-token-gated mode):
  - If an `Authorization` header is present at all: resolve it via `resolveAgentToken` (present +
    invalid → `401`, same fail-closed rule, before touching the owner-cookie branch or Supabase at
    all); if valid but lacking `documents:read` → `403`; if valid with `documents:read` → run the
    new catalog mode (`searchCatalog` from `api/_lib/catalog.js`, query params: `q`, `kind`,
    `limit`, `offset`), returning `{ ok:true, items, limit, offset, has_more }` with
    `Cache-Control: no-store`. **The existing owner-cookie dashboard branch is reached only when no
    Authorization header is present at all** — byte-for-byte unchanged code path, same `limit=100`
    local-filter behavior as today, because changing the owner dashboard's own listing semantics is
    out of this change's scope (the parent's ask is the machine/agent-facing catalog, not a rewrite
    of the human dashboard list).
- **`api/pin.js`** (the `body.kind !== undefined` visibility-toggle branch only — the
  `pinned`/batch-pin branch is untouched, stays owner-cookie-only, out of scope):
  - Add a bearer path alongside the existing owner-cookie check: if there's no owner cookie, try
    `resolveAgentToken`; present+invalid → `401`; valid but lacking `documents:publish` → `403`;
    valid with the scope → fetch the row first (`getRow`, now also imported from `access.js`) to
    confirm `row.created_by_token === agentAuth.id` before calling `patchRow` — a scoped token can
    **only** flip visibility on a row it itself created, never any other row, regardless of the
    scope being named "publish" and not "publish:own" (documented inline + in `CLAUDE.md`, per
    constraint/table above). A legacy token (no `scopes`) hitting this branch is always denied —
    `hasScope` is `false` for it, same as "no scope at all", so legacy tokens gain zero new
    capability here (constraint 2).
- **`mcp/src/index.ts`** — add 4 new MCP tools alongside the existing `share_markdown`/
  `share_diagram`: `auth_status` (whoami), `search_documents` (catalog `q`/`kind`/`limit`/
  `offset`), `read_document` (raw content by `id`+`kind`), `publish_document` (`id`+`kind`+
  `is_public`). All reuse the existing `MDSHARE_AGENT_TOKEN` env var (now also reads
  `MDSHARE_AGENT_TOKEN_FILE` as a fallback, mirroring the new CLI) — token is never a tool
  argument, so a model can never be asked/tricked into putting it in a visible tool call.
- **`mcp/package.json`** — add a second `bin` entry for the new portable CLI
  (`mdshare-cli: ./bin/mdshare-cli.mjs`) and a `files` entry so it ships with the published
  package; no new dependency (plain `fetch`/`fs`).
- **`CLAUDE.md`** — "Auth model" section gets an additive paragraph (matching the existing
  depth/style) documenting: the `scopes` column and legacy-vs-scoped split, the three scope
  strings and exactly what each grants (including the `documents:publish` own-rows-only asymmetry
  called out explicitly), the new `whoami` introspection route, the new bearer-gated catalog mode
  on `api/pastes.js`, and the new bearer-gated publish path on `api/pin.js`.
- **`README.md`** — short new subsection under the MCP section: machine/agent setup (env var +
  token-file, the 4 new MCP tools, and a pointer to the portable CLI with its subcommands) — kept
  short, no visual redesign, per "prioritize secure API+tests+docs over UI polish".
- **`api/dashboard.js`** — minimal, functional-only UI update to the existing "+ New token" form:
  three scope checkboxes (`documents:read`/`documents:write`/`documents:publish`, all unchecked by
  default — unchecked-all submits no `scopes` field at all, i.e. defaults to a legacy token, so the
  existing one-click flow for "just give me a simple token" still works with zero extra clicks);
  the token list gains a small scope-badges row per token (or "legacy" badge when `scopes` is
  `null`). No visual redesign of the panel beyond these additions.

### Not touched
- `vercel.json` (no new routes, no function count change), `api/render.js`,
  `api/diagram-render.js`, `api/archify-render.js`, `api/archify-html.js` (the HTML-chrome render
  routes stay human/cookie-only exactly as `AGENT-AUTH-PLAN.md` left them — "machine-readable read
  routes use read scope" means the raw JSON/markdown/SVG/IR routes already listed above, not the
  rendered-page iframe chrome), `api/save-to-notion.js`, migrations 001-005, the `pinned`/batch
  branch of `api/pin.js`, the owner-cookie branch of `api/pastes.js`'s response shape.

## Design notes on specific hard requirements

- **"documents:publish ... own rows ideally; document"** — resolved as a hard requirement, not a
  soft preference: implemented as own-rows-only, no exception, documented in three places (table
  above, `api/pin.js` inline comment, `CLAUDE.md`). Simpler and strictly safer than the
  alternative (library-wide publish via token), and consistent with `documents:write`/own-row-read
  already being per-token-row concepts elsewhere in this model.
- **Search/pagination injection defense is layered, not just URL-encoding.** `encodeURIComponent`
  alone does not stop PostgREST filter-grammar injection, because PostgREST parses the filter
  mini-language (`,` separates OR terms, `()` groups, `*` means SQL `%`) **after** URL-decoding —
  so a raw comma/paren/asterisk in a search term can still restructure the filter even if the
  request line itself was legally encoded. `sanitizeSearchTerm` therefore neutralizes those
  characters in the *value* before any URL-encoding happens, and `clampPagination` bounds
  `limit`/`offset` to small integer ranges before they're ever string-interpolated. Both are unit
  tested directly against adversarial inputs (see `tests/catalog.test.mjs`), and integration-tested
  by asserting the mocked `fetch` call's URL never contains an unescaped structural character from
  a malicious `q`.
- **Legacy-token non-escalation is structural, not a flag.** `isLegacyToken`/`hasScope` both derive
  purely from `scopes === null` vs. an array — there is no separate "is this an old token" marker
  to get out of sync; a pre-migration row simply has no `scopes` value to read, by construction.
- **MCP tools never take a token argument**; the CLI never takes a token flag. Both read only
  `MDSHARE_AGENT_TOKEN` / `MDSHARE_AGENT_TOKEN_FILE` from the process environment. Error paths from
  both are checked to confirm the token substring never appears in a thrown message (the upstream
  API's own error responses never echo the Authorization header back, so this is "don't introduce
  a new leak", not "redact an existing one").

## Steps

1. Write this plan ✓
2. `migrations/006_add_agent_token_scopes.sql` (not applied)
3. `api/_lib/agent-tokens.js` — `scopes`/`hasScope`/`isLegacyToken`/`ALLOWED_SCOPES`,
   `createToken`/`listTokens` updates
4. `api/_lib/catalog.js` (new leaf module)
5. `api/auth.js` — `scopes` validation on create, `scopes` in list, new `whoami`
6. `api/share.js`, `api/diagram.js`, `api/archify.js` — `documents:write` gate on POST,
   `documents:read` widening on GET
7. `api/pastes.js` — bearer catalog mode
8. `api/pin.js` — bearer `documents:publish` (own-row-only) path on the visibility branch
9. `api/dashboard.js` — scope checkboxes + badges
10. `mcp/src/index.ts` — 4 new tools + token-file fallback
11. `mcp/bin/mdshare-cli.mjs` (new) + `mcp/package.json` bin/files entries
12. `CLAUDE.md`, `README.md` updates
13. `tests/scopes.test.mjs`, `tests/catalog.test.mjs` (new)
14. `node --check` every touched/added `.js`/`.mjs` file
15. `node --test --test-force-exit tests/*.test.mjs` — full suite (old + new) must pass
16. MCP: `cd mcp && npx tsc --noEmit` (typecheck) and `npx tsc` (build) if the package has no
    separate lint config — check `mcp/package.json`'s scripts for an existing `lint`; if none
    exists, state that explicitly in the result doc rather than inventing one
17. `node --check mcp/bin/mdshare-cli.mjs`
18. Write `AGENT-SEARCH-RESULT.md` with every command run and its actual output, plus caveats
19. `git add` + commit only this session's own changes (no push)

## Success criteria

1. `api/` stays at exactly 12 top-level files.
2. Every one of the 65 pre-existing tests still passes, unmodified, after all changes
   (`node --test --test-force-exit tests/*.test.mjs`).
3. A **legacy** token (mocked DB row with no `scopes` field / `scopes: null`) still creates and
   reads-back-own exactly as before, and is denied (`403`) both the new catalog mode and the new
   publish path — proving zero silent escalation.
4. A **scoped** token with only `documents:write`: can create; `403` on catalog search; `403` on
   publish, even on its own row.
5. A **scoped** token with only `documents:read`: `403` on create (if it tries); can search/recent
   the catalog including rows it did not create and rows that are still private; `403` on publish.
6. A **scoped** token with only `documents:publish`: `403` on create; `403` on catalog; can flip
   `is_public` on a row it created; `403`/`404` on a row it did not create (own-row enforcement).
7. Invalid/malformed/revoked/expired bearer on any touched route: `401`, zero Supabase
   write/insert/patch call ever made (mocked-fetch assertion), never a cookie/anonymous fallback.
8. Catalog search excludes expired non-pinned rows (server-side filter, verified via mocked
   Supabase response plus the constructed request), includes expired-but-pinned rows, respects a
   `kind` filter, and clamps/rejects malicious `limit`/`offset`/`q` values (verified against the
   actual constructed fetch URL, not just the HTTP status code).
9. `GET /api/auth?action=whoami`: `401` with no/invalid bearer, `200` with the resolved token's own
   `id`/`name`/`legacy`/`scopes`/`expires_at` and nothing else, for a valid one.
10. Owner-cookie behavior (dashboard listing, token create/list/revoke, pin/unpin, visibility
    toggle on arbitrary rows) is completely unaffected — proven by every corresponding pre-existing
    test still passing unmodified, plus `create_token` called with no `scopes` field still
    producing a legacy (`scopes: null`) token.
11. `node --check` passes on every touched/added JS file; `mcp`'s TypeScript typechecks/builds (or
    the result doc states exactly which check was unavailable and why).
12. No production deploy, no migration apply, no `git push`, no new/rotated production credential,
    no remote/secret ever printed to a tool result or committed file in this session.
13. `git log` after this session shows exactly one new commit (or a small, clearly-scoped set)
    containing only this session's changes, on top of the existing clean history, not pushed.
