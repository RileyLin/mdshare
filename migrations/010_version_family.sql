-- 010: denormalised version facts, so reading a version costs one query however long the chain.
-- Additive only: two nullable columns + an index. Safe to re-run. A version stores the first
-- version's id (root_id) and its number (version_no); the first version keeps both NULL.
-- Applied with the Supabase management API by the agent (additive, per CLAUDE.md) before the app
-- code that writes these columns is deployed. No production row had parent_id yet, so nothing
-- needs a backfill.
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS root_id text;
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS version_no integer;
CREATE INDEX IF NOT EXISTS mdshare_pastes_root_idx ON mdshare_pastes (root_id, version_no DESC) WHERE root_id IS NOT NULL;
