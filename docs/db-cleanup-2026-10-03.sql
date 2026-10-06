-- Test-data cleanup identified during the 2026-10-03 full-app audit.
-- The sandbox this session ran in blocks direct DB writes ("Modify Shared
-- Resources"), so none of this was applied -- run it yourself, or grant
-- Bash DB-write permission and ask Claude to run it.
--
-- Every row below was independently confirmed to still exist via read-only
-- queries at the time this file was written. Re-verify row counts before
-- running in case more time has passed.

BEGIN;

-- 1. Leftover rows from this session's earlier audit-agent sweep (small,
--    low-risk, specific known ids -- confirmed no other table references
--    any of them).
DELETE FROM care_plan_goals WHERE care_plan_id IN (542, 543);
DELETE FROM care_plans WHERE id IN (542, 543);
DELETE FROM encounter_notes WHERE id IN (1155, 1156);
DELETE FROM lab_orders WHERE id IN (1571, 1572);
DELETE FROM medication_episodes WHERE id = 1934;
DELETE FROM adverse_events WHERE id = 7;
DELETE FROM drug_accountability_entries WHERE id = 13;
DELETE FROM regulatory_documents WHERE id = 7;
DELETE FROM form_templates WHERE id = 1765;
DELETE FROM messages WHERE id IN (3194, 3195, 3196);

-- 2. RD-0001 (Maria Alvarez) picked up stray fixture state from earlier
--    interrupted test runs: a half-finished MFA enrollment secret that was
--    never enabled, and a policy-acceptance signature pair that makes
--    tests/lib/queries/policy-documents.test.ts fail (it assumes RD-0001
--    has never accepted policies).
UPDATE patients SET mfa_secret_encrypted = NULL WHERE id = 'RD-0001' AND mfa_enabled = false;
DELETE FROM signatures WHERE id IN (335, 336) AND patient_id = 'RD-0001' AND signable_type = 'policy_acceptance';

-- A background full-suite run got stuck for ~10 hours mid-session (resource
-- contention, not a code bug -- re-verified every affected test passes
-- clean in isolation once the stuck process was gone). That contention
-- caused a few of THIS session's own test runs to fail partway through,
-- leaving their own throwaway fixtures behind instead of self-cleaning:
DELETE FROM adverse_events WHERE patient_id = 'TEST-DEL-TC-1791051998256';
DELETE FROM drug_accountability_entries WHERE patient_id = 'TEST-DEL-TC-1791051998256';
DELETE FROM signatures WHERE patient_id = 'TEST-DEL-TC-1791051998256';
DELETE FROM patients WHERE id = 'TEST-DEL-TC-1791051998256';
DELETE FROM care_plan_goals WHERE care_plan_id IN (SELECT id FROM care_plans WHERE patient_id = 'TEST-DEL-CP-1791051381206');
DELETE FROM care_plans WHERE patient_id = 'TEST-DEL-CP-1791051381206';
DELETE FROM patients WHERE id = 'TEST-DEL-CP-1791051381206';

-- Pre-existing (not from this session): tests/lib/fhir/observation-mapping.test.ts
-- and whatever CCDA test seeded RD-FHIR-CCDA-EMPTY both leave a fixed-id
-- patient behind from an interrupted prior run, now colliding on every
-- subsequent run with a duplicate-key error.
DELETE FROM patients WHERE id = 'RD-FHIR-O2';
DELETE FROM patients WHERE id = 'RD-FHIR-CCDA-EMPTY';

-- Pre-existing: a leftover active "Zztestdrug" episode inflates
-- tests/lib/queries/medications.test.ts's own count assertion by one.
DELETE FROM medication_episodes WHERE id = 2119 AND name = 'Zztestdrug';

COMMIT;

-- 3. THE BIG ONE, DONE SEPARATELY AND CAREFULLY: the `rooms` table is 96%
--    garbage. Of 220 rows, 212 are "Test Ward" fixtures left behind by
--    interrupted test runs across (apparently) many sessions over time --
--    not just this one. This is NOT just a test-suite problem: the real
--    /inpatient/beds Bed & Ward board any admin/crc/pi/frontdesk user opens
--    right now shows this same garbage mixed in with the 8 real rooms
--    (Ward A x3, Ward B x3, ICU x2).
--
--    Complication: one REAL, currently-admitted patient (RD-0004, Priya
--    Natarajan, admission id 348, admitted 2026-09-28) has her current room
--    set to one of these junk rows (room id 381, "Test Ward"/AM1). Deleting
--    that specific room while the admission references it will fail on the
--    FK constraint (admissions.current_room_id -> rooms.id) -- Postgres
--    protects you here, it will NOT silently corrupt that admission.
--
--    Two other junk rows (room ids 1727, 2504, both "Test Ward"/305) have a
--    stale occupied_by_patient_id = 'RD-0001' with NO admission backing it
--    at all (an interrupted test's leftover occupancy flag, not a real
--    admission) -- safe to clear/delete.
--
--    Recommended approach:
--      a) Decide what to do about admission 348 first -- either leave room
--         381 in place (it'll just be the one "Test Ward" room that
--         survives), or use the app's own Transfer flow to move RD-0004 to
--         a real ward room, freeing room 381 for deletion too.
--      b) Then run:
BEGIN;
DELETE FROM rooms WHERE ward = 'Test Ward';  -- will correctly fail here if (a) wasn't done -- that's intentional, not a bug to work around
COMMIT;

-- 4. NOT INCLUDED HERE, NEEDS A SEPARATE DECISION:
--    tests/db/unified-patient-record-migration.test.ts shows the
--    dual-sourced Tebra/IntakeQ columns (name_tebra, name_intakeq, etc.) and
--    the identity_matches table / match_status enum are all still present
--    on the live DB, contradicting several in-code comments that assume
--    this migration already ran. This is a real schema migration (DROP
--    COLUMN / DROP TABLE / DROP TYPE) with cross-branch blast radius (other
--    worktrees -- assignment-notifications, forms-redesign,
--    master-login-redesign, rbac-billing-audit -- may still read those
--    columns), so it isn't included in this cleanup script. Decide
--    separately whether/when to actually run that migration.
