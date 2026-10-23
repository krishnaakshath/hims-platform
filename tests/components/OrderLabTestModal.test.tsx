import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { OrderLabTestModal, type LabTestOption } from '@/components/OrderLabTestModal'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const TESTS: LabTestOption[] = [
  { id: 1, name: 'Complete Blood Count', code: 'CBC', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 1, isActive: true, priced: true },
  { id: 2, name: 'Chest X-Ray, 2 Views', code: 'XR-CHEST-2V', defaultUnit: null, referenceRange: null, category: 'imaging', serviceId: 1, isActive: true, priced: true },
  { id: 3, name: 'Lipid Panel', code: 'LIPID', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 1, isActive: true, priced: true },
]

const created = (patientIsLocal: boolean) =>
  vi.fn(async () => new Response(JSON.stringify({ requisitionId: 12, lines: [], patientIsLocal, notification: null }), { status: 201 }))

describe('OrderLabTestModal', () => {
  it('posts the checked tests and the follow-up request', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    const submit = screen.getByRole('button', { name: /order 0 tests|order tests/i })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /ask for a follow-up visit after the report/i }))
    fireEvent.change(screen.getByLabelText(/^follow-up after$/i), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: 'weeks' } })
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: /order 2 tests/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/lab-orders')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ labTestIds: [1, 3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review' }, priority: 'routine', fastingRequired: false })
  })

  it('sends followUp null when no follow-up is asked for, and says home collection is available', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ labTestIds: [1], followUp: null, priority: 'routine', fastingRequired: false })
    expect(await screen.findByText('Home collection available for this patient')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('tells staff when the patient is outside the home-collection area', async () => {
    vi.stubGlobal('fetch', created(false))
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByText('Patient is outside the home-collection area: walk-in only')).toBeInTheDocument()
  })

  it('does not offer home collection for an imaging-only order, even for a local patient', async () => {
    vi.stubGlobal('fetch', created(true))
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /chest x-ray/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByText('Tests ordered.')).toBeInTheDocument()
    expect(screen.queryByText('Home collection available for this patient')).not.toBeInTheDocument()
    expect(screen.queryByText(/walk-in only/)).not.toBeInTheDocument()
  })

  it('refuses a follow-up without a reason before posting', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /ask for a follow-up visit after the report/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/reason/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the server error and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Lab test not found' }), { status: 404 })))
    const onClose = vi.fn()
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={onClose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Lab test not found')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('OrderLabTestModal price gate (Foundations T10)', () => {
  it('greys out an unmapped test with "No price: ask billing"', () => {
    render(<OrderLabTestModal patientId="P1" labTests={[
      { id: 1, name: 'Mapped test', code: 'M1', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 5, isActive: true, priced: true },
      { id: 2, name: 'Unmapped test', code: 'U1', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: null, isActive: true, priced: false },
    ]} onClose={() => {}} />)
    expect(screen.getByText('No price: ask billing')).toBeInTheDocument()
    expect(screen.getByLabelText(/Unmapped test/)).toBeDisabled()
    expect(screen.getByLabelText(/Mapped test/)).not.toBeDisabled()
  })

  it('greys a mapped-but-unpriced test and an inactive test', () => {
    render(<OrderLabTestModal patientId="P1" labTests={[
      { id: 1, name: 'No rate test', code: 'N1', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 5, isActive: true, priced: false },
      { id: 2, name: 'Inactive test', code: 'I1', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 5, isActive: false, priced: true },
    ]} onClose={() => {}} />)
    expect(screen.getByLabelText(/No rate test/)).toBeDisabled()
    expect(screen.getByLabelText(/Inactive test/)).toBeDisabled()
    expect(screen.getAllByText('No price: ask billing')).toHaveLength(1)
  })
})

// WS2 T10: priority, notes, fasting, prices, bill-to and booking the home collection from the order.
describe('OrderLabTestModal order details (WS2 T10)', () => {
  const PRICED: LabTestOption[] = [
    { id: 1, name: 'Complete Blood Count', code: 'CBC', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 1, isActive: true, priced: true, pricePaise: 45000 },
    { id: 3, name: 'Lipid Panel', code: 'LIPID', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 1, isActive: true, priced: true, pricePaise: 55050, fastingRequired: true },
    { id: 2, name: 'Chest X-Ray, 2 Views', code: 'XR-CHEST-2V', defaultUnit: null, referenceRange: null, category: 'imaging', serviceId: 1, isActive: true, priced: true, pricePaise: 90000 },
  ]
  const placed = (over: Record<string, unknown> = {}) => vi.fn(async (url: string) => {
    if (url === '/api/patients/RD-0001/lab-orders') {
      return new Response(JSON.stringify({
        requisitionId: 12, lines: [{ orderId: 41, labTestId: 1 }, { orderId: 42, labTestId: 3 }], patientIsLocal: true, homeCollectionEligible: true, notification: null,
        charges: [
          { ok: true, source: 'lab_order', lineId: 1, itemName: 'CBC', taxablePaise: 45000, billTo: 'self', existing: false },
          { ok: false, source: 'lab_order', reason: 'no_context' },
        ],
        ...over,
      }), { status: 201 })
    }
    if (url.startsWith('/api/home-collections/context')) {
      return new Response(JSON.stringify({
        patient: { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH-000042', phone: '+919845013210', addressLine1: '12 MG Road', addressLine2: null, city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001', notificationOptOut: false },
        isLocal: true,
        bookableOrders: [
          { id: 40, testName: 'Older test', sampleType: 'serum', container: 'sst_gold' },
          { id: 41, testName: 'Complete Blood Count', sampleType: 'blood', container: 'edta_lavender' },
          { id: 42, testName: 'Lipid Panel', sampleType: 'serum', container: 'sst_gold' },
        ],
        bookableOrderCount: 3, activeVisits: [],
      }), { status: 200 })
    }
    if (url.startsWith('/api/home-collections/availability')) return new Response('[]', { status: 200 })
    return new Response('{}', { status: 404 })
  })

  it('shows each test\'s price, the total and who is billed', () => {
    render(<OrderLabTestModal patientId="RD-0001" labTests={PRICED} billTo="payer" onClose={vi.fn()} />)
    expect(screen.getByText('₹450.00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    expect(screen.getByText('Total ₹1,000.50')).toBeInTheDocument()
    expect(screen.getByText('Billed to: Insurer')).toBeInTheDocument()
  })

  it('pre-ticks fasting when a selected test needs it, and sends priority, notes, fasting and the visit', async () => {
    const fetchMock = placed()
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={PRICED} originatingEncounterId={88} onClose={vi.fn()} />)
    const fasting = screen.getByRole('checkbox', { name: /fasting required/i })
    expect(fasting).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    expect(fasting).toBeChecked()
    fireEvent.change(screen.getByLabelText(/^priority$/i), { target: { value: 'stat' } })
    fireEvent.change(screen.getByLabelText(/clinical notes/i), { target: { value: 'Chest pain' } })
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ labTestIds: [3], followUp: null, priority: 'stat', fastingRequired: true, clinicalNotes: 'Chest pain', originatingEncounterId: 88 })
  })

  it('after ordering: the billed lines, and "Book home collection" opens the booking with the ordered tests ticked', async () => {
    vi.stubGlobal('fetch', placed())
    render(<OrderLabTestModal patientId="RD-0001" labTests={PRICED} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 2 tests/i }))
    expect(await screen.findByText('Tests ordered.')).toBeInTheDocument()
    expect(screen.getByText(/CBC ₹450.00 on the bill \(self-pay\)/)).toBeInTheDocument()
    expect(screen.getByText(/1 test not billed: no visit or stay to bill/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /book home collection/i }))
    expect(await screen.findByText('New home collection')).toBeInTheDocument()
    await screen.findByText(/Asha Rao/)
    expect(screen.getByRole('checkbox', { name: /older test/i })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^complete blood count/i })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^lipid panel/i })).toBeChecked()
  })

  it('offers no booking when the order is not eligible', async () => {
    vi.stubGlobal('fetch', placed({ homeCollectionEligible: false }))
    render(<OrderLabTestModal patientId="RD-0001" labTests={PRICED} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByText('Tests ordered.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /book home collection/i })).not.toBeInTheDocument()
  })
})
