-- 2026-10-09 SP7 migration B: payer profiles, payer networks, payer contacts, per-payer document
-- requirements, RCM reason codes and patient policies; billing_settings gains the hospital
-- ROHINI and HFR identifiers (plan 2026-10-07-sp7-rcm-claims.md Task 5).
-- Additive, idempotent. Safe to re-run. Requires 2026-10-09-sp7-a-rcm-role.sql and SP1-SP4.
-- Creates ten enum types and six tables, adds two billing_settings columns and seeds the reason
-- codes (ON CONFLICT DO NOTHING). Updates no existing row: payers and patients are extended, not
-- migrated (ruling 6); the legacy primary/secondary insurance columns stay as they are.
-- No FK has an ON DELETE action: deletePatient clears a patient's policies explicitly.
--
-- Local apply (never db:push against a shared DB):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-09-sp7-b-payers-policies.sql
BEGIN;
DO $$ BEGIN
  CREATE TYPE payer_kind AS ENUM ('insurer', 'tpa', 'government_scheme', 'corporate');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_submission_channel AS ENUM ('portal', 'email', 'nhcx', 'courier', 'hand_delivery');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE empanelment_status AS ENUM ('empanelled', 'pending', 'suspended', 'not_empanelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE policy_type AS ENUM ('individual', 'family_floater', 'group_corporate', 'government_scheme');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE policy_relationship AS ENUM ('self', 'spouse', 'child', 'parent', 'sibling', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE policy_priority AS ENUM ('primary', 'secondary');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE policy_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_type AS ENUM ('ipd', 'daycare', 'opd');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE claim_document_kind AS ENUM ('id_proof', 'policy_card', 'claim_form', 'discharge_summary', 'itemised_bill', 'investigation_reports', 'preauth_approval', 'operation_notes', 'prescription', 'query_response', 'appeal_letter', 'settlement_advice', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE rcm_reason_category AS ENUM ('disallowance', 'rejection', 'query', 'write_off');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- billing_settings: hospital identifiers used on claims.
ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS rohini_id text;
ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS hfr_id text;

-- payer_profiles: 1:1 with payers; makes a payer an insurer, TPA, government scheme or corporate.
CREATE TABLE IF NOT EXISTS payer_profiles (
  payer_id integer PRIMARY KEY,
  kind payer_kind NOT NULL,
  short_name text,
  irdai_registration_no text,
  nhcx_participant_code text,
  default_channel claim_submission_channel NOT NULL DEFAULT 'portal',
  portal_url text,
  claims_email text,
  empanelment_status empanelment_status NOT NULL DEFAULT 'pending',
  empanelled_from date,
  empanelled_to date,
  agreement_reference text,
  preauth_sla_hours integer NOT NULL DEFAULT 1,
  claim_settlement_sla_days integer NOT NULL DEFAULT 30,
  query_response_days integer NOT NULL DEFAULT 7,
  submission_window_days integer NOT NULL DEFAULT 15,
  requires_abha boolean NOT NULL DEFAULT false,
  requires_preauth_for_ipd boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  notes text,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_name text NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_profiles_payer_id_payers_id_fk') THEN
    ALTER TABLE payer_profiles ADD CONSTRAINT payer_profiles_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_profiles_sla_ranges') THEN
    ALTER TABLE payer_profiles ADD CONSTRAINT payer_profiles_sla_ranges
      CHECK (preauth_sla_hours BETWEEN 1 AND 720 AND claim_settlement_sla_days BETWEEN 1 AND 365 AND query_response_days BETWEEN 1 AND 90 AND submission_window_days BETWEEN 1 AND 365);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_profiles_empanelment_dates') THEN
    ALTER TABLE payer_profiles ADD CONSTRAINT payer_profiles_empanelment_dates
      CHECK (empanelled_to IS NULL OR empanelled_from IS NULL OR empanelled_to >= empanelled_from);
  END IF;
END $$;

-- payer_networks: which TPAs service which insurer.
CREATE TABLE IF NOT EXISTS payer_networks (
  id serial PRIMARY KEY,
  insurer_payer_id integer NOT NULL,
  tpa_payer_id integer NOT NULL,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_networks_insurer_payer_id_payers_id_fk') THEN
    ALTER TABLE payer_networks ADD CONSTRAINT payer_networks_insurer_payer_id_payers_id_fk
      FOREIGN KEY (insurer_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_networks_tpa_payer_id_payers_id_fk') THEN
    ALTER TABLE payer_networks ADD CONSTRAINT payer_networks_tpa_payer_id_payers_id_fk
      FOREIGN KEY (tpa_payer_id) REFERENCES payers(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payer_networks_pair_unique ON payer_networks (insurer_payer_id, tpa_payer_id);

-- payer_contacts
CREATE TABLE IF NOT EXISTS payer_contacts (
  id serial PRIMARY KEY,
  payer_id integer NOT NULL,
  name text NOT NULL,
  designation text,
  phone text,
  email text,
  is_escalation boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_contacts_payer_id_payers_id_fk') THEN
    ALTER TABLE payer_contacts ADD CONSTRAINT payer_contacts_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS payer_contacts_payer_idx ON payer_contacts (payer_id);

-- payer_document_requirements: per-payer overrides of the default required documents.
CREATE TABLE IF NOT EXISTS payer_document_requirements (
  id serial PRIMARY KEY,
  payer_id integer NOT NULL,
  claim_type claim_type NOT NULL,
  document_kind claim_document_kind NOT NULL,
  required boolean NOT NULL,
  updated_by_name text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payer_document_requirements_payer_id_payers_id_fk') THEN
    ALTER TABLE payer_document_requirements ADD CONSTRAINT payer_document_requirements_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS payer_document_requirements_unique ON payer_document_requirements (payer_id, claim_type, document_kind);

-- rcm_reason_codes: reference data (read-only in SP7).
CREATE TABLE IF NOT EXISTS rcm_reason_codes (
  code text PRIMARY KEY,
  label text NOT NULL,
  category rcm_reason_category NOT NULL,
  patient_recoverable_default boolean NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rcm_reason_codes_code_format') THEN
    ALTER TABLE rcm_reason_codes ADD CONSTRAINT rcm_reason_codes_code_format
      CHECK (code ~ '^[A-Z0-9_]{2,16}$');
  END IF;
END $$;
INSERT INTO rcm_reason_codes (code, label, category, patient_recoverable_default, sort_order) VALUES
  ('NME', 'Non-medical expenses not payable', 'disallowance', true, 10),
  ('RRP', 'Proportionate deduction for room rent above eligibility', 'disallowance', true, 20),
  ('COPAY', 'Co-payment as per policy', 'disallowance', true, 30),
  ('SUBLIMIT', 'Sub-limit or capping exceeded', 'disallowance', true, 40),
  ('TARIFF', 'Charged above the agreed tariff or package rate', 'disallowance', false, 50),
  ('EXCL', 'Policy exclusion', 'rejection', true, 60),
  ('PED', 'Pre-existing disease waiting period', 'rejection', true, 70),
  ('WAIT', 'Initial waiting period', 'rejection', true, 80),
  ('NONDISC', 'Non-disclosure', 'rejection', true, 90),
  ('LATE', 'Late intimation or submission', 'rejection', false, 100),
  ('DUP', 'Duplicate claim', 'rejection', false, 110),
  ('DOCS', 'Documents incomplete', 'query', false, 120),
  ('CLARIFY', 'Clinical clarification needed', 'query', false, 130),
  ('SHORTPAY', 'Short payment by the insurer', 'write_off', false, 140),
  ('BANK', 'Bank charges', 'write_off', false, 150),
  ('ABSORB', 'Deduction absorbed by the hospital', 'write_off', false, 160),
  ('OTHER', 'Other', 'disallowance', false, 999)
ON CONFLICT (code) DO NOTHING;

-- patient_policies: a patient's insurance policy / card (card images in the private blob store).
CREATE TABLE IF NOT EXISTS patient_policies (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  insurer_payer_id integer NOT NULL,
  tpa_payer_id integer,
  policy_number text NOT NULL,
  member_id text NOT NULL,
  plan_name text,
  policy_type policy_type NOT NULL,
  corporate_name text,
  employee_id text,
  holder_name text NOT NULL,
  relationship policy_relationship NOT NULL,
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  sum_insured_paise bigint,
  copay_bp integer,
  room_rent_limit_paise bigint,
  priority policy_priority NOT NULL DEFAULT 'primary',
  status policy_status NOT NULL DEFAULT 'active',
  card_front_blob_url text,
  card_front_sha256 text,
  card_back_blob_url text,
  card_back_sha256 text,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_name text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_patient_id_patients_id_fk') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_insurer_payer_id_payers_id_fk') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_insurer_payer_id_payers_id_fk
      FOREIGN KEY (insurer_payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_tpa_payer_id_payers_id_fk') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_tpa_payer_id_payers_id_fk
      FOREIGN KEY (tpa_payer_id) REFERENCES payers(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS patient_policies_patient_idx ON patient_policies (patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS patient_policies_one_active_primary ON patient_policies (patient_id) WHERE status = 'active' AND priority = 'primary';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_dates') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_dates
      CHECK (valid_to >= valid_from);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_amounts') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_amounts
      CHECK ((sum_insured_paise IS NULL OR sum_insured_paise BETWEEN 0 AND 1000000000000) AND (room_rent_limit_paise IS NULL OR room_rent_limit_paise BETWEEN 0 AND 1000000000000) AND (copay_bp IS NULL OR copay_bp BETWEEN 0 AND 10000));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_policies_card_pairs') THEN
    ALTER TABLE patient_policies ADD CONSTRAINT patient_policies_card_pairs
      CHECK ((card_front_blob_url IS NULL) = (card_front_sha256 IS NULL) AND (card_back_blob_url IS NULL) = (card_back_sha256 IS NULL));
  END IF;
END $$;

COMMIT;
