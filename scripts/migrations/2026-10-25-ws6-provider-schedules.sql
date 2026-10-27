-- 2026-10-25 WS6 T6: doctor working hours, slot length and leave (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D5, D6).
--   provider_schedules         weekly template: several IST sessions per weekday (0 = Sunday).
--   provider_leave             leave days, one row per (provider, date).
--   providers.slot_minutes     slot length, 5..60 minutes, default 15.
--   providers.opd_room         OPD room shown at check-in / on the queue display.
--   providers.portal_bookable  whether the doctor is offered on public/portal booking.
-- Backfill: doctors in a non-clinical department (departments.kind <> 'clinical') are not
-- portal-bookable. It runs only in the guarded block that adds the column, so a re-run never
-- overwrites a later admin change.
-- Additive and re-runnable: IF NOT EXISTS, DO blocks guarded on pg_constraint / information_schema.
BEGIN;

ALTER TABLE providers ADD COLUMN IF NOT EXISTS slot_minutes integer DEFAULT 15 NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'providers_slot_minutes_range') THEN
    ALTER TABLE providers ADD CONSTRAINT providers_slot_minutes_range CHECK (slot_minutes BETWEEN 5 AND 60);
  END IF;
END $$;
ALTER TABLE providers ADD COLUMN IF NOT EXISTS opd_room text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'providers' AND column_name = 'portal_bookable'
  ) THEN
    ALTER TABLE providers ADD COLUMN IF NOT EXISTS portal_bookable boolean DEFAULT true NOT NULL;
    UPDATE providers SET portal_bookable = false
    WHERE department_id IN (SELECT id FROM departments WHERE kind <> 'clinical');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS provider_schedules (
  id serial PRIMARY KEY,
  provider_id integer NOT NULL,
  weekday integer NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_schedules_provider_id_providers_id_fk') THEN
    ALTER TABLE provider_schedules ADD CONSTRAINT provider_schedules_provider_id_providers_id_fk
      FOREIGN KEY (provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_schedules_weekday_range') THEN
    ALTER TABLE provider_schedules ADD CONSTRAINT provider_schedules_weekday_range CHECK (weekday BETWEEN 0 AND 6);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_schedules_end_after_start') THEN
    ALTER TABLE provider_schedules ADD CONSTRAINT provider_schedules_end_after_start CHECK (end_time > start_time);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS provider_schedules_provider_weekday_idx ON provider_schedules USING btree (provider_id, weekday);

CREATE TABLE IF NOT EXISTS provider_leave (
  id serial PRIMARY KEY,
  provider_id integer NOT NULL,
  leave_date date NOT NULL,
  reason text NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_leave_provider_id_providers_id_fk') THEN
    ALTER TABLE provider_leave ADD CONSTRAINT provider_leave_provider_id_providers_id_fk
      FOREIGN KEY (provider_id) REFERENCES providers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_leave_provider_date_unique') THEN
    ALTER TABLE provider_leave ADD CONSTRAINT provider_leave_provider_date_unique UNIQUE (provider_id, leave_date);
  END IF;
END $$;

COMMIT;
