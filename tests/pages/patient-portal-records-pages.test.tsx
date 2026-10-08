// Wave J (P1-20): the portal list pages read only the session patient's records, render
// rupees and IST dates, link to the owner-checked document views and audit the view.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND') } }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logPatientPortalAction: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/patient-portal-records', () => ({
  listPortalInvoices: vi.fn(async () => []),
  listPortalReceipts: vi.fn(async () => []),
  listPortalDischarges: vi.fn(async () => []),
  listPortalPrescriptions: vi.fn(async () => []),
  listPortalPolicies: vi.fn(async () => []),
  getPortalAbhaStatus: vi.fn(async () => ({ abhaNumberMasked: null, abhaAddress: null, unavailableReason: null })),
}))

import BillsPage from '@/app/patient-portal/(authenticated)/bills/page'
import DischargePage from '@/app/patient-portal/(authenticated)/discharge-summaries/page'
import PrescriptionsPage from '@/app/patient-portal/(authenticated)/prescriptions/page'
import InsurancePage from '@/app/patient-portal/(authenticated)/insurance/page'
import * as q from '@/lib/queries/patient-portal-records'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'

beforeEach(() => {
  vi.mocked(logPatientPortalAction).mockClear()
})

describe('/patient-portal/bills', () => {
  it('lists own bills and receipts with rupee totals and document links', async () => {
    vi.mocked(q.listPortalInvoices).mockResolvedValueOnce([{ id: 11, invoiceNumber: 'INV/2026-27/000011', invoiceDate: '2026-10-08', documentTitle: 'Tax Invoice', totalPaise: 123456 }])
    vi.mocked(q.listPortalReceipts).mockResolvedValueOnce([{ id: 4, receiptNumber: 'RCT/2026-27/000004', kind: 'advance', receiptDate: '2026-10-07', mode: 'upi', amountPaise: 500000 }])
    render(await BillsPage())
    expect(q.listPortalInvoices).toHaveBeenCalledWith('RD-0001')
    expect(q.listPortalReceipts).toHaveBeenCalledWith('RD-0001')
    expect(screen.getByText('₹1,234.56')).toBeInTheDocument()
    expect(screen.getByText('₹5,000.00')).toBeInTheDocument()
    expect(screen.getByText(/8 Oct 2026/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /bill INV\/2026-27\/000011/ })).toHaveAttribute('href', '/patient-portal/documents/invoices/11')
    expect(screen.getByRole('link', { name: /receipt RCT\/2026-27\/000004/ })).toHaveAttribute('href', '/patient-portal/documents/receipts/4')
    expect(screen.getByText(/Advance · UPI/)).toBeInTheDocument()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed patient portal bills', 'RD-0001')
  })

  it('shows empty states', async () => {
    render(await BillsPage())
    expect(screen.getByText(/No bills yet/)).toBeInTheDocument()
    expect(screen.getByText('No payments recorded yet.')).toBeInTheDocument()
  })
})

describe('/patient-portal/discharge-summaries', () => {
  it('links signed summaries and marks unsigned ones as being prepared', async () => {
    vi.mocked(q.listPortalDischarges).mockResolvedValueOnce([
      { admissionId: 3, admittedAt: new Date('2026-09-01T05:00:00Z'), dischargedAt: new Date('2026-09-04T05:00:00Z'), doctorName: 'Dr. Meera Iyer', signed: true },
      { admissionId: 9, admittedAt: new Date('2026-10-01T05:00:00Z'), dischargedAt: new Date('2026-10-03T05:00:00Z'), doctorName: 'Dr. Rao', signed: false },
    ])
    render(await DischargePage())
    expect(q.listPortalDischarges).toHaveBeenCalledWith('RD-0001')
    const links = screen.getAllByRole('link', { name: /view summary/i })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/patient-portal/documents/discharge/3'])
    expect(screen.getByText('Being prepared by your doctor')).toBeInTheDocument()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed patient portal discharge summaries', 'RD-0001')
  })
})

describe('/patient-portal/prescriptions', () => {
  it('splits current and past and shows the schedule and prescriber', async () => {
    vi.mocked(q.listPortalPrescriptions).mockResolvedValueOnce([
      { id: 1, name: 'Metformin', dose: '500 mg', frequencyPerDay: 2, durationDays: 30, instructions: 'After food', startDate: '2026-10-01', stopDate: null, status: 'active', prescribedAt: new Date('2026-10-01T05:00:00Z'), prescriberName: 'Dr. Meera Iyer' },
      { id: 2, name: 'Amoxicillin', dose: null, frequencyPerDay: null, durationDays: null, instructions: null, startDate: '2026-08-01', stopDate: '2026-08-07', status: 'inactive', prescribedAt: new Date('2026-08-01T05:00:00Z'), prescriberName: null },
    ])
    render(await PrescriptionsPage())
    expect(q.listPortalPrescriptions).toHaveBeenCalledWith('RD-0001')
    expect(screen.getByText('500 mg · 2 times a day · for 30 days')).toBeInTheDocument()
    expect(screen.getByText('After food')).toBeInTheDocument()
    expect(screen.getByText(/Prescribed 1 Oct 2026 by Dr. Meera Iyer/)).toBeInTheDocument()
    expect(screen.getByText('As directed')).toBeInTheDocument()
    expect(screen.getByText(/until 7 Aug 2026/)).toBeInTheDocument()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed patient portal prescriptions', 'RD-0001')
  })
})

describe('/patient-portal/insurance', () => {
  it('shows policies read-only and the masked ABHA', async () => {
    vi.mocked(q.listPortalPolicies).mockResolvedValueOnce([{
      id: 1, insurerName: 'Star Health', tpaName: 'Medi Assist', policyNumber: 'P-123', memberId: 'M-9', planName: 'Family Optima', policyType: 'family_floater',
      corporateName: null, holderName: 'Asha Rao', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: 50000000, priority: 'primary', status: 'active',
    }])
    vi.mocked(q.getPortalAbhaStatus).mockResolvedValueOnce({ abhaNumberMasked: 'XX-XXXX-XXXX-0123', abhaAddress: 'asha@abdm', unavailableReason: null })
    render(await InsurancePage())
    expect(q.listPortalPolicies).toHaveBeenCalledWith('RD-0001')
    expect(screen.getByText(/Star Health · Family Optima/)).toBeInTheDocument()
    expect(screen.getByText('₹5,00,000.00')).toBeInTheDocument()
    expect(screen.getByText('Medi Assist')).toBeInTheDocument()
    expect(screen.getByText('XX-XXXX-XXXX-0123')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    expect(logPatientPortalAction).toHaveBeenCalledWith('viewed patient portal insurance', 'RD-0001')
  })

  it('explains a missing ABHA', async () => {
    vi.mocked(q.getPortalAbhaStatus).mockResolvedValueOnce({ abhaNumberMasked: null, abhaAddress: null, unavailableReason: 'patient_declined' })
    render(await InsurancePage())
    expect(screen.getByText(/You chose not to link one/)).toBeInTheDocument()
    expect(screen.getByText(/No insurance policy on file/)).toBeInTheDocument()
  })
})
