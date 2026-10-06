import { describe, it, expect } from 'vitest'
import { listActiveProviders } from '@/lib/queries/providers'

describe('listActiveProviders', () => {
  it('returns the seeded provider roster', async () => {
    const providers = await listActiveProviders()
    expect(providers.length).toBe(5)
    expect(providers.every((p) => p.isActive)).toBe(true)
  })
})
