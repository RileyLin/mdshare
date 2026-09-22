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
