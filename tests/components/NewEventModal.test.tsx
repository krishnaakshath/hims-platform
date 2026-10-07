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
})
