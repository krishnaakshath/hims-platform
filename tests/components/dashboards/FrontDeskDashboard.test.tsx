import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  listTodaysAssignments: vi.fn(async () => []),
  countAllPendingAssignments: vi.fn(async () => 0),
}))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => []) }))
vi.mock('@/lib/queries/booking-requests', () => ({ listBookingRequests: vi.fn(async () => []) }))
vi.mock('@/lib/queries/staff-credentials', () => ({
  listExpiringOrExpiredCredentials: vi.fn(async () => [
    { id: 1, staffMemberId: 5, staffMemberName: 'Sam Staffer', credentialType: 'RN Licence', expiresOn: '2026-10-20', daysUntilExpiry: 15, status: 'expiring' },
    { id: 2, staffMemberId: 6, staffMemberName: 'Old Timer', credentialType: 'CPR', expiresOn: '2026-09-01', daysUntilExpiry: -34, status: 'expired' },
  ]),
}))
vi.mock('@/components/CheckInButton', () => ({ CheckInButton: () => null }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/' }))

beforeAll(() => {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})

const SESSION = { role: 'frontdesk' as const, name: 'Fran', userId: null }

// The number shown on a mini stat tile is the <p> right before its label <p>
// (a section heading may reuse the same words, so pick the tile's label).
function tileValue(label: string): string | null {
  const tileLabel = screen.getAllByText(label).find((el) => el.tagName === 'P' && el.previousElementSibling?.tagName === 'P')
  return tileLabel?.previousElementSibling?.textContent ?? null
}

function bookingRequest(id: number, status: 'pending' | 'confirmed' | 'declined') {
  return {
    id, status, requesterName: `Requester ${id}`, requesterDob: '1990-01-01', requesterEmail: null, requesterPhone: null,
    preferredProviderId: null, preferredDateRangeStart: '2026-10-10', preferredDateRangeEnd: '2026-10-20', reason: `Reason ${id}`,
    submittedAt: new Date(), reviewedByName: null, reviewedAt: null, declineReason: null, resultingAppointmentId: null,
  }
}

describe('FrontDeskDashboard', () => {
  it('renders the credentials tile and rows with no link to /staff (front desk cannot open the directory)', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    const { container } = render(await FrontDeskDashboard({ session: SESSION }))
    expect(container.querySelector('a[href="/staff"]')).toBeNull()
    expect(container.querySelector('a[href^="/staff"]')).toBeNull()
    expect(screen.getByText('Expiring / Expired Credentials')).toBeInTheDocument()
    expect(screen.getByText('Sam Staffer')).toBeInTheDocument()
    expect(screen.getByText('Old Timer')).toBeInTheDocument()
    expect(screen.getByText('15d left')).toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
    // Sibling tiles keep their links.
    expect(container.querySelector('a[href="/front-desk/assignments"]')).not.toBeNull()
  })

  it('credentials tile counts every expired AND expiring credential the list shows, and says so', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('Expiring / Expired Credentials')).toBe('2')
    expect(screen.queryByText('Credentials Expiring')).toBeNull()
  })

  it('booking tile counts ALL pending requests (not capped at the 5 previewed), and ignores resolved ones', async () => {
    const { listBookingRequests } = await import('@/lib/queries/booking-requests')
    vi.mocked(listBookingRequests).mockResolvedValueOnce([
      ...[1, 2, 3, 4, 5, 6, 7].map((id) => bookingRequest(id, 'pending')),
      bookingRequest(8, 'confirmed'),
      bookingRequest(9, 'declined'),
    ] as never)
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('Pending Booking Requests')).toBe('7')
    // The preview list beside it still shows at most 5.
    expect(screen.getAllByText(/^Requester \d$/)).toHaveLength(5)
  })

  it('pending-assignments tile counts every pending assignment (what /front-desk/assignments lists), not only today\'s', async () => {
    const { countAllPendingAssignments, listTodaysAssignments } = await import('@/lib/queries/doctor-assignments')
    vi.mocked(listTodaysAssignments).mockResolvedValueOnce([])
    vi.mocked(countAllPendingAssignments).mockResolvedValueOnce(1)
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('Pending Assignments')).toBe('1')
  })
})
