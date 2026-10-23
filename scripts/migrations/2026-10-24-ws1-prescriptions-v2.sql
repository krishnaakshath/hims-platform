-- 2026-10-24 WS1 T6 prescriptions v2 (plan 2026-10-23-doctor-workspace-billing.md, spec ruling 8).
-- prescriptions: a header grouping the drugs written together on one visit (advice, encounter,
-- prescriber). Each drug stays a medication_episodes row, which gains the header link, the Indian
-- dose pattern ('1-0-1'), route, food timing, SOS, the prescribed quantity and an allergy override
-- reason. Legacy rows keep every new column null (is_sos false).
-- Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS prescriptions (
  id serial PRIMARY KEY,
  patient_id text NOT NULL REFERENCES patients(id),
  encounter_id integer REFERENCES encounters(id),
  prescribed_by_provider_id integer NOT NULL REFERENCES providers(id),
  advice text,
  entered_by_name text NOT NULL,
  entered_by_user_id integer REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prescriptions_patient_idx ON prescriptions (patient_id);
CREATE INDEX IF NOT EXISTS prescriptions_encounter_idx ON prescriptions (encounter_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prescriptions_advice_len') THEN
    ALTER TABLE prescriptions ADD CONSTRAINT prescriptions_advice_len
      CHECK (advice IS NULL OR char_length(advice) <= 1000);
  END IF;
END $$;

ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS prescription_id integer REFERENCES prescriptions(id);
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS dose_pattern text;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS route text;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS food_timing text;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS is_sos boolean NOT NULL DEFAULT false;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS quantity_prescribed integer;
ALTER TABLE medication_episodes ADD COLUMN IF NOT EXISTS allergy_override_reason text;
CREATE INDEX IF NOT EXISTS medication_episodes_prescription_idx ON medication_episodes (prescription_id);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_episodes_route_valid') THEN
    ALTER TABLE medication_episodes ADD CONSTRAINT medication_episodes_route_valid
      CHECK (route IS NULL OR route IN ('oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'sublingual', 'rectal', 'vaginal', 'eye', 'ear', 'nasal', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_episodes_food_timing_valid') THEN
    ALTER TABLE medication_episodes ADD CONSTRAINT medication_episodes_food_timing_valid
      CHECK (food_timing IS NULL OR food_timing IN ('before_food', 'after_food', 'with_food', 'any'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_episodes_quantity_prescribed_positive') THEN
    ALTER TABLE medication_episodes ADD CONSTRAINT medication_episodes_quantity_prescribed_positive
      CHECK (quantity_prescribed IS NULL OR quantity_prescribed > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_episodes_allergy_override_reason_len') THEN
    ALTER TABLE medication_episodes ADD CONSTRAINT medication_episodes_allergy_override_reason_len
      CHECK (allergy_override_reason IS NULL OR char_length(allergy_override_reason) BETWEEN 5 AND 300);
  END IF;
END $$;

COMMIT;
