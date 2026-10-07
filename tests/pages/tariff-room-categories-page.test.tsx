import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'T', userId: null })) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/queries/tariff', () => ({
  listRoomCategories: vi.fn(async () => []),
  listRoomsWithCategory: vi.fn(async () => []),
  listServices: vi.fn(async () => Array.from({ length: 30 }, (_, i) => ({ id: i + 1, code: `RR${i}`, name: `Room ${i}` }))),
  listRatesForService: vi.fn(async () => []),
  listRatesForServices: vi.fn(async () => []),
}))

import { listRatesForService, listRatesForServices } from '@/lib/queries/tariff'
import RoomCategoriesPage from '@/app/(dashboard)/tariffs/room-categories/page'

beforeEach(() => vi.clearAllMocks())

describe('/tariffs/room-categories data loading', () => {
  it('loads every room-rent service rate in ONE query (no per-service N+1)', async () => {
    await RoomCategoriesPage()
    expect(listRatesForServices).toHaveBeenCalledTimes(1)
    expect(vi.mocked(listRatesForServices).mock.calls[0][0]).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    expect(listRatesForService).not.toHaveBeenCalled()
  })
})
