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

afterEach(() => vi.unstubAllGlobals())

async function pickService() {
  fireEvent.change(screen.getByLabelText(/service/i, { selector: 'input' }), { target: { value: 'cons' } })
  fireEvent.click(await screen.findByRole('button', { name: /general consultation/i }))
}

// Wave B P1-05: the price lookup UI for TARIFF_LOOKUP_ROLES.
describe('PriceLookupPanel', () => {
  it('searches services, resolves the price for the chosen date and room category, and shows it', async () => {
    const fetchFn = stubFetch((url) => {
      if (url.startsWith('/api/tariff/services')) return json(SERVICES)
      if (url.startsWith('/api/tariff/room-categories')) return json(ROOMS)
      if (url.startsWith('/api/tariff/resolve')) return json({ ok: true, serviceId: 9, serviceCode: 'CONS-GEN', serviceName: 'General consultation', amountPaise: 50000, gstRateBp: 1800, hsnSac: '999312', scope: 'base', matched: { roomCategory: 'GENERAL', ward: null }, formatted: '₹500.00' })
      return json({}, 404)
    })
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
    stubFetch((url) => {
      if (url.startsWith('/api/tariff/services')) return json(SERVICES)
      if (url.startsWith('/api/tariff/room-categories')) return json(ROOMS)
      return json({ ok: false, reason: 'no_rate' })
    })
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/no price is set/i))
  })

  it('shows the server error when the lookup fails', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/tariff/services')) return json(SERVICES)
      if (url.startsWith('/api/tariff/room-categories')) return json(ROOMS)
      return json({ error: 'Could not look up the price' }, 500)
    })
    render(<PriceLookupPanel today="2026-10-08" />)
    await pickService()
    fireEvent.click(screen.getByRole('button', { name: /look up price/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not look up the price'))
  })
})
