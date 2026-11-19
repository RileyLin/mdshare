# Token UI + CLI default-token-file hardening — plan

Scope: `api/dashboard.js` (token UI only), `mcp/bin/mdshare-cli.mjs` (`resolveToken`), their
tests, and this plan/result doc. No backend route, schema, or `api/_lib/agent-tokens.js` /
`api/auth.js` logic changes — the existing `scopes` contract (array = scoped, including `[]`;
`undefined`/omitted = legacy) already supports everything requested below without a schema
change. If that turns out false during implementation, stop and report a blocker instead of
touching backend/auth files.

## Current state (read before editing)

`api/dashboard.js` already has a working "API Tokens" panel: name input, expiry `<select>`
(30/90/180/365, **90 default**), four scope checkboxes (read/write/publish/publish:any, all
**unchecked by default**), create button that **omits** the `scopes` field entirely when no box
is checked (→ legacy token), a one-time reveal+copy box, and a revoke button with a confirm
dialog. `mcp/bin/mdshare-cli.mjs`'s `resolveToken()` checks `MDSHARE_AGENT_TOKEN` env, then
`MDSHARE_AGENT_TOKEN_FILE` env / `--token-file` flag, and returns `''` if neither is set — it
never falls back to the `login` command's own default write location
(`~/.mdshare/token`, `DEFAULT_TOKEN_FILE`), so a user who just ran `mdshare-cli login` with no
flags gets silently anonymous on every subsequent command unless they remember to pass
`--token-file` themselves.

## Requested changes

1. **Dashboard: explicit scopes, no hidden legacy default.**
   Always send `scopes` as an explicit array in the `create_token` request body — `[]` when
   nothing is checked, not an omitted field. This changes the *default* creation gesture away
   from "accidentally legacy" without touching the backend: the backend already treats an
   explicit `[]` as a real scoped token (own-row-read floor only, no catalog/create/publish) per
   `agent-tokens.js`'s `isLegacyToken()` (`scopes == null` only). Add a small, separate, explicit
   "Legacy token (create + own-row read only, no scopes)" checkbox/toggle for the rare case
   someone still wants the old omit-the-field contract — checking it sends no `scopes` field at
   all; it's mutually exclusive with the scope checkboxes in the UI (disables them) so the
   request body is never ambiguous.
2. **Default selected scope: `documents:read` checked by default**, clearly labeled "(read the
   whole library)" so the default creation flow is a read-only agent token over the full
   library, not create-capable. `documents:write` / `documents:publish` / `documents:publish:any`
   stay unchecked by default — deliberate, one click each.
3. **Default expiry: 30 days**, not 90. Keep the other options (30/90/180/365) in the dropdown,
   just change which `<option selected>`.
4. **Copy-once secret + revoke UX**: already present; review wording only, no behavior change
   needed unless testing finds a gap.
5. **Help text / links**: add a one-line "how to use this" note near the reveal box showing the
   API base URL and the exact header shape with a `<token>` placeholder only
   (`Authorization: Bearer <token>`) — never interpolate the real created token into that example
   string, and never `console.log`/print the token anywhere in the UI JS beyond the one
   `new-token-value` element that already exists for the one-time reveal.
6. **CLI default token file**: fix `resolveToken()` so that when neither `MDSHARE_AGENT_TOKEN`
   nor an explicit `MDSHARE_AGENT_TOKEN_FILE`/`--token-file` is given, it falls back to reading
   `DEFAULT_TOKEN_FILE` (`~/.mdshare/token`, the same path `cmdLogin` writes by default) and
   returns `''` (not an error) if that file doesn't exist either — preserving exact precedence
   (env var > explicit file > default file > anonymous `''`) and the existing "explicit
   `--token-file` that fails to read is a hard CLI error" behavior unchanged.

## Files to touch

- `api/dashboard.js` — token panel HTML/JS only (new legacy-toggle control, default scope
  checked, default expiry option, help note, explicit-scopes-always `createToken()` body).
- `mcp/bin/mdshare-cli.mjs` — `resolveToken()` only.
- `tests/cli-login.test.mjs` — extend/adjust `resolveToken` tests for the new default-file
  fallback (using a temp dir, never the real `$HOME`, so CI can't pick up a developer's real
  `~/.mdshare/token`).
- Add `TOKEN-UI-RESULT.md` after tests pass, with command output.

## Success criteria

- `createToken()`'s fetch body always has a `scopes` key (array) unless the new explicit legacy
  toggle is checked, in which case it has none.
- Opening the token panel shows `documents:read` pre-checked, other three unchecked, 30-day
  expiry pre-selected.
- `resolveToken()`: env var wins over everything; explicit file (env or flag) wins over default
  file and still throws on an unreadable explicit path; with nothing explicit set, a readable
  default-path file is used; with nothing explicit set and no default file, returns `''` with no
  throw (anonymous, unchanged for users who never ran `login`).
- `node --test --test-force-exit tests/*.test.mjs` passes; results + output captured in
  `TOKEN-UI-RESULT.md`.
- No `api/_lib/agent-tokens.js`, `api/auth.js`, `api/share.js`/`diagram.js`/`archify.js`,
  `api/pin.js`, or `migrations/*` edits. If any requested behavior turns out to require one,
  stop and report that as a blocker instead of editing those files.
