-- 2026-10-24 WS1 T4 diagnoses problem list flag and referrals (plan 2026-10-23-doctor-workspace-billing.md).
-- diagnoses.on_problem_list marks a diagnosis for the patient's problem list. referrals are written
-- from the consultation workspace. Additive, idempotent, safe to re-run.
BEGIN;

ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS on_problem_list boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS referrals (
  id serial PRIMARY KEY,
  encounter_id integer NOT NULL REFERENCES encounters(id),
  patient_id text NOT NULL REFERENCES patients(id),
  kind text NOT NULL,
  to_department_id integer REFERENCES departments(id),
  to_provider_id integer REFERENCES providers(id),
  external_facility text,
  external_doctor text,
  reason text NOT NULL,
  urgency text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_by_name text NOT NULL,
  created_by_user_id integer REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referrals_encounter_idx ON referrals (encounter_id);
CREATE INDEX IF NOT EXISTS referrals_to_provider_open_idx ON referrals (to_provider_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS referrals_to_department_open_idx ON referrals (to_department_id) WHERE status = 'open';

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('referrals_kind_valid', 'kind IN (''internal'', ''external'')'),
    ('referrals_urgency_valid', 'urgency IN (''routine'', ''urgent'', ''emergency'')'),
    ('referrals_status_valid', 'status IN (''open'', ''seen'', ''closed'')'),
    ('referrals_target', '(kind = ''internal'' AND (to_department_id IS NOT NULL OR to_provider_id IS NOT NULL)) OR (kind = ''external'' AND external_facility IS NOT NULL)'),
    ('referrals_text_len', 'char_length(reason) <= 1000 AND coalesce(char_length(external_facility), 0) <= 200 AND coalesce(char_length(external_doctor), 0) <= 120')
  ) AS t(name, expr)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.name AND conrelid = 'referrals'::regclass) THEN
      EXECUTE format('ALTER TABLE referrals ADD CONSTRAINT %I CHECK (%s)', c.name, c.expr);
    END IF;
  END LOOP;
END $$;

COMMIT;
