-- 2026-10-23 Foundations T9: notification_log.dedupe_key so a retried request (form send, video
-- start, booking confirm, lab/home-collection notice) never double-sends. Additive, idempotent,
-- safe to re-run.
BEGIN;
ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE INDEX IF NOT EXISTS notification_log_dedupe_idx ON notification_log (patient_id, template_key, dedupe_key);
COMMIT;
