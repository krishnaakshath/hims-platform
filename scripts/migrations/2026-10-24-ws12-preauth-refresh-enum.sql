-- 2026-10-24 WS12 Task 7 (spec 2026-10-23-insurance-verification-design.md, R10): the pre-auth
-- lifecycle action `refresh_snapshot`. Additive, idempotent, safe to re-run. ADD VALUE inside
-- BEGIN … COMMIT is valid on PG 12+; as in 2026-10-08-sp5-lab-enum-values.sql, only the
-- ALTER TYPE line belongs here, because Postgres forbids using a new enum value in the
-- transaction that added it. The value is appended, so the order equals the drizzle enum array
-- (preauthActionEnum in src/db/schema.ts) and PREAUTH_ACTIONS.
BEGIN;

ALTER TYPE preauth_action ADD VALUE IF NOT EXISTS 'refresh_snapshot';

COMMIT;
