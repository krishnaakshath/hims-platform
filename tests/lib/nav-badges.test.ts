import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  countPendingAssignmentsForProvider: vi.fn(),
  countUnacknowledgedDeclines: vi.fn(),
}))
// Wave B P1-25: unread patient messages and pending booking requests.
vi.mock('@/lib/queries/messages', () => ({ getUnreadCountForProvider: vi.fn(async () => 5) }))
vi.mock('@/lib/queries/booking-requests', () => ({ countPendingBookingRequests: vi.fn(async () => 6) }))

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
    expect(await getNavBadges({ role: 'pi', name: 'Dr. R. Kunam', userId: null })).toEqual({ '/doctor': 2, '/messages': 5, '/booking-requests': 6 })
    expect(pendingMock).toHaveBeenCalledWith(7)
  })

  it('pi unmatched gets an explicit null /doctor badge (suppressed, not a 0) and runs no count', async () => {
    resolveMock.mockResolvedValue(null)
    const badges = await getNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })
    expect(badges).toEqual({ '/doctor': null, '/messages': 5, '/booking-requests': 6 })
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it('frontdesk gets the unacknowledged-decline count on /front-desk/assignments', async () => {
    declinesMock.mockResolvedValue(3)
    expect(await getNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ '/front-desk/assignments': 3, '/booking-requests': 6 })
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

  it('billing gets nothing and runs no query', async () => {
    expect(await getNavBadges({ role: 'billing', name: 'Bill Ing', userId: null })).toEqual({})
    expect(pendingMock).not.toHaveBeenCalled()
    expect(declinesMock).not.toHaveBeenCalled()
    expect(resolveMock).not.toHaveBeenCalled()
  })

  // Wave B P1-25: only hrefs the role's nav shows, from existing count queries.
  it.each([
    ['admin', { '/front-desk/assignments': 3, '/messages': 5, '/booking-requests': 6 }],
    ['crc', { '/front-desk/assignments': 3, '/messages': 5, '/booking-requests': 6 }],
    ['pharmacy', { '/messages': 5 }],
    ['labs', {}],
  ] as const)('%s gets exactly its nav badges', async (role, expected) => {
    declinesMock.mockResolvedValue(3)
    expect(await getNavBadges({ role, name: 'Someone', userId: null })).toEqual(expected)
  })

  describe('loadNavBadges reports whether the result is degraded', () => {
    it('degraded: false on success, including an intentionally suppressed badge', async () => {
      resolveMock.mockResolvedValue(null)
      expect(await loadNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })).toEqual({ badges: { '/doctor': null, '/messages': 5, '/booking-requests': 6 }, degraded: false })
      declinesMock.mockResolvedValue(1)
      expect(await loadNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ badges: { '/front-desk/assignments': 1, '/booking-requests': 6 }, degraded: false })
      expect(await loadNavBadges({ role: 'billing', name: 'Bill Ing', userId: null })).toEqual({ badges: {}, degraded: false })
    })
    it('degraded: true with no keys when a query throws', async () => {
      declinesMock.mockRejectedValue(new Error('db down'))
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await loadNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ badges: {}, degraded: true })
      expect(errSpy).toHaveBeenCalled()
      errSpy.mockRestore()
    })
  })
})
