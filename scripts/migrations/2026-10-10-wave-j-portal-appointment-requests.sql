-- 2026-10-10 Wave J (P1-20): patient-portal appointment requests ride on booking_requests.
-- A request made from the portal names the signed-in patient (patient_id), what is asked for
-- (request_kind: a new visit, or a reschedule / cancellation of one of the patient's own
-- appointments) and, for the last two, the appointment (appointment_id). Public /book requests
-- keep request_kind 'new' with no patient and no appointment, so every existing row is valid.
-- At most one pending request per appointment. Both new FKs cascade: a request has no meaning
-- once its patient or appointment is gone, and deletePatient needs no new step.
-- Additive, idempotent. Safe to re-run.
BEGIN;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS patient_id text;
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS request_kind text NOT NULL DEFAULT 'new';
ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS appointment_id integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_patient_id_patients_id_fk') THEN
    ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_patient_id_patients_id_fk
      FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_appointment_id_appointments_id_fk') THEN
    ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_appointment_id_appointments_id_fk
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_request_kind_valid') THEN
    ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_request_kind_valid
      CHECK (request_kind IN ('new', 'reschedule', 'cancel'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_requests_kind_shape') THEN
    ALTER TABLE booking_requests ADD CONSTRAINT booking_requests_kind_shape
      CHECK ((request_kind = 'new' AND appointment_id IS NULL) OR (request_kind <> 'new' AND appointment_id IS NOT NULL AND patient_id IS NOT NULL));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS booking_requests_patient_idx ON booking_requests (patient_id);
CREATE UNIQUE INDEX IF NOT EXISTS booking_requests_one_pending_per_appointment ON booking_requests (appointment_id) WHERE status = 'pending' AND appointment_id IS NOT NULL;
COMMIT;
