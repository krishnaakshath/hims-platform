import { describe, it, expect, vi } from 'vitest'
import PatientPortalOverviewPage from '@/app/patient-portal/(authenticated)/page'
import { render, screen } from '@testing-library/react'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { getPortalFollowUps } from '@/lib/queries/follow-ups'

vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/follow-ups', () => ({ getPortalFollowUps: vi.fn(async () => []) }))
vi.mock('@/lib/queries/broadcasts', () => ({ listBroadcastsForPatient: vi.fn(async () => []) }))
// SP5: the "Lab reports" tile counts the patient's current reports.
vi.mock('@/lib/queries/lab-reports', () => ({
  listPortalLabReports: vi.fn(async () => [
    { id: 1, reportNumber: 'LR-2099-000001', releasedAt: new Date('2099-08-01T05:00:00Z'), testSummary: 'HbA1c' },
    { id: 2, reportNumber: 'LR-2099-000002', releasedAt: new Date('2099-08-02T05:00:00Z'), testSummary: 'TSH' },
  ]),
}))
vi.mock('@/lib/queries/patient-portal', () => ({
  getPatientPortalData: vi.fn(async () => ({
    currentProvider: 'Dr. R. Kunam',
    activeMedications: [{ name: 'Sertraline' }],
    diagnoses: [{ code: 'F33.1', description: 'Major depressive disorder' }],
    upcomingAppointments: [{ visitReason: 'Follow-up', providerName: 'Dr. R. Kunam', startsAt: new Date().toISOString() }],
    forms: [{ status: 'sent', templateName: 'Intake Form' }],
    unreadMessageCount: 2,
    profile: {
      uhid: 'UH-000042', abhaAddress: 'asha.rao@abdm', abhaNumberMasked: 'XX-XXXX-XXXX-1234',
      addressSummary: 'Pune, Pune, Maharashtra 411001', emergencyContactName: 'Ravi Rao', aadhaarStatus: 'on_file',
    },
  })),
}))

describe('Patient dashboard (patient-portal overview)', () => {
  it('keeps every summary tile and section from the original page (content parity)', async () => {
    const jsx = await PatientPortalOverviewPage()
    render(jsx)
    expect(screen.getAllByText(/care team/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/current meds/i)).toBeInTheDocument()
    expect(screen.getByText(/forms to complete/i)).toBeInTheDocument()
    expect(screen.getByText(/upcoming visits/i)).toBeInTheDocument()
    expect(screen.getByText(/new messages/i)).toBeInTheDocument()
    expect(screen.getByText(/announcements/i)).toBeInTheDocument()
    expect(screen.getByText(/your care team/i)).toBeInTheDocument()
    expect(screen.getByText(/diagnoses on file/i)).toBeInTheDocument()
  })

  it('puts the action-nudge cards (next visit, needs attention) before the summary tiles in document order (Hims-style Action Items pattern)', async () => {
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    const nudge = container.querySelector('[data-testid="patient-action-items"]')
    const tiles = container.querySelector('[data-testid="patient-summary-tiles"]')
    expect(nudge).not.toBeNull()
    expect(tiles).not.toBeNull()
    expect(nudge!.compareDocumentPosition(tiles!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a legacy long multi-line stored visit reason collapsed and capped at 140 chars', async () => {
    const stored = 'Follow-up\n\nr/o MI   ' + 'detail '.repeat(40)
    const base = await vi.mocked(getPatientPortalData)('RD-0001')
    vi.mocked(getPatientPortalData).mockResolvedValueOnce({
      ...base!,
      upcomingAppointments: [{ ...base!.upcomingAppointments[0], visitReason: stored }],
    })
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    const nudge = container.querySelector('[data-testid="patient-action-items"]')!
    const line = Array.from(nudge.querySelectorAll('p')).find((p) => p.textContent?.includes(' with Dr. R. Kunam'))!
    const shown = line.textContent!.replace(/ with Dr\. R\. Kunam$/, '')
    expect(shown.startsWith('Follow-up r/o MI detail detail')).toBe(true)
    expect(shown).not.toMatch(/\n|\s{2}/)
    expect(shown).toHaveLength(140)
    expect(shown.endsWith('…')).toBe(true)
  })

  it('shows Your details with UHID and Aadhaar on-file status but no digits', async () => {
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    const section = container.querySelector('section[aria-labelledby="your-details-heading"]') as HTMLElement
    expect(section).not.toBeNull()
    expect(section.textContent).toMatch(/Your details/)
    expect(section.textContent).toMatch(/UH-000042/)
    expect(section.textContent).toMatch(/asha\.rao@abdm/)
    expect(section.textContent).toMatch(/XX-XXXX-XXXX-1234/)
    expect(section.textContent).toMatch(/Pune, Pune, Maharashtra 411001/)
    expect(section.textContent).toMatch(/Ravi Rao/)
    expect(section.textContent).toMatch(/Aadhaar\s*On file/)
    // Only the UHID/ABHA/PIN identifiers carry digits; no 12-digit or 4-digit-group Aadhaar-looking value.
    expect(section.textContent).not.toMatch(/\b\d{4}\s?\d{4}\s?\d{4}\b/)
  })

  it('says Declined for a declined Aadhaar, never the reason', async () => {
    const base = await vi.mocked(getPatientPortalData)('RD-0001')
    vi.mocked(getPatientPortalData).mockResolvedValueOnce({ ...base!, profile: { ...base!.profile, aadhaarStatus: 'declined' } })
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    expect(container.querySelector('section[aria-labelledby="your-details-heading"]')!.textContent).toMatch(/Aadhaar\s*Declined/)
  })

  it('says Not on file for Aadhaar when none is recorded', async () => {
    const base = await vi.mocked(getPatientPortalData)('RD-0001')
    vi.mocked(getPatientPortalData).mockResolvedValueOnce({ ...base!, profile: { ...base!.profile, aadhaarStatus: 'not_recorded' } })
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    expect(container.querySelector('section[aria-labelledby="your-details-heading"]')!.textContent).toMatch(/Aadhaar\s*Not on file/)
  })

  it('renders Your follow-up among the action items when one is open', async () => {
    vi.mocked(getPortalFollowUps).mockResolvedValueOnce([
      { dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', status: 'scheduled', appointmentStartsAt: new Date('2026-10-21T19:00:00Z'), doctorName: 'Dr. K' },
    ])
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    const nudge = container.querySelector('[data-testid="patient-action-items"]')!
    expect(nudge.textContent).toContain('Your follow-up')
    expect(nudge.textContent).toContain('22 Oct 2026, 12:30 am with Dr. K')
  })

  it('shows the card as the only action item when nothing else needs attention', async () => {
    const base = await vi.mocked(getPatientPortalData)('RD-0001')
    vi.mocked(getPatientPortalData).mockResolvedValueOnce({ ...base!, upcomingAppointments: [], forms: [] })
    vi.mocked(getPortalFollowUps).mockResolvedValueOnce([
      { dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', status: 'planned', appointmentStartsAt: null, doctorName: 'Dr. K' },
    ])
    const jsx = await PatientPortalOverviewPage()
    const { container } = render(jsx)
    expect(container.querySelector('[data-testid="patient-action-items"]')!.textContent).toContain('Your follow-up')
  })

  it('has no follow-up card when none is open', async () => {
    const jsx = await PatientPortalOverviewPage()
    render(jsx)
    expect(screen.queryByText('Your follow-up')).toBeNull()
  })
})

describe('Patient dashboard next-visit time zone', () => {
  it('shows the next visit in IST even when the server runs in UTC', async () => {
    const prev = process.env.TZ
    process.env.TZ = 'UTC'
    try {
      const base = await vi.mocked(getPatientPortalData)('RD-0001')
      vi.mocked(getPatientPortalData).mockResolvedValueOnce({
        ...base!,
        upcomingAppointments: [{ ...base!.upcomingAppointments[0], startsAt: new Date('2026-10-21T19:00:00.000Z') }],
      })
      const jsx = await PatientPortalOverviewPage()
      const { container } = render(jsx)
      expect(container.querySelector('[data-testid="patient-action-items"]')!.textContent).toContain('22 Oct 2026, 12:30 am')
    } finally {
      if (prev === undefined) delete process.env.TZ
      else process.env.TZ = prev
    }
  })
})

// SP5
describe('Patient dashboard lab reports tile', () => {
  it('counts the session patient\'s current reports and links to the page', async () => {
    const { listPortalLabReports } = await import('@/lib/queries/lab-reports')
    render(await PatientPortalOverviewPage())
    expect(listPortalLabReports).toHaveBeenCalledWith('RD-0001')
    const tile = screen.getByRole('link', { name: /lab reports/i })
    expect(tile).toHaveAttribute('href', '/patient-portal/lab-reports')
    expect(tile).toHaveTextContent('2')
  })
})
