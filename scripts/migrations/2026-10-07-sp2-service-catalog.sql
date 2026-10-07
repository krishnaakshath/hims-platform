-- 2026-10-07 SP2 room categories + service catalogue (plan 2026-10-07-sp2-tariff-master.md Task 1).
-- Additive, idempotent. Safe to re-run. Requires the SP1 departments migration
-- (2026-10-07-sp1-departments.sql) to have been applied first.
BEGIN;

CREATE TABLE IF NOT EXISTS room_categories (
  id serial PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_categories_code_unique') THEN
    ALTER TABLE room_categories ADD CONSTRAINT room_categories_code_unique UNIQUE (code);
  END IF;
END $$;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_category_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_room_category_id_room_categories_id_fk') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_room_category_id_room_categories_id_fk
      FOREIGN KEY (room_category_id) REFERENCES room_categories(id);
  END IF;
END $$;

DO $$ BEGIN
  CREATE TYPE service_category AS ENUM (
    'consultation', 'procedure', 'investigation_lab', 'investigation_imaging', 'room_rent',
    'nursing', 'pharmacy', 'consumable', 'package', 'other'
  );
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS service_catalog (
  id serial PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  department_id integer NOT NULL,
  category service_category NOT NULL,
  hsn_sac text NOT NULL,
  gst_rate_bp integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_code_unique') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_code_unique UNIQUE (code);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_gst_rate_bp_allowed') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_gst_rate_bp_allowed
      CHECK (gst_rate_bp IN (0, 500, 1200, 1800, 2800, 4000));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_department_id_departments_id_fk') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS service_catalog_department_idx ON service_catalog (department_id);

COMMIT;
