# IMPLEMENTATION-REPORT.md — Private-by-default sharing

Status: implemented and tested locally. **Not deployed, not migrated, not pushed** — that is explicitly the parent's step.

## Files changed

### New
- `api/_lib/access.js` — shared visibility/access helpers (`getRow`, `patchRow`, `isVisible`, `isValidId`, `tableFor`, `setPrivacyHeaders`, `privateGateHtml`, `visibilityControlHtml`/`Script`).
- `api/visibility.js` — `PATCH /api/visibility` (only route that can set `is_public`; auth-gated).
- `migrations/004_add_is_public.sql` — additive migration (see "Migration" below). **Not run.**
- `tests/auth.test.mjs`, `tests/visibility.test.mjs`, `tests/publish.test.mjs`, `tests/sandbox.test.mjs`.
- `CLAUDE.md`, `PRIVACY-PLAN.md`, `IMPLEMENTATION-REPORT.md` (this file).

### Modified
- `api/auth.js` — 180-day signed, server-expiring session cookie; `timingSafeEqual`; safe malformed-cookie handling; bounded legacy-cookie transition (`LEGACY_COOKIE_CUTOFF = 2026-10-22T00:00:00Z`, ~30 days from rollout); password rotation still invalidates sessions.
- `api/share.js`, `api/diagram.js`, `api/archify.js` — GET (raw/IR) now enforces `isVisible`; POST insert payloads explicitly set `is_public: false` (never read from the request body).
- `api/render.js`, `api/diagram-render.js`, `api/archify-render.js` — enforce `isVisible`; unauthenticated+private → same-URL login gate; owner-only Share/Stop-sharing control with confirmation; `Cache-Control: private, no-store`; `X-Robots-Tag: noindex`; `Referrer-Policy: no-referrer`.
- `api/archify-render.js` — **no longer inlines** the stored archify HTML into the top-level document. Renders a wrapper page with a `sandbox="allow-scripts"` iframe (no `allow-same-origin`) pointing at `/api/archify-html`.
- `api/archify-html.js` — enforces `isVisible` directly (it's the iframe's own `src`, fetched independently by the browser); tightened CSP (`default-src 'none'` + explicit allow-list + `frame-ancestors 'self'`); no login UI (parent page owns auth).
- `api/pastes.js` — dashboard list now also returns `mdshare_archify` rows (`kind: 'archify'`) and `is_public` on every item.
- `api/dashboard.js` — catalog renders archify items (icon, kind badge, link to `/a/:id`) and a "Public" badge on public items.
- `package.json` — added `"type": "module"` (files already used ESM syntax; removes the Node runtime warning, no behavior change under Vercel's bundler).

## Enforcement model (what actually changed, mechanically)
- Every render/raw/IR handler now calls `getRow(table, id, select)` then `isVisible(row, req)` before touching the response body. `isVisible` = `isAuthenticated(req) || row.is_public === true`. A Supabase fetch error (`dbError`) or a missing/expired row is always treated as "not visible" — never as public, never as a silent 200.
- `is_public` can only change via `PATCH /api/visibility`, which 401s without a valid owner session. All three POST-create handlers build explicit Supabase insert payloads (no request-body spread) and hardcode `is_public: false`, so nothing in the create request body can flip it — verified by `tests/publish.test.mjs`.
- Render responses are `Cache-Control: private, no-store` (previously `s-maxage=60` on some routes) so a CDN/browser cache can't serve a stale authenticated view or a stale public/private state after a toggle.
- The private-content login gate reloads the exact URL that was requested (`window.location.reload()`), so there is no redirect-target parameter to validate/abuse, and no title/content is ever included in that page.

## Archify sandboxing (the one real vulnerability fixed, not just hardened)
Before this change, `/a/:id` merged the stored, attacker-reachable archify HTML (anyone can `POST /api/archify` with arbitrary `html`) directly into the top-level document served from the mdshare origin. Any script in that HTML ran with the mdshare origin's ambient authority — same-origin `fetch()` to `/api/*` with the owner's cookies attached, if the owner ever opened that link while signed in.

Fix: `/a/:id` now renders a small wrapper page (mdshare chrome + Share/Stop-sharing control) and loads the stored HTML only inside `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" src="/api/archify-html?id=...">`. `allow-same-origin` is deliberately never added — combining it with `allow-scripts` is the well-known sandbox-escape antipattern that would restore the original vulnerability. Archify's own interactivity (pan/zoom/hover-to-trace/theme toggle) is pure client-side DOM work and needs no origin access, so it's unaffected. `api/archify-html.js`'s CSP independently blocks any network calls (`connect-src 'none'`) as defense in depth even if the sandbox were ever misconfigured. `tests/sandbox.test.mjs` statically asserts the iframe's `sandbox` attribute never contains `allow-same-origin` and that the old inlining code path (`injectMdshareBar`) is gone.

## Migration (for the parent to run — not applied by this session)
File: `migrations/004_add_is_public.sql`. Additive: adds `is_public boolean NOT NULL DEFAULT false` to `mdshare_pastes`, `mdshare_diagrams`, `mdshare_archify` (existing rows become `false`/private), enables RLS on all three, and revokes direct `anon`/`authenticated` grants (no policies added, so those roles get zero rows for every operation; `service_role` — what the Vercel backend uses — bypasses RLS and is unaffected).

Apply against Supabase (e.g. via the SQL editor, or `psql "$SUPABASE_DB_URL" -f migrations/004_add_is_public.sql` if a direct Postgres connection string is available) **before** deploying this code, so the new `is_public`/`isVisible` checks have a column to read. If deployed before the migration runs, `getRow`'s `select=...,is_public` would fail the Supabase query and every handler would fail closed (503/404) rather than exposing anything — safe failure mode, but check the order to avoid a temporary outage.

## Test proof
```
$ node --test --test-force-exit tests/*.test.mjs
ℹ tests 39
ℹ suites 0
ℹ pass 39
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
Coverage: anonymous deny / owner allow / public allow / stop-sharing re-deny across all three kinds and their render + raw(+IR) routes; DB-error fail-closed (both a non-ok Supabase response and a thrown network error); expired-row denial even for the owner; malformed/tampered/expired session cookies; legacy-cookie bounded transition (valid before cutoff, rejected after); password rotation invalidating sessions; `PATCH /api/visibility` auth-only + invalid-kind/invalid-id/invalid-boolean rejection + Supabase-404 surfaced correctly; POST create routes ignoring `is_public` in the body for all three kinds; archify iframe sandboxing (no `allow-same-origin`, old inlining path removed); archify-html CSP; the pre-existing `tests/delete-flow.test.mjs` (unmodified) still passes.

`node --check` passes on every modified/new `api/*.js` file. No lint/build tooling exists in this repo (no `next`/bundler dependency, no `eslint` config, no `build` script in `package.json`) — none was skipped, none exists to run.

## Browser UI verification
**Not performed — stated blocker:** the app is a Vercel deployment backed by a live Supabase project; there is no local dev server config (`vercel dev` needs the real `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`MDSHARE_PASSWORD` env vars, which this session does not have and was told not to read/print). Live/browser verification of the deployed behavior — including the actual "Share publicly" / "Stop sharing" click-through, the login-gate flow on a real link, and archify's interactive pan/zoom inside the sandboxed iframe against a real deployment — is the parent's smoke-test step after migration + deploy, per the task's division of responsibility.

## Known limits / things the parent should double-check
1. **Migration ordering matters** (see above): apply `004_add_is_public.sql` before/at deploy, not after — otherwise every content route fails closed (safe, but produces a temporary outage rather than a leak).
2. **Legacy-cookie transition is now seamless for active sessions.** `checkAuthAndRefresh()` (used by every authenticated route) silently re-issues a fresh 180-day v2 cookie the first time it validates a request via the old cookie format — no re-login, no visible change. The `2026-10-22` cutoff (`LEGACY_COOKIE_CUTOFF` in `api/auth.js`) now only matters for a browser that makes zero authenticated requests in the ~30 days after rollout; that one residual case still needs a single password re-entry after the cutoff, which cannot be avoided without either a perpetual (never-expiring) token or a way to reach an idle browser from the server, neither of which is acceptable. See `UX-COMPATIBILITY-CHECKLIST.md` for the full writeup Riley requested.
3. **Dashboard-level toggle scope:** the "Share publicly / Stop sharing" control lives on each item's own page (`/v`, `/d`, `/a`), which is where the existing Pin/Delete/Save controls already live. The dashboard **list** shows a read-only "Public" badge on public items but does not duplicate the toggle inline per row (kept the diff bounded; the list already supports batch pin/unpin, and adding a second confirmation-gated batch action there was out of scope for a minimal diff). If per-row toggling from the list is wanted, that's a follow-up, not done here.
4. **DB error responses** distinguish "temporarily unavailable" (503) from "not found/private" (404) in the render pages, but intentionally do **not** distinguish "private" from "genuinely doesn't exist" to an anonymous caller on raw/IR routes (both are a generic 404) — only the HTML render routes show the login-gate (which does reveal "something exists here, sign in"), matching the task's login-prompt requirement without leaking title/content.
5. **git remote note (not a code change):** this repo's `origin` remote URL has a GitHub token embedded in it (from prior setup, unrelated to this task). Not modified, not printed again after the one `git remote -v` check during initial repo inspection; flagging for the owner to rotate/move to a credential helper at convenience — out of scope for this change and not touched.

6. **Private-by-default and previously-shared links (the one tradeoff needing sign-off):** links created by unauthenticated `POST` (agent auto-upload or the homepage paste box) are now private until the owner clicks "Share publicly." Anyone opening such a link without the owner's cookie — including a Telegram recipient or the agent itself — sees a sign-in prompt, not the content, until it's published. This is the deliberate, requested feature (private-by-default), not a bug, but it does change the "generate a link and forward it" habit unless that link is published first. Flagged for explicit confirmation in `UX-COMPATIBILITY-CHECKLIST.md` rather than assumed either way.

## Commit
Local commit only, on `main`, no push (per instructions). See `git log -1` in this repo for the exact commit.
