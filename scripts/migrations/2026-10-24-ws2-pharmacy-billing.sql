-- 2026-10-24 WS2 T8 pharmacy billing (plan 2026-10-23-doctor-workspace-billing.md, spec ruling 7).
-- medications: a GST-inclusive MRP per dispensing unit (null = unpriced: cannot be dispensed with a
-- charge), an optional GST slab and HSN (null = billing_settings.pharmacy_gst_rate_bp / pharmacy_hsn).
-- medication_dispenses: batch and expiry month as snapshot text (stock by batch is WS5), the reason
-- for a free dispense, and the MRP in force when it was dispensed.
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE medications ADD COLUMN IF NOT EXISTS mrp_per_unit_paise integer;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS gst_rate_bp integer;
ALTER TABLE medications ADD COLUMN IF NOT EXISTS hsn text;

ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS batch_no text;
ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS expiry_month text;
ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS no_charge_reason text;
ALTER TABLE medication_dispenses ADD COLUMN IF NOT EXISTS unit_mrp_paise integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medications_mrp_range') THEN
    ALTER TABLE medications ADD CONSTRAINT medications_mrp_range
      CHECK (mrp_per_unit_paise IS NULL OR mrp_per_unit_paise BETWEEN 0 AND 1000000000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medications_gst_rate_allowed') THEN
    ALTER TABLE medications ADD CONSTRAINT medications_gst_rate_allowed
      CHECK (gst_rate_bp IS NULL OR gst_rate_bp IN (0, 500, 1200, 1800, 2800, 4000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'medication_dispenses_expiry_month_format') THEN
    ALTER TABLE medication_dispenses ADD CONSTRAINT medication_dispenses_expiry_month_format
      CHECK (expiry_month IS NULL OR expiry_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

COMMIT;
