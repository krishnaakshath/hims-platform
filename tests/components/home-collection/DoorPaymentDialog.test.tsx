// WS6 T12: the collector's door payment dialog (cash or UPI) and the "Collect payment" button.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { DoorPaymentDialog } from '@/components/home-collection/DoorPaymentDialog'
import { CollectorRoute } from '@/components/home-collection/CollectorRoute'
import type { RouteStop } from '@/lib/queries/home-collections'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const VISIT = { id: 77, patientName: 'Asha R.', amountDuePaise: 60000, unpricedTests: 1 }
const RECEIPT = 'RCT/26-27/000042'

function routes(over: Record<string, Response> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (over[url]) return over[url]
    if (url === '/api/home-collections/77/payment') {
      const body = JSON.parse(String(init?.body))
      return body.mode === 'cash'
        ? new Response(JSON.stringify({ receiptNumber: RECEIPT }), { status: 201 })
        : new Response(JSON.stringify({ requestId: 9, qrDataUrl: 'data:image/png;base64,AAA', amountPaise: body.amountPaise }), { status: 201 })
    }
    if (url === '/api/home-collections/77/payment/confirm') return new Response(JSON.stringify({ receiptNumber: RECEIPT }), { status: 201 })
    return new Response('{}', { status: 404 })
  })
}
const bodyOf = (f: ReturnType<typeof routes>, url: string) =>
  JSON.parse(String((f.mock.calls.find((c) => c[0] === url) as unknown as [string, RequestInit])[1].body))

const renderDialog = (onClose = vi.fn()) => render(<ToastProvider><DoorPaymentDialog visit={VISIT} onClose={onClose} /></ToastProvider>)

describe('DoorPaymentDialog', () => {
  it('prefills the amount due; cash records a receipt and shows its number in a toast', async () => {
    const f = routes()
    vi.stubGlobal('fetch', f)
    const onClose = vi.fn()
    renderDialog(onClose)
    expect(screen.getByText('₹600.00')).toBeInTheDocument()
    expect(screen.getByText('1 test has no price yet.')).toBeInTheDocument()
    expect(screen.getByLabelText('Amount (₹)')).toHaveValue('600.00')
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }))
    expect(await screen.findByText(`Receipt ${RECEIPT}`)).toBeInTheDocument()
    expect(bodyOf(f, '/api/home-collections/77/payment')).toEqual({ mode: 'cash', amountPaise: 60000 })
    expect(onClose).toHaveBeenCalled()
  })

  it('UPI shows the QR, then confirms with the UTR and shows the receipt number', async () => {
    const f = routes()
    vi.stubGlobal('fetch', f)
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'UPI' }))
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '450' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show UPI QR' }))
    expect(await screen.findByRole('img', { name: 'UPI QR code for ₹450.00' })).toBeInTheDocument()
    expect(bodyOf(f, '/api/home-collections/77/payment')).toEqual({ mode: 'upi', amountPaise: 45000 })

    fireEvent.click(screen.getByRole('button', { name: 'Confirm UPI payment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/UTR/)
    fireEvent.change(screen.getByLabelText('UTR (UPI reference)'), { target: { value: '412345678901' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm UPI payment' }))
    expect(await screen.findByText(`Receipt ${RECEIPT}`)).toBeInTheDocument()
    expect(bodyOf(f, '/api/home-collections/77/payment/confirm')).toEqual({ requestId: 9, utr: '412345678901' })
  })

  it('an amount under ₹1 is refused before posting; the server UPI message is shown', async () => {
    const f = routes({ '/api/home-collections/77/payment': new Response(JSON.stringify({ error: 'UPI is not set up. Ask your administrator.' }), { status: 503 }) })
    vi.stubGlobal('fetch', f)
    renderDialog()
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record cash' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter an amount between ₹1 and ₹1,00,000.')
    expect(f).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('radio', { name: 'UPI' }))
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show UPI QR' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('UPI is not set up. Ask your administrator.'))
  })
})

describe('CollectorRoute: Collect payment', () => {
  const stop: RouteStop = {
    visitId: 77, status: 'booked', windowLabel: 'Morning 7-9', windowStart: '07:00', windowEnd: '09:00',
    patient: { id: 'RD-0001', name: 'Asha R.', uhid: 'UH-000042', ageYears: 46, gender: 'female' },
    contactPhone: '+919845013210',
    address: { line1: '12 MG Road', line2: null, city: 'Pune', district: null, stateCode: 'IN-MH', pinCode: '411001', landmark: null },
    notes: null,
    tests: [
      { orderId: 11, testName: 'Lipid panel', sampleType: 'serum', container: 'sst_gold', sampleId: null, status: 'scheduled', quotedPricePaise: 45000 },
      { orderId: 12, testName: 'CBC', sampleType: 'blood', container: 'edta_lavender', sampleId: null, status: 'scheduled', quotedPricePaise: 15000 },
      { orderId: 13, testName: 'HbA1c', sampleType: 'blood', container: 'edta_lavender', sampleId: null, status: 'scheduled', quotedPricePaise: null },
    ],
  }

  it('shows the amount due for the visit tests and opens the dialog; disabled before the visit day', () => {
    render(<ToastProvider><CollectorRoute date="2026-10-23" today="2026-10-23" canLookBack={false} stops={[stop]} /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment · ₹600.00' }))
    expect(screen.getByRole('heading', { name: 'Collect payment: Asha R.' })).toBeInTheDocument()
    cleanup()
    render(<ToastProvider><CollectorRoute date="2026-10-24" today="2026-10-23" canLookBack={false} stops={[stop]} /></ToastProvider>)
    expect(screen.getByRole('button', { name: 'Collect payment · ₹600.00' })).toBeDisabled()
  })
})
