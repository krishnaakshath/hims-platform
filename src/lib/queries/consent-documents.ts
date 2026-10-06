import { getDb } from '@/db/client'
import { consentDocuments, formTemplateConsents, formSubmissionConsents, signatures } from '@/db/schema'
import { eq, sql } from 'drizzle-orm'

export type ConsentDocument = typeof consentDocuments.$inferSelect
export type LegalReviewStatus = 'draft' | 'reviewed'

export const CONSENT_DRAFT_BANNER = '[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]'

/**
 * The exact string a signer is shown AND the exact string stored in
 * signatures.attestationText.
 *
 * The banner is derived from legalReviewStatus at render time and never
 * stored on consentDocuments: a stored copy could drift from the status
 * column. Because the composed string is what goes into the attestation, a
 * signature collected against a draft carries permanent, self-evident proof
 * that the signer was shown the warning, even after the document is later
 * marked reviewed (spec §5).
 */
export function renderConsentText(doc: { bodyText: string; legalReviewStatus: LegalReviewStatus }): string {
  if (doc.legalReviewStatus === 'reviewed') return doc.bodyText
  return `${CONSENT_DRAFT_BANNER}\n\n${doc.bodyText}`
}

export interface ConsentDocumentRow {
  id: number
  name: string
  bodyText: string
  legalReviewStatus: LegalReviewStatus
  createdAt: Date
  updatedAt: Date
  onFormsCount: number
  signedCount: number
}

// Counts are derived at read time, never stored (spec §5). The signedCount
// filters on BOTH signableType and the signableId set: signableId alone would
// also count an unrelated form_submission / admission_discharge signature
// that happens to share a small integer id.
// Drizzle renders a column interpolated into a select-list sql`` without its
// table qualifier, which inside a subquery would bind to the inner table's own
// `id`. Qualify the outer reference explicitly.
const outerDocId = sql.raw('"consent_documents"."id"')
const onFormsCountSql = sql<number>`(select count(*)::int from ${formTemplateConsents} where ${formTemplateConsents.consentDocumentId} = ${outerDocId})`
const signedCountSql = sql<number>`(select count(*)::int from ${signatures} where ${signatures.signableType} = 'form_submission_consent' and ${signatures.signableId} in (select ${formSubmissionConsents.id} from ${formSubmissionConsents} where ${formSubmissionConsents.consentDocumentId} = ${outerDocId}))`

const withCounts = {
  id: consentDocuments.id,
  name: consentDocuments.name,
  bodyText: consentDocuments.bodyText,
  legalReviewStatus: consentDocuments.legalReviewStatus,
  createdAt: consentDocuments.createdAt,
  updatedAt: consentDocuments.updatedAt,
  onFormsCount: onFormsCountSql,
  signedCount: signedCountSql,
}

export async function listConsentDocumentsWithCounts(): Promise<ConsentDocumentRow[]> {
  return getDb().select(withCounts).from(consentDocuments).orderBy(consentDocuments.name)
}

export async function getConsentDocumentWithCounts(id: number): Promise<ConsentDocumentRow | null> {
  if (!Number.isInteger(id)) return null
  const [row] = await getDb().select(withCounts).from(consentDocuments).where(eq(consentDocuments.id, id))
  return row ?? null
}

/** Cheap picker source (no counts) for the template editor's Attach control. */
export async function listConsentDocuments(): Promise<ConsentDocument[]> {
  return getDb().select().from(consentDocuments).orderBy(consentDocuments.name)
}

export async function createConsentDocument(input: { name: string; bodyText: string }): Promise<ConsentDocument> {
  const [created] = await getDb().insert(consentDocuments).values({ name: input.name, bodyText: input.bodyText }).returning()
  return created
}

export async function updateConsentDocument(
  id: number,
  patch: { name?: string; bodyText?: string; legalReviewStatus?: LegalReviewStatus },
): Promise<boolean> {
  if (!Number.isInteger(id)) return false
  const updated = await getDb()
    .update(consentDocuments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(consentDocuments.id, id))
    .returning({ id: consentDocuments.id })
  return updated.length > 0
}
