import { describe, it, expect, vi } from 'vitest'
import DoctorPortalPage from '@/app/(dashboard)/doctor/page'

vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patients', () => ({
  listPatientsWithStatus: vi.fn(async () => [
    { id: 'RD-0001', overallStatus: 'green', name: 'Jane Doe', dob: '1990-01-01', currentProvider: 'Dr. R. Kunam', referralType: null, lastCommunication: null, criteriaSummary: null },
  ]),
}))
// The page also resolves the PI's own provider row and pending assignment
// queue. Default these to empty here so the two pre-existing tests above
// stay fully isolated (no real DB call) -- the new test below swaps in
// richer data via vi.doMock + vi.resetModules for its own scenario.
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => []) }))
vi.mock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider: vi.fn(async () => []) }))
vi.mock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
vi.mock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
vi.mock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => null) }))

describe('PI dashboard (/doctor)', () => {
  it('keeps the panel stat tiles (content parity)', async () => {
    const jsx = await DoctorPortalPage()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText(/total panel/i)).toBeInTheDocument()
    expect(screen.getByText(/today's visits/i)).toBeInTheDocument()
    expect(screen.getByText(/action needed/i)).toBeInTheDocument()
    expect(screen.getByText(/assigned patient panel/i)).toBeInTheDocument()
  })

  it('shows a pending assignment in the Triage Queue', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({
      listPatientsWithStatus: vi.fn(async () => [
        { id: 'RD-0001', overallStatus: 'green', name: 'Jane Doe', dob: '1990-01-01', currentProvider: 'Dr. R. Kunam', referralType: null, lastCommunication: null, criteriaSummary: null },
      ]),
    }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. R. Kunam' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({
      listPendingAssignmentsForProvider: vi.fn(async () => [
        { id: 1, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'urgent', reason: 'New patient intake', status: 'pending', roomId: null, assignedByName: 'Taylor Nguyen', appointmentId: null, declineReason: null, createdAt: new Date(), patientName: 'Jane Doe', queueTicketNumber: 7, patientNotifiedAt: null, declineAcknowledgedAt: null, declineAcknowledgedByName: null },
      ]),
    }))
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 1, name: 'Dr. R. Kunam' })) }))
    const { default: DoctorPortalPageWithAssignments } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await DoctorPortalPageWithAssignments()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByRole('heading', { name: /triage queue/i })).toBeInTheDocument()
    expect(screen.getByText(/new patient intake/i)).toBeInTheDocument()
  })

  // Regression test: DashboardAppointmentsTable (and the StartTelemedicineButton
  // it renders per row) existed in the codebase but had been left completely
  // unwired from this page by an "Enterprise EMR" layout pass -- a pi had no
  // way to start a telemedicine visit from their own dashboard even though
  // the whole backend (POST /api/appointments/[id]/telemedicine, the join
  // flow, the session page) was fully built and working.
  it('gives pi a telemedicine start entry point scoped to their own matched provider row', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 7, name: 'Dr. R. Kunam' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 7, name: 'Dr. R. Kunam' })) }))
    const listAppointmentsInRange = vi.fn(async () => [{
      id: 501, patientId: 'RD-0001', patientName: 'Jane Doe', providerId: 7, providerName: 'Dr. R. Kunam',
      providerColorTag: 'chart-1', startsAt: new Date('2026-01-15T10:00:00Z'), endsAt: new Date('2026-01-15T10:30:00Z'),
      visitReason: 'Follow-up', status: 'scheduled' as const, notes: null,
    }])
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange }))
    const { default: DoctorPortalPageWithAppointments } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await DoctorPortalPageWithAppointments()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)

    expect(screen.getByText(/my appointments/i)).toBeInTheDocument()
    expect(screen.getByText(/jane doe/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start telemedicine visit/i })).toBeInTheDocument()

    // Ownership scoping happens at the query level, not a per-row client
    // filter -- assert the page actually asked for only this pi's own
    // matched provider id, not every provider's appointments.
    expect(listAppointmentsInRange).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), [7])
  })

  it('scopes to an empty appointment list (not "all providers") and hides the telemedicine button when the pi has no matched provider row', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. Nobody' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 7, name: 'Dr. R. Kunam' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => null) }))
    const listAppointmentsInRange = vi.fn(async () => [{
      id: 502, patientId: 'RD-0001', patientName: 'Jane Doe', providerId: 7, providerName: 'Dr. R. Kunam',
      providerColorTag: 'chart-1', startsAt: new Date('2026-01-15T10:00:00Z'), endsAt: new Date('2026-01-15T10:30:00Z'),
      visitReason: 'Follow-up', status: 'scheduled' as const, notes: null,
    }])
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange }))
    const { default: DoctorPortalPageNoMatch } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await DoctorPortalPageNoMatch()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)

    expect(screen.getByText(/my appointments/i)).toBeInTheDocument()
    expect(listAppointmentsInRange).toHaveBeenCalledWith(expect.any(Date), expect.any(Date), [])
    expect(screen.queryByRole('button', { name: /start telemedicine visit/i })).not.toBeInTheDocument()
  })

  it('unmatched provider shows the explicit warning, not an empty queue', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. Nobody', userId: null })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
    const listPendingAssignmentsForProvider = vi.fn(async () => [])
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider }))
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => null) }))
    const { default: Page } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await Page()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText("We couldn't match your account to a provider record, so your assignment queue can't be shown. Ask an administrator to check your provider record.")).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText(/queue clear/i)).toBeNull()
    const header = screen.getByRole('heading', { name: /triage queue/i }).parentElement!.parentElement!
    expect(header.textContent).not.toMatch(/0/)
    expect(listPendingAssignmentsForProvider).not.toHaveBeenCalled()
  })

  // RBAC Task 18: the panel used `currentProvider.includes(lastName)`, so
  // "Dr. Ann Lee" saw every patient whose provider text was "Dr. Bill Leeson".
  it('the assigned patient panel uses exact surname matching (Dr. Ann Lee never sees Dr. Bill Leeson\'s patients)', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. Ann Lee', userId: null })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({
      listPatientsWithStatus: vi.fn(async () => [
        { id: 'RD-0001', overallStatus: 'green', name: 'Leeson Patient', dob: '1990-01-01', currentProvider: 'Dr. Bill Leeson', referralType: null, lastCommunication: null, criteriaSummary: null },
        { id: 'RD-0002', overallStatus: 'green', name: 'Lee Patient', dob: '1990-01-01', currentProvider: 'Dr. Ann Lee', referralType: null, lastCommunication: null, criteriaSummary: null },
      ]),
    }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Bill Leeson' }, { id: 2, name: 'Dr. Ann Lee' }]) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 2, name: 'Dr. Ann Lee' })) }))
    const { default: Page } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await Page()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText('Lee Patient')).toBeInTheDocument()
    expect(screen.queryByText('Leeson Patient')).toBeNull()
  })

  it('row shows patient name, ticket, assigned-by and an urgency chip', async () => {
    vi.resetModules()
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam', userId: null })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/doctor-assignments', () => ({
      listPendingAssignmentsForProvider: vi.fn(async () => [
        { id: 1, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'urgent', reason: 'New patient intake', status: 'pending', roomId: null, assignedByName: 'Taylor Nguyen', appointmentId: null, declineReason: null, createdAt: new Date(), patientName: 'Jane Doe', queueTicketNumber: 7, patientNotifiedAt: null, declineAcknowledgedAt: null, declineAcknowledgedByName: null },
      ]),
    }))
    vi.doMock('@/lib/queries/appointments', () => ({ listAppointmentsInRange: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/form-submissions', () => ({ listFormSubmissions: vi.fn(async () => []) }))
    vi.doMock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 1, name: 'Dr. R. Kunam' })) }))
    const { default: Page } = await import('@/app/(dashboard)/doctor/page')
    const jsx = await Page()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText('Jane Doe')).toBeInTheDocument()
    expect(screen.getByText('#7')).toBeInTheDocument()
    expect(screen.getByText(/Taylor Nguyen/)).toBeInTheDocument()
    expect(screen.getByText('Urgent')).toBeInTheDocument()
  })
})
