-- 2026-10-24 WS1 T10 lab and imaging order fields (plan 2026-10-23-doctor-workspace-billing.md, spec section 4).
-- lab_requisitions.priority: routine | urgent | stat (the worklist shows stat, then urgent, first).
-- lab_requisitions.clinical_notes: the doctor's note to the lab (at most 500 characters).
-- lab_requisitions.fasting_required: the patient must fast before the sample (lane ruling R3).
-- lab_tests.fasting_required: catalog default; an order of such a test defaults to fasting (lane ruling R3).
-- Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS fasting_required boolean NOT NULL DEFAULT false;

ALTER TABLE lab_requisitions ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'routine';
ALTER TABLE lab_requisitions ADD COLUMN IF NOT EXISTS clinical_notes text;
ALTER TABLE lab_requisitions ADD COLUMN IF NOT EXISTS fasting_required boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_priority_valid') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_priority_valid
      CHECK (priority IN ('routine', 'urgent', 'stat'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_requisitions_clinical_notes_length') THEN
    ALTER TABLE lab_requisitions ADD CONSTRAINT lab_requisitions_clinical_notes_length
      CHECK (clinical_notes IS NULL OR char_length(clinical_notes) <= 500);
  END IF;
END $$;

COMMIT;
