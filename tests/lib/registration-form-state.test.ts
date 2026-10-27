import { describe, it, expect } from 'vitest'
import { EMPTY_REGISTRATION_FORM, toRegistrationPayload, fieldErrors, errorsForStep, stepOfErrorKey, errorRootOf } from '@/components/registration/registration-form-state'
import { patientRegistrationSchema } from '@/lib/validation/patient-registration'

describe('registration form state', () => {
  it('maps an empty optional field to an omitted key and builds the aadhaar union', () => {
    const p = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, name: 'A', aadhaarMode: 'declined', aadhaarDeclineReason: 'emergency' }) as Record<string, unknown>
    expect(p).not.toHaveProperty('email')
    expect(p.aadhaar).toEqual({ status: 'declined', reason: 'emergency' })
  })

  it('builds the provided aadhaar branch with consent and the abha unavailable branch', () => {
    const p = toRegistrationPayload({
      ...EMPTY_REGISTRATION_FORM, aadhaarNumber: '234567890125', aadhaarConsent: true,
      abhaMode: 'unavailable', abhaUnavailableReason: 'other', abhaUnavailableNote: 'n',
    }) as Record<string, unknown>
    expect(p.aadhaar).toEqual({ status: 'provided', number: '234567890125', consent: true })
    expect(p.abha).toEqual({ status: 'unavailable', reason: 'other', note: 'n' })
    expect(p.nationality).toBe('IN')
  })

  it('output passes the strict server schema shape (no stray keys)', () => {
    const p = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, name: 'Asha', dob: '1990-01-01', gender: 'female', addressLine1: 'x', city: 'c', district: 'd', stateCode: 'IN-KA', pinCode: '560001',
      aadhaarMode: 'declined', aadhaarDeclineReason: 'patient_declined', abhaMode: 'unavailable', abhaUnavailableReason: 'not_created' })
    expect(patientRegistrationSchema.safeParse(p).success).toBe(true)
  })

  it('fieldErrors keys a minor-without-guardian issue at contacts', () => {
    const p = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, name: 'Kid', dob: '2024-01-01', gender: 'male', addressLine1: 'x', city: 'c', district: 'd', stateCode: 'IN-KA', pinCode: '560001',
      aadhaarMode: 'declined', aadhaarDeclineReason: 'minor_no_aadhaar', abhaMode: 'unavailable', abhaUnavailableReason: 'not_created' })
    expect(fieldErrors(p).contacts).toMatch(/guardian/i)
  })

  it('fieldErrors uses dotted paths', () => {
    const e = fieldErrors(toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, aadhaarNumber: '234567890125', aadhaarConsent: true }))
    expect(e['aadhaar.number']).toBe('Enter a valid 12-digit Aadhaar number')
  })

  // WS6 T8
  it('carries the referral source, and the note only with a source', () => {
    const withSource = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, referralSource: 'doctor', referralNote: 'Dr Kulkarni' }) as Record<string, unknown>
    expect(withSource).toMatchObject({ referralSource: 'doctor', referralNote: 'Dr Kulkarni' })
    const noSource = toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, referralNote: 'stale' }) as Record<string, unknown>
    expect(noSource).not.toHaveProperty('referralSource')
    expect(noSource).not.toHaveProperty('referralNote')
  })

  it('a doctor referral requires a note, even while other steps are incomplete', () => {
    const e = fieldErrors(toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, name: 'A', referralSource: 'doctor' }))
    expect(e.referralNote).toBe('Name the referring doctor')
    expect(fieldErrors(toRegistrationPayload({ ...EMPTY_REGISTRATION_FORM, referralSource: 'camp' })).referralNote).toBeUndefined()
  })

  it('the server schema refuses an unknown referral source and a doctor referral without a note', () => {
    const base = { name: 'Asha', dob: '1990-01-01', gender: 'female', addressLine1: 'x', city: 'c', district: 'd', stateCode: 'IN-KA', pinCode: '560001',
      aadhaar: { status: 'declined', reason: 'patient_declined' }, abha: { status: 'unavailable', reason: 'not_created' } }
    expect(patientRegistrationSchema.safeParse({ ...base, referralSource: 'tv' }).success).toBe(false)
    expect(patientRegistrationSchema.safeParse({ ...base, referralSource: 'doctor' }).success).toBe(false)
    expect(patientRegistrationSchema.safeParse({ ...base, referralSource: 'doctor', referralNote: 'Dr K' }).success).toBe(true)
  })

  it('assigns each error to the step that shows its field', () => {
    expect(stepOfErrorKey('name')).toBe(0)
    expect(stepOfErrorKey('referralNote')).toBe(0)
    expect(stepOfErrorKey('pinCode')).toBe(1)
    expect(stepOfErrorKey('contacts.0.phone')).toBe(1)
    expect(stepOfErrorKey('aadhaar.number')).toBe(2)
    expect(stepOfErrorKey('primaryPlanType')).toBe(2)
    expect(errorsForStep({ name: 'n', pinCode: 'p', 'abha.note': 'a' }, 1)).toEqual({ pinCode: 'p' })
    expect(errorRootOf('aadhaarNumber')).toBe('aadhaar')
    expect(errorRootOf('abhaUnavailableReason')).toBe('abha')
    expect(errorRootOf('pinCode')).toBe('pinCode')
  })
})
