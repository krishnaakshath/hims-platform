import { describe, it, expect } from 'vitest'
import { listFaxes } from '@/lib/queries/faxes'

describe('listFaxes', () => {
  it('returns the seeded faxes joined with patient info', async () => {
    const rows = await listFaxes()
    expect(rows.length).toBeGreaterThanOrEqual(8)
    expect(rows.some((f) => f.deliveryStatus === 'delivered')).toBe(true)
    expect(rows.some((f) => f.deliveryStatus === 'failed')).toBe(true)
  })
})
