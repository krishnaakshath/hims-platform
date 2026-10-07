import { describe, it, expect } from 'vitest'
import { isValidAadhaar, normalizeAadhaar, aadhaarLast4, maskAadhaarLast4 } from '@/lib/india/aadhaar'

describe('aadhaar', () => {
  it.each(['234567890124', '2345 6789 0124', '2345-6789-0124', '498765432102', '987654321012'])('accepts %s', (v) => expect(isValidAadhaar(v)).toBe(true))
  it.each(['234567890125', '134567890124', '034567890124', '23456789012', '2345678901245', 'abcd56789012', ''])('rejects %s', (v) => expect(isValidAadhaar(v)).toBe(false))
  it('masks to last four', () => {
    expect(maskAadhaarLast4(aadhaarLast4(normalizeAadhaar('2345 6789 0124')))).toBe('XXXX XXXX 0124')
  })
})
