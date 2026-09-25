-- Migration 005: per-agent bearer API credentials.
-- Additive only. Adds a new mdshare_agent_tokens table (hashed-token storage, owner-issued,
-- expiring, revocable) plus a nullable created_by_token attribution column on all three content
-- tables. Does NOT touch is_public, the owner password/cookie flow, or any existing row's
-- visibility. Enables RLS + revokes direct anon/authenticated grants on the new table, matching
-- the convention in 004_add_is_public.sql (the app's service-role backend is unaffected — it
-- bypasses RLS by default in Supabase).
--
-- Run this manually against Supabase (parent/owner applies it — not run by this change).
-- ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ENABLE ROW
-- LEVEL SECURITY / REVOKE are all naturally idempotent — safe to re-run this file.

CREATE TABLE IF NOT EXISTS mdshare_agent_tokens (
  id            text PRIMARY KEY,        -- app-generated, e.g. "tok_<16-char nanoid>"
  name          text NOT NULL,           -- human-chosen label, shown in the dashboard, never the raw token
  token_hash    text NOT NULL,           -- SHA-256 hex digest of the raw token; raw value is never stored
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,     -- required at creation; owner picks the duration (capped, see app code)
  revoked_at    timestamptz,              -- null while active; set once, never cleared
  last_used_at  timestamptz               -- best-effort attribution, updated on successful bearer use
);

CREATE UNIQUE INDEX IF NOT EXISTS mdshare_agent_tokens_hash_idx ON mdshare_agent_tokens (token_hash);

ALTER TABLE mdshare_agent_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mdshare_agent_tokens FROM anon, authenticated;

-- Attribution: which token (if any) created a given content row. Nullable — existing rows and
-- anonymous/human-created rows stay NULL. ON DELETE SET NULL is defensive only; the app never
-- hard-deletes token rows (revoke sets revoked_at instead), but this keeps content rows valid if
-- a token row is ever removed by hand.
ALTER TABLE mdshare_pastes   ADD COLUMN IF NOT EXISTS created_by_token text REFERENCES mdshare_agent_tokens(id) ON DELETE SET NULL;
ALTER TABLE mdshare_diagrams ADD COLUMN IF NOT EXISTS created_by_token text REFERENCES mdshare_agent_tokens(id) ON DELETE SET NULL;
ALTER TABLE mdshare_archify  ADD COLUMN IF NOT EXISTS created_by_token text REFERENCES mdshare_agent_tokens(id) ON DELETE SET NULL;
