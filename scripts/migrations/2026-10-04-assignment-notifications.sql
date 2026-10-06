-- 2026-10-04 doctor-assignment notifications (spec 2026-09-29-assignment-notifications.md §3).
-- Additive, nullable, idempotent. Safe to re-run. Shared Neon DB: other branches
-- insert doctor_assignments rows without knowing these columns exist.
BEGIN;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS patient_notified_at timestamp;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS decline_acknowledged_at timestamp;
ALTER TABLE doctor_assignments ADD COLUMN IF NOT EXISTS decline_acknowledged_by_name text;
COMMIT;
