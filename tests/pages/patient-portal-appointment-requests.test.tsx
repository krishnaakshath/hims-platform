// Wave J (P1-20): the portal appointments page -- reschedule/cancel requests on the patient's
// own upcoming appointments, follow-up reminders, request history and the request form.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND') }, useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal', () => ({
  getPatientPortalData: vi.fn(async () => ({
    upcomingAppointments: [
      { id: 1, visitReason: 'Diabetes review', providerName: 'Dr. Meera Iyer', status: 'scheduled', startsAt: new Date('2099-11-03T04:00:00Z') },
      { id: 2, visitReason: 'Eye check', providerName: 'Dr. Rao', status: 'scheduled', startsAt: new Date('2099-11-04T04:00:00Z') },
      { id: 3, visitReason: 'Old', providerName: 'Dr. Rao', status: 'cancelled', startsAt: new Date('2099-11-05T04:00:00Z') },
    ],
    pastAppointments: [],
  })),
}))
vi.mock('@/lib/queries/follow-ups', () => ({ getPortalFollowUps: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-portal-records', () => ({
  listPortalAppointmentRequests: vi.fn(async () => []),
  listPortalBookableProviders: vi.fn(async () => [{ id: 4, name: 'Dr. Meera Iyer', specialty: 'Endocrinology' }]),
  pendingRequestAppointmentIds: vi.fn(async () => new Set([2])),
}))

import Page from '@/app/patient-portal/(authenticated)/appointments/page'
import { getPortalFollowUps } from '@/lib/queries/follow-ups'
import { listPortalAppointmentRequests, pendingRequestAppointmentIds } from '@/lib/queries/patient-portal-records'
import { todayIsoIn } from '@/lib/india-time'

beforeEach(() => { refresh.mockClear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('/patient-portal/appointments (Wave J)', () => {
  it('offers reschedule/cancel only on scheduled appointments without a pending request', async () => {
    render(await Page())
    expect(pendingRequestAppointmentIds).toHaveBeenCalledWith('RD-0001', [1, 2, 3])
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]).getByRole('button', { name: /^Reschedule/ })).toBeInTheDocument()
    expect(within(items[1]).getByText('Change requested')).toBeInTheDocument()
    expect(within(items[1]).queryByRole('button', { name: /^Cancel/ })).toBeNull()
    expect(within(items[2]).queryByRole('button')).toBeNull()
  })

  it('sends a cancellation request for the chosen appointment', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 9 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(await Page())
    fireEvent.click(screen.getAllByRole('button', { name: /^Cancel/ })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Send cancellation request' }))
    await waitFor(() => expect(screen.getByText('Request sent to the hospital.')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/patient-portal/appointment-requests', expect.objectContaining({ method: 'POST', body: JSON.stringify({ appointmentId: 1, kind: 'cancel' }) }))
    expect(refresh).toHaveBeenCalled()
  })

  it('shows a route error (e.g. 409 duplicate) to the patient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'You already have a pending request for this appointment' }), { status: 409 })))
    render(await Page())
    fireEvent.click(screen.getAllByRole('button', { name: /^Reschedule/ })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Send reschedule request' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a pending request for this appointment')
  })

  it('lists follow-up reminders and prefills the request form from a due follow-up window', async () => {
    vi.mocked(getPortalFollowUps).mockResolvedValueOnce([{ dueDate: '2099-12-10', windowStart: '2099-12-07', windowEnd: '2099-12-17', status: 'planned', appointmentStartsAt: null, doctorName: 'Dr. Meera Iyer' }])
    render(await Page())
    expect(screen.getByText('Due, please book')).toBeInTheDocument()
    expect(screen.getByText(/Please visit between 7 Dec 2099 and 17 Dec 2099/)).toBeInTheDocument()
    const form = screen.getByRole('form', { name: 'Request an appointment' })
    expect(within(form).getByLabelText('Earliest date')).toHaveValue('2099-12-07')
    expect(within(form).getByLabelText('Latest date')).toHaveValue('2099-12-17')
    expect(within(form).getByLabelText('Reason for the visit')).toHaveValue('Follow-up visit')
  })

  it('submits a new-visit request with today as the earliest allowed date', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 3 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(await Page())
    const form = screen.getByRole('form', { name: 'Request an appointment' })
    expect(within(form).getByLabelText('Earliest date')).toHaveAttribute('min', todayIsoIn())
    fireEvent.change(within(form).getByLabelText('Doctor (optional)'), { target: { value: '4' } })
    fireEvent.change(within(form).getByLabelText('Reason for the visit'), { target: { value: 'Knee pain' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Send request' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Request sent'))
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body).toEqual({ kind: 'new', preferredProviderId: 4, preferredDateRangeStart: todayIsoIn(), preferredDateRangeEnd: todayIsoIn(), reason: 'Knee pain' })
  })

  it('lists the patient\'s requests with a plain status', async () => {
    vi.mocked(listPortalAppointmentRequests).mockResolvedValueOnce([
      { id: 1, kind: 'cancel', status: 'pending', appointmentId: 1, preferredDateRangeStart: '2099-11-03', preferredDateRangeEnd: '2099-11-03', submittedAt: new Date('2099-10-01T05:00:00Z') },
      { id: 2, kind: 'new', status: 'declined', appointmentId: null, preferredDateRangeStart: '2099-10-10', preferredDateRangeEnd: '2099-10-12', submittedAt: new Date('2099-09-01T05:00:00Z') },
    ])
    render(await Page())
    expect(screen.getByText('Cancellation')).toBeInTheDocument()
    expect(screen.getByText('Waiting for the hospital')).toBeInTheDocument()
    expect(screen.getByText('Not possible, please call the hospital')).toBeInTheDocument()
  })
})
