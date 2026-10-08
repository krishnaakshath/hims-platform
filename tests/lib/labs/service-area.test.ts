import { describe, it, expect } from 'vitest'
import { parsePinList, isLocalPin } from '@/lib/labs/service-area'

describe('service area', () => {
  it('parses a pasted PIN list and reports invalid entries', () => {
    expect(parsePinList('560001, 560002\n560001;06001 abc')).toEqual({ pins: ['560001', '560002'], invalid: ['06001', 'abc'] })
  })

  it('ignores empty input and separators only', () => {
    expect(parsePinList('  ,;\n ')).toEqual({ pins: [], invalid: [] })
  })

  it('a patient is local only when the PIN is active', () => {
    expect(isLocalPin(' 560001 ', new Set(['560001']))).toBe(true)
    expect(isLocalPin(null, new Set(['560001']))).toBe(false)
    expect(isLocalPin(undefined, new Set(['560001']))).toBe(false)
    expect(isLocalPin('560002', new Set(['560001']))).toBe(false)
  })
})
