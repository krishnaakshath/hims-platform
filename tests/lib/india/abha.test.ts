import { describe, it, expect } from 'vitest'
import { normalizeAbhaNumber, isValidAbhaNumber, formatAbhaNumber, normalizeAbhaAddress, isValidAbhaAddress } from '@/lib/india/abha'

describe('abha', () => {
  it('normalises and formats a 14-digit ABHA number', () => {
    expect(normalizeAbhaNumber('12-3456-7890-1234')).toBe('12345678901234')
    expect(isValidAbhaNumber('12-3456-7890-1234')).toBe(true)
    expect(isValidAbhaNumber('1234567890123')).toBe(false)
    expect(formatAbhaNumber('12345678901234')).toBe('12-3456-7890-1234')
  })
  it('normalises address', () => {
    expect(normalizeAbhaAddress('  RaviKumar99@ABDM ')).toBe('ravikumar99@abdm')
  })
  it.each(['ravi.kumar@abdm', 'ravi_kumar1@sbx', 'RaviKumar99@ABDM'])('accepts ABHA address %s', (v) => expect(isValidAbhaAddress(v)).toBe(true))
  it.each(['ravi@abdm', '.ravikumar@abdm', 'ravikumar.@abdm', 'ra.vi.kumar@abdm', 'ravikumar@gmail.com', 'ravikumar'])('rejects ABHA address %s', (v) => expect(isValidAbhaAddress(v)).toBe(false))
})
