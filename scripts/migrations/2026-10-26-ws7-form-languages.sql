-- 2026-10-26 WS7 T1: form question model v2 (spec docs/superpowers/specs/2026-10-23-operations-portal-governance-design.md D9).
--   form_templates.languages        languages a patient may read the form in; English always offered.
--   consent_documents.translations  per-language { name?, bodyText? } for hi / kn; '{}' = English only.
-- The widened questions jsonb (number, phone, file, signature, section, visibleIf, i18n) needs no DDL.
-- Additive and re-runnable: ADD COLUMN IF NOT EXISTS only.
BEGIN;

ALTER TABLE form_templates ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT '{en}'::text[];
ALTER TABLE consent_documents ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
