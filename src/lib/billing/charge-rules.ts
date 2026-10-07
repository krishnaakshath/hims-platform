// Pure, table-driven charge validation. One predicate per CHARGE_RULES row, run in table order,
// then the per-hospital configuration, then the emergency-deposit downgrade.
import { addDaysIso } from '@/lib/follow-ups/rules'
import { formatIsoDate } from '@/lib/india-time'
import { formatPaise } from '@/lib/money'
import type { ServiceCategory } from '@/lib/tariff/validation'
import { chargeProcedureCodeProblems } from '@/lib/coding/service-codes'
import type { CodeSystemKind } from '@/lib/coding/code-systems'

export const CHARGE_RULE_CODES = ['service_not_found', 'service_inactive', 'price_unresolved', 'date_outside_encounter',
  'department_mismatch', 'consultation_required', 'deposit_below_threshold', 'duplicate_charge', 'preauth_required',
  'quantity_limit', 'procedure_code_not_mapped'] as const
export type ChargeRuleCode = (typeof CHARGE_RULE_CODES)[number]
export type RuleSeverity = 'block' | 'warn'
export type ViolationField = 'serviceId' | 'quantity' | 'serviceDate' | 'unitPrice' | 'preAuthReference' | 'procedureCodes' | 'context'

export interface ChargeViolation { code: ChargeRuleCode; severity: RuleSeverity; message: string; field: ViolationField; overridable: boolean }
export interface ChargeRuleDefinition {
  code: ChargeRuleCode; label: string; defaultSeverity: RuleSeverity; configurable: boolean; overridable: boolean; field: ViolationField
}

export const CHARGE_RULES: readonly ChargeRuleDefinition[] = [
  { code: 'service_not_found', label: 'Service exists in the service master', defaultSeverity: 'block', configurable: false, overridable: false, field: 'serviceId' },
  { code: 'service_inactive', label: 'Service is active', defaultSeverity: 'block', configurable: false, overridable: false, field: 'serviceId' },
  { code: 'price_unresolved', label: 'A tariff rate or manual price covers the service', defaultSeverity: 'block', configurable: false, overridable: false, field: 'unitPrice' },
  { code: 'date_outside_encounter', label: 'Service date falls within the visit or stay', defaultSeverity: 'block', configurable: false, overridable: false, field: 'serviceDate' },
  { code: 'department_mismatch', label: 'Service belongs to the visit department', defaultSeverity: 'warn', configurable: true, overridable: false, field: 'context' },
  { code: 'consultation_required', label: 'A procedure follows a doctor consultation', defaultSeverity: 'block', configurable: true, overridable: true, field: 'context' },
  { code: 'deposit_below_threshold', label: 'Admission deposit covers procedures', defaultSeverity: 'block', configurable: true, overridable: true, field: 'context' },
  { code: 'duplicate_charge', label: 'No duplicate charge on the same day', defaultSeverity: 'block', configurable: true, overridable: true, field: 'serviceId' },
  { code: 'preauth_required', label: 'Pre-authorisation reference for payers that need it', defaultSeverity: 'block', configurable: true, overridable: false, field: 'preAuthReference' },
  { code: 'quantity_limit', label: 'Quantity within the service limit', defaultSeverity: 'block', configurable: true, overridable: true, field: 'quantity' },
  { code: 'procedure_code_not_mapped', label: 'Procedure codes are mapped to the service', defaultSeverity: 'block', configurable: true, overridable: false, field: 'procedureCodes' },
]

export interface RuleConfigEntry { enabled: boolean; severity: RuleSeverity | null }
export type RuleConfig = Partial<Record<ChargeRuleCode, RuleConfigEntry>>
export interface ChargeRuleSettings { consultationWindowDays: number; ipdDepositThresholdPaise: number }
export interface ProcedureCodeRef { kind: string; code: string }

export interface ChargeRuleInput {
  service: { id: number; departmentId: number; category: ServiceCategory; isActive: boolean; requiresPreauth: boolean; maxQuantity: number | null } | null
  quantity: number
  serviceDate: string
  today: string
  context: { departmentId: number | null; startDate: string; endDate: string | null; isInpatient: boolean; isEmergencyAdmission: boolean }
  payer: { id: number; requiresPreauth: boolean } | null      // null = self-pay
  preAuthReference: string | null
  priceResolved: boolean                                       // resolver ok, or a manual price was given
  consultationDates: string[]                                  // the patient's non-cancelled opd/ipd encounter dates
  admissionDepositPaise: number | null                         // null outside an admission
  sameDayDuplicates: number                                    // non-void lines: same patient, service, context, date
  mappedProcedureCodes: ProcedureCodeRef[]
  requestedProcedureCodes: ProcedureCodeRef[]
}

type Service = NonNullable<ChargeRuleInput['service']>
type Predicate = (input: ChargeRuleInput, service: Service, settings: ChargeRuleSettings) => string[]

const asCodeRefs = (refs: ProcedureCodeRef[]) => refs as { kind: CodeSystemKind; code: string }[]

// Predicates for the rules that need a service; the two service-existence rules are handled up front
// because they short-circuit everything else.
const PREDICATES: Record<Exclude<ChargeRuleCode, 'service_not_found' | 'service_inactive'>, Predicate> = {
  price_unresolved: (i) => (i.priceResolved ? [] : ['No tariff rate covers this service on this date; add a rate or enter a manual price']),
  date_outside_encounter: (i) => {
    if (i.serviceDate > i.today) return ['The service date cannot be in the future']
    const end = i.context.endDate ?? i.today
    if (i.serviceDate < i.context.startDate || i.serviceDate > end) {
      return [`The service date must fall within the visit or stay (${formatIsoDate(i.context.startDate)} to ${formatIsoDate(end)})`]
    }
    return []
  },
  department_mismatch: (i, s) =>
    (s.category === 'consultation' || s.category === 'procedure') && i.context.departmentId !== null && i.context.departmentId !== s.departmentId
      ? ['This service belongs to a different department from the visit'] : [],
  consultation_required: (i, s, cfg) => {
    if (s.category !== 'procedure') return []
    const from = addDaysIso(i.serviceDate, -cfg.consultationWindowDays)
    const ok = i.consultationDates.some((d) => d >= from && d <= i.serviceDate)
    return ok ? [] : [`A procedure needs a doctor consultation in the ${cfg.consultationWindowDays} days before it`]
  },
  deposit_below_threshold: (i, s, cfg) => {
    if (!i.context.isInpatient || !(s.category === 'procedure' || s.category === 'package')) return []
    const threshold = cfg.ipdDepositThresholdPaise
    if (!(threshold > 0)) return []
    const deposit = i.admissionDepositPaise ?? 0
    return deposit < threshold ? [`The admission deposit (${formatPaise(deposit)}) is below the ${formatPaise(threshold)} required before procedures`] : []
  },
  duplicate_charge: (i) => (i.sameDayDuplicates > 0 ? ['This service is already charged for this visit on this date'] : []),
  preauth_required: (i, s) =>
    i.payer?.requiresPreauth && s.requiresPreauth && !i.preAuthReference?.trim()
      ? ['This payer needs a pre-authorisation reference for this service'] : [],
  quantity_limit: (i, s) => (s.maxQuantity !== null && i.quantity > s.maxQuantity ? [`Quantity cannot exceed ${s.maxQuantity} for this service`] : []),
  // SP6 owns the comparison (unmapped service = unconstrained; kind + normalised code).
  procedure_code_not_mapped: (i) => chargeProcedureCodeProblems(asCodeRefs(i.mappedProcedureCodes), asCodeRefs(i.requestedProcedureCodes)),
}

const DEFINITION = new Map(CHARGE_RULES.map((r) => [r.code, r]))

function violation(code: ChargeRuleCode, message: string, severity?: RuleSeverity): ChargeViolation {
  const d = DEFINITION.get(code)!
  return { code, severity: severity ?? d.defaultSeverity, message, field: d.field, overridable: d.overridable }
}

export function evaluateChargeRules(input: ChargeRuleInput, settings: ChargeRuleSettings, config: RuleConfig): ChargeViolation[] {
  const service = input.service
  if (service === null) return [violation('service_not_found', 'This service is not in the service master')]
  if (!service.isActive) return [violation('service_inactive', 'This service is inactive')]

  const out: ChargeViolation[] = []
  for (const def of CHARGE_RULES) {
    if (def.code === 'service_not_found' || def.code === 'service_inactive') continue
    const messages = PREDICATES[def.code](input, service, settings)
    if (messages.length === 0) continue
    const entry = def.configurable ? config[def.code] : undefined
    if (entry && !entry.enabled) continue
    const severity: RuleSeverity = (entry && entry.severity) ?? def.defaultSeverity
    for (let message of messages) {
      let sev = severity
      if (def.code === 'deposit_below_threshold' && input.context.isEmergencyAdmission) {
        sev = 'warn'
        message += ' (emergency admission: warning only)'
      }
      out.push(violation(def.code, message, sev))
    }
  }
  return out
}

export interface RuleOverride { code: ChargeRuleCode; reason: string }
export const OVERRIDE_REASON_MIN = 5

export function appliedOverrides(violations: ChargeViolation[], overrides: RuleOverride[], canOverride: boolean): RuleOverride[] {
  if (!canOverride) return []
  const overridable = new Set(violations.filter((v) => v.severity === 'block' && v.overridable).map((v) => v.code))
  const seen = new Set<ChargeRuleCode>()
  const out: RuleOverride[] = []
  for (const o of overrides) {
    const reason = o.reason.trim()
    if (!overridable.has(o.code) || reason.length < OVERRIDE_REASON_MIN || seen.has(o.code)) continue
    seen.add(o.code)
    out.push({ code: o.code, reason })
  }
  return out
}

export function unresolvedBlocks(violations: ChargeViolation[], overrides: RuleOverride[], canOverride: boolean): ChargeViolation[] {
  const covered = new Set(appliedOverrides(violations, overrides, canOverride).map((o) => o.code))
  return violations.filter((v) => v.severity === 'block' && !covered.has(v.code))
}
