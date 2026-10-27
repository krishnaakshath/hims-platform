-- 2026-10-24 WS2 T11 procedure orders from the doctor workspace (plan 2026-10-23-doctor-workspace-billing.md, spec ruling 6).
-- encounter_procedures.order_notes: the ordering doctor's note on the procedure (at most 300 characters).
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE encounter_procedures ADD COLUMN IF NOT EXISTS order_notes text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_procedures_order_notes_length') THEN
    ALTER TABLE encounter_procedures ADD CONSTRAINT encounter_procedures_order_notes_length
      CHECK (order_notes IS NULL OR char_length(order_notes) <= 300);
  END IF;
END $$;

COMMIT;
