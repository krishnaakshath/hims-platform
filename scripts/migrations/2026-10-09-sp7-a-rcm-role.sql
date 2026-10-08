-- 2026-10-09 SP7 RCM, insurer/TPA and claims: the `rcm` staff role
-- (plan 2026-10-07-sp7-rcm-claims.md Task 1).
-- Additive, idempotent. Safe to re-run. Adds one value to the existing `role` enum;
-- alters no table and touches no data.
-- `ALTER TYPE ... ADD VALUE` inside a transaction block is valid on PostgreSQL >= 12; the new
-- value cannot be used until this transaction commits, so it is deliberately not used in this
-- file. Apply it before 2026-10-09-sp7-b-payers-policies.sql.
--
-- Local apply (never db:push against a shared DB):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-09-sp7-a-rcm-role.sql
BEGIN;

ALTER TYPE role ADD VALUE IF NOT EXISTS 'rcm';

COMMIT;
