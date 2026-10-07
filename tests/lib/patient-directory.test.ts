import { describe, it, expect } from 'vitest'
import { matchesDirectoryQuery, paginate, parseDirectoryParams, phoneQueryDigits, PATIENT_PAGE_SIZE } from '@/lib/patient-directory'

const P = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH000123', phone: '+919876543210' }

// Wave B P1-08
describe('patient directory filter', () => {
  it.each(['asha', 'RD-0001', 'rd-00', 'uh000123', '000123', '9876543210', '+91 98765 43210', '98765'])('matches %s', (q) => {
    expect(matchesDirectoryQuery(P, q)).toBe(true)
  })
  it.each(['vikram', 'UH999', '11111'])('does not match %s', (q) => {
    expect(matchesDirectoryQuery(P, q)).toBe(false)
  })
  it('matches everything for an empty query', () => {
    expect(matchesDirectoryQuery(P, '  ')).toBe(true)
  })
  it('treats only phone-shaped queries with 5+ digits as a phone', () => {
    expect(phoneQueryDigits('0001')).toBeNull()
    expect(phoneQueryDigits('RD-00012')).toBeNull()
    expect(phoneQueryDigits('+91 98765 43210')).toBe('9876543210')
    expect(phoneQueryDigits('09876543210')).toBe('9876543210')
  })
})

describe('paginate', () => {
  const rows = Array.from({ length: 65 }, (_, i) => i)
  it('slices one page and reports the total', () => {
    expect(paginate(rows, 2, 30)).toEqual({ rows: rows.slice(30, 60), page: 2, pageSize: 30, total: 65, pageCount: 3 })
  })
  it('clamps an out-of-range page to the last page', () => {
    expect(paginate(rows, 9, 30).page).toBe(3)
    expect(paginate([], 4, 30)).toEqual({ rows: [], page: 1, pageSize: 30, total: 0, pageCount: 1 })
  })
})

describe('parseDirectoryParams', () => {
  it('reads q and page defensively', () => {
    expect(parseDirectoryParams({ q: '  asha ', page: '3' })).toEqual({ q: 'asha', page: 3 })
    expect(parseDirectoryParams({ q: ['a', 'b'], page: 'x' })).toEqual({ q: 'a', page: 1 })
    expect(parseDirectoryParams({ page: '-2' })).toEqual({ q: '', page: 1 })
    expect(parseDirectoryParams({ q: 'x'.repeat(300) }).q).toHaveLength(100)
  })
  it('has a sane page size', () => {
    expect(PATIENT_PAGE_SIZE).toBeGreaterThanOrEqual(20)
  })
})
