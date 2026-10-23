// WS2 T10: the workspace Orders panel (inline lab/imaging order form and the visit's orders).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { OrdersPanel } from '@/components/encounters/OrdersPanel'
import type { LabTestOption } from '@/components/OrderLabTestModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const TESTS: LabTestOption[] = [
  { id: 1, name: 'Complete Blood Count', code: 'CBC', defaultUnit: null, referenceRange: null, category: 'lab', serviceId: 1, isActive: true, priced: true, pricePaise: 45000 },
  { id: 2, name: 'Chest X-Ray', code: 'XR', defaultUnit: null, referenceRange: null, category: 'imaging', serviceId: 1, isActive: true, priced: true, pricePaise: 90000 },
]
const ORDERS = [
  { id: 41, requisitionId: 7, testName: 'Complete Blood Count', testCode: 'CBC', category: 'lab', status: 'ordered', priority: 'stat', fastingRequired: false, orderedAt: '2099-07-01T06:00:00Z', quotedPricePaise: 45000, billing: 'billed' },
  { id: 42, requisitionId: 7, testName: 'Lipid Panel', testCode: 'LIPID', category: 'lab', status: 'cancelled', priority: 'routine', fastingRequired: true, orderedAt: '2099-07-01T06:00:00Z', quotedPricePaise: 55000, billing: 'void' },
]

function mockFetch() {
  let listed = 0
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/patients/RD-1/lab-orders?encounterId=9' && !init?.method) {
      listed++
      return new Response(JSON.stringify({ orders: listed === 1 ? ORDERS : [...ORDERS, { ...ORDERS[0], id: 43, testName: 'Chest X-Ray', category: 'imaging', priority: 'routine', quotedPricePaise: 90000 }], billTo: 'self' }), { status: 200 })
    }
    if (url === '/api/patients/RD-1/lab-orders' && init?.method === 'POST') {
      return new Response(JSON.stringify({ requisitionId: 8, lines: [{ orderId: 43, labTestId: 2 }], patientIsLocal: false, homeCollectionEligible: false, notification: null,
        charges: [{ ok: true, source: 'lab_order', lineId: 5, itemName: 'Chest X-Ray', taxablePaise: 90000, billTo: 'self', existing: false }] }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  })
  return fn
}

describe('OrdersPanel', () => {
  it('lists the visit\'s orders with status, priority, price and billing, read-only without write access', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<OrdersPanel encounterId={9} patientId="RD-1" labTests={TESTS} canWrite={false} />)
    expect(await screen.findByText('Complete Blood Count')).toBeInTheDocument()
    expect(screen.getByText('STAT')).toBeInTheDocument()
    expect(screen.getByText('₹450.00')).toBeInTheDocument()
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('Charge voided')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Imaging' })).not.toBeInTheDocument()
  })

  it('orders from the imaging tab with the visit id, shows the outcome and reloads the list', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<OrdersPanel encounterId={9} patientId="RD-1" labTests={TESTS} canWrite />)
    await screen.findByText('Lipid Panel')
    expect(screen.getByText('Billed to: Self')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Imaging' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /chest x-ray/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/patients/RD-1/lab-orders' && (i as RequestInit | undefined)?.method === 'POST')).toBe(true))
    const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')!
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ labTestIds: [2], originatingEncounterId: 9 })
    expect(await screen.findByText(/Chest X-Ray ₹900.00 on the bill \(self-pay\)/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText('Chest X-Ray').length).toBeGreaterThan(0))
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u).includes('encounterId=9') && !(i as RequestInit | undefined)?.method)).toHaveLength(2)
  })
})
