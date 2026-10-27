-- 2026-10-24 WS2 T1 enum values (plan 2026-10-23-doctor-workspace-billing.md, Task 1).
-- Additive, idempotent. Safe to re-run. ADD VALUE inside BEGIN … COMMIT is valid on PG 12+.
-- Only ALTER TYPE … ADD VALUE lines belong in this file: Postgres forbids using a new enum
-- value in the transaction that added it, so anything that uses it lives in a later file.
-- The resulting order equals chargeLineSourceEnum in src/db/schema.ts.
BEGIN;

-- charge_line_source: automatic charge capture (registration fee, consultation, lab order, procedure).
ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'registration' AFTER 'pharmacy';
ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'consultation' AFTER 'registration';
ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'lab_order' AFTER 'consultation';
ALTER TYPE charge_line_source ADD VALUE IF NOT EXISTS 'procedure' AFTER 'lab_order';

COMMIT;
