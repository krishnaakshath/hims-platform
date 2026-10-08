-- 2026-10-08 SP5 lab LIS & home collection: tables, columns, constraints and the requisition
-- backfill (plan 2026-10-07-sp5-lab-home-collection.md Task 2).
-- Additive, idempotent. Safe to re-run.
-- MUST run after 2026-10-08-sp5-lab-enum-values.sql has COMMITTED: the check
-- lab_orders_scheduled_has_visit uses the new lab_order_status value 'scheduled', and Postgres
-- forbids using an enum value in the transaction that added it (Ruling 5).
-- Requires SP1 (2026-10-07-sp1-*.sql), SP2 (2026-10-07-sp2-*.sql: service_catalog, tariff_rates)
-- and SP3 (2026-10-07-sp3-encounters-follow-up.sql: encounters, follow_up_orders,
-- follow_up_interval_unit). Everything here is also expressible in src/db/schema.ts, so a fresh
-- `db:push` creates the same objects.
--
-- Local apply (never db:push against a shared DB), in this order:
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-08-sp5-lab-enum-values.sql
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-08-sp5-lab-home-collection.sql
BEGIN;

-- Types

DO $$ BEGIN
  CREATE TYPE lab_sample_type AS ENUM ('blood', 'serum', 'plasma', 'urine', 'stool', 'sputum', 'swab', 'csf', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE lab_sample_container AS ENUM ('edta_lavender', 'plain_red', 'sst_gold', 'fluoride_grey', 'citrate_blue', 'heparin_green', 'urine_container', 'stool_container', 'swab_tube', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE home_collection_status AS ENUM ('booked', 'collected', 'cancelled');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('log', 'sms', 'whatsapp', 'email');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE notification_delivery_status AS ENUM ('logged', 'sent', 'failed', 'suppressed_opt_out', 'skipped_no_contact');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- Lab report number sequence
CREATE SEQUENCE IF NOT EXISTS lab_report_seq START 1 INCREMENT 1;

-- New tables (FKs, uniques and checks are added below, each guarded)
CREATE TABLE IF NOT EXISTS lab_service_area_pins (
  id serial PRIMARY KEY,
  pin_code text NOT NULL,
  area_label text,
  is_active boolean NOT NULL DEFAULT true,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS home_collection_windows (
  id serial PRIMARY KEY,
  label text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  capacity integer NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
-- legacy_lab_order_id is the backfill key only (no FK).
CREATE TABLE IF NOT EXISTS lab_requisitions (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  ordered_by_provider_id integer NOT NULL,
  originating_encounter_id integer,
  follow_up_requested boolean NOT NULL DEFAULT false,
  follow_up_interval_value integer,
  follow_up_interval_unit follow_up_interval_unit,
  follow_up_reason text,
  follow_up_order_id integer,
  follow_up_resolved_at timestamp,
  follow_up_outcome text,
  legacy_lab_order_id integer,
  created_by_name text NOT NULL,
  created_by_user_id integer,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS home_collection_visits (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  visit_date date NOT NULL,
  window_id integer NOT NULL,
  window_label text NOT NULL,
  window_start text NOT NULL,
  window_end text NOT NULL,
  status home_collection_status NOT NULL DEFAULT 'booked',
  address_line1 text NOT NULL,
  address_line2 text,
  city text NOT NULL,
  district text,
  state_code text NOT NULL,
  pin_code text NOT NULL,
  landmark text,
  contact_phone text NOT NULL,
  notes text,
  collector_user_id integer,
  collector_assigned_at timestamp,
  collector_assigned_by_name text,
  booked_by_name text NOT NULL,
  booked_by_user_id integer,
  booked_at timestamp NOT NULL DEFAULT now(),
  reschedule_count integer NOT NULL DEFAULT 0,
  last_reschedule_reason text,
  last_reschedule_note text,
  cancelled_at timestamp,
  cancelled_by_name text,
  cancel_reason text,
  cancel_note text,
  collected_at timestamp,
  collected_by_name text,
  encounter_id integer,
  updated_at timestamp NOT NULL DEFAULT now()
);
-- blob_url is server-side only (Ruling 6).
CREATE TABLE IF NOT EXISTS lab_reports (
  id serial PRIMARY KEY,
  report_number text NOT NULL,
  requisition_id integer NOT NULL,
  patient_id text NOT NULL,
  version integer NOT NULL,
  order_ids jsonb NOT NULL,
  test_summary text NOT NULL,
  blob_url text NOT NULL,
  byte_size integer NOT NULL,
  sha256 text NOT NULL,
  released_by_name text NOT NULL,
  released_by_user_id integer,
  released_at timestamp NOT NULL DEFAULT now(),
  superseded_at timestamp
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  template_key text NOT NULL,
  channel notification_channel NOT NULL,
  status notification_delivery_status NOT NULL,
  destination_masked text,
  related_type text,
  related_id integer,
  dedupe_key text,
  error_code text,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- New columns on existing tables (all nullable or defaulted)
ALTER TABLE patients ADD COLUMN IF NOT EXISTS notification_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS notification_opt_out_at timestamp;

ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS sample_type lab_sample_type;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS container lab_sample_container;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS service_id integer;

ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS resulted_by_user_id integer;
ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS amended_at timestamp;

-- requisition_id stays nullable at DB level (Ruling 7); the backfill below fills legacy rows.
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS requisition_id integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS home_collection_visit_id integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS sample_id text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS sample_date date;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS sample_seq integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS collected_by_name text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS received_at timestamp;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS received_by_name text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS verified_at timestamp;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS verified_by_name text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS verified_by_user_id integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS reported_at timestamp;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS cancelled_at timestamp;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS cancelled_by_name text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS cancel_reason text;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quoted_price_paise integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quoted_tariff_rate_id integer;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quoted_on date;
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS quote_status text NOT NULL DEFAULT 'unmapped';
ALTER TABLE lab_orders ADD COLUMN IF NOT EXISTS status_changed_at timestamp;

-- Foreign keys (drizzle's names; ON DELETE as in schema.ts)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_tests_service_id_service_catalog_id_fk') THEN
    ALTER TABLE lab_tests ADD CONSTRAINT lab_tests_service_id_service_catalog_id_fk
      FOREIGN KEY (service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_results_resulted_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_results ADD CONSTRAINT lab_results_resulted_by_user_id_users_id_fk
      FOREIGN KEY (resulted_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_patient_id_patients_id_fk') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_ordered_by_provider_id_providers_id_fk') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_ordered_by_provider_id_providers_id_fk
      FOREIGN KEY (ordered_by_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_originating_encounter_id_encounters_id_fk') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_originating_encounter_id_encounters_id_fk
      FOREIGN KEY (originating_encounter_id) REFERENCES encounters(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_follow_up_order_id_follow_up_orders_id_fk') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_follow_up_order_id_follow_up_orders_id_fk
      FOREIGN KEY (follow_up_order_id) REFERENCES follow_up_orders(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_created_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_created_by_user_id_users_id_fk
      FOREIGN KEY (created_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_patient_id_patients_id_fk') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_window_id_home_collection_windows_id_fk') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_window_id_home_collection_windows_id_fk
      FOREIGN KEY (window_id) REFERENCES home_collection_windows(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_collector_user_id_users_id_fk') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_collector_user_id_users_id_fk
      FOREIGN KEY (collector_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_booked_by_user_id_users_id_fk') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_booked_by_user_id_users_id_fk
      FOREIGN KEY (booked_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_encounter_id_encounters_id_fk') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_reports_requisition_id_lab_requisitions_id_fk') THEN
    ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_requisition_id_lab_requisitions_id_fk
      FOREIGN KEY (requisition_id) REFERENCES lab_requisitions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_reports_patient_id_patients_id_fk') THEN
    ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_reports_released_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_released_by_user_id_users_id_fk
      FOREIGN KEY (released_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_patient_id_patients_id_fk') THEN
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_requisition_id_lab_requisitions_id_fk') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_requisition_id_lab_requisitions_id_fk
      FOREIGN KEY (requisition_id) REFERENCES lab_requisitions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_verified_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_verified_by_user_id_users_id_fk
      FOREIGN KEY (verified_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_quoted_tariff_rate_id_tariff_rates_id_fk') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_quoted_tariff_rate_id_tariff_rates_id_fk
      FOREIGN KEY (quoted_tariff_rate_id) REFERENCES tariff_rates(id);
  END IF;
END $$;
-- Named explicitly: drizzle's default (lab_orders_home_collection_visit_id_home_collection_visits_id_fk) is 64 chars.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_visit_id_fk') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_visit_id_fk
      FOREIGN KEY (home_collection_visit_id) REFERENCES home_collection_visits(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Unique constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_service_area_pins_pin_code_unique') THEN
    ALTER TABLE lab_service_area_pins ADD CONSTRAINT lab_service_area_pins_pin_code_unique UNIQUE (pin_code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_legacy_lab_order_id_unique') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_legacy_lab_order_id_unique UNIQUE (legacy_lab_order_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_reports_report_number_unique') THEN
    ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_report_number_unique UNIQUE (report_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_deliveries_dedupe_key_unique') THEN
    ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_dedupe_key_unique UNIQUE (dedupe_key);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_sample_id_unique') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_sample_id_unique UNIQUE (sample_id);
  END IF;
END $$;

-- Check constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_service_area_pins_pin_format') THEN
    ALTER TABLE lab_service_area_pins ADD CONSTRAINT lab_service_area_pins_pin_format
      CHECK (pin_code ~ '^[1-9][0-9]{5}$');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_windows_time_format') THEN
    ALTER TABLE home_collection_windows ADD CONSTRAINT home_collection_windows_time_format
      CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_windows_time_order') THEN
    ALTER TABLE home_collection_windows ADD CONSTRAINT home_collection_windows_time_order
      CHECK (start_time < end_time);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_windows_capacity_range') THEN
    ALTER TABLE home_collection_windows ADD CONSTRAINT home_collection_windows_capacity_range
      CHECK (capacity BETWEEN 1 AND 50);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_follow_up_fields') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_follow_up_fields
      CHECK ((NOT follow_up_requested AND follow_up_interval_value IS NULL AND follow_up_interval_unit IS NULL) OR (follow_up_requested AND follow_up_interval_value BETWEEN 1 AND 365 AND follow_up_interval_unit IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_pin_format') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_pin_format
      CHECK (pin_code ~ '^[1-9][0-9]{5}$');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_cancel_reason') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_cancel_reason
      CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_collected_at') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_collected_at
      CHECK (status <> 'collected' OR collected_at IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_reports_version_positive') THEN
    ALTER TABLE lab_reports ADD CONSTRAINT lab_reports_version_positive
      CHECK (version > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_quoted_price_range') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_quoted_price_range
      CHECK (quoted_price_paise IS NULL OR quoted_price_paise BETWEEN 0 AND 1000000000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_sample_pair') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_sample_pair
      CHECK ((sample_id IS NULL) = (sample_date IS NULL) AND (sample_id IS NULL) = (sample_seq IS NULL));
  END IF;
END $$;
-- Uses the new enum value 'scheduled': this is why this file runs after the enum-values file has committed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_orders_scheduled_has_visit') THEN
    ALTER TABLE lab_orders ADD CONSTRAINT lab_orders_scheduled_has_visit
      CHECK (status <> 'scheduled' OR home_collection_visit_id IS NOT NULL);
  END IF;
END $$;

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS lab_orders_sample_date_seq_unique ON lab_orders (sample_date, sample_seq);
CREATE INDEX IF NOT EXISTS lab_orders_requisition_idx ON lab_orders (requisition_id);
CREATE INDEX IF NOT EXISTS lab_orders_visit_idx ON lab_orders (home_collection_visit_id);
CREATE INDEX IF NOT EXISTS lab_orders_status_idx ON lab_orders (status);
CREATE INDEX IF NOT EXISTS lab_requisitions_patient_idx ON lab_requisitions (patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS home_collection_visits_patient_slot_unique ON home_collection_visits (patient_id, visit_date, window_id) WHERE status = 'booked';
CREATE INDEX IF NOT EXISTS home_collection_visits_date_window_idx ON home_collection_visits (visit_date, window_id);
CREATE INDEX IF NOT EXISTS home_collection_visits_collector_date_idx ON home_collection_visits (collector_user_id, visit_date);
CREATE UNIQUE INDEX IF NOT EXISTS lab_reports_requisition_version_unique ON lab_reports (requisition_id, version);
CREATE INDEX IF NOT EXISTS lab_reports_patient_idx ON lab_reports (patient_id);
CREATE INDEX IF NOT EXISTS notification_deliveries_patient_idx ON notification_deliveries (patient_id);
CREATE INDEX IF NOT EXISTS notification_deliveries_related_idx ON notification_deliveries (related_type, related_id);

-- Backfill: one requisition per legacy order (Ruling 7). Idempotent via legacy_lab_order_id.
INSERT INTO lab_requisitions (patient_id, ordered_by_provider_id, created_by_name, created_at, legacy_lab_order_id)
  SELECT o.patient_id, o.ordered_by_provider_id, 'migration', o.ordered_at, o.id FROM lab_orders o
  WHERE o.requisition_id IS NULL ON CONFLICT (legacy_lab_order_id) DO NOTHING;
UPDATE lab_orders o SET requisition_id = r.id FROM lab_requisitions r WHERE r.legacy_lab_order_id = o.id AND o.requisition_id IS NULL;

COMMIT;
