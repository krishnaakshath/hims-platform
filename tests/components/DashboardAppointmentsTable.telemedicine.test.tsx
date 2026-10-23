import { describe, it, expect } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DashboardAppointmentsTable, type DashboardAppointmentRow } from '@/components/DashboardAppointmentsTable'

// WS7 T6 (spec D20): only video appointments offer telemedicine, and a row whose
// session is already live offers "Rejoin (session active)" -- read from the
// server-provided row, so it survives a reload (a fresh mount with no local state).
function row(over: Partial<DashboardAppointmentRow>): DashboardAppointmentRow {
  return {
    id: 1, patientId: 'RD-0001', patientName: 'Asha Rao', providerName: 'Dr. R. Kunam',
    visitReason: 'Follow-up', status: 'scheduled', startsAt: '2026-10-23T04:30:00.000Z',
    visitMode: 'in_person', telemedicine: null, ...over,
  }
}

describe('DashboardAppointmentsTable telemedicine (WS7 T6)', () => {
  it('an in-person row has no telemedicine button and no Video chip', () => {
    render(<DashboardAppointmentsTable appointments={[row({})]} canStartTelemedicine />)
    expect(screen.queryByRole('button', { name: /start telemedicine visit/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Video')).not.toBeInTheDocument()
  })

  it('a video row without a session shows the Video chip and the start button', () => {
    render(<DashboardAppointmentsTable appointments={[row({ id: 2, visitMode: 'video' })]} canStartTelemedicine />)
    expect(screen.getByText('Video')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start telemedicine visit/i })).toBeInTheDocument()
  })

  it('a video row with an active session shows Rejoin after a fresh render (state from the server)', () => {
    for (const status of ['waiting', 'in_progress'] as const) {
      const rows = [row({ id: 3, visitMode: 'video', telemedicine: { sessionId: 55, status } })]
      const first = render(<DashboardAppointmentsTable appointments={rows} canStartTelemedicine />)
      first.unmount()
      // A reload: a brand-new mount fed only the server rows.
      render(<DashboardAppointmentsTable appointments={rows} canStartTelemedicine />)
      const rejoin = screen.getByRole('link', { name: 'Rejoin (session active)' })
      expect(rejoin).toHaveAttribute('href', '/telemedicine/55')
      expect(screen.queryByRole('button', { name: /start telemedicine visit/i })).not.toBeInTheDocument()
      cleanup()
    }
  })

  it('a video row whose call has ended offers neither start nor rejoin', () => {
    render(<DashboardAppointmentsTable appointments={[row({ id: 4, visitMode: 'video', telemedicine: { sessionId: 56, status: 'completed' } })]} canStartTelemedicine />)
    expect(screen.queryByRole('button', { name: /start telemedicine visit/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /rejoin/i })).not.toBeInTheDocument()
    expect(screen.getByText('Video visit ended')).toBeInTheDocument()
  })

  it('without the start permission a video row still shows its Video chip but no action', () => {
    render(<DashboardAppointmentsTable appointments={[row({ id: 5, visitMode: 'video', telemedicine: { sessionId: 57, status: 'waiting' } })]} />)
    expect(screen.getByText('Video')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /rejoin/i })).not.toBeInTheDocument()
  })
})
