import { describe, it, expect } from 'vitest'
import {
  resolvePrice,
  normalizeWard,
  type PriceQuery,
  type ServiceForPricing,
  type TariffRateCandidate,
} from '@/lib/tariff/resolve'

const svc: ServiceForPricing = {
  id: 100, code: 'CONS-GEN', name: 'General consultation', departmentId: 10,
  isActive: true, hsnSac: '999312', gstRateBp: 1800,
}

function rate(overrides: Partial<TariffRateCandidate> = {}): TariffRateCandidate {
  return {
    id: 1, serviceId: 100, scope: 'base', departmentId: null, payerId: null,
    roomCategoryCode: null, ward: null, amountPaise: 10000,
    validFrom: '2026-01-01', validTo: null, deactivated: false,
    ...overrides,
  }
}

function q(overrides: Partial<PriceQuery> = {}): PriceQuery {
  return { serviceId: 100, onDate: '2026-10-07', ...overrides }
}

function ctx(rates: TariffRateCandidate[], service: ServiceForPricing | null = svc) {
  return { service, rates }
}

describe('normalizeWard', () => {
  it.each([
    ['  ICU   Ward ', 'icu ward'],
    ['icu ward', 'icu ward'],
    ['Icu\tWard', 'icu ward'],
    ['GENERAL', 'general'],
    ['', ''],
  ])('normalises %j to %j', (input, out) => expect(normalizeWard(input)).toBe(out))
})

describe('resolvePrice', () => {
  it('returns the base rate when nothing more specific exists', () => {
    expect(resolvePrice(q(), ctx([rate({ id: 1, scope: 'base', amountPaise: 50000 })])))
      .toMatchObject({ ok: true, amountPaise: 50000, scope: 'base', rateId: 1 })
  })

  it('department list beats base for the service department', () => {
    const r = resolvePrice(q(), ctx([
      rate({ id: 1, scope: 'base', amountPaise: 50000 }),
      rate({ id: 2, scope: 'department', departmentId: 10, amountPaise: 45000 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 2, scope: 'department', amountPaise: 45000 })
  })

  it('an explicit departmentId selects that department list', () => {
    const rates = [
      rate({ id: 1, scope: 'base', amountPaise: 50000 }),
      rate({ id: 2, scope: 'department', departmentId: 20, amountPaise: 30000 }),
    ]
    expect(resolvePrice(q({ departmentId: 20 }), ctx(rates))).toMatchObject({ ok: true, rateId: 2, scope: 'department' })
    expect(resolvePrice(q(), ctx(rates))).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
  })

  it('an explicit departmentId replaces (not adds to) the service department', () => {
    const rates = [
      rate({ id: 1, scope: 'base', amountPaise: 50000 }),
      rate({ id: 2, scope: 'department', departmentId: 10, amountPaise: 40000 }),
    ]
    expect(resolvePrice(q({ departmentId: 20 }), ctx(rates))).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
  })

  it('payer-specific beats department and base', () => {
    const r = resolvePrice(q({ payerId: 7 }), ctx([
      rate({ id: 1, scope: 'base', amountPaise: 50000 }),
      rate({ id: 2, scope: 'department', departmentId: 10, amountPaise: 45000 }),
      rate({ id: 3, scope: 'payer', payerId: 7, amountPaise: 60000 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 3, scope: 'payer', amountPaise: 60000 })
  })

  it('payer generic beats base room-specific', () => {
    const r = resolvePrice(q({ payerId: 7, roomCategory: 'PRIVATE' }), ctx([
      rate({ id: 1, scope: 'base', roomCategoryCode: 'PRIVATE', amountPaise: 90000 }),
      rate({ id: 2, scope: 'payer', payerId: 7, amountPaise: 60000 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 2, scope: 'payer', matched: { roomCategory: false, ward: false } })
  })

  it('department generic beats base ward+category-specific', () => {
    const r = resolvePrice(q({ roomCategory: 'PRIVATE', ward: 'ICU' }), ctx([
      rate({ id: 1, scope: 'base', roomCategoryCode: 'PRIVATE', ward: 'ICU', amountPaise: 90000 }),
      rate({ id: 2, scope: 'department', departmentId: 10, amountPaise: 60000 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 2, scope: 'department' })
  })

  it('payer without a matching rate falls back to department then base', () => {
    const base = rate({ id: 1, scope: 'base', amountPaise: 50000 })
    const dept = rate({ id: 2, scope: 'department', departmentId: 10, amountPaise: 45000 })
    // payer 7 only has a ward-specific rate that does not apply to this query
    const payerIcu = rate({ id: 3, scope: 'payer', payerId: 7, ward: 'ICU', amountPaise: 99000 })
    expect(resolvePrice(q({ payerId: 7 }), ctx([base, dept, payerIcu]))).toMatchObject({ ok: true, rateId: 2, scope: 'department' })
    expect(resolvePrice(q({ payerId: 7 }), ctx([base, payerIcu]))).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
  })

  it('another payer\'s rate is never used', () => {
    const rates = [
      rate({ id: 1, scope: 'base', amountPaise: 50000 }),
      rate({ id: 2, scope: 'payer', payerId: 8, amountPaise: 20000 }),
    ]
    expect(resolvePrice(q({ payerId: 7 }), ctx(rates))).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
    expect(resolvePrice(q(), ctx(rates))).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
    expect(resolvePrice(q(), ctx([rates[1]]))).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('another department\'s rate is never used without an explicit departmentId', () => {
    expect(resolvePrice(q(), ctx([rate({ id: 2, scope: 'department', departmentId: 20 })])))
      .toEqual({ ok: false, reason: 'no_rate' })
  })

  it('another service\'s rate is never used', () => {
    expect(resolvePrice(q(), ctx([rate({ id: 1, serviceId: 999 })]))).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('picks the most specific within a scope: ward+category > ward > category > generic', () => {
    const generic = rate({ id: 1, amountPaise: 100 })
    const cat = rate({ id: 2, roomCategoryCode: 'PRIVATE', amountPaise: 200 })
    const ward = rate({ id: 3, ward: 'ICU', amountPaise: 300 })
    const both = rate({ id: 4, roomCategoryCode: 'PRIVATE', ward: 'ICU', amountPaise: 400 })
    const query = q({ roomCategory: 'PRIVATE', ward: 'ICU' })
    expect(resolvePrice(query, ctx([generic, cat, ward, both]))).toMatchObject({ rateId: 4, matched: { roomCategory: true, ward: true } })
    expect(resolvePrice(query, ctx([generic, cat, ward]))).toMatchObject({ rateId: 3, matched: { roomCategory: false, ward: true } })
    expect(resolvePrice(query, ctx([generic, cat]))).toMatchObject({ rateId: 2, matched: { roomCategory: true, ward: false } })
    expect(resolvePrice(query, ctx([generic]))).toMatchObject({ rateId: 1, matched: { roomCategory: false, ward: false } })
  })

  it('specificity ranks inside the payer scope too', () => {
    const r = resolvePrice(q({ payerId: 7, roomCategory: 'private' }), ctx([
      rate({ id: 1, scope: 'payer', payerId: 7, amountPaise: 100 }),
      rate({ id: 2, scope: 'payer', payerId: 7, roomCategoryCode: 'PRIVATE', amountPaise: 200 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 2, scope: 'payer', matched: { roomCategory: true, ward: false } })
  })

  it('a category-specific rate does not apply when no room category is queried', () => {
    const rates = [
      rate({ id: 1, amountPaise: 100 }),
      rate({ id: 2, roomCategoryCode: 'PRIVATE', amountPaise: 200 }),
    ]
    expect(resolvePrice(q(), ctx(rates))).toMatchObject({ ok: true, rateId: 1 })
    expect(resolvePrice(q(), ctx([rates[1]]))).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('a category-specific rate does not apply to a different room category', () => {
    expect(resolvePrice(q({ roomCategory: 'GENERAL' }), ctx([rate({ id: 2, roomCategoryCode: 'PRIVATE' })])))
      .toEqual({ ok: false, reason: 'no_rate' })
  })

  it('a ward-specific rate does not apply when no ward is queried', () => {
    expect(resolvePrice(q(), ctx([rate({ id: 2, ward: 'ICU' })]))).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('matches room category case-insensitively', () => {
    expect(resolvePrice(q({ roomCategory: ' private ' }), ctx([rate({ id: 2, roomCategoryCode: 'PRIVATE' })])))
      .toMatchObject({ ok: true, rateId: 2, matched: { roomCategory: true } })
  })

  it('matches ward case- and whitespace-insensitively', () => {
    for (const w of ['  ICU   Ward ', 'icu ward', 'Icu  Ward', 'ICU\tWARD']) {
      expect(resolvePrice(q({ ward: w }), ctx([rate({ id: 2, ward: 'icu ward' })])))
        .toMatchObject({ ok: true, rateId: 2, matched: { ward: true } })
    }
    expect(resolvePrice(q({ ward: 'ICU' }), ctx([rate({ id: 3, ward: ' Icu ' })])))
      .toMatchObject({ ok: true, rateId: 3, matched: { ward: true } })
    expect(resolvePrice(q({ ward: 'icuward' }), ctx([rate({ id: 2, ward: 'icu ward' })])))
      .toEqual({ ok: false, reason: 'no_rate' })
  })

  it('honours inclusive valid_to and future valid_from', () => {
    const rates = [
      rate({ id: 1, scope: 'base', validFrom: '2026-01-01', validTo: '2026-10-07', amountPaise: 100 }),
      rate({ id: 2, scope: 'base', validFrom: '2026-10-08', amountPaise: 200 }),
    ]
    expect(resolvePrice(q({ onDate: '2026-10-07' }), ctx(rates))).toMatchObject({ rateId: 1 })
    expect(resolvePrice(q({ onDate: '2026-10-08' }), ctx(rates))).toMatchObject({ rateId: 2 })
  })

  it.each([
    ['valid_from == onDate', { validFrom: '2026-10-07', validTo: null }, true],
    ['valid_to == onDate', { validFrom: '2026-01-01', validTo: '2026-10-07' }, true],
    ['single-day range', { validFrom: '2026-10-07', validTo: '2026-10-07' }, true],
    ['open-ended, started long ago', { validFrom: '2000-01-01', validTo: null }, true],
    ['not yet valid (starts tomorrow)', { validFrom: '2026-10-08', validTo: null }, false],
    ['expired (ended yesterday)', { validFrom: '2026-01-01', validTo: '2026-10-06' }, false],
    ['crosses a year boundary', { validFrom: '2025-12-31', validTo: '2026-12-31' }, true],
  ] as const)('date window: %s', (_label, window, applies) => {
    const r = resolvePrice(q({ onDate: '2026-10-07' }), ctx([rate({ id: 5, ...window })]))
    if (applies) expect(r).toMatchObject({ ok: true, rateId: 5 })
    else expect(r).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('an expired payer rate falls back to base', () => {
    const r = resolvePrice(q({ payerId: 7 }), ctx([
      rate({ id: 1, amountPaise: 50000 }),
      rate({ id: 2, scope: 'payer', payerId: 7, validTo: '2026-10-06', amountPaise: 1 }),
    ]))
    expect(r).toMatchObject({ ok: true, rateId: 1, scope: 'base' })
  })

  it('ignores deactivated rates', () => {
    const rates = [
      rate({ id: 1, amountPaise: 50000 }),
      rate({ id: 2, scope: 'payer', payerId: 7, amountPaise: 1, deactivated: true }),
      rate({ id: 3, roomCategoryCode: 'PRIVATE', amountPaise: 2, deactivated: true }),
    ]
    expect(resolvePrice(q({ payerId: 7, roomCategory: 'PRIVATE' }), ctx(rates))).toMatchObject({ ok: true, rateId: 1 })
    expect(resolvePrice(q(), ctx([rate({ id: 1, deactivated: true })]))).toEqual({ ok: false, reason: 'no_rate' })
  })

  it('breaks an equal-specificity tie by later validFrom, then higher id', () => {
    const older = rate({ id: 9, validFrom: '2026-01-01', amountPaise: 100 })
    const newer = rate({ id: 3, validFrom: '2026-06-01', amountPaise: 200 })
    expect(resolvePrice(q(), ctx([older, newer]))).toMatchObject({ rateId: 3 })
    const a = rate({ id: 4, validFrom: '2026-06-01', amountPaise: 400 })
    expect(resolvePrice(q(), ctx([a, newer]))).toMatchObject({ rateId: 4 })
  })

  it('reports service_not_found, service_inactive, no_rate and invalid_date', () => {
    expect(resolvePrice(q(), ctx([rate()], null))).toEqual({ ok: false, reason: 'service_not_found' })
    expect(resolvePrice(q(), ctx([rate()], { ...svc, isActive: false }))).toEqual({ ok: false, reason: 'service_inactive' })
    expect(resolvePrice(q(), ctx([]))).toEqual({ ok: false, reason: 'no_rate' })
    for (const bad of ['', '2026-1-07', '07-10-2026', '2026-13-01', '2026-02-30', '2026-10-07T00:00:00Z', 'today', '2025-02-29']) {
      expect(resolvePrice(q({ onDate: bad }), ctx([rate()]))).toEqual({ ok: false, reason: 'invalid_date' })
    }
    expect(resolvePrice(q({ onDate: '2028-02-29' }), ctx([rate()]))).toMatchObject({ ok: true })
  })

  it('checks the date before the service', () => {
    expect(resolvePrice(q({ onDate: 'nope' }), ctx([], null))).toEqual({ ok: false, reason: 'invalid_date' })
  })

  it('carries GST basis points and HSN/SAC from the service', () => {
    expect(resolvePrice(q(), ctx([rate({ id: 1, amountPaise: 123456 })]))).toEqual({
      ok: true, serviceId: 100, serviceCode: 'CONS-GEN', serviceName: 'General consultation',
      amountPaise: 123456, currency: 'INR', gstRateBp: 1800, hsnSac: '999312',
      rateId: 1, scope: 'base', matched: { roomCategory: false, ward: false },
    })
  })

  it('prices a package service through the same rules', () => {
    const pkg: ServiceForPricing = { id: 200, code: 'PKG-APPY', name: 'Appendectomy package', departmentId: 30, isActive: true, hsnSac: '999311', gstRateBp: 0 }
    const r = resolvePrice(q({ serviceId: 200, payerId: 7, roomCategory: 'SEMI' }), ctx([
      rate({ id: 1, serviceId: 200, amountPaise: 4500000 }),
      rate({ id: 2, serviceId: 200, scope: 'department', departmentId: 30, roomCategoryCode: 'SEMI', amountPaise: 4000000 }),
    ], pkg))
    expect(r).toMatchObject({ ok: true, serviceId: 200, rateId: 2, scope: 'department', amountPaise: 4000000, gstRateBp: 0 })
  })

  it('returns a result independent of candidate order (shuffled)', () => {
    const rates = [
      rate({ id: 1, amountPaise: 100 }),
      rate({ id: 2, roomCategoryCode: 'PRIVATE', amountPaise: 200 }),
      rate({ id: 3, scope: 'department', departmentId: 10, amountPaise: 300 }),
      rate({ id: 4, scope: 'department', departmentId: 10, ward: 'icu', amountPaise: 400 }),
      rate({ id: 5, scope: 'department', departmentId: 10, ward: 'ICU', validFrom: '2026-05-01', amountPaise: 500 }),
      rate({ id: 6, scope: 'department', departmentId: 10, ward: 'ICU', validFrom: '2026-05-01', amountPaise: 600 }),
      rate({ id: 7, scope: 'payer', payerId: 7, roomCategoryCode: 'GENERAL', amountPaise: 700 }),
      rate({ id: 8, scope: 'payer', payerId: 8, amountPaise: 800 }),
      rate({ id: 9, scope: 'department', departmentId: 20, amountPaise: 900 }),
      rate({ id: 10, scope: 'department', departmentId: 10, ward: 'ICU', roomCategoryCode: 'PRIVATE', deactivated: true }),
      rate({ id: 11, scope: 'department', departmentId: 10, ward: 'ICU', validFrom: '2026-11-01' }),
    ]
    const queries: PriceQuery[] = [
      q(), q({ payerId: 7 }), q({ payerId: 7, roomCategory: 'general' }), q({ payerId: 8 }),
      q({ ward: ' icu ' }), q({ roomCategory: 'PRIVATE', ward: 'ICU' }), q({ departmentId: 20 }), q({ roomCategory: 'PRIVATE' }),
    ]
    const expected = queries.map((query) => resolvePrice(query, ctx(rates)))
    expect(expected.map((r) => (r.ok ? r.rateId : r.reason))).toEqual([3, 3, 7, 8, 6, 6, 9, 3])

    // deterministic LCG so failures are reproducible
    let seed = 20261007
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    for (let i = 0; i < 200; i++) {
      const shuffled = [...rates]
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(rand() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]]
      }
      queries.forEach((query, n) => expect(resolvePrice(query, ctx(shuffled))).toEqual(expected[n]))
    }
  })

  it('does not mutate the candidate array', () => {
    const rates = [rate({ id: 2 }), rate({ id: 1 })]
    const snapshot = JSON.parse(JSON.stringify(rates))
    resolvePrice(q(), ctx(rates))
    expect(rates).toEqual(snapshot)
  })
})
