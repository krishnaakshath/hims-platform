// WS12 T9 (spec R4, R12): an admission's payer, pre-auth and deposit, kept in `admission_coverage`
// (one row per admission). Written inside the admission transaction (admitPatient's
// recordAdmissionCoverageInTx) and editable later through PUT /api/admissions/[id]/coverage.
// Audit details carry ids and enum values only.
import { and, eq, isNull, notInArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, patientPolicies, preauths } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import type { AdmissionCoverageMode, CoverageState, CoverageVerdict } from '@/lib/insurance/coverage'
import { getBillingSettings } from './billing-settings'
import { lockPatientBilling } from './billing-lock'
import { getCoverageSummary } from './coverage'
import type { WriteExecutor } from './executor'

export interface AdmissionCoverageInput {
  mode: AdmissionCoverageMode
  policyId: number | null
  preauthId: number | null
  /** Omitted: the default (R12): self-pay = billing_settings.ipd_deposit_threshold_paise, otherwise 0. */
  depositRequiredPaise?: number
}

export interface AdmissionCoverageView {
  admissionId: number
  mode: AdmissionCoverageMode
  policyId: number | null
  preauthId: number | null
  depositRequiredPaise: number
  coverageState: CoverageState
  verificationId: number | null
  recordedByName: string
  recordedAt: Date
  updatedAt: Date
}

/** Pre-auths in these states can never back an admission. */
export const CLOSED_PREAUTH_STATUSES = ['rejected', 'cancelled'] as const

export type AdmissionCoverageCheckError = 'policy_mismatch' | 'preauth_mismatch' | 'preauth_closed' | 'coverage_blocked'

export type AdmissionCoverageCheck =
  | { ok: true; verdict: CoverageVerdict }
  | { ok: false; error: AdmissionCoverageCheckError; verdict?: CoverageVerdict }

const SELF_PAY_VERDICT: CoverageVerdict = {
  state: 'no_policy', severity: 'info', label: 'Self-pay', detail: null, verifiedHoursAgo: null, isMock: false, policyId: null, verificationId: null,
}

/**
 * Validates the chosen payer for an admission of `patientId` and evaluates its cover (R4). Reads
 * only, so callers run it BEFORE any write (admitPatient: before the bed claim).
 * - The policy must be the patient's; a pre-auth must be the patient's, for that policy, and not
 *   rejected or cancelled (`preauth_closed`). `currentAdmissionId` lets an edit keep the pre-auth
 *   already linked to the same stay.
 * - Only a CASHLESS admission is evaluated in the `ipd_admission` context (the evaluator has no
 *   payment-mode input, so a self-pay or reimbursement stay must never be blocked by it). A block
 *   there is `coverage_blocked` unless `emergency`, which the evaluator turns into a warning.
 *   Reimbursement is evaluated in the `view` context: recorded, never blocked.
 */
export async function checkAdmissionCoverage(
  executor: WriteExecutor,
  i: { patientId: string; input: AdmissionCoverageInput; emergency: boolean; currentAdmissionId?: number },
  now: Date,
): Promise<AdmissionCoverageCheck> {
  const { input } = i
  if (input.mode === 'self_pay' || input.policyId === null) {
    if (input.preauthId !== null) return { ok: false, error: 'preauth_mismatch' }
    return { ok: true, verdict: SELF_PAY_VERDICT }
  }
  const [policy] = await executor.select({ patientId: patientPolicies.patientId }).from(patientPolicies).where(eq(patientPolicies.id, input.policyId)).limit(1)
  if (!policy || policy.patientId !== i.patientId) return { ok: false, error: 'policy_mismatch' }
  if (input.preauthId !== null) {
    const [pa] = await executor.select({ patientId: preauths.patientId, policyId: preauths.policyId, admissionId: preauths.admissionId, status: preauths.status })
      .from(preauths).where(eq(preauths.id, input.preauthId)).limit(1)
    if (!pa || pa.patientId !== i.patientId || pa.policyId !== input.policyId) return { ok: false, error: 'preauth_mismatch' }
    if (pa.admissionId !== null && pa.admissionId !== (i.currentAdmissionId ?? null)) return { ok: false, error: 'preauth_mismatch' }
    if ((CLOSED_PREAUTH_STATUSES as readonly string[]).includes(pa.status)) return { ok: false, error: 'preauth_closed' }
  }
  const context = input.mode === 'cashless' ? 'ipd_admission' : 'view'
  const summary = await getCoverageSummary(i.patientId, context, now, executor, undefined, i.emergency)
  const verdict = summary.policies.find((p) => p.policyId === input.policyId)?.verdict
  if (!verdict) return { ok: false, error: 'policy_mismatch' }
  if (verdict.severity === 'block') return { ok: false, error: 'coverage_blocked', verdict }
  return { ok: true, verdict }
}

/**
 * Writes (insert or replace) the admission's coverage row on the caller's executor, with the
 * verdict's state and verification. The deposit defaults per R12. Audits
 * `insurance: recorded admission coverage` with ids and enums only.
 */
export async function upsertAdmissionCoverage(
  executor: WriteExecutor,
  admissionId: number,
  patientId: string,
  input: AdmissionCoverageInput,
  verdict: CoverageVerdict,
  session: Session,
  now: Date = new Date(),
): Promise<{ depositRequiredPaise: number }> {
  const selfPay = input.mode === 'self_pay'
  const depositRequiredPaise = input.depositRequiredPaise
    ?? (selfPay ? (await getBillingSettings(executor)).ipdDepositThresholdPaise : 0)
  const values = {
    mode: input.mode,
    policyId: selfPay ? null : input.policyId,
    preauthId: selfPay ? null : input.preauthId,
    depositRequiredPaise,
    coverageState: verdict.state,
    verificationId: verdict.verificationId,
    recordedByName: session.name,
    recordedByUserId: session.userId,
  }
  await executor.insert(admissionCoverage).values({ admissionId, ...values, recordedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: admissionCoverage.admissionId, set: { ...values, updatedAt: now } })
  await logAudit(session, 'insurance: recorded admission coverage', patientId,
    `admission=${admissionId} mode=${input.mode} policy=${values.policyId ?? 'none'} preauth=${values.preauthId ?? 'none'} state=${verdict.state}`, executor)
  return { depositRequiredPaise }
}

export async function getAdmissionCoverage(admissionId: number, executor: WriteExecutor = getDb()): Promise<AdmissionCoverageView | null> {
  const [r] = await executor.select().from(admissionCoverage).where(eq(admissionCoverage.admissionId, admissionId)).limit(1)
  if (!r) return null
  return {
    admissionId: r.admissionId, mode: r.mode, policyId: r.policyId, preauthId: r.preauthId, depositRequiredPaise: r.depositRequiredPaise,
    coverageState: r.coverageState, verificationId: r.verificationId, recordedByName: r.recordedByName, recordedAt: r.recordedAt, updatedAt: r.updatedAt,
  }
}

export type UpdateAdmissionCoverageResult =
  | { ok: true; coverage: AdmissionCoverageView; verdict: CoverageVerdict; patientId: string; attendingProviderId: number }
  | { ok: false; error: 'not_found' | AdmissionCoverageCheckError; verdict?: CoverageVerdict }

/**
 * PUT /api/admissions/[id]/coverage: re-records an active admission's payer, pre-auth and deposit.
 * Same rules as at admission; emergency comes from `admissions.admission_type`. A pre-auth not yet
 * linked is linked to this stay. Lock order (as discharge): the patient billing lock, then the
 * admission row, then the pre-auth row. A discharged or unknown admission is `not_found`.
 */
export async function updateAdmissionCoverage(admissionId: number, input: AdmissionCoverageInput, session: Session, now: Date = new Date()): Promise<UpdateAdmissionCoverageResult> {
  const db = getDb()
  const [head] = await db.select({ patientId: admissions.patientId }).from(admissions).where(eq(admissions.id, admissionId)).limit(1)
  if (!head) return { ok: false, error: 'not_found' }
  return db.transaction(async (tx): Promise<UpdateAdmissionCoverageResult> => {
    await lockPatientBilling(tx, head.patientId)
    const [adm] = await tx.select({ patientId: admissions.patientId, status: admissions.status, admissionType: admissions.admissionType, attendingProviderId: admissions.attendingProviderId })
      .from(admissions).where(eq(admissions.id, admissionId)).for('update')
    if (!adm || adm.status !== 'admitted') return { ok: false, error: 'not_found' }
    const check = await checkAdmissionCoverage(tx, { patientId: adm.patientId, input, emergency: adm.admissionType === 'emergency', currentAdmissionId: admissionId }, now)
    if (!check.ok) return check
    if (input.mode !== 'self_pay' && input.preauthId !== null) {
      await tx.update(preauths).set({ admissionId, updatedAt: now })
        .where(and(eq(preauths.id, input.preauthId), isNull(preauths.admissionId), notInArray(preauths.status, [...CLOSED_PREAUTH_STATUSES])))
      const [pa] = await tx.select({ admissionId: preauths.admissionId }).from(preauths).where(eq(preauths.id, input.preauthId)).for('update')
      if (pa?.admissionId !== admissionId) return { ok: false, error: 'preauth_mismatch' }
    }
    await upsertAdmissionCoverage(tx, admissionId, adm.patientId, input, check.verdict, session, now)
    const coverage = await getAdmissionCoverage(admissionId, tx)
    if (!coverage) throw new Error('admission coverage row missing after upsert')
    return { ok: true, coverage, verdict: check.verdict, patientId: adm.patientId, attendingProviderId: adm.attendingProviderId }
  })
}
