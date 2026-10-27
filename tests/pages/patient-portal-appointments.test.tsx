import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import PatientPortalAppointmentsPage from '@/app/patient-portal/(authenticated)/appointments/page'

vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
// Wave J: the page also reads follow-ups, requests and bookable doctors.
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND') }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/queries/follow-ups', () => ({ getPortalFollowUps: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-portal-records', () => ({
  listPortalAppointmentRequests: vi.fn(async () => []),
  listPortalBookableProviders: vi.fn(async () => []),
  pendingRequestAppointmentIds: vi.fn(async () => new Set()),
  // WS7 T7: past visits come from encounters and admissions.
  listPortalPastVisits: vi.fn(async () => [
    { kind: 'opd', date: '2026-10-08', doctorName: 'Dr. Ananya Rao', departmentName: 'General Medicine', status: 'completed', dischargeSummaryHref: null },
    { kind: 'ipd', date: '2026-09-20', doctorName: 'Dr. Vikram Shetty', departmentName: 'General Surgery', status: 'discharged', dischargeSummaryHref: '/patient-portal/documents/discharge/42' },
  ]),
}))

const LONG_UPCOMING = 'Follow-up\n\nr/o MI   ' + 'detail '.repeat(40)
const LONG_PAST = '  Old\r\nvisit\t\tnotes ' + 'x'.repeat(200)

vi.mock('@/lib/queries/patient-portal', () => ({
  getPatientPortalData: vi.fn(async () => ({
    upcomingAppointments: [
      { id: 1, visitReason: LONG_UPCOMING, providerName: 'Dr. R. Kunam', status: 'scheduled', startsAt: new Date('2026-11-03T09:00:00') },
      { id: 2, visitReason: 'Short reason', providerName: 'Dr. R. Kunam', status: 'scheduled', startsAt: new Date('2026-11-04T09:00:00') },
    ],
    pastAppointments: [
      { id: 3, visitReason: LONG_PAST, providerName: 'Dr. R. Kunam', status: 'completed', startsAt: new Date('2026-09-03T09:00:00') },
    ],
  })),
}))

function reasonTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('li p:first-child')).map((p) => p.textContent ?? '')
}

describe('Patient portal appointments page -- visit reason display', () => {
  it('renders legacy long multi-line stored reasons collapsed and capped at 140 chars; short ones unchanged', async () => {
    const { container } = render(await PatientPortalAppointmentsPage())
    const [upcoming, short] = reasonTexts(container)

    expect(upcoming.startsWith('Follow-up r/o MI detail detail')).toBe(true)
    expect(upcoming).toHaveLength(140)
    expect(upcoming.endsWith('…')).toBe(true)

    for (const t of [upcoming]) expect(t).not.toMatch(/\s{2}|[\n\r\t]/)
    expect(short).toBe('Short reason')
    expect(screen.queryByText(LONG_UPCOMING)).toBeNull()
  })
})

// WS7 T7: "Past visits" lists encounters and stays (doctor, IST date), not past appointments.
describe('Patient portal appointments page -- past visits', () => {
  it('lists the OPD visit and the hospital stay with doctor and date; the stay links to its summary', async () => {
    render(await PatientPortalAppointmentsPage())
    const section = screen.getByRole('region', { name: 'Past visits' })
    expect(section).toHaveTextContent('Outpatient visit')
    expect(section).toHaveTextContent('Dr. Ananya Rao')
    expect(section).toHaveTextContent('8 Oct 2026')
    expect(section).toHaveTextContent('Hospital stay')
    expect(section).toHaveTextContent('20 Sep 2026')
    const link = screen.getByRole('link', { name: /discharge summary/i })
    expect(link).toHaveAttribute('href', '/patient-portal/documents/discharge/42')
    // Past appointments are no longer listed.
    expect(section).not.toHaveTextContent('Old visit notes')
  })
})
