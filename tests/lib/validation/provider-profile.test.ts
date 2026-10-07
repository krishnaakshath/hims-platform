import { describe, it, expect } from 'vitest'
import { providerProfileSchema } from '@/lib/validation/provider-profile'

const ok = (v: unknown) => providerProfileSchema.safeParse(v).success

describe('providerProfileSchema', () => {
  it('requires a state for SMC and forbids one for NMC', () => {
    expect(ok({ registrationCouncil: 'smc', registrationNumber: 'MMC/2011/12345' })).toBe(false)
    expect(ok({ registrationCouncil: 'smc', registrationStateCode: 'IN-MH', registrationNumber: 'MMC/2011/12345' })).toBe(true)
    expect(ok({ registrationCouncil: 'nmc', registrationStateCode: 'IN-MH', registrationNumber: '12345' })).toBe(false)
    expect(ok({ registrationCouncil: 'nmc', registrationNumber: '12345' })).toBe(true)
    expect(ok({ registrationCouncil: 'nmc', registrationStateCode: null, registrationNumber: '12345' })).toBe(true)
  })
  it('rejects an invalid state code and a state without a council', () => {
    expect(ok({ registrationCouncil: 'smc', registrationStateCode: 'IN-XX' })).toBe(false)
    expect(ok({ registrationStateCode: 'IN-MH' })).toBe(false)
  })
  it('validates and trims the registration number', () => {
    expect(providerProfileSchema.parse({ registrationNumber: ' 12345 ' }).registrationNumber).toBe('12345')
    for (const v of ['', 'has space', 'a'.repeat(21), 'bad;char']) expect(ok({ registrationNumber: v })).toBe(false)
    expect(ok({ registrationNumber: null })).toBe(true)
  })
  it('rejects a negative, fractional or oversized fee; accepts null and bounds', () => {
    for (const v of [-1, 10.5, 100_000_01]) expect(ok({ consultationFeePaise: v })).toBe(false)
    for (const v of [0, 50000, 100_000_00, null]) expect(ok({ consultationFeePaise: v })).toBe(true)
  })
  it('requires at least one key and rejects unknown keys', () => {
    expect(ok({})).toBe(false)
    expect(ok({ name: 'Dr X', isActive: false })).toBe(false)
  })
  it('accepts a name, a department id or null', () => {
    expect(ok({ name: 'Dr X' })).toBe(true)
    expect(ok({ name: '  ' })).toBe(false)
    expect(ok({ departmentId: 3 })).toBe(true)
    expect(ok({ departmentId: null })).toBe(true)
    expect(ok({ departmentId: 1.5 })).toBe(false)
  })
})
