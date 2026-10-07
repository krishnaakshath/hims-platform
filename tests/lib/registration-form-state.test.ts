import { describe, it, expect } from 'vitest'
import { EMPTY_REGISTRATION_FORM, toRegistrationPayload, fieldErrors } from '@/components/registration/registration-form-state'
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
})
