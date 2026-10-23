-- 2026-10-25 WS5 T2: medication batches and the FEFO rule (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md §3, D1/D2).
--   medication_batches              stock per batch: batch no, expiry, MRP, purchase rate, quantity, write-off.
--   medication_dispenses.batch_id   the batch a dispense row drew from (NULL for legacy rows).
-- medication_inventory.quantity_on_hand stays the per-drug total (sum of non-written-off batches).
-- Backfill: one 'OPENING' batch (no expiry) per drug with stock. Its MRP is
-- medications.mrp_per_unit_paise when WS2's column exists at run time, else 0 (dynamic SQL,
-- because the column may be absent). grn_id gets its FK to pharmacy_grns in WS5 T3.
-- Additive and re-runnable: CREATE ... IF NOT EXISTS, DO blocks guarded on pg_constraint,
-- ON CONFLICT (medication_id, batch_no) DO NOTHING.
BEGIN;

CREATE TABLE IF NOT EXISTS medication_batches (
  id serial PRIMARY KEY,
  medication_id integer NOT NULL,
  batch_no text NOT NULL,
  expiry_date date,
  mrp_per_unit_paise integer NOT NULL,
  purchase_rate_paise integer DEFAULT 0 NOT NULL,
  quantity_on_hand integer DEFAULT 0 NOT NULL,
  grn_id integer,
  received_at timestamp DEFAULT now() NOT NULL,
  written_off_at timestamp,
  write_off_reason text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_batches_medication_id_medications_id_fk') THEN
    ALTER TABLE medication_batches ADD CONSTRAINT medication_batches_medication_id_medications_id_fk
      FOREIGN KEY (medication_id) REFERENCES medications(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_batches_medication_batch_unique') THEN
    ALTER TABLE medication_batches ADD CONSTRAINT medication_batches_medication_batch_unique
      UNIQUE (medication_id, batch_no);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_batches_quantity_nonneg') THEN
    ALTER TABLE medication_batches ADD CONSTRAINT medication_batches_quantity_nonneg
      CHECK (quantity_on_hand >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_batches_mrp_nonneg') THEN
    ALTER TABLE medication_batches ADD CONSTRAINT medication_batches_mrp_nonneg
      CHECK (mrp_per_unit_paise >= 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS medication_batches_medication_expiry_idx ON medication_batches USING btree (medication_id, expiry_date);

-- medication_dispenses: the batch a dispense drew from.
ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS batch_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_dispenses_batch_id_medication_batches_id_fk') THEN
    ALTER TABLE medication_dispenses ADD CONSTRAINT medication_dispenses_batch_id_medication_batches_id_fk
      FOREIGN KEY (batch_id) REFERENCES medication_batches(id);
  END IF;
END $$;

-- Backfill: an OPENING batch for every drug with stock.
DO $$
DECLARE
  mrp_expr text := '0';
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'medications' AND column_name = 'mrp_per_unit_paise'
  ) THEN
    mrp_expr := 'COALESCE(m.mrp_per_unit_paise, 0)';
  END IF;
  EXECUTE format(
    'INSERT INTO medication_batches (medication_id, batch_no, expiry_date, mrp_per_unit_paise, quantity_on_hand)
     SELECT inv.medication_id, %L, NULL, %s, inv.quantity_on_hand
     FROM medication_inventory inv JOIN medications m ON m.id = inv.medication_id
     WHERE inv.quantity_on_hand > 0
     ON CONFLICT (medication_id, batch_no) DO NOTHING',
    'OPENING', mrp_expr);
END $$;

COMMIT;
