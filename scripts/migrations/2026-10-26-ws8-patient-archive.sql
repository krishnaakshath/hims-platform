-- 2026-10-26 WS8 T13: archive instead of delete (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D17).
--   patients.archived_at       when an admin archived the chart (NULL = active)
--   patients.archived_by_name  the admin's display name
--   patients.archive_reason    the admin's reason (>= 10 characters, enforced by the route)
--   patients_active_uhid_idx   partial index on uhid for the active (unarchived) charts every list reads
-- Mirrors src/db/schema.ts (// WS8 T13). Re-runnable.
BEGIN;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS archived_at timestamp;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS archived_by_name text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS archive_reason text;

CREATE INDEX IF NOT EXISTS patients_active_uhid_idx ON patients (uhid) WHERE archived_at IS NULL;

COMMIT;
