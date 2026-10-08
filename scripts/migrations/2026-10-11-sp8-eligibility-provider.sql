-- 2026-10-11 SP8: nhcx_eligibility_checks.provider_id, the doctor a CoverageEligibilityRequest names
-- (needed to rebuild the bundle at dispatch time, since outbound bundles are not stored).
-- Additive, idempotent, safe to re-run. Requires 2026-10-10-sp8-abdm-nhcx.sql.
BEGIN;
ALTER TABLE nhcx_eligibility_checks ADD COLUMN IF NOT EXISTS provider_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_provider_fk') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_provider_fk
      FOREIGN KEY (provider_id) REFERENCES providers(id);
  END IF;
END $$;
COMMIT;
