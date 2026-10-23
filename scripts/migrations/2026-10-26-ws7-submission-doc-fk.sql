-- 2026-10-26 WS7 T9 follow-up: portal_submissions.document_id becomes ON DELETE SET NULL, so an
-- admin deleting a portal card from the documents inbox no longer fails on the foreign key; the
-- submission keeps its decision and simply has no card. (Named to sort after
-- 2026-10-26-ws7-portal-submissions.sql, which creates the table.) Re-runnable: the constraint is
-- replaced only while it is not already SET NULL.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'portal_submissions_document_id_documents_id_fk' AND confdeltype <> 'n'
  ) THEN
    ALTER TABLE portal_submissions DROP CONSTRAINT portal_submissions_document_id_documents_id_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portal_submissions_document_id_documents_id_fk') THEN
    ALTER TABLE portal_submissions ADD CONSTRAINT portal_submissions_document_id_documents_id_fk
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL;
  END IF;
END $$;
COMMIT;
