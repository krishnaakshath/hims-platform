-- 2026-10-07 SP6 clinical coding: code systems, coded diagnoses/procedures, coding workflow
-- (plan 2026-10-07-sp6-clinical-coding.md Task 4).
-- Additive, idempotent. Safe to re-run. Creates eight new tables and six enum types, and adds
-- nullable/defaulted columns to `diagnoses`. It never rewrites existing data: legacy diagnoses
-- keep their free-text `code`/`description` exactly as they are and read as `uncoded` with no
-- encounter (the NOT NULL default on `coding_status` is filled by ADD COLUMN, not an UPDATE).
-- Requires the SP1/SP2/SP3 migrations (2026-10-07-sp1-*.sql, 2026-10-07-sp2-*.sql,
-- 2026-10-07-sp3-encounters-follow-up.sql) and 2026-10-07-sp6-a-coder-role.sql to have been
-- applied first.
--
-- MIGRATION-ONLY: the `pg_trgm` extension and `codes_display_trgm_idx` (a GIN trigram index on
-- lower(display), used by code text search) are not expressible in src/db/schema.ts. After a
-- `db:push` on a fresh DB, apply this migration as well; text search still works without the
-- index, only slower. Never `db:push` against a DB that has it (push would drop it).
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp6-b-clinical-coding.sql
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$ BEGIN
  CREATE TYPE code_system_kind AS ENUM ('icd10', 'icd10pcs', 'snomed', 'loinc', 'hbp');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE code_entry_status AS ENUM ('uncoded', 'proposed', 'coded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE diagnosis_type AS ENUM ('primary', 'secondary', 'provisional');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE encounter_coding_status AS ENUM ('uncoded', 'in_progress', 'queried', 'coded', 'finalised');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE coding_event_action AS ENUM ('claim', 'assign', 'release', 'raise_query', 'resume', 'mark_coded', 'finalise', 'reopen', 'edit_after_coded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE coding_query_status AS ENUM ('open', 'answered', 'closed', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- code_systems: one row per imported version of a code set. Versions are never deleted or
-- updated in place; one current version per kind (partial unique index below).
CREATE TABLE IF NOT EXISTS code_systems (
  id serial PRIMARY KEY,
  kind code_system_kind NOT NULL,
  version text NOT NULL,
  name text NOT NULL,
  is_sample boolean NOT NULL DEFAULT false,
  is_current boolean NOT NULL DEFAULT false,
  licence_note text,
  source_file_name text NOT NULL,
  source_sha256 text NOT NULL,
  code_count integer NOT NULL,
  imported_by_name text NOT NULL,
  imported_at timestamp NOT NULL DEFAULT now()
);

-- codes: the rows of one code-system version.
CREATE TABLE IF NOT EXISTS codes (
  id serial PRIMARY KEY,
  code_system_id integer NOT NULL,
  code text NOT NULL,
  display text NOT NULL,
  parent_code text,
  selectable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  effective_from date,
  effective_to date,
  sex_restriction text,
  age_min_years integer,
  age_max_years integer,
  excludes text[] NOT NULL DEFAULT '{}'::text[]
);

-- encounter_procedures: procedures done in a visit, coded or not.
CREATE TABLE IF NOT EXISTS encounter_procedures (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL,
  patient_id text NOT NULL,
  description text NOT NULL,
  code_id integer,
  code_system_kind code_system_kind,
  code text,
  code_display text,
  coding_status code_entry_status NOT NULL DEFAULT 'uncoded',
  performed_on date NOT NULL,
  performed_by_provider_id integer,
  service_id integer,
  sequence integer,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  proposed_by_name text,
  proposed_at timestamp,
  coded_by_name text,
  coded_at timestamp,
  voided_at timestamp,
  voided_by_name text
);

-- encounter_coding: the coding status of one encounter (no row = uncoded).
CREATE TABLE IF NOT EXISTS encounter_coding (
  encounter_id integer PRIMARY KEY,
  patient_id text NOT NULL,
  status encounter_coding_status NOT NULL DEFAULT 'uncoded',
  assigned_to_user_id integer,
  assigned_to_name text,
  assigned_at timestamp,
  coded_at timestamp,
  coded_by_name text,
  finalised_at timestamp,
  finalised_by_name text,
  reopen_count integer NOT NULL DEFAULT 0,
  updated_at timestamp NOT NULL DEFAULT now()
);

-- encounter_coding_events: append-only status history (reopen reasons live here, never in the audit log).
CREATE TABLE IF NOT EXISTS encounter_coding_events (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL,
  action coding_event_action NOT NULL,
  from_status encounter_coding_status NOT NULL,
  to_status encounter_coding_status NOT NULL,
  reason text,
  by_name text NOT NULL,
  by_user_id integer,
  at timestamp NOT NULL DEFAULT now()
);

-- coding_queries: a coder's question to the treating doctor.
CREATE TABLE IF NOT EXISTS coding_queries (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL,
  patient_id text NOT NULL,
  addressed_to_provider_id integer NOT NULL,
  question text NOT NULL,
  status coding_query_status NOT NULL DEFAULT 'open',
  raised_by_name text NOT NULL,
  raised_by_user_id integer,
  raised_at timestamp NOT NULL DEFAULT now(),
  answered_at timestamp,
  closed_at timestamp,
  closed_by_name text
);

-- coding_query_responses: the reply log of a query; cascades with its query.
CREATE TABLE IF NOT EXISTS coding_query_responses (
  id serial PRIMARY KEY,
  query_id integer NOT NULL,
  author_name text NOT NULL,
  author_role role NOT NULL,
  body text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- service_procedure_codes: service catalogue <-> procedure/package code map (version-independent).
CREATE TABLE IF NOT EXISTS service_procedure_codes (
  id serial PRIMARY KEY,
  service_id integer NOT NULL,
  code_system_kind code_system_kind NOT NULL,
  code text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- diagnoses: SP6 columns only. Every one is nullable or defaulted; `code` and `description`
-- (legacy NOT NULL free text) are not altered. An SP6-written diagnosis without a code stores code = ''.
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS encounter_id integer;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS code_id integer;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS code_system_kind code_system_kind;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS code_display text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS diagnosis_type diagnosis_type;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS coding_status code_entry_status NOT NULL DEFAULT 'uncoded';
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS sequence integer;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS proposed_by_name text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS proposed_at timestamp;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS coded_by_name text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS coded_at timestamp;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS voided_at timestamp;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS voided_by_name text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS created_at timestamp;

-- Foreign keys (drizzle's default names; one explicit name on coding_query_responses).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codes_code_system_id_code_systems_id_fk') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_code_system_id_code_systems_id_fk
      FOREIGN KEY (code_system_id) REFERENCES code_systems(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnoses_encounter_id_encounters_id_fk') THEN
    ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnoses_code_id_codes_id_fk') THEN
    ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_code_id_codes_id_fk
      FOREIGN KEY (code_id) REFERENCES codes(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_encounter_id_encounters_id_fk') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_patient_id_patients_id_fk') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_code_id_codes_id_fk') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_code_id_codes_id_fk
      FOREIGN KEY (code_id) REFERENCES codes(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_performed_by_provider_id_providers_id_fk') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_performed_by_provider_id_providers_id_fk
      FOREIGN KEY (performed_by_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_service_id_service_catalog_id_fk') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_service_id_service_catalog_id_fk
      FOREIGN KEY (service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_encounter_id_encounters_id_fk') THEN
    ALTER TABLE encounter_coding ADD CONSTRAINT encounter_coding_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_patient_id_patients_id_fk') THEN
    ALTER TABLE encounter_coding ADD CONSTRAINT encounter_coding_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_assigned_to_user_id_users_id_fk') THEN
    ALTER TABLE encounter_coding ADD CONSTRAINT encounter_coding_assigned_to_user_id_users_id_fk
      FOREIGN KEY (assigned_to_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_events_encounter_id_encounters_id_fk') THEN
    ALTER TABLE encounter_coding_events ADD CONSTRAINT encounter_coding_events_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_events_by_user_id_users_id_fk') THEN
    ALTER TABLE encounter_coding_events ADD CONSTRAINT encounter_coding_events_by_user_id_users_id_fk
      FOREIGN KEY (by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_queries_encounter_id_encounters_id_fk') THEN
    ALTER TABLE coding_queries ADD CONSTRAINT coding_queries_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_queries_patient_id_patients_id_fk') THEN
    ALTER TABLE coding_queries ADD CONSTRAINT coding_queries_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_queries_addressed_to_provider_id_providers_id_fk') THEN
    ALTER TABLE coding_queries ADD CONSTRAINT coding_queries_addressed_to_provider_id_providers_id_fk
      FOREIGN KEY (addressed_to_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_queries_raised_by_user_id_users_id_fk') THEN
    ALTER TABLE coding_queries ADD CONSTRAINT coding_queries_raised_by_user_id_users_id_fk
      FOREIGN KEY (raised_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_query_responses_query_fk') THEN
    ALTER TABLE coding_query_responses ADD CONSTRAINT coding_query_responses_query_fk
      FOREIGN KEY (query_id) REFERENCES coding_queries(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_procedure_codes_service_id_service_catalog_id_fk') THEN
    ALTER TABLE service_procedure_codes ADD CONSTRAINT service_procedure_codes_service_id_service_catalog_id_fk
      FOREIGN KEY (service_id) REFERENCES service_catalog(id);
  END IF;
END $$;

-- Check constraints.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_systems_count_nonneg') THEN
    ALTER TABLE code_systems ADD CONSTRAINT code_systems_count_nonneg CHECK (code_count >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_systems_licence_unless_sample') THEN
    ALTER TABLE code_systems ADD CONSTRAINT code_systems_licence_unless_sample
      CHECK (is_sample OR licence_note IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codes_effective_range') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_effective_range
      CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'codes_age_range') THEN
    ALTER TABLE codes ADD CONSTRAINT codes_age_range
      CHECK ((age_min_years IS NULL OR age_min_years BETWEEN 0 AND 150) AND (age_max_years IS NULL OR age_max_years BETWEEN 0 AND 150) AND (age_min_years IS NULL OR age_max_years IS NULL OR age_min_years <= age_max_years));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnoses_coded_complete') THEN
    ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_coded_complete
      CHECK (coding_status <> 'coded' OR (code_id IS NOT NULL AND encounter_id IS NOT NULL AND diagnosis_type IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnoses_proposed_has_code') THEN
    ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_proposed_has_code
      CHECK (coding_status <> 'proposed' OR code_id IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'diagnoses_code_kind_pair') THEN
    ALTER TABLE diagnoses ADD CONSTRAINT diagnoses_code_kind_pair
      CHECK ((code_id IS NULL) = (code_system_kind IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_code_required') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_code_required
      CHECK (coding_status = 'uncoded' OR (code_id IS NOT NULL AND code IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_code_kind_pair') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_code_kind_pair
      CHECK ((code_id IS NULL) = (code_system_kind IS NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_finalised_stamp') THEN
    ALTER TABLE encounter_coding ADD CONSTRAINT encounter_coding_finalised_stamp
      CHECK (status <> 'finalised' OR finalised_at IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_coding_events_reason_len') THEN
    ALTER TABLE encounter_coding_events ADD CONSTRAINT encounter_coding_events_reason_len
      CHECK (reason IS NULL OR char_length(reason) <= 500);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_queries_question_len') THEN
    ALTER TABLE coding_queries ADD CONSTRAINT coding_queries_question_len
      CHECK (char_length(question) BETWEEN 1 AND 1000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'coding_query_responses_body_len') THEN
    ALTER TABLE coding_query_responses ADD CONSTRAINT coding_query_responses_body_len
      CHECK (char_length(body) BETWEEN 1 AND 2000);
  END IF;
END $$;

-- Indexes (partial ones carry their WHERE).
CREATE UNIQUE INDEX IF NOT EXISTS code_systems_kind_version_unique ON code_systems (kind, version);
CREATE UNIQUE INDEX IF NOT EXISTS code_systems_one_current_per_kind ON code_systems (kind) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS codes_system_code_unique ON codes (code_system_id, code);
CREATE INDEX IF NOT EXISTS codes_code_prefix_idx ON codes (code_system_id, code text_pattern_ops);
-- MIGRATION-ONLY (see header): trigram search over the display text.
CREATE INDEX IF NOT EXISTS codes_display_trgm_idx ON codes USING gin (lower(display) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS diagnoses_encounter_id_idx ON diagnoses (encounter_id);
CREATE UNIQUE INDEX IF NOT EXISTS diagnoses_one_primary_per_encounter ON diagnoses (encounter_id) WHERE diagnosis_type = 'primary' AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS encounter_procedures_encounter_id_idx ON encounter_procedures (encounter_id);
CREATE INDEX IF NOT EXISTS encounter_procedures_patient_id_idx ON encounter_procedures (patient_id);
CREATE INDEX IF NOT EXISTS encounter_coding_status_idx ON encounter_coding (status);
CREATE INDEX IF NOT EXISTS encounter_coding_assignee_idx ON encounter_coding (assigned_to_user_id);
CREATE INDEX IF NOT EXISTS encounter_coding_events_encounter_idx ON encounter_coding_events (encounter_id);
CREATE INDEX IF NOT EXISTS encounter_coding_events_at_idx ON encounter_coding_events (at);
CREATE INDEX IF NOT EXISTS coding_queries_encounter_idx ON coding_queries (encounter_id);
CREATE INDEX IF NOT EXISTS coding_queries_provider_status_idx ON coding_queries (addressed_to_provider_id, status);
CREATE INDEX IF NOT EXISTS coding_query_responses_query_idx ON coding_query_responses (query_id);
CREATE UNIQUE INDEX IF NOT EXISTS service_procedure_codes_unique ON service_procedure_codes (service_id, code_system_kind, code);
CREATE UNIQUE INDEX IF NOT EXISTS service_procedure_codes_one_primary ON service_procedure_codes (service_id) WHERE is_primary;

COMMIT;
