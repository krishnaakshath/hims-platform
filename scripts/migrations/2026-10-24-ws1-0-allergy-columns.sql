-- 2026-10-24 WS1 T1 allergy columns (plan 2026-10-23-doctor-workspace-billing.md, lane ruling R4).
-- patients.allergy_status: 'unknown' until a clinician records allergies or "no known allergies".
-- allergies.recorded_by_name / recorded_at: who recorded the row and when (legacy rows stay null).
-- allergies.inactivated_at: a soft removal; an allergy is active while inactivated_at IS NULL.
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS allergy_status text NOT NULL DEFAULT 'unknown';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_allergy_status_valid') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_allergy_status_valid
      CHECK (allergy_status IN ('unknown', 'none_known', 'recorded'));
  END IF;
END $$;

ALTER TABLE allergies ADD COLUMN IF NOT EXISTS recorded_by_name text;
ALTER TABLE allergies ADD COLUMN IF NOT EXISTS recorded_at timestamp;
ALTER TABLE allergies ADD COLUMN IF NOT EXISTS inactivated_at timestamp;

COMMIT;
