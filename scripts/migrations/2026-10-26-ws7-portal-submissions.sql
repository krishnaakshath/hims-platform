-- 2026-10-26 WS7 T9: portal_submissions (spec D15). A patient's self-service insurance policy or
-- ABHA from the portal waits here as 'pending' until the front desk approves it (writing the real
-- policy, or recording the ABHA as not verified with ABDM) or rejects it with a reason. At most one
-- pending row per patient and kind (partial unique index). The optional card image is a documents
-- row (document_id). Additive, idempotent, safe to re-run. Requires patients and documents.
BEGIN;
CREATE TABLE IF NOT EXISTS portal_submissions (
  id serial PRIMARY KEY,
  patient_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  document_id integer,
  status text NOT NULL DEFAULT 'pending',
  submitted_at timestamp NOT NULL DEFAULT now(),
  reviewed_by_name text,
  reviewed_at timestamp,
  reject_reason text,
  CONSTRAINT portal_submissions_patient_id_patients_id_fk FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT portal_submissions_document_id_documents_id_fk FOREIGN KEY (document_id) REFERENCES documents(id),
  CONSTRAINT portal_submissions_kind_valid CHECK (kind IN ('policy', 'abha')),
  CONSTRAINT portal_submissions_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT portal_submissions_reviewed CHECK ((status = 'pending') = (reviewed_at IS NULL)),
  CONSTRAINT portal_submissions_reject_reason CHECK ((status = 'rejected') = (reject_reason IS NOT NULL) AND (reject_reason IS NULL OR char_length(reject_reason) BETWEEN 5 AND 300))
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_submissions_one_pending_per_kind ON portal_submissions (patient_id, kind) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS portal_submissions_status_idx ON portal_submissions (status, submitted_at);
COMMIT;
