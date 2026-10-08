import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { RcmDashboard } from '@/lib/queries/rcm-worklist'

afterEach(() => cleanup())

const DASH: RcmDashboard = {
  counts: { to_submit: 2, queried: 1, awaiting_insurer: 3, to_reconcile: 0, denied: 1, candidates: 1, preauthsOverdue: 1 },
  slaBreaches: { submission_due_soon: 0, submission_overdue: 1, query_due_soon: 0, query_overdue: 0, settlement_overdue: 2, preauth_decision_overdue: 0 },
  insurerOutstandingPaise: 1_50_000_00, aging: [{ label: '0-30', paise: 1_50_000_00 }, { label: '31-60', paise: 0 }, { label: '61-90', paise: 0 }, { label: '91-180', paise: 0 }, { label: '181+', paise: 0 }],
  settledThisMonthPaise: 80_000_00, tdsThisMonthPaise: 8_000_00,
}

function mocks(role = 'rcm') {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Farah', userId: 3 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('next/navigation', () => ({ redirect, notFound, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  return { logAudit, redirect, notFound }
}

describe('RCM pages', () => {
  it('/rcm shows the worklist counts, money and ready-to-claim links', async () => {
    const { logAudit } = mocks()
    vi.doMock('@/lib/queries/rcm-worklist', () => ({
      getRcmDashboard: vi.fn(async () => DASH),
      listClaimCandidates: vi.fn(async () => [{ patient: { id: 'P-1', name: 'Asha Rao', uhid: 'UH1' }, admissionId: null, encounterId: 7, policyId: 2, payerName: 'Star TPA', invoiceCount: 1, availablePaise: 50_000_00, episodeEndDate: '2026-10-01', slaFlags: [] }]),
    }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/page')
    const { render, screen } = await import('@testing-library/react')
    render(await Page())
    expect(screen.getByRole('link', { name: /To submit\s*2/ })).toHaveAttribute('href', '/rcm/claims?tab=to_submit')
    expect(screen.getByText('₹1,50,000.00', { selector: 'dd' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Start claim' })).toHaveAttribute('href', '/rcm/claims/new?encounterId=7&policyId=2')
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'rcm' }), 'rcm: viewed RCM dashboard', null)
  })

  it('/rcm/claims/new refuses missing or mixed params', async () => {
    const { notFound } = mocks()
    vi.doMock('@/lib/queries/claims', () => ({ getNewClaimContext: vi.fn(async () => null) }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/claims/new/page')
    await expect(Page({ searchParams: Promise.resolve({ admissionId: '1', encounterId: '2', policyId: '3' }) })).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(Page({ searchParams: Promise.resolve({ encounterId: '2', policyId: '3' }) })).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledTimes(2)
  })

  it('a denied role is redirected before any query', async () => {
    const { redirect } = mocks('billing')
    const getRcmDashboard = vi.fn()
    vi.doMock('@/lib/queries/rcm-worklist', () => ({ getRcmDashboard, listClaimCandidates: vi.fn() }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/page')
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/'); expect(getRcmDashboard).not.toHaveBeenCalled()
  })
})
