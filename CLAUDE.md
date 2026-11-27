# CLAUDE.md — mdshare app

Vercel serverless app: plain Node ESM functions in `api/` (one file = one function) + Supabase Postgres via PostgREST `fetch`. Static files in `public/` (home, `/guide`, `/llms.txt`, shared assets). Production: `mdshare-rileylins-projects.vercel.app`, deployed from GitHub `main`.

## Definition of done — run before saying "done"
```
npm ci --include=dev   # this container sets NODE_ENV=production; --include=dev is required
npm run verify         # invariants + lint + unit tests (seconds)
npm run e2e            # real Chromium against a local stack + fake Supabase -> e2e/proof/
```
Put the verify/e2e output in your completion message (+ `e2e/proof/*.png` for UI changes). To look at one page: `node e2e/drive.mjs open <path> --as owner|anon --screenshot out.png`.

## How changes ship
1. Work on a branch named `agent/<task>` and push it. `main` is protected: only commits that passed verify + e2e land, no force-push.
2. CI runs verify + e2e and labels the risk (`scripts/risk-tier.mjs`; sensitive = auth/visibility/keep/tokens, sandbox, routes, deps, migrations, the pipeline and checks, removed test lines). Everything merges automatically on green. A change waits for Riley's approval only when he asked for that: add a commit-message line `Owner-Approval: required` or push to `agent/review-<task>`. For sensitive changes, run an adversarial review (a second model tries to break it; only proven findings count) before pushing.
3. CI records a PR, fast-forwards `main`, then the `release` job waits for production to serve the commit (`/api/health`) and runs `e2e/release-check.mjs` against it. It covers pages, gates, a private create, fuzzing, random clicks, new server errors. On failure it rolls production back (`scripts/vercel-release.mjs`) and opens a `prod-alert:release` issue. The next good release promotes itself.
4. `.github/workflows/monitor.yml` runs the same check every 30 min plus the error log (`mdshare_events` via `/api/health?events=1`). Failing opens `prod-alert:monitor`; recovery closes it.
5. If CI fails, fix forward on the same branch. Never `vercel --prod` from a local tree.

`git config core.hooksPath .githooks` once per clone runs `npm run verify` before every push.
Migrations: additive only (checked). The agent may apply an additive migration with the Supabase management API and must say so in the commit; anything else goes to the owner.

## Where things are
- `api/_lib/tenant.js` — who is asking (`ownerOf`) and every user-table query, scoped by `owner_id` (migration 013). `api/_lib/session.js` — cookies (v3 carries the uid).
- `api/_lib/access.js` — `isVisible` (a private row is its owner's only), `setPrivacyHeaders`, gates.
- `api/_lib/agent-tokens.js`, `api/_lib/catalog.js` — bearer tokens, scopes, agent catalog.
- `api/auth.js` — password login (user #1), token management.
- `api/health.js` + `api/_lib/events.js` — liveness/commit, client errors, `withErrors()`.
- `api/pin.js` — keep/unkeep (fresh 7-day expiry) and the only `is_public` toggle.
- `api/doc.js` + `api/_lib/activity.js` — reading loop: read receipts, feedback, resolve, versions + zh/en translation switch (`versionInfo`). `action=search` → `api/_lib/search.js` (rpc, migration 011).
- `api/_lib/collections.js` — collections + `patchMeta` (only lang/translation_of/collection); `/c[/:slug]` is `api/_lib/collection-page.js` (`render.js?kind=collection`).
- `api/_lib/raw.js` — the one raw-Markdown path (`/raw/:id`, `/v/:id` + Bearer); agent 401 hints. `api/_lib/lint.js` — publish checks returned by `POST /api/share`. `/d/:id` is `api/_lib/diagram-page.js` via `render.js?kind=diagram`.
- `node e2e/preview.mjs <file.md>` — render a document as a reader will (390 + 1280 px) before publishing it.
- `api/_lib/ui.js` — page chrome for every server page (head, header, sign-in, 404s). `classic.js`: `?classic=1`.
- `public/assets/render.js` — the one Markdown renderer (reader, editor preview, home, guide, diagram notes): marked → DOMPurify → enhancement rules. `app.js` page behaviour, `library.js` Library/Settings, `mdshare.css` the design system. Libraries are vendored in `public/vendor/`.
- Rendering rule: stored Markdown is never rewritten. Formatting happens at view time, only on clear patterns (e2e: must-not-trigger fixtures, text-equivalence). Run `node e2e/compare-docs.mjs --dir <private docs>` before changing a rule.
- `e2e/features.json` — feature map: each user-facing feature, how to reach it, what proves it works. Add an entry per new or changed feature. `node e2e/shots.mjs` captures every page in both themes.
- `docs/history/` — past plans (background, not rules).

## Enforced by checks — read the error message, don't re-explain here
`npm run check` (`scripts/check-invariants.mjs`) fails on: more than 12 API functions; broken or duplicate rewrites; destructive SQL in migrations; creation routes taking visibility from the request; content routes missing `isVisible`/`setPrivacyHeaders`; unencoded ids in PostgREST filters; `allow-same-origin` in an iframe sandbox; timers without `.unref()`; credential-like strings; stray root Markdown; CLAUDE.md over 90 lines / 7000 chars; `api/doc.js` actions without auth (GETs: a rate limit); activity writes outside `activityWrite`; versions without `canUseParent`; translations without `canLinkTranslation`; collection pages for non-users; the loop script on non-owner pages; a create response without `checks`; search text in a PostgREST filter; Markdown served outside `sendRawMarkdown`; agent 401s without `authHint`; user-table queries outside `tenant.js`; `owner_id` set outside `insertOwned`; search without `p_owner`. `tests/invariants.test.mjs` proves each check fires.

## When you correct a mistake
Don't add a paragraph here. In order of preference:
1. Change the code or API so the mistake can't be written.
2. Add a check to `scripts/check-invariants.mjs` or an `eslint.config.js` rule whose message says how to fix the root cause.
3. Add a test.
4. Only then, one line here.

No quick fixes that hide a cause (zero-delay timers, blind retries, broad try/catch). Fix the cause or ask.

## Still judgment calls
- Content model: `mdshare_pastes` (`/v/:id`), `mdshare_diagrams` (`/d/:id`), `mdshare_archify` (`/a/:id`). All private by default (`is_public` false), with `pinned`/`expires_at` TTL.
- Auth: users (`mdshare_users`); the password is user #1. Missing and not-yours answer the same. Tokens act for their user. `scopes === null` is a legacy token. Scoped tokens use `documents:read|write|publish|publish:any`. `publish` covers only rows the token created.
- Archify HTML is attacker-controlled and is only ever shown inside the sandboxed iframe built by `api/archify-render.js`.
- Render/raw output depends on the session and `is_public`: never cacheable.
- Every page works on a phone (e2e checks overflow).
- Authoring syntax for agents lives in `public/llms.txt` (models) and `public/guide.md` (humans); change both with the renderer.
