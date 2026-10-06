import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn() }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  countPendingAssignmentsForProvider: vi.fn(),
  countUnacknowledgedDeclines: vi.fn(),
}))

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
    expect(await getNavBadges({ role: 'pi', name: 'Dr. R. Kunam', userId: null })).toEqual({ '/doctor': 2 })
    expect(pendingMock).toHaveBeenCalledWith(7)
  })

  it('pi unmatched gets an explicit null /doctor badge (suppressed, not a 0) and runs no count', async () => {
    resolveMock.mockResolvedValue(null)
    const badges = await getNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })
    expect(badges).toEqual({ '/doctor': null })
    expect(pendingMock).not.toHaveBeenCalled()
  })

  it('frontdesk gets the unacknowledged-decline count on /front-desk/assignments', async () => {
    declinesMock.mockResolvedValue(3)
    expect(await getNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ '/front-desk/assignments': 3 })
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

  describe('loadNavBadges reports whether the result is degraded', () => {
    it('degraded: false on success, including an intentionally suppressed badge', async () => {
      resolveMock.mockResolvedValue(null)
      expect(await loadNavBadges({ role: 'pi', name: 'Dr. Nobody Matchington', userId: null })).toEqual({ badges: { '/doctor': null }, degraded: false })
      declinesMock.mockResolvedValue(1)
      expect(await loadNavBadges({ role: 'frontdesk', name: 'Taylor Nguyen', userId: null })).toEqual({ badges: { '/front-desk/assignments': 1 }, degraded: false })
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
