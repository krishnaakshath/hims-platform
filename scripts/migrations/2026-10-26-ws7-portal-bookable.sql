-- 2026-10-26 WS7 T7: providers.portal_bookable (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D6).
--   portal_bookable boolean NOT NULL DEFAULT true: the doctor may be named on public/portal booking.
-- Plan A Task 6 (scripts/migrations/2026-10-24-ws6-provider-schedules.sql) adds the same column with
-- the identical guarded block, so whichever of the two runs second is a no-op. The UPDATE that
-- turns it off for doctors in non-clinical departments runs only when the column was missing,
-- so a re-run never overwrites a later admin change.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'providers' AND column_name = 'portal_bookable'
  ) THEN
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS portal_bookable boolean NOT NULL DEFAULT true;
    UPDATE providers SET portal_bookable = false
    WHERE department_id IN (SELECT id FROM departments WHERE kind <> 'clinical');
  END IF;
END $$;

COMMIT;
