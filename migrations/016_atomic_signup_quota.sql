-- 016: security fixes batch 1 (2026-11-27). Additive only, safe to re-run: one new table, two new
-- functions created only if absent; only service_role may execute them; and grants that only take
-- rights away from anon/authenticated.
--   1. mdshare_signup_user(p_label, p_entry_hash, p_max) (ADV-MU-B 2): the seat cap was a count
--      followed by a separate insert, so concurrent sign-ups all saw a free seat. This takes a
--      transaction-scoped advisory lock, counts users besides #1 (id > 1, disabled ones too), and
--      inserts only while fewer than p_max: the new id, or NULL when the beta is full.
--   2. mdshare_quota_usage + mdshare_reserve_doc(p_owner, p_max) (ADV-MU-B 3): the daily document
--      count was also check-then-act. One row per user and UTC day; a single
--      INSERT ... ON CONFLICT DO UPDATE SET n = n + 1 WHERE n < p_max RETURNING n reserves a create
--      atomically (NULL when the day's quota is used). The app never calls it for user #1 (G2).
--   3. mdshare_events (008) never revoked the default anon/authenticated grants like every sibling
--      table (ADV-MU-A F2); RLS without policies was its only protection. The app uses only the
--      service key, so nothing loses access it uses.
-- Neither function is SECURITY DEFINER: they run as the caller, and only service_role may call them.
-- Applied with the Supabase management API by the agent (additive, per CLAUDE.md).

CREATE TABLE IF NOT EXISTS mdshare_quota_usage (
  owner_id bigint  NOT NULL REFERENCES mdshare_users (id),
  day      date    NOT NULL,
  n        integer NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (owner_id, day)
);
ALTER TABLE mdshare_quota_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mdshare_quota_usage FROM anon, authenticated;

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mdshare_signup_user' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.mdshare_signup_user(p_label text, p_entry_hash text, p_max integer)
      RETURNS bigint
      LANGUAGE plpgsql VOLATILE
      SET search_path = public, pg_temp
      AS $body$
      DECLARE
        taken bigint;
        new_id bigint;
      BEGIN
        -- One sign-up at a time; the lock is released when the calling transaction ends.
        PERFORM pg_advisory_xact_lock(hashtext('mdshare_signup_user')::bigint);
        SELECT count(*) INTO taken FROM mdshare_users WHERE id > 1;
        IF p_max IS NULL OR taken >= p_max THEN
          RETURN NULL;
        END IF;
        INSERT INTO mdshare_users (label, entry_hash) VALUES (p_label, p_entry_hash) RETURNING id INTO new_id;
        RETURN new_id;
      END
      $body$
    $fn$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mdshare_reserve_doc' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.mdshare_reserve_doc(p_owner bigint, p_max integer)
      RETURNS integer
      LANGUAGE sql VOLATILE
      SET search_path = public, pg_temp
      AS $body$
        INSERT INTO mdshare_quota_usage AS q (owner_id, day, n)
        SELECT p_owner, (now() AT TIME ZONE 'utc')::date, 1
        WHERE p_owner IS NOT NULL AND p_max > 0
        ON CONFLICT (owner_id, day) DO UPDATE SET n = q.n + 1 WHERE q.n < p_max -- invariant-allow: function body, runs per create (the atomic reservation), never at migration time
        RETURNING q.n
      $body$
    $fn$;
  END IF;
END
$mig$;

REVOKE ALL ON FUNCTION public.mdshare_signup_user(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mdshare_signup_user(text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.mdshare_reserve_doc(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mdshare_reserve_doc(bigint, integer) TO service_role;

REVOKE ALL ON mdshare_events FROM anon, authenticated;


NOTIFY pgrst, 'reload schema';
