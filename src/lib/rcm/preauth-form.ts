// WS12 T8: the new pre-auth form's explanations (pure, client-safe). Why the create button is
// disabled, and how the requested amount compares with the tariff estimate. Money in paise.
import { formatPaise } from '@/lib/format'

export interface PreauthFormState { policyId: number | null; plannedAdmissionDate: string; treatingProviderId: string; estimateItems: number; diagnosisCodes: number; provisionalDiagnosisText: string }

/** What the form starts with: from the admission or visit the pre-auth is for (preauthDefaultsFor). */
export interface PreauthFormDefaults {
  admissionId: number | null; encounterId: number | null; claimType: 'ipd' | 'daycare' | 'opd'; plannedAdmissionDate: string | null
  treatingProviderId: number | null; policyId: number | null; roomCategoryCode: string | null
}

/** The fields still needed before a draft can be created, in form order, as staff read them. */
export function missingPreauthFields(s: PreauthFormState): string[] {
  const missing: string[] = []
  if (s.policyId === null) missing.push('a policy')
  if (!s.plannedAdmissionDate) missing.push('planned admission date')
  if (!s.treatingProviderId) missing.push('treating doctor')
  if (s.diagnosisCodes === 0 && !s.provisionalDiagnosisText.trim()) missing.push('a diagnosis code or provisional diagnosis')
  if (s.estimateItems === 0) missing.push('at least one estimate line')
  return missing
}

/** Above this share over the estimate, the requested amount needs an explicit confirmation. */
const CONFIRM_ABOVE_PERCENT = 25

const NONE = { level: 'none', message: null, needsConfirm: false } as const

/**
 * The requested amount against the estimate: nothing when either is unknown or they match;
 * a note when it is below, or up to 25 % above; a warning that needs confirming above 25 %.
 */
export function requestedVsEstimate(requestedPaise: number | null, estimatePaise: number | null): { level: 'none' | 'info' | 'warn'; message: string | null; needsConfirm: boolean } {
  if (requestedPaise === null || estimatePaise === null || estimatePaise <= 0 || requestedPaise === estimatePaise) return NONE
  const r = formatPaise(requestedPaise)
  const e = formatPaise(estimatePaise)
  if (requestedPaise < estimatePaise) return { level: 'info', message: `The requested ${r} is below the estimate of ${e}.`, needsConfirm: false }
  // Integer comparison: requested > estimate × 1.25.
  const warn = requestedPaise * 100 > estimatePaise * (100 + CONFIRM_ABOVE_PERCENT)
  // Rounded away from the threshold, so a warning never reads "25% above".
  const exact = ((requestedPaise - estimatePaise) * 100) / estimatePaise
  const percent = warn ? Math.ceil(exact) : Math.floor(exact)
  const above = `The requested ${r} is ${percent.toLocaleString('en-IN')}% above the estimate of ${e}.`
  if (warn) return { level: 'warn', message: `${above} Check the amount, or confirm it below.`, needsConfirm: true }
  return { level: 'info', message: above, needsConfirm: false }
}
