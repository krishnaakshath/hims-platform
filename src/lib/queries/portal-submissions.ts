// WS7 T9 (spec D15): portal self-service policy and ABHA submissions. A patient's upload lands in
// portal_submissions as 'pending' (one per patient and kind). The front desk approves it -- the
// real policy through createPolicy, or the ABHA recorded on the chart through
// updatePatientProfile, "Recorded, not verified with ABDM" -- or rejects it with a reason the
// patient sees. Staff stay the gatekeepers of master data: nothing the patient types reaches a
// policy or the chart until a reviewer decides. The decision, the master-data write and the audit
// row commit together (createPolicy / updatePatientProfile run as savepoints in one transaction).
// Card images go only through the private blob store; no blob URL leaves this module. Audit
// details carry ids, kinds and counts only -- never policy numbers, ABHA numbers or names.
import { randomUUID } from 'node:crypto'
import { and, asc, count, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '@/db/client'
import {
  documents, patientPolicies, patients, portalSubmissions,
  type PortalSubmissionAbhaPayload, type PortalSubmissionPolicyPayload,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Role, Session } from '@/lib/auth'
import { putPrivateBlob, readPrivateBlob } from '@/lib/blob-store'
import { isUniqueViolation } from '@/lib/db-errors'
import { formatAbhaNumber, isValidAbhaAddress, isValidAbhaNumber, normalizeAbhaAddress, normalizeAbhaNumber } from '@/lib/india/abha'
import { todayIsoIn } from '@/lib/india-time'
import { isoDateSchema } from '@/lib/follow-ups/validation'
import { MAX_DOCUMENT_PAISE } from '@/lib/billing/amounts'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { looksLikeNationalId, NATIONAL_ID_MESSAGE } from '@/lib/rcm/identifier-guard'
import { RCM_ERROR_MESSAGE, RCM_ERROR_STATUS } from '@/lib/rcm/errors'
import { sha256Hex } from '@/lib/rcm/hash'
import { policySchema } from '@/lib/rcm/validation'
import type { SniffedUpload } from '@/lib/upload-sniff'
import { createPolicy } from './rcm-policies'
import { updatePatientProfile } from './patient-profile'

export type PortalSubmissionKind = 'policy' | 'abha'
export type PortalSubmissionStatus = 'pending' | 'approved' | 'rejected'

// ---- the patient's fields (multipart form values are strings) --------------------------------

export const portalPolicyFieldsSchema = z.object({
  kind: z.literal('policy'),
  insurerName: z.string().trim().min(2, 'Enter the insurance company').max(120),
  policyNumber: z.string().trim().min(3, 'Enter the policy number').max(40)
    .regex(/^[A-Za-z0-9/-]+$/, 'Use letters, digits, / and - only')
    .refine((v) => !looksLikeNationalId(v), NATIONAL_ID_MESSAGE),
  validFrom: isoDateSchema,
  validTo: isoDateSchema,
  sumInsuredPaise: z.string().regex(/^\d{1,13}$/).transform(Number).pipe(z.number().int().min(0).max(MAX_DOCUMENT_PAISE)).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.validTo < v.validFrom) ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'The policy end date is before its start' })
})

export const portalAbhaFieldsSchema = z.object({
  kind: z.literal('abha'),
  abhaNumber: z.string().transform(normalizeAbhaNumber).refine(isValidAbhaNumber, 'Enter your 14-digit ABHA number'),
  abhaAddress: z.string().transform(normalizeAbhaAddress).refine(isValidAbhaAddress, 'Enter a valid ABHA address').optional(),
}).strict()

export type PortalSubmissionInput =
  | { kind: 'policy'; payload: PortalSubmissionPolicyPayload }
  | { kind: 'abha'; payload: PortalSubmissionAbhaPayload }

export type CardUpload = { bytes: Uint8Array } & SniffedUpload

const CARD_EXTENSION: Record<SniffedUpload['contentType'], string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }
const CARD_NAME: Record<PortalSubmissionKind, string> = { policy: 'Insurance card (patient portal)', abha: 'ABHA card (patient portal)' }

// ---- patient writes and reads ----------------------------------------------------------------

/** The pending check runs before any file is stored; a race on the partial unique index is the same refusal. */
export async function createPortalSubmission(
  patientId: string, input: PortalSubmissionInput, card?: CardUpload,
): Promise<{ ok: true; id: number } | { ok: false; error: 'pending_exists' }> {
  const db = getDb()
  const [pending] = await db.select({ id: portalSubmissions.id }).from(portalSubmissions)
    .where(and(eq(portalSubmissions.patientId, patientId), eq(portalSubmissions.kind, input.kind), eq(portalSubmissions.status, 'pending'))).limit(1)
  if (pending) return { ok: false, error: 'pending_exists' }

  const blob = card ? await putPrivateBlob(`portal-submissions/${randomUUID()}.${CARD_EXTENSION[card.contentType]}`, card.bytes, card.contentType) : null
  try {
    const id = await db.transaction(async (tx) => {
      let documentId: number | null = null
      if (card && blob) {
        const [doc] = await tx.insert(documents).values({
          name: CARD_NAME[input.kind], documentDate: todayIsoIn(), receivedFrom: 'Patient portal', documentType: 'other',
          patientId, fileUrl: blob.url, fileType: card.fileType,
        }).returning({ id: documents.id })
        documentId = doc.id
      }
      const [row] = await tx.insert(portalSubmissions).values({ patientId, kind: input.kind, payload: input.payload, documentId }).returning({ id: portalSubmissions.id })
      await logPatientPortalAction('patient portal: submitted self-service', patientId, `submission=${row.id} kind=${input.kind} cards=${documentId === null ? 0 : 1}`, tx)
      return row.id
    })
    return { ok: true, id }
  } catch (err) {
    if (isUniqueViolation(err, 'portal_submissions_one_pending_per_kind')) return { ok: false, error: 'pending_exists' }
    throw err
  }
}

export interface PortalSubmissionForPatient {
  id: number; kind: PortalSubmissionKind; status: PortalSubmissionStatus; summary: string
  submittedAt: Date; reviewedAt: Date | null; rejectReason: string | null
}

const maskAbha = (digits: string) => `XX-XXXX-XXXX-${digits.slice(-4)}`

/** The patient's own submissions, newest first (the last 20). The ABHA number is masked. */
export async function listPortalSubmissionsForPatient(patientId: string): Promise<PortalSubmissionForPatient[]> {
  const rows = await getDb().select().from(portalSubmissions).where(eq(portalSubmissions.patientId, patientId))
    .orderBy(desc(portalSubmissions.submittedAt), desc(portalSubmissions.id)).limit(20)
  return rows.map((r) => ({
    id: r.id, kind: r.kind, status: r.status, submittedAt: r.submittedAt, reviewedAt: r.reviewedAt, rejectReason: r.rejectReason,
    summary: r.kind === 'policy'
      ? `${(r.payload as PortalSubmissionPolicyPayload).insurerName} · ${(r.payload as PortalSubmissionPolicyPayload).policyNumber}`
      : `ABHA ${maskAbha((r.payload as PortalSubmissionAbhaPayload).abhaNumber)}`,
  }))
}

// ---- staff reads -----------------------------------------------------------------------------

export interface PendingPortalSubmission {
  id: number; kind: PortalSubmissionKind; patientId: string; patientName: string; uhid: string | null
  submittedAt: Date; details: { label: string; value: string }[]; hasCard: boolean; documentId: number | null
}

/** Roles that see the full ABHA number in the queue; others (rcm: no identity numbers) see it masked. */
const ABHA_FULL_ROLES: readonly Role[] = ['admin', 'frontdesk']

export async function listPendingPortalSubmissions(viewerRole: Role): Promise<PendingPortalSubmission[]> {
  const rows = await getDb()
    .select({ s: portalSubmissions, patientName: patients.name, uhid: patients.uhid })
    .from(portalSubmissions)
    .innerJoin(patients, eq(patients.id, portalSubmissions.patientId))
    .where(eq(portalSubmissions.status, 'pending'))
    .orderBy(asc(portalSubmissions.submittedAt), asc(portalSubmissions.id))
    .limit(200)
  return rows.map(({ s, patientName, uhid }) => {
    let details: { label: string; value: string }[]
    if (s.kind === 'policy') {
      const p = s.payload as PortalSubmissionPolicyPayload
      details = [
        { label: 'Insurer (as typed)', value: p.insurerName },
        { label: 'Policy number', value: p.policyNumber },
        { label: 'Valid', value: `${p.validFrom} to ${p.validTo}` },
        ...(p.sumInsuredPaise === undefined ? [] : [{ label: 'Sum insured (paise)', value: String(p.sumInsuredPaise) }]),
      ]
    } else {
      const a = s.payload as PortalSubmissionAbhaPayload
      details = [
        { label: 'ABHA number', value: ABHA_FULL_ROLES.includes(viewerRole) ? formatAbhaNumber(a.abhaNumber) : maskAbha(a.abhaNumber) },
        ...(a.abhaAddress ? [{ label: 'ABHA address', value: ABHA_FULL_ROLES.includes(viewerRole) ? a.abhaAddress : 'On file' }] : []),
      ]
    }
    return { id: s.id, kind: s.kind, patientId: s.patientId, patientName, uhid, submittedAt: s.submittedAt, details, hasCard: s.documentId !== null, documentId: s.documentId }
  })
}

export async function countPendingPortalSubmissions(): Promise<number> {
  const [r] = await getDb().select({ n: count() }).from(portalSubmissions).where(eq(portalSubmissions.status, 'pending'))
  return Number(r?.n ?? 0)
}

// ---- the decision ----------------------------------------------------------------------------

export type PortalSubmissionDecision =
  | { decision: 'approve'; insurerPayerId?: number; tpaPayerId?: number | null }
  | { decision: 'reject'; reason: string }

export type DecisionError = 'not_found' | 'already_decided' | 'insurer_required' | 'not_a_policy' | 'invalid' | 'abha_in_use' | 'abha_verified' | 'policy_refused'
export type DecisionResult =
  | { ok: true; patientId: string; policyId?: number }
  | { ok: false; error: DecisionError; status: 400 | 404 | 409 | 422; message: string }

const fail = (error: DecisionError, status: 400 | 404 | 409 | 422, message: string): DecisionResult => ({ ok: false, error, status, message })

export async function decidePortalSubmission(id: number, decision: PortalSubmissionDecision, session: Session, now: Date = new Date()): Promise<DecisionResult> {
  const db = getDb()
  const [found] = await db.select().from(portalSubmissions).where(eq(portalSubmissions.id, id)).limit(1)
  if (!found) return fail('not_found', 404, 'Submission not found')
  if (found.status !== 'pending') return fail('already_decided', 409, 'This submission has already been decided')

  if (decision.decision === 'approve') {
    if (found.kind === 'policy' && decision.insurerPayerId === undefined) return fail('insurer_required', 400, 'Choose the insurer for this policy')
    if (found.kind === 'abha' && (decision.insurerPayerId !== undefined || decision.tpaPayerId !== undefined)) return fail('not_a_policy', 400, 'An ABHA submission takes no insurer')
  }

  // A policy card is copied into the policy's own card slot (the document may later be deleted
  // from the documents inbox). The copy is stored before the transaction, as uploadPolicyCard does.
  let cardCopy: { url: string; sha256: string } | null = null
  if (decision.decision === 'approve' && found.kind === 'policy' && found.documentId !== null) {
    const [doc] = await db.select({ fileUrl: documents.fileUrl }).from(documents).where(eq(documents.id, found.documentId)).limit(1)
    const file = doc?.fileUrl ? await readPrivateBlob(doc.fileUrl) : null
    const ext = file ? CARD_EXTENSION[file.contentType as SniffedUpload['contentType']] : undefined
    if (file && ext) {
      const { url } = await putPrivateBlob(`rcm/policies/portal-${id}/${randomUUID()}.${ext}`, file.bytes, file.contentType)
      cardCopy = { url, sha256: sha256Hex(file.bytes) }
    }
  }

  let result: DecisionResult
  try {
    result = await db.transaction(async (tx) => {
      const [sub] = await tx.select().from(portalSubmissions).where(eq(portalSubmissions.id, id)).for('update')
      if (!sub) return fail('not_found', 404, 'Submission not found')
      if (sub.status !== 'pending') return fail('already_decided', 409, 'This submission has already been decided')
      const decided = { reviewedByName: session.name, reviewedAt: now }

      if (decision.decision === 'reject') {
        await tx.update(portalSubmissions).set({ ...decided, status: 'rejected', rejectReason: decision.reason }).where(eq(portalSubmissions.id, id))
        await logAudit(session, 'rejected portal submission', sub.patientId, `submission=${id} kind=${sub.kind}`, tx)
        return { ok: true, patientId: sub.patientId }
      }

      const [patient] = await tx.select({ name: patients.name, abhaVerifiedAt: patients.abhaVerifiedAt }).from(patients).where(eq(patients.id, sub.patientId)).for('update')
      if (!patient) return fail('not_found', 404, 'Patient not found')

      if (sub.kind === 'policy') {
        const p = sub.payload as PortalSubmissionPolicyPayload
        const [primary] = await tx.select({ id: patientPolicies.id }).from(patientPolicies)
          .where(and(eq(patientPolicies.patientId, sub.patientId), eq(patientPolicies.status, 'active'), eq(patientPolicies.priority, 'primary'))).limit(1)
        const priority = primary ? 'secondary' : 'primary'
        const parsed = policySchema.safeParse({
          patientId: sub.patientId, insurerPayerId: decision.insurerPayerId, tpaPayerId: decision.tpaPayerId ?? null,
          policyNumber: p.policyNumber, memberId: p.policyNumber, policyType: 'individual', holderName: patient.name.slice(0, 200), relationship: 'self',
          validFrom: p.validFrom, validTo: p.validTo, sumInsuredPaise: p.sumInsuredPaise ?? null, priority, status: 'active',
        })
        if (!parsed.success) return fail('invalid', 400, 'The submitted policy details are not valid; reject it with a reason')
        const created = await createPolicy(parsed.data, session, now, tx)
        if (!created.ok) {
          const status = RCM_ERROR_STATUS[created.error]
          return fail('policy_refused', status === 403 ? 409 : status, created.message ?? RCM_ERROR_MESSAGE[created.error])
        }
        const policyId = created.value.policyId
        if (cardCopy) await tx.update(patientPolicies).set({ cardFrontBlobUrl: cardCopy.url, cardFrontSha256: cardCopy.sha256 }).where(eq(patientPolicies.id, policyId))
        if (sub.documentId !== null) {
          await tx.update(documents).set({
            documentType: priority === 'primary' ? 'insurance_card_primary_front' : 'insurance_card_secondary_front',
            status: 'processed', filedByName: session.name, filedAt: now,
          }).where(eq(documents.id, sub.documentId))
        }
        await tx.update(portalSubmissions).set({ ...decided, status: 'approved' }).where(eq(portalSubmissions.id, id))
        await logAudit(session, 'approved portal submission', sub.patientId, `submission=${id} kind=policy policy=${policyId}`, tx)
        return { ok: true, patientId: sub.patientId, policyId }
      }

      // ABHA: recorded on the chart as typed, never stamped verified (abha_verified_* stay null).
      // A chart whose ABHA is already verified with ABDM is changed only from the chart itself.
      if (patient.abhaVerifiedAt !== null) return fail('abha_verified', 409, "This patient's ABHA is already verified with ABDM; change it from the patient's chart")
      const a = sub.payload as PortalSubmissionAbhaPayload
      await updatePatientProfile(sub.patientId, { abha: { status: 'provided', abhaNumber: a.abhaNumber, abhaAddress: a.abhaAddress } }, session, tx)
      if (sub.documentId !== null) {
        await tx.update(documents).set({ status: 'processed', filedByName: session.name, filedAt: now }).where(eq(documents.id, sub.documentId))
      }
      await tx.update(portalSubmissions).set({ ...decided, status: 'approved' }).where(eq(portalSubmissions.id, id))
      await logAudit(session, 'approved portal submission', sub.patientId, `submission=${id} kind=abha`, tx)
      return { ok: true, patientId: sub.patientId }
    })
  } catch (err) {
    if (isUniqueViolation(err, 'patients_abha_number_unique')) return fail('abha_in_use', 409, 'This ABHA number is already registered to another patient')
    if (isUniqueViolation(err, 'patients_abha_address_unique')) return fail('abha_in_use', 409, 'This ABHA address is already registered to another patient')
    throw err
  }
  return result
}

/** The kinds this patient has pending (the portal hides that form until it is decided). */
export async function pendingKindsForPatient(patientId: string): Promise<PortalSubmissionKind[]> {
  const rows = await getDb().select({ kind: portalSubmissions.kind }).from(portalSubmissions)
    .where(and(eq(portalSubmissions.patientId, patientId), eq(portalSubmissions.status, 'pending')))
  return rows.map((r) => r.kind)
}
