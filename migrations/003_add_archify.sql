-- Migration: Add mdshare_archify table for archify-generated diagrams
-- Stores the typed JSON IR (source of truth, re-renderable + diffable) + diagram kind.
-- Rendered HTML is produced on demand by /api/archify-render (not stored — it's ~600KB).
CREATE TABLE IF NOT EXISTS mdshare_archify (
  id          text PRIMARY KEY,
  kind        text NOT NULL,              -- architecture | workflow | sequence | dataflow | lifecycle
  ir          jsonb NOT NULL,             -- archify typed JSON IR (source of truth; re-renderable, diffable)
  html        text,                       -- rendered self-contained archify HTML (~600KB; served at /a/:id)
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  pinned      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mdshare_archify_expires_idx ON mdshare_archify (expires_at);
