-- 2026-10-24 WS2 T9 automatic charges (plan 2026-10-23-doctor-workspace-billing.md, spec ruling 6).
-- charge_lines.lab_order_id / encounter_procedure_id: the order a line bills (one line per order).
-- charge_lines_one_consultation_per_encounter / _one_registration_per_patient: idempotence backstops
--   for the automatic visit charges (capture checks under the patient billing lock first).
-- billing_settings.registration_service_id: the service billed at a patient's first visit (null = none).
-- billing_settings.free_review_days: follow-up/review visits within this many days of the last charged
--   consultation of the department are free (0 = always charge).
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS lab_order_id integer;
ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS encounter_procedure_id integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_lab_order_id_lab_orders_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_lab_order_id_lab_orders_id_fk
      FOREIGN KEY (lab_order_id) REFERENCES lab_orders(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_lab_order_id_unique') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_lab_order_id_unique UNIQUE (lab_order_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_encounter_procedure_id_encounter_procedures_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_encounter_procedure_id_encounter_procedures_id_fk
      FOREIGN KEY (encounter_procedure_id) REFERENCES encounter_procedures(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_encounter_procedure_id_unique') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_encounter_procedure_id_unique UNIQUE (encounter_procedure_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS charge_lines_one_consultation_per_encounter ON charge_lines (encounter_id)
  WHERE source = 'consultation' AND status <> 'void';
CREATE UNIQUE INDEX IF NOT EXISTS charge_lines_one_registration_per_patient ON charge_lines (patient_id)
  WHERE source = 'registration' AND status <> 'void';

ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS registration_service_id integer;
ALTER TABLE billing_settings ADD COLUMN IF NOT EXISTS free_review_days integer NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_registration_service_id_service_catalog_id_fk') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_registration_service_id_service_catalog_id_fk
      FOREIGN KEY (registration_service_id) REFERENCES service_catalog(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_settings_free_review_days_range') THEN
    ALTER TABLE billing_settings ADD CONSTRAINT billing_settings_free_review_days_range
      CHECK (free_review_days BETWEEN 0 AND 30);
  END IF;
END $$;

COMMIT;
