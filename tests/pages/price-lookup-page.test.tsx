import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const getService = vi.fn()
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'FD', userId: 1 })) }))
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT ${p}`) } }))
vi.mock('@/lib/queries/tariff', () => ({ getService: (id: number) => getService(id) }))
vi.mock('@/components/tariff/PriceLookupPanel', () => ({
  PriceLookupPanel: ({ today, initialService }: { today: string; initialService?: { id: number; name: string } | null }) => <p>panel {today} {initialService ? `${initialService.id}:${initialService.name}` : 'none'}</p>,
}))
vi.mock('@/lib/india-time', async (orig) => ({ ...(await orig<typeof import('@/lib/india-time')>()), todayIsoIn: () => '2026-10-08' }))

import PriceLookupPage from '@/app/(dashboard)/price-lookup/page'

const props = (sp: Record<string, string> = {}) => ({ searchParams: Promise.resolve(sp) })

beforeEach(() => getService.mockReset())

describe('/price-lookup', () => {
  it('renders the lookup with today in IST', async () => {
    render(await PriceLookupPage(props()))
    expect(screen.getByRole('heading', { level: 1, name: /price lookup/i })).toBeInTheDocument()
    expect(screen.getByText('panel 2026-10-08 none')).toBeInTheDocument()
    expect(getService).not.toHaveBeenCalled()
  })

  // Wave G: a global-search service hit lands here preselected.
  it('preselects an active service from ?serviceId=', async () => {
    getService.mockResolvedValue({ id: 9, code: 'CONS', name: 'Consultation', departmentName: 'General Medicine', isActive: true })
    render(await PriceLookupPage(props({ serviceId: '9' })))
    expect(getService).toHaveBeenCalledWith(9)
    expect(screen.getByText('panel 2026-10-08 9:Consultation')).toBeInTheDocument()
  })

  it('ignores a bad, unknown or inactive serviceId', async () => {
    render(await PriceLookupPage(props({ serviceId: 'abc' })))
    expect(getService).not.toHaveBeenCalled()
    getService.mockResolvedValueOnce(null)
    render(await PriceLookupPage(props({ serviceId: '5' })))
    getService.mockResolvedValueOnce({ id: 6, code: 'OLD', name: 'Old', departmentName: 'X', isActive: false })
    render(await PriceLookupPage(props({ serviceId: '6' })))
    expect(screen.getAllByText('panel 2026-10-08 none')).toHaveLength(3)
  })
})
