import { getDb } from '@/db/client'
import { consentDocuments, formSubmissionConsents, formSubmissions, formTemplateConsents, signatures } from '@/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { getFormTemplate } from '@/lib/queries/form-templates'

export interface AttachedConsentRow {
  formTemplateConsentId: number
  consentDocumentId: number
  name: string
  bodyPreview: string
  legalReviewStatus: 'draft' | 'reviewed'
  sortOrder: number
  signedCount: number
}

export type AttachResult =
  | { ok: true; formTemplateConsentId: number }
  | { ok: false; reason: 'duplicate' | 'no_such_document' | 'no_such_template' }

const POSTGRES_UNIQUE_VIOLATION = '23505'
const POSTGRES_FK_VIOLATION = '23503'
const PREVIEW_MAX = 80

function isUniqueViolation(error: unknown): boolean {
  // Depending on the drizzle version the pg error is either thrown directly or
  // wrapped with the original on `.cause`.
  const e = error as { code?: string; cause?: { code?: string } }
  return e?.code === POSTGRES_UNIQUE_VIOLATION || e?.cause?.code === POSTGRES_UNIQUE_VIOLATION
}

function isForeignKeyViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } }
  return e?.code === POSTGRES_FK_VIOLATION || e?.cause?.code === POSTGRES_FK_VIOLATION
}

// UI preview only -- never the signed text (that is renderConsentText).
function previewOf(bodyText: string): string {
  const firstLine = bodyText.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
  return firstLine.length > PREVIEW_MAX ? firstLine.slice(0, PREVIEW_MAX) : firstLine
}

export async function countConsentsForTemplate(formTemplateId: number): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(formTemplateConsents)
    .where(eq(formTemplateConsents.formTemplateId, formTemplateId))
  return row?.n ?? 0
}

export async function listConsentsForTemplate(formTemplateId: number): Promise<AttachedConsentRow[]> {
  // Scoped to submissions of THIS template: a signature on another template's
  // submission of the same document must not count (spec §4). Derived at read
  // time, never stored.
  const signedCountSql = sql<number>`(select count(*)::int from ${signatures} where ${signatures.signableType} = 'form_submission_consent' and ${signatures.signableId} in (select ${formSubmissionConsents.id} from ${formSubmissionConsents} inner join ${formSubmissions} on ${formSubmissions.id} = ${formSubmissionConsents.formSubmissionId} where ${formSubmissions.templateId} = ${formTemplateId} and ${formSubmissionConsents.consentDocumentId} = ${consentDocuments.id}))`
  const rows = await getDb()
    .select({
      formTemplateConsentId: formTemplateConsents.id,
      consentDocumentId: consentDocuments.id,
      name: consentDocuments.name,
      bodyText: consentDocuments.bodyText,
      legalReviewStatus: consentDocuments.legalReviewStatus,
      sortOrder: formTemplateConsents.sortOrder,
      signedCount: signedCountSql,
    })
    .from(formTemplateConsents)
    .innerJoin(consentDocuments, eq(consentDocuments.id, formTemplateConsents.consentDocumentId))
    .where(eq(formTemplateConsents.formTemplateId, formTemplateId))
    .orderBy(formTemplateConsents.sortOrder, formTemplateConsents.id)
  return rows.map(({ bodyText, ...rest }) => ({ ...rest, bodyPreview: previewOf(bodyText) }))
}

export async function attachConsentToTemplate(formTemplateId: number, consentDocumentId: number): Promise<AttachResult> {
  if (!(await getFormTemplate(formTemplateId))) return { ok: false, reason: 'no_such_template' }
  const [doc] = await getDb().select({ id: consentDocuments.id }).from(consentDocuments).where(eq(consentDocuments.id, consentDocumentId))
  if (!doc) return { ok: false, reason: 'no_such_document' }

  // max+1, not count: after a detach the count can collide with a remaining row.
  const [maxRow] = await getDb()
    .select({ m: sql<number>`coalesce(max(${formTemplateConsents.sortOrder}), -1)::int` })
    .from(formTemplateConsents)
    .where(eq(formTemplateConsents.formTemplateId, formTemplateId))
  const sortOrder = (maxRow?.m ?? -1) + 1
  try {
    const [created] = await getDb()
      .insert(formTemplateConsents)
      .values({ formTemplateId, consentDocumentId, sortOrder })
      .returning({ id: formTemplateConsents.id })
    return { ok: true, formTemplateConsentId: created.id }
  } catch (error) {
    // The unique index (template, document) is the real boundary; losing a
    // race to it is a duplicate, not a 500.
    if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate' }
    // Template or document deleted between the existence checks and the insert.
    if (isForeignKeyViolation(error)) {
      const constraint = String((error as { constraint?: string; cause?: { constraint?: string } }).constraint ?? (error as { cause?: { constraint?: string } }).cause?.constraint ?? '')
      return { ok: false, reason: constraint.includes('document') ? 'no_such_document' : 'no_such_template' }
    }
    throw error
  }
}

// Removes only the template<->document link. formSubmissionConsents and
// signatures are deliberately untouched: packets already sent keep their
// consent pages, and past signatures stay exactly where they are (spec §4).
export async function detachConsentFromTemplate(formTemplateId: number, consentDocumentId: number): Promise<boolean> {
  const deleted = await getDb()
    .delete(formTemplateConsents)
    .where(and(eq(formTemplateConsents.formTemplateId, formTemplateId), eq(formTemplateConsents.consentDocumentId, consentDocumentId)))
    .returning({ id: formTemplateConsents.id })
  return deleted.length > 0
}
