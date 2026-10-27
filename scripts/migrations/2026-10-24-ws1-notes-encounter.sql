-- 2026-10-24 WS1 T5 notes linked to a visit (plan 2026-10-23-doctor-workspace-billing.md).
-- encounter_notes.encounter_id: the visit a note was written in (nullable; legacy notes have none).
-- Signing a note writes a signatures row of type encounter_note (enum value added by
-- 2026-10-24-ws1-0-enum-values.sql). Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE encounter_notes ADD COLUMN IF NOT EXISTS encounter_id integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_notes_encounter_id_encounters_id_fk') THEN
    ALTER TABLE encounter_notes ADD CONSTRAINT encounter_notes_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS encounter_notes_encounter_idx ON encounter_notes (encounter_id);

COMMIT;
