-- 008: error/event log for production monitoring (client errors, server errors, release events).
-- Additive only. Written by the API with the service key; nothing reads it without the monitor key.
CREATE TABLE IF NOT EXISTS mdshare_events (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,           -- client_error | server_error
  message     text,
  detail      jsonb,
  commit      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mdshare_events_created_at_idx ON mdshare_events (created_at DESC);
ALTER TABLE mdshare_events ENABLE ROW LEVEL SECURITY;
