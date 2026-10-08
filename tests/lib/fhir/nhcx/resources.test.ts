import { describe, it, expect } from 'vitest'
import { NhcxBuildError, nhcxCoverage, nhcxHospital, nhcxPatient, nhcxPayer, nhcxPractitioner } from '@/lib/fhir/nhcx/resources'
import { fhirMoneyToPaise, paiseToFhirMoney } from '@/lib/fhir/nhcx/money'
import { HOSPITAL, INSURER, PATIENT, POLICY, TPA, type AnyJson } from './fixtures'

describe('NHCX base resources', () => {
  it('the patient has UHID and ABHA identifiers, no telecom, address or ADN', () => {
    const p: AnyJson = nhcxPatient({ ...PATIENT, abhaNumber: '91-1234-5678-9012' }, 'u1')
    expect(p.identifier.map((i: AnyJson) => i.type.coding[0].code)).toEqual(['MR', 'ABHA']); expect(p.identifier[1].system).toBe('https://healthid.ndhm.gov.in')
    expect(p.identifier[1].value).toBe('91-1234-5678-9012')
    expect(p).not.toHaveProperty('telecom'); expect(p).not.toHaveProperty('address')
    expect(p).toMatchObject({ gender: 'female', birthDate: '1990-03-12', name: [{ text: 'Asha Rao' }] })
    expect((nhcxPatient(PATIENT, 'u2') as AnyJson).identifier).toHaveLength(1)
    expect(() => nhcxPatient({ ...PATIENT, uhid: null }, 'u3')).toThrow(NhcxBuildError)
  })
  it('the hospital needs HFR or ROHINI', () => {
    expect(() => nhcxHospital({ ...HOSPITAL, hfrId: null, rohiniId: null }, 'h')).toThrow(NhcxBuildError)
    const h: AnyJson = nhcxHospital(HOSPITAL, 'h')
    expect(h.identifier.map((i: AnyJson) => i.system)).toEqual(['https://facility.ndhm.gov.in', 'https://rohini.iib.gov.in/'])
    expect(h.type[0].coding[0].code).toBe('prov'); expect(h.name).toBe(HOSPITAL.legalName)
  })
  it('a doctor without a registration number cannot be sent; the number carries no HPR system', () => {
    expect(() => nhcxPractitioner({ name: 'Dr A', registrationNumber: null }, 'd')).toThrow('The treating doctor has no registration number')
    const d: AnyJson = nhcxPractitioner({ name: 'Dr A', registrationNumber: 'MMC-12345' }, 'd')
    expect(d.identifier[0]).toEqual({ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MD', display: 'Medical License number' }] }, value: 'MMC-12345' })
  })
  it('insurer and TPA organisations and the coverage', () => {
    expect((nhcxPayer(INSURER, 'i') as AnyJson).type[0].coding[0].code).toBe('ins')
    expect((nhcxPayer(TPA, 't') as AnyJson).type[0].coding[0].code).toBe('pay')
    const c: AnyJson = nhcxCoverage(POLICY, 'c', { patientId: 'p', insurerId: 'i' })
    expect(c).toMatchObject({ subscriberId: 'MEM-9', status: 'active', beneficiary: { reference: 'urn:uuid:p' }, payor: [{ reference: 'urn:uuid:i' }], period: { start: '2026-04-01', end: '2027-03-31' } })
    expect(c.identifier[0].value).toBe('POL-123')
  })
  it('money converts without float drift', () => {
    expect(paiseToFhirMoney(123_456_789)).toEqual({ value: 1234567.89, currency: 'INR' }); expect(fhirMoneyToPaise({ value: 1234567.89, currency: 'INR' })).toBe(123_456_789); expect(fhirMoneyToPaise({ value: 1.234 })).toBeNull()
    expect(paiseToFhirMoney(5)).toEqual({ value: 0.05, currency: 'INR' }); expect(fhirMoneyToPaise({ value: 0.05 })).toBe(5)
    expect(fhirMoneyToPaise({ value: 10, currency: 'USD' })).toBeNull(); expect(fhirMoneyToPaise({ value: -1 })).toBeNull(); expect(fhirMoneyToPaise({ value: 1e13 })).toBeNull()
    expect(paiseToFhirMoney(2 ** 31 + 7)).toEqual({ value: 21474836.55, currency: 'INR' })
  })
})
