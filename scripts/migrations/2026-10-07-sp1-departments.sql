-- 2026-10-07 SP1 department master (plan 2026-10-07-sp1-patient-master.md Task 2).
-- Additive, idempotent. Safe to re-run. Shared Neon DB: other branches
-- do not know this table exists.
BEGIN;
DO $$ BEGIN
  CREATE TYPE department_kind AS ENUM ('clinical', 'diagnostic', 'support', 'administrative');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
CREATE TABLE IF NOT EXISTS departments (
  id serial PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  kind department_kind NOT NULL DEFAULT 'clinical',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_code_unique') THEN
    ALTER TABLE departments ADD CONSTRAINT departments_code_unique UNIQUE (code);
  END IF;
END $$;
COMMIT;
