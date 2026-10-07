import { describe, it, expect, expectTypeOf } from 'vitest'
import { datesToIso, type DatesToIso, type HasDate } from '@/lib/cache-shape'

describe('datesToIso', () => {
  it('replaces every Date at any depth with its ISO string and leaves the rest alone', () => {
    const d = new Date('2026-10-08T04:30:00.000Z')
    const input = { a: d, b: [d, { c: d, n: 1 }], s: 'x', z: null, u: undefined, nested: { deep: [[d]] } }
    const out = datesToIso(input)
    expect(out).toEqual({ a: d.toISOString(), b: [d.toISOString(), { c: d.toISOString(), n: 1 }], s: 'x', z: null, u: undefined, nested: { deep: [[d.toISOString()]] } })
    // A Redis cache hit (JSON round-trip) yields the identical value.
    expect(JSON.parse(JSON.stringify(out))).toEqual(out)
  })

  it('handles top-level dates, nulls and primitives', () => {
    expect(datesToIso(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
    expect(datesToIso(null)).toBeNull()
    expect(datesToIso(3)).toBe(3)
  })

  it('maps types too', () => {
    expectTypeOf<DatesToIso<{ at: Date; list: { when: Date | null }[] }>>().toEqualTypeOf<{ at: string; list: { when: string | null }[] }>()
    expectTypeOf<HasDate<{ a: { b: Date[] } }>>().toEqualTypeOf<true>()
    expectTypeOf<HasDate<{ a: string; b: number[] }>>().toEqualTypeOf<false>()
  })
})
