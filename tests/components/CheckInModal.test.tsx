import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CheckInModal } from '@/components/CheckInModal'

// Wave C P0-04 / P1-14: the patient comes from the PatientPicker (name, UHID,
// mobile) and the ticket links to the printable token slip.
const ASHA = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const PROVIDERS = [{ id: 1, name: 'Dr. R. Kunam' }]

describe('CheckInModal', () => {
  it('does not show a room picker for an outpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/outpatient/i))
    expect(screen.queryByLabelText(/room/i)).not.toBeInTheDocument()
  })

  // WS3 T3: Inpatient no longer checks in -- it opens the admission dialog (spec 3.1 item 1).
  it('Inpatient opens the admission dialog for the picked patient, with no room select', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith('/api/inpatient/admissions/form-context') ? {
      patient: { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 34 },
      beds: [{ id: 5, label: 'Ward A 101-A', ward: 'Ward A', genderRestriction: null, roomCategoryName: null, tariffPaise: null, conflict: null }],
      policies: [], preauths: [], openOpdEncounter: null, activeAdmissionId: null, depositThresholdPaise: 0,
    } : {}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<CheckInModal providers={PROVIDERS} initialPatient={ASHA} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(await screen.findByRole('heading', { name: 'Admit patient' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Room' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/inpatient/admissions/form-context?patientId=RD-0001')).toBe(true)
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/front-desk/check-in')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('Inpatient without a patient asks for the patient first and cannot check in', () => {
    render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(screen.getByText(/pick the patient to open the admission form/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Room' })).not.toBeInTheDocument()
    expect(screen.getByText('Check In')).toBeDisabled()
  })

  it('finds the patient by UHID/name/mobile in the picker and checks in by chart id', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ ...ASHA, gender: 'female', ageYears: 34 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response(JSON.stringify({ id: 1 }), { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
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
    render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    expect(screen.getByText('Check In')).toBeDisabled()
  })

  it('starts with a preselected patient (quick path from the patient page)', () => {
    render(<CheckInModal providers={PROVIDERS} initialPatient={ASHA} onClose={vi.fn()} />)
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
  })

  describe('check-in ticket', () => {
    async function checkInSuccessfully(overrides?: { providerId?: number }) {
      const patientId = ASHA.id
      const providerId = overrides?.providerId ?? 1

      const apiResponse = {
        id: 1,
        queueTicketNumber: 42,
        patientId,
        providerId,
        visitType: 'outpatient',
        urgency: 'routine',
        reason: 'Follow-up',
        encounterId: 9,
        opdToken: 42,
      }
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(apiResponse), { status: 201 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<CheckInModal providers={PROVIDERS} initialPatient={ASHA} onClose={vi.fn()} />)

      fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: String(providerId) } })
      fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })

      fireEvent.click(screen.getByText('Check In'))
      // WS2 T9: the fee preview is fetched too; count the check-in POST only.
      await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/api/front-desk/check-in')).toHaveLength(1))

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

  // WS2 T9: automatic consultation and registration charges.
  describe('fees', () => {
    const PREVIEW = { registration: { itemName: 'Registration and UHID card', amountPaise: 10000 }, consultation: { itemName: 'Consultation - General Medicine', amountPaise: 60000 }, note: null }
    function stub(preview: unknown, checkIn: unknown = {}) {
      const fetchMock = vi.fn(async (url: string) => (
        url.startsWith('/api/front-desk/check-in/fee-preview')
          ? new Response(JSON.stringify(preview), { status: 200 })
          : new Response(JSON.stringify(checkIn), { status: 201 })
      ))
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }
    function fill() {
      render(<CheckInModal providers={PROVIDERS} initialPatient={ASHA} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: '1' } })
      fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Fever' } })
    }

    it('shows the consultation and first-visit registration fee before check-in', async () => {
      const fetchMock = stub(PREVIEW)
      fill()
      expect(await screen.findByText('Consultation ₹600 · Registration ₹100 (first visit)')).toBeInTheDocument()
      const url = fetchMock.mock.calls.map(([u]) => u).find((u) => u.startsWith('/api/front-desk/check-in/fee-preview'))!
      expect(url).toBe('/api/front-desk/check-in/fee-preview?patientId=RD-0001&providerId=1&visitType=outpatient&urgency=routine')
      vi.unstubAllGlobals()
    })

    it('says when the department has no consultation rate', async () => {
      stub({ registration: null, consultation: null, note: 'no_rate' })
      fill()
      expect(await screen.findByText(/no consultation rate is set/i)).toBeInTheDocument()
      vi.unstubAllGlobals()
    })

    it('after check-in lists the charges and links "Collect now" to the cash desk with the self-pay total', async () => {
      stub(PREVIEW, { id: 1, opdToken: 7, encounterId: 9, charges: [
        { ok: true, source: 'consultation', lineId: 3, itemName: 'Consultation - General Medicine', taxablePaise: 60000, billTo: 'self', existing: false },
        { ok: true, source: 'registration', lineId: 4, itemName: 'Registration and UHID card', taxablePaise: 10000, billTo: 'self', existing: false },
      ] })
      fill()
      await screen.findByText(/Consultation ₹600/)
      fireEvent.click(screen.getByText('Check In'))
      expect(await screen.findByText('Consultation - General Medicine')).toBeInTheDocument()
      expect(screen.getByText('Registration and UHID card')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /collect now/i })).toHaveAttribute('href', '/cash-desk?patientId=RD-0001&amountPaise=70000')
      vi.unstubAllGlobals()
    })

    it('after check-in says when a charge was not billed, with no "Collect now" for nothing', async () => {
      stub(PREVIEW, { id: 1, opdToken: 7, encounterId: 9, charges: [
        { ok: false, source: 'consultation', reason: 'price_unresolved', rules: ['price_unresolved'] },
      ] })
      fill()
      await screen.findByText(/Consultation ₹600/)
      fireEvent.click(screen.getByText('Check In'))
      expect(await screen.findByText(/consultation not billed: no rate/i)).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /collect now/i })).not.toBeInTheDocument()
      vi.unstubAllGlobals()
    })
  })

  describe('Reason field (patient-facing)', () => {
    const HINT = 'Shown to the patient in their visit confirmation — keep it brief and non-clinical.'
    it('shows a visible hint wired to the input via aria-describedby', () => {
      render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
      const hint = screen.getByText(HINT)
      expect(hint).toBeVisible()
      const input = screen.getByLabelText(/reason/i)
      expect(input).toHaveAttribute('aria-describedby', hint.id)
      expect(hint.id).not.toBe('')
    })
    it('caps the reason at 140 characters', () => {
      render(<CheckInModal providers={PROVIDERS} onClose={vi.fn()} />)
      expect(screen.getByLabelText(/reason/i)).toHaveAttribute('maxLength', '140')
    })
  })
})
