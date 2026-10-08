import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PortalFollowUpCard } from '@/components/follow-ups/PortalFollowUpCard'
import type { PortalFollowUp } from '@/lib/follow-ups/view'

const PLANNED: PortalFollowUp = { dueDate: '2026-10-21', windowStart: '2026-10-18', windowEnd: '2026-10-28', status: 'planned', appointmentStartsAt: null, doctorName: 'Dr. K' }
const BOOKED: PortalFollowUp = { ...PLANNED, status: 'scheduled', appointmentStartsAt: new Date('2026-10-21T19:00:00Z') }

describe('PortalFollowUpCard', () => {
  it('shows the window when not booked', () => {
    render(<PortalFollowUpCard followUp={PLANNED} />)
    expect(screen.getByRole('heading', { name: 'Your follow-up' })).toBeInTheDocument()
    expect(screen.getByText(/Due, please book/)).toBeInTheDocument()
    expect(screen.getByText(/18 Oct 2026.*28 Oct 2026/)).toBeInTheDocument()
  })

  it('shows the IST time and doctor when booked', () => {
    render(<PortalFollowUpCard followUp={BOOKED} />)
    expect(screen.getByText('Booked')).toBeInTheDocument()
    expect(screen.getByText('22 Oct 2026, 12:30 am with Dr. K')).toBeInTheDocument()
  })

  it('asks a missed patient to call', () => {
    render(<PortalFollowUpCard followUp={{ ...PLANNED, status: 'missed' }} />)
    expect(screen.getByText(/Missed, please contact us/)).toBeInTheDocument()
    expect(screen.getByText('Please call the hospital to rebook.')).toBeInTheDocument()
  })

  it('card shows no reason or notes', () => {
    const { container } = render(<PortalFollowUpCard followUp={{ ...BOOKED, ...({ reason: 'SECRET', planNotes: 'SECRET' } as object) } as PortalFollowUp} />)
    expect(container.textContent).not.toContain('SECRET')
  })
})

// Wave J (P1-20)
describe('PortalFollowUpCard request link', () => {
  it('links a due or missed follow-up to the portal request form; a booked one has no link', () => {
    const { unmount } = render(<PortalFollowUpCard followUp={PLANNED} />)
    expect(screen.getByRole('link', { name: 'Request this visit' })).toHaveAttribute('href', '/patient-portal/appointments#request-appointment')
    unmount()
    render(<PortalFollowUpCard followUp={BOOKED} />)
    expect(screen.queryByRole('link', { name: 'Request this visit' })).toBeNull()
  })
})
