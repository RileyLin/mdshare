# PLAN.md — mdshare New Features

## Files to Create/Modify

1. **api/render.js** — MODIFY
   - Add `rawMd` variable embedded in page (already have `raw` JS var — will reuse)
   - Add `id` variable embedded in page (pass from handler)
   - Add Download .md button (Feature 1)
   - Add Copy markdown button (Feature 2)
   - Add Save dropdown with Pin + Save to Notion (Feature 3)

2. **api/pin.js** — CREATE
   - PATCH handler: reads `{ id }` from body, updates expires_at to 2099-12-31 in Supabase

3. **api/save-to-notion.js** — CREATE
   - POST handler: reads `{ id }` from body
   - Fetches markdown from Supabase
   - Converts markdown to Notion blocks (simple converter)
   - Creates Notion page under parent 34d51bc3-98a8-80f2-a0fb-cc808020ed96
   - Returns `{ ok: true, notionUrl }`

4. **vercel.json** — no change needed (Vercel auto-detects api/ files)

## Steps

1. Write PLAN.md (this file) ✓
2. Set NOTION_TOKEN Vercel env var
3. Implement api/pin.js
4. Implement api/save-to-notion.js
5. Modify api/render.js with all 3 feature buttons
6. Git commit + push
7. Report commit hash

## Success Criteria
1. api/render.js has Download + Copy buttons in top bar ✓
2. api/pin.js and api/save-to-notion.js exist and are correct ✓
3. Save dropdown in render page calls both new endpoints correctly ✓
4. NOTION_TOKEN added as Vercel env var ✓
5. All files committed and pushed to origin/main ✓
