import { describe, it, expect } from 'vitest'
import { serviceCategoryEnum, TARIFF_SCOPES } from '@/db/schema'
import {
  AMOUNT_CAP_MESSAGE, MAX_AMOUNT_PAISE,
  RATE_SCOPES, SERVICE_CATEGORIES, GST_RATES_BP, gstPercentToBp, hsnSacKind, hsnSacProblem,
  serviceCreateSchema, serviceUpdateSchema, rateCreateSchema, rateRevisionSchema, ratePatchSchema,
  roomCategoryCreateSchema, roomCategoryUpdateSchema, roomAssignmentSchema, packageItemsSchema,
  resolveQuerySchema, isoDate, SERVICE_CODE_PATTERN, ROOM_CATEGORY_CODE_PATTERN,
} from '@/lib/tariff/validation'

const svc = { code: 'opd-cons', name: 'OPD consultation', departmentId: 1, category: 'consultation', hsnSac: '999312', gstRateBp: 0 }

describe('tariff validation', () => {
  it('SERVICE_CATEGORIES and TARIFF scopes mirror the schema', () => {
    expect(SERVICE_CATEGORIES.map((c) => c.code)).toEqual(serviceCategoryEnum.enumValues)
    expect([...RATE_SCOPES]).toEqual([...TARIFF_SCOPES])
    expect([...GST_RATES_BP]).toEqual([0, 500, 1200, 1800, 2800, 4000])
  })
  it.each([['999312', 'sac'], ['3004', 'hsn'], ['30049099', 'hsn'], ['9993', 'hsn'], ['99931', null], ['abc123', null]])('hsnSacKind %s', (c, k) => expect(hsnSacKind(c)).toBe(k))
  it('needs SAC for a consultation and HSN for a consumable', () => {
    expect(hsnSacProblem('consultation', '3004')).not.toBeNull(); expect(hsnSacProblem('consultation', '999312')).toBeNull()
    expect(hsnSacProblem('consumable', '999312')).not.toBeNull(); expect(hsnSacProblem('consumable', '30059010')).toBeNull()
    expect(hsnSacProblem('other', '999312')).toBeNull(); expect(hsnSacProblem('other', '3004')).toBeNull()
    expect(hsnSacProblem('other', 'zz')).not.toBeNull()
  })
  it.each([['18', 1800], ['18%', 1800], ['18.0', 1800], ['0', 0], ['40', 4000], ['10', null], ['-5', null], ['', null], ['abc', null]])('gstPercentToBp %s', (i, o) => expect(gstPercentToBp(i)).toBe(o))
  it('upper-cases the service code and rejects a bad one', () => {
    expect(serviceCreateSchema.parse(svc).code).toBe('OPD-CONS')
    expect(serviceCreateSchema.safeParse({ ...svc, code: '-X' }).success).toBe(false)
    expect(SERVICE_CODE_PATTERN.test('A')).toBe(false)
    expect(ROOM_CATEGORY_CODE_PATTERN.test('ICU_1')).toBe(true)
  })
  it('service create rejects mismatched HSN/SAC, bad GST, unknown keys', () => {
    expect(serviceCreateSchema.safeParse({ ...svc, hsnSac: '3004' }).success).toBe(false)
    expect(serviceCreateSchema.safeParse({ ...svc, gstRateBp: 1000 }).success).toBe(false)
    expect(serviceCreateSchema.safeParse({ ...svc, extra: 1 }).success).toBe(false)
  })
  it('serviceUpdateSchema refuses a code change and an empty body', () => {
    expect(serviceUpdateSchema.safeParse({ code: 'NEW' }).success).toBe(false)
    expect(serviceUpdateSchema.safeParse({}).success).toBe(false)
    expect(serviceUpdateSchema.safeParse({ isActive: false }).success).toBe(true)
    expect(serviceUpdateSchema.safeParse({ name: 'x' }).success).toBe(true)
  })
  it('rateCreateSchema enforces scope keys and ordered dates', () => {
    const base = { serviceId: 1, amountPaise: 50000, validFrom: '2026-10-01' }
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base' }).success).toBe(true)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'payer' }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'payer', payerId: 3 }).success).toBe(true)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'department', departmentId: 2 }).success).toBe(true)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'department', departmentId: 2, payerId: 3 }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', payerId: 3 }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', validTo: '2026-09-30' }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', validTo: '2026-10-01' }).success).toBe(true)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', validFrom: '2026-02-30' }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', amountPaise: -1 }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', amountPaise: 10_000_000_001 }).success).toBe(false)
    // int4 column: the cap is ₹1 crore (1_000_000_000 paise), with a fixed, passable message.
    expect(MAX_AMOUNT_PAISE).toBe(1_000_000_000)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', amountPaise: 1_000_000_000 }).success).toBe(true)
    const over = rateCreateSchema.safeParse({ ...base, scope: 'base', amountPaise: 1_000_000_001 })
    expect(over.success).toBe(false)
    expect(over.error?.issues[0]).toMatchObject({ code: 'custom', message: AMOUNT_CAP_MESSAGE })
    expect(rateRevisionSchema.safeParse({ amountPaise: 1_000_000_000, effectiveFrom: '2026-10-08' }).success).toBe(true)
    expect(rateRevisionSchema.safeParse({ amountPaise: 1_000_000_001, effectiveFrom: '2026-10-08' }).error?.issues[0].message).toBe(AMOUNT_CAP_MESSAGE)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', amountPaise: 1.5 }).success).toBe(false)
    expect(rateCreateSchema.safeParse({ ...base, scope: 'base', ward: '' }).success).toBe(false)
  })
  it('isoDate rejects non-calendar dates', () => {
    expect(isoDate.safeParse('2028-02-29').success).toBe(true)
    expect(isoDate.safeParse('2027-02-29').success).toBe(false)
    expect(isoDate.safeParse('2026-1-1').success).toBe(false)
  })
  it('revision and patch schemas', () => {
    expect(rateRevisionSchema.safeParse({ amountPaise: 100, effectiveFrom: '2026-10-08' }).success).toBe(true)
    expect(ratePatchSchema.safeParse({ validTo: '2026-10-08' }).success).toBe(true)
    expect(ratePatchSchema.safeParse({ deactivate: true }).success).toBe(true)
    expect(ratePatchSchema.safeParse({ deactivate: false }).success).toBe(false)
    expect(ratePatchSchema.safeParse({}).success).toBe(false)
    expect(ratePatchSchema.safeParse({ deactivate: true, validTo: '2026-10-08' }).success).toBe(false)
  })
  it('room category schemas', () => {
    expect(roomCategoryCreateSchema.parse({ code: 'icu', name: 'ICU' }).code).toBe('ICU')
    expect(roomCategoryCreateSchema.safeParse({ code: '1X', name: 'n' }).success).toBe(false)
    expect(roomCategoryUpdateSchema.safeParse({ code: 'X' }).success).toBe(false)
    expect(roomCategoryUpdateSchema.safeParse({ isActive: true }).success).toBe(true)
    expect(roomAssignmentSchema.safeParse({ roomCategoryId: null }).success).toBe(true)
    expect(roomAssignmentSchema.safeParse({ roomCategoryId: 3 }).success).toBe(true)
    expect(roomAssignmentSchema.safeParse({}).success).toBe(false)
  })
  it('resolveQuerySchema needs exactly one service key and rejects unknown params', () => {
    expect(resolveQuerySchema.safeParse({ serviceId: '4', onDate: '2026-10-07' }).success).toBe(true)
    expect(resolveQuerySchema.parse({ serviceId: '4', payerId: '2' })).toMatchObject({ serviceId: 4, payerId: 2 })
    expect(resolveQuerySchema.safeParse({ serviceCode: 'OPD' }).success).toBe(true)
    expect(resolveQuerySchema.safeParse({}).success).toBe(false)
    expect(resolveQuerySchema.safeParse({ serviceId: '4', serviceCode: 'OPD' }).success).toBe(false)
    expect(resolveQuerySchema.safeParse({ serviceId: '4', patientId: 'RD-0001' }).success).toBe(false)
    expect(resolveQuerySchema.safeParse({ serviceId: 'abc' }).success).toBe(false)
  })
  it('packageItemsSchema rejects duplicate items, bad quantities and >100 items', () => {
    expect(packageItemsSchema.safeParse({ items: [{ serviceId: 1, quantity: 2 }, { serviceId: 2, quantity: 1 }] }).success).toBe(true)
    expect(packageItemsSchema.safeParse({ items: [{ serviceId: 1, quantity: 2 }, { serviceId: 1, quantity: 1 }] }).success).toBe(false)
    expect(packageItemsSchema.safeParse({ items: [{ serviceId: 1, quantity: 0 }] }).success).toBe(false)
    expect(packageItemsSchema.safeParse({ items: [{ serviceId: 1, quantity: 1000 }] }).success).toBe(false)
    expect(packageItemsSchema.safeParse({ items: Array.from({ length: 101 }, (_, i) => ({ serviceId: i + 1, quantity: 1 })) }).success).toBe(false)
  })
})

// SP4: service billing flags.
describe('service billing flags (SP4)', () => {
  it('service update accepts requiresPreauth and a maxQuantity of 1..1000', () => {
    expect(serviceUpdateSchema.safeParse({ requiresPreauth: true }).success).toBe(true)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: 1 }).success).toBe(true)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: 1000 }).success).toBe(true)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: null }).success).toBe(true)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: 0 }).success).toBe(false)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: 1001 }).success).toBe(false)
    expect(serviceUpdateSchema.safeParse({ maxQuantity: 2.5 }).success).toBe(false)
    expect(serviceUpdateSchema.safeParse({ requiresPreauth: 'yes' }).success).toBe(false)
  })
  it('service create accepts the flags too and leaves them optional', () => {
    expect(serviceCreateSchema.safeParse({ ...svc, requiresPreauth: true, maxQuantity: 5 }).success).toBe(true)
    expect(serviceCreateSchema.safeParse(svc).success).toBe(true)
  })
})
