// WS1 T3: the hospital-first doctor home. Trials off: "Consultant · <department>", the doctor's own
// recent patients in the hospital table, no screening column. Either mode: Today's Schedule starts
// the visit through POST /api/encounters/<id>/start and opens the workspace; an appointment not yet
// checked in shows "Awaiting check-in"; Today's OPD links to the workspace.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  listMyRecentPatients: vi.fn(),
  listPatientsWithStatus: vi.fn(),
  listOpenReferralsToProvider: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) },
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr. A Rao', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patients', () => ({ listPatientsWithStatus: h.listPatientsWithStatus }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 3, name: 'Dr. A Rao' }]) }))
vi.mock('@/lib/queries/doctor-assignments', () => ({ listPendingAssignmentsForProvider: vi.fn(async () => []) }))
vi.mock('@/lib/doctor-queue-provider', () => ({ resolveDoctorQueueProvider: vi.fn(async () => ({ id: 3, name: 'Dr. A Rao' })) }))
vi.mock('@/lib/queries/referrals', () => ({ listOpenReferralsToProvider: h.listOpenReferralsToProvider, providerDepartmentId: vi.fn(async () => 12) })) // WS1 T4
vi.mock('@/lib/queries/coding-queries', () => ({ listOpenCodingQueriesForProvider: vi.fn(async () => []) }))
vi.mock('@/lib/queries/lab-critical', () => ({ listOpenCriticalAlerts: vi.fn(async () => []), acknowledgeableCriticalOrderIds: vi.fn(async () => []) })) // WS4 T12
vi.mock('@/lib/queries/appointments', () => ({
  listAppointmentsInRange: vi.fn(async () => [
    { id: 501, patientId: 'RD-0501', patientName: 'Meena Iyer', providerId: 3, providerName: 'Dr. A Rao', providerColorTag: 'chart-1', startsAt: new Date(), endsAt: new Date(Date.now() + 1_800_000), visitReason: 'Fever', status: 'scheduled', notes: null },
    { id: 502, patientId: 'RD-0502', patientName: 'Ravi Kumar', providerId: 3, providerName: 'Dr. A Rao', providerColorTag: 'chart-1', startsAt: new Date(), endsAt: new Date(Date.now() + 1_800_000), visitReason: 'Review', status: 'scheduled', notes: null },
    { id: 503, patientId: 'RD-0503', patientName: 'Asha Nair', providerId: 3, providerName: 'Dr. A Rao', providerColorTag: 'chart-1', startsAt: new Date(), endsAt: new Date(Date.now() + 1_800_000), visitReason: 'Cough', status: 'scheduled', notes: null },
  ]),
}))
vi.mock('@/lib/queries/hospital-kpis', () => ({
  getDoctorWorkload: vi.fn(async () => ({
    encountersToday: [{ encounterId: 77, patientId: 'RD-0501', patientName: 'Meena Iyer', uhid: 'UH-501', opdToken: 4, status: 'checked_in' }],
    inpatients: [], resultsToReview: [], labsAwaitingResult: 0, followUps: [], unsignedNotes: 0, draftNotes: [],
  })),
}))
vi.mock('@/lib/queries/encounter-workspace', () => ({
  encountersForAppointments: vi.fn(async () => new Map([[501, { encounterId: 77, status: 'checked_in' }], [503, { encounterId: 78, status: 'in_consultation' }]])),
  uhidsForPatients: vi.fn(async () => new Map([['RD-0501', 'UH-501'], ['RD-0502', 'UH-502'], ['RD-0503', 'UH-503']])),
  listMyRecentPatients: h.listMyRecentPatients,
  providerDepartmentName: vi.fn(async () => 'General Medicine'),
}))

import DoctorPortalPage from '@/app/(dashboard)/doctor/page'

describe('doctor home (hospital-first)', () => {
  beforeEach(() => {
    h.push.mockClear()
    h.listMyRecentPatients.mockReset()
    h.listMyRecentPatients.mockResolvedValue([
      { id: 'RD-0900', name: 'Gopal Shah', dob: '1970-05-01', uhid: 'UH-900', phone: null, gender: 'male', currentProvider: 'Dr. A Rao', referralType: null, lastCommunication: null, lastVisitAt: '2026-10-01T05:00:00.000Z', primaryPayerName: null },
    ])
    h.listOpenReferralsToProvider.mockReset()
    h.listOpenReferralsToProvider.mockResolvedValue([])
    h.listPatientsWithStatus.mockReset()
    h.listPatientsWithStatus.mockResolvedValue([
      { id: 'RD-0001', overallStatus: 'green', name: 'Trial Person', dob: '1990-01-01', currentProvider: 'Dr. A Rao', referralType: null, lastCommunication: null, criteriaSummary: { inclusionMet: 1, inclusionTotal: 2, exclusionMet: 0, exclusionTotal: 0 } },
    ])
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  describe('trials off', () => {
    beforeEach(() => { vi.stubEnv('ENABLE_TRIALS', '') })

    it('says Consultant · department, lists my recent patients in the hospital table, no trial wording', async () => {
      render(await DoctorPortalPage())
      expect(screen.queryByText(/principal investigator/i)).toBeNull()
      expect(screen.getByText('Consultant · General Medicine')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'My patients (last 90 days)' })).toBeInTheDocument()
      expect(screen.queryByText(/assigned patient panel/i)).toBeNull()
      expect(screen.getByText('Gopal Shah')).toBeInTheDocument()
      expect(screen.getByText('UH-900')).toBeInTheDocument()
      expect(screen.queryByText(/meets|inclusion|screening/i)).toBeNull()
      expect(h.listPatientsWithStatus).not.toHaveBeenCalled()
      expect(h.listMyRecentPatients).toHaveBeenCalledWith(3, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    })

    it('Start Encounter posts to the visit\'s start route and opens the workspace', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'in_consultation', changed: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      vi.stubGlobal('fetch', fetchMock)
      render(await DoctorPortalPage())
      const buttons = screen.getAllByRole('button', { name: /start encounter/i })
      expect(buttons).toHaveLength(1)
      fireEvent.click(buttons[0])
      await waitFor(() => expect(h.push).toHaveBeenCalledWith('/encounters/77'))
      expect(fetchMock).toHaveBeenCalledWith('/api/encounters/77/start', expect.objectContaining({ method: 'POST' }))
    })

    it('an appointment with no visit shows "Awaiting check-in"; one in consultation offers Continue; UHID not chart id', async () => {
      render(await DoctorPortalPage())
      expect(screen.getByText('Awaiting check-in')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /continue/i })).toHaveAttribute('href', '/encounters/78')
      expect(screen.getAllByText(/UH-502/).length).toBeGreaterThan(0)
      expect(screen.queryByText(/RD-0502/)).toBeNull()
    })

    it('Today\'s OPD rows link to the workspace', async () => {
      render(await DoctorPortalPage())
      const links = screen.getAllByRole('link', { name: 'Meena Iyer' })
      expect(links.map((l) => l.getAttribute('href'))).toContain('/encounters/77')
    })
  })

  describe('trials on', () => {
    beforeEach(() => { vi.stubEnv('ENABLE_TRIALS', 'true') })

    it('keeps the trial panel and Principal Investigator wording; Start Encounter still targets the visit', async () => {
      render(await DoctorPortalPage())
      expect(screen.getByText(/principal investigator/i)).toBeInTheDocument()
      expect(screen.getByText(/assigned patient panel/i)).toBeInTheDocument()
      expect(h.listMyRecentPatients).not.toHaveBeenCalled()
      expect(screen.getByRole('button', { name: /start encounter/i })).toBeInTheDocument()
    })
  })
  // WS1 T4
  it('"Referred to me" lists open referrals with the UHID (never the chart id), linked to the chart', async () => {
    h.listOpenReferralsToProvider.mockResolvedValue([
      { id: 9, patientId: 'RD-0777', patientName: 'Kiran Das', uhid: 'UH-777', fromProviderName: 'Dr. B Shah', urgency: 'urgent', createdAt: new Date('2026-10-22T05:00:00Z') },
    ])
    render(await DoctorPortalPage())
    expect(screen.getByRole('heading', { name: 'Referred to me' })).toBeInTheDocument()
    const link = screen.getByRole('link', { name: 'Kiran Das' })
    expect(link).toHaveAttribute('href', '/patients/RD-0777')
    expect(screen.getByText('UH-777')).toBeInTheDocument()
    expect(screen.getByText(/from Dr\. B Shah/)).toBeInTheDocument()
    expect(screen.queryByText('RD-0777')).toBeNull()
    expect(h.listOpenReferralsToProvider).toHaveBeenCalledWith(3, 12)
  })
})
