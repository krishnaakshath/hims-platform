import { describe, expect, it } from 'vitest'
import {
  CHARGE_RULES, CHARGE_RULE_CODES, OVERRIDE_REASON_MIN, appliedOverrides, evaluateChargeRules, unresolvedBlocks,
  type ChargeRuleInput, type ChargeViolation,
} from '@/lib/billing/charge-rules'

const base: ChargeRuleInput = { service: { id: 1, departmentId: 10, category: 'procedure', isActive: true, requiresPreauth: false, maxQuantity: null },
  quantity: 1, serviceDate: '2026-10-20', today: '2026-10-20',
  context: { departmentId: 10, startDate: '2026-10-20', endDate: null, isInpatient: false, isEmergencyAdmission: false },
  payer: null, preAuthReference: null, priceResolved: true, consultationDates: ['2026-10-20'], admissionDepositPaise: null,
  sameDayDuplicates: 0, mappedProcedureCodes: [], requestedProcedureCodes: [], preAuthCheck: null, coverage: null }
const S = { consultationWindowDays: 30, ipdDepositThresholdPaise: 0 }
const codes = (v: ChargeViolation[]) => v.map((x) => x.code)
const svc = (over: Partial<NonNullable<ChargeRuleInput['service']>>) => ({ ...base.service!, ...over })

describe('charge rule engine', () => {
  it('a clean procedure has no violations', () => { expect(evaluateChargeRules(base, S, {})).toEqual([]) })
  it('a missing service short-circuits every other rule', () => {
    expect(codes(evaluateChargeRules({ ...base, service: null, priceResolved: false }, S, {}))).toEqual(['service_not_found'])
    expect(evaluateChargeRules({ ...base, service: null }, S, {})[0]).toMatchObject({ severity: 'block', field: 'serviceId', overridable: false, message: 'This service is not in the service master' })
  })
  it('an inactive service short-circuits every other rule', () => {
    const v = evaluateChargeRules({ ...base, service: svc({ isActive: false }), priceResolved: false, sameDayDuplicates: 2 }, S, {})
    expect(v).toEqual([expect.objectContaining({ code: 'service_inactive', message: 'This service is inactive' })])
  })
  it('price unresolved', () => {
    expect(evaluateChargeRules({ ...base, priceResolved: false }, S, {})[0]).toMatchObject({
      code: 'price_unresolved', field: 'unitPrice', overridable: false,
      message: 'No tariff rate covers this service on this date; add a rate or enter a manual price',
    })
  })
  it('blocks a procedure with no consultation in the window, and accepts one exactly N days back', () => {
    expect(codes(evaluateChargeRules({ ...base, consultationDates: ['2026-09-19'] }, S, {}))).toEqual(['consultation_required'])
    expect(evaluateChargeRules({ ...base, consultationDates: ['2026-09-20'] }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, consultationDates: ['2026-09-19'] }, S, {})[0]).toMatchObject({
      overridable: true, field: 'context', message: 'A procedure needs a doctor consultation in the 30 days before it',
    })
  })
  it('a consultation after the service date does not count', () => {
    expect(codes(evaluateChargeRules({ ...base, consultationDates: ['2026-10-21'] }, S, {}))).toEqual(['consultation_required'])
  })
  it('consultation is only required for procedures', () => {
    expect(evaluateChargeRules({ ...base, service: svc({ category: 'consultation' }), consultationDates: [] }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, service: svc({ category: 'package' }), consultationDates: [] }, S, {})).toEqual([])
  })
  it('dates: future and outside the stay', () => {
    expect(evaluateChargeRules({ ...base, serviceDate: '2026-10-21' }, S, {})[0].message).toBe('The service date cannot be in the future')
    expect(codes(evaluateChargeRules({ ...base, serviceDate: '2026-10-19', consultationDates: ['2026-10-19'] }, S, {}))).toEqual(['date_outside_encounter'])
    expect(evaluateChargeRules({ ...base, serviceDate: '2026-10-19', consultationDates: ['2026-10-19'] }, S, {})[0].message)
      .toBe('The service date must fall within the visit or stay (20 Oct 2026 to 20 Oct 2026)')
  })
  it('dates: after the end of a closed stay', () => {
    const closed = { ...base, serviceDate: '2026-10-23', today: '2026-10-25', context: { ...base.context, startDate: '2026-10-20', endDate: '2026-10-22' } }
    const v = evaluateChargeRules(closed, S, {})
    expect(v[0]).toMatchObject({ code: 'date_outside_encounter', field: 'serviceDate' })
    expect(v[0].message).toBe('The service date must fall within the visit or stay (20 Oct 2026 to 22 Oct 2026)')
  })
  it('department mismatch warns for consultations and procedures only, and can be disabled', () => {
    const mismatch = { ...base, context: { ...base.context, departmentId: 11 } }
    expect(evaluateChargeRules(mismatch, S, {})[0]).toMatchObject({ code: 'department_mismatch', severity: 'warn', overridable: false, field: 'context' })
    expect(evaluateChargeRules({ ...mismatch, service: svc({ category: 'pharmacy' }) }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, context: { ...base.context, departmentId: null } }, S, {})).toEqual([])
    expect(evaluateChargeRules(mismatch, S, { department_mismatch: { enabled: false, severity: null } })).toEqual([])
  })
  it('deposit: blocks an elective IPD procedure below threshold, only warns for an emergency', () => {
    const ipd = { ...base, context: { ...base.context, isInpatient: true }, admissionDepositPaise: 1_000_00 }
    const s = { ...S, ipdDepositThresholdPaise: 5_000_00 }
    expect(evaluateChargeRules(ipd, s, {})).toEqual([expect.objectContaining({ code: 'deposit_below_threshold', severity: 'block', overridable: true })])
    const em = evaluateChargeRules({ ...ipd, context: { ...ipd.context, isEmergencyAdmission: true } }, s, {})
    expect(em[0]).toMatchObject({ severity: 'warn' }); expect(em[0].message).toMatch(/emergency admission: warning only\)$/)
    expect(em[0].message).toBe('The admission deposit (₹1,000.00) is below the ₹5,000.00 required before procedures (emergency admission: warning only)')
  })
  it('deposit: not for outpatients, zero threshold, enough deposit, or other categories; null deposit counts as zero', () => {
    const s = { ...S, ipdDepositThresholdPaise: 5_000_00 }
    const ipd = { ...base, context: { ...base.context, isInpatient: true }, admissionDepositPaise: 1_000_00 }
    expect(evaluateChargeRules({ ...ipd, context: { ...ipd.context, isInpatient: false } }, s, {})).toEqual([])
    expect(evaluateChargeRules(ipd, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...ipd, admissionDepositPaise: 5_000_00 }, s, {})).toEqual([])
    expect(evaluateChargeRules({ ...ipd, service: svc({ category: 'pharmacy' }) }, s, {})).toEqual([])
    expect(codes(evaluateChargeRules({ ...ipd, service: svc({ category: 'package' }), admissionDepositPaise: null }, s, {}))).toEqual(['deposit_below_threshold'])
  })
  it('emergency downgrade applies after config, and a disabled rule stays off', () => {
    const em = { ...base, context: { ...base.context, isInpatient: true, isEmergencyAdmission: true }, admissionDepositPaise: 0 }
    const s = { ...S, ipdDepositThresholdPaise: 100 }
    expect(evaluateChargeRules(em, s, { deposit_below_threshold: { enabled: true, severity: 'block' } })[0].severity).toBe('warn')
    expect(evaluateChargeRules(em, s, { deposit_below_threshold: { enabled: false, severity: null } })).toEqual([])
  })
  it('duplicate charge and quantity limit', () => {
    expect(evaluateChargeRules({ ...base, sameDayDuplicates: 1 }, S, {})[0]).toMatchObject({
      code: 'duplicate_charge', field: 'serviceId', overridable: true, message: 'This service is already charged for this visit on this date',
    })
    expect(evaluateChargeRules({ ...base, service: svc({ maxQuantity: 2 }), quantity: 3 }, S, {})[0]).toMatchObject({
      code: 'quantity_limit', field: 'quantity', overridable: true, message: 'Quantity cannot exceed 2 for this service',
    })
    expect(evaluateChargeRules({ ...base, service: svc({ maxQuantity: 2 }), quantity: 2 }, S, {})).toEqual([])
  })
  it('pre-auth needs both flags and a blank reference', () => {
    const v = { ...base, payer: { id: 7, requiresPreauth: true }, service: { ...base.service!, requiresPreauth: true } }
    expect(codes(evaluateChargeRules(v, S, {}))).toEqual(['preauth_required'])
    expect(evaluateChargeRules(v, S, {})[0]).toMatchObject({ field: 'preAuthReference', overridable: false })
    expect(evaluateChargeRules({ ...v, preAuthReference: '  ' }, S, {})).toHaveLength(1)
    expect(evaluateChargeRules({ ...v, preAuthReference: 'PA-123' }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...v, payer: { id: 7, requiresPreauth: false } }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...v, payer: null }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...v, service: { ...v.service, requiresPreauth: false } }, S, {})).toEqual([])
  })
  it('procedure codes: unmapped services are unconstrained; mapped ones must match (case-insensitive code)', () => {
    expect(evaluateChargeRules({ ...base, requestedProcedureCodes: [{ kind: 'hbp', code: 'X1' }] }, S, {})).toEqual([])
    const m = { ...base, mappedProcedureCodes: [{ kind: 'hbp', code: 'SMP001A' }] }
    expect(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: 'smp001a' }] }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: 'SMP002A' }] }, S, {})[0].message).toBe('SMP002A is not a procedure code mapped to this service')
    // the kind must match too
    expect(codes(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'icd10pcs', code: 'SMP001A' }] }, S, {}))).toEqual(['procedure_code_not_mapped'])
    // one violation per unmapped code
    const two = evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: 'A' }, { kind: 'hbp', code: 'B' }, { kind: 'hbp', code: 'SMP001A' }] }, S, {})
    expect(two.map((v) => v.message)).toEqual(['A is not a procedure code mapped to this service', 'B is not a procedure code mapped to this service'])
    expect(two[0]).toMatchObject({ field: 'procedureCodes', overridable: false })
    // same answer as SP6's chargeProcedureCodeProblems (normalised code in the message)
    expect(evaluateChargeRules({ ...m, requestedProcedureCodes: [{ kind: 'hbp', code: ' smp002a ' }] }, S, {})[0].message).toBe('SMP002A is not a procedure code mapped to this service')
  })
  it('config disables or re-grades configurable rules only', () => {
    const dup = { ...base, sameDayDuplicates: 1 }
    expect(evaluateChargeRules(dup, S, { duplicate_charge: { enabled: false, severity: null } })).toEqual([])
    expect(evaluateChargeRules(dup, S, { duplicate_charge: { enabled: true, severity: 'warn' } })[0].severity).toBe('warn')
    expect(evaluateChargeRules(dup, S, { duplicate_charge: { enabled: true, severity: null } })[0].severity).toBe('block')
    expect(codes(evaluateChargeRules({ ...base, priceResolved: false }, S, { price_unresolved: { enabled: false, severity: null } }))).toEqual(['price_unresolved'])
    expect(evaluateChargeRules({ ...base, priceResolved: false }, S, { price_unresolved: { enabled: true, severity: 'warn' } })[0].severity).toBe('block')
    expect(evaluateChargeRules({ ...base, service: null }, S, { service_not_found: { enabled: false, severity: 'warn' } })[0].code).toBe('service_not_found')
  })
  it('reports violations in table order', () => {
    const v = evaluateChargeRules({ ...base, priceResolved: false, sameDayDuplicates: 1, consultationDates: [], context: { ...base.context, departmentId: 11 } }, S, {})
    expect(codes(v)).toEqual(['price_unresolved', 'department_mismatch', 'consultation_required', 'duplicate_charge'])
  })
  it('overrides: only authority roles, only overridable blocks, only with a real reason', () => {
    const v = evaluateChargeRules({ ...base, sameDayDuplicates: 1, priceResolved: false }, S, {})
    const ov = [{ code: 'duplicate_charge' as const, reason: 'second dressing, other leg' }, { code: 'price_unresolved' as const, reason: 'please allow' }]
    expect(codes(unresolvedBlocks(v, ov, true))).toEqual(['price_unresolved'])
    expect(codes(unresolvedBlocks(v, ov, false))).toEqual(['price_unresolved', 'duplicate_charge'])   // table order
    expect(unresolvedBlocks(v, [{ code: 'duplicate_charge', reason: ' ok ' }], true)).toHaveLength(2)
  })
  it('appliedOverrides trims, dedupes, and ignores warns and unknown codes', () => {
    expect(OVERRIDE_REASON_MIN).toBe(5)
    const v = evaluateChargeRules({ ...base, sameDayDuplicates: 1, context: { ...base.context, departmentId: 11 } }, S, {})
    const ov = [
      { code: 'duplicate_charge' as const, reason: '  second dressing  ' },
      { code: 'duplicate_charge' as const, reason: 'again, same' },
      { code: 'department_mismatch' as const, reason: 'is only a warning' },
      { code: 'quantity_limit' as const, reason: 'no such violation' },
    ]
    expect(appliedOverrides(v, ov, true)).toEqual([{ code: 'duplicate_charge', reason: 'second dressing' }])
    expect(appliedOverrides(v, ov, false)).toEqual([])
    expect(unresolvedBlocks(v, ov, true)).toEqual([])
  })
  it('a re-graded warn is not a block to override or resolve', () => {
    const v = evaluateChargeRules({ ...base, sameDayDuplicates: 1 }, S, { duplicate_charge: { enabled: true, severity: 'warn' } })
    expect(unresolvedBlocks(v, [], false)).toEqual([])
  })
  it('CHARGE_RULES has one row per code in order', () => {
    expect(CHARGE_RULES.map((r) => r.code)).toEqual([...CHARGE_RULE_CODES])
    expect(CHARGE_RULES.filter((r) => !r.configurable).map((r) => r.code)).toEqual(['service_not_found', 'service_inactive', 'price_unresolved', 'date_outside_encounter'])
  })
})

// SP7 (ruling 7)
describe('SP7 preauth_invalid rule', () => {
  it('a typed reference that is not an approved pre-auth blocks; a valid one passes', () => {
    const v = { ...base, payer: { id: 7, requiresPreauth: true }, service: { ...base.service!, requiresPreauth: true }, preAuthReference: 'PA-1' }
    expect(evaluateChargeRules({ ...v, preAuthCheck: 'expired' }, S, {})[0]).toMatchObject({ code: 'preauth_invalid', message: 'This pre-authorisation expired before the service date', overridable: false })
    expect(evaluateChargeRules({ ...v, preAuthCheck: 'valid' }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...v, preAuthCheck: 'not_found' }, S, {})[0].message).toBe('No pre-authorisation with this reference exists for this patient')
    expect(evaluateChargeRules({ ...v, preAuthCheck: 'payer_mismatch' }, S, { preauth_invalid: { enabled: false, severity: null } })).toEqual([])
    expect(evaluateChargeRules({ ...v, payer: null, preAuthCheck: 'not_found' }, S, {})).toEqual([])
  })
  it('CHARGE_RULES still has one row per code in order', () => { expect(CHARGE_RULES.map((r) => r.code)).toEqual([...CHARGE_RULE_CODES]); expect(CHARGE_RULE_CODES[11]).toBe('preauth_invalid') })
})
// end SP7

// WS12 T10 (spec R7, R8): room-rent and sum-insured limits, warn by default, configurable, not overridable.
describe('WS12 coverage limit rules', () => {
  type Coverage = NonNullable<ChargeRuleInput['coverage']>
  const cov = (over: Partial<Coverage> = {}): Coverage => ({
    roomCategoryCode: 'GEN', roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00, balancePaise: null, insuredRunningPaise: 0, lineTaxablePaise: 5_000_00, ...over,
  })
  const room = { ...base, service: svc({ category: 'room_rent' }), payer: { id: 7, requiresPreauth: false }, consultationDates: [] }

  it('the first 12 codes and their rule rows are unchanged; the two new codes come last', () => {
    expect(CHARGE_RULE_CODES.slice(0, 12)).toEqual(['service_not_found', 'service_inactive', 'price_unresolved', 'date_outside_encounter',
      'department_mismatch', 'consultation_required', 'deposit_below_threshold', 'duplicate_charge', 'preauth_required',
      'quantity_limit', 'procedure_code_not_mapped', 'preauth_invalid'])
    expect(CHARGE_RULE_CODES.slice(12)).toEqual(['room_rent_over_limit', 'sum_insured_exceeded'])
    expect(CHARGE_RULES.map((r) => r.code)).toEqual([...CHARGE_RULE_CODES])
    for (const code of ['room_rent_over_limit', 'sum_insured_exceeded'] as const) {
      expect(CHARGE_RULES.find((r) => r.code === code)).toMatchObject({ defaultSeverity: 'warn', configurable: true, overridable: false, field: 'context' })
    }
  })
  it('a room-rent line at ₹5,000/day over a ₹3,000/day limit warns once', () => {
    const v = evaluateChargeRules({ ...room, coverage: cov() }, S, {})
    expect(v).toEqual([{ code: 'room_rent_over_limit', severity: 'warn', field: 'context', overridable: false,
      message: 'Room rent ₹5,000.00/day is above the policy limit ₹3,000.00/day; the insurer may deduct proportionately' }])
  })
  it('the per-day price is the line amount over the days', () => {
    expect(evaluateChargeRules({ ...room, quantity: 3, coverage: cov({ lineTaxablePaise: 9_000_00 }) }, S, {})).toEqual([])
    expect(codes(evaluateChargeRules({ ...room, quantity: 2, coverage: cov({ lineTaxablePaise: 8_000_00 }) }, S, {}))).toEqual(['room_rent_over_limit'])
  })
  it('an ICU room uses the ICU limit', () => {
    expect(evaluateChargeRules({ ...room, coverage: cov({ roomCategoryCode: 'ICU' }) }, S, {})).toEqual([])
    const v = evaluateChargeRules({ ...room, coverage: cov({ roomCategoryCode: 'NICU', lineTaxablePaise: 7_000_00 }) }, S, {})
    expect(v.map((x) => x.message)).toEqual(['Room rent ₹7,000.00/day is above the policy limit ₹6,000.00/day; the insurer may deduct proportionately'])
  })
  it('no limits, a non-room service or self-pay: no violation', () => {
    expect(evaluateChargeRules({ ...room, coverage: cov({ roomRentLimitPaise: null, icuLimitPaise: null }) }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...room, coverage: cov({ roomCategoryCode: 'ICU', icuLimitPaise: null }) }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, consultationDates: ['2026-10-20'], coverage: cov() }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...room, payer: null, coverage: null }, S, {})).toEqual([])
  })
  it('config enabled: false suppresses it; severity block makes it block (still not overridable)', () => {
    expect(evaluateChargeRules({ ...room, coverage: cov() }, S, { room_rent_over_limit: { enabled: false, severity: null } })).toEqual([])
    const v = evaluateChargeRules({ ...room, coverage: cov() }, S, { room_rent_over_limit: { enabled: true, severity: 'block' } })
    expect(v[0]).toMatchObject({ code: 'room_rent_over_limit', severity: 'block', overridable: false })
    expect(unresolvedBlocks(v, [{ code: 'room_rent_over_limit', reason: 'family agreed' }], true)).toHaveLength(1)
  })
  it('a running total of ₹4,80,000 plus ₹30,000 against a ₹5,00,000 balance warns', () => {
    const v = evaluateChargeRules({ ...base, payer: { id: 7, requiresPreauth: false }, coverage: cov({ balancePaise: 5_00_000_00, insuredRunningPaise: 4_80_000_00, lineTaxablePaise: 30_000_00 }) }, S, {})
    expect(v).toEqual([{ code: 'sum_insured_exceeded', severity: 'warn', field: 'context', overridable: false,
      message: 'This takes the insured total to ₹5,10,000.00, above the available sum insured ₹5,00,000.00' }])
    // Exactly at the balance is fine; no balance known is fine.
    expect(evaluateChargeRules({ ...base, coverage: cov({ balancePaise: 5_00_000_00, insuredRunningPaise: 4_70_000_00, lineTaxablePaise: 30_000_00 }) }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, coverage: cov({ balancePaise: null, insuredRunningPaise: 9_00_000_00 }) }, S, {})).toEqual([])
    expect(evaluateChargeRules({ ...base, coverage: cov({ balancePaise: 5_00_000_00, insuredRunningPaise: 4_80_000_00, lineTaxablePaise: 30_000_00 }) }, S, { sum_insured_exceeded: { enabled: false, severity: null } })).toEqual([])
  })
  it('a room-rent line can raise both, in table order', () => {
    expect(codes(evaluateChargeRules({ ...room, coverage: cov({ balancePaise: 1_000_00 }) }, S, {}))).toEqual(['room_rent_over_limit', 'sum_insured_exceeded'])
  })
})
// end WS12 T10
