-- 2026-10-09 Wave G (P2-01): per-user read state for the staff notification feed.
-- The feed itself is computed from live events (lab reports, critical results,
-- follow-ups, booking requests, assignments, stock, patient notices); this table
-- only remembers which feed items a staff user has read. user_key is 'u:<users.id>'
-- or, for a session with no users row, 'n:<role>:<name>'. Additive, idempotent,
-- safe to re-run. Rows older than the feed window are pruned by the app.
BEGIN;
CREATE TABLE IF NOT EXISTS staff_notification_reads (
  user_key text NOT NULL,
  item_key text NOT NULL,
  read_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT staff_notification_reads_user_key_item_key_pk PRIMARY KEY (user_key, item_key)
);
CREATE INDEX IF NOT EXISTS staff_notification_reads_read_at_idx ON staff_notification_reads (read_at);
COMMIT;
