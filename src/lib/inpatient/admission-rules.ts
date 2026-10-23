import { istDateOf } from '@/lib/india-time'

export type WardGender = 'male' | 'female' | null
export type PatientGender = 'male' | 'female' | 'transgender' | 'other' | 'unknown' | null
export type WardGenderConflict = 'opposite_sex' | 'unverified_gender'

export const CHILD_EXEMPT_AGE_YEARS = 12
export const OVERRIDE_REASON_MIN = 10

/** Why placing this patient in a gender-restricted ward needs an override, or null when it does not. */
export function wardGenderConflict(i: { patientGender: PatientGender; ageYears: number; ward: WardGender }): WardGenderConflict | null {
  if (i.ward === null) return null
  if (i.ageYears < CHILD_EXEMPT_AGE_YEARS) return null
  if (i.patientGender === 'male' || i.patientGender === 'female') return i.patientGender === i.ward ? null : 'opposite_sex'
  return 'unverified_gender'
}

export function admissionTypeLabel(t: 'elective' | 'emergency' | 'transfer_in'): 'Planned' | 'Emergency' | 'Transfer in' {
  return t === 'elective' ? 'Planned' : t === 'emergency' ? 'Emergency' : 'Transfer in'
}

/** IST calendar days stayed; the admission day counts as 1, never less than 1. */
export function daysStayed(admittedAt: Date, now: Date): number {
  const a = Date.parse(`${istDateOf(admittedAt)}T00:00:00Z`)
  const n = Date.parse(`${istDateOf(now)}T00:00:00Z`)
  return Math.max(1, Math.round((n - a) / 86_400_000) + 1)
}
