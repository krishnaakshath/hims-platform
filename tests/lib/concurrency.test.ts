import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from '@/lib/concurrency'

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` loaders at once and keeps input order', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const out = await mapWithConcurrency(Array.from({ length: 13 }, (_, i) => i), 4, async (n) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await tick(5 + ((n * 7) % 11))
      inFlight--
      return n * 2
    })
    expect(maxInFlight).toBe(4)
    expect(out).toEqual(Array.from({ length: 13 }, (_, i) => i * 2))
  })

  it('passes the index and handles fewer items than the limit', async () => {
    expect(await mapWithConcurrency(['a', 'b'], 8, async (s, i) => `${s}${i}`)).toEqual(['a0', 'b1'])
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })

  it('rejects with the first loader error', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })).rejects.toThrow('boom')
  })

  it('rejects a limit below 1', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow()
  })
})
