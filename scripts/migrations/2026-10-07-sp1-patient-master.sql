-- 2026-10-07 SP1 Indian patient master (plan 2026-10-07-sp1-patient-master.md Task 3).
-- Additive, idempotent. Safe to re-run. Shared Neon DB: other branches insert
-- patients/providers/app_settings rows without knowing these columns exist,
-- so every new column is nullable or has a default.
-- Requires 2026-10-07-sp1-departments.sql to have been applied first
-- (providers.department_id references departments).
-- Apply: node --env-file=.env.local scripts/apply-sql.mjs scripts/migrations/2026-10-07-sp1-patient-master.sql
BEGIN;

-- KYC document types. ALTER TYPE ... ADD VALUE is allowed inside a transaction
-- block on Postgres 12+; the new values just cannot be USED in this same
-- transaction, and nothing below uses them.
ALTER TYPE id_type ADD VALUE IF NOT EXISTS 'voter_id';
ALTER TYPE id_type ADD VALUE IF NOT EXISTS 'pan';
ALTER TYPE id_type ADD VALUE IF NOT EXISTS 'ration_card';

-- UHID numeric part; the prefix is app_settings.uhid_prefix.
CREATE SEQUENCE IF NOT EXISTS uhid_seq START 1 INCREMENT 1;

DO $$ BEGIN
  CREATE TYPE gender AS ENUM ('male', 'female', 'transgender', 'other', 'unknown');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE marital_status AS ENUM ('single', 'married', 'divorced', 'widowed', 'separated', 'unknown');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE blood_group AS ENUM ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE patient_contact_kind AS ENUM ('next_of_kin', 'guardian', 'emergency');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE registration_council AS ENUM ('nmc', 'smc');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- patients: structured Indian demographics/address, UHID, ABHA, MLC.
-- Aadhaar is NOT a patients column (see patient_aadhaar below).
ALTER TABLE patients ADD COLUMN IF NOT EXISTS uhid text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS gender gender;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS marital_status marital_status;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS blood_group blood_group;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS occupation text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS nationality text DEFAULT 'IN';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS religion text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS preferred_language text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS photo_blob_path text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS state_code text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS pin_code text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_number text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_address text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_unavailable_reason text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS abha_unavailable_note text;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS is_mlc boolean NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS mlc_number text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_uhid_unique') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_uhid_unique UNIQUE (uhid);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_abha_number_unique') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_abha_number_unique UNIQUE (abha_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patients_abha_address_unique') THEN
    ALTER TABLE patients ADD CONSTRAINT patients_abha_address_unique UNIQUE (abha_address);
  END IF;
END $$;

-- NOK / guardian / emergency contacts.
CREATE TABLE IF NOT EXISTS patient_contacts (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  kind patient_contact_kind NOT NULL,
  name text NOT NULL,
  relationship text NOT NULL,
  phone text NOT NULL,
  address_text text,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_contacts_patient_id_patients_id_fk') THEN
    ALTER TABLE patient_contacts ADD CONSTRAINT patient_contacts_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS patient_contacts_patient_id_idx ON patient_contacts (patient_id);

-- Aadhaar: one row per patient, encrypted value + last 4 with consent, XOR a
-- recorded decline reason.
CREATE TABLE IF NOT EXISTS patient_aadhaar (
  patient_id text PRIMARY KEY,
  aadhaar_encrypted text,
  aadhaar_last4 text,
  consent_given boolean NOT NULL DEFAULT false,
  consent_recorded_at timestamp,
  decline_reason text,
  decline_note text,
  recorded_by_name text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_aadhaar_patient_id_patients_id_fk') THEN
    ALTER TABLE patient_aadhaar ADD CONSTRAINT patient_aadhaar_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_aadhaar_value_xor_decline') THEN
    ALTER TABLE patient_aadhaar ADD CONSTRAINT patient_aadhaar_value_xor_decline CHECK (
      (aadhaar_encrypted IS NOT NULL AND aadhaar_last4 ~ '^[0-9]{4}$' AND consent_given AND decline_reason IS NULL)
      OR (aadhaar_encrypted IS NULL AND aadhaar_last4 IS NULL AND decline_reason IS NOT NULL)
    );
  END IF;
END $$;

-- app_settings: UHID prefix; India default timezone.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS uhid_prefix text NOT NULL DEFAULT 'UH';
ALTER TABLE app_settings ALTER COLUMN practice_timezone SET DEFAULT 'Asia/Kolkata';
UPDATE app_settings SET practice_timezone = 'Asia/Kolkata' WHERE practice_timezone = 'America/Los_Angeles';

-- providers: department, NMC/SMC registration, consultation fee (integer paise).
ALTER TABLE providers ADD COLUMN IF NOT EXISTS department_id integer;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS registration_council registration_council;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS registration_state_code text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS consultation_fee_paise integer;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'INR';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_department_id_departments_id_fk') THEN
    ALTER TABLE providers ADD CONSTRAINT providers_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_consultation_fee_nonneg') THEN
    ALTER TABLE providers ADD CONSTRAINT providers_consultation_fee_nonneg
      CHECK (consultation_fee_paise IS NULL OR consultation_fee_paise >= 0);
  END IF;
END $$;

COMMIT;
