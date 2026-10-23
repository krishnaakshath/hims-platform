import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmConsents, abhaLinkOverrides, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { isUniqueViolation } from '@/lib/db-errors'
import { identityAuditEntries } from '@/lib/patient-identity'
import { normalizeAbhaAddress, normalizeAbhaNumber } from '@/lib/india/abha'
import { ENROL_CONSENT, VERIFICATION_CONSENT, type AbdmConsentGivenBy, type AbdmConsentPurpose } from '@/lib/abdm/constants'
import { getFlow, type AbhaFlow } from '@/lib/abdm/flow-store'
import { compareAbhaIdentity, type IdentityField } from '@/lib/abdm/identity-match'
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

export type ApplyAbhaResult =
  | { ok: true }
  | { ok: false; error: 'not_found' | 'abha_conflict' | 'flow_not_verified' }
  | { ok: false; error: 'identity_mismatch'; fields: IdentityField[] }

/** WS12 T5: the staff member's decision to link despite the mismatched fields they were shown. */
export type AbhaLinkOverride = { fields: IdentityField[]; reason: string }
export type ApplyAbhaOptions = { override?: AbhaLinkOverride }

async function stampConsent(tx: WriteExecutor, consentId: number | null, patientId: string): Promise<void> {
  if (consentId == null) return
  await tx.update(abdmConsents).set({ patientId }).where(and(eq(abdmConsents.id, consentId), isNull(abdmConsents.patientId)))
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]
export type VerifiedAbha = NonNullable<AbhaFlow['verified']>
export type ChartIdentity = { name: string; dob: string | null; gender: string | null }

/** The chart fields the ABDM profile is compared with (WS12 T5); null when there is no such patient. */
export async function readChartIdentity(patientId: string, db: WriteExecutor = getDb()): Promise<ChartIdentity | null> {
  const [p] = await db.select({ name: patients.name, dob: patients.dob, gender: patients.gender }).from(patients).where(eq(patients.id, patientId))
  return p ?? null
}

export type ApplyAbhaTxResult = { ok: true } | { ok: false; error: 'not_found' } | { ok: false; error: 'identity_mismatch'; fields: IdentityField[] }

/**
 * The link itself, inside the caller's transaction: locks the patient, compares
 * the ABDM profile with the locked chart (WS12 T5, spec R9), sets number,
 * address and the verification columns, stamps the consent, writes the SP1
 * identity audit rows plus 'abdm: verified ABHA'. A mismatch is refused unless
 * `override` names every mismatched field; then an abha_link_overrides row
 * (with the reason) is written and the audit says which fields, never values
 * or the reason. A unique violation (ABHA on another patient) propagates for
 * the caller to map.
 */
export async function applyVerifiedAbhaTx(
  tx: Tx, patientId: string, v: VerifiedAbha, consentId: number | null, session: Session,
  opts: ApplyAbhaOptions & { shareId?: number } = {},
): Promise<ApplyAbhaTxResult> {
  const before = await readIdentityForUpdate(tx, patientId)
  if (!before) return { ok: false, error: 'not_found' }
  const chart = await readChartIdentity(patientId, tx)
  if (!chart) return { ok: false, error: 'not_found' }
  const cmp = compareAbhaIdentity(chart, v.profile ?? null)
  const override = opts.override
  if (cmp.mismatch && (!override || cmp.mismatchedFields.some((f) => !override.fields.includes(f)))) {
    return { ok: false, error: 'identity_mismatch', fields: cmp.mismatchedFields }
  }

  const abhaNumber = normalizeAbhaNumber(v.abhaNumber)
  const abhaAddress = v.abhaAddress ? normalizeAbhaAddress(v.abhaAddress) : before.snapshot.abhaAddress
  await tx.update(patients).set({
    abhaNumber, abhaAddress, abhaUnavailableReason: null, abhaUnavailableNote: null,
    abhaVerifiedAt: new Date(), abhaVerificationSource: v.source, abhaVerifiedVia: v.via,
  }).where(eq(patients.id, patientId))
  await stampConsent(tx, consentId, patientId)
  const entries = identityAuditEntries(before.snapshot, { ...before.snapshot, abhaNumber, abhaAddress, abhaUnavailableReason: null }, false)
  for (const e of entries) await logAudit(session, e.action, patientId, e.details, tx)
  await logAudit(session, 'abdm: verified ABHA', patientId, `patient=${patientId} via=${v.via} source=${v.source}`, tx)
  if (cmp.mismatch && override) {
    await tx.insert(abhaLinkOverrides).values({
      patientId, via: opts.shareId != null ? 'scan_and_share' : 'abha_flow', shareId: opts.shareId ?? null,
      fields: cmp.mismatchedFields, reason: override.reason.trim(), byName: session.name, byUserId: session.userId,
    })
    await logAudit(session, 'abdm: linked ABHA despite identity mismatch', patientId, `fields=${cmp.mismatchedFields.join(',')}`, tx)
  }
  return { ok: true }
}

/** Links a verified flow's ABHA to an existing patient: number, address and the verification columns, in one transaction. */
export async function applyVerifiedAbha(patientId: string, flow: AbhaFlow, session: Session, opts: ApplyAbhaOptions = {}): Promise<ApplyAbhaResult> {
  const v = flow.verified
  if (!v) return { ok: false, error: 'flow_not_verified' }
  try {
    return await getDb().transaction((tx) => applyVerifiedAbhaTx(tx, patientId, v, flow.consentId, session, opts))
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
