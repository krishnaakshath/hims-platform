import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NewEventModal } from '@/components/NewEventModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

describe('NewEventModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <NewEventModal
        providers={[{ id: 1, name: 'Dr. Test' }]}
        defaultDate="2026-09-25"
        onClose={onClose}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('caps the visit reason input at 140 characters', () => {
    render(
      <NewEventModal
        providers={[{ id: 1, name: 'Dr. Test' }]}
        defaultDate="2026-09-25"
        onClose={vi.fn()}
      />
    )
    expect(screen.getByPlaceholderText('Visit reason')).toHaveAttribute('maxLength', '140')
  })

  // Wave C P0-04: no full patient list in the page; the PatientPicker finds by name/UHID/mobile.
  it('books for the patient picked by name, UHID or mobile', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response('{}', { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-09-25" onClose={vi.fn()} />)
    expect(screen.queryByRole('option', { name: /select a patient/i })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: '98123' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    fireEvent.change(screen.getByLabelText(/doctor/i), { target: { value: '1' } })
    // WS6 T7: no working hours in this stub, so the time inputs appear once the slots load.
    await screen.findByLabelText('Start time (IST)')
    fireEvent.change(screen.getByPlaceholderText('Visit reason'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/appointments')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/appointments')!
    expect(JSON.parse(init!.body as string).patientId).toBe('RD-0001')
  })

  it('starts with a preselected patient (Book appointment from the patient page)', () => {
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-09-25" initialPatient={{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }} onClose={vi.fn()} />)
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /patient/i })).not.toBeInTheDocument()
  })

  // WS7 T6 (spec D20): In person / Video toggle; in person is the default.
  it('books in person by default and sends visitMode video when Video is chosen', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-09-25" initialPatient={{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }} onClose={vi.fn()} />)
    expect(screen.getByRole('radio', { name: 'In person' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Video' }))
    expect(screen.getByRole('radio', { name: 'Video' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.change(screen.getByLabelText(/doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByPlaceholderText('Visit reason'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/appointments')!
    expect(JSON.parse(init!.body as string).visitMode).toBe('video')
  })
})

// WS6 T7 (spec D5): no past default date; the time comes from the doctor's slots.
describe('NewEventModal date and slots', () => {
  afterEach(() => { vi.useRealTimers() })
  const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00+05:30`).toISOString()
  const SLOTS = { date: '2026-10-26', slotMinutes: 30, onLeave: false, slots: [
    { startsAt: at('09:00'), endsAt: at('09:30'), status: 'booked' },
    { startsAt: at('09:30'), endsAt: at('10:00'), status: 'free' },
  ] }

  it('never defaults to a past date and does not offer one', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-10-19" onClose={vi.fn()} />)
    const date = screen.getByLabelText('Appointment date')
    expect(date).toHaveValue('2026-10-23')
    expect(date).toHaveAttribute('min', '2026-10-23')
  })

  it('books the free slot picked for the chosen doctor', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/providers/1/slots') ? new Response(JSON.stringify(SLOTS), { status: 200 }) : new Response('{}', { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-10-26" initialPatient={{ id: 'RD-0001', name: 'Asha Rao', uhid: null }} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/doctor/i), { target: { value: '1' } })
    expect(await screen.findByRole('button', { name: /09:00.*booked/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /09:30/ }))
    fireEvent.change(screen.getByPlaceholderText('Visit reason'), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/appointments')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/appointments')!
    const body = JSON.parse(init!.body as string)
    expect(body).toMatchObject({ startsAt: at('09:30'), endsAt: at('10:00') })
    expect(body).not.toHaveProperty('outsideHoursConfirmed')
  })

  it('sends outsideHoursConfirmed for a confirmed time outside working hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T06:00:00Z'))
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/providers/1/slots') ? new Response(JSON.stringify(SLOTS), { status: 200 }) : new Response('{}', { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<NewEventModal providers={[{ id: 1, name: 'Dr. Test' }]} defaultDate="2026-10-26" initialPatient={{ id: 'RD-0001', name: 'Asha Rao', uhid: null }} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/doctor/i), { target: { value: '1' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Other time' }))
    fireEvent.change(screen.getByLabelText('Start time (IST)'), { target: { value: '17:00' } })
    fireEvent.change(screen.getByLabelText('End time (IST)'), { target: { value: '17:30' } })
    fireEvent.change(screen.getByPlaceholderText('Visit reason'), { target: { value: 'Review' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/outside working hours/i))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/appointments')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/appointments')!
    expect(JSON.parse(init!.body as string)).toMatchObject({ startsAt: '2026-10-26T17:00:00+05:30', endsAt: '2026-10-26T17:30:00+05:30', outsideHoursConfirmed: true })
  })
})
