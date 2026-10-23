import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'

// Foundations T11: one payment path. The cash desk's mode list with the UPI QR flow, the
// collect-payment links into it (patient collections, invoice page), invoice paid/outstanding,
// and the retired legacy billing pages.
let role: Role = 'billing'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`) })
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirect(p),
  notFound: () => { throw new Error('NOT_FOUND') },
  useRouter: () => ({ refresh, push: vi.fn() }),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-ledger', () => ({
  findPatientForCashDesk: vi.fn(async () => []), getPatientLedger: vi.fn(), listPayableInvoices: vi.fn(async () => []),
}))
vi.mock('@/lib/queries/invoices', () => ({ listInvoices: vi.fn(), getInvoice: vi.fn(), getInvoicePaidPaise: vi.fn(), INVOICE_PAGE_SIZE: 50 }))
vi.mock('@/lib/queries/insurance-claims', () => ({ listInsuranceClaims: vi.fn(async () => []) }))
vi.mock('@/lib/queries/patient-statements', () => ({ listPatientStatements: vi.fn(async () => []) }))
vi.mock('@/components/billing/InvoiceDocument', () => ({ InvoiceDocument: vi.fn(() => <div data-testid="doc" />) }))
vi.mock('@/components/billing/InvoiceActions', () => ({ InvoiceActions: vi.fn(() => <div data-testid="actions" />) }))

import { getPatientLedger, listPayableInvoices } from '@/lib/queries/patient-ledger'
import { getInvoice, getInvoicePaidPaise, listInvoices } from '@/lib/queries/invoices'
import { listInsuranceClaims } from '@/lib/queries/insurance-claims'
import { listPatientStatements } from '@/lib/queries/patient-statements'
import { CashDeskPanel } from '@/components/billing/CashDeskPanel'
import { PatientCollectionsTable } from '@/components/PatientCollectionsTable'
import CashDeskPage from '@/app/(dashboard)/cash-desk/page'
import InvoicesPage from '@/app/(dashboard)/billing/invoices/page'
import InvoicePage from '@/app/(dashboard)/billing/invoices/[id]/page'
import InsuranceCollectionsPage from '@/app/(dashboard)/billing/insurance-collections/page'
import StatementsPage from '@/app/(dashboard)/billing/statements/page'
import { NAV_BILLING_ITEMS } from '@/components/LeftNav'

const LEDGER = {
  patient: { id: 'RD-1', name: 'Asha Rao', uhid: 'HMS-000123' },
  activeAdmissionId: null,
  ledger: { rows: [], summary: { invoicedPaise: 0, creditedPaise: 0, receivedPaise: 0, refundedPaise: 0, balancePaise: 0, outstandingPaise: 0, creditBalancePaise: 0 } },
  unbilledPaise: 0, legacyCharges: [], coveredPendingPaise: 0, patientPayablePaise: 0,
}

const fetchMock = vi.fn()
beforeEach(() => {
  role = 'billing'
  vi.clearAllMocks()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(getPatientLedger).mockResolvedValue(LEDGER as never)
  vi.mocked(listPayableInvoices).mockResolvedValue([{ id: 7, invoiceNumber: 'INV/26-27/000001', totalPaise: 500000 }])
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const panel = (over: Partial<Parameters<typeof CashDeskPanel>[0]> = {}) =>
  render(<CashDeskPanel patientId="RD-1" admissionId={null} finalisedInvoices={[{ id: 7, invoiceNumber: 'INV/26-27/000001', totalPaise: 500000 }]} canRefund upiReady {...over} />)

describe('CashDeskPanel payment modes', () => {
  it('offers cash, UPI, card, cheque, NEFT and other', () => {
    panel()
    const options = Array.from((screen.getByLabelText('Mode') as HTMLSelectElement).options).map((o) => o.value)
    expect(options).toEqual(['cash', 'upi', 'card', 'cheque', 'neft', 'other'])
  })

  it('UPI: shows the server QR, amount and UPI id, takes the UTR and records one payment', async () => {
    fetchMock
      .mockImplementationOnce(() => json(201, { requestId: 9, uri: 'upi://pay?pa=h@icici', qrDataUrl: 'data:image/png;base64,AAA', vpa: 'h@icici', payeeName: 'Sunrise', amountPaise: 250050 }))
      .mockImplementationOnce(() => json(201, { receiptNumber: 'RCT/26-27/000009', paymentId: 41 }))
    panel()
    fireEvent.click(screen.getByRole('tab', { name: 'Take payment' }))
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '2500.50' } })
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'upi' } })
    expect(screen.queryByLabelText('Reference')).toBeNull()
    fireEvent.change(screen.getByLabelText('Against invoice'), { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show UPI QR' }))
    const img = await screen.findByRole('img', { name: /UPI QR code/ })
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAA')
    expect(screen.getByText('h@icici')).toBeInTheDocument()
    expect(screen.getAllByText('₹2,500.50').length).toBeGreaterThan(0)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ patientId: 'RD-1', amountPaise: 250050, kind: 'receipt', invoiceId: 7 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/billing/payments/upi-request')

    const record = screen.getByRole('button', { name: 'Record payment' })
    expect(record).toBeDisabled()
    fireEvent.change(screen.getByLabelText('UTR (UPI reference)'), { target: { value: '412345678901' } })
    fireEvent.click(record)
    expect(await screen.findByRole('link', { name: /Print receipt RCT\/26-27\/000009/ })).toHaveAttribute('href', '/print/receipts/41')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/billing/payments/upi-request/9/confirm')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ utr: '412345678901' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('UPI not set up: the 503 message is shown', async () => {
    fetchMock.mockImplementationOnce(() => json(503, { error: 'UPI is not set up. Ask your administrator.' }))
    panel()
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'upi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show UPI QR' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('UPI is not set up. Ask your administrator.')
  })

  it('without a hospital UPI id, UPI falls back to a typed reference on the same payments route', async () => {
    fetchMock.mockImplementationOnce(() => json(201, { receiptNumber: 'RCT/26-27/000010', paymentId: 42 }))
    panel({ upiReady: false })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'upi' } })
    fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'UTR412345678901' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record advance' }))
    await screen.findByRole('link', { name: /Print receipt/ })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/billing/payments')
  })

  it('card, cheque and NEFT post to the same payments route with their reference', async () => {
    for (const mode of ['card', 'cheque', 'neft']) {
      fetchMock.mockImplementationOnce(() => json(201, { receiptNumber: 'RCT/26-27/000011', paymentId: 43 }))
      const { unmount } = panel()
      fireEvent.click(screen.getByRole('tab', { name: 'Take payment' }))
      fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '10' } })
      fireEvent.change(screen.getByLabelText('Mode'), { target: { value: mode } })
      fireEvent.change(screen.getByLabelText('Reference'), { target: { value: 'REF123456' } })
      fireEvent.click(screen.getByRole('button', { name: 'Record payment' }))
      await screen.findByRole('link', { name: /Print receipt/ })
      const [url, init] = fetchMock.mock.calls.at(-1)!
      expect(url).toBe('/api/billing/payments')
      expect(JSON.parse(init.body)).toMatchObject({ kind: 'receipt', mode, reference: 'REF123456', amountPaise: 1000 })
      unmount()
    }
  })

  it('prefills the payment tab with the amount and invoice it was opened for', () => {
    panel({ initialAmountPaise: 250050, initialInvoiceId: 7 })
    expect(screen.getByRole('tab', { name: 'Take payment' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByLabelText('Amount (₹)')).toHaveValue('2500.50')
    expect(screen.getByLabelText('Against invoice')).toHaveValue('7')
  })
})

describe('/cash-desk prefill from the query', () => {
  it('reads patientId, amountPaise and invoiceId and passes them through', async () => {
    vi.stubEnv('HOSPITAL_UPI_VPA', 'h@icici')
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1', amountPaise: '250050', invoiceId: '7' }) }))
    expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('2500.50')
    expect(screen.getByLabelText('Against invoice')).toHaveValue('7')
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'upi' } })
    expect(screen.getByRole('button', { name: 'Show UPI QR' })).toBeInTheDocument()
  })

  it('ignores an amount that is not a positive integer, and an invoice that is not payable', async () => {
    for (const amountPaise of ['0', '-5', '12.5', 'abc', '99999999999999999']) {
      const { unmount } = render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1', amountPaise, invoiceId: '99' }) }))
      expect(screen.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('')
      expect(screen.getByRole('tab', { name: 'Take advance' })).toHaveAttribute('aria-selected', 'true')
      unmount()
    }
  })

  it('an unknown patient is a 404', async () => {
    vi.mocked(getPatientLedger).mockResolvedValue(null)
    await expect(CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-9', amountPaise: '100' }) })).rejects.toThrow('NOT_FOUND')
  })
})

describe('Collect Payment links to the Cash Desk', () => {
  it('Patient Collections opens the cash desk for that patient and amount', () => {
    render(<PatientCollectionsTable rows={[{ patientId: 'RD-0001', patientName: 'Zz', balanceCents: 12345, unappliedCents: 0 }]} />)
    expect(screen.getByRole('link', { name: /collect payment/i })).toHaveAttribute('href', '/cash-desk?patientId=RD-0001&amountPaise=12345')
  })
})

describe('invoices: paid and outstanding', () => {
  const ROW = { id: 7, invoiceNumber: 'INV/26-27/000001', status: 'finalised', patientId: 'RD-1', patientName: 'Asha Rao', uhid: 'HMS-1', payerName: null, invoiceDate: '2026-10-01', totalPaise: 500000, paidPaise: 200000, outstandingPaise: 300000, createdAt: new Date() }

  it('the list shows Paid and Outstanding columns in rupees', async () => {
    vi.mocked(listInvoices).mockResolvedValue({ rows: [ROW as never, { ...ROW, id: 8, invoiceNumber: null, status: 'draft', totalPaise: null, paidPaise: 0, outstandingPaise: null } as never], total: 2 })
    render(await InvoicesPage({ searchParams: Promise.resolve({}) }))
    expect(screen.getByRole('columnheader', { name: 'Paid' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Outstanding' })).toBeInTheDocument()
    expect(screen.getByText('₹2,000.00')).toBeInTheDocument()
    expect(screen.getByText('₹3,000.00')).toBeInTheDocument()
  })

  it('the invoice page has Collect payment, prefilled with the outstanding amount', async () => {
    vi.mocked(getInvoice).mockResolvedValue({ id: 7, status: 'finalised', patientId: 'RD-1', totalPaise: 500000 } as never)
    vi.mocked(getInvoicePaidPaise).mockResolvedValue(200000)
    render(await InvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(screen.getByRole('link', { name: /collect payment/i })).toHaveAttribute('href', '/cash-desk?patientId=RD-1&amountPaise=300000&invoiceId=7')
  })

  it('no Collect payment on a paid, draft or cancelled invoice', async () => {
    vi.mocked(getInvoice).mockResolvedValue({ id: 7, status: 'finalised', patientId: 'RD-1', totalPaise: 500000 } as never)
    vi.mocked(getInvoicePaidPaise).mockResolvedValue(500000)
    const { unmount } = render(await InvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(screen.queryByRole('link', { name: /collect payment/i })).toBeNull()
    unmount()
    vi.mocked(getInvoice).mockResolvedValue({ id: 7, status: 'draft', patientId: 'RD-1', totalPaise: null } as never)
    render(await InvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(screen.queryByRole('link', { name: /collect payment/i })).toBeNull()
  })
})

describe('legacy billing pages are retired', () => {
  it('Insurance Collections redirects to RCM claims and Statements to the cash desk, before any query', async () => {
    await expect(InsuranceCollectionsPage()).rejects.toThrow('REDIRECT /rcm/claims')
    await expect(StatementsPage()).rejects.toThrow('REDIRECT /cash-desk')
    expect(listInsuranceClaims).not.toHaveBeenCalled()
    expect(listPatientStatements).not.toHaveBeenCalled()
  })

  it('the billing nav no longer lists them, nor the demo card payment', () => {
    const hrefs = NAV_BILLING_ITEMS.map((i) => i.href)
    expect(hrefs).not.toContain('/billing/insurance-collections')
    expect(hrefs).not.toContain('/billing/statements')
    expect(hrefs).not.toContain('/billing/pay')
  })
})
