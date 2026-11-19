# CLAUDE.md — mdshare app

Vercel serverless app: plain Node ESM functions in `api/` (one file = one function) + Supabase Postgres via PostgREST `fetch`. Static files in `public/` (home, `/guide`, `/llms.txt`, shared assets). Production: `mdshare-rileylins-projects.vercel.app`, deployed from GitHub `main`.

## Definition of done — run before saying "done"
```
npm ci --include=dev   # this container sets NODE_ENV=production; --include=dev is required
npm run verify         # invariants + lint + unit tests (seconds)
npm run e2e            # real Chromium against a local stack + fake Supabase -> e2e/proof/
```
Put the verify/e2e output in your completion message, plus `e2e/proof/*.png` for UI changes. To look at one page while working: `node e2e/drive.mjs open <path> --as owner|anon --screenshot out.png`.

## How changes ship
1. Work on a branch named `agent/<task>` and push it.
2. CI (`.github/workflows/ci.yml`) runs verify + e2e on every push. On an `agent/*` branch, when both pass, CI fast-forwards `main` to that commit and Vercel deploys it.
3. If CI fails, fix forward on the same branch. Don't push unverified commits to `main`, don't `vercel --prod` from a local tree, don't force-push.

`git config core.hooksPath .githooks` once per clone runs `npm run verify` before every push.
Migrations in `migrations/` are applied by hand by the owner. Agents write them, never run them.

## Where things are
- `api/_lib/access.js` — row fetch/patch, `isValidId`, `isVisible`, `setPrivacyHeaders`, login gate.
- `api/_lib/agent-tokens.js`, `api/_lib/catalog.js` — bearer tokens, scopes, agent catalog.
- `api/auth.js` — owner password login, signed 180-day session cookie, token management.
- `api/pin.js` — keep ("pin") / unkeep (fresh 7-day expiry) and the only `is_public` toggle (`keep: true` keeps in the same write).
- `api/_lib/ui.js` — page chrome for every server page (head, header, owner controls, sign-in card, 404s). `api/_lib/classic.js` is the pre-redesign reader behind `?classic=1`.
- `public/assets/render.js` — the one Markdown renderer (reader, editor preview, home, guide, diagram notes): marked → DOMPurify → enhancement rules. `app.js` page behaviour, `library.js` Library/Settings, `mdshare.css` the design system. Libraries are vendored in `public/vendor/`.
- Rendering rule: stored Markdown is never rewritten. Automatic formatting happens at view time and fires only on clear patterns; `e2e` has must-not-trigger fixtures and an old-vs-new text-equivalence check. Run `node e2e/compare-docs.mjs --dir <private docs>` before changing a rule.
- `e2e/features.json` — feature map: each user-facing feature, how to reach it, what proves it works. Add an entry when you add or change a feature. `node e2e/shots.mjs` captures every page in both themes.
- `docs/history/` — past plans, rollout notes and the previous long CLAUDE.md. Background only, not current rules.

## Enforced by checks — read the error message, don't re-explain here
`npm run check` (`scripts/check-invariants.mjs`) fails on: more than 12 API functions (Vercel Hobby cap); broken or duplicate rewrites; destructive SQL in migrations; creation routes taking visibility from the request; content routes missing `isVisible`/`setPrivacyHeaders`; unencoded ids in PostgREST filters; `allow-same-origin` in an iframe sandbox; timers without `.unref()`; credential-like strings (the repo is public); stray root Markdown; CLAUDE.md over 90 lines / 7000 chars. `tests/invariants.test.mjs` proves each check fires.

## When you correct a mistake
Don't add a paragraph here. In order of preference:
1. Change the code or API so the mistake can't be written.
2. Add a check to `scripts/check-invariants.mjs` or a rule to `eslint.config.js`, with a message that says how to fix the root cause.
3. Add a test.
4. Only then, one line here.

No quick fixes that hide a cause (zero-delay timers, blind retries, broad try/catch). Fix the cause or ask.

## Still judgment calls
- Content model: `mdshare_pastes` (`/v/:id`), `mdshare_diagrams` (`/d/:id`), `mdshare_archify` (`/a/:id`). All private by default (`is_public` false), with `pinned`/`expires_at` TTL.
- Auth: a single owner (`MDSHARE_PASSWORD`). Agent bearer tokens are additive. `scopes === null` is a legacy token. Scoped tokens use `documents:read|write|publish|publish:any`. `publish` covers only rows the token created.
- Archify HTML is attacker-controlled and is only ever shown inside the sandboxed iframe built by `api/archify-render.js`.
- Render/raw output depends on the session and on `is_public`, so it is never cacheable.
- Keep every page usable on a phone (`e2e` mobile feature checks for horizontal overflow).
- Authoring syntax for agents lives in `public/llms.txt` (models) and `public/guide.md` (humans); change both with the renderer.
