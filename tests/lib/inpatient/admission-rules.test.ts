import { describe, it, expect } from 'vitest'
import {
  wardGenderConflict, admissionTypeLabel, daysStayed, CHILD_EXEMPT_AGE_YEARS, OVERRIDE_REASON_MIN,
} from '@/lib/inpatient/admission-rules'

describe('wardGenderConflict', () => {
  it('flags opposite-sex placement', () => {
    expect(wardGenderConflict({ patientGender: 'female', ageYears: 30, ward: 'male' })).toBe('opposite_sex')
    expect(wardGenderConflict({ patientGender: 'male', ageYears: 30, ward: 'female' })).toBe('opposite_sex')
  })
  it('allows same sex and mixed wards', () => {
    expect(wardGenderConflict({ patientGender: 'male', ageYears: 30, ward: 'male' })).toBeNull()
    expect(wardGenderConflict({ patientGender: 'female', ageYears: 30, ward: 'female' })).toBeNull()
    expect(wardGenderConflict({ patientGender: 'female', ageYears: 30, ward: null })).toBeNull()
    expect(wardGenderConflict({ patientGender: null, ageYears: 30, ward: null })).toBeNull()
  })
  it('exempts young children', () => {
    expect(CHILD_EXEMPT_AGE_YEARS).toBe(12)
    expect(wardGenderConflict({ patientGender: 'female', ageYears: 7, ward: 'male' })).toBeNull()
  })
  it('treats unverifiable gender as a conflict in a restricted ward', () => {
    for (const g of ['transgender', 'other', 'unknown', null] as const) {
      expect(wardGenderConflict({ patientGender: g, ageYears: 30, ward: 'male' })).toBe('unverified_gender')
      expect(wardGenderConflict({ patientGender: g, ageYears: 30, ward: 'female' })).toBe('unverified_gender')
    }
  })
  it('exposes the override reason minimum', () => { expect(OVERRIDE_REASON_MIN).toBe(10) })
})

describe('admissionTypeLabel', () => {
  it('maps labels', () => {
    expect(admissionTypeLabel('elective')).toBe('Planned')
    expect(admissionTypeLabel('emergency')).toBe('Emergency')
    expect(admissionTypeLabel('transfer_in')).toBe('Transfer in')
  })
})

describe('daysStayed', () => {
  const ist = (s: string) => new Date(`${s}+05:30`)
  it('counts the admission day as 1', () => {
    expect(daysStayed(ist('2026-10-23T23:50:00'), ist('2026-10-23T23:55:00'))).toBe(1)
  })
  it('rolls over at IST midnight', () => {
    expect(daysStayed(ist('2026-10-23T23:50:00'), ist('2026-10-24T00:05:00'))).toBe(2)
  })
  it('never goes below 1', () => {
    expect(daysStayed(ist('2026-10-23T12:00:00'), ist('2026-10-22T12:00:00'))).toBe(1)
  })
})
