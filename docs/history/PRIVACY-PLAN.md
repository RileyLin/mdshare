# Privacy Rollout — Implementation Plan

Parent tracker: `../PRIVACY-PHASES.md`. This file is the exact scope for the code change described there:
**all existing/new content (pastes, diagrams, archify) is private by default; only an authenticated owner action can make an item public; toggling off immediately revokes public access.**

## Files

### New
- `api/_lib/access.js` — shared: Supabase row fetch/patch helpers, `isValidId`, `isVisible(row, req)`, `tableFor(kind)`, login-gate HTML (reload-in-place, no open redirect), owner-only publish/unpublish UI+script snippet, privacy response headers. Underscore-prefixed dir so Vercel does not route it as a function.
- `api/visibility.js` — `PATCH /api/visibility {id, kind, is_public}`. The **only** route that can change `is_public`. Auth-gated.
- `migrations/004_add_is_public.sql` — additive: `is_public boolean NOT NULL DEFAULT false` on all three tables, explicit backfill to `false`, `ENABLE ROW LEVEL SECURITY`, `REVOKE ALL ... FROM anon, authenticated` (no policies added — service_role bypasses RLS and keeps working; anon/authenticated get zero direct rows). **Not applied by this session** — parent runs it.
- `tests/auth.test.mjs` — signed-cookie issue/verify, expiry, malformed cookies, legacy-cookie bounded transition, password-rotation invalidation.
- `tests/visibility.test.mjs` — anonymous deny / owner allow / public allow / stop-public re-deny, across all three kinds and their render+raw(+IR) routes; DB-error fail-closed; login-gate reflects the same URL (no redirect param).
- `tests/publish.test.mjs` — `PATCH /api/visibility` auth-only; POST create cannot set `is_public` regardless of request body.
- `tests/sandbox.test.mjs` — static source checks: archify iframe `sandbox` contains `allow-scripts` and never `allow-same-origin`; archify-html CSP present.
- `CLAUDE.md` — codebase cheat sheet (this repo had none).
- `PRIVACY-PLAN.md` — this file.
- `IMPLEMENTATION-REPORT.md` — written after implementation: file list, migration command, test output, known limits.

### Modified
- `api/auth.js` — 180-day signed, server-expiring session cookie (`exp.sigHex`), `timingSafeEqual` verification, safe handling of malformed/tampered cookies, bounded legacy-cookie transition window (documented cutoff constant), password rotation still invalidates sessions.
- `api/share.js` — GET (raw markdown) enforces `isVisible`; ids validated before use in Supabase filters; POST explicitly persists `is_public: false` (never reads it from the body).
- `api/render.js` (`/v/:id`) — enforces `isVisible`; unauthenticated + private ⇒ same-URL login gate (no content leak); owner-only Share/Stop-sharing control; `Cache-Control: private, no-store`; noindex + no-referrer headers.
- `api/diagram.js` — GET (raw SVG) enforces `isVisible`; ids validated; POST persists `is_public: false` explicitly.
- `api/diagram-render.js` (`/d/:id`) — same gate/control/header treatment as render.js.
- `api/archify.js` — GET (raw IR JSON) enforces `isVisible`; ids validated; POST persists `is_public: false` explicitly.
- `api/archify-render.js` (`/a/:id`) — same gate/control/header treatment; **and** stops inlining the stored archify HTML into the top-level document. Instead renders a wrapper page whose only "unsafe" content is a sandboxed `<iframe sandbox="allow-scripts" ...>` pointing at `/api/archify-html`, so uploaded archify HTML never runs with the mdshare origin's cookies/API access.
- `api/archify-html.js` — enforces `isVisible` (generic placeholder, no login UI — the parent page owns auth); tightened CSP (`default-src 'none'` + explicit allow-list + `frame-ancestors 'self'`).
- `api/pastes.js` — dashboard list now also returns `mdshare_archify` rows (kind `archify`) and `is_public` on every item.
- `api/dashboard.js` — catalog renders archify items (icon/badge/link to `/a/:id`) and shows a "Public" badge on public items.
- `package.json` — add `"type": "module"` (files already use ESM `import`/`export`; this removes the Node runtime warning and makes module type explicit — no behavior change under Vercel's bundler).

### Untouched (verified in scope, no change needed)
- `public/index.html`, `mcp/`, `.env.example`, `vercel.json` rewrites, `migrations/001-003`, `LICENSE`, `README.md`.

## Enforcement model
- `isVisible(row, req)` = `isAuthenticated(req) || row.is_public === true`. Applied before returning content from **every** render/raw/IR endpoint (`render.js`, `diagram-render.js`, `archify-render.js`, `archify-html.js`, `share.js` GET, `diagram.js` GET, `archify.js` GET) and before the Vercel rewrites (`/v/:id`, `/d/:id`, `/a/:id`, `/raw/:id`) that point at them — since the rewrites just alias these same handlers, enforcing in the handler covers both the rewrite and the direct `/api/...` path.
- Supabase fetch errors are treated as **not visible** (fail closed), never as "public" or "not found silently succeeding".
- `is_public` can only be set by `PATCH /api/visibility`, gated by `isAuthenticated(req)`. POST create handlers construct their Supabase insert payload with explicit fields (no body spread) and always include `is_public: false`, so a POST body containing `is_public: true` has no effect.

## Success criteria
1. Migration is additive-only; not applied by this session (parent runs it).
2. No anonymous request to any render/raw/IR route for a private item returns its title/markdown/SVG/IR/HTML.
3. Anonymous HTML-page request (`/v`,`/d`,`/a`) to a private item gets a same-URL login form, not a redirect elsewhere and not silent content.
4. `PATCH /api/visibility` requires auth; toggling `is_public` to `false` makes the item immediately unreachable to anonymous requests (no caching gap — `Cache-Control: private, no-store`).
5. Unauthenticated `POST` still creates rows (rate-limited, as today) and those rows are always private; no request body can force `is_public: true` on create.
6. Dashboard/`api/pastes` lists all three kinds with correct links and public/private status; owner-only Share/Stop-sharing control on each item's own page, with confirmation and in-place status update.
7. Archify HTML is only ever executed inside a `sandbox="allow-scripts"` iframe with no `allow-same-origin`; verified by a source-scan test.
8. Session cookie: HttpOnly, Secure, SameSite=Lax, ~180-day lifetime, server-verified expiry, `timingSafeEqual` comparison; malformed/tampered/expired cookies fail closed without throwing; pre-existing (legacy) cookies keep working until a documented cutoff, then require re-login (no perpetual token).
9. `node --test --test-force-exit tests/*.test.mjs` passes, including the pre-existing `delete-flow.test.mjs`.
10. No files outside `projects/mdshare/app/` touched; no secret values read, printed, or changed; no migration/deploy/push executed by this session.
