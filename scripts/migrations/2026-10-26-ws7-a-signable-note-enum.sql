-- 2026-10-26 WS7 Task 5 (spec 2026-10-23-operations-portal-governance-design.md, D12): a signed
-- clinical note writes a signatures row with signable_type = 'encounter_note'. Additive,
-- idempotent, safe to re-run, and a no-op when the doctor-workspace lane (WS1) has already
-- added the same value. As in 2026-10-24-ws12-preauth-refresh-enum.sql, only the ALTER TYPE line
-- belongs here, because Postgres forbids using a new enum value in the transaction that added
-- it. The value is appended, so the order equals signableTypeEnum in src/db/schema.ts.
BEGIN;

ALTER TYPE signable_type ADD VALUE IF NOT EXISTS 'encounter_note';

COMMIT;
