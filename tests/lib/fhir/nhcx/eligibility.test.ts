import { describe, it, expect } from 'vitest'
import { buildEligibilityBundle, parseEligibilityResponse } from '@/lib/fhir/nhcx/eligibility'
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
