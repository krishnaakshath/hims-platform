import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CheckInModal } from '@/components/CheckInModal'

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

  it('submits a check-in with the selected provider and visit type', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    fireEvent.click(screen.getByText('Check In'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init!.body as string)
    expect(body.patientId).toBe('RD-0001')
    expect(body.visitType).toBe('outpatient')

    vi.unstubAllGlobals()
  })

  it('allows submitting an inpatient check-in with no room selected when no rooms exist', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={[]} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Admission' } })

    expect(screen.getByText('Check In')).not.toBeDisabled()
  })

  it('disables submit for an inpatient visit when rooms exist but none is selected', () => {
    render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'RD-0001' } })
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Admission' } })

    expect(screen.getByText('Check In')).toBeDisabled()
  })

  describe('check-in ticket', () => {
    async function checkInSuccessfully(overrides?: { roomId?: number; patientId?: string; providerId?: number }) {
      const patientId = overrides?.patientId ?? 'RD-0001'
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
      }
      const fetchMock = vi.fn(async () => new Response(JSON.stringify(apiResponse), { status: 201 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<CheckInModal providers={PROVIDERS} rooms={ROOMS} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: patientId } })
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
      await waitFor(() => expect(screen.getByText(/42/)).toBeInTheDocument())
    })

    it('shows the patient name on the ticket', async () => {
      await checkInSuccessfully({ patientId: 'RD-0001' })
      await waitFor(() => expect(screen.getByText('RD-0001')).toBeInTheDocument())
    })

    it('shows the assigned room on the ticket for inpatient visits', async () => {
      await checkInSuccessfully({ roomId: 1 })
      await waitFor(() => expect(screen.getByText(/Ward A.*101.*A/)).toBeInTheDocument())
    })

    it('shows the current date on the ticket', async () => {
      await checkInSuccessfully()
      const today = new Date().toLocaleDateString()
      await waitFor(() => expect(screen.getByText(new RegExp(today.replace(/[/\\-]/g, '[/\\\\-]')))).toBeInTheDocument())
    })

    it('shows a Print button on the ticket', async () => {
      await checkInSuccessfully()
      await waitFor(() => expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument())
    })

    it('calls window.print when the Print button is clicked', async () => {
      await checkInSuccessfully()
      const printMock = vi.fn()
      vi.stubGlobal('print', printMock)

      await waitFor(() => expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /print/i }))
      expect(printMock).toHaveBeenCalledTimes(1)

      vi.unstubAllGlobals()
    })

    it('wraps the ticket in a printable div with id="print-ticket"', async () => {
      await checkInSuccessfully()
      await waitFor(() => expect(document.getElementById('print-ticket')).not.toBeNull())
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
