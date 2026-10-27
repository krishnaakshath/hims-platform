-- 2026-10-24 WS4 T12 critical-value alerts (plan 2026-10-23-inpatient-lab, spec 3.5 and §4).
-- One alert per lab order, raised inside the result transaction when the summary flag becomes
-- critical; open -> notified -> acknowledged, or withdrawn by an amendment.
-- Cascades (pinned in tests/db/migrate-runner.test.ts):
--   lab_critical_alerts -> lab_orders ON DELETE CASCADE: an alert is detail of its order.
--   lab_critical_alerts -> patients   ON DELETE CASCADE: and of its patient (deletePatient needs no new line).
--   notified_by_user_id / acknowledged_by_user_id stay NO ACTION.
-- Additive, idempotent, safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS lab_critical_alerts (
  id serial PRIMARY KEY,
  lab_order_id integer NOT NULL,
  patient_id text NOT NULL,
  summary text NOT NULL,
  status text DEFAULT 'open' NOT NULL,
  raised_at timestamp DEFAULT now() NOT NULL,
  notified_at timestamp,
  notified_by_name text,
  notified_by_user_id integer,
  notified_to_name text,
  notify_channel text,
  read_back boolean,
  acknowledged_at timestamp,
  acknowledged_by_name text,
  acknowledged_by_user_id integer,
  ack_note text,
  withdrawn_at timestamp
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_lab_order_id_lab_orders_id_fk') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_lab_order_id_lab_orders_id_fk
      FOREIGN KEY (lab_order_id) REFERENCES lab_orders(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_patient_id_patients_id_fk') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_notified_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_notified_by_user_id_users_id_fk
      FOREIGN KEY (notified_by_user_id) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_acknowledged_by_user_id_users_id_fk') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_acknowledged_by_user_id_users_id_fk
      FOREIGN KEY (acknowledged_by_user_id) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_status_valid') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_status_valid
      CHECK (status IN ('open', 'notified', 'acknowledged', 'withdrawn'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_channel_valid') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_channel_valid
      CHECK (notify_channel IS NULL OR notify_channel IN ('phone', 'in_person', 'in_app'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_summary_length') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_summary_length
      CHECK (char_length(summary) BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_notified_to_length') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_notified_to_length
      CHECK (notified_to_name IS NULL OR char_length(notified_to_name) <= 120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_ack_note_length') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_ack_note_length
      CHECK (ack_note IS NULL OR char_length(ack_note) <= 300);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lab_critical_alerts_phone_read_back') THEN
    ALTER TABLE lab_critical_alerts ADD CONSTRAINT lab_critical_alerts_phone_read_back
      CHECK (notify_channel IS DISTINCT FROM 'phone' OR read_back = true);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS lab_critical_alerts_lab_order_unique ON lab_critical_alerts (lab_order_id);
CREATE INDEX IF NOT EXISTS lab_critical_alerts_patient_idx ON lab_critical_alerts (patient_id);
CREATE INDEX IF NOT EXISTS lab_critical_alerts_status_idx ON lab_critical_alerts (status);

COMMIT;
