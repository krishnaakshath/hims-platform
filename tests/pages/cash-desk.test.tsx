import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'

let role: Role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`) })
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirect(p),
  notFound: () => { throw new Error('NOT_FOUND') },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-ledger', () => ({
  findPatientForCashDesk: vi.fn(async () => []), getPatientLedger: vi.fn(), listPayableInvoices: vi.fn(async () => []), getReceipt: vi.fn(),
}))
vi.mock('@/lib/queries/billing-settings', () => ({ getBillingSettings: vi.fn(async () => ({ legalName: 'Sunrise Hospital', gstin: '29AAGCB7383J1Z4', address: 'MG Road' })) }))
vi.mock('@/components/billing/CashDeskPanel', () => ({ CashDeskPanel: vi.fn(() => <div data-testid="panel" />) }))
vi.mock('@/lib/payments/manual-upi', () => ({ listPendingUpiRequests: vi.fn(async () => []) })) // WS7 T8
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() })) // WS7 T8

import { findPatientForCashDesk, getPatientLedger, getReceipt } from '@/lib/queries/patient-ledger'
import { CashDeskPanel } from '@/components/billing/CashDeskPanel'
import { logAudit } from '@/lib/audit'
import CashDeskPage from '@/app/(dashboard)/cash-desk/page'
import ReceiptPrintPage from '@/app/print/receipts/[id]/page'
import { fireEvent } from '@testing-library/react' // WS7 T8
import { listPendingUpiRequests } from '@/lib/payments/manual-upi' // WS7 T8
import { sendJson } from '@/lib/client-fetch' // WS7 T8

const LEDGER = {
  patient: { id: 'RD-1', name: 'Asha Rao', uhid: 'HMS-000123' },
  activeAdmissionId: 12,
  ledger: {
    rows: [
      { kind: 'advance', id: 41, number: 'RCT/26-27/000004', at: new Date('2026-10-08T05:00:00Z'), amountPaise: 2500000, admissionId: 12, balancePaise: -2500000 },
      { kind: 'invoice', id: 7, number: 'INV/26-27/000001', at: new Date('2026-10-09T05:00:00Z'), amountPaise: 3_540_000_000, admissionId: 12, balancePaise: 3_537_500_000 },
    ],
    summary: { invoicedPaise: 3_540_000_000, creditedPaise: 0, receivedPaise: 2500000, refundedPaise: 0, balancePaise: 3_537_500_000, outstandingPaise: 3_537_500_000, creditBalancePaise: 0 },
  },
  unbilledPaise: 150000,
  legacyCharges: [{ id: 3, dateOfService: '2026-09-01', amountPaise: 12345, status: 'draft', legacy: true }],
}

beforeEach(() => {
  role = 'frontdesk'
  vi.clearAllMocks()
  vi.mocked(getPatientLedger).mockResolvedValue(LEDGER as never)
})

describe('/cash-desk', () => {
  it('searches patients and links each result', async () => {
    vi.mocked(findPatientForCashDesk).mockResolvedValue([{ id: 'RD-1', name: 'Asha Rao', uhid: 'HMS-000123' }])
    render(await CashDeskPage({ searchParams: Promise.resolve({ q: 'Asha' }) }))
    expect(findPatientForCashDesk).toHaveBeenCalledWith('Asha')
    expect(screen.getByRole('link', { name: /Asha Rao/ })).toHaveAttribute('href', '/cash-desk?patientId=RD-1')
  })

  it('shows the ledger in IST with receipt links, the summary and flagged legacy charges (no link for frontdesk)', async () => {
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'RCT/26-27/000004' })).toHaveAttribute('href', '/print/receipts/41')
    expect(screen.getByText('8 Oct 2026, 10:30 am')).toBeInTheDocument()
    expect(screen.getAllByText('₹3,53,75,000.00').length).toBeGreaterThan(0)
    expect(screen.getByText('Legacy')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /₹123.45|Charge #3/ })).toBeNull()
    // frontdesk cannot open /billing/invoices (CHARGE_CAPTURE_ROLES), so the invoice number is plain text
    expect(screen.getByText('INV/26-27/000001')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'INV/26-27/000001' })).toBeNull()
    expect(vi.mocked(CashDeskPanel).mock.calls[0][0]).toMatchObject({ patientId: 'RD-1', admissionId: 12, canRefund: false })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: viewed patient ledger', 'RD-1')
    // WS2 T12: frontdesk takes money but does not draft invoices (INVOICE_READY_ROLES).
    expect(screen.queryByRole('button', { name: 'Invoice ready charges' })).toBeNull()
  })

  it.each(['billing', 'crc', 'admin'] as const)('%s can invoice the patient\'s ready charges', async (r) => {
    role = r
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    expect(screen.getByRole('button', { name: 'Invoice ready charges' })).toBeInTheDocument()
  })

  it('billing can refund and follow legacy charge links', async () => {
    role = 'billing'
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    expect(vi.mocked(CashDeskPanel).mock.calls[0][0]).toMatchObject({ canRefund: true })
    expect(screen.getByRole('link', { name: 'Charge #3' })).toHaveAttribute('href', '/billing/charges/3')
    expect(screen.getByRole('link', { name: 'INV/26-27/000001' })).toHaveAttribute('href', '/billing/invoices/7')
  })

  it('an unknown patient is a 404; a denied role is redirected before any read', async () => {
    vi.mocked(getPatientLedger).mockResolvedValue(null)
    await expect(CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-9' }) })).rejects.toThrow('NOT_FOUND')
    role = 'pharmacy'
    await expect(CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) })).rejects.toThrow('REDIRECT /')
    expect(getPatientLedger).toHaveBeenCalledTimes(1)
  })
})

describe('/print/receipts/[id]', () => {
  it('prints an advance receipt with hospital, patient, mode, reference, amount and receiver; audited', async () => {
    vi.mocked(getReceipt).mockResolvedValue({
      id: 41, receiptNumber: 'RCT/26-27/000004', kind: 'advance', patientId: 'RD-1', patientName: 'Asha Rao', uhid: 'HMS-000123', mode: 'upi',
      reference: 'UTR412345678901', amountPaise: 2500000, receiptDate: '2026-10-08', receivedByName: 'Front Desk', receivedAt: new Date('2026-10-08T05:00:00Z'),
    } as never)
    render(await ReceiptPrintPage({ params: Promise.resolve({ id: '41' }) }))
    expect(screen.getByRole('heading', { name: 'Advance Receipt' })).toBeInTheDocument()
    for (const text of ['Sunrise Hospital', 'GSTIN 29AAGCB7383J1Z4', 'RCT/26-27/000004', '8 Oct 2026', 'Asha Rao', 'UPI', 'UTR412345678901', '₹25,000.00', 'Front Desk']) {
      expect(screen.getAllByText(new RegExp(text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))).length, text).toBeGreaterThan(0)
    }
    expect(screen.getByText('Rupees Twenty-Five Thousand Only')).toBeInTheDocument()
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: printed receipt', 'RD-1')
  })

  it('404s an unknown receipt; redirects a denied role first', async () => {
    vi.mocked(getReceipt).mockResolvedValue(null)
    await expect(ReceiptPrintPage({ params: Promise.resolve({ id: '9' }) })).rejects.toThrow('NOT_FOUND')
    role = 'pi'
    await expect(ReceiptPrintPage({ params: Promise.resolve({ id: '9' }) })).rejects.toThrow('REDIRECT /')
  })
})

// WS7 T8 (spec D14): the pending UPI list. A portal request shows the patient-reported UTR masked;
// the cashier types the full UTR from the bank statement and confirms through the existing route.
describe('/cash-desk pending UPI payments', () => {
  const PENDING = [
    { id: 41, source: 'portal', amountPaise: 30000, invoiceNumber: 'INV/26-27/000007', createdAt: new Date('2026-10-20T05:00:00Z'), reportedUtrMasked: '••••1234', reportedAt: new Date('2026-10-20T05:10:00Z') },
    { id: 42, source: 'staff', amountPaise: 5000, invoiceNumber: null, createdAt: new Date('2026-10-20T06:00:00Z'), reportedUtrMasked: null, reportedAt: null },
  ]

  it('lists pending requests with the masked patient-reported UTR, never the full one', async () => {
    vi.mocked(listPendingUpiRequests).mockResolvedValueOnce(PENDING as never)
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    expect(listPendingUpiRequests).toHaveBeenCalledWith('RD-1')
    expect(screen.getByRole('heading', { name: 'Pending UPI payments' })).toBeInTheDocument()
    expect(screen.getByText('Patient reported UTR ••••1234')).toBeInTheDocument()
    expect(screen.getByText(/Patient portal/)).toBeInTheDocument()
    expect(screen.getByText(/INV\/26-27\/000007/)).toBeInTheDocument()
    expect(screen.getAllByText(/Patient reported UTR/)).toHaveLength(1)
  })

  it('shows nothing when no request is pending', async () => {
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    expect(screen.queryByRole('heading', { name: 'Pending UPI payments' })).toBeNull()
  })

  it('confirm posts the typed UTR to the existing confirm route', async () => {
    vi.mocked(listPendingUpiRequests).mockResolvedValueOnce(PENDING as never)
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: true, status: 201, data: { receiptNumber: 'RCT/26-27/000009', paymentId: 9 } })
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    const confirm = screen.getByRole('button', { name: /Confirm payment request 41/ })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/UTR for request 41/), { target: { value: '412345671234' } })
    fireEvent.click(confirm)
    expect(await screen.findByText(/Recorded RCT\/26-27\/000009/)).toBeInTheDocument()
    expect(sendJson).toHaveBeenCalledWith('/api/billing/payments/upi-request/41/confirm', 'POST', { utr: '412345671234' })
  })

  it('a refused confirm (UTR already used) shows the route message', async () => {
    vi.mocked(listPendingUpiRequests).mockResolvedValueOnce(PENDING as never)
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: false, status: 409, error: 'This UTR has already been recorded' })
    render(await CashDeskPage({ searchParams: Promise.resolve({ patientId: 'RD-1' }) }))
    fireEvent.change(screen.getByLabelText(/UTR for request 41/), { target: { value: '412345671234' } })
    fireEvent.click(screen.getByRole('button', { name: /Confirm payment request 41/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This UTR has already been recorded')
  })
})
// end WS7 T8
