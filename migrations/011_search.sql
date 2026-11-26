-- 011: full-text search over documents (titles and bodies, Chinese included).
-- Additive only: an extension, two indexes and one read-only function, each created only if
-- absent. Safe to re-run: a rerun never replaces a newer function body (no CREATE OR REPLACE).
-- Applied with the Supabase management API by the agent (additive, per CLAUDE.md) before the app
-- code that calls mdshare_search is deployed.
--
-- Why a function: the search text must never be spliced into a PostgREST filter string, where
-- "," "(" ")" "*" restructure the filter. api/_lib/search.js sends it as a JSON body to
-- /rest/v1/rpc/mdshare_search; here it is a plain parameter, and LIKE wildcards in it
-- (\ % _) are escaped so "50%" matches only a literal "50%".
-- Trigram indexes make the substring match cheap and work for CJK text (the database ctype is
-- en_US.UTF-8, which treats CJK characters as word characters).

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS mdshare_pastes_title_trgm_idx ON mdshare_pastes USING gin (lower(title) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS mdshare_pastes_content_trgm_idx ON mdshare_pastes USING gin (lower(content) extensions.gin_trgm_ops);

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'mdshare_search' AND pronamespace = 'public'::regnamespace) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.mdshare_search(q text, lim integer DEFAULT 20, skip integer DEFAULT 0)
      RETURNS TABLE (id text, title text, created_at timestamptz, expires_at timestamptz, pinned boolean,
                     is_public boolean, title_match boolean, excerpt text, total bigint)
      LANGUAGE sql STABLE
      SET search_path = public, pg_temp
      AS $body$
        SELECT h.id, h.title, h.created_at, h.expires_at, h.pinned, h.is_public, h.title_match,
               -- a window around the first match; the app trims it to a short plain-text snippet
               substr(h.content, greatest(1, h.pos - 240), 480 + length(btrim(q))) AS excerpt,
               count(*) OVER () AS total
        FROM (
          SELECT t.id, t.title, t.created_at, t.expires_at, t.pinned, t.is_public, t.content,
                 coalesce(lower(t.title) LIKE ('%' || replace(replace(replace(lower(btrim(q)), '\', '\\'), '%', '\%'), '_', '\_') || '%'), false) AS title_match,
                 strpos(lower(t.content), lower(btrim(q))) AS pos
          FROM mdshare_pastes t
          WHERE length(btrim(q)) BETWEEN 1 AND 200
            AND (lower(t.title) LIKE ('%' || replace(replace(replace(lower(btrim(q)), '\', '\\'), '%', '\%'), '_', '\_') || '%')
                 OR lower(t.content) LIKE ('%' || replace(replace(replace(lower(btrim(q)), '\', '\\'), '%', '\%'), '_', '\_') || '%'))
            AND (t.pinned IS TRUE OR t.expires_at IS NULL OR t.expires_at > now())
        ) h
        ORDER BY h.title_match DESC, h.created_at DESC, h.id
        LIMIT least(greatest(coalesce(lim, 20), 1), 50)
        OFFSET least(greatest(coalesce(skip, 0), 0), 1000)
      $body$
    $fn$;
  END IF;
END
$mig$;

-- Only the server (service_role) may call it; anon/authenticated keys get nothing.
REVOKE ALL ON FUNCTION public.mdshare_search(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mdshare_search(text, integer, integer) TO service_role;

-- Make PostgREST see the new function without waiting for its schema cache.
NOTIFY pgrst, 'reload schema';
