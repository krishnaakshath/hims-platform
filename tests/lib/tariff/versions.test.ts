import { describe, it, expect } from 'vitest'
import { normalizeWard, sameDims, rangesOverlap, findOverlap, addDays, planRevision, type DatedRate } from '@/lib/tariff/versions'

const dims = { serviceId: 1, scope: 'base' as const, departmentId: null, payerId: null, roomCategoryId: null, ward: null }
const cur = { id: 9, ...dims, validFrom: '2026-01-01', validTo: '2026-12-31' as string | null, amountPaise: 100, deactivated: false }

describe('tariff versions', () => {
  it('normalizeWard trims, collapses whitespace and lower-cases', () => {
    expect(normalizeWard(' Icu  Ward ')).toBe('icu ward')
  })
  it('rangesOverlap is inclusive and treats null as open', () => {
    expect(rangesOverlap({ validFrom: '2026-01-01', validTo: '2026-01-31' }, { validFrom: '2026-01-31', validTo: null })).toBe(true)
    expect(rangesOverlap({ validFrom: '2026-01-01', validTo: '2026-01-30' }, { validFrom: '2026-01-31', validTo: null })).toBe(false)
    expect(rangesOverlap({ validFrom: '2026-01-01', validTo: null }, { validFrom: '2030-01-01', validTo: null })).toBe(true)
    expect(rangesOverlap({ validFrom: '2026-05-01', validTo: '2026-05-31' }, { validFrom: '2026-01-01', validTo: '2026-04-30' })).toBe(false)
  })
  it('sameDims treats wards case-insensitively and distinguishes payers', () => {
    expect(sameDims({ ...dims, ward: ' ICU ' }, { ...dims, ward: 'icu' })).toBe(true)
    expect(sameDims({ ...dims, ward: 'icu' }, { ...dims, ward: null })).toBe(false)
    expect(sameDims({ ...dims, scope: 'payer', payerId: 1 }, { ...dims, scope: 'payer', payerId: 2 })).toBe(false)
    expect(sameDims(dims, { ...dims })).toBe(true)
    expect(sameDims(dims, { ...dims, serviceId: 2 })).toBe(false)
    expect(sameDims(dims, { ...dims, roomCategoryId: 4 })).toBe(false)
    expect(sameDims(dims, { ...dims, departmentId: 4 })).toBe(false)
  })
  it('findOverlap ignores deactivated rows and the row itself', () => {
    const cand: DatedRate = { ...dims, validFrom: '2026-06-01', validTo: null }
    const row = (o: Partial<DatedRate>): DatedRate => ({ ...dims, validFrom: '2026-01-01', validTo: null, ...o })
    expect(findOverlap(cand, [row({ id: 1 })])?.id).toBe(1)
    expect(findOverlap(cand, [row({ id: 1, deactivated: true })])).toBeNull()
    expect(findOverlap({ ...cand, id: 1 }, [row({ id: 1 })])).toBeNull()
    expect(findOverlap(cand, [row({ id: 1, payerId: 5, scope: 'payer' })])).toBeNull()
    expect(findOverlap(cand, [row({ id: 1, validTo: '2026-05-31' })])).toBeNull()
  })
  it('addDays crosses month and leap-year boundaries', () => {
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29'); expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
  it('planRevision closes the day before and keeps the original end', () => {
    const plan = planRevision(cur, { amountPaise: 150, effectiveFrom: '2026-10-08' })
    expect(plan).toEqual({ ok: true, close: { id: 9, validTo: '2026-10-07' }, insert: expect.objectContaining({ validFrom: '2026-10-08', validTo: '2026-12-31', amountPaise: 150 }) })
    const open = planRevision({ ...cur, validTo: null }, { amountPaise: 150, effectiveFrom: '2026-10-08' })
    expect(open).toMatchObject({ ok: true, insert: { validTo: null } })
  })
  it('planRevision rejects effectiveFrom <= validFrom', () => {
    const err = 'New rate must start after the current rate starts'
    expect(planRevision(cur, { amountPaise: 150, effectiveFrom: '2026-01-01' })).toEqual({ ok: false, error: err })
    expect(planRevision(cur, { amountPaise: 150, effectiveFrom: '2025-12-31' })).toEqual({ ok: false, error: err })
  })
  it('planRevision rejects a date after the current end, an unchanged amount and a deactivated rate', () => {
    expect(planRevision(cur, { amountPaise: 150, effectiveFrom: '2027-01-01' })).toEqual({ ok: false, error: 'The current rate ends before that date; add a new rate instead' })
    expect(planRevision(cur, { amountPaise: 100, effectiveFrom: '2026-10-08' })).toEqual({ ok: false, error: 'The new amount equals the current amount' })
    expect(planRevision({ ...cur, deactivated: true }, { amountPaise: 150, effectiveFrom: '2026-10-08' })).toEqual({ ok: false, error: 'The rate is deactivated' })
  })
})
