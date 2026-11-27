-- 015: drop the owner_id DEFAULT 1 from migration 013 (COMPAT-CHECK G1). NOT APPLIED YET.
--
-- Apply only in P6, in this order:
--   1. the multi-user code (P1-P3) is live in production (it always sends owner_id itself);
--   2. multiuser-2026-11-27/backfill-null-owners.sql has re-run and every count is 0;
--   3. then this file.
-- Until step 1 the production code relies on the default: it inserts rows without owner_id, and
-- they must stay user #1's. After this, an insert bug yields an ownerless row (invisible to
-- everyone, flagged by the release check's owner probe) instead of a row filed under user #1.
-- Rollback: `ALTER TABLE <t> ALTER COLUMN owner_id SET DEFAULT 1` (only needed if old code returns).
-- Safe to re-run: DROP DEFAULT on a column without a default does nothing.

ALTER TABLE mdshare_pastes       ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_diagrams     ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_archify      ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_agent_tokens ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_events       ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_reads        ALTER COLUMN owner_id DROP DEFAULT;
ALTER TABLE mdshare_feedback     ALTER COLUMN owner_id DROP DEFAULT;
