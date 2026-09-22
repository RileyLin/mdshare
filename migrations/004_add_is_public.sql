-- Migration 004: private-by-default sharing.
-- Additive only. Adds is_public to all three content tables (default false — existing rows are
-- private), enables Row Level Security, and revokes direct table grants from the PostgREST
-- anon/authenticated roles so the only way to read/write these tables is through the app's
-- service-role backend (which bypasses RLS by default in Supabase) — never directly via a
-- client-side anon/authenticated Supabase key.
--
-- No CREATE POLICY statements are added on purpose: with RLS enabled and zero policies, anon and
-- authenticated get zero rows for every operation (SELECT/INSERT/UPDATE/DELETE all deny). The
-- service_role key used by api/*.js is unaffected either way (service_role bypasses RLS).
--
-- Run this manually against Supabase (parent/owner applies it — not run by this change).

-- NOTE (revised 2026-09-22): earlier draft of this migration also ran an explicit
-- "UPDATE ... SET is_public = false" backfill on all three tables. Removed: it was redundant
-- (ADD COLUMN ... DEFAULT false already backfills existing rows to false, once, at column
-- creation) and destructive on any future re-run of this file, since it would silently reset
-- back to false any row a human had deliberately published (is_public = true) in the meantime.
-- ADD COLUMN IF NOT EXISTS / ENABLE ROW LEVEL SECURITY / REVOKE are all naturally idempotent —
-- safe to re-run this file with no data-mutating side effect once the column already exists.
ALTER TABLE mdshare_pastes   ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE mdshare_diagrams ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;
ALTER TABLE mdshare_archify  ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

ALTER TABLE mdshare_pastes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdshare_diagrams ENABLE ROW LEVEL SECURITY;
ALTER TABLE mdshare_archify  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON mdshare_pastes   FROM anon, authenticated;
REVOKE ALL ON mdshare_diagrams FROM anon, authenticated;
REVOKE ALL ON mdshare_archify  FROM anon, authenticated;
