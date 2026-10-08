// Wave J (P1-20): the staff queue shows portal requests (kind, target appointment), confirms
// a reschedule against the requesting patient without a picker, and confirms a cancellation
// with an empty PATCH after a second click.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { BookingRequestsQueue } from '@/components/BookingRequestsQueue'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const row = (over: Partial<BookingRequestRow>): BookingRequestRow => ({
  id: 5, requesterName: 'Asha Rao', requesterDob: '1980-01-01', requesterEmail: null, requesterPhone: null, preferredProviderId: null,
  preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-05', reason: 'Knee pain', status: 'pending', submittedAt: new Date('2026-10-08T05:00:00Z'),
  reviewedByName: null, reviewedAt: null, declineReason: null, resultingAppointmentId: null, patientId: null, requestKind: 'new', appointmentId: null, ...over,
})

afterEach(() => { vi.unstubAllGlobals(); refresh.mockClear() })

describe('BookingRequestsQueue portal requests', () => {
  it('labels portal requests and leaves public ones unlabelled', () => {
    render(<BookingRequestsQueue canResolve providers={[]} requests={[row({ id: 1 }), row({ id: 2, patientId: 'RD-1', requestKind: 'reschedule', appointmentId: 77 })]} />)
    expect(screen.getByText('Portal · Reschedule of appointment #77')).toBeInTheDocument()
    expect(screen.getAllByText(/^Portal ·/)).toHaveLength(1)
  })

  it('confirms a cancellation with an empty body after a second click', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BookingRequestsQueue canResolve providers={[]} requests={[row({ id: 9, patientId: 'RD-1', requestKind: 'cancel', appointmentId: 31 })]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment #31' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/booking-requests/9/confirm', expect.objectContaining({ method: 'PATCH', body: '{}' }))
  })
})

describe('ConfirmBookingRequestModal for a portal reschedule', () => {
  it('confirms against the requesting patient with no picker', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ConfirmBookingRequestModal request={row({ patientId: 'RD-0042', requestKind: 'reschedule', appointmentId: 12 })} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    expect(screen.getByText('Confirm Reschedule Request')).toBeInTheDocument()
    expect(screen.getByText(/cancels appointment #12/)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /patient/i })).toBeNull()
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.patientId).toBe('RD-0042')
  })
})
