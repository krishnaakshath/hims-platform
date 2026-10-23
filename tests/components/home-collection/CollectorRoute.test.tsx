// WS6 T11: the collector's route screen -- map link, handover code, waiver, and the visit-date guard.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { CollectorRoute } from '@/components/home-collection/CollectorRoute'
import type { RouteStop } from '@/lib/queries/home-collections'
import { formatSampleId } from '@/lib/labs/sample-id'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const SID = formatSampleId('2026-10-23', 42)
const STOP: RouteStop = {
  visitId: 77,
  status: 'booked',
  windowLabel: 'Morning 7-9',
  windowStart: '07:00',
  windowEnd: '09:00',
  patient: { id: 'RD-0001', name: 'Asha R.', uhid: 'UH-000042', ageYears: 46, gender: 'female' },
  contactPhone: '+919845013210',
  address: { line1: '12 MG Road', line2: null, city: 'Pune', district: null, stateCode: 'IN-MH', pinCode: '411001', landmark: 'Opp. Shiva Temple' },
  notes: null,
  tests: [{ orderId: 11, testName: 'Lipid panel', sampleType: 'serum', container: 'sst_gold', sampleId: SID, status: 'scheduled', quotedPricePaise: 45000 }],
}

function mockFetch() {
  return vi.fn(async (url: string) => {
    if (url === '/api/home-collections/77/otp') return new Response(JSON.stringify({ channelStatus: 'sent' }), { status: 200 })
    if (url === '/api/home-collections/77/collect') return new Response(JSON.stringify({ ok: true, collectedOrderIds: [11], notCollectedOrderIds: [], encounterId: 5 }), { status: 200 })
    return new Response('{}', { status: 404 })
  })
}

const bodyOf = (fetchMock: ReturnType<typeof mockFetch>, url: string) =>
  JSON.parse(String((fetchMock.mock.calls.find((c) => c[0] === url) as unknown as [string, RequestInit])[1].body))

describe('CollectorRoute (WS6 T11)', () => {
  it('links the visit address to Google Maps, with the landmark and PIN', () => {
    render(<CollectorRoute date="2026-10-23" today="2026-10-23" canLookBack={false} stops={[STOP]} />)
    const link = screen.getByRole('link', { name: 'Open in Maps' })
    const href = link.getAttribute('href')!
    expect(href.startsWith('https://www.google.com/maps/search/?api=1&query=')).toBe(true)
    expect(new URL(href).searchParams.get('query')).toBe('12 MG Road, near Opp. Shiva Temple, Pune 411001')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('disables Collect before the visit date and says which day it is', () => {
    render(<CollectorRoute date="2026-10-24" today="2026-10-23" canLookBack={false} stops={[STOP]} />)
    expect(screen.getByRole('button', { name: 'Mark collected' })).toBeDisabled()
    expect(screen.getByText('Visit is on 24 Oct')).toBeInTheDocument()
  })

  it('sends the code, then collects with the code the patient reads out', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<CollectorRoute date="2026-10-23" today="2026-10-23" canLookBack={false} stops={[STOP]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark collected' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }))
    await screen.findByText(/Code sent to the patient's phone/)
    expect(bodyOf(fetchMock, '/api/home-collections/77/otp')).toEqual({})

    fireEvent.change(screen.getByRole('textbox', { name: /scan or type/i }), { target: { value: SID } })
    fireEvent.change(screen.getByLabelText('Handover code from the patient'), { target: { value: '04 29-17' } })
    expect(screen.getByLabelText('Or, why the code could not be used')).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Save collection' }))
    await screen.findByText(/Saved: 1 collected/)
    expect(bodyOf(fetchMock, '/api/home-collections/77/collect')).toEqual({ sampleIds: [SID], otp: '042917' })
  })

  it('without a code asks for one or a reason; a waiver reason is sent instead', async () => {
    const fetchMock = mockFetch()
    vi.stubGlobal('fetch', fetchMock)
    render(<CollectorRoute date="2026-10-23" today="2026-10-23" canLookBack={false} stops={[STOP]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark collected' }))
    fireEvent.change(screen.getByRole('textbox', { name: /scan or type/i }), { target: { value: SID } })
    fireEvent.click(screen.getByRole('button', { name: 'Save collection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the handover code the patient received, or choose why it could not be used.')
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Or, why the code could not be used'), { target: { value: 'sms_unavailable' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save collection' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(bodyOf(fetchMock, '/api/home-collections/77/collect')).toEqual({ sampleIds: [SID], waiverReason: 'sms_unavailable' })
  })
})
