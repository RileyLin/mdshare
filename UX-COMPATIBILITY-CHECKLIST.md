# UX Compatibility Checklist — private-by-default sharing

Written per Riley's request (Sep 22, 01:57 PT) before any further changes. Scope: does the privacy
implementation preserve existing UX, and where does it necessarily deviate. **No deploy performed.**

## Constraint-by-constraint

| Constraint | Status | Notes |
|---|---|---|
| No redesign | ✅ Preserved | Zero CSS/layout changes. Same top bar, same buttons, same styling tokens. |
| No extra steps for signed-in everyday reading | ✅ Preserved | An authenticated owner viewing their own content (public or private) gets the page in one request, same as before — `isVisible` short-circuits true for the owner with no redirect/extra round trip. |
| No forced re-login of an existing valid session, if migration is safe | ✅ Fixed this turn | See "Seamless session upgrade" below. |
| No changes to pin / Save-to-Notion / edit / delete / render / interactivity | ✅ Preserved | Those handlers/buttons are byte-for-byte the same logic; only the auth *check* they use was swapped from `isAuthenticated(req)` to `checkAuthAndRefresh(req, res)` (same true/false result, plus the silent-upgrade side effect below — no behavior visible to the caller). |
| No changes to agent auto-upload (POST create) | ✅ Preserved API, ⚠️ one real consequence — see below | Same endpoints, same request/response shape, same rate limits. The one behavior change is what happens when someone (including the agent itself, or a Telegram recipient) later opens the returned link without the owner's cookie — see "The one real tradeoff" below. This is inherent to the private-by-default requirement itself, not an implementation choice. |
| Preserve current URLs | ✅ Preserved | `/v/:id`, `/d/:id`, `/a/:id`, `/raw/:id`, `/dashboard`, and all `/api/*` paths are unchanged. |
| Minimal UI: small status + toggle in the existing toolbar | ✅ Preserved | One `<span class="badge">` + one `<button class="btn">`, reusing the exact existing badge/button CSS classes, inserted into the existing `top-bar-actions` row next to Copy/PDF/Save. No new panel, no new page, no new section. |
| 6-month login | ✅ Preserved | 180-day (`60*60*24*180`s) signed cookie, unchanged from the original implementation. |
| Public share button | ✅ Preserved | "Share publicly" / "Stop sharing" control, with a confirm() prompt, on each item's own page. |

## Seamless session upgrade (implemented this turn)

**Before this turn:** a pre-existing browser session (issued before the privacy rollout) kept
working, unmodified, until a fixed cutoff date (`2026-10-22`), after which it would stop working
and force one re-login.

**Now:** every authenticated route (`render.js`, `diagram-render.js`, `archify-render.js`,
`dashboard.js`, `pastes.js`, `pin.js`, `save-to-notion.js`, `share.js` PATCH/DELETE,
`visibility.js`, `GET /api/auth`) calls a single `checkAuthAndRefresh(req, res)` instead of a bare
boolean check. The very first time it validates a request via the old (legacy) cookie format, it
transparently sets a fresh, full-180-day v2 cookie on that same response — no redirect, no login
screen, no visible change at all. The browser just starts sending the new cookie on its next
request.

**Net effect:** the `2026-10-22` cutoff now only matters for a browser that makes *zero*
authenticated requests at all between the rollout and that date. Any normal usage pattern (Riley
opening the dashboard, editing a paste, pinning something, toggling sharing) upgrades that
browser's session before the cutoff is ever reached. Tested in `tests/auth.test.mjs`
(`checkAuthAndRefresh silently upgrades a valid legacy cookie...`).

**Residual tradeoff (can't be fully eliminated):** if a signed-in device is completely idle for the
entire ~30-day window (no dashboard visits, no edits, no pin/Notion/publish actions), its legacy
cookie will stop validating on `2026-10-22` and that one device needs a single password re-entry.
This is unavoidable without either (a) accepting the legacy cookie forever (a perpetual,
never-expiring token — explicitly what "180-day session" and general security hygiene argue
against), or (b) proactively pinging every idle device before the cutoff (not possible from the
server side; there's no background job that can reach a browser that never connects). Recommend
accepting this residual case as-is — it only affects devices that are, by definition, not being
used.

## The one real tradeoff: private-by-default and shared links

This is the single behavior change worth explicit sign-off, because it affects how already-shared
and future-shared links behave, not just the UI.

**Before this change:** every paste/diagram/archify link was viewable by *anyone* who had the URL,
with no sign-in — that was mdshare's entire reason to exist (paste something, get a link, send the
link, done).

**After this change (as originally requested — this is the feature, not a bug):** a link created
by an unauthenticated `POST` (agent auto-upload, or the homepage paste box) is **private** until the
owner explicitly clicks "Share publicly" on that item. Anyone without the owner's auth cookie who
opens that link — including a Telegram recipient, a teammate, Riley on a different device, or the
agent itself checking its own output — sees a "sign in" page instead of the content, until it's
published.

**What did *not* change:** the create step itself (POST → get back `{url, id, expires_in}`) is
identical; nothing about the upload API, its fields, or its response shape changed. Only what
happens when that URL is later opened by someone without the cookie.

**What Riley should confirm before this goes live:** does the existing habit of "generate a link,
forward it, done" need every one of those links to be manually published first from now on, or
should there be a way for the *create* step itself to opt into public (e.g. an agent passing an
explicit "make this public" flag it's allowed to set, or a default-public mode for certain
call sites)? As implemented, `POST` can **never** set `is_public` — that was an explicit
requirement in the original task ("no capability to publish public" from create) — so if
"agent auto upload" links are expected to be immediately open to recipients with zero extra step,
that is currently not possible without a follow-up decision from Riley. Flagging this now rather
than assuming either direction.

## Regression test proof

```
$ node --test --test-force-exit tests/*.test.mjs
ℹ tests 43
ℹ pass 43
ℹ fail 0
```
(4 new tests added for `checkAuthAndRefresh`; all 39 prior tests, including the untouched
`tests/delete-flow.test.mjs`, still pass unmodified.) `node --check` passes on every touched file.

## Status

- Code change (seamless upgrade) implemented and tested; not deployed.
- Migration/DB permissions: per Riley, already applied by the parent — this session did not touch
  the database and has no visibility into whether the applied schema matches
  `migrations/004_add_is_public.sql` exactly. Worth a diff/confirm on the parent's side before
  deploying this code, since the render/raw handlers now unconditionally `select=...,is_public` —
  if the column isn't there yet, every content route will fail closed (503), not leak anything, but
  will effectively take the whole read path down until the column exists.
- **Holding for confirmation** on the one open question above (link-sharing tradeoff) before this
  is considered final / before parent deploys.
