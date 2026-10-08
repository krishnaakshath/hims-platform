import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn() }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  countPendingAssignmentsForProvider: vi.fn(),
  countUnacknowledgedDeclines: vi.fn(),
}))
// Wave B P1-25: unread patient messages and pending booking requests.
vi.mock('@/lib/queries/messages', () => ({ getUnreadCountForProvider: vi.fn(async () => 5) }))
vi.mock('@/lib/queries/booking-requests', () => ({ countPendingBookingRequests: vi.fn(async () => 6) }))
// Wave E P1-25: role work-queue badges (KPI loaders, coding backlog, collector route).
vi.mock('@/lib/queries/hospital-kpis', () => ({
  getFollowUpBuckets: vi.fn(async () => ({ due: 1, overdue: 1, upcoming: 0, scheduled: 0, missed: 0, capped: false })),
  getLabKpis: vi.fn(),
  getPharmacyKpis: vi.fn(),
  getBillingQueue: vi.fn(async () => ({ draftInvoices: 3, uninvoicedLines: 0, uninvoicedPaise: 0, pharmacyDraftCharges: 0, pendingApprovalCharges: 8 })),
  getClaimAgeing: vi.fn(),
  countResultsToVerifyForProvider: vi.fn(async () => 1),
}))
vi.mock('@/lib/queries/coding-worklist', () => ({ listCodingWorklist: vi.fn() }))
vi.mock('@/lib/queries/home-collections', () => ({ listCollectorRoute: vi.fn() }))

import { GET } from '@/app/api/nav-badges/route'
import { requireSession } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { countPendingAssignmentsForProvider, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'

const sessionMock = vi.mocked(requireSession)
const resolveMock = vi.mocked(resolveDoctorQueueProvider)
const pendingMock = vi.mocked(countPendingAssignmentsForProvider)
const declinesMock = vi.mocked(countUnacknowledgedDeclines)

describe('GET /api/nav-badges', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('401 without a session, and computes nothing', async () => {
    sessionMock.mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))
    const res = await GET()
    expect(res.status).toBe(401)
    expect(resolveMock).not.toHaveBeenCalled()
    expect(pendingMock).not.toHaveBeenCalled()
    expect(declinesMock).not.toHaveBeenCalled()
  })

  it('returns the pending count for a pi with a matched provider, with Cache-Control: no-store', async () => {
    sessionMock.mockResolvedValueOnce({ role: 'pi', name: 'Dr. R. Kunam', userId: null })
    resolveMock.mockResolvedValue({ id: 7, name: 'Dr. R. Kunam' })
    pendingMock.mockResolvedValue(4)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ badges: { '/doctor': 4, '/labs': 1, '/messages': 5, '/booking-requests': 6 }, degraded: false })
    expect(pendingMock).toHaveBeenCalledWith(7)
  })

  it('returns the decline count for frontdesk', async () => {
    sessionMock.mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })
    declinesMock.mockResolvedValue(2)
    const res = await GET()
    expect(await res.json()).toEqual({ badges: { '/front-desk/assignments': 2, '/front-desk/follow-ups': 2, '/booking-requests': 6 }, degraded: false })
  })

  it('returns billing\'s own queues (Wave E), running no clinical query', async () => {
    sessionMock.mockResolvedValueOnce({ role: 'billing', name: 'Bill Ing', userId: null })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ badges: { '/billing/charges': 8, '/billing/invoices': 3 }, degraded: false })
    expect(resolveMock).not.toHaveBeenCalled()
    expect(pendingMock).not.toHaveBeenCalled()
    expect(declinesMock).not.toHaveBeenCalled()
  })

  it('returns an explicit null /doctor badge (not degraded) for an unmatched pi', async () => {
    sessionMock.mockResolvedValueOnce({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })
    resolveMock.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ badges: { '/doctor': null, '/labs': null, '/messages': 5, '/booking-requests': 6 }, degraded: false })
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it('fails safe to {} flagged degraded when a count query throws', async () => {
    sessionMock.mockResolvedValueOnce({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })
    declinesMock.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET()
    errSpy.mockRestore()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({ badges: {}, degraded: true })
  })
})
