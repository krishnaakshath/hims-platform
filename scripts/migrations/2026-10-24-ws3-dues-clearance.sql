-- 2026-10-24 WS3 T5 discharge dues clearances (plan 2026-10-23-inpatient-lab, spec 3.2 item 13 and §4).
-- Append-only rows written by billing; an outstanding amount needs an override reason.
-- Detail rows of the admission: ON DELETE CASCADE (pinned in tests/db/migrate-runner.test.ts).
-- Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS admission_dues_clearances (
  id serial PRIMARY KEY,
  admission_id integer NOT NULL,
  charges_paise bigint NOT NULL,
  paid_paise bigint NOT NULL,
  insurer_share_paise bigint NOT NULL,
  outstanding_paise bigint NOT NULL,
  override_reason text,
  cleared_by_name text NOT NULL,
  cleared_by_user_id integer,
  cleared_at timestamp DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_dues_clearances_admission_id_admissions_id_fk') THEN
    ALTER TABLE admission_dues_clearances ADD CONSTRAINT admission_dues_clearances_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_dues_clearances_cleared_by_user_id_users_id_fk') THEN
    ALTER TABLE admission_dues_clearances ADD CONSTRAINT admission_dues_clearances_cleared_by_user_id_users_id_fk
      FOREIGN KEY (cleared_by_user_id) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_dues_clearances_reason') THEN
    ALTER TABLE admission_dues_clearances ADD CONSTRAINT admission_dues_clearances_reason
      CHECK (outstanding_paise = 0 OR override_reason IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_dues_clearances_amounts') THEN
    ALTER TABLE admission_dues_clearances ADD CONSTRAINT admission_dues_clearances_amounts
      CHECK (charges_paise >= 0 AND paid_paise >= 0 AND insurer_share_paise >= 0 AND outstanding_paise >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_dues_clearances_reason_length') THEN
    ALTER TABLE admission_dues_clearances ADD CONSTRAINT admission_dues_clearances_reason_length
      CHECK (override_reason IS NULL OR char_length(override_reason) BETWEEN 10 AND 500);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS admission_dues_clearances_admission_idx ON admission_dues_clearances (admission_id, cleared_at);

COMMIT;
