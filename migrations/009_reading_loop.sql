-- 009: the reading loop — versions, feedback routing, read receipts, paragraph feedback.
-- Additive only: new nullable columns on mdshare_pastes and two new tables. Safe to re-run.
-- Applied with the Supabase management API by the agent (additive, per CLAUDE.md) before the app
-- code that reads these columns is deployed.

-- Versions: a new document can name the document it replaces. Nullable; old rows stay NULL.
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS parent_id text;
CREATE INDEX IF NOT EXISTS mdshare_pastes_parent_idx ON mdshare_pastes (parent_id) WHERE parent_id IS NOT NULL;
-- Where feedback on a document should be sent (an agent session/chat id). Owner/token creates only.
ALTER TABLE mdshare_pastes ADD COLUMN IF NOT EXISTS origin text;
CREATE INDEX IF NOT EXISTS mdshare_pastes_created_at_idx ON mdshare_pastes (created_at DESC);

-- Read receipts: one row per document, owner reads only (the API ignores everyone else).
CREATE TABLE IF NOT EXISTS mdshare_reads (
  doc_id          text PRIMARY KEY,
  first_opened_at timestamptz NOT NULL DEFAULT now(),
  last_opened_at  timestamptz NOT NULL DEFAULT now(),
  open_count      integer NOT NULL DEFAULT 0,
  max_scroll      integer NOT NULL DEFAULT 0,   -- 0..100, furthest point reached
  active_seconds  integer NOT NULL DEFAULT 0    -- visible, recently-interacted time
);
ALTER TABLE mdshare_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mdshare_reads FROM anon, authenticated;

-- Paragraph feedback from the reader page, picked up by the agent that wrote the document.
CREATE TABLE IF NOT EXISTS mdshare_feedback (
  id          text PRIMARY KEY,                 -- fb_<nanoid>
  doc_id      text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('example', 'unclear', 'wrong', 'expand', 'note')),
  quote       text,
  note        text,
  context     jsonb,                            -- {heading, before, after}
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_in text,                             -- id of the version that addressed it
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS mdshare_feedback_doc_idx ON mdshare_feedback (doc_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mdshare_feedback_status_idx ON mdshare_feedback (status, created_at DESC);
ALTER TABLE mdshare_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mdshare_feedback FROM anon, authenticated;
