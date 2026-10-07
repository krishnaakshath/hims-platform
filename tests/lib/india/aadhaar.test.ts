import { describe, it, expect } from 'vitest'
import { isValidAadhaar, normalizeAadhaar, aadhaarLast4, maskAadhaarLast4, containsAadhaarLike, redactAadhaarLike } from '@/lib/india/aadhaar'

describe('aadhaar', () => {
  it.each(['234567890124', '2345 6789 0124', '2345-6789-0124', '498765432102', '987654321012'])('accepts %s', (v) => expect(isValidAadhaar(v)).toBe(true))
  it.each(['234567890125', '134567890124', '034567890124', '23456789012', '2345678901245', 'abcd56789012', ''])('rejects %s', (v) => expect(isValidAadhaar(v)).toBe(false))
  it('masks to last four', () => {
    expect(maskAadhaarLast4(aadhaarLast4(normalizeAadhaar('2345 6789 0124')))).toBe('XXXX XXXX 0124')
  })

  describe('free-text detector (shared by zod notes, buildAadhaarRow and logAudit)', () => {
    it.each([
      '234567890124', '2345 6789 0124', '2345-6789-0124', '2345.6789.0124', '2345  6789  0124', '2345/6789/0124',
      '2345 -/. 6789\t0124', 'card no 2345.6789-0124 lost', 'x234567890124y',
    ])('detects and redacts %j', (t) => {
      expect(containsAadhaarLike(t)).toBe(true)
      expect(redactAadhaarLike(t)).not.toMatch(/2345|6789/)
      expect(redactAadhaarLike(t)).toContain('[redacted]')
    })
    it.each([
      '234567890125', // checksum wrong
      '134567890124', // leading 1
      '12345678901234', // 14 digits (ABHA-length run)
      '1234567890124', // 13-digit run containing a valid 12 at the end
      'lost card', '',
    ])('leaves %j alone', (t) => {
      expect(containsAadhaarLike(t)).toBe(false)
      expect(redactAadhaarLike(t)).toBe(t)
    })
    it('redacts every occurrence and is stateless across calls', () => {
      expect(redactAadhaarLike('234567890124 and 2345.6789.0124')).toBe('[redacted] and [redacted]')
      expect(containsAadhaarLike('234567890124')).toBe(true)
      expect(containsAadhaarLike('234567890124')).toBe(true)
    })
  })
})
