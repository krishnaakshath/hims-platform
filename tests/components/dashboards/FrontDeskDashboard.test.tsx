import { describe, it, expect, vi, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { deadLinks } from '../../pages/dashboard-link-gates'

vi.mock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
vi.mock('@/lib/queries/doctor-assignments', () => ({
  listTodaysAssignments: vi.fn(async () => []),
  countAllPendingAssignments: vi.fn(async () => 0),
  countUnacknowledgedDeclines: vi.fn(async () => 0),
}))
// Wave E: the hospital KPI snapshot (scoped to frontdesk) and patient labels.
vi.mock('@/lib/queries/hospital-kpis', async () => {
  const { HOSPITAL_SNAPSHOT } = await import('../../fixtures/hospital-snapshot')
  return {
    getHospitalSnapshot: vi.fn(async () => ({ ...HOSPITAL_SNAPSHOT, labs: null, billing: null, claims: null })),
    listPatientLabels: vi.fn(async () => [{ id: 'RD-0042', name: 'Asha Verma', uhid: 'UH-000042' }]),
  }
})
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => []) }))
vi.mock('@/lib/queries/booking-requests', () => ({ listBookingRequests: vi.fn(async () => []) }))
vi.mock('@/lib/queries/staff-credentials', () => ({ listExpiringOrExpiredCredentials: vi.fn(async () => { throw new Error('front desk must not load staff credentials') }) }))
vi.mock('@/components/AddPatientButton', () => ({ AddPatientButton: () => <button type="button">Add New Patient</button> }))
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
  it('Wave E P1-06: no staff credential data on the front desk home (a role barred from /staff)', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    const { container } = render(await FrontDeskDashboard({ session: SESSION }))
    expect(screen.queryByText(/credential/i)).toBeNull()
    expect(container.querySelector('a[href^="/staff"]')).toBeNull()
  })

  it('Wave E P1-06: hospital KPIs for the desk -- OPD tokens, beds, collections, recalls -- and no labs, billing or claims', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    const { container } = render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('OPD tokens today')).toBe('42')
    expect(tileValue('Follow-ups to recall')).toBe('9')
    expect(tileValue('Collected today')).toBe('₹1,22,956.00')
    expect(container.querySelector('a[href="/front-desk/follow-ups?bucket=overdue"]')).not.toBeNull()
    expect(screen.queryByText('Lab orders open')).toBeNull()
    expect(screen.queryByText('Draft invoices')).toBeNull()
    expect(screen.getByText('General Ward')).toBeInTheDocument()
  })

  it('Wave E P1-06: quick actions -- register a patient, the queue display and the price lookup', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    const { container } = render(await FrontDeskDashboard({ session: SESSION }))
    expect(screen.getByRole('button', { name: 'Add New Patient' })).toBeInTheDocument()
    expect(container.querySelector('a[href="/display/queue"]')).not.toBeNull()
    expect(container.querySelector('a[href="/price-lookup"]')).not.toBeNull()
  })

  it('Wave E P1-06: today\'s assignments show patient name, UHID and token, never the raw internal id', async () => {
    const { listTodaysAssignments } = await import('@/lib/queries/doctor-assignments')
    vi.mocked(listTodaysAssignments).mockResolvedValueOnce([
      { id: 1, patientId: 'RD-0042', providerId: 1, visitType: 'outpatient', urgency: 'routine', reason: 'Fever', status: 'pending', roomId: null, assignedByName: 'Fran', appointmentId: null, declineReason: null, queueTicketNumber: 17, createdAt: new Date() },
    ] as never)
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(screen.getByText('Asha Verma')).toBeInTheDocument()
    expect(screen.getByText('UH-000042')).toBeInTheDocument()
    expect(screen.getByText('#17')).toBeInTheDocument()
    expect(screen.queryByText('RD-0042')).toBeNull()
  })

  it('Wave E P1-25: the declines tile counts what the Assignments nav badge counts (unacknowledged declines)', async () => {
    const { countUnacknowledgedDeclines } = await import('@/lib/queries/doctor-assignments')
    vi.mocked(countUnacknowledgedDeclines).mockResolvedValueOnce(3)
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('Declines to acknowledge')).toBe('3')
  })

  it('every link on the front desk home opens a page frontdesk may open', async () => {
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    const { container } = render(await FrontDeskDashboard({ session: SESSION }))
    expect(deadLinks(container, 'frontdesk')).toEqual([])
  })

  it('booking preview lists at most 5 pending requests, ignoring resolved ones; the tile shows the live pending count', async () => {
    const { listBookingRequests } = await import('@/lib/queries/booking-requests')
    vi.mocked(listBookingRequests).mockResolvedValueOnce([
      ...[1, 2, 3, 4, 5, 6, 7].map((id) => bookingRequest(id, 'pending')),
      bookingRequest(8, 'confirmed'),
      bookingRequest(9, 'declined'),
    ] as never)
    const { FrontDeskDashboard } = await import('@/components/dashboards/FrontDeskDashboard')
    render(await FrontDeskDashboard({ session: SESSION }))
    expect(tileValue('Booking requests')).toBe('6')
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
