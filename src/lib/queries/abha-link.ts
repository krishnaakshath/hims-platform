import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmConsents, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { identityAuditEntries } from '@/lib/patient-identity'
import { normalizeAbhaAddress, normalizeAbhaNumber } from '@/lib/india/abha'
import { ENROL_CONSENT, VERIFICATION_CONSENT, type AbdmConsentGivenBy, type AbdmConsentPurpose } from '@/lib/abdm/constants'
import { getFlow, type AbhaFlow } from '@/lib/abdm/flow-store'
import { readIdentityForUpdate } from './patient-profile'
import type { WriteExecutor } from './executor'

// SP8 ABHA linking (ruling 12): "recorded" (SP1, typed) and "verified" (ABDM
// or Scan & Share) are distinct. A verified ABHA is linked only to the
// patient the staff member chose; an ABHA already on another patient is a
// conflict, never merged. Audit details carry ids and enum values only,
// never the ABHA number or address.

export type ConsentInput = { flowId: string; patientId: string | null; purpose: AbdmConsentPurpose; givenBy: AbdmConsentGivenBy; textSha256: string }

export async function recordConsent(input: ConsentInput, session: Session): Promise<{ consentId: number }> {
  const code = input.purpose === 'abha_enrolment' ? ENROL_CONSENT : VERIFICATION_CONSENT
  return getDb().transaction(async (tx) => {
    const [row] = await tx.insert(abdmConsents).values({
      patientId: input.patientId,
      flowId: input.flowId,
      purpose: input.purpose,
      consentCode: code.code,
      consentVersion: code.version,
      textSha256: input.textSha256,
      givenBy: input.givenBy,
      recordedByName: session.name,
      recordedByUserId: session.userId,
    }).returning({ id: abdmConsents.id })
    await logAudit(session, 'abdm: recorded ABHA consent', input.patientId, `consent=${row.id} purpose=${input.purpose} given_by=${input.givenBy}`, tx)
    return { consentId: row.id }
  })
}

export type ApplyAbhaResult = { ok: true } | { ok: false; error: 'not_found' | 'abha_conflict' | 'flow_not_verified' }

async function stampConsent(tx: WriteExecutor, consentId: number | null, patientId: string): Promise<void> {
  if (consentId == null) return
  await tx.update(abdmConsents).set({ patientId }).where(and(eq(abdmConsents.id, consentId), isNull(abdmConsents.patientId)))
}

/** Links a verified flow's ABHA to an existing patient: number, address and the verification columns, in one transaction. */
export async function applyVerifiedAbha(patientId: string, flow: AbhaFlow, session: Session): Promise<ApplyAbhaResult> {
  const v = flow.verified
  if (!v) return { ok: false, error: 'flow_not_verified' }
  try {
    return await getDb().transaction(async (tx): Promise<ApplyAbhaResult> => {
      const before = await readIdentityForUpdate(tx, patientId)
      if (!before) return { ok: false, error: 'not_found' }
      const abhaNumber = normalizeAbhaNumber(v.abhaNumber)
      const abhaAddress = v.abhaAddress ? normalizeAbhaAddress(v.abhaAddress) : before.snapshot.abhaAddress
      await tx.update(patients).set({
        abhaNumber, abhaAddress, abhaUnavailableReason: null, abhaUnavailableNote: null,
        abhaVerifiedAt: new Date(), abhaVerificationSource: v.source, abhaVerifiedVia: v.via,
      }).where(eq(patients.id, patientId))
      await stampConsent(tx, flow.consentId, patientId)
      const entries = identityAuditEntries(before.snapshot, { ...before.snapshot, abhaNumber, abhaAddress, abhaUnavailableReason: null }, false)
      for (const e of entries) await logAudit(session, e.action, patientId, e.details, tx)
      await logAudit(session, 'abdm: verified ABHA', patientId, `patient=${patientId} via=${v.via} source=${v.source}`, tx)
      return { ok: true }
    })
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'abha_conflict' }
    throw e
  }
}

/**
 * Registration path (inside registerPatient's transaction): stamps the
 * verification columns only when the flow belongs to this staff member, is
 * verified, and verified the very ABHA number being registered. Otherwise it
 * does nothing and the ABHA stays "recorded, not verified".
 */
export async function consumeVerifiedAbha(tx: WriteExecutor, patientId: string, flowId: string, submittedAbhaNumber: string | null, session: Session): Promise<boolean> {
  if (!submittedAbhaNumber) return false
  const flow = await getFlow(flowId, session.name)
  const v = flow?.verified
  if (!flow || !v || normalizeAbhaNumber(v.abhaNumber) !== normalizeAbhaNumber(submittedAbhaNumber)) return false
  await tx.update(patients).set({ abhaVerifiedAt: new Date(), abhaVerificationSource: v.source, abhaVerifiedVia: v.via }).where(eq(patients.id, patientId))
  await stampConsent(tx, flow.consentId, patientId)
  await logAudit(session, 'abdm: verified ABHA', patientId, `patient=${patientId} via=${v.via} source=${v.source}`, tx)
  return true
}
