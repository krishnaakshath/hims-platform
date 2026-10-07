import { describe, it, expect } from 'vitest'
import { formatUhid, parseUhid, isValidUhidPrefix } from '@/lib/uhid'

describe('uhid', () => {
  it('formats prefix + 8-digit sequence + Verhoeff digit', () => {
    expect(formatUhid('UH', 42)).toBe('UH000000427')
    expect(formatUhid('UH', 1)).toBe('UH000000017')
    expect(formatUhid('MH01', 100)).toBe('MH01000001002')
  })
  it('round-trips and rejects a typo', () => {
    expect(parseUhid('UH000000427')).toEqual({ prefix: 'UH', seq: 42 })
    expect(parseUhid('MH01000001002')).toEqual({ prefix: 'MH01', seq: 100 })
    expect(parseUhid('UH000000428')).toBeNull()
    expect(parseUhid('UH00000427')).toBeNull()
  })
  it.each(['uh', '1UH', 'TOOLONGX', 'U-H', ''])('rejects prefix %s', (p) => expect(() => formatUhid(p, 1)).toThrow())
  it.each([0, -1, 1.5, 100_000_000])('rejects seq %s', (n) => expect(() => formatUhid('UH', n)).toThrow())
  it('validates prefixes', () => {
    expect(isValidUhidPrefix('UH')).toBe(true)
    expect(isValidUhidPrefix('ABCDEF')).toBe(true)
    expect(isValidUhidPrefix('ABCDEFG')).toBe(false)
    expect(isValidUhidPrefix('uh')).toBe(false)
  })
})
