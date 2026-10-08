import { describe, expect, it } from 'vitest'
import { istDateOf } from '@/lib/india-time'
import { DOCUMENT_SERIES, MAX_SERIES_VALUE, SERIES_PREFIX, financialYearOf, formatDocumentNumber } from '@/lib/billing/numbering'

describe('document numbering', () => {
  it('financial year turns at 1 April', () => {
    expect(financialYearOf('2026-04-01')).toBe('2026-27'); expect(financialYearOf('2027-03-31')).toBe('2026-27')
    expect(financialYearOf('2027-04-01')).toBe('2027-28'); expect(financialYearOf('2099-06-01')).toBe('2099-00')
    expect(financialYearOf('2026-01-15')).toBe('2025-26')
  })
  it('financial year turns at IST midnight on 1 April', () => {
    expect(financialYearOf(istDateOf(new Date('2027-03-31T18:40:00Z')))).toBe('2027-28')
    expect(financialYearOf(istDateOf(new Date('2027-03-31T18:20:00Z')))).toBe('2026-27')
  })
  it('rejects a malformed date', () => { expect(() => financialYearOf('2026/04/01')).toThrow(RangeError) })
  it('has the four series with their prefixes', () => {
    expect([...DOCUMENT_SERIES]).toEqual(['invoice', 'receipt', 'credit_note', 'refund'])
    expect(SERIES_PREFIX).toEqual({ invoice: 'INV', receipt: 'RCT', credit_note: 'CRN', refund: 'RFD' })
  })
  it('formats every series within the GST 16-character limit', () => {
    expect(formatDocumentNumber('invoice', '2026-27', 123)).toBe('INV/26-27/000123')
    expect(formatDocumentNumber('refund', '2099-00', 1)).toBe('RFD/99-00/000001')
    for (const s of DOCUMENT_SERIES) expect(formatDocumentNumber(s, '2026-27', MAX_SERIES_VALUE).length).toBeLessThanOrEqual(16)
    expect(formatDocumentNumber('invoice', '2026-27', MAX_SERIES_VALUE)).toBe('INV/26-27/999999')
    expect(() => formatDocumentNumber('invoice', '2026-27', 1_000_000)).toThrow('Document series exhausted')
    expect(() => formatDocumentNumber('invoice', '2026-27', 0)).toThrow('Document series exhausted')
    expect(() => formatDocumentNumber('invoice', '2026-27', 1.5)).toThrow('Document series exhausted')
  })
})
