import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'

let role: Role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
vi.mock('next/navigation', () => ({
  redirect: (p: string) => { throw new Error(`REDIRECT ${p}`) },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/ar-dashboard', () => ({ getArDashboardData: vi.fn(async () => ({ outstandingArCents: 0, grossCollectionRate: 0, avgDaysInAr: 0, agingBuckets: [] })) }))
vi.mock('@/lib/queries/charges', () => ({ listCharges: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-collections', () => ({ listPatientCollections: vi.fn(async () => []) }))
vi.mock('@/lib/queries/insurance-eligibility', () => ({ countEligibilityFollowUps: vi.fn(async () => 0) }))
vi.mock('@/components/ArAgingChart', () => ({ ArAgingChart: () => null }))
// Wave E P1-19: SP4 queue and the day's takings.
vi.mock('@/lib/queries/hospital-kpis', () => ({
  getBillingQueue: vi.fn(async () => ({ draftInvoices: 4, uninvoicedLines: 17, uninvoicedPaise: 2500000, pharmacyDraftCharges: 2, pendingApprovalCharges: 3 })),
  getCollectionsToday: vi.fn(async () => ({ date: '2026-10-08', receiptCount: 12, collectedPaise: 12345600, refundedPaise: 0, netPaise: 12345600 })),
}))

import BillingHomePage from '@/app/(dashboard)/billing/page'
import { deadLinks } from './dashboard-link-gates'
import { listCharges } from '@/lib/queries/charges'

beforeEach(() => { role = 'billing' })

// Wave B P0-01: Tariffs reachable from the billing home for TARIFF_MANAGE_ROLES only.
describe('/billing home', () => {
  it.each(['billing', 'admin'] as const)('links %s to Tariffs', async (r) => {
    role = r
    render(await BillingHomePage())
    expect(screen.getByRole('link', { name: /tariffs/i })).toHaveAttribute('href', '/tariffs')
  })

  it('does not link crc to Tariffs (its /tariffs gate would bounce it)', async () => {
    role = 'crc'
    render(await BillingHomePage())
    expect(screen.queryByRole('link', { name: /tariffs/i })).not.toBeInTheDocument()
  })
})

// Wave B P1-22: the simulated eligibility check follows DEMO_FEATURES.
describe('/billing home eligibility check', () => {
  const saved = process.env.DEMO_FEATURES
  afterEach(() => { process.env.DEMO_FEATURES = saved })

  it('hides Verify Insurance when DEMO_FEATURES is off', async () => {
    process.env.DEMO_FEATURES = 'false'
    render(await BillingHomePage())
    expect(screen.queryByRole('button', { name: /verify insurance/i })).not.toBeInTheDocument()
  })

  // SP8: the simulated check is retired (NHCX eligibility runs on the patient's policy).
  it('never offers the simulated check, even with DEMO_FEATURES on', async () => {
    process.env.DEMO_FEATURES = 'true'
    render(await BillingHomePage())
    expect(screen.queryByRole('button', { name: /verify insurance/i })).not.toBeInTheDocument()
  })
})

// Wave E P1-19: every KPI on the billing home drills into the list it counts.
describe('/billing home tiles', () => {
  const charge = (id: number, status: string) => ({ id, status, patientId: 'RD-1', patientName: 'P', providerName: 'D', dateOfService: '2026-10-08', diagnosisCodes: [], procedureCodes: [], amountCents: 100, notes: null, createdAt: '2026-10-08T00:00:00.000Z' })
  const tileHref = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('[data-kpi-label]')].find((e) => e.textContent === label)?.closest('a')?.getAttribute('href')
  const tileValue = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('[data-kpi-label]')].find((e) => e.textContent === label)?.previousElementSibling?.textContent

  it('charge status tiles count by status and open /billing/charges filtered to it ("Approved" counts approved, not "paid")', async () => {
    vi.mocked(listCharges).mockResolvedValueOnce([charge(1, 'draft'), charge(2, 'approved'), charge(3, 'approved'), charge(4, 'pending_approval'), charge(5, 'submitted')] as never)
    const { container } = render(await BillingHomePage())
    expect(tileValue(container, 'Draft')).toBe('1')
    expect(tileHref(container, 'Draft')).toBe('/billing/charges?status=draft')
    expect(tileValue(container, 'Approved')).toBe('2')
    expect(tileHref(container, 'Approved')).toBe('/billing/charges?status=approved')
    expect(tileHref(container, 'Pending Approval')).toBe('/billing/charges?status=pending_approval')
    expect(tileHref(container, 'Submitted')).toBe('/billing/charges?status=submitted')
  })

  it('pharmacy drafts to review, draft invoices, lines to invoice and today\'s collections', async () => {
    const { container } = render(await BillingHomePage())
    expect(tileValue(container, 'Pharmacy drafts to review')).toBe('2')
    expect(tileHref(container, 'Pharmacy drafts to review')).toBe('/billing/charges?status=draft&source=pharmacy')
    expect(tileValue(container, 'Draft invoices')).toBe('4')
    expect(tileHref(container, 'Draft invoices')).toBe('/billing/invoices?status=draft')
    expect(tileValue(container, 'Lines to invoice')).toBe('17')
    expect(tileHref(container, 'Lines to invoice')).toBe('/billing/capture')
    expect(tileValue(container, 'Collected today')).toBe('₹1,23,456.00')
    expect(tileHref(container, 'Collected today')).toBe('/cash-desk')
    expect(tileHref(container, 'Outstanding A/R')).toBe('/billing/ar-dashboard')
  })

  it.each(['billing', 'admin', 'crc'] as const)('no dead links for %s', async (r) => {
    role = r
    const { container } = render(await BillingHomePage())
    expect(deadLinks(container, r)).toEqual([])
  })
})
