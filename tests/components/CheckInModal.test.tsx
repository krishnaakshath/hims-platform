import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CheckInModal } from '@/components/CheckInModal'

// Wave C P0-04 / P1-14: the patient comes from the PatientPicker (name, UHID,
// mobile) and the ticket links to the printable token slip.
const ASHA = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const PROVIDERS = [{ id: 1, name: 'Dr. R. Kunam' }]
const ROOMS = [{ id: 1, ward: 'Ward A', roomNumber: '101', bedNumber: 'A' }]

describe('CheckInModal', () => {
  it('does not show a room picker for an outpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/outpatient/i))
    expect(screen.queryByLabelText(/room/i)).not.toBeInTheDocument()
  })

  it('shows a room picker for an inpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(screen.getByLabelText(/room/i)).toBeInTheDocument()
  })

  it('finds the patient by UHID/name/mobile in the picker and checks in by chart id', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ ...ASHA, gender: 'female', ageYears: 34 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response(JSON.stringify({ id: 1 }), { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'UH0000' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    fireEvent.click(screen.getByText('Check In'))

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/front-desk/check-in')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/front-desk/check-in')!
    const body = JSON.parse(init!.body as string)
    expect(body.patientId).toBe('RD-0001')
    expect(body.visitType).toBe('outpatient')

    vi.unstubAllGlobals()
  })

  it('cannot submit until a patient is picked', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    expect(screen.getByText('Check In')).toBeDisabled()
  })

  it('starts with a preselected patient (quick path from the patient page)', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} initialPatient={ASHA} onClose={vi.fn()} />)
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
  })

  it('allows submitting an inpatient check-in with no room selected when no rooms exist', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={[]} initialPatient={ASHA} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Admission' } })

    expect(screen.getByText('Check In')).not.toBeDisabled()
  })

  it('disables submit for an inpatient visit when rooms exist but none is selected', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} initialPatient={ASHA} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Admission' } })

    expect(screen.getByText('Check In')).toBeDisabled()
  })

  describe('check-in ticket', () => {
    async function checkInSuccessfully(overrides?: { roomId?: number; providerId?: number }) {
      const patientId = ASHA.id
      const providerId = overrides?.providerId ?? 1
      const roomId = overrides?.roomId

      const apiResponse = {
        id: 1,
        queueTicketNumber: 42,
        patientId,
        providerId,
        visitType: roomId ? 'inpatient' : 'outpatient',
        urgency: 'routine',
        reason: 'Follow-up',
        roomId: roomId ?? null,
        encounterId: 9,
        opdToken: 42,
      }
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(apiResponse), { status: 201 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} initialPatient={ASHA} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: String(providerId) } })
      fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })

      if (roomId) {
        fireEvent.click(screen.getByLabelText(/inpatient/i))
        fireEvent.change(screen.getByLabelText(/room/i), { target: { value: String(roomId) } })
      }

      fireEvent.click(screen.getByText('Check In'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

      return { fetchMock }
    }

    it('shows the queue number on the ticket after a successful check-in', async () => {
      await checkInSuccessfully()
      await waitFor(() => expect(screen.getByText('42')).toBeInTheDocument())
    })

    it('shows the patient name and UHID on the ticket, not only the chart id', async () => {
      await checkInSuccessfully()
      await waitFor(() => expect(screen.getByText('Asha Rao')).toBeInTheDocument())
      expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
    })

    it('shows the assigned room on the ticket for inpatient visits', async () => {
      await checkInSuccessfully({ roomId: 1 })
      await waitFor(() => expect(screen.getByText(/Ward A.*101.*A/)).toBeInTheDocument())
    })

    it('links to the printable token slip instead of printing the whole page', async () => {
      await checkInSuccessfully()
      const printMock = vi.fn()
      vi.stubGlobal('print', printMock)
      const link = await screen.findByRole('link', { name: /print token slip/i })
      expect(link).toHaveAttribute('href', '/print/token/9')
      expect(link).toHaveAttribute('target', '_blank')
      fireEvent.click(link)
      expect(printMock).not.toHaveBeenCalled()
      expect(document.getElementById('print-ticket')).toBeNull()
      vi.unstubAllGlobals()
    })
  })

  describe('Reason field (patient-facing)', () => {
    const HINT = 'Shown to the patient in their visit confirmation — keep it brief and non-clinical.'
    it('shows a visible hint wired to the input via aria-describedby', () => {
      render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
      const hint = screen.getByText(HINT)
      expect(hint).toBeVisible()
      const input = screen.getByLabelText(/reason/i)
      expect(input).toHaveAttribute('aria-describedby', hint.id)
      expect(hint.id).not.toBe('')
    })
    it('caps the reason at 140 characters', () => {
      render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
      expect(screen.getByLabelText(/reason/i)).toHaveAttribute('maxLength', '140')
    })
  })
})
