import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import { FollowUpWorklist } from '@/components/follow-ups/FollowUpWorklist'
import { row } from './worklist-fixtures'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
afterEach(() => { cleanup(); push.mockClear(); vi.unstubAllGlobals() })

const BASE = {
  rows: [row()],
  counts: { due: 2, overdue: 1, upcoming: 3, scheduled: 4, missed: 5 },
  filters: { bucket: 'overdue' as const, departmentId: 2, providerId: 7 },
  providers: [{ id: 7, name: 'Dr. K' }, { id: 8, name: 'Dr. L' }],
  departments: [{ id: 2, name: 'Cardiology' }, { id: 3, name: 'Neurology' }],
  todayIso: '2026-10-20',
  canAct: true,
  capped: false,
  missedCapped: false,
}

describe('FollowUpWorklist', () => {
  it('tab links keep the department and doctor filters', () => {
    render(<FollowUpWorklist {...BASE} />)
    const due = screen.getByRole('link', { name: 'Due (2)' })
    expect(due.getAttribute('href')).toContain('bucket=due')
    expect(due.getAttribute('href')).toContain('departmentId=2')
    expect(due.getAttribute('href')).toContain('providerId=7')
    expect(screen.getByRole('link', { name: 'Booked (4)' }).getAttribute('href')).toContain('bucket=scheduled')
    expect(screen.getByRole('link', { name: 'Overdue (1)' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows patient link, tel link, and row actions when canAct', () => {
    render(<FollowUpWorklist {...BASE} />)
    expect(screen.getByRole('link', { name: /Asha Rao/ }).getAttribute('href')).toBe('/patients/RD-0001')
    expect(screen.getByRole('link', { name: /98765/ }).getAttribute('href')).toMatch(/^tel:/)
    expect(screen.getByRole('button', { name: /^book/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /log contact/i })).toBeInTheDocument()
  })

  it('hides actions when read-only', () => {
    render(<FollowUpWorklist {...BASE} canAct={false} />)
    expect(screen.queryByRole('button', { name: /book|log contact|cancel booking/i })).toBeNull()
  })

  it('department select navigates keeping the other filters', () => {
    render(<FollowUpWorklist {...BASE} />)
    fireEvent.change(screen.getByLabelText(/department/i), { target: { value: '3' } })
    expect(push).toHaveBeenCalledTimes(1)
    const url = push.mock.calls[0][0] as string
    expect(url).toContain('departmentId=3')
    expect(url).toContain('providerId=7')
    expect(url).toContain('bucket=overdue')
  })

  it('shows the cap notice and the empty state', () => {
    render(<FollowUpWorklist {...BASE} capped rows={[]} />)
    expect(screen.getByText(/showing first 500/i)).toBeInTheDocument()
    expect(screen.queryByText(/showing first 200/i)).toBeNull()
    expect(screen.getByText('No follow-ups in this list.')).toBeInTheDocument()
  })

  it('shows Reschedule and Cancel booking for a booked row, with the booking time in IST', () => {
    const booked = row({ status: 'scheduled', bucket: 'scheduled', appointment: { id: 3, startsAt: new Date('2026-10-21T19:00:00Z'), endsAt: new Date('2026-10-21T19:15:00Z'), status: 'scheduled', providerId: 7, providerName: 'Dr. K' } })
    render(<FollowUpWorklist {...BASE} rows={[booked]} />)
    expect(screen.getByRole('button', { name: /reschedule/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel booking/i })).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText(/22 Oct 2026, 12:30 am/)).toBeInTheDocument()
  })

  it('cancel booking confirms first and shows the server error in an alert', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'That follow-up is not booked.' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const booked = row({ status: 'scheduled', bucket: 'scheduled', appointment: { id: 3, startsAt: new Date('2026-10-21T19:00:00Z'), endsAt: new Date('2026-10-21T19:15:00Z'), status: 'scheduled', providerId: 7, providerName: 'Dr. K' } })
    render(<FollowUpWorklist {...BASE} rows={[booked]} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel booking/i }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: 'Patient asked' } })
    fireEvent.click(screen.getByRole('button', { name: /^confirm/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not booked/)
  })

  it('opens the contact dialog and the booking dialog prefilled', () => {
    render(<FollowUpWorklist {...BASE} />)
    fireEvent.click(screen.getByRole('button', { name: /log contact/i }))
    expect(screen.getByLabelText(/outcome/i)).toBeInTheDocument()
    cleanup()
    render(<FollowUpWorklist {...BASE} />)
    fireEvent.click(screen.getByRole('button', { name: /^book/i }))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByLabelText(/^date/i)).toHaveValue('2026-10-20')
    expect(dialog.getByLabelText(/doctor/i)).toHaveValue('7')
  })

  it('the Missed list has its own 200-row notice, driven by missedCapped', () => {
    render(<FollowUpWorklist {...BASE} filters={{ ...BASE.filters, bucket: 'missed' }} missedCapped />)
    expect(screen.getByText(/showing first 200/i)).toBeInTheDocument()
    expect(screen.queryByText(/showing first 500/i)).toBeNull()
    cleanup()
    render(<FollowUpWorklist {...BASE} filters={{ ...BASE.filters, bucket: 'missed' }} />)
    expect(screen.queryByText(/showing first/i)).toBeNull()
  })

  it('the live 500 notice is not driven by the missed flag', () => {
    render(<FollowUpWorklist {...BASE} missedCapped />)
    expect(screen.queryByText(/showing first/i)).toBeNull()
  })
})
