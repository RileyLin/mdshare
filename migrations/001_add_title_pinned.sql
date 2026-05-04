-- Migration: Add title and pinned columns to mdshare_pastes
ALTER TABLE mdshare_pastes
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
