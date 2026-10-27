-- 2026-10-25 WS5 T3: goods received notes (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md §3).
--   document_series 'grn'          GRN/<FY>/<6 digits>, drawn from document_counters like invoices.
--   pharmacy_grns                  one row per supplier delivery: number, supplier, invoice, receiver, total, line count.
--   medication_batches.grn_id      FK to pharmacy_grns (the column was created by WS5 T2).
-- ADD VALUE inside BEGIN … COMMIT is valid on PG 12+ (as in 2026-10-24-ws12-preauth-refresh-enum.sql);
-- nothing in this file uses the new value, which Postgres forbids in the transaction that added it.
-- The value is appended, so the order equals documentSeriesEnum in src/db/schema.ts.
-- Additive and re-runnable: IF NOT EXISTS, DO blocks guarded on pg_constraint.
BEGIN;

ALTER TYPE document_series ADD VALUE IF NOT EXISTS 'grn';

CREATE TABLE IF NOT EXISTS pharmacy_grns (
  id serial PRIMARY KEY,
  grn_number text NOT NULL,
  supplier_name text NOT NULL,
  supplier_invoice_no text NOT NULL,
  supplier_invoice_date date NOT NULL,
  received_by_name text NOT NULL,
  received_at timestamp DEFAULT now() NOT NULL,
  total_paise bigint NOT NULL,
  line_count integer NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_grns_grn_number_unique') THEN
    ALTER TABLE pharmacy_grns ADD CONSTRAINT pharmacy_grns_grn_number_unique UNIQUE (grn_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_grns_total_nonneg') THEN
    ALTER TABLE pharmacy_grns ADD CONSTRAINT pharmacy_grns_total_nonneg CHECK (total_paise >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_grns_line_count_positive') THEN
    ALTER TABLE pharmacy_grns ADD CONSTRAINT pharmacy_grns_line_count_positive CHECK (line_count > 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS pharmacy_grns_received_at_idx ON pharmacy_grns USING btree (received_at);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_batches_grn_id_pharmacy_grns_id_fk') THEN
    ALTER TABLE medication_batches ADD CONSTRAINT medication_batches_grn_id_pharmacy_grns_id_fk
      FOREIGN KEY (grn_id) REFERENCES pharmacy_grns(id);
  END IF;
END $$;

COMMIT;
