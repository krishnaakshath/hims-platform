import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => cleanup())

describe('/rcm/reports', () => {
  it('defaults to the current IST month, links the CSV with the range and audits the view', async () => {
    vi.resetModules()
    const logAudit = vi.fn(async () => undefined)
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'rcm', name: 'Farah', userId: 3 })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit }))
    vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
    vi.doMock('@/lib/india-time', async () => ({ ...(await vi.importActual<object>('@/lib/india-time')), todayIsoIn: () => '2099-06-15' }))
    vi.doMock('@/lib/queries/rcm-reports', async () => ({
      ...(await vi.importActual<object>('@/lib/queries/rcm-reports')),
      agingByPayer: vi.fn(async () => [{ payerId: 1, payerName: 'Star TPA', buckets: { '0-30': 100, '31-60': 0, '61-90': 0, '91-180': 0, '181+': 0 }, totalPaise: 100 }]),
      denialAnalysis: vi.fn(async () => []), payerPerformance: vi.fn(async () => []),
    }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/reports/page')
    const { render, screen } = await import('@testing-library/react')
    render(await Page({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('link', { name: 'Download claim register (CSV)' })).toHaveAttribute('href', '/api/rcm/reports/claims-csv?from=2099-06-01&to=2099-06-15')
    expect(screen.getByText('Star TPA')).toBeInTheDocument()
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rcm: viewed RCM reports', null, 'from=2099-06-01 to=2099-06-15')
  })
})
