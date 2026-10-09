# Agent-native scoped catalog search/read/create + explicit publish — result

Implements `AGENT-SEARCH-PLAN.md` in full. Parent constraint honored throughout: **no deploy, no
migration apply, no production credentials issued, no `git push`, no remote/secret ever printed.**

## What changed (see `AGENT-SEARCH-PLAN.md` "Files" for the full file list/rationale)

- **Migration 006** (`migrations/006_add_agent_token_scopes.sql`, additive, **not applied**): adds
  a nullable `scopes text[]` column to `mdshare_agent_tokens`.
- **Scope model** (`api/_lib/agent-tokens.js`): `scopes === null` = legacy token (every
  pre-existing token, by construction) = unaffected, unconditional create + own-row-read, no
  catalog, no publish. A `scopes` array = scoped token, gated per-capability by
  `documents:read`/`documents:write`/`documents:publish`. `hasScope()`/`isLegacyToken()` are the
  two structural checks every gate uses.
- **`api/_lib/catalog.js`** (new): real server-side search (sanitized `ilike` OR-filter across
  title + body columns), real server-side not-expired-or-pinned filtering, real server-side
  bounded `limit`/`offset`, across `paste`/`diagram`/`archify`/`all` — not "fetch latest 100, then
  `Array.filter()`".
- **`api/auth.js`**: `create_token` validates an optional `scopes` array (unknown value → `400`
  before any Supabase call; omitted → legacy token, byte-identical to every existing caller);
  `tokens` listing includes `scopes`; new bearer-only `GET ?action=whoami` introspection route.
- **`api/share.js` / `api/diagram.js` / `api/archify.js`**: `POST` gated on `documents:write` for
  scoped tokens only (legacy unaffected); `GET` visibility widened to any row when the token holds
  `documents:read` (legacy unaffected — its own-row-only check is untouched).
- **`api/pastes.js`**: an `Authorization` header now routes to a new bearer-gated catalog mode
  (`documents:read` required, `403` otherwise) entirely separate from the unchanged owner-cookie
  dashboard-listing branch (reached only with no `Authorization` header at all).
- **`api/pin.js`**: the visibility-toggle branch (`{id, kind, is_public}` shape only — pin/unpin
  untouched) gained a bearer `documents:publish` path, strictly own-row-only (fetches the row
  first and compares `created_by_token` before patching).
- **`api/dashboard.js`**: three scope checkboxes on the "+ New token" form (all unchecked → omits
  `scopes` → legacy token, zero extra clicks for the existing simple flow) and scope/legacy badges
  on the token list.
- **`mcp/src/index.ts`**: four new tools (`auth_status`, `search_documents`, `read_document`,
  `publish_document`); token now also resolvable from `MDSHARE_AGENT_TOKEN_FILE`, read via a
  proper static `fs` import (an earlier draft used `require()`, which is not available under this
  package's ESM/`NodeNext` module setup — caught by `tsc --noEmit` + a manual review, fixed before
  the final build).
- **`mcp/bin/mdshare-cli.mjs`** (new): portable, dependency-free CLI — `status`/`search`/`recent`/
  `read`/`create`/`publish`. No `--token` flag; only `MDSHARE_AGENT_TOKEN` /
  `MDSHARE_AGENT_TOKEN_FILE` (env) / `--token-file <path>`. Never prints the token.
- **`mcp/package.json`**: adds the `mdshare-cli` bin entry + ships `bin/` in `files`.
- **`CLAUDE.md`, `README.md`**: documentation updated to match (scope table, `whoami`, catalog
  mode, publish-own-rows-only asymmetry, CLI/MCP machine-setup section).
- **`tests/scopes.test.mjs`** (new, 14 tests), **`tests/catalog.test.mjs`** (new, 15 tests).

## Commands run and actual output

### Baseline (before any change)
```
$ git status --porcelain        -> (empty, clean)
$ ls api/*.js | wc -l            -> 12
$ node --test --test-force-exit tests/*.test.mjs
  tests 65 / pass 65 / fail 0
```

### Final state (after all changes)
```
$ node --check <every touched/added .js/.mjs file>     -> OK, all 12 files
$ node --test --test-force-exit tests/*.test.mjs
  tests 94 / pass 94 / fail 0
$ ls api/*.js | wc -l                                   -> 12   (cap preserved, no new top-level file)
$ cd mcp && npx tsc --noEmit                             -> exit 0, no errors
$ cd mcp && npx tsc                                      -> exit 0, no errors (dist/ rebuilt)
$ node --check mcp/dist/index.js                         -> OK
$ node --check mcp/bin/mdshare-cli.mjs                   -> OK
$ node mcp/bin/mdshare-cli.mjs                            -> prints usage, exit 0
```
No lint script exists in either `package.json` (root or `mcp/`) — stated explicitly rather than
inventing one, per the task's "state unavailable checks" instruction.

Test breakdown: 65 pre-existing (unmodified, all still passing) + 14 new in `scopes.test.mjs` + 15
new in `catalog.test.mjs` = 94.

### New-test coverage mapped to the parent's required cases
- **Legacy tokens unchanged**: `scopes.test.mjs` — create unconditional, catalog `403`, publish
  denied; plus `agent-auth.test.mjs` (pre-existing, untouched) still green.
- **Revoked/expired/malformed denied**: pre-existing `agent-auth.test.mjs` cases untouched and
  still passing; the new scope/write/read/publish gates sit entirely downstream of that existing
  401 check (verified by reading every new branch — the resolve-then-401 check always runs first).
- **Scope isolation**: `scopes.test.mjs` — three dedicated tests, one scope at a time, confirming
  the other two capabilities are denied for each.
- **Cross-token read with explicit scope**: `scopes.test.mjs` — a `documents:read` token reads a
  different token's private row.
- **Denied publish**: `scopes.test.mjs` — no scope, wrong scope, and right scope but wrong row (own-
  row enforcement), all covered.
- **Private creation**: pre-existing `publish.test.mjs`/`visibility.test.mjs` untouched, still
  green — new code never touches the "`is_public` always false on create" invariant.
- **Expired exclusion**: `catalog.test.mjs` — mocked rows prove the expiry filter is a real
  Supabase request-URL parameter (`or=(expires_at.gt....,pinned.eq.true)`), and a merge/sort test
  confirms correct ordering/inclusion.
- **Pagination/search injection**: `catalog.test.mjs` — direct `sanitizeSearchTerm`/
  `clampPagination` unit tests against adversarial strings/numbers, plus an integration test
  asserting the actual constructed Supabase fetch URL for a malicious `q` never contains the raw
  injected clause and that `limit`/`offset` land clamped in that same URL.

## Implementation caveats (read before deploying)

1. **Migration 006 is not applied.** Until the parent runs it against Supabase, every `resolveAgentToken()`
   lookup's `select=...,scopes` will simply get `scopes: undefined` back from PostgREST for a
   column that doesn't exist yet — PostgREST's actual behavior for selecting a non-existent column
   is to **error** (`400`), not silently omit it, which `resolveAgentToken`'s existing `!res.ok` →
   `lookup_failed` → `401` branch already fails closed on. **Net effect: until migration 006 is
   applied, every bearer-token request everywhere 401s**, not just the new scope-gated ones. This
   is a safe failure mode (fail-closed) but worth knowing before flipping anything on — apply
   migration 006 before any token (old or new) is expected to keep working post-deploy.
2. **Catalog pagination across `kind=all` is best-effort, not exact**, by design (documented in
   `api/_lib/catalog.js`'s header and `AGENT-SEARCH-PLAN.md`): each table is independently
   paginated at the Postgres level, then merged/sorted/truncated in Node. Requesting one specific
   `kind` gets exact, single-table real pagination. A client that needs exact pagination across
   all three kinds should page by `kind` separately.
3. **Search covers `title` for every kind, plus `content` (paste) / `markdown` (diagram) / `kind`
   (archify)** — archify rows don't get their IR/HTML substring-matched (not meaningfully
   searchable text), only title/kind. Documented in `catalog.js`'s `KIND_CONFIG`.
4. **`documents:publish` is own-row-only, unconditionally** — not "own rows ideally" as a soft
   preference but a hard, enforced restriction (fetch-then-compare-`created_by_token` before any
   patch). A token can never flip visibility on the owner's content or another token's content,
   even holding this scope. Documented in three places: `AGENT-SEARCH-PLAN.md`, `api/pin.js`
   inline, `CLAUDE.md`.
5. **No `documents:delete`/revoke/mint scope exists**, by design — not an oversight. Bearer tokens
   can never delete content or manage other tokens, regardless of any scope combination.
6. **The portable CLI's `create` subcommand doesn't support `kind=archify`** — archify rows need
   `html`+`kind`+`ir` fields that don't map cleanly onto "one file argument"; the CLI says so and
   points at the MCP tools / direct `POST /api/archify` instead, rather than offering a
   half-working shape.
7. **One CLI smoke-test ran against the live public hosted instance** (`node mcp/bin/
   mdshare-cli.mjs status` with no token configured, before `MDSHARE_BASE_URL` was considered) —
   this was a read-only, unauthenticated `GET` with **no state-changing side effect** (confirmed:
   it 401'd, same as it would against either the old or new `auth.js` GET handler), not a deploy
   check, migration, or credential action. No further live calls were made after noticing this;
   all other verification used `node --test` with mocked `fetch`.
8. **An earlier MCP draft used `require('fs')` inside `index.ts`**, which does not exist under this
   package's ESM (`"type": "module"`, `tsconfig.json`'s `"module": "NodeNext"`) setup and would
   have thrown at runtime despite `tsc --noEmit` initially passing (TypeScript's ambient `Node`
   types don't universally flag this). Caught by manual review before the final build; fixed with
   a proper static `import { readFileSync } from "fs"`. Re-ran `tsc --noEmit` + `tsc` + `node
   --check dist/index.js` clean after the fix — this file reflects the corrected, final state.

## Not done / explicitly out of scope (per the plan)

- `api/render.js`, `api/diagram-render.js`, `api/archify-render.js`, `api/archify-html.js` (the
  human/cookie-only HTML-chrome render routes) were not touched — "machine-readable read routes"
  means the raw JSON/markdown/SVG/IR routes, which were already bearer-capable and are the ones
  extended here.
- `api/pastes.js`'s owner-cookie dashboard-listing response shape/behavior is byte-for-byte
  unchanged — only reachable, as before, when no `Authorization` header is present at all.
- `api/pin.js`'s pin/unpin (non-visibility) branch is untouched — owner-cookie-only, out of scope.
- No deploy, no migration apply, no new/rotated production credential, no `git push` — all
  explicitly reserved for the parent, per the task.

## Live-inspection follow-up (2026-10-08, same evening)

Parent's live inspection found: production still on commit `0068952` (pre-agent-token), the
`mdshare_agent_tokens` table doesn't exist yet (migration 005 not applied), and
`GET /api/pastes` on production (the pre-existing owner-dashboard listing code) returned a
stale-looking catalog — newest visible item from Oct 7 despite known Oct 8 content.

**Root cause confirmed by reading the live code path** (`api/pastes.js`'s owner-cookie branch,
unchanged since before this whole effort started): each of the three per-table Supabase queries
used `order=pinned.desc,created_at.desc&limit=100` with **no expiry filter in the query at all**
— the not-expired-or-pinned check (`.filter(p => !p.expired)`) ran in JS *after* that hardcoded
100-row fetch. Any expired-but-not-yet-purged row still occupied one of those 100 slots in the
DB's own ordering; once enough such rows sorted ahead of a given fresh row, that row simply never
made it into the 100-row window to begin with — no amount of post-fetch JS filtering can recover
a row the DB query never returned. This is a real latent bug in code that predates this entire
change, now fixed as part of this follow-up.

**Fix** (`api/pastes.js`, owner-cookie path only — the bearer-token catalog path in
`api/_lib/catalog.js` already did this correctly from the start): the same
`or=(expires_at.gt.<now>,pinned.eq.true)` real server-side filter now runs on all three per-table
queries (pastes/diagrams/archify), in the same request as `limit=100`, so the limit now bounds
100 *valid* rows. Added `?sort=latest` as a new, additive, backward-compatible query param on this
same route: switches both the per-table SQL `order=` clause and the final JS merge-sort to pure
`created_at.desc`, ignoring pinned priority — a genuine "what's actually newest" view, for
diagnosing exactly this class of staleness going forward. Omitting `?sort` is byte-identical to
the old default (pinned first, then recency); the response shape is unchanged. New tests:
`tests/pastes.test.mjs` (5 tests) — confirms the filter is a real query-string parameter on all
three table requests (not a post-fetch JS step), confirms a defense-in-depth JS filter still
catches a stale-mock violation, confirms `?sort=latest` orders by pure recency including past a
pinned row, confirms the default is unaffected, confirms the actual constructed order-by clause
switches correctly. Full suite after this fix: **99/99** (94 from the first pass + 5 new).

**Also re-verified per this follow-up's requests:**
- Machine auth-status + token-argv-free CLI setup were already in place from the first pass
  (`GET /api/auth?action=whoami`, the `auth_status` MCP tool, `mdshare-cli status`) — confirmed
  present, no `--token`-style flag anywhere in the CLI or MCP tool surface; token resolution stays
  env/file-only (`MDSHARE_AGENT_TOKEN` / `MDSHARE_AGENT_TOKEN_FILE` / `--token-file <path>`).
- Remote freshness: checked via `git status -sb` only (cached remote-tracking ref, no network
  fetch, no credential-bearing remote URL printed) — confirmed local `main` is ahead of
  `origin/main` by the commits made in this and the prior pass, consistent with nothing having
  been pushed, as instructed.
- No deploy, no migration apply (005 or 006), no production credential issuance, no push, in this
  follow-up either — parent is applying migrations and deploying separately after review, per
  their message.

## Commit

Two commits total across both passes, on top of the existing history, containing exactly the
files changed in each pass (`git status --porcelain` / `git status -sb` reviewed before each
commit — no stray/unexpected files, no secrets, no remote URL printed anywhere in this document
or in any tool output surfaced during either session). Neither pushed.

## Round 3 (2026-10-08, same evening, second follow-up)

Parent applied migration 005 (1273 pastes / 39 diagrams / 8 archify unchanged, all private;
baseline 65/65) and confirmed via `git fetch` that `origin/main` is still behind local `main` —
nothing reset. Three asks: (1) a portable-CLI login flow for new-machine setup (hidden password
prompt -> `/api/auth` -> issue a scoped per-machine token -> `0600` file, no tokens in args or
output; the dashboard-issued-token path still works too); (2) make sure "no extra serverless
function" is needed; (3) `documents:publish` should stay explicit/own-docs-only *unless* the
owner directly grants a broader capability — i.e. there should be a way to grant that broader
capability, deliberately and separately.

**`mdshare-cli.mjs login`** (new subcommand): hidden password prompt (interactive raw-mode stdin,
no echo — or `MDSHARE_OWNER_PASSWORD` env var for non-interactive use; never a CLI flag) ->
`POST /api/auth` (existing login route, unchanged) -> uses the returned `mdshare_auth` session
cookie to `POST /api/auth {action:'create_token', scopes}` (existing route, unchanged) -> writes
ONLY the raw token to a `0600` file (default `~/.mdshare/token`, `--token-file` to override).
`--stdout` is an explicit opt-in that prints *only* the token to stdout (for piping into e.g. a
protected secrets-store CLI) with every status line on stderr instead — this is exactly what the
parent said they'll use for OpenClaw's own agent token (piped directly into the protected secrets
store, no plaintext file, egress-proxy-restricted). **No new serverless function**: both requests
hit the already-existing `api/auth.js` route; `api/` is still exactly 12 files.

**Testability refactor + bug caught before commit**: to unit-test `cmdLogin` without a real
network call, `fail()` was changed to throw a catchable `CliError` instead of calling
`process.exit()`, and the script's real argv-parsing `main()` now only runs when the file is
executed directly (an `isDirectRun` guard) — observable CLI behavior (stderr + exit 1 on failure)
is unchanged; every `cmd*` function is now a plain importable async function. This refactor was
necessary because a first attempt at an integration test (spawn the real CLI as a subprocess
against a local HTTP server) failed with `fetch failed` / `SocketError: other side closed` —
traced to this dev sandbox's exec environment routing *all* outbound traffic, including 127.0.0.1
loopback, through an egress proxy that refuses unlisted hosts (confirmed directly: a plain
`http.request` to a local server returned the literal body `"Secret egress proxy refused the
request."`). Switched to the mocked-`global.fetch` unit-test pattern already used throughout this
repo's suite instead — no network dependency, same coverage. While building the subprocess test
first, syntax-checking caught an actual bug: an earlier edit of the `login` command had
accidentally produced `const token = ***;` (invalid syntax) instead of `const token =
createData.token;` — found via `node --check`, fixed before anything was committed. New tests:
`tests/cli-login.test.mjs` (7 tests) — file-mode writes only the token to a 0600 file and never
prints it, `--stdout` mode prints only the token (status goes to stderr), wrong password fails
closed with no file/token created, confirms there is no `--password` flag read anywhere (only the
env var or the hidden prompt), `cmdStatus` throws `CliError` rather than exiting, plus two small
`parseArgs`/`resolveToken` checks.

**`documents:publish:any`** (new, fourth scope in `ALLOWED_SCOPES`): deliberately separate from
`documents:publish`, never implied by it or by any scope combination (a dedicated test confirms
`documents:read` + `documents:publish` together still never leaks into library-wide publish).
Only active when the owner explicitly includes this exact string in a token's `scopes` array.
`api/pin.js`'s bearer path now checks both publish scopes: `documents:publish:any` skips the
own-row check entirely (same library-wide reach `documents:read` already has); plain
`documents:publish` keeps the original own-row-only behavior unchanged. Dashboard gained a
fourth, cautionary-styled (⚠️, red-tinted) checkbox for it, unchecked by default, visually and
functionally distinct from the plain `documents:publish` checkbox. New tests (added to
`tests/scopes.test.mjs`, 2 more): a `documents:publish:any`-only token publishing a row it did
NOT create; a token with `documents:read`+`documents:publish` (no `:any`) still denied on a
non-own row.

**Remote freshness**: re-confirmed via `git fetch origin` (parent's own report) that `origin/main`
is unchanged and behind local `main` — consistent with nothing pushed from this side. No deploy,
no migration apply, no production credential issuance, no push, in this round either.

Full suite after round 3: **108/108** (99 from round 2 + 2 new scope tests + 7 new CLI tests).
`api/` still exactly 12 files. MCP `tsc --noEmit` + `tsc` still build clean.

