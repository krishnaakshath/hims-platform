import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  countPendingAssignmentsForProvider: vi.fn(),
  countUnacknowledgedDeclines: vi.fn(),
}))
// Wave B P1-25: unread patient messages and pending booking requests.
vi.mock('@/lib/queries/messages', () => ({ getUnreadCountForProvider: vi.fn(async () => 5) }))
vi.mock('@/lib/queries/booking-requests', () => ({ countPendingBookingRequests: vi.fn(async () => 6) }))
// Wave E P1-25: the work-queue badges reuse the dashboards' own KPI loaders, so a
// badge always equals the tile on the page it points to.
vi.mock('@/lib/queries/hospital-kpis', () => ({
  getFollowUpBuckets: vi.fn(async () => ({ due: 2, overdue: 3, upcoming: 9, scheduled: 1, missed: 4, capped: false })),
  getLabKpis: vi.fn(async () => ({ awaitingCollection: 4, inTransit: 1, atBench: 2, toVerify: 8, toReport: 1, criticalUnverified: 1, resultedToday: 0, criticalToday: 0, medianTatMinutes: null })),
  getPharmacyKpis: vi.fn(async () => ({ outOfStock: 2, lowStock: 5, dispensedToday: 0, unbilledDispenses: 7 })),
  getBillingQueue: vi.fn(async () => ({ draftInvoices: 4, uninvoicedLines: 0, uninvoicedPaise: 0, pharmacyDraftCharges: 1, pendingApprovalCharges: 9 })),
  getClaimAgeing: vi.fn(async () => ({ outstandingPaise: 0, aging: [], preauthsOverdue: 2, queried: 5 })),
  countResultsToVerifyForProvider: vi.fn(async () => 4),
}))
vi.mock('@/lib/queries/coding-worklist', () => ({ listCodingWorklist: vi.fn(async () => ({ rows: [], total: 11, counts: {} })) }))
vi.mock('@/lib/queries/home-collections', () => ({ listCollectorRoute: vi.fn(async () => [{ status: 'booked' }, { status: 'collected' }, { status: 'booked' }]) }))

import { getNavBadges, loadNavBadges } from '@/lib/nav-badges'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { countPendingAssignmentsForProvider, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'

const resolveMock = vi.mocked(resolveDoctorQueueProvider)
const pendingMock = vi.mocked(countPendingAssignmentsForProvider)
const declinesMock = vi.mocked(countUnacknowledgedDeclines)

describe('getNavBadges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pi with a matched provider gets the pending count on /doctor', async () => {
    resolveMock.mockResolvedValue({ id: 7, name: 'Dr. R. Kunam' })
    pendingMock.mockResolvedValue(2)
    expect(await getNavBadges({ role: 'pi', name: 'Dr. R. Kunam', userId: null })).toEqual({ '/doctor': 2, '/labs': 4, '/messages': 5, '/booking-requests': 6 })
    expect(pendingMock).toHaveBeenCalledWith(7)
  })

  it('pi unmatched gets an explicit null /doctor badge (suppressed, not a 0) and runs no count', async () => {
    resolveMock.mockResolvedValue(null)
    const badges = await getNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })
    expect(badges).toEqual({ '/doctor': null, '/labs': null, '/messages': 5, '/booking-requests': 6 })
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it('frontdesk gets the unacknowledged-decline count on /front-desk/assignments', async () => {
    declinesMock.mockResolvedValue(3)
    expect(await getNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ '/front-desk/assignments': 3, '/front-desk/follow-ups': 5, '/booking-requests': 6 })
  })

  describe('fails safe to {} (no badge, never a false number)', () => {
    it.each([
      ['the pi provider resolver rejects', 'pi', () => resolveMock.mockRejectedValue(new Error('db down'))],
      ['the pi pending count rejects', 'pi', () => {
        resolveMock.mockResolvedValue({ id: 7, name: 'Dr. R. Kunam' })
        pendingMock.mockRejectedValue(new Error('db down'))
      }],
      ['the frontdesk decline count rejects', 'frontdesk', () => declinesMock.mockRejectedValue(new Error('db down'))],
    ] as const)('when %s', async (_label, role, arrange) => {
      arrange()
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await getNavBadges({ role, name: 'Dr. R. Kunam', userId: null })).toEqual({})
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  it('billing gets its own queues (charges pending approval, draft invoices) and no clinical query', async () => {
    expect(await getNavBadges({ role: 'billing', name: 'Bill Ing', userId: null })).toEqual({ '/billing/charges': 9, '/billing/invoices': 4 })
    expect(pendingMock).not.toHaveBeenCalled()
    expect(declinesMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
  })

  // Wave B P1-25: only hrefs the role's nav shows, from existing count queries.
  it.each([
    ['admin', { '/front-desk/assignments': 3, '/front-desk/follow-ups': 5, '/messages': 5, '/booking-requests': 6 }],
    ['crc', { '/front-desk/assignments': 3, '/front-desk/follow-ups': 5, '/messages': 5, '/booking-requests': 6 }],
    // Wave E P1-25
    ['pharmacy', { '/messages': 5, '/pharmacy': 2, '/pharmacy/billing': 7 }],
    ['labs', { '/labs': 7 }],
    ['coder', { '/coding': 11 }],
    ['rcm', { '/rcm/claims': 5, '/rcm/preauths': 2 }],
  ] as const)('%s gets exactly its nav badges', async (role, expected) => {
    declinesMock.mockResolvedValue(3)
    expect(await getNavBadges({ role, name: 'Someone', userId: null })).toEqual(expected)
  })

  describe('loadNavBadges reports whether the result is degraded', () => {
    it('degraded: false on success, including an intentionally suppressed badge', async () => {
      resolveMock.mockResolvedValue(null)
      expect(await loadNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })).toEqual({ badges: { '/doctor': null, '/labs': null, '/messages': 5, '/booking-requests': 6 }, degraded: false })
      declinesMock.mockResolvedValue(1)
      expect(await loadNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ badges: { '/front-desk/assignments': 1, '/front-desk/follow-ups': 5, '/booking-requests': 6 }, degraded: false })
      expect(await loadNavBadges({ role: 'billing', name: 'Bill Ing', userId: null })).toEqual({ badges: { '/billing/charges': 9, '/billing/invoices': 4 }, degraded: false })
    })
    it('degraded: true with no keys when a query throws', async () => {
      declinesMock.mockRejectedValue(new Error('db down'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await loadNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ badges: {}, degraded: true })
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })

  // Wave E P1-25: the collector's own stops still to collect today (user-scoped).
  it('collector: own booked stops for today on /collections; none without a user id', async () => {
    const { listCollectorRoute } = await import('@/lib/queries/home-collections')
    expect(await getNavBadges({ role: 'collector', name: 'C', userId: 42 })).toEqual({ '/collections': 2 })
    expect(vi.mocked(listCollectorRoute)).toHaveBeenCalledWith(42, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    vi.mocked(listCollectorRoute).mockClear()
    expect(await getNavBadges({ role: 'collector', name: 'C', userId: null })).toEqual({ '/collections': 0 })
    expect(vi.mocked(listCollectorRoute)).not.toHaveBeenCalled()
  })

  // Every badge key must be a nav href that role's LeftNav shows (no badge on a hidden or dead entry).
  it('every badge key is an href the role\'s nav shows', async () => {
    const { NAV_ITEMS, NAV_TRAILING_ITEMS, NAV_BILLING_ITEMS, BILLING_ROLES } = await import('@/components/LeftNav')
    const { ALL_ROLES } = await import('@/lib/role-policy')
    resolveMock.mockResolvedValue({ id: 7, name: 'Dr. R. Kunam' })
    pendingMock.mockResolvedValue(1)
    declinesMock.mockResolvedValue(1)
    for (const role of ALL_ROLES) {
      const visible = new Set([
        ...[...NAV_ITEMS, ...NAV_TRAILING_ITEMS].filter((i) => !i.roles || i.roles.includes(role)).map((i) => i.href),
        ...(BILLING_ROLES.includes(role) ? NAV_BILLING_ITEMS.map((i) => i.href) : []),
      ])
      const badges = await getNavBadges({ role, name: 'Dr. R. Kunam', userId: 1 })
      for (const href of Object.keys(badges)) expect.soft(visible.has(href), `${role}: ${href}`).toBe(true)
    }
  })
})
