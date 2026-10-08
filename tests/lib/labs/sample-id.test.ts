import { describe, it, expect } from 'vitest'
import { formatSampleId, parseSampleId, displaySampleId } from '@/lib/labs/sample-id'
import { verhoeffCheckDigit } from '@/lib/india/verhoeff'

describe('sample IDs', () => {
  it('formats with a Verhoeff check digit and displays grouped', () => {
    expect(formatSampleId('2026-10-08', 42)).toBe('L26100800429')
    expect(formatSampleId('2026-12-31', 1234)).toBe('L26123112342')
    expect(displaySampleId('L26100800429')).toBe('L261008-0042-9')
  })

  it('grows past four sequence digits and round-trips', () => {
    const id = formatSampleId('2026-10-08', 123456)
    expect(id).toMatch(/^L261008123456\d$/)
    expect(parseSampleId(id)).toEqual({ canonical: id, dateIso: '2026-10-08', seq: 123456 })
    expect(displaySampleId(id)).toBe(`L261008-123456-${id.slice(-1)}`)
  })

  it('refuses an out-of-range sequence', () => {
    expect(() => formatSampleId('2026-10-08', 0)).toThrow()
    expect(() => formatSampleId('2026-10-08', 1_000_000)).toThrow()
    expect(() => formatSampleId('2026-10-08', 1.5)).toThrow()
  })

  it('parses scanner and typed forms', () => {
    expect(parseSampleId(' l261008-0042-9 ')).toEqual({ canonical: 'L26100800429', dateIso: '2026-10-08', seq: 42 })
    expect(parseSampleId('L26100800429')).toEqual({ canonical: 'L26100800429', dateIso: '2026-10-08', seq: 42 })
  })

  it('rejects a single-digit typo and an adjacent transposition', () => {
    expect(parseSampleId('L26100800439')).toBeNull() // 42 → 43
    expect(parseSampleId('L26100800249')).toBeNull() // 42 → 24
    expect(parseSampleId('L26133100011')).toBeNull() // month 13
  })

  it('rejects impossible calendar dates even with a valid check digit', () => {
    const digits = '2602300001' // 30 Feb 2026
    expect(parseSampleId(`L${digits}${verhoeffCheckDigit(digits)}`)).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseSampleId('')).toBeNull()
    expect(parseSampleId('X26100800429')).toBeNull()
    expect(parseSampleId('L2610080042')).toBeNull()
  })
})
