-- 014: multi-user beta P3 — quotas that can be "unlimited" and the owner's per-user stats.
-- Safe to re-run, and invisible to the code in production before P3 (it never reads mdshare_users):
--   1. The two quota columns become nullable. NULL means unlimited; new users still get the
--      defaults from 013 (200 documents a day, 512 KB per document).
--   2. User #1 (the owner) gets NULL quotas: the owner is never limited (COMPAT-CHECK G2). The code
--      also treats user #1 as unlimited whatever these cells say (api/_lib/tenant.js).
--   3. sessions_valid_after (nullable): rotating the entry link sets it, so browsers signed in with
--      an older link are signed out too (a leaked link can't leave a session behind).
--   4. mdshare_user_stats(): one row per user with counts only (no content, no titles), for the
--      owner's GET /api/doc?action=stats. Created only if absent; service_role only.
-- Applied with the Supabase management API by the agent (additive, per CLAUDE.md).

ALTER TABLE mdshare_users ALTER COLUMN quota_docs_per_day DROP NOT NULL;
ALTER TABLE mdshare_users ALTER COLUMN quota_bytes DROP NOT NULL;

UPDATE mdshare_users SET quota_docs_per_day = NULL, quota_bytes = NULL WHERE id = 1 AND (quota_docs_per_day IS NOT NULL OR quota_bytes IS NOT NULL); -- invariant-allow: G2 (accepted by Riley): only row id 1, only towards unlimited; a rerun changes nothing

ALTER TABLE mdshare_users ADD COLUMN IF NOT EXISTS sessions_valid_after timestamptz;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mdshare_user_stats' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.mdshare_user_stats()
      RETURNS TABLE (user_id bigint, label text, created_at timestamptz, disabled boolean,
                     docs_this_week bigint, docs_last_week bigint, docs_total bigint,
                     opened_by_owner bigint, opened_this_week bigint, last_active timestamptz)
      LANGUAGE sql STABLE
      SET search_path = public, pg_temp
      AS $body$
        WITH docs AS (
          SELECT owner_id, created_at FROM mdshare_pastes
          UNION ALL SELECT owner_id, created_at FROM mdshare_diagrams
          UNION ALL SELECT owner_id, created_at FROM mdshare_archify
        ), d AS (
          SELECT owner_id,
                 count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS this_week,
                 count(*) FILTER (WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS last_week,
                 count(*) AS total,
                 max(created_at) AS last_doc
          FROM docs GROUP BY owner_id
        ), r AS (
          SELECT owner_id,
                 count(*) AS opened,
                 count(*) FILTER (WHERE last_opened_at >= now() - interval '7 days') AS opened_week,
                 max(last_opened_at) AS last_read
          FROM mdshare_reads GROUP BY owner_id
        ), t AS (
          SELECT owner_id, max(last_used_at) AS last_token FROM mdshare_agent_tokens GROUP BY owner_id
        )
        SELECT u.id, u.label, u.created_at, u.disabled,
               coalesce(d.this_week, 0), coalesce(d.last_week, 0), coalesce(d.total, 0),
               coalesce(r.opened, 0), coalesce(r.opened_week, 0),
               greatest(d.last_doc, r.last_read, t.last_token)
        FROM mdshare_users u
        LEFT JOIN d ON d.owner_id = u.id
        LEFT JOIN r ON r.owner_id = u.id
        LEFT JOIN t ON t.owner_id = u.id
        ORDER BY u.id
      $body$
    $fn$;
  END IF;
END
$mig$;

REVOKE ALL ON FUNCTION public.mdshare_user_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mdshare_user_stats() TO service_role;

NOTIFY pgrst, 'reload schema';
