-- 2026-10-24 WS3 T1 admission fields, ward gender restriction, one active stay (plan 2026-10-23-inpatient-lab).
-- Payer, pre-auth and deposit are NOT here: they live in admission_coverage (WS12).
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS expected_stay_days integer;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS attendant_name text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS attendant_relationship text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS attendant_phone text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS ward_gender_override_reason text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS ward_gender_override_by_name text;
ALTER TABLE admissions ADD COLUMN IF NOT EXISTS admitted_by_name text;
ALTER TABLE admission_transfers ADD COLUMN IF NOT EXISTS ward_gender_override_reason text;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS gender_restriction text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admissions_expected_stay_range') THEN
    ALTER TABLE admissions ADD CONSTRAINT admissions_expected_stay_range
      CHECK (expected_stay_days IS NULL OR (expected_stay_days BETWEEN 1 AND 365));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_gender_restriction_valid') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_gender_restriction_valid
      CHECK (gender_restriction IS NULL OR gender_restriction IN ('male', 'female'));
  END IF;
END $$;

UPDATE rooms SET gender_restriction = 'male' WHERE gender_restriction IS NULL AND ward ILIKE '%(male)%';
UPDATE rooms SET gender_restriction = 'female' WHERE gender_restriction IS NULL AND ward ILIKE '%(female)%';

-- Refuse to build the unique index over bad data; report admission ids only.
DO $$
DECLARE dup text;
BEGIN
  SELECT string_agg(a.id::text, ', ' ORDER BY a.id) INTO dup
    FROM admissions a
   WHERE a.status = 'admitted'
     AND a.patient_id IN (SELECT patient_id FROM admissions WHERE status = 'admitted' GROUP BY patient_id HAVING count(*) > 1);
  IF dup IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate active admissions: %', dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS admissions_one_active_per_patient ON admissions (patient_id) WHERE status = 'admitted';

COMMIT;
