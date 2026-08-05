# Delete Button Fix Plan

## Files to modify

- `api/render.js` — add the missing `deletePaste()` browser function used by the existing authenticated Delete button.
- `tests/delete-flow.test.mjs` — add focused API/UI contract tests for authentication, deletion, and the rendered button handler.

## Existing partial work to preserve

- `api/share.js` already contains the authenticated `DELETE` route and `supabaseDelete()` helper.
- Unrelated Archify files and changes must remain untouched.

## Steps

1. Add a confirmation prompt before destructive deletion.
2. Send an authenticated same-origin `DELETE /api/share?id=<pasteId>` request.
3. Show a clear in-button pending/failure state.
4. Redirect to the dashboard only after the API confirms deletion.
5. Test unauthenticated rejection, authenticated deletion, missing IDs, and the UI contract.
6. Run Node syntax checks and focused tests.

## Success criteria

- Clicking Delete no longer throws `deletePaste is not defined`.
- Canceling confirmation performs no request.
- Unauthenticated DELETE returns 401.
- Authenticated DELETE calls Supabase with method DELETE and returns 200.
- Failed deletion leaves the page in place and gives retry feedback.
- Successful deletion redirects away from the deleted paste.
