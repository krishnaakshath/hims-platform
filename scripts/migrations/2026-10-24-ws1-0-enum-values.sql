-- 2026-10-24 WS1 T1 enum values (plan 2026-10-23-doctor-workspace-billing.md, Task 1).
-- Additive, idempotent. Safe to re-run. ADD VALUE inside BEGIN … COMMIT is valid on PG 12+.
-- Only ALTER TYPE … ADD VALUE lines belong in this file: Postgres forbids using a new enum
-- value in the transaction that added it, so anything that uses it lives in a later file.
-- The resulting order equals signableTypeEnum in src/db/schema.ts.
BEGIN;

-- signable_type: a signed doctor's encounter note.
ALTER TYPE signable_type ADD VALUE IF NOT EXISTS 'encounter_note' AFTER 'form_submission_consent';

COMMIT;
