-- 2026-10-24 WS12 T1: coverage verification (spec docs/superpowers/specs/2026-10-23-insurance-verification-design.md §4).
--   coverage_verifications  every verification result from any source (nhcx, nhcx_mock, manual), append-only (R1).
--   admission_coverage      one row per admission: payment mode, policy, pre-auth, deposit, verdict (R12).
--   patient_policies.icu_limit_paise  per-day ICU limit (R7).
--   nhcx_eligibility_checks_context_valid re-created to allow 'checkin' (ELIGIBILITY_CONTEXTS).
-- MIGRATION-ONLY OBJECTS (drizzle cannot express them; same shape as SP7's sp7_append_only()):
--   function and trigger ws12_coverage_verifications_append_only: UPDATE/DELETE on
--   coverage_verifications raise 55000 unless hims.allow_document_purge = 'on'.
-- Additive and re-runnable: CREATE ... IF NOT EXISTS, DO blocks guarded on pg_constraint and
-- pg_trigger. The one DROP is the context check, dropped only while its definition lacks 'checkin'.
-- Requires 2026-10-10-sp8-abdm-nhcx.sql (nhcx_eligibility_checks) and SP7 migrations B and C.
BEGIN;

-- patient_policies: per-day ICU limit.
ALTER TABLE patient_policies ADD COLUMN IF NOT EXISTS icu_limit_paise bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_icu_limit_range') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_icu_limit_range
      CHECK (icu_limit_paise IS NULL OR icu_limit_paise BETWEEN 0 AND 1000000000000);
  END IF;
END $$;

-- nhcx_eligibility_checks: the context list gains 'checkin'.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'nhcx_eligibility_checks_context_valid' AND pg_get_constraintdef(oid) NOT LIKE '%''checkin''%'
  ) THEN
    ALTER TABLE nhcx_eligibility_checks DROP CONSTRAINT nhcx_eligibility_checks_context_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_context_valid') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_context_valid
      CHECK (context IN ('registration', 'checkin', 'admission', 'preauth', 'manual'));
  END IF;
END $$;

-- coverage_verifications
CREATE TABLE IF NOT EXISTS coverage_verifications (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  policy_id integer NOT NULL,
  source text NOT NULL,
  result text NOT NULL,
  context text NOT NULL,
  nhcx_check_id integer,
  method text,
  insurer_reference text,
  document_blob_url text,
  document_sha256 text,
  document_content_type text,
  verified_by_name text NOT NULL,
  verified_by_user_id integer,
  verified_at timestamp NOT NULL,
  valid_until timestamp NOT NULL,
  sum_insured_paise bigint,
  balance_paise bigint,
  copay_bp integer,
  room_rent_limit_paise bigint,
  icu_limit_paise bigint,
  reported_valid_to date,
  note text,
  created_at timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_patient_fk') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_patient_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_policy_fk') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_policy_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_check_fk') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_check_fk
      FOREIGN KEY (nhcx_check_id) REFERENCES nhcx_eligibility_checks(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_user_fk') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_user_fk
      FOREIGN KEY (verified_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_nhcx_check_unique') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_nhcx_check_unique UNIQUE (nhcx_check_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_source_valid') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_source_valid
      CHECK (source IN ('nhcx', 'nhcx_mock', 'manual'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_result_valid') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_result_valid
      CHECK (result IN ('active', 'inactive', 'error'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_context_valid') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_context_valid
      CHECK (context IN ('registration', 'checkin', 'admission', 'preauth', 'manual'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_method_valid') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_method_valid
      CHECK (method IS NULL OR method IN ('insurer_portal', 'tpa_portal', 'phone', 'email', 'letter'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_manual_method') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_manual_method
      CHECK (source <> 'manual' OR method IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_manual_no_check') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_manual_no_check
      CHECK (source <> 'manual' OR nhcx_check_id IS NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_reference_length') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_reference_length
      CHECK (insurer_reference IS NULL OR char_length(insurer_reference) <= 64);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_document_triple') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_document_triple
      CHECK ((document_blob_url IS NULL) = (document_sha256 IS NULL) AND (document_sha256 IS NULL) = (document_content_type IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_valid_window') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_valid_window
      CHECK (valid_until > verified_at);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_amounts') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_amounts
      CHECK ((sum_insured_paise IS NULL OR sum_insured_paise BETWEEN 0 AND 1000000000000)
         AND (balance_paise IS NULL OR balance_paise BETWEEN 0 AND 1000000000000)
         AND (room_rent_limit_paise IS NULL OR room_rent_limit_paise BETWEEN 0 AND 1000000000000)
         AND (icu_limit_paise IS NULL OR icu_limit_paise BETWEEN 0 AND 1000000000000)
         AND (copay_bp IS NULL OR copay_bp BETWEEN 0 AND 10000));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coverage_verifications_note_length') THEN
    ALTER TABLE coverage_verifications ADD CONSTRAINT coverage_verifications_note_length
      CHECK (note IS NULL OR char_length(note) <= 500);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS coverage_verifications_policy_idx ON coverage_verifications USING btree (policy_id, verified_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS coverage_verifications_patient_idx ON coverage_verifications USING btree (patient_id);

-- Immutability (migration-only), the sp7_append_only() shape.
CREATE OR REPLACE FUNCTION ws12_coverage_verifications_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'coverage verifications are append-only' USING ERRCODE = '55000';
END;
$fn$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ws12_coverage_verifications_append_only' AND tgrelid = 'coverage_verifications'::regclass) THEN
    CREATE TRIGGER ws12_coverage_verifications_append_only BEFORE UPDATE OR DELETE ON coverage_verifications
      FOR EACH ROW EXECUTE FUNCTION ws12_coverage_verifications_append_only();
  END IF;
END $$;

-- admission_coverage
CREATE TABLE IF NOT EXISTS admission_coverage (
  admission_id integer PRIMARY KEY,
  mode text NOT NULL,
  policy_id integer,
  preauth_id integer,
  deposit_required_paise bigint DEFAULT 0 NOT NULL,
  coverage_state text NOT NULL,
  verification_id integer,
  override_note text,
  recorded_by_name text NOT NULL,
  recorded_by_user_id integer,
  recorded_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_admission_fk') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_admission_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_policy_fk') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_policy_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_preauth_fk') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_preauth_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_verification_fk') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_verification_fk
      FOREIGN KEY (verification_id) REFERENCES coverage_verifications(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_user_fk') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_user_fk
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_mode_valid') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_mode_valid
      CHECK (mode IN ('self_pay', 'cashless', 'reimbursement'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_state_valid') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_state_valid
      CHECK (coverage_state IN ('no_policy', 'policy_inactive', 'policy_not_started', 'policy_expired', 'verified_active', 'verified_inactive', 'verification_error', 'pending', 'stale', 'unverified'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_mode_policy') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_mode_policy
      CHECK ((mode = 'self_pay' AND policy_id IS NULL AND preauth_id IS NULL) OR (mode <> 'self_pay' AND policy_id IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_deposit_range') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_deposit_range
      CHECK (deposit_required_paise BETWEEN 0 AND 10000000000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_coverage_override_note_length') THEN
    ALTER TABLE admission_coverage ADD CONSTRAINT admission_coverage_override_note_length
      CHECK (override_note IS NULL OR char_length(override_note) <= 500);
  END IF;
END $$;

COMMIT;
