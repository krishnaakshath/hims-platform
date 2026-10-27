-- 2026-10-24 WS1 T2 vitals and consultation record (plan 2026-10-23-doctor-workspace-billing.md).
-- encounter_vitals is the one vitals table (lane ruling R1: includes pain_score and notes).
-- encounter_consults is one row per encounter. Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS encounter_vitals (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL REFERENCES encounters(id),
  patient_id text NOT NULL REFERENCES patients(id),
  recorded_at timestamp NOT NULL DEFAULT now(),
  recorded_by_name text NOT NULL,
  recorded_by_user_id integer REFERENCES users(id),
  systolic_mmhg integer,
  diastolic_mmhg integer,
  pulse_bpm integer,
  temp_deci_c integer,
  spo2_pct integer,
  resp_rate integer,
  weight_g integer,
  height_mm integer,
  pain_score smallint,
  notes text
);
CREATE INDEX IF NOT EXISTS encounter_vitals_encounter_idx ON encounter_vitals (encounter_id);

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('encounter_vitals_systolic_range', 'systolic_mmhg IS NULL OR systolic_mmhg BETWEEN 50 AND 300'),
    ('encounter_vitals_diastolic_range', 'diastolic_mmhg IS NULL OR diastolic_mmhg BETWEEN 20 AND 200'),
    ('encounter_vitals_pulse_range', 'pulse_bpm IS NULL OR pulse_bpm BETWEEN 20 AND 250'),
    ('encounter_vitals_temp_range', 'temp_deci_c IS NULL OR temp_deci_c BETWEEN 300 AND 450'),
    ('encounter_vitals_spo2_range', 'spo2_pct IS NULL OR spo2_pct BETWEEN 50 AND 100'),
    ('encounter_vitals_resp_range', 'resp_rate IS NULL OR resp_rate BETWEEN 4 AND 80'),
    ('encounter_vitals_weight_range', 'weight_g IS NULL OR weight_g BETWEEN 300 AND 400000'),
    ('encounter_vitals_height_range', 'height_mm IS NULL OR height_mm BETWEEN 300 AND 2500'),
    ('encounter_vitals_pain_range', 'pain_score IS NULL OR pain_score BETWEEN 0 AND 10'),
    ('encounter_vitals_notes_len', 'notes IS NULL OR char_length(notes) <= 300'),
    ('encounter_vitals_bp_order', 'systolic_mmhg IS NULL OR diastolic_mmhg IS NULL OR diastolic_mmhg < systolic_mmhg'),
    ('encounter_vitals_any_measurement', 'num_nonnulls(systolic_mmhg, diastolic_mmhg, pulse_bpm, temp_deci_c, spo2_pct, resp_rate, weight_g, height_mm, pain_score) > 0')
  ) AS t(name, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name AND conrelid = 'encounter_vitals'::regclass) THEN
      EXECUTE format('ALTER TABLE encounter_vitals ADD CONSTRAINT %I CHECK (%s)', c.name, c.expr);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS encounter_consults (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL UNIQUE REFERENCES encounters(id),
  patient_id text NOT NULL REFERENCES patients(id),
  chief_complaint text,
  history_present_illness text,
  past_history text,
  family_history text,
  personal_history text,
  examination text,
  advice text,
  no_diagnosis_reason text,
  updated_at timestamp NOT NULL,
  updated_by_name text NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_consults_text_len' AND conrelid = 'encounter_consults'::regclass) THEN
    ALTER TABLE encounter_consults ADD CONSTRAINT encounter_consults_text_len CHECK (
      coalesce(char_length(chief_complaint), 0) <= 4000 AND coalesce(char_length(history_present_illness), 0) <= 4000
      AND coalesce(char_length(past_history), 0) <= 4000 AND coalesce(char_length(family_history), 0) <= 4000
      AND coalesce(char_length(personal_history), 0) <= 4000 AND coalesce(char_length(examination), 0) <= 4000
      AND coalesce(char_length(advice), 0) <= 4000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_consults_reason_len' AND conrelid = 'encounter_consults'::regclass) THEN
    ALTER TABLE encounter_consults ADD CONSTRAINT encounter_consults_reason_len CHECK (no_diagnosis_reason IS NULL OR char_length(no_diagnosis_reason) <= 300);
  END IF;
END $$;

COMMIT;
