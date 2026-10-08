import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { InvoiceDocument } from '@/components/billing/InvoiceDocument'
import type { InvoiceDetail } from '@/lib/queries/invoices'
import { rupeesInWords } from '@/lib/billing/amount-words'

const PARTIES = {
  hospital: { legalName: 'Sunrise Hospital Pvt Ltd', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', gstStateCode: '29', address: '12 MG Road, Bengaluru' },
  patient: { id: 'RD-0001', name: 'Asha Rao', uhid: 'HMS-000123', addressLine1: '4 Lake View', addressLine2: null, city: 'Mysuru', district: null, stateCode: 'IN-KA', pinCode: '570001' },
  payer: { id: 4, name: 'Star Health', gstin: '27AAPFU0939F1ZV', stateCode: 'IN-MH' },
  context: { encounterId: 5, admissionId: null, label: 'Outpatient visit (visit 5)' },
}

const LINE = {
  lineNo: 1, chargeLineId: 1, itemCode: 'PROC1', itemName: 'Wound dressing', hsnSac: '999312', serviceDate: '2099-06-01', quantity: 2, unitPricePaise: 50000,
  priceSource: 'base' as const, taxablePaise: 100000, gstRateBp: 1800, cgstRateBp: 900, sgstRateBp: 900, igstRateBp: 0, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000,
}

function invoice(over: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: 7, invoiceNumber: 'INV/99-00/000001', status: 'finalised', patientId: 'RD-0001', encounterId: 5, admissionId: null, payerId: 4,
    financialYear: '2099-00', invoiceDate: '2099-06-01', documentTitle: 'Tax Invoice', supplyType: 'intra', placeOfSupplyStateCode: 'IN-KA',
    snapshot: PARTIES, taxablePaise: 100000, cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, totalPaise: 118000,
    createdByName: 'Clerk', createdAt: new Date('2099-06-01T05:00:00Z'), finalisedAt: new Date('2099-06-01T06:00:00Z'), finalisedByName: 'Biller',
    cancelledAt: null, cancelledByName: null, discardedAt: null, discardedByName: null,
    lines: [LINE], creditNote: null, patientName: 'Asha Rao', uhid: 'HMS-000123', estimated: false,
    parties: PARTIES, place: { stateCode: 'IN-KA', supplyType: 'intra' },
    ...over,
  } as InvoiceDetail
}

describe('InvoiceDocument', () => {
  it('renders CGST and SGST columns for an intra-state invoice and IGST for inter-state', () => {
    const { unmount } = render(<InvoiceDocument invoice={invoice()} />)
    const table = screen.getByRole('table', { name: 'Invoice lines' })
    expect(within(table).getByRole('columnheader', { name: /CGST/ })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: /SGST/ })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: /IGST/ })).toBeNull()
    expect(screen.getByText('Karnataka (29)')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'TAX INVOICE' })).toBeInTheDocument()
    expect(screen.getByText('INV/99-00/000001')).toBeInTheDocument()
    expect(screen.getByText('GSTIN 29AAGCB7383J1Z4')).toBeInTheDocument()
    expect(screen.getByText(/Star Health/)).toBeInTheDocument()
    expect(screen.getAllByText('₹1,180.00').length).toBeGreaterThan(0)
    unmount()
    const inter = invoice({
      supplyType: 'inter', placeOfSupplyStateCode: 'IN-MH', place: { stateCode: 'IN-MH', supplyType: 'inter' }, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000,
      lines: [{ ...LINE, cgstRateBp: 0, sgstRateBp: 0, igstRateBp: 1800, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 }],
    })
    render(<InvoiceDocument invoice={inter} />)
    const t2 = screen.getByRole('table', { name: 'Invoice lines' })
    expect(within(t2).getByRole('columnheader', { name: /IGST/ })).toBeInTheDocument()
    expect(within(t2).queryByRole('columnheader', { name: /CGST/ })).toBeNull()
    expect(screen.getByText('Maharashtra (27)')).toBeInTheDocument()
  })

  it('a draft reads PROVISIONAL BILL — NOT A TAX INVOICE and has no number', () => {
    render(<InvoiceDocument invoice={invoice({ status: 'draft', invoiceNumber: null, invoiceDate: null, documentTitle: null, snapshot: null, estimated: true, totalPaise: null, taxablePaise: null, cgstPaise: null, sgstPaise: null, igstPaise: null })} />)
    expect(screen.getByRole('heading', { name: 'PROVISIONAL BILL — NOT A TAX INVOICE' })).toBeInTheDocument()
    expect(screen.queryByText(/INV\//)).toBeNull()
    expect(screen.getByText('Draft #7')).toBeInTheDocument()
    expect(screen.getByText(/estimate/i)).toBeInTheDocument()
    // Totals are summed from the estimated lines.
    expect(screen.getAllByText('₹1,180.00').length).toBeGreaterThan(0)
  })

  it('a cancelled invoice shows the credit note banner', () => {
    render(<InvoiceDocument invoice={invoice({ status: 'cancelled', creditNote: { creditNoteNumber: 'CRN/99-00/000001', issueDate: '2099-06-02', reason: 'Wrong patient' } as never })} />)
    expect(screen.getByRole('status')).toHaveTextContent('CANCELLED — Credit note CRN/99-00/000001')
  })

  it('formats amounts above 2^31 paise', () => {
    render(<InvoiceDocument invoice={invoice({ totalPaise: 3_540_000_000, taxablePaise: 3_000_000_000, cgstPaise: 270_000_000, sgstPaise: 270_000_000 })} />)
    expect(screen.getByText('₹3,54,00,000.00')).toBeInTheDocument()
    expect(screen.getByText('Rupees Three Crore Fifty-Four Lakh Only')).toBeInTheDocument()
  })

  it('carries no phone, email, date of birth or identity numbers', () => {
    const { container } = render(<InvoiceDocument invoice={invoice()} />)
    expect(container.textContent).not.toMatch(/phone|email|dob|date of birth|abha/i)
  })
})

describe('rupeesInWords', () => {
  it.each([
    [0, 'Rupees Zero Only'],
    [100, 'Rupees One Only'],
    [118000, 'Rupees One Thousand One Hundred Eighty Only'],
    [12345678, 'Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Seventy-Eight Paise Only'],
    [3_540_000_000, 'Rupees Three Crore Fifty-Four Lakh Only'],
    [1_000_000_000_000, 'Rupees One Thousand Crore Only'],
  ])('%i paise', (paise, words) => expect(rupeesInWords(paise)).toBe(words))
})
