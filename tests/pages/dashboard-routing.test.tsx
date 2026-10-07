import { describe, it, expect, vi } from 'vitest'

// Vitest 5 no longer auto-hoists bare `const mock*` declarations referenced
// inside a `vi.mock` factory (the brief's literal snippet throws "Cannot
// access 'mockRedirect' before initialization" under this project's vitest
// version) -- `vi.hoisted` is the supported way to get the same effect, with
// no change to what the test actually verifies.
const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Test PI' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/dashboard', () => ({ getDashboardData: vi.fn(async () => ({
  latestForms: [], pendingForms: [], pendingFormsTotal: 0, pendingClassification: [], recentEvents: [],
  patientsByMonth: [], screeningBreakdown: { green: 0, yellow: 0, red: 0 }, peakHourRange: null,
  avgExperienceRating: null, completedReviewCount: 0, totalPatients: 0,
})) }))
vi.mock('@/lib/queries/form-templates', () => ({ listFormTemplates: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
vi.mock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
vi.mock('@/lib/queries/users', () => ({ listAllUsers: vi.fn(async () => []) }))

import DashboardHomePage from '@/app/(dashboard)/page'

describe('dashboard role routing', () => {
  it('redirects a PI session to /doctor instead of rendering a Home dashboard', async () => {
    await DashboardHomePage()
    expect(mockRedirect).toHaveBeenCalledWith('/doctor')
  })

  it('renders the FrontDeskDashboard with KPI strip and queue for a frontdesk session', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ redirect: mockRedirect }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'Taylor Nguyen' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => [{ id: 1, ward: 'Ward A', roomNumber: '101', bedNumber: 'A' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listTodaysAssignments: vi.fn(async () => [
      { id: 1, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'urgent', reason: 'Test visit', status: 'pending', roomId: null, assignedByName: 'Taylor Nguyen', appointmentId: null, declineReason: null, createdAt: new Date() },
    ]), countAllPendingAssignments: vi.fn(async () => 1) }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]), listAllProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]) }))
    vi.doMock('@/lib/queries/insurance-eligibility', () => ({ countEligibilityFollowUps: vi.fn(async () => 0) }))
    const { default: DashboardHomePageWithFrontDesk } = await import('@/app/(dashboard)/page')
    const { render, screen } = await import('@testing-library/react')
    const jsx = await DashboardHomePageWithFrontDesk()
    render(jsx)
    expect(screen.getByText(/rooms available/i)).toBeInTheDocument()
    expect(screen.getByText('Test visit')).toBeInTheDocument()
  })

  // SP6 (ruling 4/5): the coder's home is /coding. Without this redirect the coder
  // would fall through to the coordinator dashboard (patient names, appointments).
  it('redirects a coder session to /coding before loading any dashboard data', async () => {
    vi.resetModules()
    const redirectThrows = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
    const listPatients = vi.fn(async () => [])
    vi.doMock('next/navigation', () => ({ redirect: redirectThrows }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'coder', name: 'Asha Menon' })) }))
    vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: listPatients }))
    const { default: Page } = await import('@/app/(dashboard)/page')
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT')
    expect(redirectThrows).toHaveBeenCalledWith('/coding')
    expect(listPatients).not.toHaveBeenCalled()
  })
  // end SP6
})
