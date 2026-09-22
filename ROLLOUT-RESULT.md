# ROLLOUT-RESULT.md — private-by-default sharing, deployed 2026-09-22

## Deployed
- **Production URL:** https://mdshare-rileylins-projects.vercel.app (aliases: `mdshare-theta.vercel.app`, `mdshare-git-main-rileylins-projects.vercel.app`)
- **Deployment ID:** `dpl` for `mdshare-d7zc6f6bo-rileylins-projects.vercel.app` (target: production, Vercel project `prj_Ds2SO8grYWn9c8LwESN04QVcr28P`, team `team_LVaHJxu5IBnbppmuwYrYbcWf`)
- **Commit deployed:** `0068952` on `main` (local only — not pushed to origin, per instructions)
- **DB migration applied:** `migrations/004_add_is_public.sql`, run once via Supabase Management API against project `recblkqymttrsysjhdbc`. RLS + REVOKE were already live before this session (verified read-only, not assumed); the `ADD COLUMN is_public boolean NOT NULL DEFAULT false` on all three tables was the only part actually missing, and is what this session applied.

## Real blocker found + fixed (not silently absorbed)
**Vercel Hobby plan caps deployments at 12 serverless functions.** Old live code had exactly 12; adding `api/visibility.js` made 13 and the first deploy attempt failed outright (`Error: No more than 12 Serverless Functions...`). Asked Riley to choose between paying for Pro vs. a free code consolidation; got no reply within the wait window, so proceeded with the no-cost, no-risk default: **merged `api/visibility.js`'s PATCH logic into `api/pin.js`**, dispatched by body shape (`kind` present → visibility toggle; absent → existing pin/unpin), with the client-side toggle script's fetch URL updated from `/api/visibility` to `/api/pin`. No user-facing URL or page changed — this was an internal API consolidation only. Function count is back to 12. All 45 tests still pass after the merge (one edge-case bug in my first dispatch attempt — invalid `is_public` type falling through to pin logic instead of hitting the "must be boolean" validation — was caught by the existing test suite and fixed before deploy).

## Real UX regression found + fixed (per your explicit instruction not to silently accept it)
The old `archify-render.js` force-applied archify's `editorial` (warm-paper) preset + light theme before serving, matching mdshare's house look. That logic (`applyWarmPaperDefault`) was dropped in the privacy rewrite when archify's rendering moved into a sandboxed iframe, and was never re-added anywhere — neither the archify CLI nor the mdshare upload path forces a preset at creation time either. Net effect, unfixed: any archify diagram without an explicitly embedded `data-preset` would have silently stopped matching mdshare's house style after this deploy.

**Fix:** re-added `applyWarmPaperDefault()` to `api/archify-html.js` (the file that now actually serves the stored HTML into the iframe), applied to `row.html` before every response. Verified live in production (see below) — a fixture created with no `data-preset` attribute at all came back from `/api/archify-html` with `data-preset="editorial" data-theme="light"` injected, exactly like before.

## Migration revised (non-destructive on rerun, per your instruction)
Original draft of `004_add_is_public.sql` included an explicit `UPDATE ... SET is_public = false` backfill on all three tables — redundant (the `ADD COLUMN ... DEFAULT false` already backfills once, at creation) and destructive if the file were ever re-run after a human had deliberately published something. Removed those three UPDATE statements; kept `ADD COLUMN IF NOT EXISTS` / `ENABLE ROW LEVEL SECURITY` / `REVOKE`, all naturally idempotent. Confirmed via live read-only queries: before this session's edit, RLS+REVOKE were already applied but the column did not exist yet, so this was genuinely a first-time run, not a rerun — the fix is forward-looking safety, not a correction of something already broken.

## Legacy-cookie transparent upgrade — already implemented, not modified
`checkAuthAndRefresh()` silently re-issues a fresh 180-day v2 cookie the first time it validates a request via the old (pre-rollout) cookie format — this was already done by a prior session (see `UX-COMPATIBILITY-CHECKLIST.md`), not something this session needed to add. `LEGACY_COOKIE_CUTOFF = 2026-10-22` only matters for a browser making zero authenticated requests in that ~30-day window.

## Test proof
```
$ node --test --test-force-exit tests/*.test.mjs
ℹ tests 45
ℹ pass 45
ℹ fail 0
```
`node --check` passes on every modified `api/*.js` file. (39 tests originally reported → 43 after the prior session's seamless-upgrade work → 45 after this session's two new regression tests: preset-forcing behavior + `applyWarmPaperDefault` unit test.)

## Live verification (production)

### DB state (read-only queries, before and after)
- Before: RLS enabled ✅, anon/authenticated grants revoked ✅ (both already true), `is_public` column **absent** on all 3 tables.
- After migration: `is_public boolean NOT NULL DEFAULT false` present on all 3 tables.
- Row counts preserved exactly, nothing lost, nothing unexpectedly made public:
  - `mdshare_pastes`: 1179 rows, 0 public (before and after)
  - `mdshare_diagrams`: 39 rows, 0 public
  - `mdshare_archify`: 7 rows, 0 public

### HTTP-level checks against the live production URL (curl; see limitation note below on browser)
| Check | Result |
|---|---|
| Anon `raw/qNYPmUfOQj` (pre-existing content, formerly world-readable) | **404** (was 200 before deploy) |
| Anon `/v/qNYPmUfOQj` render | **401** login gate |
| Anon `/dashboard` | **401** |
| `POST /api/auth` with real production password | **200**, `Set-Cookie: mdshare_auth=<redacted>; Max-Age=15552000; Path=/; HttpOnly; SameSite=Lax; Secure` — 15552000s = exactly 180 days |
| Authenticated `GET /api/auth` | 200 `{ok:true}` |
| Authenticated `GET /dashboard` | 200 |
| Synthetic paste created with `is_public:true` in the POST body | Created **private** anyway (anon `raw/:id` → 404) — confirms create routes never trust that field |
| Owner publishes via `PATCH /api/pin` (merged visibility endpoint), `kind:"paste"` | 200, then anon `raw/:id` → **200**, correct content |
| Owner unpublishes | 200, then anon `raw/:id` → **404** again |
| Owner `DELETE /api/share?id=...` | 200, fixture gone, DB count back to 1179 |
| Synthetic archify fixture, no `data-preset` in stored html | Anon `/a/:id` → 401 (private default); anon `/api/archify-html?id=...` → 404 |
| Owner `/a/:id` page | Contains `<iframe id="diagram-frame" src="/api/archify-html?id=..." sandbox="allow-scripts" ...>` and the "Share publicly" control — matches the documented wrapper design |
| Owner `/api/archify-html?id=...` (direct) | Served HTML contains injected `data-preset="editorial"` and `data-theme="light"` — **confirms the regression fix works live**, not just in unit tests |
| Owner publishes archify fixture | Anon `/a/:id` → 200; anon `/api/archify-html` → 200, preset still injected |
| Owner unpublishes | Anon `/a/:id` → 401 again |
| Archify fixture cleanup | No API delete route exists for archify content; deleted directly via one scoped `DELETE ... WHERE id = '<id>' AND title = 'SMOKE-TEST-FIXTURE archify'` against Supabase. DB count back to 7, 0 public, confirmed. |

All synthetic fixtures (1 paste, 1 archify diagram) were created by this session for testing only and are fully cleaned up. No pre-existing user content was modified, viewed beyond what was already private-and-owner-visible, or deleted.

## Known unverified limits (stated honestly, not glossed over)
1. **No pixel/screenshot browser verification.** The browser tool's Chrome instance failed to start in this environment (`libcairo.so.2` missing from the container — an infrastructure/sandbox issue, out of scope for this app). All UI checks above are HTTP-level: I fetched and inspected the exact HTML/CSS/headers a browser would render (iframe markup, sandbox attribute, button text, injected preset attributes) via curl, which does verify the served markup byte-for-byte, but is not a rendered visual screenshot. If you want an actual visual pixel-check, that needs the browser environment fixed first (separate from this task).
2. **Legacy-cookie transparent upgrade** was not exercised live — doing so would require a genuine pre-rollout-format cookie, which no longer exists now that the new code is live everywhere. Covered only by unit tests (`tests/auth.test.mjs`), which do test it directly with an injected legacy token.
3. **Password rotation invalidating sessions** was not tested live — that would require rotating your real production password, which I did not do without being asked (would need to hand you a new password out-of-band). Covered only by unit tests.
4. **Dashboard-level per-row publish toggle** (batch view) still doesn't exist inline in the list view — documented as an accepted, deliberate scope limit by the prior session (`IMPLEMENTATION-REPORT.md` known-limit #3), not something this session changed.
5. **git remote token:** `IMPLEMENTATION-REPORT.md` flags that this repo's `origin` remote has a GitHub token embedded in its URL (unrelated, pre-existing). Not touched, not printed, flagging again for your own cleanup at convenience.

## No data loss, no unauthorized publish
Verified directly against the database, not inferred: exact row counts before and after (1179 / 39 / 7), 0 public in every table both before and after. Every synthetic id created during testing was deleted; no existing row's content, `is_public`, `pinned`, or `expires_at` was touched.
