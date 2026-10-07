import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  patientRegistrationSchema, patientProfileUpdateSchema, contactsReplaceSchema, aadhaarInputSchema, abhaInputSchema, guardianProblem,
} from '@/lib/validation/patient-registration'

const valid = (over: Record<string, unknown> = {}) => ({
  name: 'Asha Rao', dob: '1990-01-01', gender: 'female', addressLine1: '12 MG Road', city: 'Mumbai', district: 'Mumbai',
  stateCode: 'IN-MH', pinCode: '400001',
  aadhaar: { status: 'provided', number: '2345 6789 0124', consent: true },
  abha: { status: 'unavailable', reason: 'not_created' },
  ...over,
})
const guardian = { kind: 'guardian', name: 'Ravi Rao', relationship: 'parent', phone: '9876543210' }

afterEach(() => vi.useRealTimers())

describe('patientRegistrationSchema', () => {
  it('aadhaar union accepts spaced input and rejects bad checksum without echoing it', () => {
    expect(patientRegistrationSchema.parse(valid()).aadhaar).toEqual({ status: 'provided', number: '234567890124', consent: true })
    const r = patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'provided', number: '2345 6789 0125', consent: true } }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error!.flatten())).not.toMatch(/2345|6789|0125/)
    expect(JSON.stringify(r.error!.issues)).toContain('Enter a valid 12-digit Aadhaar number')
  })
  it('requires consent to store Aadhaar', () => {
    const r = patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'provided', number: '234567890124', consent: false } }))
    expect(r.success).toBe(false)
    expect(JSON.stringify(r.error!.issues)).toContain('Patient consent is required to record Aadhaar')
  })
  it('accepts a decline and requires a note for reason other', () => {
    expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'declined', reason: 'patient_declined' } })).success).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'declined', reason: 'other' } })).success).toBe(false)
    expect(patientRegistrationSchema.safeParse(valid({ aadhaar: { status: 'declined', reason: 'other', note: '  lost card ' } })).success).toBe(true)
    expect(aadhaarInputSchema.safeParse({ status: 'declined', reason: 'bogus' }).success).toBe(false)
  })
  it('rejects a decline note holding an Aadhaar number, without echoing it', () => {
    for (const note of ['card 2345 6789 0124', '2345.6789.0124', '234567890124']) {
      const r = aadhaarInputSchema.safeParse({ status: 'declined', reason: 'other', note })
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error!.issues)).toContain('Do not enter an Aadhaar number in the note')
      expect(JSON.stringify(r.error!.issues)).not.toMatch(/2345|6789/)
    }
    expect(abhaInputSchema.safeParse({ status: 'unavailable', reason: 'other', note: 'aadhaar 2345-6789-0124' }).success).toBe(false)
    expect(aadhaarInputSchema.safeParse({ status: 'declined', reason: 'other', note: 'ref 234567890125' }).success).toBe(true)
  })
  it('rejects a registration with no aadhaar key at all (mandatory)', () => {
    const rest: Record<string, unknown> = valid(); delete rest.aadhaar
    expect(patientRegistrationSchema.safeParse(rest).success).toBe(false)
  })
  it('requires a guardian contact for a patient under 18 on the Asia/Kolkata date', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T19:00:00Z'))
    expect(patientRegistrationSchema.safeParse(valid({ dob: '2008-10-07' })).success).toBe(true)
    const r = patientRegistrationSchema.safeParse(valid({ dob: '2008-10-08' }))
    expect(r.success).toBe(false)
    expect(r.error!.issues.some((i) => i.path.join('.') === 'contacts' && i.message === 'A guardian contact is required for a patient under 18')).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ dob: '2008-10-08', contacts: [guardian] })).success).toBe(true)
  })
  it('rejects a DOB after today', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-06T19:00:00Z'))
    const r = patientRegistrationSchema.safeParse(valid({ dob: '2026-10-08' }))
    expect(r.success).toBe(false)
    expect(r.error!.issues.some((i) => i.path[0] === 'dob')).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ dob: '2026-10-07', contacts: [guardian] })).success).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ dob: '2026-02-30' })).success).toBe(false)
  })
  it('normalises ABHA number with hyphens', () => {
    expect(patientRegistrationSchema.parse(valid({ abha: { status: 'provided', abhaNumber: '12-3456-7890-1234' } })).abha).toEqual({ status: 'provided', abhaNumber: '12345678901234' })
  })
  it('ABHA: needs one identifier, validates, and requires note for other', () => {
    expect(abhaInputSchema.safeParse({ status: 'provided' }).success).toBe(false)
    expect(abhaInputSchema.safeParse({ status: 'provided', abhaNumber: '123' }).success).toBe(false)
    expect(abhaInputSchema.parse({ status: 'provided', abhaAddress: ' Asha.Rao123@abdm ' })).toEqual({ status: 'provided', abhaAddress: 'asha.rao123@abdm' })
    expect(abhaInputSchema.safeParse({ status: 'unavailable', reason: 'other' }).success).toBe(false)
    expect(abhaInputSchema.safeParse({ status: 'unavailable', reason: 'nope' }).success).toBe(false)
  })
  it('applies defaults and normalises phone/contacts', () => {
    const p = patientRegistrationSchema.parse(valid({ phone: '+91 98765 43210', contacts: [{ ...guardian, phone: '09876543210' }] }))
    expect(p.nationality).toBe('IN'); expect(p.isMlc).toBe(false); expect(p.phone).toBe('+919876543210'); expect(p.contacts[0].phone).toBe('+919876543210')
    expect(patientRegistrationSchema.safeParse(valid({ phone: '12345' })).success).toBe(false)
    expect(patientRegistrationSchema.safeParse(valid({ contacts: [{ ...guardian, phone: 'x' }] })).success).toBe(false)
  })
  it('rejects bad state/PIN, unknown keys, mlcNumber without isMlc, >5 contacts', () => {
    expect(patientRegistrationSchema.safeParse(valid({ stateCode: 'MH' })).success).toBe(false)
    expect(patientRegistrationSchema.safeParse(valid({ pinCode: '011001' })).success).toBe(false)
    expect(patientRegistrationSchema.safeParse(valid({ uhid: 'X1' })).success).toBe(false)
    const r = patientRegistrationSchema.safeParse(valid({ mlcNumber: 'M1' }))
    expect(r.success).toBe(false); expect(r.error!.issues.some((i) => i.path[0] === 'mlcNumber')).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ isMlc: true, mlcNumber: 'M1' })).success).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ contacts: Array(6).fill({ ...guardian, kind: 'emergency' }) })).success).toBe(false)
  })
  it('kyc rejects aadhaar as a doc type', () => {
    expect(patientRegistrationSchema.safeParse(valid({ kyc: { docType: 'pan', docNumber: 'ABCDE1234F' } })).success).toBe(true)
    expect(patientRegistrationSchema.safeParse(valid({ kyc: { docType: 'aadhaar', docNumber: '1' } })).success).toBe(false)
  })
})

describe('patientProfileUpdateSchema', () => {
  it('rejects an aadhaar key', () => { expect(patientProfileUpdateSchema.safeParse({ aadhaar: { status: 'declined', reason: 'emergency' } }).success).toBe(false) })
  it('rejects uhid, contacts and kyc', () => {
    for (const k of [{ uhid: 'X' }, { contacts: [] }, { kyc: { docType: 'pan', docNumber: '1' } }]) expect(patientProfileUpdateSchema.safeParse(k).success).toBe(false)
  })
  it('rejects an empty object', () => { expect(patientProfileUpdateSchema.safeParse({}).success).toBe(false) })
  it('does not inject defaults and accepts a partial', () => {
    expect(patientProfileUpdateSchema.parse({ city: 'Pune' })).toEqual({ city: 'Pune' })
    expect(patientProfileUpdateSchema.parse({ abha: { status: 'unavailable', reason: 'emergency' } })).toEqual({ abha: { status: 'unavailable', reason: 'emergency' } })
  })
})

describe('contactsReplaceSchema / guardianProblem', () => {
  it('validates the replace payload', () => {
    expect(contactsReplaceSchema.safeParse({ contacts: [guardian] }).success).toBe(true)
    expect(contactsReplaceSchema.safeParse({ contacts: [], x: 1 }).success).toBe(false)
  })
  it('guardianProblem', () => {
    expect(guardianProblem([], '2020-01-01', '2026-10-07')).toBe('A guardian contact is required for a patient under 18')
    expect(guardianProblem([{ kind: 'guardian' }], '2020-01-01', '2026-10-07')).toBeNull()
    expect(guardianProblem([], '1990-01-01', '2026-10-07')).toBeNull()
  })
})
