-- 2026-10-23 Foundations T11 (review fix): one UPI reference (UTR) per receipt, across patients.
-- A unique expression index over the normalised UPI reference of patient_payments, the same
-- normalisation as normaliseUtr() in src/lib/payments/provider.ts (spaces and dashes dropped,
-- upper-cased). Together with payment_requests_utr_unique this refuses a UTR recorded twice, by
-- hand or through a UPI QR request, even when two patients' payments race.
-- Backfill-safe: if existing rows already share a normalised UPI reference (old demo data), the
-- index is created partial over rows newer than the current maximum id, so the migration never
-- fails and every new payment is still guarded; a NOTICE names how many duplicates were left.
-- Additive, idempotent, safe to re-run. Requires 2026-10-23-payment-requests.sql.
BEGIN;
DO $$
DECLARE
  dup_count integer;
  max_id integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'patient_payments_upi_reference_unique') THEN
    RETURN;
  END IF;
  SELECT count(*) INTO dup_count FROM (
    SELECT upper(regexp_replace(reference, '[[:space:]-]', '', 'g')) AS ref
    FROM patient_payments WHERE mode = 'upi' AND reference IS NOT NULL
    GROUP BY 1 HAVING count(*) > 1
  ) d;
  IF dup_count = 0 THEN
    CREATE UNIQUE INDEX patient_payments_upi_reference_unique
      ON patient_payments ((upper(regexp_replace(reference, '[[:space:]-]', '', 'g'))))
      WHERE mode = 'upi' AND reference IS NOT NULL;
  ELSE
    SELECT coalesce(max(id), 0) INTO max_id FROM patient_payments;
    RAISE NOTICE 'patient_payments: % duplicated UPI reference(s) predate the guard; indexing rows with id > %', dup_count, max_id;
    EXECUTE format(
      'CREATE UNIQUE INDEX patient_payments_upi_reference_unique ON patient_payments ((upper(regexp_replace(reference, %L, %L, %L)))) WHERE mode = %L AND reference IS NOT NULL AND id > %s',
      '[[:space:]-]', '', 'g', 'upi', max_id);
  END IF;
END $$;
COMMIT;
