// WS12 coverage: what is known about each of a patient's policies right now (R1, R2, R7).
// Reads only; the routes that call this audit the read. Insurer references and document URLs
// stay in the facts for the server; callers decide what leaves (never logged).
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { coverageVerifications, encounters, nhcxEligibilityChecks, patientPolicies, payerProfiles, type CoverageVerificationRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { putPrivateBlob } from '@/lib/blob-store'
import { formatCalendarDate, startOfIstDay, todayIsoIn } from '@/lib/india-time'
import { rcmFail, rcmOk, policyNotInForceMessage, type RcmWriteResult } from '@/lib/rcm/errors'
import { sha256Hex } from '@/lib/rcm/hash'
import type { ManualVerificationInput } from '@/lib/insurance/validation'
import type { EligibilityContext, EligibilityPurpose, EligibilityStatus, NhcxResponseSummary } from '@/lib/nhcx/constants'
import { readNhcxConfig } from '@/lib/integrations/config'
import {
  COVERAGE_FRESH_HOURS, MANUAL_VERIFICATION_MAX_DAYS, effectiveLimits, evaluateCoverage, manualValidUntilBounds,
  type CoverageContext, type CoverageLimits, type CoveragePolicyFacts, type CoverageVerdict, type CoverageVerificationFacts,
} from '@/lib/insurance/coverage'
import { payersOnNhcx, requestEligibility, type EligibilityDeps } from './nhcx-eligibility'
import { listPatientPolicies, type PolicyView } from './rcm-policies'
import type { WriteExecutor } from './executor'

export interface PolicyCoverage { policyId: number; verdict: CoverageVerdict; current: CoverageVerificationFacts | null; history: CoverageVerificationFacts[]; pendingCheckId: number | null; limits: CoverageLimits }
export interface CoverageSummary { primary: PolicyCoverage | null; policies: PolicyCoverage[] }

const HISTORY_LIMIT = 5

function toFacts(r: CoverageVerificationRow): CoverageVerificationFacts {
  return {
    id: r.id, source: r.source, result: r.result, verifiedAt: r.verifiedAt, validUntil: r.validUntil,
    verifiedByName: r.verifiedByName, method: r.method, insurerReference: r.insurerReference,
    hasDocument: r.documentBlobUrl !== null, // a boolean only: the URL stays on the server
    limits: { sumInsuredPaise: r.sumInsuredPaise, balancePaise: r.balancePaise, copayBp: r.copayBp, roomRentLimitPaise: r.roomRentLimitPaise, icuLimitPaise: r.icuLimitPaise },
  }
}

/**
 * The verification in force for a policy at `now` (valid_until > now): the newest answered one
 * (active or inactive); only when none is current, the newest current error. A failed re-check
 * says nothing about cover, so it never hides a current answer.
 */
export async function currentVerification(executor: WriteExecutor, policyId: number, now: Date): Promise<CoverageVerificationFacts | null> {
  const [r] = await executor.select().from(coverageVerifications)
    .where(and(eq(coverageVerifications.policyId, policyId), gt(coverageVerifications.validUntil, now)))
    .orderBy(sql`(${coverageVerifications.result} = 'error')`, desc(coverageVerifications.verifiedAt), desc(coverageVerifications.id))
    .limit(1)
  return r ? toFacts(r) : null
}

function policyLimits(p: PolicyView): CoverageLimits {
  return { sumInsuredPaise: p.sumInsuredPaise, balancePaise: null, copayBp: p.copayBp, roomRentLimitPaise: p.roomRentLimitPaise, icuLimitPaise: p.icuLimitPaise }
}

/** The primary policy: the active primary one, else the first active one; an inactive policy is never primary. */
function primaryOf(policies: readonly PolicyView[]): PolicyView | null {
  return policies.find((p) => p.status === 'active' && p.priority === 'primary') ?? policies.find((p) => p.status === 'active') ?? null
}

async function coverageOf(executor: WriteExecutor, p: PolicyView, onNhcx: boolean, context: CoverageContext, now: Date, onDate?: string): Promise<PolicyCoverage> {
  const rows = await executor.select().from(coverageVerifications).where(eq(coverageVerifications.policyId, p.id))
    .orderBy(desc(coverageVerifications.verifiedAt), desc(coverageVerifications.id)).limit(HISTORY_LIMIT)
  const history = rows.map(toFacts)
  const latest = history[0] ?? null
  const current = await currentVerification(executor, p.id, now)
  const pendingWhere = [eq(nhcxEligibilityChecks.policyId, p.id), eq(nhcxEligibilityChecks.status, 'pending')]
  if (latest) pendingWhere.push(gt(nhcxEligibilityChecks.requestedAt, latest.verifiedAt))
  const [pending] = await executor.select({ id: nhcxEligibilityChecks.id }).from(nhcxEligibilityChecks)
    .where(and(...pendingWhere)).orderBy(desc(nhcxEligibilityChecks.requestedAt), desc(nhcxEligibilityChecks.id)).limit(1)
  const pendingCheckId = pending?.id ?? null
  const own = policyLimits(p)
  const facts: CoveragePolicyFacts = { id: p.id, status: p.status, validFrom: p.validFrom, validTo: p.validTo, insurerName: p.insurer.name, onNhcx, limits: own }
  const verdict = evaluateCoverage({ policy: facts, verification: current ?? latest, pendingCheck: pendingCheckId !== null, context, now, onDate })
  return { policyId: p.id, verdict, current, history, pendingCheckId, limits: effectiveLimits(own, current?.limits ?? null) }
}

/**
 * Every policy of the patient (active first, primary first, newest) with its verdict in
 * `context`, its current verification, the last five verifications and a pending NHCX check
 * newer than the latest verification. `primary` is null when no policy is active. `onDate`
 * (default: today in IST) is the date the policy must be in force on, e.g. a pre-auth's planned
 * admission date (WS12 T8).
 */
export async function getCoverageSummary(patientId: string, context: CoverageContext, now: Date = new Date(), given?: WriteExecutor, onDate?: string): Promise<CoverageSummary> {
  const views = await listPatientPolicies(patientId, given)
  if (views.length === 0) return { primary: null, policies: [] }
  // Resolved only once there is a policy: a patient without one costs a single query.
  const executor = given ?? getDb()
  const payerIds = [...new Set(views.flatMap((p) => (p.tpa ? [p.insurer.payerId, p.tpa.payerId] : [p.insurer.payerId])))]
  const codes = await executor.select({ payerId: payerProfiles.payerId, code: payerProfiles.nhcxParticipantCode })
    .from(payerProfiles).where(inArray(payerProfiles.payerId, payerIds))
  const onNhcx = payersOnNhcx(views, new Map(codes.map((c) => [c.payerId, c.code])))
  const policies: PolicyCoverage[] = []
  for (const p of views) policies.push(await coverageOf(executor, p, onNhcx[p.id] ?? false, context, now, onDate))
  const primaryView = primaryOf(views)
  return { primary: primaryView ? policies.find((c) => c.policyId === primaryView.id) ?? null : null, policies }
}

const INSURER_REFERENCE_MAX = 64
const MAX_LIMIT_PAISE = 1_000_000_000_000
const amount = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_LIMIT_PAISE ? v : null)

/**
 * R1/R2/R6: the verification an answered NHCX eligibility check leaves, written inside the
 * transaction that settles the check. `eligible` -> active, `not_eligible` -> inactive; an
 * `error`, `no_response` or `pending` status writes nothing (null). Current for
 * COVERAGE_FRESH_HOURS. A second answer for the same check writes nothing (ON CONFLICT on
 * nhcx_check_id). The insurer reference is stored (≤ 64), never logged or returned.
 */
export async function recordNhcxVerificationTx(
  tx: WriteExecutor,
  i: { checkId: number; summary: NhcxResponseSummary; insurerReference: string | null; status: EligibilityStatus; isMock: boolean; now: Date },
): Promise<number | null> {
  const result = i.status === 'eligible' ? 'active' : i.status === 'not_eligible' ? 'inactive' : null
  if (!result) return null
  const [check] = await tx.select({
    patientId: nhcxEligibilityChecks.patientId, policyId: nhcxEligibilityChecks.policyId, context: nhcxEligibilityChecks.context,
    requestedByName: nhcxEligibilityChecks.requestedByName, requestedByUserId: nhcxEligibilityChecks.requestedByUserId, isMock: nhcxEligibilityChecks.isMock,
  }).from(nhcxEligibilityChecks).where(eq(nhcxEligibilityChecks.id, i.checkId)).limit(1)
  if (!check) return null
  const c = i.summary.coverage ?? null
  const reference = i.insurerReference?.trim().slice(0, INSURER_REFERENCE_MAX) || null
  const copay = c?.copayBp
  const [row] = await tx.insert(coverageVerifications).values({
    patientId: check.patientId, policyId: check.policyId,
    source: i.isMock || check.isMock ? 'nhcx_mock' : 'nhcx', result, context: check.context, nhcxCheckId: i.checkId,
    insurerReference: reference, verifiedByName: check.requestedByName, verifiedByUserId: check.requestedByUserId,
    verifiedAt: i.now, validUntil: new Date(i.now.getTime() + COVERAGE_FRESH_HOURS * 3_600_000),
    sumInsuredPaise: amount(c?.sumInsuredPaise), balancePaise: amount(c?.balancePaise),
    copayBp: typeof copay === 'number' && Number.isInteger(copay) && copay >= 0 && copay <= 10_000 ? copay : null,
    roomRentLimitPaise: amount(c?.roomRentLimitPaise), icuLimitPaise: amount(c?.icuLimitPaise),
    reportedValidTo: c?.benefitPeriodEnd && /^\d{4}-\d{2}-\d{2}$/.test(c.benefitPeriodEnd) ? c.benefitPeriodEnd : null,
  }).onConflictDoNothing({ target: coverageVerifications.nhcxCheckId }).returning({ id: coverageVerifications.id })
  return row?.id ?? null
}

// ---- WS12 T3: manual verification (R1, R2) ----

const DOCUMENT_EXTENSION: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png' }
const DAY_MS = 24 * 3_600_000

/**
 * R1/R2: a verification staff confirmed with the insurer or TPA themselves. The patient comes
 * from the policy. `validUntil` must lie in [today, min(today + 30, policy valid_to)] (IST);
 * the row is current until the end of that IST day. `verifiedOn` today is stamped `now`; an
 * earlier day is stamped at midday IST of that day. An optional PDF/JPEG/PNG is hashed and put
 * in the private blob store before the transaction (a failed put writes nothing; no store
 * throws ServiceNotConfiguredError). The insurer reference and blob URL are stored, never
 * logged, returned or audited.
 */
export async function recordManualVerification(
  policyId: number,
  input: ManualVerificationInput,
  file: { bytes: Uint8Array; contentType: string } | null,
  session: Session,
  now: Date = new Date(),
): Promise<RcmWriteResult<{ verificationId: number }>> {
  const [policy] = await getDb().select({ patientId: patientPolicies.patientId, validFrom: patientPolicies.validFrom, validTo: patientPolicies.validTo })
    .from(patientPolicies).where(eq(patientPolicies.id, policyId)).limit(1)
  if (!policy) return rcmFail('policy_not_found')
  const today = todayIsoIn(undefined, now)
  if (input.verifiedOn > today) return rcmFail('amounts_invalid', 'The verification date cannot be in the future')
  if (input.validUntil < today) return rcmFail('amounts_invalid', 'Valid until cannot be before today')
  if (policy.validTo < today) {
    return rcmFail('policy_not_in_force', policyNotInForceMessage(formatCalendarDate(today), formatCalendarDate(policy.validFrom), formatCalendarDate(policy.validTo)))
  }
  const { maxIso } = manualValidUntilBounds(today, policy.validTo)
  if (input.validUntil > maxIso) {
    return rcmFail('policy_not_in_force', input.validUntil > policy.validTo
      ? `Valid until cannot be after the policy ends (${formatCalendarDate(policy.validTo)})`
      : `Valid until can be at most ${MANUAL_VERIFICATION_MAX_DAYS} days from today (${formatCalendarDate(maxIso)})`)
  }

  let document: { url: string; sha256: string; contentType: string } | null = null
  if (file) {
    const ext = DOCUMENT_EXTENSION[file.contentType]
    if (!ext) return rcmFail('upload_invalid')
    const sha256 = sha256Hex(file.bytes)
    const { url } = await putPrivateBlob(`insurance/verifications/${policyId}/${randomUUID()}.${ext}`, file.bytes, file.contentType)
    document = { url, sha256, contentType: file.contentType }
  }

  const verifiedAt = input.verifiedOn === today ? now : new Date(startOfIstDay(input.verifiedOn).getTime() + DAY_MS / 2)
  const validUntil = new Date(startOfIstDay(input.validUntil).getTime() + DAY_MS)
  return getDb().transaction(async (tx) => {
    const [row] = await tx.insert(coverageVerifications).values({
      patientId: policy.patientId, policyId, source: 'manual', result: input.result, context: 'manual', method: input.method,
      insurerReference: input.reference,
      documentBlobUrl: document?.url ?? null, documentSha256: document?.sha256 ?? null, documentContentType: document?.contentType ?? null,
      verifiedByName: session.name, verifiedByUserId: session.userId, verifiedAt, validUntil,
      sumInsuredPaise: input.sumInsuredPaise ?? null, balancePaise: input.balancePaise ?? null, copayBp: input.copayBp ?? null,
      roomRentLimitPaise: input.roomRentLimitPaise ?? null, icuLimitPaise: input.icuLimitPaise ?? null,
      note: input.note || null,
    }).returning({ id: coverageVerifications.id })
    await logAudit(session, 'insurance: recorded manual verification', policy.patientId,
      `policy=${policyId} verification=${row.id} result=${input.result} method=${input.method} document=${document ? 'yes' : 'no'}`, tx)
    return rcmOk({ verificationId: row.id })
  })
}

/** Server-side only: a verification's stored document (never returned in JSON), or null when it has none. */
export async function getVerificationDocumentBlob(verificationId: number): Promise<{ url: string; contentType: string; extension: string; patientId: string; policyId: number } | null> {
  const [row] = await getDb().select({
    url: coverageVerifications.documentBlobUrl, contentType: coverageVerifications.documentContentType,
    patientId: coverageVerifications.patientId, policyId: coverageVerifications.policyId,
  }).from(coverageVerifications).where(eq(coverageVerifications.id, verificationId)).limit(1)
  if (!row?.url || !row.contentType) return null
  return { url: row.url, contentType: row.contentType, extension: DOCUMENT_EXTENSION[row.contentType] ?? 'bin', patientId: row.patientId, policyId: row.policyId }
}

// ---- WS12 T4: the automatic NHCX check after a parent action commits (R5) ----

export type EligibilitySkipReason = 'nhcx_not_configured' | 'not_on_nhcx' | 'already_verified' | 'no_doctor' | 'not_ready'
export type MaybeEligibilityResult = { started: true; checkId: number } | { started: false; reason: EligibilitySkipReason; message: string }

export const ELIGIBILITY_SKIP_MESSAGE: Record<Exclude<EligibilitySkipReason, 'not_ready'>, string> = {
  nhcx_not_configured: 'NHCX not configured: record a manual verification',
  not_on_nhcx: 'This insurer is not on NHCX: confirm cover with the insurer or TPA, then record a manual verification',
  already_verified: 'A current verification is on record: no new check was needed',
  no_doctor: 'No NHCX check started: no treating doctor is known yet. Run the check from the Insurance tab once a doctor is chosen',
}
const NOT_STARTED_MESSAGE = 'The NHCX check could not be started: run it from the Insurance tab or record a manual verification'

/** The doctor of the patient's latest non-cancelled encounter (R5), or null when there is none. */
export async function defaultEligibilityProviderId(patientId: string): Promise<number | null> {
  const [row] = await getDb().select({ providerId: encounters.providerId }).from(encounters)
    .where(and(eq(encounters.patientId, patientId), ne(encounters.status, 'cancelled')))
    .orderBy(desc(encounters.encounterDate), desc(encounters.checkedInAt), desc(encounters.id)).limit(1)
  return row?.providerId ?? null
}

/**
 * R5: start an NHCX eligibility check for a policy when it can help: NHCX available (configured
 * or the labelled mock), the policy's payer on NHCX, no current active verification and a known
 * doctor. Call it AFTER the parent transaction commits. It never throws: a business reason comes
 * back as `{ started: false, reason, message }` (`not_ready` carries requestEligibility's message,
 * e.g. the missing ROHINI/HFR copy); an unexpected error is logged by class name only and reported
 * as `not_ready`. The send itself happens after the check is written (requestEligibility).
 */
export async function maybeStartEligibility(
  i: { policyId: number; context: EligibilityContext; providerId: number | null; purpose?: EligibilityPurpose },
  session: Session,
  now: Date = new Date(),
  deps: Omit<EligibilityDeps, 'now'> = {},
): Promise<MaybeEligibilityResult> {
  const skip = (reason: EligibilitySkipReason, message: string): MaybeEligibilityResult => ({ started: false, reason, message })
  try {
    if (readNhcxConfig().state === 'not_configured') return skip('nhcx_not_configured', ELIGIBILITY_SKIP_MESSAGE.nhcx_not_configured)
    const db = getDb()
    const [policy] = await db.select({ id: patientPolicies.id, insurerPayerId: patientPolicies.insurerPayerId, tpaPayerId: patientPolicies.tpaPayerId })
      .from(patientPolicies).where(eq(patientPolicies.id, i.policyId)).limit(1)
    if (!policy) return skip('not_ready', 'Policy not found')
    const payerIds = policy.tpaPayerId ? [policy.insurerPayerId, policy.tpaPayerId] : [policy.insurerPayerId]
    const codes = await db.select({ payerId: payerProfiles.payerId, code: payerProfiles.nhcxParticipantCode }).from(payerProfiles).where(inArray(payerProfiles.payerId, payerIds))
    const onNhcx = payersOnNhcx(
      [{ id: policy.id, insurer: { payerId: policy.insurerPayerId }, tpa: policy.tpaPayerId ? { payerId: policy.tpaPayerId } : null }],
      new Map(codes.map((c) => [c.payerId, c.code])),
    )[policy.id]
    if (!onNhcx) return skip('not_on_nhcx', ELIGIBILITY_SKIP_MESSAGE.not_on_nhcx)
    const current = await currentVerification(db, policy.id, now)
    if (current?.result === 'active') return skip('already_verified', ELIGIBILITY_SKIP_MESSAGE.already_verified)
    if (i.providerId === null) return skip('no_doctor', ELIGIBILITY_SKIP_MESSAGE.no_doctor)
    const r = await requestEligibility(
      { policyId: policy.id, purpose: i.purpose ?? 'validation', context: i.context, providerId: i.providerId },
      session, { ...deps, now: () => now },
    )
    if (!r.ok) return skip('not_ready', r.message ?? NOT_STARTED_MESSAGE)
    return { started: true, checkId: r.value.checkId }
  } catch (err) {
    console.error(`[coverage] auto eligibility check failed (${err instanceof Error ? err.name : 'unknown'})`)
    return skip('not_ready', NOT_STARTED_MESSAGE)
  }
}

