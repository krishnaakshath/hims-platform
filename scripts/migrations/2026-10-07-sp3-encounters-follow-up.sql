-- 2026-10-07 SP3 encounters, follow-up orders and contact attempts
-- (plan 2026-10-07-sp3-encounters-followup.md Task 2).
-- Additive, idempotent. Safe to re-run. Creates three new tables and eight enum types;
-- alters no existing table (appointments and admissions get no new columns).
-- Requires the SP1 migrations (2026-10-07-sp1-departments.sql, 2026-10-07-sp1-patient-master.sql)
-- to have been applied first. Everything here is also expressible in src/db/schema.ts
-- (there is no exclusion constraint), so a fresh `db:push` creates the same objects.
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp3-encounters-follow-up.sql
BEGIN;

DO $$ BEGIN
  CREATE TYPE encounter_type AS ENUM ('opd', 'ipd', 'lab');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE encounter_visit_type AS ENUM ('new', 'follow_up', 'review', 'emergency');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE encounter_status AS ENUM ('checked_in', 'in_consultation', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE follow_up_status AS ENUM ('planned', 'scheduled', 'completed', 'missed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE follow_up_source AS ENUM ('encounter', 'discharge', 'lab_report', 'manual');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE follow_up_interval_unit AS ENUM ('days', 'weeks', 'months');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE follow_up_contact_channel AS ENUM ('phone', 'sms', 'whatsapp', 'email', 'in_person');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE follow_up_contact_outcome AS ENUM ('reached_booked', 'reached_will_call_back', 'reached_declined', 'no_answer', 'wrong_number', 'message_left');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- encounters: one row per OPD visit / IPD stay, created at check-in. encounter_date is the
-- Asia/Kolkata business date; the OPD token restarts per IST date.
CREATE TABLE IF NOT EXISTS encounters (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  encounter_type encounter_type NOT NULL,
  visit_type encounter_visit_type NOT NULL DEFAULT 'new',
  status encounter_status NOT NULL DEFAULT 'checked_in',
  encounter_date date NOT NULL,
  opd_token integer,
  department_id integer,
  provider_id integer NOT NULL,
  appointment_id integer,
  admission_id integer,
  doctor_assignment_id integer,
  checked_in_by_name text NOT NULL,
  checked_in_at timestamp NOT NULL DEFAULT now(),
  status_changed_at timestamp,
  status_changed_by_name text,
  completed_at timestamp,
  cancel_reason text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_patient_id_patients_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_department_id_departments_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_provider_id_providers_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_provider_id_providers_id_fk
      FOREIGN KEY (provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_appointment_id_appointments_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_appointment_id_appointments_id_fk
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_admission_id_admissions_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_doctor_assignment_id_doctor_assignments_id_fk') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_doctor_assignment_id_doctor_assignments_id_fk
      FOREIGN KEY (doctor_assignment_id) REFERENCES doctor_assignments(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_appointment_id_unique') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_appointment_id_unique UNIQUE (appointment_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_admission_id_unique') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_admission_id_unique UNIQUE (admission_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_doctor_assignment_id_unique') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_doctor_assignment_id_unique UNIQUE (doctor_assignment_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounters_token_positive') THEN
    ALTER TABLE encounters ADD CONSTRAINT encounters_token_positive
      CHECK (opd_token IS NULL OR opd_token > 0);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS encounters_date_token_unique ON encounters (encounter_date, opd_token);
CREATE INDEX IF NOT EXISTS encounters_patient_id_idx ON encounters (patient_id);

-- follow_up_orders: a prescribed return visit. Provenance links are ON DELETE SET NULL.
-- originating_lab_order_id is the SP5 placeholder; SP3 never writes it.
-- Deliberately no "scheduled => appointment_id IS NOT NULL" check: deleting an appointment
-- nulls the link, and deriveFollowUpStatus treats that as planned.
CREATE TABLE IF NOT EXISTS follow_up_orders (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  source follow_up_source NOT NULL,
  status follow_up_status NOT NULL DEFAULT 'planned',
  prescribed_by_provider_id integer NOT NULL,
  department_id integer,
  base_date date NOT NULL,
  due_date date NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  interval_value integer,
  interval_unit follow_up_interval_unit,
  reason text NOT NULL,
  plan_notes text,
  originating_encounter_id integer,
  originating_admission_id integer,
  originating_lab_order_id integer,
  appointment_id integer,
  completed_encounter_id integer,
  created_by_name text NOT NULL,
  created_by_user_id integer,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  plan_updated_at timestamp,
  plan_updated_by_name text,
  scheduled_at timestamp,
  scheduled_by_name text,
  scheduled_by_user_id integer,
  completed_at timestamp,
  cancelled_at timestamp,
  cancelled_by_name text,
  cancel_reason text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_patient_id_patients_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_prescribed_by_provider_id_providers_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_prescribed_by_provider_id_providers_id_fk
      FOREIGN KEY (prescribed_by_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_department_id_departments_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_originating_encounter_id_encounters_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_originating_encounter_id_encounters_id_fk
      FOREIGN KEY (originating_encounter_id) REFERENCES encounters(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_originating_admission_id_admissions_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_originating_admission_id_admissions_id_fk
      FOREIGN KEY (originating_admission_id) REFERENCES admissions(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_originating_lab_order_id_lab_orders_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_originating_lab_order_id_lab_orders_id_fk
      FOREIGN KEY (originating_lab_order_id) REFERENCES lab_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_appointment_id_appointments_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_appointment_id_appointments_id_fk
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_completed_encounter_id_encounters_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_completed_encounter_id_encounters_id_fk
      FOREIGN KEY (completed_encounter_id) REFERENCES encounters(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_created_by_user_id_users_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_created_by_user_id_users_id_fk
      FOREIGN KEY (created_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_scheduled_by_user_id_users_id_fk') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_scheduled_by_user_id_users_id_fk
      FOREIGN KEY (scheduled_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_appointment_id_unique') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_appointment_id_unique UNIQUE (appointment_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_window_order') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_window_order
      CHECK (window_start <= due_date AND due_date <= window_end);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_interval_pair') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_interval_pair
      CHECK ((interval_value IS NULL) = (interval_unit IS NULL) AND (interval_value IS NULL OR interval_value > 0));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_orders_cancel_reason') THEN
    ALTER TABLE follow_up_orders ADD CONSTRAINT follow_up_orders_cancel_reason
      CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS follow_up_orders_patient_id_idx ON follow_up_orders (patient_id);
CREATE INDEX IF NOT EXISTS follow_up_orders_status_window_idx ON follow_up_orders (status, window_end);

-- follow_up_contact_attempts: recall log; cascades with its order. The order FK is named
-- explicitly because drizzle's default name would exceed Postgres's 63-character limit.
CREATE TABLE IF NOT EXISTS follow_up_contact_attempts (
  id serial PRIMARY KEY,
  follow_up_order_id integer NOT NULL,
  channel follow_up_contact_channel NOT NULL,
  outcome follow_up_contact_outcome NOT NULL,
  note text,
  attempted_by_name text NOT NULL,
  attempted_by_user_id integer,
  attempted_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_contact_attempts_attempted_by_user_id_users_id_fk') THEN
    ALTER TABLE follow_up_contact_attempts ADD CONSTRAINT follow_up_contact_attempts_attempted_by_user_id_users_id_fk
      FOREIGN KEY (attempted_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_contact_attempts_order_id_fk') THEN
    ALTER TABLE follow_up_contact_attempts ADD CONSTRAINT follow_up_contact_attempts_order_id_fk
      FOREIGN KEY (follow_up_order_id) REFERENCES follow_up_orders(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_contact_attempts_note_len') THEN
    ALTER TABLE follow_up_contact_attempts ADD CONSTRAINT follow_up_contact_attempts_note_len
      CHECK (note IS NULL OR char_length(note) <= 500);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS follow_up_contact_attempts_order_idx ON follow_up_contact_attempts (follow_up_order_id);

COMMIT;
