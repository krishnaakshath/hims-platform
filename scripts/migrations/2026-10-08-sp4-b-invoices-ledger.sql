-- 2026-10-08 SP4 migration B: invoices, credit notes, receipts, refunds, document counters,
-- and the immutability triggers on issued documents (plan 2026-10-07-sp4-charge-capture.md Task 5).
-- Additive, idempotent. Safe to re-run. Requires 2026-10-08-sp4-a-charge-lines.sql (and therefore
-- SP1-SP3) to have been applied first. Creates four enum types and six tables, and adds
-- charge_lines.invoice_id. No FK has an ON DELETE action: issued documents are never cascaded.
-- Money: every amount and total is bigint paise; invoice_lines.unit_price_paise stays int4.
--
-- MIGRATION-ONLY OBJECTS (like SP2's tariff_rates_no_overlap): the functions
-- sp4_reject_issued_change() and sp4_invoice_guard() and the five triggers below cannot be
-- expressed in src/db/schema.ts. They exist only here: after every fresh `db:push`, apply this
-- file (docs/DEPLOYING.md section 4), and never `db:push` against a DB that has them.
--   - invoices_issued_guard: a finalised or cancelled invoice cannot be deleted; a cancelled one
--     cannot be updated; a finalised one may only change to status 'cancelled', with
--     cancelled_at / cancelled_by_name, every other column unchanged (IS NOT DISTINCT FROM).
--     Draft and discarded invoices are ordinary mutable rows.
--   - invoice_lines_immutable, credit_notes_immutable, patient_payments_immutable,
--     refunds_immutable: no UPDATE or DELETE at all (these rows only exist once issued).
--   Each refusal is SQLSTATE 55000 'issued billing documents cannot be changed'. Triggers fire for
--   every role, table owners and superusers included.
--
-- PURGE SETTING: a transaction that first runs
--     select set_config('hims.allow_document_purge', 'on', true)
-- passes every guard until it ends (the third argument makes it transaction-local, so it cannot
-- leak into a pooled connection). Only the seed's clearExistingData() and the test helper
-- purgeBillingFixtures() (tests/db/billing-fixtures.ts) use it; app code never does. It is an
-- accident guard, not a security boundary: any role can set a custom setting, and a superuser can
-- bypass triggers (session_replication_role = replica) or TRUNCATE.
--
-- Local apply (never db:push against a shared DB):
--   /Users/k2a/.docker/bin/docker exec -i hims-local-pg psql -U postgres -d hims -v ON_ERROR_STOP=1 < scripts/migrations/2026-10-08-sp4-b-invoices-ledger.sql
BEGIN;

DO $$ BEGIN
  CREATE TYPE document_series AS ENUM ('invoice', 'receipt', 'credit_note', 'refund');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM ('draft', 'finalised', 'cancelled', 'discarded');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE payment_mode AS ENUM ('cash', 'upi', 'card', 'cheque', 'neft', 'other');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
DO $$ BEGIN
  CREATE TYPE patient_payment_kind AS ENUM ('advance', 'receipt');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

-- document_counters: gapless numbering per series per financial year (YYYY-YY).
CREATE TABLE IF NOT EXISTS document_counters (
  series document_series NOT NULL,
  financial_year text NOT NULL,
  last_value integer NOT NULL DEFAULT 0
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_counters_pk') THEN
    ALTER TABLE document_counters ADD CONSTRAINT document_counters_pk PRIMARY KEY (series, financial_year);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_counters_fy_format') THEN
    ALTER TABLE document_counters ADD CONSTRAINT document_counters_fy_format
      CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_counters_value_range') THEN
    ALTER TABLE document_counters ADD CONSTRAINT document_counters_value_range
      CHECK (last_value BETWEEN 0 AND 999999);
  END IF;
END $$;

-- invoices: draft -> finalised (numbered, snapshotted, totalled) -> cancelled (by credit note);
-- or draft -> discarded.
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  invoice_number text,
  status invoice_status NOT NULL DEFAULT 'draft',
  patient_id text NOT NULL,
  encounter_id integer,
  admission_id integer,
  payer_id integer,
  financial_year text,
  invoice_date date,
  document_title text,
  supply_type text,
  place_of_supply_state_code text,
  snapshot jsonb,
  taxable_paise bigint,
  cgst_paise bigint,
  sgst_paise bigint,
  igst_paise bigint,
  total_paise bigint,
  created_by_name text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  finalised_at timestamp,
  finalised_by_name text,
  cancelled_at timestamp,
  cancelled_by_name text,
  discarded_at timestamp,
  discarded_by_name text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_patient_id_patients_id_fk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_encounter_id_encounters_id_fk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_admission_id_admissions_id_fk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_payer_id_payers_id_fk') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_payer_id_payers_id_fk
      FOREIGN KEY (payer_id) REFERENCES payers(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_invoice_number_unique') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_number_unique UNIQUE (invoice_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_number_when_issued') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_number_when_issued
      CHECK ((status IN ('finalised', 'cancelled')) = (invoice_number IS NOT NULL));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_totals_when_issued') THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_totals_when_issued
      CHECK (status NOT IN ('finalised', 'cancelled') OR (total_paise IS NOT NULL AND snapshot IS NOT NULL AND invoice_date IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invoices_patient_idx ON invoices (patient_id);

-- invoice_lines: written only at finalisation (snapshots of the charge line and its tax split).
CREATE TABLE IF NOT EXISTS invoice_lines (
  id serial PRIMARY KEY,
  invoice_id integer NOT NULL,
  charge_line_id integer NOT NULL,
  line_no integer NOT NULL,
  item_code text NOT NULL,
  item_name text NOT NULL,
  hsn_sac text NOT NULL,
  service_date date NOT NULL,
  quantity integer NOT NULL,
  unit_price_paise integer NOT NULL,
  price_source text NOT NULL,
  taxable_paise bigint NOT NULL,
  gst_rate_bp integer NOT NULL,
  cgst_rate_bp integer NOT NULL,
  sgst_rate_bp integer NOT NULL,
  igst_rate_bp integer NOT NULL,
  cgst_paise bigint NOT NULL,
  sgst_paise bigint NOT NULL,
  igst_paise bigint NOT NULL,
  total_paise bigint NOT NULL
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_invoice_id_invoices_id_fk') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_invoice_id_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES invoices(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_lines_charge_line_id_charge_lines_id_fk') THEN
    ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_charge_line_id_charge_lines_id_fk
      FOREIGN KEY (charge_line_id) REFERENCES charge_lines(id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_lines_invoice_line_no_unique ON invoice_lines (invoice_id, line_no);

-- credit_notes: full-value, one per cancelled invoice.
CREATE TABLE IF NOT EXISTS credit_notes (
  id serial PRIMARY KEY,
  credit_note_number text NOT NULL,
  invoice_id integer NOT NULL,
  financial_year text NOT NULL,
  issue_date date NOT NULL,
  reason text NOT NULL,
  taxable_paise bigint NOT NULL,
  cgst_paise bigint NOT NULL,
  sgst_paise bigint NOT NULL,
  igst_paise bigint NOT NULL,
  total_paise bigint NOT NULL,
  issued_by_name text NOT NULL,
  issued_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_notes_invoice_id_invoices_id_fk') THEN
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_invoice_id_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES invoices(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_notes_credit_note_number_unique') THEN
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_credit_note_number_unique UNIQUE (credit_note_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_notes_invoice_id_unique') THEN
    ALTER TABLE credit_notes ADD CONSTRAINT credit_notes_invoice_id_unique UNIQUE (invoice_id);
  END IF;
END $$;

-- patient_payments: advances and receipts (record-keeping only). The reference never reaches the audit log.
CREATE TABLE IF NOT EXISTS patient_payments (
  id serial PRIMARY KEY,
  receipt_number text NOT NULL,
  kind patient_payment_kind NOT NULL,
  patient_id text NOT NULL,
  admission_id integer,
  encounter_id integer,
  invoice_id integer,
  mode payment_mode NOT NULL,
  reference text,
  amount_paise bigint NOT NULL,
  financial_year text NOT NULL,
  receipt_date date NOT NULL,
  received_by_name text NOT NULL,
  received_by_user_id integer,
  received_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_patient_id_patients_id_fk') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_admission_id_admissions_id_fk') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_encounter_id_encounters_id_fk') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_encounter_id_encounters_id_fk
      FOREIGN KEY (encounter_id) REFERENCES encounters(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_invoice_id_invoices_id_fk') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_invoice_id_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES invoices(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_received_by_user_id_users_id_fk') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_received_by_user_id_users_id_fk
      FOREIGN KEY (received_by_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_receipt_number_unique') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_receipt_number_unique UNIQUE (receipt_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_amount_positive') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_amount_positive
      CHECK (amount_paise > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_payments_reference_required') THEN
    ALTER TABLE patient_payments ADD CONSTRAINT patient_payments_reference_required
      CHECK (mode = 'cash' OR reference IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS patient_payments_patient_idx ON patient_payments (patient_id);

-- refunds: money returned to the patient, at most their credit balance (checked by the app under lock).
CREATE TABLE IF NOT EXISTS refunds (
  id serial PRIMARY KEY,
  refund_number text NOT NULL,
  patient_id text NOT NULL,
  admission_id integer,
  against_payment_id integer,
  mode payment_mode NOT NULL,
  reference text,
  amount_paise bigint NOT NULL,
  reason text NOT NULL,
  financial_year text NOT NULL,
  refund_date date NOT NULL,
  issued_by_name text NOT NULL,
  issued_at timestamp NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_patient_id_patients_id_fk') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_admission_id_admissions_id_fk') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_admission_id_admissions_id_fk
      FOREIGN KEY (admission_id) REFERENCES admissions(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_against_payment_id_patient_payments_id_fk') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_against_payment_id_patient_payments_id_fk
      FOREIGN KEY (against_payment_id) REFERENCES patient_payments(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_refund_number_unique') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_refund_number_unique UNIQUE (refund_number);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_amount_positive') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_amount_positive
      CHECK (amount_paise > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refunds_reference_required') THEN
    ALTER TABLE refunds ADD CONSTRAINT refunds_reference_required
      CHECK (mode = 'cash' OR reference IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS refunds_patient_idx ON refunds (patient_id);

-- charge_lines.invoice_id: the draft or issued invoice a line is on (null = unbilled).
ALTER TABLE charge_lines ADD COLUMN IF NOT EXISTS invoice_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_lines_invoice_id_invoices_id_fk') THEN
    ALTER TABLE charge_lines ADD CONSTRAINT charge_lines_invoice_id_invoices_id_fk
      FOREIGN KEY (invoice_id) REFERENCES invoices(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS charge_lines_invoice_idx ON charge_lines (invoice_id);

-- Immutability (MIGRATION-ONLY; see the header).
CREATE OR REPLACE FUNCTION sp4_reject_issued_change() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'issued billing documents cannot be changed' USING ERRCODE = '55000';
END;
$fn$;

CREATE OR REPLACE FUNCTION sp4_invoice_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_setting('hims.allow_document_purge', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('finalised', 'cancelled') THEN
      RAISE EXCEPTION 'issued billing documents cannot be changed' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'issued billing documents cannot be changed' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'finalised' THEN
    -- The one allowed change: finalised -> cancelled, touching only the cancellation columns.
    -- Compared as whole rows minus those columns, so a column added later is protected too.
    IF NEW.status = 'cancelled'
       AND (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by_name'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by_name']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'issued billing documents cannot be changed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$fn$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_issued_guard' AND tgrelid = 'invoices'::regclass) THEN
    CREATE TRIGGER invoices_issued_guard BEFORE UPDATE OR DELETE ON invoices
      FOR EACH ROW EXECUTE FUNCTION sp4_invoice_guard();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoice_lines_immutable' AND tgrelid = 'invoice_lines'::regclass) THEN
    CREATE TRIGGER invoice_lines_immutable BEFORE UPDATE OR DELETE ON invoice_lines
      FOR EACH ROW EXECUTE FUNCTION sp4_reject_issued_change();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'credit_notes_immutable' AND tgrelid = 'credit_notes'::regclass) THEN
    CREATE TRIGGER credit_notes_immutable BEFORE UPDATE OR DELETE ON credit_notes
      FOR EACH ROW EXECUTE FUNCTION sp4_reject_issued_change();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'patient_payments_immutable' AND tgrelid = 'patient_payments'::regclass) THEN
    CREATE TRIGGER patient_payments_immutable BEFORE UPDATE OR DELETE ON patient_payments
      FOR EACH ROW EXECUTE FUNCTION sp4_reject_issued_change();
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'refunds_immutable' AND tgrelid = 'refunds'::regclass) THEN
    CREATE TRIGGER refunds_immutable BEFORE UPDATE OR DELETE ON refunds
      FOR EACH ROW EXECUTE FUNCTION sp4_reject_issued_change();
  END IF;
END $$;

COMMIT;
