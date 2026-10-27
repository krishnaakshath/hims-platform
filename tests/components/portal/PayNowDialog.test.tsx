// WS7 T8 (spec D14): the portal's Pay now dialog. It shows the UPI QR for the outstanding amount,
// then lets the patient report the UTR; it says plainly that the hospital confirms the payment.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))

import { sendJson } from '@/lib/client-fetch'
import { PayNowDialog } from '@/components/portal/PayNowDialog'

const QR = { requestId: 41, qrDataUrl: 'data:image/png;base64,AAA', upiUri: 'upi://pay?pa=a@ybl&pn=X&am=300.00&cu=INR&tn=n', amountPaise: 30000 }

beforeEach(() => {
  vi.mocked(sendJson).mockReset()
  refresh.mockReset()
})

async function openQr() {
  vi.mocked(sendJson).mockResolvedValueOnce({ ok: true, status: 201, data: QR })
  render(<PayNowDialog invoiceId={7} invoiceNumber="INV/26-27/000007" outstandingPaise={30000} />)
  fireEvent.click(screen.getByRole('button', { name: /Pay now/ }))
  await screen.findByRole('img', { name: /UPI QR code for ₹300.00/ })
}

describe('PayNowDialog', () => {
  it('Pay now asks for a QR for this bill and shows it with the amount and a UPI app link', async () => {
    await openQr()
    expect(sendJson).toHaveBeenCalledWith('/api/patient-portal/payments/upi-request', 'POST', { invoiceId: 7 })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /UPI QR code/ })).toHaveAttribute('src', QR.qrDataUrl)
    expect(screen.getByRole('link', { name: /Open in a UPI app/ })).toHaveAttribute('href', QR.upiUri)
    expect(screen.getByText('Bill INV/26-27/000007')).toBeInTheDocument()
  })

  it('reporting a UTR sends it once and says the hospital will confirm it', async () => {
    await openQr()
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true } })
    fireEvent.change(screen.getByLabelText(/UTR/), { target: { value: '4123 4567 8901' } })
    fireEvent.click(screen.getByRole('button', { name: /Send reference/ }))
    expect(await screen.findByRole('status')).toHaveTextContent(/hospital will confirm your payment/i)
    expect(sendJson).toHaveBeenLastCalledWith('/api/patient-portal/payments/41/reported-utr', 'POST', { utr: '4123 4567 8901' })
    expect(screen.queryByText(/4123 4567 8901/)).toBeNull()
  })

  it('a malformed UTR is caught before sending', async () => {
    await openQr()
    fireEvent.change(screen.getByLabelText(/UTR/), { target: { value: 'ab!' } })
    expect(screen.getByRole('button', { name: /Send reference/ })).toBeDisabled()
    expect(sendJson).toHaveBeenCalledTimes(1)
  })

  it('a refusal is shown, never swallowed', async () => {
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: false, status: 409, error: 'This bill is already paid' })
    render(<PayNowDialog invoiceId={7} invoiceNumber="INV/26-27/000007" outstandingPaise={30000} />)
    fireEvent.click(screen.getByRole('button', { name: /Pay now/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This bill is already paid')
    await waitFor(() => expect(screen.queryByRole('img', { name: /UPI QR code/ })).toBeNull())
  })
})
