import { getDb } from '@/db/client'
import { consentDocuments, formSubmissionConsents, formSubmissions, formTemplateConsents, signatures } from '@/db/schema'
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm'
import { renderConsentText } from '@/lib/queries/consent-documents'
import { getSubmissionPatientIdByToken } from '@/lib/queries/intake-portal'

export interface SubmissionConsent {
  formSubmissionConsentId: number
  name: string
  // Composed server-side from renderConsentText, so the client cannot render
  // wording that differs from what will be stored in
  // signatures.attestationText (spec §6). For an already-signed row it is the
  // stored attestationText itself -- what the patient actually agreed to --
  // not the document's current (possibly since-edited) wording.
  renderedText: string
  signedAt: Date | null
  signerTypedName: string | null
}

/**
 * Rows are written at send time, so detaching a consent document from a
 * template later does not change a packet already in a patient's hands. This
 * is a deliberate, narrow divergence from how questions behave
 * (getIntakePortalData reads formTemplates.questions live) -- a question
 * changing under a patient produces a confusing form, while a consent
 * changing under a patient produces a signature against something they were
 * never shown. Questions are NOT being changed to match (spec §2).
 */
// The executor is either the shared db or a transaction handle; callers that
// insert the submission row in the same unit of work (POST
// /api/form-submissions) pass their tx so both writes commit or roll back
// together -- a submission without its consent rows would fail OPEN at the
// completion gate.
type DbExecutor = Pick<ReturnType<typeof getDb>, 'select' | 'insert'>

export async function copyTemplateConsentsToSubmission(formTemplateId: number, formSubmissionId: number, db: DbExecutor = getDb()): Promise<number> {
  const attached = await db
    .select({ consentDocumentId: formTemplateConsents.consentDocumentId, sortOrder: formTemplateConsents.sortOrder })
    .from(formTemplateConsents)
    .where(eq(formTemplateConsents.formTemplateId, formTemplateId))
    .orderBy(asc(formTemplateConsents.sortOrder), asc(formTemplateConsents.id))
  if (attached.length === 0) return 0
  const created = await db
    .insert(formSubmissionConsents)
    .values(attached.map((a) => ({ formSubmissionId, consentDocumentId: a.consentDocumentId, sortOrder: a.sortOrder })))
    .returning({ id: formSubmissionConsents.id })
  return created.length
}

export async function listConsentsForSubmission(formSubmissionId: number): Promise<SubmissionConsent[]> {
  const db = getDb()
  const rows = await db
    .select({ id: formSubmissionConsents.id, name: consentDocuments.name, bodyText: consentDocuments.bodyText, legalReviewStatus: consentDocuments.legalReviewStatus })
    .from(formSubmissionConsents)
    .innerJoin(consentDocuments, eq(formSubmissionConsents.consentDocumentId, consentDocuments.id))
    .where(eq(formSubmissionConsents.formSubmissionId, formSubmissionId))
    .orderBy(asc(formSubmissionConsents.sortOrder), asc(formSubmissionConsents.id))
  if (rows.length === 0) return []

  // Latest signature per row. Filtered on BOTH signableType and signableId:
  // signableId alone would match a form_submission / admission_discharge
  // signature that happens to share a small integer id.
  const sigs = await db
    .select({ signableId: signatures.signableId, signedAt: signatures.signedAt, signerTypedName: signatures.signerTypedName, attestationText: signatures.attestationText })
    .from(signatures)
    .where(and(eq(signatures.signableType, 'form_submission_consent'), inArray(signatures.signableId, rows.map((r) => r.id))))
    .orderBy(desc(signatures.signedAt), desc(signatures.id))
  const latest = new Map<number, (typeof sigs)[number]>()
  for (const s of sigs) if (!latest.has(s.signableId)) latest.set(s.signableId, s)

  return rows.map((r) => {
    const sig = latest.get(r.id)
    return {
      formSubmissionConsentId: r.id,
      name: r.name,
      renderedText: sig ? sig.attestationText : renderConsentText(r),
      signedAt: sig?.signedAt ?? null,
      signerTypedName: sig?.signerTypedName ?? null,
    }
  })
}

// Drizzle renders a column interpolated into a select-list sql`` without its
// table qualifier, which inside this subquery would bind to signatures.id.
// Qualify the outer reference explicitly (same fix as consent-documents.ts).
const outerFscId = sql.raw('"form_submission_consents"."id"')
const isSignedSql = sql`exists (select 1 from ${signatures} where ${signatures.signableType} = 'form_submission_consent' and ${signatures.signableId} = ${outerFscId})`

// Shared by both completion gates; `scope` picks which submission(s).
// Signatures are matched on (signableType='form_submission_consent',
// signableId) via isSignedSql, never signableId alone.
async function countUnsignedConsentsWhere(scope: SQL): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(formSubmissionConsents)
    .innerJoin(formSubmissions, eq(formSubmissionConsents.formSubmissionId, formSubmissions.id))
    .where(and(scope, sql`not ${isSignedSql}`))
  return row?.n ?? 0
}

// Keyed by token, not submission id, so the completion gate in
// PUT /api/intake/[token] needs no extra id-resolution round trip.
export async function countUnsignedConsentsByToken(token: string): Promise<number> {
  return countUnsignedConsentsWhere(eq(formSubmissions.accessToken, token))
}

// Staff-side completion gate (PUT /api/form-submissions/[id]).
export async function countUnsignedConsentsBySubmissionId(formSubmissionId: number): Promise<number> {
  return countUnsignedConsentsWhere(eq(formSubmissions.id, formSubmissionId))
}

export async function hasAttachedConsents(formSubmissionId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: formSubmissionConsents.id })
    .from(formSubmissionConsents)
    .where(eq(formSubmissionConsents.formSubmissionId, formSubmissionId))
    .limit(1)
  return !!row
}

/**
 * The single ownership check for inline signing: returns null when the token
 * is unknown, expired, or already completed (via getSubmissionPatientIdByToken,
 * the one place token validity is decided) OR when the consent row belongs to
 * a different submission than the token's. Living here, the sign route cannot
 * forget it.
 */
export async function getSubmissionConsentForToken(
  token: string,
  formSubmissionConsentId: number,
): Promise<{ formSubmissionId: number; patientId: string; renderedText: string; alreadySigned: boolean } | null> {
  if (!Number.isInteger(formSubmissionConsentId) || formSubmissionConsentId <= 0) return null
  const patientId = await getSubmissionPatientIdByToken(token)
  if (!patientId) return null

  const [row] = await getDb()
    .select({
      formSubmissionId: formSubmissionConsents.formSubmissionId,
      bodyText: consentDocuments.bodyText,
      legalReviewStatus: consentDocuments.legalReviewStatus,
      alreadySigned: sql<boolean>`${isSignedSql}`,
    })
    .from(formSubmissionConsents)
    .innerJoin(formSubmissions, eq(formSubmissionConsents.formSubmissionId, formSubmissions.id))
    .innerJoin(consentDocuments, eq(formSubmissionConsents.consentDocumentId, consentDocuments.id))
    .where(and(eq(formSubmissionConsents.id, formSubmissionConsentId), eq(formSubmissions.accessToken, token)))
  if (!row) return null

  return {
    formSubmissionId: row.formSubmissionId,
    patientId,
    renderedText: renderConsentText(row),
    alreadySigned: row.alreadySigned,
  }
}
