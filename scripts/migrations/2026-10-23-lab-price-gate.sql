-- 2026-10-23 Foundations T10: lab_tests.is_active (activating an unmapped test is refused by the app).
-- Additive, idempotent, safe to re-run.
BEGIN;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
COMMIT;
