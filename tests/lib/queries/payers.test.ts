import { describe, it, expect } from 'vitest'
import { listPayers, getPayerById } from '@/lib/queries/payers'

describe('payer directory queries', () => {
  it('lists the seeded payers, including at least Aetna and Medicare', async () => {
    const all = await listPayers()
    expect(all.length).toBeGreaterThanOrEqual(14)
    expect(all.some((p) => p.name === 'Aetna')).toBe(true)
    expect(all.some((p) => p.payerType === 'medicare')).toBe(true)
  })

  it('gets a single payer by id', async () => {
    const all = await listPayers()
    const first = all[0]
    const byId = await getPayerById(first.id)
    expect(byId?.name).toBe(first.name)
  })

  it('returns null for a nonexistent payer id', async () => {
    const byId = await getPayerById(999999)
    expect(byId).toBeNull()
  })
})
