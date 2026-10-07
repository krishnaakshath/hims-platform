import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'FD', userId: 1 })) }))
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT ${p}`) } }))
vi.mock('@/components/tariff/PriceLookupPanel', () => ({ PriceLookupPanel: ({ today }: { today: string }) => <p>panel {today}</p> }))
vi.mock('@/lib/india-time', async (orig) => ({ ...(await orig<typeof import('@/lib/india-time')>()), todayIsoIn: () => '2026-10-08' }))

import PriceLookupPage from '@/app/(dashboard)/price-lookup/page'

describe('/price-lookup', () => {
  it('renders the lookup with today in IST', async () => {
    render(await PriceLookupPage())
    expect(screen.getByRole('heading', { level: 1, name: /price lookup/i })).toBeInTheDocument()
    expect(screen.getByText('panel 2026-10-08')).toBeInTheDocument()
  })
})
