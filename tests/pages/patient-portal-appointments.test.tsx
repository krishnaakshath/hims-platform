import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import PatientPortalAppointmentsPage from '@/app/patient-portal/(authenticated)/appointments/page'

vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))

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
    const [upcoming, short, past] = reasonTexts(container)

    expect(upcoming.startsWith('Follow-up r/o MI detail detail')).toBe(true)
    expect(upcoming).toHaveLength(140)
    expect(upcoming.endsWith('…')).toBe(true)

    expect(past.startsWith('Old visit notes xxx')).toBe(true)
    expect(past).toHaveLength(140)
    expect(past.endsWith('…')).toBe(true)

    for (const t of [upcoming, past]) expect(t).not.toMatch(/\s{2}|[\n\r\t]/)
    expect(short).toBe('Short reason')
    expect(screen.queryByText(LONG_UPCOMING)).toBeNull()
  })
})
