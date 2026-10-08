-- 2026-10-09 SP7 migration C: pre-authorisations, insurer queries, claims, claim invoice links,
-- submission versions (the two copies), dispatches, claim events, claim documents, disallowances,
-- settlements and write-offs; charge_lines gains preauth_id (plan 2026-10-07-sp7-rcm-claims.md Task 6).
-- Additive, idempotent. Safe to re-run. Requires 2026-10-09-sp7-b-payers-policies.sql and SP1-SP4.
-- Creates eight enum types, two sequences and fourteen tables. No FK has an ON DELETE action.
-- claim_documents.source_id has no FK on purpose (its source table depends on `source`; SP7
-- does not depend on any lab-report table).
--
-- MIGRATION-ONLY OBJECTS (like SP4's issued-document triggers): the functions sp7_append_only(),
-- sp7_dispatch_guard(), sp7_settlement_guard() and sp7_write_off_guard() and the eight triggers
-- below cannot be expressed in src/db/schema.ts. Apply this file after every fresh `db:push`.
--   - claim_submissions_append_only, claim_events_append_only, claim_disallowances_append_only,
--     preauth_events_append_only, preauth_documents_append_only: no UPDATE or DELETE.
--   - claim_dispatches_guard: no DELETE; an UPDATE only while insurer_reference is null, changing
--     only insurer_reference, acknowledged_on and acknowledged_by_name.
--   - claim_settlements_guard: no DELETE; an UPDATE only while reconciled_at is null, changing only
--     bank_credit_date, reconciled_at and reconciled_by_name.
--   - claim_write_offs_guard: no DELETE; an UPDATE only while status = 'requested', changing only
--     status, decided_by_name, decided_by_user_id, decided_at and decision_note.
--   Each refusal is SQLSTATE 55000 'claim records are append-only'. Allowed changes are checked
--   as whole rows minus the allowed columns, so a column added later is protected too.
--
-- PURGE SETTING: a transaction that first runs
--     select set_config('hims.allow_document_purge', 'on', true)
-- passes every guard until it ends (transaction-local). Only the seed's clearExistingData(),
-- deletePatient's purge of a deletable patient's draft rows, and tests/db/rcm-fixtures.ts use it.
--
-- Local apply (never db:push against a shared DB):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-09-sp7-c-preauth-claims.sql
BEGIN;
DO $$ BEGIN
  CREATE TYPE preauth_status AS ENUM ('draft', 'requested', 'queried', 'approved', 'enhancement_requested', 'enhancement_queried', 'enhanced', 'rejected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE preauth_action AS ENUM ('request', 'record_query', 'respond_query', 'approve', 'reject', 'request_enhancement', 'approve_enhancement', 'reject_enhancement', 'cancel');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_status AS ENUM ('draft', 'submitted', 'queried', 'approved', 'partially_approved', 'rejected', 'appealed', 'settled', 'closed', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_event_action AS ENUM ('submit', 'record_query', 'respond_query', 'record_approval', 'record_partial_approval', 'record_rejection', 'appeal', 'record_settlement', 'close', 'reopen', 'withdraw', 'note');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_submission_kind AS ENUM ('initial', 'query_response', 'appeal', 'resubmission');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE rcm_query_status AS ENUM ('open', 'answered', 'closed');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_write_off_status AS ENUM ('requested', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_document_source AS ENUM ('upload', 'invoice', 'lab_report', 'discharge_summary', 'preauth_letter', 'policy_card', 'waiver');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Numbering (ruling 8): not tax documents, so sequences (gaps allowed).
CREATE SEQUENCE IF NOT EXISTS preauth_number_seq;
CREATE SEQUENCE IF NOT EXISTS claim_number_seq;

-- preauths
CREATE TABLE IF NOT EXISTS preauths (
  id serial PRIMARY KEY,
  preauth_number text NOT NULL,
  patient_id text NOT NULL,
  policy_id integer NOT NULL,
  insurer_payer_id integer NOT NULL,
  tpa_payer_id integer,
  admission_id integer,
  encounter_id integer,
  claim_type claim_type NOT NULL,
  status preauth_status NOT NULL DEFAULT 'draft',
  planned_admission_date date NOT NULL,
  expected_length_of_stay_days integer NOT NULL,
  room_category_code text,
  treating_provider_id integer NOT NULL,
  diagnoses jsonb NOT NULL DEFAULT '[]'::jsonb,
  procedures jsonb NOT NULL DEFAULT '[]'::jsonb,
  provisional_diagnosis_text text,
  estimate_lines jsonb NOT NULL,
  estimated_paise bigint NOT NULL,
  requested_paise bigint NOT NULL,
  approved_paise bigint,
  approval_reference text,
  valid_until date,
  first_requested_at timestamp,
  last_requested_at timestamp,
  decided_at timestamp,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_preauth_number_unique') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_preauth_number_unique
      UNIQUE (preauth_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_patient_id_patients_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_policy_id_patient_policies_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_policy_id_patient_policies_id_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_insurer_payer_id_payers_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_insurer_payer_id_payers_id_fk
      FOREIGN KEY (insurer_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_tpa_payer_id_payers_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_tpa_payer_id_payers_id_fk
      FOREIGN KEY (tpa_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_admission_id_admissions_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_encounter_id_encounters_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_treating_provider_id_providers_id_fk') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_treating_provider_id_providers_id_fk
      FOREIGN KEY (treating_provider_id) REFERENCES providers(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS preauths_patient_idx ON preauths (patient_id);
CREATE INDEX IF NOT EXISTS preauths_status_idx ON preauths (status);
CREATE UNIQUE INDEX IF NOT EXISTS preauths_insurer_reference_unique ON preauths (insurer_payer_id, lower(approval_reference)) WHERE approval_reference IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_approved_fields') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_approved_fields
      CHECK (status NOT IN ('approved', 'enhancement_requested', 'enhancement_queried', 'enhanced') OR (approved_paise IS NOT NULL AND approval_reference IS NOT NULL AND valid_until IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauths_amounts_range') THEN
    ALTER TABLE preauths ADD CONSTRAINT preauths_amounts_range
      CHECK (estimated_paise BETWEEN 0 AND 1000000000000 AND requested_paise BETWEEN 0 AND 1000000000000 AND (approved_paise IS NULL OR approved_paise BETWEEN 0 AND 1000000000000) AND expected_length_of_stay_days BETWEEN 1 AND 365);
  END IF;
END $$;

-- preauth_events (append-only)
CREATE TABLE IF NOT EXISTS preauth_events (
  id serial PRIMARY KEY,
  preauth_id integer NOT NULL,
  action preauth_action NOT NULL,
  from_status preauth_status,
  to_status preauth_status NOT NULL,
  amount_paise bigint,
  reason_code text,
  note text,
  snapshot jsonb,
  snapshot_sha256 text,
  by_name text NOT NULL,
  by_user_id integer,
  at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_events_preauth_id_preauths_id_fk') THEN
    ALTER TABLE preauth_events ADD CONSTRAINT preauth_events_preauth_id_preauths_id_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_events_reason_code_rcm_reason_codes_code_fk') THEN
    ALTER TABLE preauth_events ADD CONSTRAINT preauth_events_reason_code_rcm_reason_codes_code_fk
      FOREIGN KEY (reason_code) REFERENCES rcm_reason_codes(code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_events_by_user_id_users_id_fk') THEN
    ALTER TABLE preauth_events ADD CONSTRAINT preauth_events_by_user_id_users_id_fk
      FOREIGN KEY (by_user_id) REFERENCES users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS preauth_events_preauth_idx ON preauth_events (preauth_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_events_note_len') THEN
    ALTER TABLE preauth_events ADD CONSTRAINT preauth_events_note_len
      CHECK (note IS NULL OR length(note) <= 1000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_events_snapshot_pair') THEN
    ALTER TABLE preauth_events ADD CONSTRAINT preauth_events_snapshot_pair
      CHECK ((snapshot IS NULL) = (snapshot_sha256 IS NULL));
  END IF;
END $$;

-- claims
CREATE TABLE IF NOT EXISTS claims (
  id serial PRIMARY KEY,
  claim_number text NOT NULL,
  patient_id text NOT NULL,
  policy_id integer NOT NULL,
  insurer_payer_id integer NOT NULL,
  tpa_payer_id integer,
  billing_payer_id integer NOT NULL,
  claim_type claim_type NOT NULL,
  admission_id integer,
  encounter_id integer,
  preauth_id integer,
  status claim_status NOT NULL DEFAULT 'draft',
  claimed_paise bigint NOT NULL DEFAULT 0,
  approved_paise bigint,
  disallowed_paise bigint NOT NULL DEFAULT 0,
  non_recoverable_disallowed_paise bigint NOT NULL DEFAULT 0,
  settled_paise bigint NOT NULL DEFAULT 0,
  written_off_paise bigint NOT NULL DEFAULT 0,
  current_decision_event_id integer,
  current_version integer NOT NULL DEFAULT 0,
  row_version integer NOT NULL DEFAULT 0,
  insurer_claim_reference text,
  first_submitted_at timestamp,
  last_status_at timestamp,
  closed_at timestamp,
  created_by_name text NOT NULL,
  created_by_user_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_claim_number_unique') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_claim_number_unique
      UNIQUE (claim_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_patient_id_patients_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_policy_id_patient_policies_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_policy_id_patient_policies_id_fk
      FOREIGN KEY (policy_id) REFERENCES patient_policies(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_insurer_payer_id_payers_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_insurer_payer_id_payers_id_fk
      FOREIGN KEY (insurer_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_tpa_payer_id_payers_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_tpa_payer_id_payers_id_fk
      FOREIGN KEY (tpa_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_billing_payer_id_payers_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_billing_payer_id_payers_id_fk
      FOREIGN KEY (billing_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_admission_id_admissions_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_encounter_id_encounters_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_preauth_id_preauths_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_preauth_id_preauths_id_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_created_by_user_id_users_id_fk') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_created_by_user_id_users_id_fk
      FOREIGN KEY (created_by_user_id) REFERENCES users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claims_patient_idx ON claims (patient_id);
CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (status);
CREATE INDEX IF NOT EXISTS claims_billing_payer_idx ON claims (billing_payer_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_context') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_context
      CHECK ((claim_type = 'opd' AND encounter_id IS NOT NULL AND admission_id IS NULL) OR (claim_type IN ('ipd', 'daycare') AND admission_id IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_amounts_nonneg') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_amounts_nonneg
      CHECK (claimed_paise BETWEEN 0 AND 1000000000000 AND (approved_paise IS NULL OR approved_paise >= 0) AND disallowed_paise >= 0 AND non_recoverable_disallowed_paise >= 0 AND settled_paise >= 0 AND written_off_paise >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_approved_le_claimed') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_approved_le_claimed
      CHECK (approved_paise IS NULL OR approved_paise <= claimed_paise);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_credits_le_claimed') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_credits_le_claimed
      CHECK (settled_paise + written_off_paise <= claimed_paise);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_nonrecoverable_le_disallowed') THEN
    ALTER TABLE claims ADD CONSTRAINT claims_nonrecoverable_le_disallowed
      CHECK (non_recoverable_disallowed_paise <= disallowed_paise);
  END IF;
END $$;

-- rcm_queries: an insurer query on exactly one pre-auth or claim
CREATE TABLE IF NOT EXISTS rcm_queries (
  id serial PRIMARY KEY,
  preauth_id integer,
  claim_id integer,
  question text NOT NULL,
  raised_on date NOT NULL,
  due_on date NOT NULL,
  status rcm_query_status NOT NULL DEFAULT 'open',
  answered_at timestamp,
  closed_at timestamp,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_queries_preauth_id_preauths_id_fk') THEN
    ALTER TABLE rcm_queries ADD CONSTRAINT rcm_queries_preauth_id_preauths_id_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_queries_claim_id_claims_id_fk') THEN
    ALTER TABLE rcm_queries ADD CONSTRAINT rcm_queries_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rcm_queries_claim_idx ON rcm_queries (claim_id);
CREATE INDEX IF NOT EXISTS rcm_queries_preauth_idx ON rcm_queries (preauth_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_queries_one_subject') THEN
    ALTER TABLE rcm_queries ADD CONSTRAINT rcm_queries_one_subject
      CHECK ((preauth_id IS NULL) <> (claim_id IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_queries_due_after_raised') THEN
    ALTER TABLE rcm_queries ADD CONSTRAINT rcm_queries_due_after_raised
      CHECK (due_on >= raised_on);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_queries_question_len') THEN
    ALTER TABLE rcm_queries ADD CONSTRAINT rcm_queries_question_len
      CHECK (length(question) BETWEEN 1 AND 2000);
  END IF;
END $$;

-- claim_submissions (append-only): one row per outbound package version
CREATE TABLE IF NOT EXISTS claim_submissions (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  version integer NOT NULL,
  kind claim_submission_kind NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_sha256 text NOT NULL,
  rcm_copy_blob_url text NOT NULL,
  rcm_copy_sha256 text NOT NULL,
  insurer_copy_blob_url text NOT NULL,
  insurer_copy_sha256 text NOT NULL,
  created_by_name text NOT NULL,
  created_by_user_id integer,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_submissions_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_submissions ADD CONSTRAINT claim_submissions_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_submissions_created_by_user_id_users_id_fk') THEN
    ALTER TABLE claim_submissions ADD CONSTRAINT claim_submissions_created_by_user_id_users_id_fk
      FOREIGN KEY (created_by_user_id) REFERENCES users(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS claim_submissions_claim_version_unique ON claim_submissions (claim_id, version);

-- rcm_query_responses
CREATE TABLE IF NOT EXISTS rcm_query_responses (
  id serial PRIMARY KEY,
  query_id integer NOT NULL,
  body text NOT NULL,
  responded_on date NOT NULL,
  submission_id integer,
  by_name text NOT NULL,
  at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_query_responses_query_fk') THEN
    ALTER TABLE rcm_query_responses ADD CONSTRAINT rcm_query_responses_query_fk
      FOREIGN KEY (query_id) REFERENCES rcm_queries(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_query_responses_submission_id_claim_submissions_id_fk') THEN
    ALTER TABLE rcm_query_responses ADD CONSTRAINT rcm_query_responses_submission_id_claim_submissions_id_fk
      FOREIGN KEY (submission_id) REFERENCES claim_submissions(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS rcm_query_responses_query_idx ON rcm_query_responses (query_id);

-- preauth_documents (append-only)
CREATE TABLE IF NOT EXISTS preauth_documents (
  id serial PRIMARY KEY,
  preauth_id integer NOT NULL,
  kind claim_document_kind NOT NULL,
  title text NOT NULL,
  blob_url text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  query_response_id integer,
  uploaded_by_name text NOT NULL,
  uploaded_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_documents_preauth_id_preauths_id_fk') THEN
    ALTER TABLE preauth_documents ADD CONSTRAINT preauth_documents_preauth_id_preauths_id_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'preauth_documents_query_response_id_rcm_query_responses_id_fk') THEN
    ALTER TABLE preauth_documents ADD CONSTRAINT preauth_documents_query_response_id_rcm_query_responses_id_fk
      FOREIGN KEY (query_response_id) REFERENCES rcm_query_responses(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS preauth_documents_preauth_idx ON preauth_documents (preauth_id);

-- claim_invoices
CREATE TABLE IF NOT EXISTS claim_invoices (
  claim_id integer NOT NULL,
  invoice_id integer NOT NULL,
  invoice_total_paise bigint NOT NULL,
  claimed_paise bigint NOT NULL,
  added_by_name text NOT NULL,
  added_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_invoices_pk') THEN
    ALTER TABLE claim_invoices ADD CONSTRAINT claim_invoices_pk
      PRIMARY KEY (claim_id, invoice_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_invoices_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_invoices ADD CONSTRAINT claim_invoices_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_invoices_invoice_id_invoices_id_fk') THEN
    ALTER TABLE claim_invoices ADD CONSTRAINT claim_invoices_invoice_id_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES invoices(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claim_invoices_invoice_idx ON claim_invoices (invoice_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_invoices_claimed_range') THEN
    ALTER TABLE claim_invoices ADD CONSTRAINT claim_invoices_claimed_range
      CHECK (claimed_paise BETWEEN 1 AND invoice_total_paise);
  END IF;
END $$;

-- claim_dispatches: how a version reached the insurer; the insurer reference is recorded once
CREATE TABLE IF NOT EXISTS claim_dispatches (
  id serial PRIMARY KEY,
  submission_id integer NOT NULL,
  channel claim_submission_channel NOT NULL,
  transport text NOT NULL,
  tracking_reference text,
  dispatched_on date NOT NULL,
  dispatched_by_name text NOT NULL,
  dispatched_at timestamp NOT NULL DEFAULT now(),
  insurer_reference text,
  acknowledged_on date,
  acknowledged_by_name text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_dispatches_submission_id_unique') THEN
    ALTER TABLE claim_dispatches ADD CONSTRAINT claim_dispatches_submission_id_unique
      UNIQUE (submission_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_dispatches_submission_id_claim_submissions_id_fk') THEN
    ALTER TABLE claim_dispatches ADD CONSTRAINT claim_dispatches_submission_id_claim_submissions_id_fk
      FOREIGN KEY (submission_id) REFERENCES claim_submissions(id);
  END IF;
END $$;

-- claim_events (append-only)
CREATE TABLE IF NOT EXISTS claim_events (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  action claim_event_action NOT NULL,
  from_status claim_status,
  to_status claim_status NOT NULL,
  submission_id integer,
  amount_paise bigint,
  note text,
  portal_checked_on date,
  by_name text NOT NULL,
  by_user_id integer,
  at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_events_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_events ADD CONSTRAINT claim_events_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_events_submission_id_claim_submissions_id_fk') THEN
    ALTER TABLE claim_events ADD CONSTRAINT claim_events_submission_id_claim_submissions_id_fk
      FOREIGN KEY (submission_id) REFERENCES claim_submissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_events_by_user_id_users_id_fk') THEN
    ALTER TABLE claim_events ADD CONSTRAINT claim_events_by_user_id_users_id_fk
      FOREIGN KEY (by_user_id) REFERENCES users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claim_events_claim_idx ON claim_events (claim_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_events_note_len') THEN
    ALTER TABLE claim_events ADD CONSTRAINT claim_events_note_len
      CHECK (note IS NULL OR length(note) <= 2000);
  END IF;
END $$;

-- claim_documents (superseded, never deleted)
CREATE TABLE IF NOT EXISTS claim_documents (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  kind claim_document_kind NOT NULL,
  source claim_document_source NOT NULL,
  title text NOT NULL,
  blob_url text,
  content_type text,
  byte_size integer,
  sha256 text,
  source_id integer,
  id_proof_type text,
  waiver_reason text,
  query_response_id integer,
  superseded_at timestamp,
  superseded_by_name text,
  uploaded_by_name text NOT NULL,
  uploaded_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_query_response_id_rcm_query_responses_id_fk') THEN
    ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_query_response_id_rcm_query_responses_id_fk
      FOREIGN KEY (query_response_id) REFERENCES rcm_query_responses(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claim_documents_claim_idx ON claim_documents (claim_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_upload_complete') THEN
    ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_upload_complete
      CHECK (source <> 'upload' OR (blob_url IS NOT NULL AND sha256 IS NOT NULL AND content_type IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_waiver_reason') THEN
    ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_waiver_reason
      CHECK (source <> 'waiver' OR waiver_reason IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_documents_id_proof_type') THEN
    ALTER TABLE claim_documents ADD CONSTRAINT claim_documents_id_proof_type
      CHECK (kind <> 'id_proof' OR source <> 'upload' OR id_proof_type IS NOT NULL);
  END IF;
END $$;

-- claim_disallowances (append-only)
CREATE TABLE IF NOT EXISTS claim_disallowances (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  event_id integer NOT NULL,
  reason_code text NOT NULL,
  amount_paise bigint NOT NULL,
  patient_recoverable boolean NOT NULL,
  note text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_disallowances_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_disallowances ADD CONSTRAINT claim_disallowances_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_disallowances_event_id_claim_events_id_fk') THEN
    ALTER TABLE claim_disallowances ADD CONSTRAINT claim_disallowances_event_id_claim_events_id_fk
      FOREIGN KEY (event_id) REFERENCES claim_events(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_disallowances_reason_code_rcm_reason_codes_code_fk') THEN
    ALTER TABLE claim_disallowances ADD CONSTRAINT claim_disallowances_reason_code_rcm_reason_codes_code_fk
      FOREIGN KEY (reason_code) REFERENCES rcm_reason_codes(code);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claim_disallowances_claim_idx ON claim_disallowances (claim_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_disallowances_amount_positive') THEN
    ALTER TABLE claim_disallowances ADD CONSTRAINT claim_disallowances_amount_positive
      CHECK (amount_paise > 0);
  END IF;
END $$;

-- claim_settlements (amounts immutable; reconciled once)
CREATE TABLE IF NOT EXISTS claim_settlements (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  event_id integer NOT NULL,
  utr text NOT NULL,
  payment_date date NOT NULL,
  received_paise bigint NOT NULL,
  tds_paise bigint NOT NULL,
  bank_charges_paise bigint NOT NULL,
  settled_paise bigint NOT NULL,
  bank_credit_date date,
  reconciled_at timestamp,
  reconciled_by_name text,
  recorded_by_name text NOT NULL,
  recorded_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_settlements_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_settlements ADD CONSTRAINT claim_settlements_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_settlements_event_id_claim_events_id_fk') THEN
    ALTER TABLE claim_settlements ADD CONSTRAINT claim_settlements_event_id_claim_events_id_fk
      FOREIGN KEY (event_id) REFERENCES claim_events(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS claim_settlements_claim_utr_unique ON claim_settlements (claim_id, lower(utr));
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_settlements_sum') THEN
    ALTER TABLE claim_settlements ADD CONSTRAINT claim_settlements_sum
      CHECK (settled_paise = received_paise + tds_paise + bank_charges_paise);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_settlements_amounts') THEN
    ALTER TABLE claim_settlements ADD CONSTRAINT claim_settlements_amounts
      CHECK (received_paise > 0 AND tds_paise >= 0 AND bank_charges_paise >= 0);
  END IF;
END $$;

-- claim_write_offs (decided once, by a second person)
CREATE TABLE IF NOT EXISTS claim_write_offs (
  id serial PRIMARY KEY,
  claim_id integer NOT NULL,
  amount_paise bigint NOT NULL,
  reason_code text NOT NULL,
  note text NOT NULL,
  status claim_write_off_status NOT NULL DEFAULT 'requested',
  requested_by_name text NOT NULL,
  requested_by_user_id integer,
  requested_at timestamp NOT NULL DEFAULT now(),
  decided_by_name text,
  decided_by_user_id integer,
  decided_at timestamp,
  decision_note text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_claim_id_claims_id_fk') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_claim_id_claims_id_fk
      FOREIGN KEY (claim_id) REFERENCES claims(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_reason_code_rcm_reason_codes_code_fk') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_reason_code_rcm_reason_codes_code_fk
      FOREIGN KEY (reason_code) REFERENCES rcm_reason_codes(code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_requested_by_user_id_users_id_fk') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_requested_by_user_id_users_id_fk
      FOREIGN KEY (requested_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_decided_by_user_id_users_id_fk') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_decided_by_user_id_users_id_fk
      FOREIGN KEY (decided_by_user_id) REFERENCES users(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS claim_write_offs_claim_idx ON claim_write_offs (claim_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_amount_positive') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_amount_positive
      CHECK (amount_paise > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_decided') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_decided
      CHECK (status = 'requested' OR (decided_at IS NOT NULL AND decided_by_name IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_write_offs_second_person') THEN
    ALTER TABLE claim_write_offs ADD CONSTRAINT claim_write_offs_second_person
      CHECK (decided_by_user_id IS NULL OR decided_by_user_id IS DISTINCT FROM requested_by_user_id);
  END IF;
END $$;

-- charge_lines.preauth_id (ruling 7)
ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS preauth_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_preauth_id_preauths_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_preauth_id_preauths_id_fk
      FOREIGN KEY (preauth_id) REFERENCES preauths(id);
  END IF;
END $$;

-- Immutability (migration-only).
CREATE OR REPLACE FUNCTION sp7_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'claim records are append-only' USING ERRCODE = '55000';
END;
$fn$;
CREATE OR REPLACE FUNCTION sp7_dispatch_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.insurer_reference IS NULL
     AND (to_jsonb(NEW) - ARRAY['insurer_reference', 'acknowledged_on', 'acknowledged_by_name']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['insurer_reference', 'acknowledged_on', 'acknowledged_by_name']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'claim records are append-only' USING ERRCODE = '55000';
END;
$fn$;
CREATE OR REPLACE FUNCTION sp7_settlement_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.reconciled_at IS NULL
     AND (to_jsonb(NEW) - ARRAY['bank_credit_date', 'reconciled_at', 'reconciled_by_name']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['bank_credit_date', 'reconciled_at', 'reconciled_by_name']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'claim records are append-only' USING ERRCODE = '55000';
END;
$fn$;
CREATE OR REPLACE FUNCTION sp7_write_off_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'requested'
     AND (to_jsonb(NEW) - ARRAY['status', 'decided_by_name', 'decided_by_user_id', 'decided_at', 'decision_note']) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_by_name', 'decided_by_user_id', 'decided_at', 'decision_note']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'claim records are append-only' USING ERRCODE = '55000';
END;
$fn$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_submissions_append_only' AND tgrelid = 'claim_submissions'::regclass) THEN
    CREATE TRIGGER claim_submissions_append_only BEFORE UPDATE OR DELETE ON claim_submissions
      FOR EACH ROW EXECUTE FUNCTION sp7_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_events_append_only' AND tgrelid = 'claim_events'::regclass) THEN
    CREATE TRIGGER claim_events_append_only BEFORE UPDATE OR DELETE ON claim_events
      FOR EACH ROW EXECUTE FUNCTION sp7_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_disallowances_append_only' AND tgrelid = 'claim_disallowances'::regclass) THEN
    CREATE TRIGGER claim_disallowances_append_only BEFORE UPDATE OR DELETE ON claim_disallowances
      FOR EACH ROW EXECUTE FUNCTION sp7_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'preauth_events_append_only' AND tgrelid = 'preauth_events'::regclass) THEN
    CREATE TRIGGER preauth_events_append_only BEFORE UPDATE OR DELETE ON preauth_events
      FOR EACH ROW EXECUTE FUNCTION sp7_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'preauth_documents_append_only' AND tgrelid = 'preauth_documents'::regclass) THEN
    CREATE TRIGGER preauth_documents_append_only BEFORE UPDATE OR DELETE ON preauth_documents
      FOR EACH ROW EXECUTE FUNCTION sp7_append_only();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_dispatches_guard' AND tgrelid = 'claim_dispatches'::regclass) THEN
    CREATE TRIGGER claim_dispatches_guard BEFORE UPDATE OR DELETE ON claim_dispatches
      FOR EACH ROW EXECUTE FUNCTION sp7_dispatch_guard();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_settlements_guard' AND tgrelid = 'claim_settlements'::regclass) THEN
    CREATE TRIGGER claim_settlements_guard BEFORE UPDATE OR DELETE ON claim_settlements
      FOR EACH ROW EXECUTE FUNCTION sp7_settlement_guard();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'claim_write_offs_guard' AND tgrelid = 'claim_write_offs'::regclass) THEN
    CREATE TRIGGER claim_write_offs_guard BEFORE UPDATE OR DELETE ON claim_write_offs
      FOR EACH ROW EXECUTE FUNCTION sp7_write_off_guard();
  END IF;
END $$;

COMMIT;
