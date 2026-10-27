import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'
import { PAGE_GATES } from '../../pages/page-gates-harness'
import { linkAdmits } from '../../pages/dashboard-link-gates'

// WS8 T15: which items each role sees. The count sources are stubbed; their SQL is covered in
// needs-attention-counts.test.ts and in each source's own tests.
const m = vi.hoisted(() => ({
  lab: { criticalUnverified: 2 },
  followUps: { overdue: 4, due: 1 },
  pharmacy: { outOfStock: 0, lowStock: 3, dispensedToday: 0, unbilledDispenses: 0 } as Record<string, number>,
  credentials: { expired: 1, expiring: 2 },
  policies: 5,
  portal: 6,
  upi: 7,
  dpr: 8,
}))

vi.mock('@/lib/queries/hospital-kpis', () => ({
  getLabKpis: vi.fn(async () => m.lab),
  getFollowUpBuckets: vi.fn(async () => m.followUps),
  getPharmacyKpis: vi.fn(async () => m.pharmacy),
}))
vi.mock('@/lib/queries/staff-credentials', () => ({ countCredentialsExpiringWithin: vi.fn(async () => m.credentials) }))
vi.mock('@/lib/queries/rcm-policies', () => ({ countPoliciesExpiringBetween: vi.fn(async () => m.policies) }))
vi.mock('@/lib/queries/portal-submissions', () => ({ countPendingPortalSubmissions: vi.fn(async () => m.portal) }))
vi.mock('@/lib/payments/manual-upi', () => ({ countReportedPortalUpiRequests: vi.fn(async () => m.upi) }))
vi.mock('@/lib/queries/data-principal-requests', () => ({ countOverdueDataPrincipalRequests: vi.fn(async () => m.dpr) }))

import {
  DATA_REQUEST_REGISTER_ROLES, MAX_ATTENTION_ITEMS, PHARMACY_DASHBOARD_ROLES, loadNeedsAttention, rankAttention, type AttentionItem,
} from '@/lib/queries/needs-attention'
import { countCredentialsExpiringWithin } from '@/lib/queries/staff-credentials'
import { countPoliciesExpiringBetween } from '@/lib/queries/rcm-policies'

const TODAY = '2026-10-24'
const ids = async (role: Role) => (await loadNeedsAttention(role, TODAY)).map((i) => i.id)

beforeEach(() => {
  m.lab = { criticalUnverified: 2 }
  m.followUps = { overdue: 4, due: 1 }
  m.pharmacy = { outOfStock: 0, lowStock: 3, dispensedToday: 0, unbilledDispenses: 0 }
  m.credentials = { expired: 1, expiring: 2 }
  m.policies = 5; m.portal = 6; m.upi = 7; m.dpr = 8
  vi.clearAllMocks()
})

describe('loadNeedsAttention', () => {
  it('local role lists equal the gates of the pages they link to', () => {
    expect(new Set(PHARMACY_DASHBOARD_ROLES)).toEqual(new Set(PAGE_GATES.find((g) => g.route === '/pharmacy')!.allowed))
    expect(new Set(DATA_REQUEST_REGISTER_ROLES)).toEqual(new Set(PAGE_GATES.find((g) => g.route === '/governance/data-requests')!.allowed))
  })

  it('admin sees credentials expiring in 30 days and overdue data requests, danger first, at most six', async () => {
    const items = await loadNeedsAttention('admin', TODAY)
    expect(items.map((i) => i.id)).toContain('expiring_credentials')
    expect(items.map((i) => i.id)).toContain('overdue_data_requests')
    expect(items.length).toBeLessThanOrEqual(MAX_ATTENTION_ITEMS)
    expect(items.slice(0, 3).map((i) => i.id)).toEqual(['critical_labs', 'overdue_data_requests', 'expiring_credentials'])
    expect(items.find((i) => i.id === 'expiring_credentials')).toMatchObject({ count: 3, href: '/staff', tone: 'danger' })
    expect(items.find((i) => i.id === 'overdue_data_requests')).toMatchObject({ count: 8, href: '/governance/data-requests' })
    expect(countCredentialsExpiringWithin).toHaveBeenCalledWith(TODAY, 30)
  })

  it('pharmacy sees low stock and never RCM, cash-desk or governance items', async () => {
    m.pharmacy = { ...m.pharmacy, outOfStock: 1 }
    const items = await loadNeedsAttention('pharmacy', TODAY)
    expect(items.map((i) => i.id)).toEqual(['low_stock'])
    expect(items[0]).toMatchObject({ count: 4, href: '/pharmacy?stock=out', tone: 'danger' })
    expect(countPoliciesExpiringBetween).not.toHaveBeenCalled()
  })

  it('pharmacy sees expiring stock once the batch-stock stream supplies expiringIn90Days (feature check)', async () => {
    expect(await ids('pharmacy')).not.toContain('expiring_stock')
    m.pharmacy = { ...m.pharmacy, expiringIn90Days: 9 }
    const items = await loadNeedsAttention('pharmacy', TODAY)
    expect(items.map((i) => i.id)).toEqual(['low_stock', 'expiring_stock'])
    expect(items[1]).toMatchObject({ count: 9, href: '/pharmacy?stock=expiring', tone: 'warning' })
  })

  it('front desk sees overdue follow-ups, portal submissions and reported UPI, never credentials', async () => {
    const got = await ids('frontdesk')
    expect(got).toEqual(['overdue_follow_ups', 'reported_upi', 'pending_portal_submissions'])
    expect(countCredentialsExpiringWithin).not.toHaveBeenCalled()
  })

  it('rcm sees policies expiring in 7 days, counted from today to today + 7', async () => {
    const items = await loadNeedsAttention('rcm', TODAY)
    expect(items.find((i) => i.id === 'expiring_policies')).toMatchObject({ count: 5, href: '/rcm/policies?expiring=7' })
    expect(countPoliciesExpiringBetween).toHaveBeenCalledWith('2026-10-24', '2026-10-31')
  })

  it('a zero count is not shown', async () => {
    m.followUps = { overdue: 0, due: 3 }
    m.upi = 0
    expect(await ids('frontdesk')).toEqual(['pending_portal_submissions'])
  })

  it('every item a role is shown links to a page that role may open', async () => {
    m.pharmacy = { ...m.pharmacy, expiringIn90Days: 2 }
    for (const role of ALL_ROLES) {
      for (const item of await loadNeedsAttention(role, TODAY)) {
        expect.soft(linkAdmits(item.href, role), `${role} -> ${item.href}`).toBe(true)
      }
    }
  })
})

describe('rankAttention', () => {
  const it_ = (id: AttentionItem['id'], tone: AttentionItem['tone'], count = 1): AttentionItem => ({ id, tone, count, label: id, href: '/' })
  it('puts danger before warning, drops zeros and caps at six', () => {
    const out = rankAttention([
      it_('overdue_follow_ups', 'warning'), it_('reported_upi', 'warning', 0), it_('critical_labs', 'danger'),
      it_('low_stock', 'warning'), it_('expiring_stock', 'warning'), it_('pending_portal_submissions', 'warning'),
      it_('expiring_policies', 'warning'), it_('overdue_data_requests', 'danger'), it_('expiring_credentials', 'warning'),
    ])
    expect(out.map((i) => i.id)).toEqual(['critical_labs', 'overdue_data_requests', 'overdue_follow_ups', 'low_stock', 'expiring_stock', 'pending_portal_submissions'])
  })
})
