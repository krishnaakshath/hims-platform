import { describe, it, expect } from 'vitest'
import { buildPriceSheet, type PriceSheetRate } from '@/lib/tariff/price-sheet'

// Wave G P1-05: the price lookup's rate card -- every rate in force on a date,
// by scope (base, department, payer) and room category / ward, in INR.
const rate = (over: Partial<PriceSheetRate>): PriceSheetRate => ({
  id: 1, scope: 'base', departmentId: null, departmentName: null, payerId: null, payerName: null,
  roomCategoryCode: null, ward: null, amountPaise: 50000, validFrom: '2026-01-01', validTo: null, deactivatedAt: null,
  ...over,
})
const CATS = [{ code: 'DELUXE', name: 'Deluxe room' }, { code: 'GENERAL', name: 'General ward' }]

describe('buildPriceSheet', () => {
  it('keeps only rates in force on the date (inclusive range, deactivated never)', () => {
    const sheet = buildPriceSheet([
      rate({ id: 1 }),
      rate({ id: 2, validFrom: '2026-10-09' }),
      rate({ id: 3, validTo: '2026-10-07', roomCategoryCode: 'DELUXE' }),
      rate({ id: 4, validTo: '2026-10-08', roomCategoryCode: 'GENERAL' }),
      rate({ id: 5, deactivatedAt: new Date('2026-02-01T00:00:00Z'), ward: 'icu' }),
    ], '2026-10-08', CATS)
    expect(sheet.rows.map((r) => r.rateId)).toEqual([1, 4])
  })

  it('orders base, then department, then payer; generic before room/ward specific', () => {
    const sheet = buildPriceSheet([
      rate({ id: 1, scope: 'payer', payerId: 7, payerName: 'Star Health' }),
      rate({ id: 2, scope: 'department', departmentId: 3, departmentName: 'Cardiology', roomCategoryCode: 'DELUXE' }),
      rate({ id: 3, scope: 'department', departmentId: 3, departmentName: 'Cardiology' }),
      rate({ id: 4, ward: 'icu' }),
      rate({ id: 5 , roomCategoryCode: 'GENERAL' }),
      rate({ id: 6 }),
    ], '2026-10-08', CATS)
    expect(sheet.rows.map((r) => r.rateId)).toEqual([6, 5, 4, 3, 2, 1])
  })

  it('formats money as INR from paise and names room categories', () => {
    const [row] = buildPriceSheet([rate({ amountPaise: 123456, roomCategoryCode: 'DELUXE' })], '2026-10-08', CATS).rows
    expect(row.formatted).toBe('₹1,234.56')
    expect(row.roomCategoryName).toBe('Deluxe room')
    expect(row.roomCategoryCode).toBe('DELUXE')
  })

  it('lists the distinct payers and departments that have a rate (for the lookup filters)', () => {
    const sheet = buildPriceSheet([
      rate({ id: 1, scope: 'payer', payerId: 7, payerName: 'Star Health' }),
      rate({ id: 2, scope: 'payer', payerId: 7, payerName: 'Star Health', roomCategoryCode: 'DELUXE' }),
      rate({ id: 3, scope: 'department', departmentId: 3, departmentName: 'Cardiology' }),
      rate({ id: 4, ward: 'icu' }),
    ], '2026-10-08', CATS)
    expect(sheet.payers).toEqual([{ id: 7, name: 'Star Health' }])
    expect(sheet.departments).toEqual([{ id: 3, name: 'Cardiology' }])
    expect(sheet.wards).toEqual(['icu'])
  })
})
