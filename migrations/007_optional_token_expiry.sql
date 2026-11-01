-- Owner may explicitly choose a never-expiring token. NULL represents no expiry.
-- No existing values are modified; revocation and scopes are unchanged.
ALTER TABLE public.mdshare_agent_tokens ALTER COLUMN expires_at DROP NOT NULL;
