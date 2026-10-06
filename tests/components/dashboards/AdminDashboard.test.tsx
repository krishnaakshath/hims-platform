import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AdminDashboard, type DashboardPageProps } from '@/components/dashboards/AdminDashboard'

// jsdom has no ResizeObserver, but recharts' <ResponsiveContainer> (used by
// PatientsByMonthChart / ScreeningBreakdownChart, both rendered here) requires
// one to measure its container on mount. Stub it locally rather than in the
// shared vitest.setup.ts, since this is the first test file to render a
// recharts-based component.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const baseProps: DashboardPageProps = {
  session: { role: 'admin', name: 'Test Admin', userId: null },
  data: {
    latestForms: [], pendingForms: [], pendingFormsTotal: 3, pendingClassification: [{ id: 'RD-0001', name: 'Jane Doe' }],
    recentEvents: [], patientsByMonth: [{ month: 'Jan', count: 2 }], screeningBreakdown: { green: 1, yellow: 2, red: 0 },
    peakHourRange: '10:00 AM – 12:00 PM', avgExperienceRating: 4.5, completedReviewCount: 2, totalPatients: 1,
  },
  templates: [{ id: 1, name: 'Intake Form' }],
  patients: [{ id: 'RD-0001', name: 'Jane Doe' }],
  appointmentsInRange: [],
  staffByRole: [{ role: 'admin', count: 1 }, { role: 'pi', count: 2 }, { role: 'crc', count: 3 }],
  canStartTelemedicine: true,
}

describe('AdminDashboard', () => {
  it('keeps every widget from the original shared Home page (content parity)', () => {
    render(<AdminDashboard {...baseProps} />)
    expect(screen.getByText(/peak scheduling hours/i)).toBeInTheDocument()
    // "Total Patients" appears twice by design (the stat-row card header and
    // the "Total Patients" mini stat tile), so use getAllByText here and for
    // the other two labels that are likewise duplicated across a stat/section
    // heading and a mini stat tile, rather than getByText (which throws on
    // more than one match).
    expect(screen.getAllByText(/total patients/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/avg\. patient experience/i)).toBeInTheDocument()
    expect(screen.getByText(/patients added/i)).toBeInTheDocument()
    expect(screen.getByText(/screening status breakdown/i)).toBeInTheDocument()
    expect(screen.getAllByText(/pending forms/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/pending classifications/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/form templates/i)).toBeInTheDocument()
    expect(screen.getByText(/latest forms received/i)).toBeInTheDocument()
    expect(screen.getByText(/latest account events/i)).toBeInTheDocument()
  })

  it('falls back to the distinct patient ids in the picker list when a pre-deploy cached object has no totalPatients', () => {
    // getDashboardData() is cached for 15s, so right after a deploy the
    // cached object can predate the totalPatients field. The tiles must
    // still show a real number, never NaN or a blank.
    const { totalPatients: _omit, ...staleData } = baseProps.data
    void _omit
    const ids = Array.from({ length: 41 }, (_, i) => `RD-${String(i + 1).padStart(4, '0')}`)
    // The picker is a patient x screening join: a patient screened for two
    // trials appears twice and must still count once.
    const patients = [...ids, ids[0], ids[1]].map((id) => ({ id, name: id }))
    render(<AdminDashboard {...baseProps} data={staleData as DashboardPageProps['data']} patients={patients} />)
    expect(screen.getAllByText('41')).toHaveLength(2)
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })

  it('both Total Patients figures come from the shared data.totalPatients, not the length of the patient picker list', () => {
    // The picker list can legitimately differ from the patient count (it is
    // built from a patient x screening join); the shared definition is the
    // distinct patients count from getDashboardData().
    render(<AdminDashboard {...baseProps} data={{ ...baseProps.data, totalPatients: 66 }} />)
    expect(screen.getAllByText('66')).toHaveLength(2)
  })

  it('adds the new admin-only staff roster card, linking to the existing Settings page', () => {
    render(<AdminDashboard {...baseProps} />)
    expect(screen.getByText(/staff/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /staff/i })).toHaveAttribute('href', '/settings')
  })

  it('renders the Credential Expiry widget with each entry\'s staff name, credential type, and expiry phrase', () => {
    render(<AdminDashboard {...baseProps} expiringCredentials={[
      { id: 1, staffMemberId: 10, staffMemberName: 'Dr. Rajiv Kunam', credentialType: 'DEA Registration', expiresOn: '2026-10-28', daysUntilExpiry: 30, status: 'expiring_soon' },
      { id: 2, staffMemberId: 11, staffMemberName: 'Dr. Elena Bosch', credentialType: 'State Medical License', expiresOn: '2026-09-13', daysUntilExpiry: -15, status: 'expired' },
    ]} />)
    expect(screen.getByText(/credential expiry/i)).toBeInTheDocument()
    expect(screen.getByText('Dr. Rajiv Kunam')).toBeInTheDocument()
    expect(screen.getByText('DEA Registration')).toBeInTheDocument()
    expect(screen.getByText(/expires in 30 days/i)).toBeInTheDocument()
    expect(screen.getByText('Dr. Elena Bosch')).toBeInTheDocument()
    expect(screen.getByText('State Medical License')).toBeInTheDocument()
    expect(screen.getByText(/expired 15 days ago/i)).toBeInTheDocument()
  })

  it('shows the empty-state message when expiringCredentials is empty/omitted', () => {
    render(<AdminDashboard {...baseProps} />)
    expect(screen.getByText(/credential expiry/i)).toBeInTheDocument()
    expect(screen.getByText(/no credentials expiring soon/i)).toBeInTheDocument()
  })
})
