-- 2026-10-24 WS12 T5: abha_link_overrides (spec R9, §4). A row records an ABHA linked to a chart
-- despite an identity mismatch (name, date of birth or gender): which fields differed, the staff
-- member's reason (10-300 characters), who and when. via = 'abha_flow' (an ABDM create/verify
-- flow) or 'scan_and_share' (then share_id names the profile share).
-- MIGRATION-ONLY OBJECT: the function and trigger ws12_abha_link_overrides_append_only make the
-- table append-only (no UPDATE or DELETE; SQLSTATE 55000), bypassed only by a transaction that
-- first runs select set_config('hims.allow_document_purge', 'on', true), as sp7_append_only().
-- Additive, idempotent, safe to re-run. Requires patients, users and abdm_profile_shares
-- (2026-10-10-sp8-abdm-nhcx.sql).
BEGIN;
CREATE TABLE IF NOT EXISTS abha_link_overrides (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  via text NOT NULL,
  share_id integer,
  fields jsonb NOT NULL,
  reason text NOT NULL,
  by_name text NOT NULL,
  by_user_id integer,
  at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT abha_link_overrides_patient_id_patients_id_fk FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT abha_link_overrides_share_id_abdm_profile_shares_id_fk FOREIGN KEY (share_id) REFERENCES abdm_profile_shares(id),
  CONSTRAINT abha_link_overrides_by_user_id_users_id_fk FOREIGN KEY (by_user_id) REFERENCES users(id),
  CONSTRAINT abha_link_overrides_via_valid CHECK (via IN ('abha_flow', 'scan_and_share')),
  CONSTRAINT abha_link_overrides_share_via CHECK ((via = 'scan_and_share') = (share_id IS NOT NULL)),
  CONSTRAINT abha_link_overrides_fields_valid CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) > 0 AND fields <@ '["name", "dob", "gender"]'::jsonb),
  CONSTRAINT abha_link_overrides_reason_length CHECK (char_length(reason) BETWEEN 10 AND 300)
);
CREATE INDEX IF NOT EXISTS abha_link_overrides_patient_idx ON abha_link_overrides (patient_id, at);

CREATE OR REPLACE FUNCTION ws12_abha_link_overrides_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'ABHA link overrides are append-only' USING ERRCODE = '55000';
END;
$fn$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ws12_abha_link_overrides_append_only' AND tgrelid = 'abha_link_overrides'::regclass) THEN
    CREATE TRIGGER ws12_abha_link_overrides_append_only BEFORE UPDATE OR DELETE ON abha_link_overrides
      FOR EACH ROW EXECUTE FUNCTION ws12_abha_link_overrides_append_only();
  END IF;
END $$;
COMMIT;
