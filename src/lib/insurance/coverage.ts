// WS12 coverage verification (spec docs/superpowers/specs/2026-10-23-insurance-verification-design.md,
// rulings R1-R7). Pure and client-safe: no DB, no env. The query layer
// (src/lib/queries/coverage.ts) loads the facts; this decides what they mean in a context.
// Relative import: src/db/schema.ts imports this module, and drizzle-kit does not resolve '@/'.
import { formatCalendarDate, todayIsoIn } from '../india-time'

/** R2: an NHCX or mock answer is current for this many hours. */
export const COVERAGE_FRESH_HOURS = 24
/** R2: a manual verification is current for at most this many days (and never past the policy end). */
export const MANUAL_VERIFICATION_MAX_DAYS = 30
export const MANUAL_VERIFICATION_DEFAULT_DAYS = 7
/** R7: room category codes whose per-day limit is the ICU limit, not the room-rent limit. */
export const ICU_ROOM_CATEGORY_CODES = ['ICU', 'HDU', 'NICU', 'PICU', 'CCU'] as const

export const VERIFICATION_SOURCES = ['nhcx', 'nhcx_mock', 'manual'] as const
export const VERIFICATION_RESULTS = ['active', 'inactive', 'error'] as const
export const VERIFICATION_METHODS = ['insurer_portal', 'tpa_portal', 'phone', 'email', 'letter'] as const
export const VERIFICATION_CONTEXTS = ['registration', 'checkin', 'admission', 'preauth', 'manual'] as const

/** R12: how an admission is paid (admission_coverage.mode). */
export const ADMISSION_COVERAGE_MODES = ['self_pay', 'cashless', 'reimbursement'] as const
export type AdmissionCoverageMode = (typeof ADMISSION_COVERAGE_MODES)[number]

export type VerificationSource = (typeof VERIFICATION_SOURCES)[number]
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number]
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number]
export type VerificationContext = (typeof VERIFICATION_CONTEXTS)[number]

/** Where the verdict is used; decides severity (R4). */
export type CoverageContext = 'view' | 'registration' | 'opd_checkin' | 'ipd_admission' | 'preauth'

/** Every verdict state, in the order of evaluation. admission_coverage.coverage_state is checked against it. */
export const COVERAGE_STATES = [
  'no_policy', 'policy_inactive', 'policy_not_started', 'policy_expired',
  'verified_active', 'verified_inactive', 'verification_error', 'pending', 'stale', 'unverified',
] as const
export type CoverageState = 'no_policy' | 'policy_inactive' | 'policy_not_started' | 'policy_expired'
  | 'verified_active' | 'verified_inactive' | 'verification_error' | 'pending' | 'stale' | 'unverified'

export interface CoverageLimits { sumInsuredPaise: number | null; balancePaise: number | null; copayBp: number | null; roomRentLimitPaise: number | null; icuLimitPaise: number | null }
export interface CoveragePolicyFacts { id: number; status: 'active' | 'inactive'; validFrom: string; validTo: string; insurerName: string; onNhcx: boolean; limits: CoverageLimits }
export interface CoverageVerificationFacts { id: number; source: (typeof VERIFICATION_SOURCES)[number]; result: (typeof VERIFICATION_RESULTS)[number]; verifiedAt: Date; validUntil: Date; verifiedByName: string; method: string | null; insurerReference: string | null; /** A confirmation document is stored; only this flag leaves, never its URL. */ hasDocument: boolean; limits: CoverageLimits }
export interface CoverageVerdict { state: CoverageState; severity: 'ok' | 'info' | 'warn' | 'block'; label: string; detail: string | null; verifiedHoursAgo: number | null; isMock: boolean; policyId: number | null; verificationId: number | null }

export const MOCK_LABEL = 'Sandbox mock - not real'

const SOURCE_LABEL: Record<VerificationSource, string> = { nhcx: 'NHCX', nhcx_mock: 'NHCX sandbox mock', manual: 'manual check' }
const METHOD_LABEL: Record<VerificationMethod, string> = { insurer_portal: 'insurer portal', tpa_portal: 'TPA portal', phone: 'phone', email: 'email', letter: 'letter' }

/** 'less than an hour ago' | '1 hour ago' | 'N hours ago' | 'N days ago' (from 48 hours). */
export function hoursAgoLabel(hours: number): string {
  const h = Math.max(0, Math.floor(hours))
  if (h < 1) return 'less than an hour ago'
  if (h === 1) return '1 hour ago'
  if (h < 48) return `${h} hours ago`
  return `${Math.floor(h / 24)} days ago`
}

/** R7: per field, the current verification's value where it gave one, else the policy's own. */
export function effectiveLimits(policy: CoverageLimits, verification: CoverageLimits | null): CoverageLimits {
  const pick = <K extends keyof CoverageLimits>(k: K) => verification?.[k] ?? policy[k]
  return {
    sumInsuredPaise: pick('sumInsuredPaise'), balancePaise: pick('balancePaise'), copayBp: pick('copayBp'),
    roomRentLimitPaise: pick('roomRentLimitPaise'), icuLimitPaise: pick('icuLimitPaise'),
  }
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
const minIso = (a: string, b: string) => (a < b ? a : b)

/** R2: a manual verification's "valid until" date: default today + 7, at most today + 30, never after the policy end. */
export function manualValidUntilBounds(todayIso: string, policyValidTo: string): { defaultIso: string; maxIso: string } {
  return {
    defaultIso: minIso(addDaysIso(todayIso, MANUAL_VERIFICATION_DEFAULT_DAYS), policyValidTo),
    maxIso: minIso(addDaysIso(todayIso, MANUAL_VERIFICATION_MAX_DAYS), policyValidTo),
  }
}

type Severity = CoverageVerdict['severity']

/** R4: a blocking condition blocks only at IPD admission (unless emergency) and pre-auth; elsewhere it warns. */
function blockOrWarn(context: CoverageContext, emergency: boolean): Severity {
  if (context === 'preauth') return 'block'
  if (context === 'ipd_admission') return emergency ? 'warn' : 'block'
  return 'warn'
}
/** Missing, stale, pending or failed verification: a warning where the insurer is about to be relied on. */
function attention(context: CoverageContext): Severity {
  return context === 'ipd_admission' || context === 'preauth' ? 'warn' : 'info'
}

function verifiedBy(v: CoverageVerificationFacts): string {
  const how = v.source === 'manual' && v.method && v.method in METHOD_LABEL ? `${SOURCE_LABEL.manual} by ${METHOD_LABEL[v.method as VerificationMethod]}` : SOURCE_LABEL[v.source]
  const mock = v.source === 'nhcx_mock' ? ` (${MOCK_LABEL})` : ''
  return `Verified by ${v.verifiedByName} via ${how}${mock}`
}

export function evaluateCoverage(i: { policy: CoveragePolicyFacts | null; verification: CoverageVerificationFacts | null; pendingCheck: boolean; context: CoverageContext; now: Date; emergency?: boolean; onDate?: string }): CoverageVerdict {
  const { policy, verification, context, now } = i
  const emergency = i.emergency === true
  const hoursAgo = verification ? Math.max(0, Math.floor((now.getTime() - verification.verifiedAt.getTime()) / 3_600_000)) : null
  const verdict = (state: CoverageState, severity: Severity, label: string, detail: string | null, fromVerification: boolean): CoverageVerdict => ({
    state, severity, label, detail,
    verifiedHoursAgo: hoursAgo,
    isMock: fromVerification && verification?.source === 'nhcx_mock',
    policyId: policy?.id ?? null,
    verificationId: verification?.id ?? null,
  })

  if (!policy) {
    return verdict('no_policy', context === 'ipd_admission' || context === 'preauth' ? 'warn' : 'info', 'No insurance policy on file', 'Treat as self-pay or add the policy', false)
  }

  // R3: validity is computed from the dates (IST calendar), never written.
  const onDate = i.onDate ?? todayIsoIn(undefined, now)
  const range = `valid ${formatCalendarDate(policy.validFrom)} to ${formatCalendarDate(policy.validTo)}`
  const policyState: CoverageState | null = policy.status !== 'active' ? 'policy_inactive'
    : policy.validTo < onDate ? 'policy_expired'
    : policy.validFrom > onDate ? 'policy_not_started'
    : null
  if (policyState) {
    const severity = blockOrWarn(context, emergency)
    const label = policyState === 'policy_inactive' ? 'Policy marked inactive'
      : policyState === 'policy_expired' ? `Policy expired on ${formatCalendarDate(policy.validTo)}`
      : `Policy not valid until ${formatCalendarDate(policy.validFrom)}`
    const reason = policyState === 'policy_inactive' ? 'This policy is marked inactive' : `This policy is not valid on ${formatCalendarDate(onDate)} (${range})`
    const next = context === 'ipd_admission' && emergency ? 'Emergency admission: proceed, and settle cover or self-pay later'
      : severity === 'block' ? 'Fix the policy dates or status, or treat as self-pay'
      : 'Treat as self-pay or update the policy'
    return verdict(policyState, severity, label, `${reason}. ${next}.`, false)
  }

  const current = verification !== null && verification.validUntil.getTime() > now.getTime() ? verification : null
  if (current) {
    if (current.result === 'active') {
      return verdict('verified_active', 'ok', `Policy valid, verified ${hoursAgoLabel(hoursAgo ?? 0)}`, verifiedBy(current), true)
    }
    if (current.result === 'inactive') {
      return verdict('verified_inactive', blockOrWarn(context, emergency), 'Insurer says the policy is not in force', `${verifiedBy(current)}. Treat as self-pay or check with the insurer.`, true)
    }
    return verdict('verification_error', attention(context), 'Verification failed', `The last check ${hoursAgoLabel(hoursAgo ?? 0)} returned an error: verify again or record a manual verification.${current.source === 'nhcx_mock' ? ` ${MOCK_LABEL}.` : ''}`, true)
  }
  if (i.pendingCheck) {
    return verdict('pending', attention(context), 'Verification in progress', "Waiting for the insurer's answer", false)
  }
  if (verification) {
    return verdict('stale', attention(context), 'Verification out of date', `Last verified ${hoursAgoLabel(hoursAgo ?? 0)}: verify again before relying on the cover`, true)
  }
  return verdict('unverified', attention(context), 'Not verified', policy.onNhcx ? 'No verification on record: run an NHCX check or record a manual verification' : 'No verification on record: record a manual verification', false)
}

