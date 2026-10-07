import { describe, it, expect } from 'vitest'
import {
  INDIAN_STATES, isIndianStateCode, stateName, isValidPinCode, KYC_DOC_TYPES, GENDERS, MARITAL_STATUSES,
  BLOOD_GROUPS, AADHAAR_DECLINE_REASONS, ABHA_UNAVAILABLE_REASONS,
} from '@/lib/india/reference'
import { normalizePhone } from '@/lib/india/phone'
import { genderEnum, maritalStatusEnum, bloodGroupEnum, patientAadhaar } from '@/db/schema'

describe('reference data', () => {
  it('lists exactly 36 unique ISO 3166-2:IN codes incl. 2023 renames', () => {
    const codes = INDIAN_STATES.map((s) => s.code)
    expect(codes.length).toBe(36)
    expect(new Set(codes).size).toBe(36)
    for (const c of ['IN-CG', 'IN-OD', 'IN-TS', 'IN-UK', 'IN-DH', 'IN-LA']) expect(isIndianStateCode(c)).toBe(true)
    for (const c of ['IN-OR', 'IN-CT', 'IN-TG', 'IN-UT', 'MH']) expect(isIndianStateCode(c)).toBe(false)
    expect(stateName('IN-KL')).toBe('Kerala')
    expect(stateName('XX')).toBeNull()
  })
  it.each([['110001', true], ['560034', true], ['011001', false], ['11001', false], ['1100011', false], ['11000a', false]])('PIN %s -> %s', (p, ok) => expect(isValidPinCode(p)).toBe(ok))
  it('never offers Aadhaar as a KYC document type', () => { expect(KYC_DOC_TYPES as readonly string[]).not.toContain('aadhaar') })
  it('mirrors the DB enums', () => {
    expect(GENDERS.map((g) => g.code)).toEqual(genderEnum.enumValues)
    expect(MARITAL_STATUSES.map((g) => g.code)).toEqual(maritalStatusEnum.enumValues)
    expect(BLOOD_GROUPS.map((g) => g.code)).toEqual(bloodGroupEnum.enumValues)
    expect(AADHAAR_DECLINE_REASONS.map((g) => g.code)).toEqual(patientAadhaar.declineReason.enumValues)
    expect(ABHA_UNAVAILABLE_REASONS.map((g) => g.code)).toEqual(['not_created', 'patient_declined', 'emergency', 'other'])
  })
})

describe('normalizePhone', () => {
  it.each([['9876543210', '+919876543210'], ['+91 98765 43210', '+919876543210'], ['09876543210', '+919876543210'], ['919876543210', '+919876543210'], ['+447700900123', '+447700900123'], ['5876543210', null], ['12345', null], ['', null], ['abc', null]])('phone %s', (i, o) => expect(normalizePhone(i)).toBe(o))
})
