-- 2026-10-24 WS4 T11 doctor acknowledgement and co-sign of a lab result
-- (plan 2026-10-23-inpatient-lab, spec 3.4 and §4).
-- Cascades (pinned in tests/db/migrate-runner.test.ts):
--   lab_result_signoffs -> lab_orders ON DELETE CASCADE: a sign-off is detail of its order.
--   provider_id / user_id stay NO ACTION.
-- One sign-off of each kind per provider per order: unique (lab_order_id, kind, provider_id).
-- Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS lab_result_signoffs (
  id serial PRIMARY KEY,
  lab_order_id integer NOT NULL,
  kind text NOT NULL,
  provider_id integer NOT NULL,
  user_id integer,
  signed_by_name text NOT NULL,
  note text,
  signed_at timestamp DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_signoffs_lab_order_id_lab_orders_id_fk') THEN
    ALTER TABLE lab_result_signoffs ADD CONSTRAINT lab_result_signoffs_lab_order_id_lab_orders_id_fk
      FOREIGN KEY (lab_order_id) REFERENCES lab_orders(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_signoffs_provider_id_providers_id_fk') THEN
    ALTER TABLE lab_result_signoffs ADD CONSTRAINT lab_result_signoffs_provider_id_providers_id_fk
      FOREIGN KEY (provider_id) REFERENCES providers(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_signoffs_user_id_users_id_fk') THEN
    ALTER TABLE lab_result_signoffs ADD CONSTRAINT lab_result_signoffs_user_id_users_id_fk
      FOREIGN KEY (user_id) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_signoffs_kind_valid') THEN
    ALTER TABLE lab_result_signoffs ADD CONSTRAINT lab_result_signoffs_kind_valid
      CHECK (kind IN ('acknowledge', 'cosign'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_result_signoffs_note_length') THEN
    ALTER TABLE lab_result_signoffs ADD CONSTRAINT lab_result_signoffs_note_length
      CHECK (note IS NULL OR char_length(note) <= 300);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lab_result_signoffs_order_kind_provider_unique ON lab_result_signoffs (lab_order_id, kind, provider_id);
CREATE INDEX IF NOT EXISTS lab_result_signoffs_provider_idx ON lab_result_signoffs (provider_id);

COMMIT;
