-- 2026-10-24 WS4 T8 lab analytes, age/sex reference ranges and per-analyte result values
-- (plan 2026-10-23-inpatient-lab, spec 3.3 items 17-22 and §4).
-- Cascades (pinned in tests/db/migrate-runner.test.ts):
--   lab_test_analytes -> lab_tests ON DELETE CASCADE: definitions of a test. Lab tests are only
--     deactivated by the app; a test with orders, or an analyte with results, stays NO ACTION-protected.
--   lab_analyte_ranges -> lab_test_analytes ON DELETE CASCADE: part of the definition.
--   lab_result_values -> lab_results / lab_orders ON DELETE CASCADE: detail of the summary result.
--   lab_result_values.analyte_id stays NO ACTION: an analyte with results is deactivated, never deleted.
-- Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS lab_test_analytes (
  id serial PRIMARY KEY,
  lab_test_id integer NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  unit text,
  value_type text DEFAULT 'numeric' NOT NULL,
  decimals integer,
  sort_order integer DEFAULT 0 NOT NULL,
  loinc_code text,
  options jsonb,
  abnormal_options jsonb,
  critical_options jsonb,
  is_active boolean DEFAULT true NOT NULL
);

CREATE TABLE IF NOT EXISTS lab_analyte_ranges (
  id serial PRIMARY KEY,
  analyte_id integer NOT NULL,
  sex text DEFAULT 'any' NOT NULL,
  age_min_days integer DEFAULT 0 NOT NULL,
  age_max_days integer,
  normal_low numeric(14,4),
  normal_high numeric(14,4),
  critical_low numeric(14,4),
  critical_high numeric(14,4),
  display_text text
);

CREATE TABLE IF NOT EXISTS lab_result_values (
  id serial PRIMARY KEY,
  lab_result_id integer NOT NULL,
  lab_order_id integer NOT NULL,
  analyte_id integer NOT NULL,
  value_text text NOT NULL,
  value_numeric numeric(14,4),
  unit text,
  reference_range_text text,
  flag lab_result_flag DEFAULT 'normal' NOT NULL,
  interpretation text,
  flag_source text DEFAULT 'auto' NOT NULL,
  flag_reason text
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_test_analytes_lab_test_id_lab_tests_id_fk') THEN
    ALTER TABLE lab_test_analytes ADD CONSTRAINT lab_test_analytes_lab_test_id_lab_tests_id_fk
      FOREIGN KEY (lab_test_id) REFERENCES lab_tests(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_test_analytes_value_type_valid') THEN
    ALTER TABLE lab_test_analytes ADD CONSTRAINT lab_test_analytes_value_type_valid
      CHECK (value_type IN ('numeric', 'option', 'text'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_test_analytes_decimals_range') THEN
    ALTER TABLE lab_test_analytes ADD CONSTRAINT lab_test_analytes_decimals_range
      CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 4);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analyte_ranges_analyte_id_lab_test_analytes_id_fk') THEN
    ALTER TABLE lab_analyte_ranges ADD CONSTRAINT lab_analyte_ranges_analyte_id_lab_test_analytes_id_fk
      FOREIGN KEY (analyte_id) REFERENCES lab_test_analytes(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analyte_ranges_sex_valid') THEN
    ALTER TABLE lab_analyte_ranges ADD CONSTRAINT lab_analyte_ranges_sex_valid
      CHECK (sex IN ('any', 'male', 'female'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analyte_ranges_age_band') THEN
    ALTER TABLE lab_analyte_ranges ADD CONSTRAINT lab_analyte_ranges_age_band
      CHECK (age_min_days >= 0 AND (age_max_days IS NULL OR age_max_days > age_min_days));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_analyte_ranges_bounds_ordered') THEN
    ALTER TABLE lab_analyte_ranges ADD CONSTRAINT lab_analyte_ranges_bounds_ordered
      CHECK ((critical_low IS NULL OR normal_low IS NULL OR critical_low <= normal_low)
        AND (normal_low IS NULL OR normal_high IS NULL OR normal_low <= normal_high)
        AND (normal_high IS NULL OR critical_high IS NULL OR normal_high <= critical_high)
        AND (critical_low IS NULL OR critical_high IS NULL OR critical_low <= critical_high));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_lab_result_id_lab_results_id_fk') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_lab_result_id_lab_results_id_fk
      FOREIGN KEY (lab_result_id) REFERENCES lab_results(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_lab_order_id_lab_orders_id_fk') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_lab_order_id_lab_orders_id_fk
      FOREIGN KEY (lab_order_id) REFERENCES lab_orders(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_analyte_id_lab_test_analytes_id_fk') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_analyte_id_lab_test_analytes_id_fk
      FOREIGN KEY (analyte_id) REFERENCES lab_test_analytes(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_interpretation_valid') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_interpretation_valid
      CHECK (interpretation IS NULL OR interpretation IN ('N', 'L', 'H', 'LL', 'HH', 'A', 'AA'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_flag_source_valid') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_flag_source_valid
      CHECK (flag_source IN ('auto', 'manual'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_values_flag_reason_length') THEN
    ALTER TABLE lab_result_values ADD CONSTRAINT lab_result_values_flag_reason_length
      CHECK (flag_reason IS NULL OR char_length(flag_reason) <= 500);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lab_test_analytes_test_code_unique ON lab_test_analytes (lab_test_id, code);
CREATE INDEX IF NOT EXISTS lab_analyte_ranges_analyte_idx ON lab_analyte_ranges (analyte_id);
CREATE UNIQUE INDEX IF NOT EXISTS lab_result_values_result_analyte_unique ON lab_result_values (lab_result_id, analyte_id);
CREATE INDEX IF NOT EXISTS lab_result_values_order_idx ON lab_result_values (lab_order_id);
CREATE INDEX IF NOT EXISTS lab_result_values_analyte_idx ON lab_result_values (analyte_id);

COMMIT;
