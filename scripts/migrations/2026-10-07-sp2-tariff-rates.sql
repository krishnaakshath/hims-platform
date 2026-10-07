-- 2026-10-07 SP2 tariff rates + package items (plan 2026-10-07-sp2-tariff-master.md Task 2).
-- Additive, idempotent. Safe to re-run. Requires 2026-10-07-sp1-departments.sql and
-- 2026-10-07-sp2-service-catalog.sql to have been applied first.
--
-- tariff_rates_no_overlap (EXCLUDE USING gist) cannot be expressed in src/db/schema.ts;
-- it exists ONLY here. Apply this file after every fresh `db:push` (docs/DEPLOYING.md §4).
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS tariff_rates (
  id serial PRIMARY KEY,
  service_id integer NOT NULL,
  scope text NOT NULL,
  department_id integer,
  payer_id integer,
  room_category_id integer,
  ward text,
  amount_paise integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  valid_from date NOT NULL,
  valid_to date,
  deactivated_at timestamp,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_service_id_service_catalog_id_fk') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_service_id_service_catalog_id_fk
      FOREIGN KEY (service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_department_id_departments_id_fk') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_department_id_departments_id_fk
      FOREIGN KEY (department_id) REFERENCES departments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_payer_id_payers_id_fk') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_room_category_id_room_categories_id_fk') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_room_category_id_room_categories_id_fk
      FOREIGN KEY (room_category_id) REFERENCES room_categories(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_amount_nonneg') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_amount_nonneg CHECK (amount_paise >= 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_range_ordered') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_range_ordered
      CHECK (valid_to IS NULL OR valid_to >= valid_from);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_scope_keys') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_scope_keys CHECK (
      (scope = 'base' AND department_id IS NULL AND payer_id IS NULL)
      OR (scope = 'department' AND department_id IS NOT NULL AND payer_id IS NULL)
      OR (scope = 'payer' AND payer_id IS NOT NULL AND department_id IS NULL)
    );
  END IF;
END $$;
-- No two ACTIVE versions of the same (service, scope, department/payer, room category, ward)
-- may share a day. Ranges are inclusive on both ends; a null valid_to is open-ended.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tariff_rates_no_overlap') THEN
    ALTER TABLE tariff_rates ADD CONSTRAINT tariff_rates_no_overlap EXCLUDE USING gist (
      service_id WITH =, scope WITH =, (coalesce(department_id, 0)) WITH =, (coalesce(payer_id, 0)) WITH =,
      (coalesce(room_category_id, 0)) WITH =, (coalesce(ward, '')) WITH =,
      daterange(valid_from, valid_to, '[]') WITH &&
    ) WHERE (deactivated_at IS NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS tariff_rates_service_idx ON tariff_rates (service_id);

CREATE TABLE IF NOT EXISTS service_package_items (
  id serial PRIMARY KEY,
  package_service_id integer NOT NULL,
  item_service_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_package_items_package_service_id_service_catalog_id_fk') THEN
    ALTER TABLE service_package_items ADD CONSTRAINT service_package_items_package_service_id_service_catalog_id_fk
      FOREIGN KEY (package_service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_package_items_item_service_id_service_catalog_id_fk') THEN
    ALTER TABLE service_package_items ADD CONSTRAINT service_package_items_item_service_id_service_catalog_id_fk
      FOREIGN KEY (item_service_id) REFERENCES service_catalog(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_package_items_qty_positive') THEN
    ALTER TABLE service_package_items ADD CONSTRAINT service_package_items_qty_positive CHECK (quantity > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_package_items_not_self') THEN
    ALTER TABLE service_package_items ADD CONSTRAINT service_package_items_not_self
      CHECK (package_service_id <> item_service_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS service_package_items_pkg_item_unique
  ON service_package_items (package_service_id, item_service_id);

COMMIT;
