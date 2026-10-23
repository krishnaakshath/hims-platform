-- 2026-10-25 WS6 T11: proof of sample handover at the door (spec D7,
-- docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md).
--   home_collection_visits.handover_otp_hash        scrypt hash of the 6-digit code (never the code)
--   home_collection_visits.handover_otp_expires_at  15 minutes after the code was sent
--   home_collection_visits.handover_otp_attempts    wrong codes since the last send (locked at 5)
--   home_collection_visits.handover_verified_at     set when the collect was proven with the code
--   home_collection_visits.handover_waiver_reason   no_phone | sms_unavailable | patient_declined
-- Additive and re-runnable: IF NOT EXISTS, DO block guarded on pg_constraint.
BEGIN;

ALTER TABLE home_collection_visits ADD COLUMN IF NOT EXISTS handover_otp_hash text;
ALTER TABLE home_collection_visits ADD COLUMN IF NOT EXISTS handover_otp_expires_at timestamp;
ALTER TABLE home_collection_visits ADD COLUMN IF NOT EXISTS handover_otp_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE home_collection_visits ADD COLUMN IF NOT EXISTS handover_verified_at timestamp;
ALTER TABLE home_collection_visits ADD COLUMN IF NOT EXISTS handover_waiver_reason text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'home_collection_visits_handover_waiver_reason') THEN
    ALTER TABLE home_collection_visits ADD CONSTRAINT home_collection_visits_handover_waiver_reason
      CHECK (handover_waiver_reason IS NULL OR handover_waiver_reason IN ('no_phone', 'sms_unavailable', 'patient_declined'));
  END IF;
END $$;

COMMIT;
