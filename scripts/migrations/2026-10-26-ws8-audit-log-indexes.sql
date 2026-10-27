-- 2026-10-26 WS8 T12: audit_log indexes for the filtered, keyset-paginated audit log and its CSV export
-- (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D19).
--   (timestamp, id)          newest-first keyset pages and date ranges
--   (patient_id, timestamp)  the patient (UHID / chart id) filter
--   (role, timestamp)        the role filter
-- Mirrors src/db/schema.ts (// WS8 T12). Re-runnable.
BEGIN;

CREATE INDEX IF NOT EXISTS audit_log_timestamp_id_idx ON audit_log (timestamp, id);
CREATE INDEX IF NOT EXISTS audit_log_patient_timestamp_idx ON audit_log (patient_id, timestamp);
CREATE INDEX IF NOT EXISTS audit_log_role_timestamp_idx ON audit_log (role, timestamp);

COMMIT;
