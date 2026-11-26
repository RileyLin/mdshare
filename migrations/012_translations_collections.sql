-- 012: Chinese/English versions linked + collections (Tier 2, Batch B, 2026-11-26).
-- Additive only: three nullable columns, two partial indexes, two CHECK constraints added only when
-- absent. Safe to re-run. Applied with the Supabase management API by the agent (additive, per
-- CLAUDE.md) before the app code that reads these columns is deployed. No backfill.
--   lang           'zh' | 'en' | NULL
--   translation_of the translation group root: the version root (root_id or id) of the original
--                  document. The app normalises every link to it, so one query finds the whole group.
--   collection     a slug (lowercase letters, digits, hyphens), shown at /c/<slug> to the owner.
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS lang text;
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS translation_of text;
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS collection text;
CREATE INDEX IF NOT EXISTS mdshare_pastes_translation_idx ON mdshare_pastes (translation_of) WHERE translation_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS mdshare_pastes_collection_idx ON mdshare_pastes (collection, created_at) WHERE collection IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mdshare_pastes_lang_check') THEN
    ALTER TABLE mdshare_pastes ADD CONSTRAINT mdshare_pastes_lang_check CHECK (lang IS NULL OR lang IN ('zh', 'en'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mdshare_pastes_collection_check') THEN
    ALTER TABLE mdshare_pastes ADD CONSTRAINT mdshare_pastes_collection_check CHECK (collection IS NULL OR collection ~ '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$');
  END IF;
END $$;
