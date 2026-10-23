// WS4 T9 (spec 3.5 item 26, lane ruling R6): a result write drops today's (IST) lab KPI entry.
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cache')>('@/lib/cache')
  return { ...actual, invalidateCache: vi.fn(async () => undefined) }
})

import { invalidateCache } from '@/lib/cache'
import { invalidateLabKpis } from '@/lib/queries/hospital-kpis'

describe('invalidateLabKpis', () => {
  it('deletes kpi:labs:<IST date>, the key getLabKpis caches under', async () => {
    await invalidateLabKpis(new Date('2099-05-01T19:00:00Z')) // 00:30 IST on 2 May
    expect(invalidateCache).toHaveBeenCalledWith('kpi:labs:2099-05-02')
  })
})
