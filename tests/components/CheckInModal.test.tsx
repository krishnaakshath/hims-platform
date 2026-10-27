import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CheckInModal } from '@/components/CheckInModal'
import { ToastProvider } from '@/components/ui/toast'

// Wave C P0-04 / P1-14: the patient comes from the PatientPicker (name, UHID,
// mobile) and the ticket links to the printable token slip.
const ASHA = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

// WS6 T9: doctors come grouped by clinical department; the department select narrows them.
const DEPARTMENTS = [{ id: 10, name: 'General Medicine' }, { id: 11, name: 'Orthopaedics' }]
const PROVIDERS = [
  { id: 1, name: 'Dr. R. Kunam', departmentId: 10 },
  { id: 2, name: 'Dr. S. Hegde', departmentId: 10 },
  { id: 4, name: 'Dr. N. Rao', departmentId: 10 },
  { id: 3, name: 'Dr. P. Bone', departmentId: 11 },
]
const SUMMARY = {
  providers: [
    { providerId: 1, departmentId: 10, waiting: 3, inConsultation: 1, estimatedWaitMinutes: 30, availability: 'available' },
    { providerId: 2, departmentId: 10, waiting: 0, inConsultation: 0, estimatedWaitMinutes: null, availability: 'on_leave' },
    { providerId: 4, departmentId: 10, waiting: 0, inConsultation: 0, estimatedWaitMinutes: null, availability: 'outside_hours' },
    { providerId: 3, departmentId: 11, waiting: 0, inConsultation: 0, estimatedWaitMinutes: 0, availability: 'available' },
  ],
}
const render = (ui: ReactElement) => rtlRender(<ToastProvider>{ui}</ToastProvider>)
const summaryResponse = () => new Response(JSON.stringify(SUMMARY), { status: 200 })
/** Chooses the doctor's department, then the doctor. */
function pickDoctor(id: number) {
  const doctor = PROVIDERS.find((p) => p.id === id)!
  fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: String(doctor.departmentId) } })
  fireEvent.change(screen.getByLabelText(/assign to doctor/i), { target: { value: String(id) } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/api/front-desk/queue-summary' ? summaryResponse() : new Response('{}', { status: 404 }))))
})
afterEach(() => { vi.unstubAllGlobals() })

describe('CheckInModal', () => {
  it('does not show a room picker for an outpatient visit', () => {
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
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
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(await screen.findByRole('heading', { name: 'Admit patient' })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Room' })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/inpatient/admissions/form-context?patientId=RD-0001')).toBe(true)
    expect(fetchMock.mock.calls.some(([u]) => u === '/api/front-desk/check-in')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('Inpatient without a patient asks for the patient first and cannot check in', () => {
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/inpatient/i))
    expect(screen.getByText(/pick the patient to open the admission form/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Room' })).not.toBeInTheDocument()
    expect(screen.getByText('Check In')).toBeDisabled()
  })

  it('finds the patient by UHID/name/mobile in the picker and checks in by chart id', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ ...ASHA, gender: 'female', ageYears: 34 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : url === '/api/front-desk/queue-summary' ? summaryResponse()
          : new Response(JSON.stringify({ id: 1 }), { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)

    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'UH0000' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    pickDoctor(1)
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    fireEvent.click(screen.getByText('Check In'))

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/front-desk/check-in')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/front-desk/check-in')!
    const body = JSON.parse(init!.body as string)
    expect(body.patientId).toBe('RD-0001')
    expect(body.visitType).toBe('outpatient')

  })

  it('cannot submit until a patient is picked', () => {
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
    pickDoctor(1)
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Follow-up' } })
    expect(screen.getByText('Check In')).toBeDisabled()
  })

  it('starts with a preselected patient (quick path from the patient page)', () => {
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
  })

  describe('department and queue length (WS6 T9)', () => {
    it('lists no doctor until a department is chosen, then only that department\'s doctors', async () => {
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
      const doctor = screen.getByLabelText(/assign to doctor/i) as HTMLSelectElement
      expect(doctor).toBeDisabled()
      expect(within(screen.getByLabelText(/^department$/i)).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a department…', 'General Medicine', 'Orthopaedics'])
      fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: '10' } })
      expect(doctor).toBeEnabled()
      const names = within(doctor).getAllByRole('option').map((o) => o.textContent ?? '')
      expect(names.some((n) => n.includes('Dr. R. Kunam'))).toBe(true)
      expect(names.some((n) => n.includes('Dr. P. Bone'))).toBe(false)
    })

    it('shows each doctor\'s queue length and wait, or that they are on leave or outside hours', async () => {
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: '10' } })
      const doctor = screen.getByLabelText(/assign to doctor/i)
      expect(await within(doctor).findByRole('option', { name: 'Dr. R. Kunam — 3 waiting · ~30 min' })).toBeInTheDocument()
      expect(within(doctor).getByRole('option', { name: 'Dr. S. Hegde — On leave' })).toBeInTheDocument()
      expect(within(doctor).getByRole('option', { name: 'Dr. N. Rao — Outside hours' })).toBeInTheDocument()
      fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: '11' } })
      expect(within(doctor).getByRole('option', { name: 'Dr. P. Bone — No one waiting' })).toBeInTheDocument()
    })

    it('clears the chosen doctor when the department changes', () => {
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)
      pickDoctor(1)
      fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Fever' } })
      expect(screen.getByText('Check In')).toBeEnabled()
      fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: '11' } })
      expect((screen.getByLabelText(/assign to doctor/i) as HTMLSelectElement).value).toBe('')
      expect(screen.getByText('Check In')).toBeDisabled()
    })

    it('still lists the doctors by name when the queue summary cannot be loaded', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
      fireEvent.change(screen.getByLabelText(/^department$/i), { target: { value: '10' } })
      await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
      expect(within(screen.getByLabelText(/assign to doctor/i)).getByRole('option', { name: 'Dr. R. Kunam' })).toBeInTheDocument()
    })
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
      const fetchMock = vi.fn(async (url: string) => (url === '/api/front-desk/queue-summary' ? summaryResponse() : new Response(JSON.stringify(apiResponse), { status: 201 })))
      vi.stubGlobal('fetch', fetchMock)

      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)

      pickDoctor(providerId)
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

    it('announces the token in a toast with a link to print the slip', async () => {
      await checkInSuccessfully()
      const toast = (await screen.findByText('Token 42 issued')).closest('[role="status"]') as HTMLElement
      // The open dialog marks the toast region aria-hidden, so find the link by its text.
      expect(within(toast).getByText('Print token slip').closest('a')).toHaveAttribute('href', '/print/token/9')
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
      await screen.findByText('Token 42 issued')
      const link = within(screen.getByRole('dialog')).getByRole('link', { name: /print token slip/i })
      expect(link).toHaveAttribute('href', '/print/token/9')
      expect(link).toHaveAttribute('target', '_blank')
      fireEvent.click(link)
      expect(printMock).not.toHaveBeenCalled()
      expect(document.getElementById('print-ticket')).toBeNull()
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
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)
      pickDoctor(1) // WS6 T9: department first, then the doctor
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
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
      const hint = screen.getByText(HINT)
      expect(hint).toBeVisible()
      const input = screen.getByLabelText(/reason/i)
      expect(input).toHaveAttribute('aria-describedby', hint.id)
      expect(hint.id).not.toBe('')
    })
    it('caps the reason at 140 characters', () => {
      render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} onClose={vi.fn()} />)
      expect(screen.getByLabelText(/reason/i)).toHaveAttribute('maxLength', '140')
    })
  })

  // WS12 T9: the chosen patient's cover as a badge; OPD check-in never blocks on it.
  it('shows the chosen patient\'s cover at check-in and still allows checking in', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/patients/RD-0001/coverage?context=opd_checkin') return new Response(JSON.stringify({ primary: { verdict: { state: 'policy_expired', severity: 'warn', label: 'Policy expired', detail: 'Fix the policy dates or status, or treat as self-pay', verifiedHoursAgo: null, isMock: false, policyId: 7, verificationId: null } }, policies: [] }), { status: 200 })
      if (url === '/api/front-desk/queue-summary') return summaryResponse()
      return new Response('{}', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<CheckInModal providers={PROVIDERS} departments={DEPARTMENTS} initialPatient={ASHA} onClose={vi.fn()} />)
    expect(await screen.findByText('Policy expired')).toBeInTheDocument()
    pickDoctor(1)
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Fever' } })
    expect(screen.getByText('Check In')).toBeEnabled()
  })
})
