-- 2026-10-26 WS7 T6: visit mode (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D20).
--   appointments.visit_mode               'in_person' (default) or 'video'; only video appointments offer telemedicine.
--   booking_requests.requested_visit_mode  the mode a patient asked for; NULL = not stated.
-- Additive and re-runnable: ADD COLUMN IF NOT EXISTS plus guarded CHECK constraints.
BEGIN;

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS visit_mode text NOT NULL DEFAULT 'in_person';
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS requested_visit_mode text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_visit_mode_valid') THEN
    ALTER TABLE appointments ADD CONSTRAINT appointments_visit_mode_valid CHECK (visit_mode IN ('in_person', 'video'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_requested_visit_mode_valid') THEN
    ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_requested_visit_mode_valid
      CHECK (requested_visit_mode IS NULL OR requested_visit_mode IN ('in_person', 'video'));
  END IF;
END $$;

-- An appointment that already has a telemedicine session was a video visit before this
-- column existed; mark it so its session stays reachable (rejoin / link recovery).
UPDATE appointments SET visit_mode = 'video'
WHERE visit_mode = 'in_person' AND id IN (SELECT appointment_id FROM telemedicine_sessions);

COMMIT;
