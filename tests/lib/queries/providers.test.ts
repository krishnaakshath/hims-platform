import { describe, it, expect } from 'vitest'
import { listActiveProviders } from '@/lib/queries/providers'

describe('listActiveProviders', () => {
  it('returns the seeded provider roster', async () => {
    const providers = await listActiveProviders()
    expect(providers.length).toBeGreaterThanOrEqual(5)
    expect(providers.some((p) => p.name === 'Dr. Rajiv Kunam')).toBe(true)
    expect(providers.every((p) => p.isActive)).toBe(true)
  })
})
