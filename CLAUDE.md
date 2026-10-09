# CLAUDE.md — mdshare app

Vercel serverless app: plain Node functions under `api/` (not Next.js, despite README wording) + Supabase Postgres. Deployed at `mdshare-rileylins-projects.vercel.app`.

## Layout
- `api/*.js` — one file = one Vercel function. `vercel.json` rewrites pretty paths (`/v/:id`, `/d/:id`, `/a/:id`, `/raw/:id`, `/dashboard`) to the matching function.
- `api/_lib/access.js` — shared helpers: Supabase row fetch/patch, id validation, visibility check (`isVisible`), login-gate HTML, publish/unpublish UI+script snippet. Underscore prefix keeps Vercel from routing it as its own function.
- `public/index.html` — static home page (paste box).
- `migrations/*.sql` — additive-only. Applied manually against Supabase by the repo owner; agents never run/apply these.
- `tests/*.test.mjs` — `node --test`. Some handlers register a rate-limit-cleanup `setInterval`; run with `--test-force-exit` or tests may hang after passing.
- `mcp/` — separate npm package (`mdshare-mcp`), an MCP server wrapping `POST /api/share`.

## Content model
Three kinds, three tables: `mdshare_pastes` (markdown, `/v/:id`), `mdshare_diagrams` (SVG, `/d/:id`), `mdshare_archify` (self-contained interactive HTML + IR, `/a/:id`). All three have `is_public boolean DEFAULT false` (private-by-default; see `migrations/004_add_is_public.sql`) plus `pinned`/`expires_at` for TTL/keep-forever.

## Auth model
Single-owner, password-based — no per-user accounts. `MDSHARE_PASSWORD` env var; `MDSHARE_HMAC_SECRET` (falls back to `SUPABASE_SERVICE_KEY`) signs sessions. `api/auth.js` issues a signed, server-expiring session cookie (180 days) — read its header comment for the exact token format and the legacy-cookie transition window/cutoff. `isAuthenticated(req)` means "is the owner."

**Agent (machine) bearer tokens — additive, added 2026-09-25.** Separate from the owner cookie above: the owner-authenticated dashboard's "API Tokens" panel (`api/dashboard.js`) issues named, expiring, revocable `Authorization: Bearer <token>` credentials for scripts/agents (`api/_lib/agent-tokens.js`). Only a SHA-256 hash is ever persisted (`mdshare_agent_tokens.token_hash`, migration `005_add_agent_tokens.sql`); the raw value is shown once at creation and never logged. A bearer token can `POST /api/share|diagram|archify` (creates a row attributed to itself via `created_by_token`, always `is_public:false` regardless of the request body — identical to anonymous create) and `GET` back **only rows it itself created** — `isVisible(row, req, res, { agentOwns })` in `access.js` is the added OR-branch. An `Authorization` header that's present but invalid/expired/revoked always `401`s and never silently falls back to anonymous creation; a completely absent header is the unchanged anonymous/owner/public path. The MCP client (`mcp/src/index.ts`) reads an optional `MDSHARE_AGENT_TOKEN` env var and sends it as the bearer header when set — unset behaves exactly as before.

**Explicit scopes + agent-native catalog/publish — additive, added 2026-10-08 (`AGENT-SEARCH-PLAN.md`).** Every token row gained a nullable `scopes text[]` column (migration `006_add_agent_token_scopes.sql`). `scopes === null` — true for **every** token created before this change, and for any new token the owner creates via `POST /api/auth {action:'create_token'}` while simply omitting the `scopes` field — is a **legacy** token: unaffected, exactly the create+own-row-read behavior above, no new capability, ever (checked structurally via `isLegacyToken()` in `api/_lib/agent-tokens.js`, not a flag that could drift). A token created **with** an explicit `scopes` array (owner-chosen, validated against `ALLOWED_SCOPES`, even `[]`) is **scoped**: its capabilities come only from that array, on top of the same universal own-row-read floor every token has always had. Three scopes exist, and no more (there is deliberately no delete/mint/revoke scope — bearer tokens can never create, revoke, or enumerate other tokens, nor delete any content, regardless of scope):
- `documents:read` — read **any** owner row (not just rows this token created) via the raw `GET` routes on `share.js`/`diagram.js`/`archify.js`, **and** is required for any access at all to the new agent catalog mode on `GET /api/pastes` (same route the owner dashboard already used for its own listing — an `Authorization` header routes to this new bearer-gated catalog branch instead, see `api/_lib/catalog.js`). The catalog supports `q` (real server-side `ilike` search, not "fetch latest 100 then filter in JS" — see that file's injection-defense notes), `kind` (`paste`/`diagram`/`archify`/`all`), and bounded `limit`/`offset` pagination; expired non-pinned rows are excluded server-side.
- `documents:write` — required, **for a scoped token only**, to `POST` (create) via those same three routes. A legacy token's create ability is completely unaffected by this scope's absence.
- `documents:publish` — lets a scoped token `PATCH /api/pin` (the `{id, kind, is_public}` visibility-toggle shape) to flip its own content's visibility, but **only on a row it itself created** — intentionally not "publish anything in the owner's library" even though `documents:read` is library-wide; this asymmetry is deliberate (see `AGENT-SEARCH-PLAN.md`).

`GET /api/auth?action=whoami` (bearer-only, no owner cookie involved) lets a token introspect itself: `{ id, name, legacy, scopes, expires_at }`, `401` on an absent/invalid header, never any other token's data. The owner dashboard's token-creation form now has `documents:read`/`write`/`publish` checkboxes (all unchecked → omits `scopes` entirely → legacy token, zero extra clicks for the old simple flow) and shows each token's scopes (or a "legacy" badge) in its list. `mcp/bin/mdshare-cli.mjs` is a new, dependency-free portable CLI (`status`/`search`/`recent`/`read`/`create`/`publish`) for machines without an MCP client; both it and `mcp/src/index.ts`'s four new tools (`auth_status`, `search_documents`, `read_document`, `publish_document`) resolve the bearer token only from `MDSHARE_AGENT_TOKEN`/`MDSHARE_AGENT_TOKEN_FILE` — never a tool argument or CLI flag.

## Visibility model
- Content is private unless `is_public = true` on its row.
- `isVisible(row, req)` (in `_lib/access.js`) = owner OR `row.is_public`. Every render/raw/IR route calls it before returning content, and treats Supabase fetch errors as **not visible** (fail closed).
- Only `PATCH /api/visibility` can flip `is_public`, and only when `isAuthenticated(req)`. Creation (`POST`) routes build explicit insert payloads and always set `is_public: false` — never read that field from the request body.
- Unauthenticated `POST` still creates content (rate-limited, as before); it just always creates private rows.

## Security notes — read before touching auth/render/archify files
- Every Supabase REST call interpolates a row `id` into a PostgREST filter string. Always run untrusted ids through `isValidId()` and `encodeURIComponent()` first (see `_lib/access.js`).
- `api/archify-html.js` serves attacker-reachable HTML: anyone can `POST /api/archify` with arbitrary `html`. It must only ever be loaded inside an iframe with `sandbox="allow-scripts"` and **no** `allow-same-origin` — that combination would hand the framed content the real mdshare origin's cookies/APIs. `api/archify-render.js` builds that iframe; don't change it back to inlining the stored HTML into the top-level document.
- Render/raw responses use `Cache-Control: private, no-store` deliberately — output depends on the auth cookie and on `is_public`, so caching would leak private content or serve stale state after a publish/unpublish toggle.

## Local dev / testing
```
node --test --test-force-exit tests/*.test.mjs
```
No build step; Vercel deploys `api/` and `public/` directly. Deploys and Supabase migrations are run by the repo owner, not by agents.
