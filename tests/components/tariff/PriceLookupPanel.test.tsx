import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PriceLookupPanel } from '@/components/tariff/PriceLookupPanel'

type Handler = (url: string) => Response
function stubFetch(handler: Handler) {
  const fn = vi.fn(async (input: RequestInfo | URL) => handler(String(input)))
  vi.stubGlobal('fetch', fn)
  return fn
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const SERVICES = { services: [{ id: 9, code: 'CONS-GEN', name: 'General consultation', departmentName: 'General Medicine' }] }
const ROOMS = { roomCategories: [{ id: 1, code: 'GENERAL', name: 'General ward' }] }
const DEPTS = [{ id: 3, code: 'CARD', name: 'Cardiology', isActive: true }, { id: 4, code: 'GEN', name: 'General Medicine', isActive: true }]
const row = (over: Record<string, unknown>) => ({ rateId: 1, scope: 'base', departmentId: null, departmentName: null, payerId: null, payerName: null, roomCategoryCode: null, roomCategoryName: null, ward: null, amountPaise: 50000, formatted: '₹500.00', validFrom: '2026-01-01', validTo: null, ...over })
const SHEET = {
  service: { id: 9, code: 'CONS-GEN', name: 'General consultation', departmentName: 'General Medicine', gstRateBp: 1800, hsnSac: '999312' },
  onDate: '2026-10-08',
  rows: [
    row({ rateId: 1 }),
    row({ rateId: 2, roomCategoryCode: 'GENERAL', roomCategoryName: 'General ward', amountPaise: 70000, formatted: '₹700.00' }),
    row({ rateId: 3, ward: 'icu', amountPaise: 150000, formatted: '₹1,500.00', validTo: '2026-12-31' }),
    row({ rateId: 4, scope: 'department', departmentId: 3, departmentName: 'Cardiology', amountPaise: 60000, formatted: '₹600.00' }),
    row({ rateId: 5, scope: 'payer', payerId: 7, payerName: 'Star Health', amountPaise: 45000, formatted: '₹450.00' }),
  ],
  payers: [{ id: 7, name: 'Star Health' }],
  departments: [{ id: 3, name: 'Cardiology' }],
  wards: ['icu'],
}
const RESOLVED = { ok: true, serviceId: 9, serviceCode: 'CONS-GEN', serviceName: 'General consultation', amountPaise: 50000, gstRateBp: 1800, hsnSac: '999312', scope: 'base', matched: { roomCategory: 'GENERAL', ward: null }, formatted: '₹500.00' }

/** The common routes; `extra` answers first. */
function routes(extra?: (url: string) => Response | undefined): Handler {
  return (url) => {
    const r = extra?.(url)
    if (r) return r
    if (url.includes('/price-sheet')) return json(SHEET)
    if (url.startsWith('/api/tariff/services')) return json(SERVICES)
    if (url.startsWith('/api/tariff/room-categories')) return json(ROOMS)
    if (url.startsWith('/api/departments')) return json(DEPTS)
    if (url.startsWith('/api/tariff/resolve')) return json(RESOLVED)
    return json({}, 404)
  }
}

afterEach(() => vi.unstubAllGlobals())

async function pickService() {
  fireEvent.change(screen.getByLabelText(/service/i, { selector: 'input' }), { target: { value: 'cons' } })
  fireEvent.click(await screen.findByRole('option', { name: /general consultation/i }))
}

// Wave B P1-05: the price lookup UI for TARIFF_LOOKUP_ROLES.
describe('PriceLookupPanel', () => {
  it('searches services, resolves the price for the chosen date and room category, and shows it', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    fireEvent.change(await screen.findByLabelText(/room category/i), { target: { value: 'GENERAL' } })
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('₹500.00'))
    expect(screen.getByRole('status')).toHaveTextContent(/GST 18%/)
    const resolveUrl = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/tariff/resolve'))!
    const params = new URLSearchParams(resolveUrl.split('?')[1])
    expect(Object.fromEntries(params)).toEqual({ serviceId: '9', onDate: '2026-10-08', roomCategory: 'GENERAL' })
  })

  it('explains when no rate applies', async () => {
    stubFetch(routes((url) => (url.startsWith('/api/tariff/resolve') ? json({ ok: false, reason: 'no_rate' }) : undefined)))
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/no price is set/i))
  })

  it('shows an error when the lookup fails (never server internals)', async () => {
    stubFetch(routes((url) => (url.startsWith('/api/tariff/resolve') ? json({ error: 'boom: relation x' }, 500) : undefined)))
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i))
    expect(screen.getByRole('alert')).not.toHaveTextContent(/relation/)
  })

  // Wave G P1-05: the rate card and the payer / department / ward filters.
  it('shows the rate card for the chosen service and date, by scope, room and ward, in INR', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    const table = await screen.findByRole('table', { name: /rates in force/i })
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toContain('/api/tariff/services/9/price-sheet?onDate=2026-10-08')
    const text = table.textContent ?? ''
    for (const t of ['Base rate', 'General ward', 'Ward: icu', '₹1,500.00', 'Department rate', 'Cardiology', '₹600.00', 'Payer rate', 'Star Health', '₹450.00']) expect(text).toContain(t)
  })

  it('reloads the rate card when the date changes', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    await screen.findByRole('table', { name: /rates in force/i })
    fireEvent.change(screen.getByLabelText(/^date$/i), { target: { value: '2026-11-01' } })
    await waitFor(() => expect(fetchFn.mock.calls.map((c) => String(c[0]))).toContain('/api/tariff/services/9/price-sheet?onDate=2026-11-01'))
  })

  it('sends the chosen payer, department and ward to the resolver', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    await screen.findByRole('table', { name: /rates in force/i })
    fireEvent.change(screen.getByLabelText(/^payer$/i), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText(/ordering department/i), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/^ward$/i), { target: { value: 'icu' } })
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('₹500.00'))
    const resolveUrl = fetchFn.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/api/tariff/resolve'))!
    expect(Object.fromEntries(new URLSearchParams(resolveUrl.split('?')[1]))).toEqual({ serviceId: '9', onDate: '2026-10-08', payerId: '7', departmentId: '3', ward: 'icu' })
  })

  it('filters the service search by department', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    const dept = await screen.findByLabelText(/search in department/i)
    await waitFor(() => expect(dept.querySelectorAll('option').length).toBe(3))
    fireEvent.change(dept, { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText(/service/i, { selector: 'input' }), { target: { value: 'cons' } })
    await screen.findByRole('option', { name: /general consultation/i })
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toContain('/api/tariff/services?q=cons&departmentId=3')
  })

  it('starts from a service passed in (global search hit) and loads its rate card', async () => {
    const fetchFn = stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" initialService={{ id: 9, code: 'CONS-GEN', name: 'General consultation' }} />)
    await screen.findByRole('table', { name: /rates in force/i })
    expect(screen.getByLabelText(/service/i, { selector: 'input' })).toHaveValue('General consultation')
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toContain('/api/tariff/services/9/price-sheet?onDate=2026-10-08')
  })

  it('moves through matching services with the arrow keys and picks with Enter', async () => {
    stubFetch(routes())
    render(<PriceLookupPanel today="2026-10-08" />)
    const input = screen.getByLabelText(/service/i, { selector: 'input' })
    fireEvent.change(input, { target: { value: 'cons' } })
    await screen.findByRole('option', { name: /general consultation/i })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('General consultation')
    await screen.findByRole('table', { name: /rates in force/i })
  })
})
