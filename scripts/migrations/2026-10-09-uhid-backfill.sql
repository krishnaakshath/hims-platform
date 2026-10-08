-- 2026-10-09 Wave D: one-off UHID backfill for patients registered before SP1 (audit P0-05).
-- Gives every patient whose uhid IS NULL a UHID in exactly the app's format
-- (src/lib/uhid.ts formatUhid): app_settings.uhid_prefix + the next uhid_seq value
-- zero-padded to 8 digits + a Verhoeff check digit over those 8 digits.
-- Idempotent: only rows with no UHID are touched, so a second run changes nothing.
-- Never rewrites an issued UHID. Before numbering, the sequence is moved past the highest
-- number already issued under the current prefix, and any number that is somehow taken is
-- skipped, so a backfilled UHID can never collide with an existing one.
-- Requires 2026-10-07-sp1-patient-master.sql (patients.uhid, uhid_seq, app_settings.uhid_prefix).
-- Apply: node --env-file=.env.local scripts/apply-sql.mjs scripts/migrations/2026-10-09-uhid-backfill.sql
BEGIN;

CREATE SEQUENCE IF NOT EXISTS uhid_seq START 1 INCREMENT 1;

DO $$
DECLARE
  -- Verhoeff tables (dihedral group D5), identical to src/lib/india/verhoeff.ts.
  vd int[] := '{{0,1,2,3,4,5,6,7,8,9},{1,2,3,4,0,6,7,8,9,5},{2,3,4,0,1,7,8,9,5,6},{3,4,0,1,2,8,9,5,6,7},{4,0,1,2,3,9,5,6,7,8},{5,9,8,7,6,0,4,3,2,1},{6,5,9,8,7,1,0,4,3,2},{7,6,5,9,8,2,1,0,4,3},{8,7,6,5,9,3,2,1,0,4},{9,8,7,6,5,4,3,2,1,0}}';
  vp int[] := '{{0,1,2,3,4,5,6,7,8,9},{1,5,7,6,2,8,3,0,9,4},{5,8,0,3,7,9,6,1,4,2},{8,9,1,6,0,4,3,5,2,7},{9,4,5,3,1,2,6,8,7,0},{4,2,8,6,5,7,3,9,0,1},{2,7,9,3,8,0,6,4,1,5},{7,0,4,6,9,1,3,2,5,8}}';
  vinv int[] := '{0,4,3,2,1,5,6,7,8,9}';
  uhid_prefix text;
  max_issued bigint;
  seq_last bigint;
  seq_called boolean;
  seqv bigint;
  digits text;
  rev text;
  c int;
  i int;
  candidate text;
  r record;
BEGIN
  SELECT coalesce((SELECT s.uhid_prefix FROM app_settings s ORDER BY s.id LIMIT 1), 'UH') INTO uhid_prefix;
  IF uhid_prefix !~ '^[A-Z][A-Z0-9]{0,5}$' THEN
    RAISE EXCEPTION 'app_settings.uhid_prefix is not a valid UHID prefix';
  END IF;

  -- Move the sequence past the highest number already issued under this prefix.
  SELECT max(substring(p.uhid FROM length(uhid_prefix) + 1 FOR 8)::bigint) INTO max_issued
    FROM patients p WHERE p.uhid ~ ('^' || uhid_prefix || '[0-9]{9}$');
  SELECT s.last_value, s.is_called INTO seq_last, seq_called FROM uhid_seq s;
  IF max_issued IS NOT NULL AND (max_issued > seq_last OR (max_issued = seq_last AND NOT seq_called)) THEN
    PERFORM setval('uhid_seq', max_issued, true);
  END IF;

  FOR r IN SELECT p.id FROM patients p WHERE p.uhid IS NULL ORDER BY p.date_added, p.id FOR UPDATE LOOP
    LOOP
      seqv := nextval('uhid_seq');
      IF seqv > 99999999 THEN
        RAISE EXCEPTION 'uhid_seq is exhausted for 8-digit UHIDs';
      END IF;
      digits := lpad(seqv::text, 8, '0');
      rev := reverse(digits);
      c := 0;
      FOR i IN 1..length(rev) LOOP
        c := vd[c + 1][vp[(i % 8) + 1][substr(rev, i, 1)::int + 1] + 1];
      END LOOP;
      candidate := uhid_prefix || digits || vinv[c + 1]::text;
      EXIT WHEN NOT EXISTS (SELECT 1 FROM patients p2 WHERE p2.uhid = candidate);
    END LOOP;
    UPDATE patients SET uhid = candidate WHERE id = r.id AND uhid IS NULL;
  END LOOP;
END $$;

COMMIT;
