import { describe, it, expect } from 'vitest'
import { NATIONAL_ID_PROBLEM, validateNhcxBundle } from '@/lib/fhir/nhcx/validate'
import { CS_IDENTIFIER_TYPE } from '@/lib/fhir/nhcx/systems'
import { allFixtures, clone, fixture } from './fixtures'

describe('validateNhcxBundle', () => {
  it.each([
    'Bundle-CoverageEligibilityRequestBundle-validation-example-01', 'Bundle-ClaimBundle-preauthorization-example-01', 'Bundle-ClaimBundle-enhancement-example-01',
    'Bundle-ClaimBundle-settlement-example-01', 'Bundle-TaskBundleForCommunicationRequest-example-01', 'Bundle-TaskBundleForCommunicationResponse-example-01',
    'Bundle-TaskBundleForPaymentNoticeRequest-example-01', 'Bundle-TaskBundleForPaymentNoticeResponse-example-01',
  ])('the de-identified official example %s validates', (n) => {
    const profile = n.includes('Claim') ? 'ClaimBundle' : n.includes('Task') ? 'TaskBundle' : 'CoverageEligibilityRequestBundle'
    expect(validateNhcxBundle(fixture(n), profile)).toEqual([])
  })
  it('reports a missing required element and a dangling reference', () => {
    const b = clone(fixture('Bundle-ClaimBundle-preauthorization-example-01')); delete b.entry[0].resource.diagnosis; b.entry[0].resource.patient.reference = 'urn:uuid:nope'
    expect(validateNhcxBundle(b, 'ClaimBundle')).toEqual(expect.arrayContaining(['Claim.diagnosis is required', 'Claim.patient references urn:uuid:nope, which is not in the bundle']))
  })
  it('refuses any Aadhaar identifier', () => {
    const b = clone(fixture('Bundle-ClaimBundle-preauthorization-example-01'))
    b.entry[1].resource.identifier.push({ type: { coding: [{ system: CS_IDENTIFIER_TYPE, code: 'ADN' }] }, value: 'x' })
    expect(validateNhcxBundle(b, 'ClaimBundle')).toContain(NATIONAL_ID_PROBLEM)
    const c = clone(fixture('Bundle-ClaimBundle-preauthorization-example-01'))
    c.entry[1].resource.identifier = [{ system: 'https://uidai.gov.in/', value: 'x' }]
    expect(validateNhcxBundle(c, 'ClaimBundle')).toContain(NATIONAL_ID_PROBLEM)
  })
  it('checks the bundle type, the first entry and the coded paths', () => {
    const b = clone(fixture('Bundle-ClaimBundle-preauthorization-example-01'))
    b.type = 'document'; delete b.entry[0].resource.item[0].productOrService.coding[0].system
    expect(validateNhcxBundle(b, 'ClaimBundle')).toEqual(expect.arrayContaining(['Bundle.type must be collection', 'Claim.item.productOrService.coding needs system and code']))
    expect(validateNhcxBundle(fixture('Bundle-ClaimBundle-preauthorization-example-01'), 'TaskBundle')).toContain('TaskBundle must start with exactly one Task')
    expect(validateNhcxBundle({ resourceType: 'Patient' }, 'ClaimBundle')).toEqual(['Not a FHIR Bundle'])
  })
  it('fixtures carry no Aadhaar after de-identification', () => {
    for (const f of allFixtures()) expect(JSON.stringify(f)).not.toMatch(/uidai|"ADN"|\b\d{12}\b/)
  })
})
