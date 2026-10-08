// Wave J (P1-20): the portal's full-page documents (invoice, receipt, discharge summary).
// Gate order: patient session, then accepted policies, both before any record read. The
// record query is always scoped to the SESSION patient; a null (another patient's id, a
// draft, an unsigned summary) is a 404 with no audit row. A shown document is audited.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const redirect = vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`) })
vi.mock('next/navigation', () => ({ redirect: (u: string) => redirect(u), notFound: () => { throw new Error('NEXT_NOT_FOUND') }, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
let sessionPatient: string | null = 'RD-0001'
let accepted = true
vi.mock('@/lib/patient-session', () => ({
  requirePatientSessionOrRedirect: vi.fn(async () => {
    if (!sessionPatient) redirect('/patient-portal/login')
    return { patientId: sessionPatient }
  }),
}))
vi.mock('@/lib/queries/policy-documents', () => ({ hasAcceptedCurrentPolicies: vi.fn(async () => accepted) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal-records', () => ({
  getPortalInvoice: vi.fn(async () => null),
  getPortalReceipt: vi.fn(async () => null),
  getPortalDischargeSummary: vi.fn(async () => null),
}))
vi.mock('@/lib/queries/billing-settings', () => ({ getBillingSettings: vi.fn(async () => ({ legalName: 'Test Hospital Pvt Ltd', address: '1 MG Road', gstin: '29ABCDE1234F1Z5', stateCode: 'IN-KA' })) }))
vi.mock('@/lib/queries/settings', () => ({ getPracticeIdentity: vi.fn(async () => ({ practiceName: 'Test Hospital', practiceSite: 'Bengaluru' })) }))
vi.mock('@/components/billing/InvoiceDocument', () => ({ InvoiceDocument: ({ invoice }: { invoice: { invoiceNumber: string } }) => <p>Invoice document {invoice.invoiceNumber}</p> }))

import InvoicePage from '@/app/patient-portal/documents/invoices/[id]/page'
import ReceiptPage from '@/app/patient-portal/documents/receipts/[id]/page'
import DischargePage from '@/app/patient-portal/documents/discharge/[admissionId]/page'
import { getPortalDischargeSummary, getPortalInvoice, getPortalReceipt } from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import type { DischargeSummaryData } from '@/lib/encounters/discharge-summary'

const props = (id: string) => ({ params: Promise.resolve({ id }) })
const admProps = (admissionId: string) => ({ params: Promise.resolve({ admissionId }) })

const CASES = [
  { name: 'invoice', run: (id: string) => InvoicePage(props(id)), query: getPortalInvoice },
  { name: 'receipt', run: (id: string) => ReceiptPage(props(id)), query: getPortalReceipt },
  { name: 'discharge summary', run: (id: string) => DischargePage(admProps(id)), query: getPortalDischargeSummary },
] as const

beforeEach(() => {
  sessionPatient = 'RD-0001'
  accepted = true
  redirect.mockClear()
  for (const c of CASES) vi.mocked(c.query).mockReset().mockResolvedValue(null)
  vi.mocked(logPatientPortalAction).mockClear()
})

describe.each(CASES)('portal $name document', ({ run, query }) => {
  it('no patient session -> portal login, before any record read', async () => {
    sessionPatient = null
    await expect(run('5')).rejects.toThrow('NEXT_REDIRECT:/patient-portal/login')
    expect(query).not.toHaveBeenCalled()
  })

  it('policies not accepted -> consent page, before any record read', async () => {
    accepted = false
    await expect(run('5')).rejects.toThrow('NEXT_REDIRECT:/patient-portal/consent')
    expect(query).not.toHaveBeenCalled()
  })

  it('a malformed id is a 404 with no read', async () => {
    await expect(run('abc')).rejects.toThrow('NEXT_NOT_FOUND')
    await expect(run('0')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(query).not.toHaveBeenCalled()
  })

  it('another patient\'s id (the scoped query finds nothing) is a 404 and is not audited', async () => {
    await expect(run('99')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(vi.mocked(query).mock.calls[0][0]).toBe('RD-0001')
    expect(vi.mocked(query).mock.calls[0][1]).toBe(99)
    expect(logPatientPortalAction).not.toHaveBeenCalled()
  })
})

describe('portal documents render the patient\'s own record and audit the view', () => {
  it('invoice', async () => {
    vi.mocked(getPortalInvoice).mockResolvedValue({ id: 5, invoiceNumber: 'INV/2099-00/000001' } as never)
    render(await InvoicePage(props('5')))
    expect(screen.getByText('Invoice document INV/2099-00/000001')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /back to bills/i })).toHaveAttribute('href', '/patient-portal/bills')
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed invoice via patient portal', 'RD-0001', 'invoice=5')
  })

  it('receipt', async () => {
    vi.mocked(getPortalReceipt).mockResolvedValue({
      id: 7, receiptNumber: 'RCT/2099-00/000004', kind: 'receipt', receiptDate: '2099-06-01', mode: 'upi', amountPaise: 150050,
      patientName: 'Asha Rao', uhid: 'HIMS000000011', admissionId: null, reference: 'UPI-123', receivedByName: 'Cashier One', receivedAt: new Date('2099-06-01T05:00:00Z'),
    })
    render(await ReceiptPage(props('7')))
    expect(screen.getByText('RCT/2099-00/000004')).toBeInTheDocument()
    expect(screen.getByText('Payment Receipt')).toBeInTheDocument()
    expect(screen.getByText('₹1,500.50')).toBeInTheDocument()
    expect(screen.getByText('Test Hospital Pvt Ltd')).toBeInTheDocument()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed receipt via patient portal', 'RD-0001', 'receipt=7')
  })

  it('discharge summary: the patient copy, with clinical sections and no administrative banner', async () => {
    const data: DischargeSummaryData = {
      hospitalName: 'H', timezone: 'Asia/Kolkata', generatedAt: '2099-05-05T00:00:00.000Z',
      patient: { id: 'RD-0001', uhid: 'HIMS000000011', name: 'Asha Rao', ageYears: 40, gender: 'Female', abhaNumber: 'XX-XXXX-XXXX-0123', abhaAddress: 'asha@abdm', address: null, isMlc: false, mlcNumber: null },
      admission: { id: 12, admissionType: 'elective', admittedOn: '2099-05-01', dischargedOn: '2099-05-04', lengthOfStayDays: 3, lastWard: null },
      attending: { providerId: 1, name: 'Dr. Meera Iyer', registration: null, departmentName: null },
      clinical: { diagnosis: 'Dengue fever', drugs: 'Paracetamol 500 mg', devices: '', diet: 'Soft', notes: 'Recovered' },
      followUp: null,
      signature: { signerTypedName: 'Dr. Meera Iyer', signedAt: '2099-05-04T06:00:00.000Z' },
      record: { diagnoses: [], medications: [], labs: [], labsNotFinal: 0 },
    }
    vi.mocked(getPortalDischargeSummary).mockResolvedValue(data)
    render(await DischargePage(admProps('12')))
    expect(screen.getByText('Dengue fever')).toBeInTheDocument()
    expect(screen.getByText('Paracetamol 500 mg')).toBeInTheDocument()
    expect(screen.getByText('XX-XXXX-XXXX-0123')).toBeInTheDocument()
    expect(screen.queryByText(/Administrative copy/)).toBeNull()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed discharge summary via patient portal', 'RD-0001', 'admission=12')
  })
})
