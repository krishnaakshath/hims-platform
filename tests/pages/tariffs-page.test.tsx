import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Role } from '@/lib/auth'

let role: Role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`) })
vi.mock('next/navigation', () => ({ redirect: (p: string) => redirect(p), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/queries/tariff', () => ({ listServicesWithCurrentPrices: vi.fn(async () => []), countServices: vi.fn(async () => 0) }))
vi.mock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => []) }))
vi.mock('@/components/tariff/ServicesTable', () => ({ ServicesTable: vi.fn(() => null) }))

import { listServicesWithCurrentPrices, countServices } from '@/lib/queries/tariff'
import { ServicesTable } from '@/components/tariff/ServicesTable'
import TariffsPage from '@/app/(dashboard)/tariffs/page'

type Element = { props: { children: unknown } }
// Find the ServicesTable element in the page's returned tree and return its props.
function tableProps(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const n of node) { const p = tableProps(n); if (p) return p } return null }
  const el = node as { type?: unknown; props?: Record<string, unknown> }
  if (el.type === ServicesTable) return el.props ?? null
  return tableProps((el as Element).props?.children)
}
const render = async (sp: Record<string, string>) => tableProps(await TariffsPage({ searchParams: Promise.resolve(sp) }))

beforeEach(() => {
  role = 'billing'
  vi.clearAllMocks()
})

describe('/tariffs pagination', () => {
  it('loads 50 per page and passes the total for the truncation notice', async () => {
    vi.mocked(countServices).mockResolvedValue(120)
    const props = await render({ q: 'cons', page: '2' })
    expect(vi.mocked(listServicesWithCurrentPrices).mock.calls[0][0]).toMatchObject({ q: 'cons', limit: 50, offset: 50 })
    expect(vi.mocked(countServices).mock.calls[0][0]).toMatchObject({ q: 'cons' })
    expect(props?.pagination).toEqual({ page: 2, pageSize: 50, total: 120 })
  })

  it.each([['garbage', 'x'], ['zero', '0'], ['negative', '-2'], ['huge', '99999999999']])('a %s page falls back to a valid page', async (_l, page) => {
    vi.mocked(countServices).mockResolvedValue(120)
    const props = await render({ page })
    const { offset } = vi.mocked(listServicesWithCurrentPrices).mock.calls[0][0] as { offset: number }
    expect([0, 100]).toContain(offset)
    expect((props?.pagination as { page: number }).page).toBe(offset / 50 + 1)
  })

  it('redirects a denied role before loading anything', async () => {
    role = 'frontdesk'
    await expect(render({})).rejects.toThrow('REDIRECT /')
    expect(listServicesWithCurrentPrices).not.toHaveBeenCalled()
    expect(countServices).not.toHaveBeenCalled()
  })
})
