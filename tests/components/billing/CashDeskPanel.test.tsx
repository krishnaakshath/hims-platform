import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { CashDeskPanel } from '@/components/billing/CashDeskPanel'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/billing/payments') return new Response(JSON.stringify({ receiptNumber: 'RCT/26-27/000004', paymentId: 41 }), { status: 201 })
    if (url === '/api/billing/refunds') return new Response(JSON.stringify({ refundNumber: 'RFD/26-27/000001' }), { status: 201 })
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const INVOICES = [{ id: 7, invoiceNumber: 'INV/26-27/000001', totalPaise: 118000 }]

describe('CashDeskPanel', () => {
  it('frontdesk sees take-payment but no refund form', () => {
    render(<CashDeskPanel patientId="RD-1" admissionId={null} finalisedInvoices={INVOICES} canRefund={false} />)
    expect(screen.getByRole('tab', { name: 'Take advance' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Take payment' })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Refund' })).toBeNull()
  })

  it('a card number in the reference shows the inline message and blocks submit', async () => {
    render(<CashDeskPanel patientId="RD-1" admissionId={null} finalisedInvoices={INVOICES} canRefund={false} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Take payment' }))
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'card' } })
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: '4111 1111 1111 1111' } })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '500' } })
    expect(screen.getByText('This looks like a card number. Enter the bank or UPI reference instead')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeDisabled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records an advance in paise against the admission and links the receipt print', async () => {
    render(<CashDeskPanel patientId="RD-1" admissionId={12} finalisedInvoices={[]} canRefund={false} />)
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '25,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }))
    expect(await screen.findByRole('link', { name: /RCT\/26-27\/000004/ })).toHaveAttribute('href', '/print/receipts/41')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ patientId: 'RD-1', kind: 'advance', mode: 'cash', amountPaise: 2500000, admissionId: 12 })
  })

  it('a payment against an invoice sends the invoice id; billing can refund with a reason', async () => {
    render(<CashDeskPanel patientId="RD-1" admissionId={null} finalisedInvoices={INVOICES} canRefund />)
    fireEvent.click(screen.getByRole('tab', { name: 'Take payment' }))
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'upi' } })
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'UTR412345678901' } })
    fireEvent.change(screen.getByLabelText('Against invoice'), { target: { value: '7' } })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '1180' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ patientId: 'RD-1', kind: 'receipt', mode: 'upi', reference: 'UTR412345678901', amountPaise: 118000, invoiceId: 7 })

    fireEvent.click(screen.getByRole('tab', { name: 'Refund' }))
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    expect(screen.getByRole('button', { name: 'Issue refund' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Discharged early' } })
    fireEvent.click(screen.getByRole('button', { name: 'Issue refund' }))
    expect(await screen.findByText(/RFD\/26-27\/000001/)).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ patientId: 'RD-1', mode: 'cash', amountPaise: 10000, reason: 'Discharged early' })
  })
})
