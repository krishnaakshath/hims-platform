-- 2026-10-26 WS7 T3: the language a patient filled an intake form in, so the
-- signed copy is shown in that language (spec D9/D10). Null = not recorded
-- (submissions before this column, or never saved by the patient): English.
-- Additive and re-runnable: ADD COLUMN IF NOT EXISTS and a guarded constraint.
BEGIN;

ALTER TABLE form_submissions ADD COLUMN IF NOT EXISTS language text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_submissions_language_valid') THEN
    ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_language_valid
      CHECK (language IS NULL OR language IN ('en', 'hi', 'kn'));
  END IF;
END $$;

COMMIT;
