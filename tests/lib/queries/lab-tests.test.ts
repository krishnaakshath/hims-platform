import { describe, it, expect } from 'vitest'
import { listLabTests } from '@/lib/queries/lab-tests'

describe('lab tests catalog', () => {
  it('lists at least the 10 seeded tests', async () => {
    const all = await listLabTests()
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all.some((t) => t.code === 'TSH')).toBe(true)
  })

  it('includes the seeded imaging studies with a category of "imaging"', async () => {
    const all = await listLabTests()
    const chest = all.find((t) => t.code === 'XR-CHEST-2V')
    expect(chest).toBeDefined()
    expect(chest!.category).toBe('imaging')
    expect(chest!.defaultUnit).toBeNull()
    expect(chest!.referenceRange).toBeNull()
  })

  it('gives every catalog row a category, with the chemistry panels on "lab"', async () => {
    const all = await listLabTests()
    expect(all.every((t) => t.category === 'lab' || t.category === 'imaging')).toBe(true)
    expect(all.find((t) => t.code === 'TSH')!.category).toBe('lab')
  })
})
