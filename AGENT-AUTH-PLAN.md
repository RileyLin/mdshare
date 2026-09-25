# Agent (machine) bearer-token auth — implementation plan

Parent tracker/audit: `../mdshare-agent-auth-review/FINDINGS.md` (read-only review, 2026-09-25) —
its bounded recommendation is what this plan implements. User explicitly authorized
implementation ("make it up then") after that read-only review.

**Naming note:** this repo already has a `PLAN.md` (the pin/Notion feature plan, already shipped
— see its checkmarks) and a scoped `PRIVACY-PLAN.md` for the private-by-default rollout. Following
that existing precedent rather than overwriting/repurposing `PLAN.md`, this feature's plan is its
own file: `AGENT-AUTH-PLAN.md`.

## Scope (from FINDINGS.md's recommendation, made concrete)

Additive-only machine auth, independent of the human password/cookie flow:
- Owner-authenticated UI can create a separate, named bearer token per agent/service.
- Token shown once at creation (masked-reveal-once flow), never logged, never re-displayed.
- Hash-only persisted (HMAC-SHA256, keyed by the existing `MDSHARE_HMAC_SECRET`), with id/name/
  scopes/expiry/revoked-at.
- `Authorization: Bearer <token>` only — never a query param.
- Invalid / expired / revoked token → `401`, **never** silently falls back to anonymous-create.
- Default scope: `create` + `read:own` (its own rows only). No delete, no visibility-toggle, no
  cross-owner read, no broad Supabase service-role exposure to tokens.
- Human password/cookie auth, session lifetime, and private-by-default behavior are all
  **unchanged**.

## Hard constraint: Vercel Hobby's 12-function cap

`api/` already has exactly 12 files == 12 functions (confirmed via `ls api/*.js`; this repo hit
this exact cap during the privacy rollout — see `ROLLOUT-RESULT.md`). **No new top-level `api/*.js`
file may be added.** New capability is added by:
1. Extending existing functions (`api/auth.js` gets new methods/body-shapes; `api/share.js`,
   `api/diagram.js`, `api/archify.js` get additive Authorization-header handling).
2. A new file under `api/_lib/` (underscore-prefixed dir — Vercel does not route these as
   functions, confirmed by `access.js`'s own file-header comment and by `CLAUDE.md`).

## Files

### New
- **`api/_lib/agent-tokens.js`** — standalone leaf module (crypto + Supabase REST calls only, no
  import from `./access.js` or `../auth.js`). Holds: `generateAgentTokenValue`, `hashAgentToken`,
  `extractBearerToken`, `resolveAgentToken` (bearer→principal lookup, never throws, distinguishes
  "no header" / "invalid" / "valid"), `ownsRow` (is this row's `created_by` this token's id —
  isolated query, fails closed to `false` rather than 503-ing every visitor if migration 006
  hasn't run yet), `createAgentToken` / `listAgentTokens` / `revokeAgentToken` (owner-only DB CRUD;
  callers are responsible for the auth gate).
  - **Why a new leaf module instead of adding to `access.js` or `auth.js` directly:** `access.js`
    already imports `{isAuthenticated, checkAuthAndRefresh}` from `auth.js`. If `auth.js` (which
    needs the token CRUD) imported back from `access.js`, or if `access.js` imported from a module
    that itself imports `auth.js`, that's a real import cycle. A dependency-free leaf that both
    `auth.js` and the content routes import from independently avoids the cycle entirely.
  - Duplicates the 1-line content-id shape check from `access.js`'s `isValidId` (same reason —
    avoiding the cycle). Documented in the file header; kept in sync via
    `tests/agent-auth.test.mjs`.
- **`migrations/006_add_agent_tokens.sql`** — additive: new `mdshare_agent_tokens` table
  (hash-only, RLS enabled, anon/authenticated revoked — same posture as migration 004/005), plus a
  nullable `created_by uuid references mdshare_agent_tokens(id)` column on all three content
  tables. **Not applied by this session** — parent runs it, same convention as every prior
  migration in this repo.
- **`tests/agent-auth.test.mjs`** — unit + integration coverage (see Success Criteria).
- **`AGENT-AUTH-PLAN.md`** — this file.

### Modified
- **`api/_lib/access.js`** — `isVisible(row, req, res, tokenOwnsRow = false)` gains a 4th,
  backward-compatible parameter: `row.is_public` OR owner-cookie OR `tokenOwnsRow === true`. The
  boolean is computed by each caller (via `ownsRow()` in the new leaf module) — `isVisible` itself
  stays synchronous (no new imports, no async footgun risk at any of its 7 existing call sites).
- **`api/auth.js`** — extends the existing single function, no new file:
  - `GET /api/auth?tokens=1` (owner-only) — list tokens (id, name, scopes, created_at, expires_at,
    revoked_at — **never** the hash or the raw value).
  - `POST /api/auth {action:"create_token", name, expires_in_days?}` (owner-only, dispatched by
    body shape — same pattern `api/pin.js` already uses to share one endpoint across two concerns)
    — validates `name` (1-64 printable chars) and `expires_in_days` (positive integer ≤ 3650 or
    omitted for no expiry), rate-limited per IP (10/hour, mirrors the existing login rate limiter),
    returns the raw token **once**.
  - `DELETE /api/auth {id}` (owner-only) — revokes (idempotent: revoking an already-revoked or
    unknown-but-valid-shape id both return a clean result, distinguished only by a real 404 for a
    genuinely unknown id).
  - Existing `GET` (status check) and `POST {password}` (login) behavior is unchanged.
- **`api/share.js`, `api/diagram.js`, `api/archify.js`** — `POST` (create): if an `Authorization`
  header is present it MUST resolve to a valid token or the request gets `401` before any Supabase
  call — never falls through to the existing anonymous-create path. If valid, the insert payload
  conditionally adds `created_by: <token id>` (omitted entirely when there's no token — so an
  un-migrated database is never sent an unknown column by ordinary anonymous/owner traffic; a
  `created_by` value can only exist once a token exists, which itself requires migration 006 to
  have already run — the dependency ordering is enforced by data, not just documentation). `GET`
  (raw read-back): resolves the token (if any) and passes `ownsRow(...)` through to `isVisible`.
- **`api/render.js`, `api/diagram-render.js`, `api/archify-render.js`, `api/archify-html.js`** —
  same `isVisible(..., tokenOwnsRow)` wiring for read-back consistency (an agent reading its own
  content back through the rendered page/iframe path, not just the raw JSON/markdown/SVG path).
- **`api/dashboard.js`** — new owner-only "Agent tokens" section: list + revoke, "+ New token"
  button → name (+ optional expiry) form → one-time reveal (readonly input + copy button, explicit
  "won't be shown again" warning, cleared from the DOM/JS state once dismissed). No
  `console.log`/network log of the raw value anywhere; it only ever exists in the JSON response
  body and that one input's value.
- **`CLAUDE.md`** — "Auth model" section gets one additive paragraph documenting the token layer
  (mirrors the existing single-owner paragraph's style/depth).

### Not touched
- `vercel.json` (no new routes), `README.md` (this is an owner-admin capability, not part of the
  public quickstart), `mcp/` package, `api/pastes.js`/`api/pin.js` (dashboard listing + pin/publish
  stay owner-cookie-only — out of the audit's bounded scope), any existing migration file.

## Design notes on specific requirements

- **Hash-only, no plaintext at rest:** `hashAgentToken` is HMAC-SHA256 keyed by
  `MDSHARE_HMAC_SECRET` (same fallback chain as `auth.js`'s session-cookie HMAC key) — rotating
  that one secret invalidates sessions **and** agent tokens together, consistent with the existing
  "one secret to revoke everything" story.
- **Constant-time / timing:** verification is a DB lookup by exact hash equality (`token_hash=eq.
  <hash>`), not an application-level byte-by-byte secret comparison — the classic timing side
  channel `timingSafeEqual` defends against (early-exit compare loops) doesn't exist in this shape,
  same reasoning GitHub/Stripe-style API-key-by-hash designs rely on. No manual constant-time
  compare is introduced because none is needed here; documented in the leaf module's header rather
  than added as theatre.
- **Input limits:** bearer token length bounded (20–512 chars) before it's ever hashed or sent to
  Supabase; `name` bounded to 64 printable-ASCII chars; `expires_in_days` bounded to a positive
  integer ≤ 3650.
- **CSRF / session handling:** no new mechanism added. The existing app relies on
  `SameSite=Lax` cookies (blocks cross-site POST/PATCH/DELETE with the cookie attached) for every
  owner-cookie-gated mutation, with no separate CSRF token anywhere in the codebase — the new
  owner-only token-management endpoints (`POST/DELETE /api/auth`) follow that exact existing
  pattern rather than inventing a new one.
- **Never falls back to anonymous create:** enforced structurally — the `Authorization` header
  check happens before the Supabase insert call in each of the three create routes, and returns
  `401` on any invalid/expired/revoked result. There is no code path where a rejected token still
  reaches the insert.
- **Attribution / rotation:** `created_by` on a content row is the token's own `id` (a UUID from
  the token row), not the human owner. Rotation = revoke old + create new (both already-provided
  primitives); no extra "rotate" endpoint needed. Human/owner-created rows keep `created_by = NULL`
  (both the current anonymous-create path and any future owner-cookie create path).
- **Read-back scope:** an agent token can read a row back (raw markdown/SVG/IR **and** the
  rendered page) only if it created that exact row (`created_by` match). It cannot list (`api/
  pastes.js` untouched), cannot toggle visibility, cannot delete, cannot see other tokens'/the
  owner's private rows. Public rows and owner-cookie access are unaffected either way.

## `gbrain` code-graph check (per repo instructions)

`code_callers`/`code_blast` on `isVisible` both returned "not built / not found" — this repo isn't
indexed in the connected brain's code graph. Per instructions, falling back to local references:
every call site of `isVisible` was found by reading each `api/*.js` file directly (7 call sites
across `share.js`, `diagram.js`, `archify.js`, `render.js`, `diagram-render.js`,
`archify-render.js`, `archify-html.js`) — all 7 are updated consistently above.

## Steps

1. Write this plan ✓
2. `migrations/006_add_agent_tokens.sql` (not applied)
3. `api/_lib/agent-tokens.js` (new leaf module)
4. `api/_lib/access.js` (`isVisible` 4th param)
5. `api/auth.js` (list/create/revoke token endpoints)
6. `api/share.js`, `api/diagram.js`, `api/archify.js` (Authorization header on create + read-back)
7. `api/render.js`, `api/diagram-render.js`, `api/archify-render.js`, `api/archify-html.js`
   (read-back wiring)
8. `api/dashboard.js` (owner UI)
9. `CLAUDE.md` update
10. `tests/agent-auth.test.mjs`
11. `node --check` every touched file + `node --test --test-force-exit tests/*.test.mjs`
12. Local synthetic browser check of the new dashboard UI (no live Supabase — see Implementation
    report for exact method and its limits)
13. Commit (no push, per existing repo convention)
14. Write `../mdshare-agent-auth-review/IMPLEMENTATION.md`

## Success criteria

1. `api/` function count stays at 12 (no new top-level file).
2. Human password/cookie login, session lifetime, and private-by-default behavior for every
   existing route are unchanged — proven by the full existing test suite still passing unmodified.
3. Owner-authenticated dashboard can create a named token, sees the raw value exactly once, sees
   it in the token list (without the value) afterward, and can revoke it.
4. `POST /api/share|diagram|archify` with no `Authorization` header: unchanged anonymous-create
   behavior (rate-limited, always private, no `created_by`).
5. Same routes with a **valid** token: creates successfully, row gets `created_by` set to the
   token's id, `is_public` is still always `false` regardless of request body.
6. Same routes with an **invalid/expired/revoked** token: `401`, confirmed no Supabase insert call
   ever happens (mocked-fetch assertion, not just a status code check).
7. `GET` raw / rendered routes: the token's own row is readable via the token (no cookie, private,
   `is_public:false`); a **different** private row (not owned by that token) stays denied; if the
   ownership-check query itself fails (simulating "migration not applied yet"), the read still
   fails closed (deny) rather than 503ing or crashing the shared visibility path.
8. Owner-cookie access to everything (own rows, all tokens' rows, public rows) is unaffected.
9. Token values are never logged (`console.*`), never appear in a URL/query string, and the create
   response is the only place the raw value ever appears server-side.
10. `node --test --test-force-exit tests/*.test.mjs` passes, all tests included (old + new).
11. No production deploy, no migration apply, no `git push` performed by this session — explicit
    parent/owner action required for those three, spelled out in the implementation report.
