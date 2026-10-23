import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

const ZERO_DUES = { chargesPaise: 0, payerChargesPaise: 0, insurerSharePaise: 0, paidPaise: 0, outstandingPaise: 0, creditPaise: 0 }
// WS3 T6: GET /api/inpatient/admissions/[id]/discharge-context (no diagnoses, no MAR drugs, no dues).
const EMPTY_CONTEXT = { diagnoses: [], medications: [], dues: ZERO_DUES, latestClearance: null, unpostedRoomRentDays: 0 }
const CODES = {
  codeSystem: { id: 1, version: '2019', isSample: false },
  hits: [{ id: 777, kind: 'icd10', code: 'A90', display: 'Dengue fever [classical dengue]', selectable: true, version: '2019', isSample: false }],
}

function mockFetch(body: unknown = { ok: true, followUpAppointmentId: null, followUpOrderId: null }, context: unknown = EMPTY_CONTEXT): FetchMock {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.endsWith('/discharge-context')) return new Response(JSON.stringify(context), { status: 200 })
    if (url.startsWith('/api/coding/codes')) return new Response(JSON.stringify(CODES), { status: 200 })
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The dues step loads, then Next opens the summary. */
async function passDues() {
  await screen.findByText('Outstanding')
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

async function fillSummaryAndContinue() {
  await passDues()
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

const posts = (m: FetchMock) => m.mock.calls.filter(([, init]) => init?.method === 'POST')
const sentBody = (m: FetchMock) => JSON.parse(posts(m)[0][1]!.body as string)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DischargeAdmissionModal', () => {
  it('sends followUp only when a reason is entered and builds an IST slot', async () => {
    const fetchMock = mockFetch({ ok: true, followUpAppointmentId: 9, followUpOrderId: 4 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await fillSummaryAndContinue()

    fireEvent.change(screen.getByLabelText('Follow-up in'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Follow-up unit'), { target: { value: 'weeks' } })
    fireEvent.change(screen.getByLabelText('Follow-up reason'), { target: { value: 'Wound check' } })
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2026-10-21' } })
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '10:00' } })
    sign()

    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    expect(posts(fetchMock)[0][0]).toBe('/api/inpatient/admissions/7/discharge')
    const body = sentBody(fetchMock)
    expect(body.followUp).toEqual({ timing: { kind: 'interval', interval: { value: 2, unit: 'weeks' } }, reason: 'Wound check' })
    expect(body.followUpStartsAt).toBe('2026-10-21T10:00:00+05:30')
    expect(body.followUpEndsAt).toBe('2026-10-21T10:30:00+05:30')
    expect(await screen.findByText(/follow-up appointment was scheduled/i)).toBeInTheDocument()
  })

  it('sends no followUp key without a reason, even with a number entered', async () => {
    const fetchMock = mockFetch()
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Follow-up in'), { target: { value: '3' } })
    sign()

    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    const body = sentBody(fetchMock)
    expect(body).not.toHaveProperty('followUp')
    expect(body).not.toHaveProperty('followUpStartsAt')
  })

  it('sends an on-date plan', async () => {
    const fetchMock = mockFetch({ ok: true, followUpAppointmentId: null, followUpOrderId: 5 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Plan timing'), { target: { value: 'date' } })
    fireEvent.change(screen.getByLabelText('Follow-up on date'), { target: { value: '2026-11-02' } })
    fireEvent.change(screen.getByLabelText('Follow-up reason'), { target: { value: 'Review scans' } })
    sign()

    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    expect(sentBody(fetchMock).followUp).toEqual({ timing: { kind: 'date', dueDate: '2026-11-02' }, reason: 'Review scans' })
    expect(await screen.findByText(/follow-up plan was recorded/i)).toBeInTheDocument()
  })

  it('rejects a slot that would cross midnight without calling the API', async () => {
    const fetchMock = mockFetch()
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await fillSummaryAndContinue()
    fireEvent.change(screen.getByLabelText('Follow-up date'), { target: { value: '2026-10-21' } })
    fireEvent.change(screen.getByLabelText('Follow-up time'), { target: { value: '23:45' } })
    sign()

    expect(await screen.findByText(/must end by midnight/i)).toBeInTheDocument()
    expect(posts(fetchMock)).toHaveLength(0)
  })
})

// WS3 T6: the dues step and the coded, MAR-prefilled summary (spec 3.2 items 13-14).
describe('DischargeAdmissionModal -- dues step and coded summary (WS3 T6)', () => {
  const CONTEXT = {
    diagnoses: [{ codeId: 501, code: 'K40.9', display: 'Unilateral inguinal hernia', type: 'provisional' }],
    medications: [
      { name: 'Paracetamol', dose: '650 mg', lastStatus: 'given' },
      { name: 'Ceftriaxone', dose: '1 g', lastStatus: 'scheduled' },
    ],
    dues: { chargesPaise: 12_500_00, payerChargesPaise: 0, insurerSharePaise: 0, paidPaise: 10_000_00, outstandingPaise: 2_500_00, creditPaise: 0 },
    latestClearance: null,
    unpostedRoomRentDays: 2,
  }

  it('opens on the dues step; outstanding dues without a clearance disable Next', async () => {
    const fetchMock = mockFetch(undefined, CONTEXT)
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    expect(await screen.findByText('Billing must clear or override dues before discharge')).toBeInTheDocument()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/inpatient/admissions/7/discharge-context')
    expect(screen.getByText('₹12,500.00')).toBeInTheDocument()
    expect(screen.getByText('₹10,000.00')).toBeInTheDocument()
    expect(screen.getByText('₹2,500.00')).toBeInTheDocument()
    expect(screen.getByText(/2 days of room rent are not posted yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  })

  it("a current override clearance lets the doctor continue", async () => {
    mockFetch(undefined, {
      ...CONTEXT,
      latestClearance: { id: 1, admissionId: 7, chargesPaise: 12_500_00, paidPaise: 10_000_00, insurerSharePaise: 0, outstandingPaise: 2_500_00, overrideReason: 'Employer pays monthly', clearedByName: 'Billing Desk', clearedByUserId: null, clearedAt: '2026-10-23T05:00:00.000Z' },
    })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    expect(await screen.findByText(/Cleared by Billing Desk/)).toBeInTheDocument()
    expect(screen.queryByText('Billing must clear or override dues before discharge')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  })

  it('prefills the drugs from the MAR and the diagnosis from the stay; picking an ICD-10 code fills the text and is sent', async () => {
    const fetchMock = mockFetch(undefined, { ...CONTEXT, dues: ZERO_DUES, unpostedRoomRentDays: 0 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await passDues()

    expect(screen.getByLabelText('Drugs')).toHaveValue('Paracetamol 650 mg\nCeftriaxone 1 g')
    expect(screen.getByLabelText('Diagnosis')).toHaveValue('Unilateral inguinal hernia')
    expect(screen.getByText('K40.9')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Discharge diagnosis (ICD-10)' }), { target: { value: 'dengue' } })
    fireEvent.click(await screen.findByRole('option', { name: /A90/ }))
    expect(screen.getByText('A90')).toBeInTheDocument()
    expect(screen.getByLabelText('Diagnosis')).toHaveValue('Unilateral inguinal hernia; Dengue fever [classical dengue]')

    for (const label of ['Devices', 'Diet', 'Discharge summary notes']) fireEvent.change(screen.getByLabelText(label), { target: { value: `TEST ${label}` } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    sign()
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    const body = sentBody(fetchMock)
    expect(body.diagnosisCodeIds).toEqual([501, 777])
    expect(body.dischargeDrugs).toBe('Paracetamol 650 mg\nCeftriaxone 1 g')
  })

  it('a removed code chip is not sent', async () => {
    const fetchMock = mockFetch(undefined, { ...CONTEXT, dues: ZERO_DUES, unpostedRoomRentDays: 0 })
    render(<DischargeAdmissionModal admissionId={7} onClose={vi.fn()} />)
    await passDues()
    fireEvent.click(screen.getByRole('button', { name: 'Remove K40.9' }))
    for (const label of ['Devices', 'Diet', 'Discharge summary notes']) fireEvent.change(screen.getByLabelText(label), { target: { value: `TEST ${label}` } })
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    sign()
    await waitFor(() => expect(posts(fetchMock)).toHaveLength(1))
    expect(sentBody(fetchMock)).not.toHaveProperty('diagnosisCodeIds')
  })
})
