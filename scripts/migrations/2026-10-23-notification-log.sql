-- 2026-10-23 Foundations T8: notification log, per-template channel config and per-patient
-- channel preferences (spec §4.4). notification_log holds ids, a masked destination, a status
-- and an error class per channel attempt -- never a message body. Additive, idempotent,
-- safe to re-run.
BEGIN;
CREATE TABLE IF NOT EXISTS notification_log (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  template_key text NOT NULL,
  channel text NOT NULL,
  destination_masked text,
  status text NOT NULL,
  provider_message_id text,
  error_class text,
  created_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT notification_log_patient_id_patients_id_fk FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT notification_log_channel_check CHECK (channel IN ('sms', 'email', 'whatsapp', 'in_app', 'log')),
  CONSTRAINT notification_log_status_check CHECK (status IN ('queued', 'sent', 'failed', 'skipped', 'log_only'))
);
CREATE INDEX IF NOT EXISTS notification_log_patient_created_idx ON notification_log (patient_id, created_at);

CREATE TABLE IF NOT EXISTS notification_template_config (
  template_key text PRIMARY KEY,
  channels text[] NOT NULL DEFAULT '{}'::text[],
  dlt_template_id text,
  whatsapp_template_name text,
  updated_by_name text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT notification_template_config_channels_check CHECK (channels <@ ARRAY['sms', 'whatsapp', 'email', 'in_app']::text[])
);

CREATE TABLE IF NOT EXISTS patient_notification_preferences (
  patient_id text PRIMARY KEY,
  sms boolean NOT NULL DEFAULT true,
  whatsapp boolean NOT NULL DEFAULT true,
  email boolean NOT NULL DEFAULT true,
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT patient_notification_preferences_patient_id_patients_id_fk FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE cascade
);
COMMIT;
