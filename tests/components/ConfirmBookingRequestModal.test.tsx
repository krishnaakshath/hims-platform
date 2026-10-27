import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import { BookingRequestsQueue } from '@/components/BookingRequestsQueue'
import { ToastProvider } from '@/components/ui/toast' // WS6 T8: registration shows toasts
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push }) }))

function requestWithReason(reason: string) {
  return {
    id: 5, requesterName: 'Morgan Lee', reason, preferredProviderId: null,
    preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-10',
  } as unknown as BookingRequestRow
}

describe('ConfirmBookingRequestModal visit reason', () => {
  it('prefills a long multi-line public request reason normalized to at most 140 chars', () => {
    // Public booking requests allow up to 2000 chars; the confirm route caps visitReason at 140.
    const reason = 'I have had\n\nheadaches   for weeks. ' + 'More detail. '.repeat(40)
    render(<ConfirmBookingRequestModal request={requestWithReason(reason)} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    const input = screen.getByLabelText('Visit reason') as HTMLInputElement
    expect(input.value.startsWith('I have had headaches for weeks. More detail.')).toBe(true)
    expect(Array.from(input.value)).toHaveLength(140)
    expect(input.value.endsWith('…')).toBe(true)
    expect(input).toHaveAttribute('maxLength', '140')
  })

  it('prefills a short reason unchanged', () => {
    render(<ConfirmBookingRequestModal request={requestWithReason('New patient intake')} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Visit reason')).toHaveValue('New patient intake')
  })
})

// Wave C P0-04: the request is confirmed against a patient found by name/UHID/mobile.
describe('ConfirmBookingRequestModal patient', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('confirms against the patient picked in the PatientPicker', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ id: 'RD-0007', name: 'Morgan Lee', uhid: 'UH00000007', gender: null, ageYears: null }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response('{}', { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<ConfirmBookingRequestModal request={requestWithReason('New patient intake')} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'morgan' } })
    fireEvent.click(await screen.findByRole('option', { name: /morgan lee/i }))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: '1' } })
    await screen.findByLabelText('Start time (IST)') // WS6 T7: no working hours in this stub
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/booking-requests/5/confirm')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/booking-requests/5/confirm')!
    expect(JSON.parse(init!.body as string).patientId).toBe('RD-0007')
  })
})

// WS6 T7 (spec D5): the confirm date never defaults to the past, and the time comes from the slots.
describe('ConfirmBookingRequestModal date', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
  const ranged = (start: string, end: string) => ({ ...requestWithReason('Checkup'), preferredDateRangeStart: start, preferredDateRangeEnd: end }) as BookingRequestRow

  it('defaults to today when the requested range is past, with today as the minimum', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    render(<ConfirmBookingRequestModal request={ranged('2026-10-20', '2026-10-22')} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    const date = screen.getByLabelText('Appointment date')
    expect(date).toHaveValue('2026-10-23')
    expect(date).toHaveAttribute('min', '2026-10-23')
  })

  it('defaults to the start of a future range', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    render(<ConfirmBookingRequestModal request={ranged('2026-10-25', '2026-10-27')} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    expect(screen.getByLabelText('Appointment date')).toHaveValue('2026-10-25')
  })

  it('confirms the free slot picked for the preferred doctor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00+05:30`).toISOString()
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/providers/1/slots')
        ? new Response(JSON.stringify({ date: '2026-10-26', slotMinutes: 30, onLeave: false, slots: [{ startsAt: at('11:00'), endsAt: at('11:30'), status: 'free' }] }), { status: 200 })
        : new Response('{}', { status: 200 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const request = { ...ranged('2026-10-26', '2026-10-28'), patientId: 'RD-0042', preferredProviderId: 1 } as BookingRequestRow
    render(<ConfirmBookingRequestModal request={request} providers={[{ id: 1, name: 'Dr. Test' }]} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /11:00/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/booking-requests/5/confirm')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/booking-requests/5/confirm')!
    expect(JSON.parse(init!.body as string)).toMatchObject({ patientId: 'RD-0042', providerId: 1, startsAt: at('11:00'), endsAt: at('11:30') })
  })
})

// WS6 T7: a public request from someone with no chart is registered from the queue, then confirmed.
describe('Register from this request', () => {
  afterEach(() => { vi.unstubAllGlobals(); push.mockClear() })
  const publicRow = {
    id: 5, requesterName: 'Morgan Lee', requesterDob: '1985-06-20', requesterEmail: 'morgan@example.com', requesterPhone: '+919812345678',
    preferredProviderId: null, preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-10', reason: 'New patient intake',
    status: 'pending', submittedAt: new Date('2026-10-08T05:00:00Z'), reviewedByName: null, reviewedAt: null, declineReason: null,
    resultingAppointmentId: null, patientId: null, requestKind: 'new', appointmentId: null,
  } as BookingRequestRow

  it('is offered only for a request with no patient', () => {
    render(<BookingRequestsQueue canResolve providers={[]} requests={[publicRow, { ...publicRow, id: 6, patientId: 'RD-1' }]} />)
    expect(screen.getAllByRole('button', { name: 'Register from this request' })).toHaveLength(1)
  })

  it('opens registration prefilled from the request and, after saving, the confirm dialog with that patient', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
      if (url === '/api/patients' && init?.method === 'POST') return new Response(JSON.stringify({ id: 'RD-0099' }), { status: 201 })
      if (url === '/api/payers') return new Response('[]', { status: 200 })
      return new Response(JSON.stringify({ results: [], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ToastProvider><BookingRequestsQueue canResolve providers={[{ id: 1, name: 'Dr. Test' }]} requests={[publicRow]} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Register from this request' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Add New Patient')
    expect(screen.getByDisplayValue('Morgan Lee')).toBeInTheDocument()
    expect(screen.getByDisplayValue('1985-06-20')).toBeInTheDocument()
    expect(screen.getByDisplayValue('+919812345678')).toBeInTheDocument()
    // The rest of registration is filled by the front desk as usual, step by step (WS6 T8).
    fireEvent.change(screen.getByLabelText('Gender'), { target: { value: 'female' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.change(screen.getByLabelText('Address line 1'), { target: { value: '12 MG Road' } })
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Bengaluru' } })
    fireEvent.change(screen.getByLabelText('District'), { target: { value: 'Bengaluru Urban' } })
    fireEvent.change(screen.getByLabelText('State / UT'), { target: { value: 'IN-KA' } })
    fireEvent.change(screen.getByLabelText('PIN code'), { target: { value: '560001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByLabelText('ABHA not available'))
    fireEvent.change(screen.getByLabelText('Reason ABHA is not available'), { target: { value: 'not_created' } })
    fireEvent.click(screen.getByLabelText('Patient does not provide Aadhaar'))
    fireEvent.change(screen.getByLabelText('Reason for no Aadhaar'), { target: { value: 'patient_declined' } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Confirm Booking Request')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/api/patients' && i?.method === 'POST')!
    expect(JSON.parse(post[1]!.body as string)).toMatchObject({ name: 'Morgan Lee', dob: '1985-06-20', phone: '+919812345678', email: 'morgan@example.com' })
    // The new patient is already picked: no search box, their name shown.
    expect(screen.queryByRole('combobox', { name: /patient/i })).toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('Morgan Lee')
    expect(push).not.toHaveBeenCalled()
  })
})
