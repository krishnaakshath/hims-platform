-- 2026-10-08 SP5 enum values (plan 2026-10-07-sp5-lab-home-collection.md, Ruling 5).
-- Additive, idempotent. Safe to re-run. ADD VALUE inside BEGIN … COMMIT is valid on PG 12+.
-- Only ALTER TYPE … ADD VALUE lines belong in this file: Postgres forbids using a new
-- enum value in the transaction that added it, so anything that references one lives in
-- 2026-10-08-sp5-lab-home-collection.sql, which must run after this file has committed.
-- Each value is placed relative to a value that existed before this migration, so the
-- resulting order equals the drizzle enum array in src/db/schema.ts.
--
-- Task 3 adds the `collector` role value; Task 2 adds the lab_order_status values here.
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-08-sp5-lab-enum-values.sql
BEGIN;

-- lab_order_status: pre-SP5 order is (ordered, collected, resulted, cancelled); the result is
-- (ordered, scheduled, collected, received, resulted, verified, reported, cancelled) = LAB_ORDER_STATUSES.
ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'scheduled' BEFORE 'collected';
ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'received' AFTER 'collected';
ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'reported' BEFORE 'cancelled';
ALTER TYPE lab_order_status ADD VALUE IF NOT EXISTS 'verified' AFTER 'resulted';

ALTER TYPE role ADD VALUE IF NOT EXISTS 'collector';

COMMIT;
