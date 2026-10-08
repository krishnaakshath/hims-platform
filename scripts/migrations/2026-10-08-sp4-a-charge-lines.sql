-- 2026-10-08 SP4 migration A: billing settings, rule configuration and charge lines
-- (plan 2026-10-07-sp4-charge-capture.md Task 4).
-- Additive, idempotent. Safe to re-run. Requires the SP1, SP2 and SP3 migrations
-- (2026-10-07-sp1-*.sql, 2026-10-07-sp2-*.sql, 2026-10-07-sp3-encounters-follow-up.sql).
-- Creates two enum types and three tables (billing_settings, charge_rule_configs, charge_lines),
-- adds nullable/defaulted billing flags to payers and service_catalog, and inserts the
-- billing_settings singleton row. Everything here is also expressible in src/db/schema.ts.
--
-- Money: unit prices and configured amounts are int4 paise (cap 1,000,000,000 = MAX_AMOUNT_PAISE);
-- the computed charge_lines.taxable_paise is bigint.
-- No FK here has an ON DELETE action: deletePatient() clears a patient's charge lines explicitly.
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-08-sp4-a-charge-lines.sql
BEGIN;

DO $$ BEGIN
  CREATE TYPE charge_line_source AS ENUM ('manual', 'room_rent', 'pharmacy');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE charge_line_status AS ENUM ('captured', 'invoiced', 'void');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- payers: pre-authorisation flag, GSTIN and state (IN-xx) for the recipient-state place of supply.
ALTER TABLE payers ADD COLUMN IF NOT EXISTS requires_preauth boolean NOT NULL DEFAULT false;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS gstin text;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS state_code text;

-- service_catalog: pre-authorisation flag and an optional per-line quantity cap.
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS requires_preauth boolean NOT NULL DEFAULT false;
ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS max_quantity integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_max_quantity_range') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_max_quantity_range
      CHECK (max_quantity IS NULL OR max_quantity BETWEEN 1 AND 1000);
  END IF;
END $$;

-- billing_settings: singleton (id = 1). The seed never clears it.
CREATE TABLE IF NOT EXISTS billing_settings (
  id integer PRIMARY KEY DEFAULT 1,
  legal_name text,
  gstin text,
  state_code text,
  address text,
  place_of_supply_mode text NOT NULL DEFAULT 'location_of_service',
  consultation_window_days integer NOT NULL DEFAULT 30,
  ipd_deposit_threshold_paise integer NOT NULL DEFAULT 0,
  room_rent_service_id integer,
  pharmacy_gst_rate_bp integer NOT NULL DEFAULT 500,
  pharmacy_hsn text NOT NULL DEFAULT '3004',
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_name text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_singleton') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_singleton
      CHECK (id = 1);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_consultation_window_range') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_consultation_window_range
      CHECK (consultation_window_days BETWEEN 1 AND 365);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_deposit_threshold_range') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_deposit_threshold_range
      CHECK (ipd_deposit_threshold_paise BETWEEN 0 AND 1000000000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_pharmacy_gst_allowed') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_pharmacy_gst_allowed
      CHECK (pharmacy_gst_rate_bp IN (0, 500, 1200, 1800, 2800, 4000));
  END IF;
END $$;

-- charge_rule_configs: admin overrides of the rule table (missing row = table defaults).
CREATE TABLE IF NOT EXISTS charge_rule_configs (
  rule_code text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  severity text,
  updated_at timestamp NOT NULL DEFAULT now(),
  updated_by_name text NOT NULL
);

-- charge_lines: one captured charge against an OPD encounter or IPD admission (pharmacy lines
-- may have neither). Item, category, HSN/SAC and GST rate are snapshots taken at capture.
CREATE TABLE IF NOT EXISTS charge_lines (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  encounter_id integer,
  admission_id integer,
  source charge_line_source NOT NULL,
  status charge_line_status NOT NULL DEFAULT 'captured',
  service_id integer,
  item_code text NOT NULL,
  item_name text NOT NULL,
  service_category service_category,
  department_id integer,
  ordering_provider_id integer,
  performing_provider_id integer,
  service_date date NOT NULL,
  quantity integer NOT NULL,
  unit_price_paise integer NOT NULL,
  price_source text NOT NULL,
  tariff_rate_id integer,
  resolved_price_paise integer,
  price_override_reason text,
  taxable_paise bigint NOT NULL,
  gst_rate_bp integer NOT NULL,
  hsn_sac text NOT NULL,
  payer_id integer,
  pre_auth_reference text,
  procedure_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  rule_overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
  legacy_charge_id integer,
  medication_dispense_id integer,
  void_reason text,
  voided_at timestamp,
  voided_by_name text,
  created_by_name text NOT NULL,
  created_by_user_id integer,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_room_rent_service_id_service_catalog_id_fk') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_room_rent_service_id_service_catalog_id_fk
      FOREIGN KEY (room_rent_service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_patient_id_patients_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_encounter_id_encounters_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_admission_id_admissions_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_service_id_service_catalog_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_service_id_service_catalog_id_fk
      FOREIGN KEY (service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_department_id_departments_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_ordering_provider_id_providers_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_ordering_provider_id_providers_id_fk
      FOREIGN KEY (ordering_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_performing_provider_id_providers_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_performing_provider_id_providers_id_fk
      FOREIGN KEY (performing_provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_tariff_rate_id_tariff_rates_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_tariff_rate_id_tariff_rates_id_fk
      FOREIGN KEY (tariff_rate_id) REFERENCES tariff_rates(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_payer_id_payers_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_legacy_charge_id_charges_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_legacy_charge_id_charges_id_fk
      FOREIGN KEY (legacy_charge_id) REFERENCES charges(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_medication_dispense_id_medication_dispenses_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_medication_dispense_id_medication_dispenses_id_fk
      FOREIGN KEY (medication_dispense_id) REFERENCES medication_dispenses(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_created_by_user_id_users_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_created_by_user_id_users_id_fk
      FOREIGN KEY (created_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_legacy_charge_id_unique') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_legacy_charge_id_unique UNIQUE (legacy_charge_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_medication_dispense_id_unique') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_medication_dispense_id_unique UNIQUE (medication_dispense_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_quantity_range') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_quantity_range
      CHECK (quantity BETWEEN 1 AND 1000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_unit_price_range') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_unit_price_range
      CHECK (unit_price_paise BETWEEN 0 AND 1000000000);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_taxable_nonneg') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_taxable_nonneg
      CHECK (taxable_paise >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_gst_rate_allowed') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_gst_rate_allowed
      CHECK (gst_rate_bp IN (0, 500, 1200, 1800, 2800, 4000));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_service_required') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_service_required
      CHECK (source = 'pharmacy' OR service_id IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_context_required') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_context_required
      CHECK (source = 'pharmacy' OR encounter_id IS NOT NULL OR admission_id IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_manual_reason') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_manual_reason
      CHECK (price_source <> 'manual' OR price_override_reason IS NOT NULL);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_void_reason') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_void_reason
      CHECK (status <> 'void' OR void_reason IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS charge_lines_patient_idx ON charge_lines (patient_id);
CREATE INDEX IF NOT EXISTS charge_lines_encounter_idx ON charge_lines (encounter_id);
CREATE INDEX IF NOT EXISTS charge_lines_admission_idx ON charge_lines (admission_id);
-- Room rent is posted idempotently: one live line per admission per census day.
CREATE UNIQUE INDEX IF NOT EXISTS charge_lines_room_rent_day_unique ON charge_lines (admission_id, service_date)
  WHERE source = 'room_rent' AND status <> 'void';

INSERT INTO billing_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
