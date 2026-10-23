// WS1 T2: the pure vitals rules (src/lib/encounters/vitals.ts) and the consult patch schema.
import { describe, it, expect } from 'vitest'
import { bmiTenths, toVitalsColumns, vitalsFlags, vitalsInputSchema } from '@/lib/encounters/vitals'
import { consultPatchSchema } from '@/lib/encounters/consult-validation'

describe('bmiTenths', () => {
  it('computes BMI in tenths from grams and millimetres', () => {
    expect(bmiTenths(70000, 1750)).toBe(229)
  })
  it('is null when either input is missing', () => {
    expect(bmiTenths(null, 1750)).toBeNull()
    expect(bmiTenths(70000, null)).toBeNull()
  })
})

describe('toVitalsColumns', () => {
  it('converts to integer storage units', () => {
    expect(toVitalsColumns({ tempC: 37.4, weightKg: 70.25, heightCm: 175.5 })).toMatchObject({
      tempDeciC: 374, weightG: 70250, heightMm: 1755, systolicMmhg: null, pulseBpm: null, painScore: null, notes: null,
    })
  })
  it('maps painScore and notes (R1)', () => {
    expect(toVitalsColumns({ pulseBpm: 80, painScore: 4, notes: 'after walk' })).toMatchObject({ pulseBpm: 80, painScore: 4, notes: 'after walk' })
    expect(toVitalsColumns({ painScore: 0 }).painScore).toBe(0)
  })
  it('is not fooled by float noise', () => {
    expect(toVitalsColumns({ tempC: 36.6, weightKg: 0.3 })).toMatchObject({ tempDeciC: 366, weightG: 300 })
  })
})

describe('vitalsInputSchema', () => {
  const ok = (v: unknown) => vitalsInputSchema.safeParse(v).success
  it('accepts a normal set', () => {
    expect(ok({ systolicMmhg: 120, diastolicMmhg: 80, pulseBpm: 72, tempC: 36.8, spo2Pct: 98, respRate: 16, weightKg: 70.5, heightCm: 170 })).toBe(true)
  })
  it('rejects an empty object', () => { expect(ok({})).toBe(false) })
  it('rejects diastolic >= systolic', () => {
    expect(ok({ systolicMmhg: 120, diastolicMmhg: 120 })).toBe(false)
    expect(ok({ systolicMmhg: 120, diastolicMmhg: 130 })).toBe(false)
    expect(ok({ diastolicMmhg: 80 })).toBe(true)
  })
  it('rejects out-of-range values', () => {
    expect(ok({ spo2Pct: 101 })).toBe(false)
    expect(ok({ spo2Pct: 49 })).toBe(false)
    expect(ok({ pulseBpm: 19 })).toBe(false)
    expect(ok({ respRate: 81 })).toBe(false)
    expect(ok({ systolicMmhg: 49 })).toBe(false)
    expect(ok({ tempC: 45.1 })).toBe(false)
    expect(ok({ weightKg: 0.2 })).toBe(false)
    expect(ok({ heightCm: 251 })).toBe(false)
  })
  it('rejects excess decimals and non-integers where integers are required', () => {
    expect(ok({ tempC: 37.45 })).toBe(false)
    expect(ok({ weightKg: 70.1234 })).toBe(false)
    expect(ok({ heightCm: 170.25 })).toBe(false)
    expect(ok({ pulseBpm: 72.5 })).toBe(false)
  })
  it('rejects unknown keys and strings', () => {
    expect(ok({ pulseBpm: 70, extra: 1 })).toBe(false)
    expect(ok({ pulseBpm: '70' })).toBe(false)
  })
  it('painScore: int 0..10, counts as a measurement (R1)', () => {
    expect(ok({ painScore: 0 })).toBe(true)
    expect(ok({ painScore: 10 })).toBe(true)
    expect(ok({ painScore: 11 })).toBe(false)
    expect(ok({ painScore: -1 })).toBe(false)
    expect(ok({ painScore: 2.5 })).toBe(false)
  })
  it('notes alone is not a vitals set; notes are trimmed and capped at 300 (R1)', () => {
    expect(ok({ notes: 'only a note' })).toBe(false)
    const r = vitalsInputSchema.safeParse({ pulseBpm: 70, notes: '  seated  ' })
    expect(r.success && r.data.notes).toBe('seated')
    expect(ok({ pulseBpm: 70, notes: 'x'.repeat(300) })).toBe(true)
    expect(ok({ pulseBpm: 70, notes: 'x'.repeat(301) })).toBe(false)
  })
})

describe('vitalsFlags', () => {
  const cols = (o: Parameters<typeof toVitalsColumns>[0]) => toVitalsColumns(o)
  it('flags 150/95 as bp_high only', () => {
    expect(vitalsFlags(cols({ systolicMmhg: 150, diastolicMmhg: 95 }))).toEqual(['bp_high'])
  })
  it('flags each threshold', () => {
    expect(vitalsFlags(cols({ systolicMmhg: 85, diastolicMmhg: 50 }))).toEqual(['bp_low'])
    expect(vitalsFlags(cols({ tempC: 38 }))).toEqual(['fever'])
    expect(vitalsFlags(cols({ spo2Pct: 93 }))).toEqual(['spo2_low'])
    expect(vitalsFlags(cols({ pulseBpm: 101 }))).toEqual(['tachycardia'])
    expect(vitalsFlags(cols({ pulseBpm: 49 }))).toEqual(['bradycardia'])
  })
  it('flags nothing for a normal set', () => {
    expect(vitalsFlags(cols({ systolicMmhg: 120, diastolicMmhg: 80, pulseBpm: 72, tempC: 37, spo2Pct: 98 }))).toEqual([])
  })
})

describe('consultPatchSchema', () => {
  it('needs at least one key and trims', () => {
    expect(consultPatchSchema.safeParse({}).success).toBe(false)
    const r = consultPatchSchema.safeParse({ chiefComplaint: '  fever  ' })
    expect(r.success && r.data.chiefComplaint).toBe('fever')
    expect(consultPatchSchema.safeParse({ advice: null }).success).toBe(true)
  })
  it('caps fields at 4000 and noDiagnosisReason at 300; rejects unknown keys', () => {
    expect(consultPatchSchema.safeParse({ examination: 'x'.repeat(4001) }).success).toBe(false)
    expect(consultPatchSchema.safeParse({ examination: 'x'.repeat(4000) }).success).toBe(true)
    expect(consultPatchSchema.safeParse({ noDiagnosisReason: 'x'.repeat(301) }).success).toBe(false)
    expect(consultPatchSchema.safeParse({ nope: 'x' }).success).toBe(false)
  })
})
