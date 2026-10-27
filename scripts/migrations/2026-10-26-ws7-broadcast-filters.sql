-- 2026-10-26 WS7 T10: real broadcasts (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D16).
--   broadcasts.filters        the hospital audience filters the sender used (jsonb; NULL on older rows)
--   broadcasts.template_key   'broadcast_notice' for sends through the notification service
--   broadcasts.sent_count / skipped_count / failed_count   per-broadcast outcome counts
-- Per-recipient delivery rows live in notification_log. Additive and re-runnable.
BEGIN;

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS filters jsonb;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS template_key text;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS sent_count integer NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS skipped_count integer NOT NULL DEFAULT 0;
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;

COMMIT;
