// SP5 Task 9: the stage-based worklist and its role-gated actions.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { WorklistOrder } from '@/components/LabWorklist'
import { LabWorklist } from '@/components/LabWorklist'
import type { Role } from '@/lib/auth'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  refresh.mockClear()
})

let nextId = 1
function order(overrides: Partial<WorklistOrder> = {}): WorklistOrder {
  const id = nextId++
  return {
    id,
    status: 'ordered',
    orderedAt: new Date('2099-05-01T04:30:00Z'),
    collectedAt: null,
    receivedAt: null,
    verifiedAt: null,
    patientId: `RD-${id}`,
    patientName: `Patient ${id}`,
    patientUhid: `UH-${id}`,
    testId: 1,
    testName: 'Glucose, fasting',
    testCode: 'GLU',
    category: 'lab',
    attachments: [],
    orderedByProviderId: 1,
    orderedByProviderName: 'Dr. Test',
    sampleId: null,
    requisitionId: 10,
    homeCollectionVisitId: null,
    visitDate: null,
    result: null,
    ...overrides,
  }
}

const RESULTED = () => order({
  status: 'resulted', sampleId: 'L26100800429', collectedAt: new Date('2099-05-01T05:00:00Z'), receivedAt: new Date('2099-05-01T06:00:00Z'),
  result: { value: '182', unit: 'mg/dL', flag: 'abnormal', resultedByName: 'Lab Tech', amendedAt: null },
})
const ALL = () => [
  order({ status: 'ordered' }),
  order({ status: 'collected', sampleId: 'L26100800438', collectedAt: new Date('2099-05-01T05:00:00Z') }),
  order({ status: 'received', sampleId: 'L26100800440', collectedAt: new Date('2099-05-01T05:00:00Z'), receivedAt: new Date('2099-05-01T06:00:00Z') }),
  RESULTED(),
  order({ status: 'verified', testName: 'Verified test', verifiedAt: new Date('2099-05-01T08:00:00Z') }),
  order({ status: 'reported', testName: 'Reported test' }),
]
const renderAs = (role: Role, orders = ALL()) => render(<LabWorklist orders={orders} labTests={[]} role={role} />)

describe('LabWorklist stages', () => {
  it('renders every stage section in order, and verified/reported orders stay visible', () => {
    renderAs('admin')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.replace(/\s*\(\d+\)$/, ''))
    expect(headings).toEqual(['To collect', 'In transit', 'At the bench', 'To verify', 'To report', 'Reported'])
    expect(screen.getByText(/Verified test/)).toBeInTheDocument()
    expect(screen.getByText(/Reported test/)).toBeInTheDocument()
  })

  it('labs sees Receive and Enter result but not Verify', () => {
    renderAs('labs')
    expect(screen.getByLabelText('Scan or type sample ID')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enter result' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Amend' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('pi sees Verify on resulted rows and no receive box', () => {
    renderAs('pi')
    expect(screen.getByRole('button', { name: 'Verify' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Scan or type sample ID')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Enter result' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Amend' })).toBeNull()
    // pi still collects and cancels pre-result orders.
    expect(screen.getByRole('button', { name: 'Mark collected' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Cancel' }).length).toBe(3)
  })

  it('crc sees the stages with no action buttons', () => {
    renderAs('crc')
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByLabelText('Scan or type sample ID')).toBeNull()
  })

  it('a resulted row shows its value, unit, flag and "Awaiting verification"', () => {
    renderAs('admin', [RESULTED()])
    expect(screen.getByText(/182 mg\/dL/)).toBeInTheDocument()
    expect(screen.getByText('Abnormal')).toBeInTheDocument()
    expect(screen.getByText('Awaiting verification')).toBeInTheDocument()
    expect(screen.getByText(/L261008-0042-9/)).toBeInTheDocument()
  })

  it('a home-booked order shows its visit date and no Mark collected', () => {
    renderAs('admin', [order({ status: 'scheduled', homeCollectionVisitId: 5, visitDate: '2099-05-02' })])
    expect(screen.getByText(/Home visit 2 May 2099/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark collected' })).toBeNull()
  })

  it('groups To report by requisition', () => {
    renderAs('admin', [
      order({ status: 'verified', requisitionId: 21, testName: 'A test' }),
      order({ status: 'verified', requisitionId: 21, testName: 'B test' }),
      order({ status: 'verified', requisitionId: 22, testName: 'C test' }),
    ])
    expect(screen.getByText('Requisition #21')).toBeInTheDocument()
    expect(screen.getByText('Requisition #22')).toBeInTheDocument()
  })

  it('after Mark collected it shows the sample ID and a Print label link', async () => {
    const o = order({ status: 'ordered' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, sampleId: 'L26100800429' }), { status: 200 })))
    renderAs('labs', [o])
    fireEvent.click(screen.getByRole('button', { name: 'Mark collected' }))
    await waitFor(() => expect(screen.getByText(/L261008-0042-9/)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Print label' }).getAttribute('href')).toBe(`/lab-labels?orders=${o.id}`)
    expect(fetch).toHaveBeenCalledWith(`/api/lab-orders/${o.id}/collect`, { method: 'POST' })
  })

  it('Verify posts to the verify route and shows a refusal message', async () => {
    const o = RESULTED()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Results must be verified by someone other than the person who entered them.' }), { status: 409 })))
    renderAs('pi', [o])
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(screen.getByText(/someone other than the person/)).toBeInTheDocument())
    expect(fetch).toHaveBeenCalledWith(`/api/lab-orders/${o.id}/verify`, { method: 'POST' })
  })

  it('the receive box submits the scanned ID on Enter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ orderId: 3, sampleId: 'L26100800438' }), { status: 200 })))
    renderAs('labs')
    const input = screen.getByLabelText('Scan or type sample ID')
    fireEvent.change(input, { target: { value: 'L261008-0043-8' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/lab-orders/receive', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sampleId: 'L261008-0043-8' }) })))
    await waitFor(() => expect(screen.getByText(/Received L261008-0043-8/)).toBeInTheDocument())
  })
})
