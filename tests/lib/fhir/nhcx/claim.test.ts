import { describe, it, expect } from 'vitest'
import { buildClaimBundle, buildPreauthBundle, claimBundleProblems } from '@/lib/fhir/nhcx/claim'
import { paiseToFhirMoney } from '@/lib/fhir/nhcx/money'
import { validateNhcxBundle } from '@/lib/fhir/nhcx/validate'
import { CS_SUPPORTINGINFO_CATEGORY } from '@/lib/fhir/nhcx/systems'
import { CTX, PRE, SNAP, type AnyJson } from './fixtures'

describe('claim bundles', () => {
  it('builds a claim bundle that validates and carries the snapshot totals', () => {
    const b: AnyJson = buildClaimBundle(SNAP, CTX); expect(validateNhcxBundle(b, 'ClaimBundle')).toEqual([])
    const claim = b.entry[0].resource; expect(claim.use).toBe('claim'); expect(claim.total).toEqual(paiseToFhirMoney(SNAP.totals.claimedPaise))
    expect(claim.item).toHaveLength(SNAP.items.length); expect(claim.type.coding[0].code).toBe('737481003')
    expect(claim.diagnosis[0].diagnosisCodeableConcept.coding[0]).toMatchObject({ system: 'http://hl7.org/fhir/sid/icd-10', version: '2019' })
    expect(claim.identifier[0].value).toBe('CLM-2026-000012/v1')
    expect(claim.insurance[0].preAuthRef).toEqual(['INS-PA-778'])
    expect(claim.item[1]).toMatchObject({ quantity: { value: 3 }, unitPrice: { value: 10000, currency: 'INR' }, net: { value: 30000, currency: 'INR' } })
    expect(claim).not.toHaveProperty('related')
  })
  it('a pre-auth enhancement references the prior approval', () => {
    const c: AnyJson = buildPreauthBundle({ ...PRE, kind: 'enhancement' }, { ...CTX, priorPreauthRef: 'PA123' }).entry[0].resource
    expect(c.use).toBe('preauthorization'); expect(c.insurance[0].preAuthRef).toEqual(['PA123'])
    expect(c.related[0].relationship.coding[0].code).toBe('prior')
    const initial: AnyJson = buildPreauthBundle(PRE, CTX)
    expect(validateNhcxBundle(initial, 'ClaimBundle')).toEqual([])
    expect(initial.entry[0].resource.diagnosis[0].type[0].coding[0].code).toBe('148006')
    expect(initial.entry[0].resource.total).toEqual(paiseToFhirMoney(15_000_000))
    expect(initial.entry[0].resource.insurance[0]).not.toHaveProperty('preAuthRef')
  })
  it('refuses a bundle with sample-set codes', () => {
    expect(claimBundleProblems({ ...SNAP, diagnoses: [{ ...SNAP.diagnoses[0], version: 'SAMPLE-ICD10-0' }] }, CTX)).toEqual(['sample_codes'])
  })
  it('refuses when the treating doctor has no registration number', () => {
    expect(claimBundleProblems(SNAP, { ...CTX, practitioner: { name: 'Dr A', registrationNumber: null } })).toEqual(['practitioner_registration_missing'])
  })
  it('refuses package (hbp) procedure codes', () => {
    expect(claimBundleProblems({ ...SNAP, procedures: [{ ...SNAP.procedures[0], kind: 'hbp', code: 'SC001A' }] }, CTX)).toEqual(['unmapped_procedure_codes'])
  })
  it('names every gap in order', () => {
    expect(claimBundleProblems({ ...SNAP, items: [], diagnoses: [], hospital: { ...SNAP.hospital, hfrId: null, rohiniId: null }, patient: { ...SNAP.patient, uhid: null } }, CTX))
      .toEqual(['no_items', 'no_diagnosis', 'hospital_ids_missing', 'patient_uhid_missing'])
    expect(claimBundleProblems({ ...PRE, estimate: [] }, CTX)).toEqual(['no_items'])
    expect(claimBundleProblems(SNAP, CTX)).toEqual([])
  })
  it('maps document kinds to S5 supporting-info codes and embeds data only when given', () => {
    const plain: AnyJson = buildClaimBundle(SNAP, CTX).entry[0].resource
    expect(plain.supportingInfo).toHaveLength(2)
    expect(plain.supportingInfo[0]).toMatchObject({ category: { coding: [{ system: CS_SUPPORTINGINFO_CATEGORY, code: 'HDS' }] }, valueAttachment: { title: 'Discharge summary', contentType: 'application/pdf' } })
    expect(plain.supportingInfo[1].category.coding[0].code).toBe('DIA')
    expect(plain.supportingInfo[0].valueAttachment).not.toHaveProperty('data')
    const withData: AnyJson = buildClaimBundle(SNAP, { ...CTX, attachments: new Map([['a'.repeat(64), { contentType: 'application/pdf', dataBase64: 'JVBERi0=' }]]) }).entry[0].resource
    expect(withData.supportingInfo[0].valueAttachment.data).toBe('JVBERi0=')
    expect(withData.supportingInfo[1].valueAttachment).not.toHaveProperty('data')
  })
  it('the bundle carries no phone, email, address or ADN', () => {
    expect(JSON.stringify(buildClaimBundle(SNAP, CTX))).not.toMatch(/telecom|"address"|"ADN"|uidai/)
    const withAbha: AnyJson = buildClaimBundle({ ...SNAP, patient: { ...SNAP.patient, abhaNumber: '91-1234-5678-9012' } }, CTX)
    expect(withAbha.entry[1].resource.identifier[1].value).toBe('91-1234-5678-9012')
  })
})
