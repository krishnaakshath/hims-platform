import { describe, it, expect } from 'vitest'
import { buildEligibilityBundle, emptySummary, parseEligibilityResponse } from '@/lib/fhir/nhcx/eligibility'
import { validateNhcxBundle } from '@/lib/fhir/nhcx/validate'
import { PROFILE } from '@/lib/fhir/nhcx/systems'
import { fixture, HOSPITAL, INSURER, PATIENT, POLICY, type AnyJson } from './fixtures'

const INPUT = {
  requestId: '0b6c7c5e-6d3f-4d4c-9a51-2f7d4f0d9f11', purpose: 'validation' as const, created: new Date('2026-10-08T06:02:26.605Z'), patient: PATIENT,
  hospital: HOSPITAL, insurer: INSURER, policy: POLICY, practitioner: { name: 'Dr A', registrationNumber: 'MMC-12345' }, serviceDate: '2026-10-08',
}

describe('eligibility bundle', () => {
  it('builds a valid eligibility bundle', () => {
    const b: AnyJson = buildEligibilityBundle(INPUT)
    expect(validateNhcxBundle(b, 'CoverageEligibilityRequestBundle')).toEqual([])
    expect(b.meta.profile[0]).toBe(PROFILE.CoverageEligibilityRequestBundle)
    expect(b.timestamp).toBe('2026-10-08T11:32:26.605+05:30')
    expect(b.entry.map((e: AnyJson) => e.resource.resourceType)).toEqual(['CoverageEligibilityRequest', 'Patient', 'Practitioner', 'Organization', 'Organization', 'Location', 'Coverage'])
    expect(b.entry[0].resource).toMatchObject({ purpose: ['validation'], servicedDate: '2026-10-08', status: 'active' })
    expect(JSON.stringify(b)).not.toMatch(/telecom|"address"|"ADN"|uidai/)
  })
  it('parses the official validation response as in force', () => {
    expect(parseEligibilityResponse(fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'))).toMatchObject({ ok: true, summary: { inforce: true, outcome: 'complete' } })
  })
  it('the disposition text is not copied into the summary; a bundle without a response is a problem', () => {
    const r = parseEligibilityResponse(fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'))
    expect(JSON.stringify(r)).not.toContain('in-force.')
    expect(parseEligibilityResponse({ resourceType: 'Bundle', entry: [] })).toMatchObject({ ok: false })
  })
})

// WS12 T2 (R6): limits from CoverageEligibilityResponse.insurance[0]; codes UNVERIFIED (docs/ABDM-NHCX.md U21).
describe('eligibility response limits (WS12 R6)', () => {
  const money = (value: number) => ({ value, currency: 'INR' })
  const cc = (code: string) => ({ coding: [{ code }] })
  const withInsurance = (insurance: unknown, identifier?: unknown) => {
    const b = fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01')
    const r = b.entry.find((e: AnyJson) => e.resource.resourceType === 'CoverageEligibilityResponse').resource
    r.insurance = [insurance]
    if (identifier !== undefined) r.identifier = identifier
    return b
  }
  const LIMITED = {
    inforce: true,
    benefitPeriod: { start: '2026-04-01', end: '2027-03-31' },
    item: [
      { category: cc('medical'), benefit: [
        { type: cc('benefit'), allowedMoney: money(500000), usedMoney: money(50000) },
        { type: cc('copay-percent'), allowedUnsignedInt: 10 },
      ] },
      { category: cc('room-rent'), benefit: [{ type: cc('room'), allowedMoney: money(4000) }] },
      { category: cc('icu'), benefit: [{ type: cc('room'), allowedMoney: money(8000.5) }] },
    ],
  }

  it('reads sum insured, balance (allowed - used), co-pay bp, room-rent and ICU per-day limits and benefit period end', () => {
    const r = parseEligibilityResponse(withInsurance(LIMITED))
    expect(r).toMatchObject({ ok: true, summary: { inforce: true } })
    if (!r.ok) return
    expect(r.summary.coverage).toEqual({
      sumInsuredPaise: 50_000_000, balancePaise: 45_000_000, copayBp: 1000, roomRentLimitPaise: 400_000, icuLimitPaise: 800_050, benefitPeriodEnd: '2027-03-31',
    })
  })
  it('a bundle without limits or a benefit period gives coverage null; emptySummary has coverage null', () => {
    const r = parseEligibilityResponse(withInsurance({ inforce: true }))
    expect(r.ok && r.summary.coverage).toBeNull()
    expect(emptySummary().coverage).toBeNull()
  })
  it('the official example yields only its benefit period end', () => {
    const r = parseEligibilityResponse(fixture('Bundle-CoverageEligibilityResponseBundle-validation-example-01'))
    expect(r.ok && r.summary.coverage).toEqual({ sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null, benefitPeriodEnd: '2026-08-07' })
  })
  it('used above allowed gives a zero balance; out-of-range co-pay, foreign currency and bad dates are dropped', () => {
    const r = parseEligibilityResponse(withInsurance({
      inforce: true, benefitPeriod: { end: '31/03/2027' },
      item: [
        { benefit: [{ type: cc('benefit'), allowedMoney: money(1000), usedMoney: money(2000) }, { type: cc('copay-percent'), allowedUnsignedInt: 150 }] },
        { category: cc('room-rent'), benefit: [{ type: cc('room'), allowedMoney: { value: 10, currency: 'USD' } }] },
      ],
    }))
    expect(r.ok && r.summary.coverage).toEqual({ sumInsuredPaise: 100_000, balancePaise: 0, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null, benefitPeriodEnd: null })
  })
  it('returns the response identifier as insurerReference (clipped to 64), never inside the summary', () => {
    const long = 'R'.repeat(80)
    const r = parseEligibilityResponse(withInsurance(LIMITED, [{ system: 'https://insurer.example/elig', value: long }]))
    expect(r.ok && r.insurerReference).toBe('R'.repeat(64))
    expect(JSON.stringify(r.ok && r.summary)).not.toContain('RRRR')
    const none = parseEligibilityResponse(withInsurance(LIMITED))
    expect(none.ok && none.insurerReference).toBeNull()
  })
})
