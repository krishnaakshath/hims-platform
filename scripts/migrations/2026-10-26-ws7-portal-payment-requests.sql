-- 2026-10-26 WS7 T8: portal Pay now (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D14).
--   payment_requests.source        'staff' (cash desk QR, default) or 'portal' (patient Pay now).
--   payment_requests.reported_utr  the UTR a patient says they paid with: unverified, never a receipt;
--                                  the cashier confirms it through the existing confirm route.
--   payment_requests.reported_at   when the patient reported it.
-- Additive and re-runnable. Requires 2026-10-23-payment-requests.sql.
BEGIN;

ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff';
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS reported_utr text;
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS reported_at timestamp;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_requests_source_valid') THEN
    ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_source_valid CHECK (source IN ('staff', 'portal'));
  END IF;
END $$;

COMMIT;
