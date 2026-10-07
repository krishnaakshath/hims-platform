import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'

let role: Role = 'crc'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`) })
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirect(p),
  notFound: () => { throw new Error('NOT_FOUND') },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/charge-capture', () => ({
  listCaptureContexts: vi.fn(),
  getCaptureHeader: vi.fn(),
  listChargeLinesForContext: vi.fn(async () => []),
  listUnbilledPharmacyPatients: vi.fn(async () => []),
  getPharmacyCaptureView: vi.fn(),
}))
vi.mock('@/components/billing/ChargeCaptureForm', () => ({ ChargeCaptureForm: vi.fn(() => <div data-testid="capture-form" />) }))
vi.mock('@/components/billing/ChargeLinesTable', () => ({ ChargeLinesTable: vi.fn(() => <div data-testid="lines-table" />) }))
vi.mock('@/components/billing/RoomRentButton', () => ({ RoomRentButton: vi.fn(() => <button type="button">Post room rent to date</button>) }))

import { getCaptureHeader, getPharmacyCaptureView, listCaptureContexts, listChargeLinesForContext, listUnbilledPharmacyPatients } from '@/lib/queries/charge-capture'
import { ChargeLinesTable } from '@/components/billing/ChargeLinesTable'
import { ChargeCaptureForm } from '@/components/billing/ChargeCaptureForm'
import { logAudit } from '@/lib/audit'
import CapturePage from '@/app/(dashboard)/billing/capture/page'

const page = async (sp: Record<string, string>) => render(await CapturePage({ searchParams: Promise.resolve(sp) }))

const HEADER = {
  patientId: 'RD-0001', patientName: 'Asha Rao', uhid: 'HMS-000123', label: 'Inpatient stay (admitted 30 May 2099)',
  payerName: 'Star Health', depositPaise: 500000, kind: 'admission' as const, primaryPayerId: 4,
}

beforeEach(() => {
  role = 'crc'
  vi.clearAllMocks()
  vi.mocked(listCaptureContexts).mockResolvedValue({ encounters: [], admissions: [] })
  vi.mocked(getCaptureHeader).mockResolvedValue(HEADER)
})

describe('/billing/capture', () => {
  it('lists today\'s visits and admitted patients with links, and empty states', async () => {
    vi.mocked(listCaptureContexts).mockResolvedValue({
      encounters: [{ id: 7, patientId: 'RD-0002', patientName: 'Ravi Kumar', uhid: 'HMS-000200', opdToken: 4, departmentName: 'General Medicine', providerName: 'Dr Iyer' }],
      admissions: [],
    })
    await page({})
    expect(screen.getByRole('link', { name: /Ravi Kumar/ })).toHaveAttribute('href', '/billing/capture?encounterId=7')
    expect(screen.getByText('No patients admitted.')).toBeInTheDocument()
  })

  it('shows the header, lines and form for an admission, with room rent', async () => {
    await page({ admissionId: '12' })
    expect(getCaptureHeader).toHaveBeenCalledWith({ admissionId: 12 })
    expect(listChargeLinesForContext).toHaveBeenCalledWith({ admissionId: 12 })
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/HMS-000123/)).toBeInTheDocument()
    expect(screen.getByText('Star Health')).toBeInTheDocument()
    expect(screen.getByText('₹5,000.00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Post room rent to date' })).toBeInTheDocument()
    expect(vi.mocked(ChargeCaptureForm).mock.calls[0][0]).toMatchObject({ context: { admissionId: 12 }, canOverride: false, hasPayer: true })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: viewed charge capture', 'RD-0001')
  })

  it('billing may override prices', async () => {
    role = 'billing'
    await page({ encounterId: '3' })
    expect(vi.mocked(ChargeCaptureForm).mock.calls[0][0]).toMatchObject({ context: { encounterId: 3 }, canOverride: true })
  })

  it.each([[{ encounterId: 'abc' }], [{ admissionId: '0' }], [{ encounterId: '1', admissionId: '2' }]])('a bad id is a 404: %o', async (sp) => {
    await expect(page(sp)).rejects.toThrow('NOT_FOUND')
    expect(getCaptureHeader).not.toHaveBeenCalled()
  })

  it('an unknown context is a 404', async () => {
    vi.mocked(getCaptureHeader).mockResolvedValue(null)
    await expect(page({ encounterId: '99' })).rejects.toThrow('NOT_FOUND')
  })

  it('redirects a denied role before loading anything', async () => {
    role = 'frontdesk'
    await expect(page({})).rejects.toThrow('REDIRECT /')
    expect(listCaptureContexts).not.toHaveBeenCalled()
  })

  // Pharmacy bills of a patient who is not admitted carry no visit or stay; without this view
  // nothing could put them on an invoice.
  it('lists patients with unbilled pharmacy charges and opens their lines without a capture form', async () => {
    vi.mocked(listUnbilledPharmacyPatients).mockResolvedValue([{ patientId: 'RD-0005', patientName: 'Meena Das', uhid: 'HMS-000500', lineCount: 2, taxablePaise: 3000 }])
    await page({})
    expect(screen.getByRole('link', { name: /Meena Das/ })).toHaveAttribute('href', '/billing/capture?patientId=RD-0005')
    vi.mocked(getPharmacyCaptureView).mockResolvedValue({
      patientId: 'RD-0005', patientName: 'Meena Das', uhid: 'HMS-000500',
      lines: [{ id: 9, serviceDate: '2099-06-01', itemCode: 'J3490', itemName: 'Drug', quantity: 2, unitPricePaise: 1500, taxablePaise: 3000, priceSource: 'pharmacy', status: 'captured', invoiceId: null, source: 'pharmacy', violations: [], voidReason: null }],
    } as never)
    await page({ patientId: 'RD-0005' })
    expect(getPharmacyCaptureView).toHaveBeenCalledWith('RD-0005')
    expect(vi.mocked(ChargeLinesTable).mock.calls.at(-1)![0].lines.map((l: { id: number }) => l.id)).toEqual([9])
    expect(vi.mocked(ChargeCaptureForm)).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: viewed charge capture', 'RD-0005')
  })

  it('a pharmacy view with a bad or unknown patient id is a 404', async () => {
    await expect(page({ patientId: 'bad id!' })).rejects.toThrow('NOT_FOUND')
    await expect(page({ patientId: 'RD-1', encounterId: '2' })).rejects.toThrow('NOT_FOUND')
    vi.mocked(getPharmacyCaptureView).mockResolvedValue(null)
    await expect(page({ patientId: 'RD-9' })).rejects.toThrow('NOT_FOUND')
  })
})
