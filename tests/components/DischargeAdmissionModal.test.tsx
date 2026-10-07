import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function mockFetch(body: unknown = { ok: true, followUpAppointmentId: null, followUpOrderId: null }): FetchMock {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function fillSummaryAndContinue() {
  for (const label of ['Diagnosis', 'Drugs', 'Devices', 'Diet', 'Discharge summary notes']) {
    fireEvent.change(screen.getByLabelText(label), { target: { value: `TEST ${label}` } })
  }
  fireEvent.click(screen.getByText('Next'))
}

function sign() {
  fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: 'Dr. Chen' } })
  fireEvent.click(screen.getByLabelText('Attestation'))
  fireEvent.click(screen.getByRole('button', { name: 'Discharge' }))
}

const sentBody = (m: FetchMock) => JSON.parse(m.mock.calls[0][1]!.body as string)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DischargeAdmissionModal', () => {
  it('sends followUp only when a reason is entered and builds an IST slot', async () => {
    const fetchMock = mockFetch({ ok: true, followUpAppointmentId: 9, followUpOrderId: 4 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    fillSummaryAndContinue()

    fireEvent.change(screen.getByLabelText('Follow-up in'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Follow-up unit'), { target: { value: 'weeks' } })
    fireEvent.change(screen.getByLabelText('Follow-up reason'), { target: { value: 'Wound check' } })
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2026-10-21' } })
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '10:00' } })
    sign()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/inpatient/admissions/7/discharge')
    const body = sentBody(fetchMock)
    expect(body.followUp).toEqual({ timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'Wound check' })
    expect(body.followUpStartsAt).toBe('2026-10-21T10:00:00+05:30')
    expect(body.followUpEndsAt).toBe('2026-10-21T10:30:00+05:30')
    expect(await screen.findByText(/follow-up appointment was scheduled/i)).toBeInTheDocument()
  })

  it('sends no followUp key without a reason, even with a number entered', async () => {
    const fetchMock = mockFetch()
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Follow-up in'), { target: { value: '3' } })
    sign()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const body = sentBody(fetchMock)
    expect(body).not.toHaveProperty('followUp')
    expect(body).not.toHaveProperty('followUpStartsAt')
  })

  it('sends an on-date plan', async () => {
    const fetchMock = mockFetch({ ok: true, followUpAppointmentId: null, followUpOrderId: 5 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Plan timing'), { target: { value: 'date' } })
    fireEvent.change(screen.getByLabelText('Follow-up on date'), { target: { value: '2026-11-02' } })
    fireEvent.change(screen.getByLabelText('Follow-up reason'), { target: { value: 'Review scans' } })
    sign()

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(sentBody(fetchMock).followUp).toEqual({ timing: { kind: 'date', dueDate: '2026-11-02' }, reason: 'Review scans' })
    expect(await screen.findByText(/follow-up plan was recorded/i)).toBeInTheDocument()
  })

  it('rejects a slot that would cross midnight without calling the API', async () => {
    const fetchMock = mockFetch()
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2026-10-21' } })
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '23:45' } })
    sign()

    expect(await screen.findByText(/must end by midnight/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
