-- 2026-10-07 SP6 clinical coding: the `coder` staff role
-- (plan 2026-10-07-sp6-clinical-coding.md Task 1).
-- Additive, idempotent. Safe to re-run. Adds one value to the existing `role` enum;
-- alters no table and touches no data.
-- `ALTER TYPE ... ADD VALUE` inside a transaction block is valid on PostgreSQL >= 12; the new
-- value cannot be used until this transaction commits, so it is deliberately not used in this
-- file. Apply it before 2026-10-07-sp6-b-clinical-coding.sql (which references the role type).
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-07-sp6-a-coder-role.sql
BEGIN;

ALTER TYPE role ADD VALUE IF NOT EXISTS 'coder';

COMMIT;
