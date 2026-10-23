-- 2026-10-26 WS8 T14: data_principal_requests, the DPDP data-principal request register (spec
-- docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D18). One row per access,
-- correction, erasure or grievance request; due_by is 30 days after received_at. patient_id is
-- nullable: an erasure that deletes the chart clears it, and the register entry is kept.
-- export_blob_url is the private-store URL of the prepared export bundle (never sent to a client).
-- Mirrors src/db/schema.ts (// WS8 T14). Additive, idempotent, safe to re-run. Requires patients.
BEGIN;
CREATE TABLE IF NOT EXISTS data_principal_requests (
  id serial PRIMARY KEY,
  reference text NOT NULL,
  patient_id text,
  kind text NOT NULL,
  received_via text NOT NULL,
  received_at date NOT NULL,
  due_by date NOT NULL,
  status text NOT NULL DEFAULT 'received',
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  export_blob_url text,
  note text,
  decision_note text,
  handled_by_name text,
  created_at timestamp NOT NULL DEFAULT now(),
  closed_at timestamp,
  CONSTRAINT data_principal_requests_reference_unique UNIQUE (reference),
  CONSTRAINT data_principal_requests_patient_id_patients_id_fk FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT data_principal_requests_reference_format CHECK (reference ~ '^DPR-[0-9]{4}-[0-9]{6,}$'),
  CONSTRAINT data_principal_requests_kind_valid CHECK (kind IN ('access', 'correction', 'erasure', 'grievance')),
  CONSTRAINT data_principal_requests_via_valid CHECK (received_via IN ('email', 'portal_message', 'letter', 'in_person')),
  CONSTRAINT data_principal_requests_status_valid CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
  CONSTRAINT data_principal_requests_closed CHECK ((status IN ('completed', 'rejected')) = (closed_at IS NOT NULL)),
  CONSTRAINT data_principal_requests_due_after_receipt CHECK (due_by >= received_at),
  CONSTRAINT data_principal_requests_checklist_object CHECK (jsonb_typeof(checklist) = 'object')
);
CREATE INDEX IF NOT EXISTS data_principal_requests_patient_idx ON data_principal_requests (patient_id);
CREATE INDEX IF NOT EXISTS data_principal_requests_open_due_idx ON data_principal_requests (due_by) WHERE closed_at IS NULL;
COMMIT;
