import { describe, it, expect, vi } from 'vitest'

// Cache miss: loader runs, so the rows hold real Dates from Drizzle.
vi.mock('@/lib/cache', () => ({
  getOrSetCache: vi.fn(async (_k: string, _t: number, loader: () => Promise<unknown>) => loader()),
  documentsListCacheKey: () => 'documents:list:all',
}))

import { listDocuments } from '@/lib/queries/documents'

describe('listDocuments timestamp shape', () => {
  it('returns timestamps as ISO strings (same shape as a cache hit), never Date objects', async () => {
    const rows = await listDocuments()
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.createdAt).not.toBeInstanceOf(Date)
      expect(typeof r.createdAt).toBe('string')
      expect(r.filedAt === null || typeof r.filedAt === 'string').toBe(true)
    }
  })
})
