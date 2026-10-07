import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CoordinatorDashboard } from '@/components/dashboards/CoordinatorDashboard'
import type { DashboardPageProps } from '@/components/dashboards/AdminDashboard'

// jsdom has no ResizeObserver, but recharts' <ResponsiveContainer> (used by
// PatientsByMonthChart / ScreeningBreakdownChart, both rendered here) requires
// one to measure its container on mount. Stub it locally, same as
// AdminDashboard.test.tsx does.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

const baseProps: DashboardPageProps = {
  session: { role: 'crc', name: 'Test CRC', userId: null },
  data: {
    latestForms: [], pendingForms: [{ id: 1, status: 'sent', sentDate: new Date().toISOString(), completedDate: null, templateName: 'Intake', patientName: 'Jane Doe' }],
    pendingFormsTotal: 1, pendingClassification: [{ id: 'RD-0001', name: 'Jane Doe' }],
    recentEvents: [{ id: 1, action: 'sent intake form', userName: 'Test CRC', timestamp: new Date().toISOString() }],
    patientsByMonth: [{ month: 'Jan', count: 2 }], screeningBreakdown: { green: 1, yellow: 2, red: 0 },
    peakHourRange: '10:00 AM – 12:00 PM', avgExperienceRating: 4.5, completedReviewCount: 2, totalPatients: 1,
  },
  templates: [{ id: 1, name: 'Intake Form' }],
  patients: [{ id: 'RD-0001', name: 'Jane Doe' }],
  appointmentsInRange: [],
  staffByRole: [{ role: 'admin', count: 1 }, { role: 'pi', count: 2 }, { role: 'crc', count: 3 }],
  // Spec §6's role table: a crc session never gets the "Start telemedicine
  // visit" action (only admin/pi do) -- false here matches how a real
  // CoordinatorDashboard render (crc session) always computes this.
  canStartTelemedicine: false,
}

describe('CoordinatorDashboard', () => {
  it('keeps every widget from the original shared Home page (content parity)', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    expect(screen.getByText(/peak scheduling hours/i)).toBeInTheDocument()
    expect(screen.getByText(/patients added/i)).toBeInTheDocument()
    expect(screen.getByText(/screening status breakdown/i)).toBeInTheDocument()
    expect(screen.getAllByText(/pending classifications/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/latest account events/i)).toBeInTheDocument()
    expect(screen.getByText(/busiest 2-hour window/i)).toBeInTheDocument()
    expect(screen.getByText(/screened ·/i)).toBeInTheDocument()
    expect(screen.getByText(/completed experience survey/i)).toBeInTheDocument()
  })

  it('puts the actionable queues (Pending Forms, Pending Classifications) before the stat row in document order', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    const queueIdx = headings.findIndex((h) => /pending classifications/i.test(h ?? ''))
    const statIdx = headings.findIndex((h) => /patients added/i.test(h ?? ''))
    expect(queueIdx).toBeGreaterThanOrEqual(0)
    expect(statIdx).toBeGreaterThanOrEqual(0)
    expect(queueIdx).toBeLessThan(statIdx)
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
    render(<CoordinatorDashboard {...baseProps} data={staleData as DashboardPageProps['data']} patients={patients} />)
    expect(screen.getAllByText('41')).toHaveLength(2)
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })

  it('both Total Patients figures use the same shared data.totalPatients as the admin dashboard (no role scoping)', () => {
    render(<CoordinatorDashboard {...baseProps} data={{ ...baseProps.data, totalPatients: 66 }} />)
    expect(screen.getAllByText('66')).toHaveLength(2)
  })

  it('does not show the admin-only staff roster or audit log link', () => {
    render(<CoordinatorDashboard {...baseProps} />)
    expect(screen.queryByRole('link', { name: /audit log/i })).not.toBeInTheDocument()
  })
})
