-- Migration: Add pinned column to mdshare_diagrams
-- Enables Pin (keep forever) on the /d/:id diagram view, matching mdshare_pastes.
ALTER TABLE mdshare_diagrams
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
