import { describe, it, expect, afterEach } from 'vitest'
import { patientToFhir } from '@/lib/fhir/patient'
import { uhidSystem, ABHA_NUMBER_SYSTEM, ABHA_ADDRESS_SYSTEM } from '@/lib/fhir/identifier-systems'
import { makePatientRow } from '../../fixtures/patient-row'

describe('patientToFhir', () => {
  it('maps identifier, name, and DOB from the single-sourced patient fields', () => {
    const fhir = patientToFhir(makePatientRow({ id: 'RD-FHIR-P1', name: 'Test Name', dob: '1985-03-02' }))
    expect(fhir.resourceType).toBe('Patient')
    expect(fhir.id).toBe('RD-FHIR-P1')
    expect(fhir.identifier).toEqual([{ value: 'RD-FHIR-P1' }])
    expect(fhir.name).toEqual([{ text: 'Test Name' }])
    expect(fhir.birthDate).toBe('1985-03-02')
    expect(fhir).not.toHaveProperty('gender')
    expect(fhir).not.toHaveProperty('address')
  })

  it('keeps the local id identifier first and adds UHID and ABHA identifiers', () => {
    const f = patientToFhir(makePatientRow({ id: 'RD-0001', uhid: 'UH000000427', abhaNumber: '12345678901234', abhaAddress: 'ravi.kumar@abdm' }))
    expect(f.identifier[0]).toEqual({ value: 'RD-0001' })
    expect(f.identifier.map((i) => i.type?.text)).toEqual([undefined, 'UHID', 'ABHA Number', 'ABHA Address'])
    expect(f.identifier[1]).toEqual({ system: uhidSystem(), type: { text: 'UHID' }, value: 'UH000000427' })
    expect(f.identifier[2]).toEqual({ system: ABHA_NUMBER_SYSTEM, type: { text: 'ABHA Number' }, value: '12-3456-7890-1234' })
    expect(f.identifier[3]).toEqual({ system: ABHA_ADDRESS_SYSTEM, type: { text: 'ABHA Address' }, value: 'ravi.kumar@abdm' })
  })

  it('emits only the identifiers that are present', () => {
    const f = patientToFhir(makePatientRow({ uhid: 'UH000000001' }))
    expect(f.identifier.map((i) => i.type?.text)).toEqual([undefined, 'UHID'])
  })

  it('omits gender when unknown to the record and maps every value', () => {
    expect(patientToFhir(makePatientRow())).not.toHaveProperty('gender')
    expect(patientToFhir(makePatientRow({ gender: 'transgender' })).gender).toBe('other')
    expect(patientToFhir(makePatientRow({ gender: 'male' })).gender).toBe('male')
    expect(patientToFhir(makePatientRow({ gender: 'female' })).gender).toBe('female')
    expect(patientToFhir(makePatientRow({ gender: 'other' })).gender).toBe('other')
    expect(patientToFhir(makePatientRow({ gender: 'unknown' })).gender).toBe('unknown')
  })

  it('maps the structured Indian address', () => {
    const f = patientToFhir(makePatientRow({
      addressLine1: '12 MG Road', addressLine2: 'Indiranagar', city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: '560034',
    }))
    expect(f.address).toEqual([{ line: ['12 MG Road', 'Indiranagar'], city: 'Bengaluru', district: 'Bengaluru Urban', state: 'Karnataka', postalCode: '560034', country: 'IN' }])
  })

  it('omits address without a first line, and optional parts when absent', () => {
    expect(patientToFhir(makePatientRow({ city: 'Pune', pinCode: '411001' }))).not.toHaveProperty('address')
    expect(patientToFhir(makePatientRow({ addressLine1: '5 Lane' })).address).toEqual([{ line: ['5 Lane'] }])
  })

  it('does not derive the address country from nationality; Indian addresses get IN', () => {
    // A Nepali national living at an Indian address: the address is in India.
    expect(patientToFhir(makePatientRow({ addressLine1: '5 Lane', stateCode: 'IN-KA', nationality: 'NP' })).address?.[0].country).toBe('IN')
    // No Indian state on the address: no country is asserted, whatever the nationality.
    expect(patientToFhir(makePatientRow({ addressLine1: '5 Lane', nationality: 'NP' })).address?.[0]).not.toHaveProperty('country')
    expect(patientToFhir(makePatientRow({ addressLine1: '5 Lane', nationality: 'IN' })).address?.[0]).not.toHaveProperty('country')
  })

  it('never emits an Aadhaar identifier even if a caller smuggles the field in', () => {
    const f = patientToFhir({ ...makePatientRow(), aadhaar: '234567890124' } as never)
    expect(JSON.stringify(f)).not.toMatch(/aadhaar|234567890124/i)
  })
})

describe('uhidSystem', () => {
  const original = process.env.NEXT_PUBLIC_APP_URL
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_APP_URL
    else process.env.NEXT_PUBLIC_APP_URL = original
  })
  it('derives from the app URL when set, else a local URN', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://hims.example.in'
    expect(uhidSystem()).toBe('https://hims.example.in/fhir/sid/uhid')
    delete process.env.NEXT_PUBLIC_APP_URL
    expect(uhidSystem()).toBe('urn:x-local:uhid')
  })
})
