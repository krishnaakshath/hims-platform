-- 2026-10-25 WS6 T8: how the patient came to the hospital, recorded at registration
-- (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md, WS6 schema).
--   patients.referral_source  one of self, doctor, hospital, camp, insurer, online, other (nullable).
--   patients.referral_note    free text, e.g. the referring doctor (required by the app for 'doctor').
-- The patient photo uses the existing patients.photo_blob_path (no column here).
-- Additive and re-runnable: IF NOT EXISTS, DO block guarded on pg_constraint.
BEGIN;

ALTER TABLE patients ADD COLUMN IF NOT EXISTS referral_source text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS referral_note text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_referral_source_valid') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_referral_source_valid
      CHECK (referral_source IS NULL OR referral_source IN ('self', 'doctor', 'hospital', 'camp', 'insurer', 'online', 'other'));
  END IF;
END $$;

COMMIT;
