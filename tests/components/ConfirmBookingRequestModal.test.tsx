import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/booking-requests/5/confirm')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/booking-requests/5/confirm')!
    expect(JSON.parse(init!.body as string).patientId).toBe('RD-0007')
  })
})
