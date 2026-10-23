// WS2 T11: the workspace Procedures panel (search, order with quantity and notes, the visit's
// procedures with billing state, cancel).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ProceduresPanel } from '@/components/encounters/ProceduresPanel'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const PROCS = [
  { id: 31, name: 'Wound dressing', serviceCode: 'DRESS', performedOn: '2099-07-01', codingStatus: 'uncoded', status: 'active', notes: null, quantity: 1, taxablePaise: 50000, billing: 'billed' },
  { id: 32, name: 'Suturing', serviceCode: 'SUTURE', performedOn: '2099-07-01', codingStatus: 'coded', status: 'active', notes: null, quantity: null, taxablePaise: null, billing: 'not_billed' },
  { id: 33, name: 'Nebulisation', serviceCode: 'NEB', performedOn: '2099-07-01', codingStatus: 'uncoded', status: 'cancelled', notes: null, quantity: 1, taxablePaise: 20000, billing: 'void' },
]
const OPTIONS = [{ serviceId: 5, code: 'DRESS', name: 'Wound dressing', departmentName: 'Surgery', pricePaise: 50000 }, { serviceId: 6, code: 'PLAST', name: 'Plaster cast', departmentName: 'Ortho', pricePaise: null }]

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/encounters/9/procedures' && !init?.method) return new Response(JSON.stringify({ procedures: PROCS }), { status: 200 })
    if (url.startsWith('/api/encounters/9/procedure-options')) return new Response(JSON.stringify({ options: OPTIONS }), { status: 200 })
    if (url === '/api/encounters/9/procedures' && init?.method === 'POST') {
      return new Response(JSON.stringify({ procedureId: 34, charge: { ok: true, source: 'procedure', lineId: 7, itemName: 'Wound dressing', taxablePaise: 100000, billTo: 'self', existing: false } }), { status: 201 })
    }
    if (url === '/api/encounters/9/procedures/31' && init?.method === 'DELETE') return new Response(JSON.stringify({ ok: true, billing: 'credit_note_needed' }), { status: 200 })
    return new Response('{}', { status: 404 })
  })
}

describe('ProceduresPanel', () => {
  it('lists the procedures with billing state, read-only without write access', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<ProceduresPanel encounterId={9} canWrite={false} />)
    expect(await screen.findByText('Wound dressing')).toBeInTheDocument()
    expect(screen.getByText('₹500.00')).toBeInTheDocument()
    expect(screen.getByText('On the bill')).toBeInTheDocument()
    expect(screen.getByText('Not billed')).toBeInTheDocument()
    expect(screen.getByText('Charge voided')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Search procedures')).not.toBeInTheDocument()
  })

  it('searches, orders with quantity and notes, and shows the charge outcome', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<ProceduresPanel encounterId={9} canWrite />)
    fireEvent.change(screen.getByLabelText('Search procedures'), { target: { value: 'dress' } })
    expect(await screen.findByRole('option', { name: /Wound dressing.*₹500\.00/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Plaster cast.*no rate/ })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Procedure'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Left forearm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Order procedure' }))
    expect(await screen.findByText('Wound dressing ₹1,000.00 on the bill (self-pay)')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]!.body))).toEqual({ serviceId: 5, quantity: 2, notes: 'Left forearm' })
    expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/encounters/9/procedure-options?q=dress')).toBe(true)
  })

  it('shows a not-billed outcome with its reason', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ procedureId: 34, charge: { ok: false, source: 'procedure', reason: 'blocked', rules: ['deposit_below_threshold'] } }), { status: 201 })
      return mockFetch()(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ProceduresPanel encounterId={9} canWrite />)
    fireEvent.change(screen.getByLabelText('Search procedures'), { target: { value: 'dress' } })
    await screen.findByRole('option', { name: /Wound dressing/ })
    fireEvent.change(screen.getByLabelText('Procedure'), { target: { value: '5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Order procedure' }))
    expect(await screen.findByText('Procedure recorded, not billed: the admission deposit is below the threshold')).toBeInTheDocument()
  })

  it('cancels an uncoded procedure (no cancel on coded or cancelled ones) and reports a credit note', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<ProceduresPanel encounterId={9} canWrite />)
    await screen.findByText('Wound dressing')
    const cancels = screen.getAllByRole('button', { name: /^Cancel / })
    expect(cancels.map((b) => b.getAttribute('aria-label'))).toEqual(['Cancel Wound dressing'])
    fireEvent.click(cancels[0])
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/encounters/9/procedures/31' && i?.method === 'DELETE')).toBe(true))
    expect(await screen.findByText('Cancelled. The charge is on a finalised invoice: billing must issue a credit note.')).toBeInTheDocument()
  })
})
