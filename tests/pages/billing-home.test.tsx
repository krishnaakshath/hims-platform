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

import BillingHomePage from '@/app/(dashboard)/billing/page'

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
