import { describe, it, expect } from 'vitest'
import { toRateCandidate, toDatedRate, packageItemsProblem, type RateRow, type ServiceRow } from '@/lib/queries/tariff'

const rate = (over: Partial<RateRow> = {}): RateRow => ({
  id: 7, serviceId: 3, scope: 'payer', departmentId: null, payerId: 11, roomCategoryId: 4, ward: 'icu ward',
  amountPaise: 125000, currency: 'INR', validFrom: '2026-01-01', validTo: '2026-12-31', deactivatedAt: null,
  createdByName: 'admin', createdAt: new Date('2026-01-01T00:00:00Z'),
  payerName: 'Star Health', departmentName: null, roomCategoryCode: 'PVT',
  ...over,
})

const svc = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  id: 1, code: 'PKG1', name: 'Package', departmentId: 2, category: 'package', hsnSac: '999311', gstRateBp: 0,
  isActive: true, createdAt: new Date(), updatedAt: new Date(), departmentCode: 'GEN', departmentName: 'General',
  requiresPreauth: false, maxQuantity: null, // SP4
  ...over,
})

describe('tariff row mapping', () => {
  it('toRateCandidate maps deactivatedAt to deactivated and keeps the room category code', () => {
    expect(toRateCandidate(rate())).toEqual({
      id: 7, serviceId: 3, scope: 'payer', departmentId: null, payerId: 11, roomCategoryCode: 'PVT', ward: 'icu ward',
      amountPaise: 125000, validFrom: '2026-01-01', validTo: '2026-12-31', deactivated: false,
    })
    const off = toRateCandidate(rate({ deactivatedAt: new Date(), roomCategoryId: null, roomCategoryCode: null, validTo: null }))
    expect(off.deactivated).toBe(true)
    expect(off.roomCategoryCode).toBeNull()
    expect(off.validTo).toBeNull()
  })

  it('toDatedRate keeps the dimension ids and flags deactivation', () => {
    expect(toDatedRate(rate())).toEqual({
      id: 7, serviceId: 3, scope: 'payer', departmentId: null, payerId: 11, roomCategoryId: 4, ward: 'icu ward',
      validFrom: '2026-01-01', validTo: '2026-12-31', deactivated: false,
    })
    expect(toDatedRate(rate({ deactivatedAt: new Date() })).deactivated).toBe(true)
  })

  it('packageItemsProblem rejects self, nested packages, inactive items and a non-package parent', () => {
    const pkg = svc()
    const item = svc({ id: 2, code: 'X1', category: 'procedure' })
    const nested = svc({ id: 3, code: 'PKG2', category: 'package' })
    const inactive = svc({ id: 4, code: 'X2', category: 'procedure', isActive: false })
    const byId = new Map([pkg, item, nested, inactive].map((s) => [s.id, s]))

    expect(packageItemsProblem(pkg, [{ serviceId: 2, quantity: 2 }], byId)).toBeNull()
    expect(packageItemsProblem(pkg, [], byId)).toBeNull()
    expect(packageItemsProblem(pkg, [{ serviceId: 1, quantity: 1 }], byId)).toMatch(/itself/i)
    expect(packageItemsProblem(pkg, [{ serviceId: 3, quantity: 1 }], byId)).toMatch(/PKG2.*package/i)
    expect(packageItemsProblem(pkg, [{ serviceId: 4, quantity: 1 }], byId)).toMatch(/X2.*inactive/i)
    expect(packageItemsProblem(pkg, [{ serviceId: 99, quantity: 1 }], byId)).toMatch(/unknown/i)
    expect(packageItemsProblem(item, [{ serviceId: 2, quantity: 1 }], byId)).toMatch(/not a package/i)
  })
})
