-- 2026-10-10 SP8 ABDM / NHCX integration (plan 2026-10-07-sp8-abdm-nhcx.md Task 2).
-- patients gains the ABHA verification columns (verified by ABDM or a Scan & Share, all three or
-- none); new tables abdm_consents, abdm_profile_shares, nhcx_eligibility_checks, nhcx_exchanges
-- and nhcx_inbound_calls. Additive, idempotent, safe to re-run. Requires the SP1 and SP7
-- migrations (2026-10-09-sp7-c-preauth-claims.sql). No FK has an ON DELETE action. No existing
-- row is changed.
--
-- Never stored in any of these tables: the national ID number, one-time passwords and ABDM
-- tokens (SP8 ruling 4). Outbound NHCX bundles are rebuilt from the SP7 snapshots; only their
-- SHA-256 and, until accepted, the vault-sealed JWE are kept. Inbound payloads are vault-sealed.
--
-- MIGRATION-ONLY OBJECTS: sp8_append_only() and sp8_abdm_consents_guard() with the triggers
-- nhcx_inbound_calls_append_only (no UPDATE or DELETE) and abdm_consents_append_only (no DELETE;
-- the one allowed UPDATE sets patient_id from NULL and changes nothing else). Both refuse with
-- SQLSTATE 55000 and both are bypassed by a transaction that first runs
--     select set_config('hims.allow_document_purge', 'on', true)
-- (the seed's clearExistingData(), deletePatient and tests/db/sp8-fixtures.ts only; the 30-day
-- nhcx_inbound_calls purge in the NHCX sweep).
BEGIN;
-- patients: ABHA verification (ruling 12: recorded vs verified)
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_verified_at timestamp;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_verification_source text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_verified_via text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_abha_verification_complete') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_abha_verification_complete
      CHECK ((abha_verified_at IS NULL) = (abha_verification_source IS NULL) AND (abha_verified_at IS NULL) = (abha_verified_via IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_abha_verification_source_valid') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_abha_verification_source_valid
      CHECK (abha_verification_source IS NULL OR abha_verification_source IN ('abdm', 'abdm_sandbox_mock'));
  END IF;
END $$;

-- abdm_consents
CREATE TABLE IF NOT EXISTS abdm_consents (
  id serial PRIMARY KEY,
  patient_id text,
  flow_id text NOT NULL,
  purpose text NOT NULL,
  consent_code text NOT NULL,
  consent_version text NOT NULL,
  text_sha256 text NOT NULL,
  given_by text NOT NULL,
  recorded_by_name text NOT NULL,
  recorded_by_user_id integer,
  recorded_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_consents_patient_fk') THEN
    ALTER TABLE abdm_consents ADD CONSTRAINT abdm_consents_patient_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_consents_recorded_by_user_fk') THEN
    ALTER TABLE abdm_consents ADD CONSTRAINT abdm_consents_recorded_by_user_fk
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_consents_purpose_valid') THEN
    ALTER TABLE abdm_consents ADD CONSTRAINT abdm_consents_purpose_valid
      CHECK (purpose IN ('abha_enrolment', 'abha_verification'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_consents_given_by_valid') THEN
    ALTER TABLE abdm_consents ADD CONSTRAINT abdm_consents_given_by_valid
      CHECK (given_by IN ('patient', 'guardian'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS abdm_consents_patient_idx ON abdm_consents (patient_id);
CREATE INDEX IF NOT EXISTS abdm_consents_flow_idx ON abdm_consents (flow_id);

-- abdm_profile_shares (Scan & Share)
CREATE TABLE IF NOT EXISTS abdm_profile_shares (
  id serial PRIMARY KEY,
  request_id text NOT NULL,
  hip_id text NOT NULL,
  counter_id text NOT NULL,
  intent text NOT NULL,
  abha_number text,
  abha_address text,
  name text,
  gender text,
  year_of_birth integer,
  month_of_birth integer,
  day_of_birth integer,
  phone text,
  address_line text,
  district_name text,
  state_name text,
  pincode text,
  token_date date NOT NULL,
  token_number integer NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  patient_id text,
  ack_state text NOT NULL DEFAULT 'pending',
  is_mock boolean NOT NULL DEFAULT false,
  received_at timestamp NOT NULL DEFAULT now(),
  resolved_at timestamp,
  resolved_by_name text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_request_unique') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_request_unique
      UNIQUE (request_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_patient_fk') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_patient_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_expired_scrubbed') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_expired_scrubbed
      CHECK (status <> 'expired' OR (abha_number IS NULL AND abha_address IS NULL AND name IS NULL AND phone IS NULL AND address_line IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_status_valid') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_status_valid
      CHECK (status IN ('pending', 'registered', 'linked', 'dismissed', 'expired'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_ack_state_valid') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_ack_state_valid
      CHECK (ack_state IN ('pending', 'sent', 'failed'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'abdm_profile_shares_token_positive') THEN
    ALTER TABLE abdm_profile_shares ADD CONSTRAINT abdm_profile_shares_token_positive
      CHECK (token_number > 0);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS abdm_profile_shares_token_unique ON abdm_profile_shares (token_date, counter_id, token_number);
CREATE INDEX IF NOT EXISTS abdm_profile_shares_status_idx ON abdm_profile_shares (status, received_at);

-- nhcx_eligibility_checks
CREATE TABLE IF NOT EXISTS nhcx_eligibility_checks (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  policy_id integer NOT NULL,
  payer_id integer NOT NULL,
  purpose text NOT NULL,
  context text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  inforce boolean,
  requested_by_name text NOT NULL,
  requested_by_user_id integer,
  requested_at timestamp NOT NULL DEFAULT now(),
  responded_at timestamp,
  is_mock boolean NOT NULL DEFAULT false
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_patient_fk') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_patient_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_policy_fk') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_policy_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_payer_fk') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_payer_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_user_fk') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_user_fk
      FOREIGN KEY (requested_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_purpose_valid') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_purpose_valid
      CHECK (purpose IN ('validation', 'benefits', 'auth-requirements', 'discovery'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_context_valid') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_context_valid
      CHECK (context IN ('registration', 'admission', 'preauth', 'manual'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_eligibility_checks_status_valid') THEN
    ALTER TABLE nhcx_eligibility_checks ADD CONSTRAINT nhcx_eligibility_checks_status_valid
      CHECK (status IN ('pending', 'eligible', 'not_eligible', 'error', 'no_response'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS nhcx_eligibility_patient_idx ON nhcx_eligibility_checks (patient_id);

-- nhcx_exchanges (outbox and inbound messages)
CREATE TABLE IF NOT EXISTS nhcx_exchanges (
  id serial PRIMARY KEY,
  entity_type text NOT NULL,
  direction text NOT NULL,
  action text NOT NULL,
  correlation_id uuid NOT NULL,
  api_call_id uuid NOT NULL,
  sender_code text NOT NULL,
  recipient_code text NOT NULL,
  state text NOT NULL,
  protocol_status text,
  patient_id text NOT NULL,
  policy_id integer,
  preauth_id integer,
  preauth_event_id integer,
  claim_id integer,
  claim_submission_id integer,
  eligibility_check_id integer,
  rcm_query_id integer,
  related_exchange_id integer,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp,
  last_error_code text,
  last_polled_at timestamp,
  body_sha256 text NOT NULL,
  jwe_encrypted text,
  payload_encrypted text,
  summary jsonb,
  review_state text NOT NULL DEFAULT 'not_needed',
  reviewed_by_name text,
  reviewed_at timestamp,
  is_mock boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  responded_at timestamp
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_api_call_unique') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_api_call_unique
      UNIQUE (api_call_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_patient_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_patient_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_policy_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_policy_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_preauth_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_preauth_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_preauth_event_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_preauth_event_fk
      FOREIGN KEY (preauth_event_id) REFERENCES preauth_events(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_claim_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_claim_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_claim_submission_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_claim_submission_fk
      FOREIGN KEY (claim_submission_id) REFERENCES claim_submissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_eligibility_check_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_eligibility_check_fk
      FOREIGN KEY (eligibility_check_id) REFERENCES nhcx_eligibility_checks(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_rcm_query_fk') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_rcm_query_fk
      FOREIGN KEY (rcm_query_id) REFERENCES rcm_queries(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_payload_direction') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_payload_direction
      CHECK ((direction = 'inbound' OR payload_encrypted IS NULL) AND (direction = 'outbound' OR jwe_encrypted IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_attempts_range') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_attempts_range
      CHECK (attempts BETWEEN 0 AND 10);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_entity_type_valid') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_entity_type_valid
      CHECK (entity_type IN ('coverageeligibility', 'preauth', 'claim', 'communication', 'paymentnotice', 'status'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_direction_valid') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_direction_valid
      CHECK (direction IN ('outbound', 'inbound'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_state_valid') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_state_valid
      CHECK (state IN ('pending_send', 'sent', 'send_failed', 'queued', 'dispatched', 'responded', 'error', 'no_response', 'received', 'acknowledged'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_exchanges_review_state_valid') THEN
    ALTER TABLE nhcx_exchanges ADD CONSTRAINT nhcx_exchanges_review_state_valid
      CHECK (review_state IN ('not_needed', 'pending', 'confirmed', 'dismissed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS nhcx_exchanges_correlation_idx ON nhcx_exchanges (correlation_id);
CREATE INDEX IF NOT EXISTS nhcx_exchanges_claim_idx ON nhcx_exchanges (claim_id);
CREATE INDEX IF NOT EXISTS nhcx_exchanges_preauth_idx ON nhcx_exchanges (preauth_id);
CREATE INDEX IF NOT EXISTS nhcx_exchanges_due_idx ON nhcx_exchanges (state, next_attempt_at);
-- One outbound exchange per claim version (a double-clicked submit cannot send twice).
CREATE UNIQUE INDEX IF NOT EXISTS nhcx_exchanges_submission_unique ON nhcx_exchanges (claim_submission_id)
  WHERE direction = 'outbound' AND claim_submission_id IS NOT NULL;

-- nhcx_inbound_calls (replay dedupe; ids only)
CREATE TABLE IF NOT EXISTS nhcx_inbound_calls (
  api_call_id uuid PRIMARY KEY,
  action text NOT NULL,
  sender_code text NOT NULL,
  correlation_id uuid NOT NULL,
  outcome text NOT NULL,
  exchange_id integer,
  received_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nhcx_inbound_calls_outcome_valid') THEN
    ALTER TABLE nhcx_inbound_calls ADD CONSTRAINT nhcx_inbound_calls_outcome_valid
      CHECK (outcome IN ('accepted', 'rejected'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS nhcx_inbound_calls_received_idx ON nhcx_inbound_calls (received_at);

-- Immutability (migration-only).
CREATE OR REPLACE FUNCTION sp8_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'integration records are append-only' USING ERRCODE = '55000';
END;
$fn$;
CREATE OR REPLACE FUNCTION sp8_abdm_consents_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.patient_id IS NULL AND NEW.patient_id IS NOT NULL
     AND (to_jsonb(NEW) - 'patient_id') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'patient_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'integration records are append-only' USING ERRCODE = '55000';
END;
$fn$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nhcx_inbound_calls_append_only' AND tgrelid = 'nhcx_inbound_calls'::regclass) THEN
    CREATE TRIGGER nhcx_inbound_calls_append_only BEFORE UPDATE OR DELETE ON nhcx_inbound_calls
      FOR EACH ROW EXECUTE FUNCTION sp8_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'abdm_consents_append_only' AND tgrelid = 'abdm_consents'::regclass) THEN
    CREATE TRIGGER abdm_consents_append_only BEFORE UPDATE OR DELETE ON abdm_consents
      FOR EACH ROW EXECUTE FUNCTION sp8_abdm_consents_guard();
  END IF;
END $$;
COMMIT;
