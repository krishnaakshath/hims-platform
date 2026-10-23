-- 2026-10-23 Foundations T11: payment_requests, one row per UPI QR shown at the cash desk.
-- Confirming a request with the payer's UTR posts the ordinary receipt (patient_payments,
-- mode 'upi') in the same transaction; the partial unique index on utr refuses a UTR used twice.
-- Additive, idempotent, safe to re-run. Requires 2026-10-08-sp4-b-invoices-ledger.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS payment_requests (
  id serial PRIMARY KEY,
  provider text NOT NULL DEFAULT 'manual_upi_qr',
  patient_id text NOT NULL REFERENCES patients(id),
  kind patient_payment_kind NOT NULL DEFAULT 'receipt',
  admission_id integer REFERENCES admissions(id),
  invoice_id integer REFERENCES invoices(id),
  amount_paise bigint NOT NULL,
  vpa text NOT NULL,
  note text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  utr text,
  payment_id integer REFERENCES patient_payments(id),
  created_by text NOT NULL,
  created_by_user_id integer REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  confirmed_at timestamp,
  CONSTRAINT payment_requests_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT payment_requests_status_valid CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  CONSTRAINT payment_requests_confirmed_has_utr CHECK (status <> 'confirmed' OR (utr IS NOT NULL AND payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_requests_utr_unique ON payment_requests (utr) WHERE utr IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_requests_patient_idx ON payment_requests (patient_id);
COMMIT;
