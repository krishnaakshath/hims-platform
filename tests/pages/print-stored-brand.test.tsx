import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import type { Session } from '@/lib/auth'
import type { BrandSettingsInput } from '@/lib/brand-snapshot'
import type { InvoiceDetail } from '@/lib/queries/invoices'

// WL T10 (group 2): printed documents read the brand at request time (getBrand): the slips, the
// prescription and the discharge summary print the stored header text, logo, footer and signature
// line; invoices and receipts add only the logo, footer and signature line and keep the billing
// legal name (spec D3). With no stored brand nothing extra prints.

class NotFound extends Error {}
class Redirect extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (to: string) => { throw new Redirect(to) },
}))
const state = vi.hoisted(() => ({ role: 'admin' as string }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test WL T10', userId: null })) }))
vi.mock('@/lib/audit', async (orig) => ({ ...(await orig<object>()), logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/print-slips', () => ({
  getTokenSlip: vi.fn(async () => ({
    encounterId: 55, opdToken: 17, encounterType: 'opd', encounterDate: '2026-10-08', checkedInAt: new Date('2026-10-08T04:00:00Z'),
    patient: { id: 'RD-0042', name: 'Asha Rao', uhid: 'UH00000042' }, doctorName: 'Dr. Meera Iyer', departmentName: 'General Medicine', room: null,
  })),
  getRegistrationSlip: vi.fn(async () => ({ id: 'RD-0042', name: 'Asha Rao', uhid: 'UH00000042', registeredAt: new Date('2026-10-07T20:00:00Z') })),
  getPatientDocumentIdentity: vi.fn(async () => ({ id: 'RD-0042', name: 'Asha Rao', uhid: 'UH00000042', dob: '1980-10-03', gender: 'female' })),
}))
vi.mock('@/lib/queries/prescriptions', () => ({
  getPrintablePrescriptions: vi.fn(async () => [{
    id: 1, patientId: 'RD-0042', name: 'Amoxicillin', medicationClass: 'Antibiotic', dose: '500 mg', frequencyPerDay: 3, durationDays: 5,
    instructions: null, prescribedAt: new Date('2026-10-08T04:00:00Z'), enteredByName: null,
    prescriber: { name: 'Dr. Meera Iyer', credentials: 'MBBS', specialty: 'General Medicine' }, prescriberRegistration: 'SMC IN-MH 12345',
  }]),
}))

const PARTIES = {
  hospital: { legalName: 'Sunrise Hospital Pvt Ltd', gstin: '29AAGCB7383J1Z4', stateCode: 'IN-KA', gstStateCode: '29', address: '12 MG Road, Bengaluru' },
  patient: { id: 'RD-0001', name: 'Asha Rao', uhid: 'HMS-000123', addressLine1: '4 Lake View', addressLine2: null, city: 'Mysuru', district: null, stateCode: 'IN-KA', pinCode: '570001' },
  payer: null,
  context: { encounterId: 5, admissionId: null, label: 'Outpatient visit (visit 5)' },
}
const INVOICE = {
  id: 7, invoiceNumber: 'INV/99-00/000001', status: 'finalised', patientId: 'RD-0001', encounterId: 5, admissionId: null, payerId: null,
  financialYear: '2099-00', invoiceDate: '2099-06-01', documentTitle: 'Tax Invoice', supplyType: 'intra', placeOfSupplyStateCode: 'IN-KA',
  snapshot: PARTIES, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, totalPaise: 0,
  createdByName: 'Clerk', createdAt: new Date('2099-06-01T05:00:00Z'), finalisedAt: new Date('2099-06-01T06:00:00Z'), finalisedByName: 'Biller',
  cancelledAt: null, cancelledByName: null, discardedAt: null, discardedByName: null,
  lines: [], creditNote: null, patientName: 'Asha Rao', uhid: 'HMS-000123', estimated: false,
  parties: PARTIES, place: { stateCode: 'IN-KA', supplyType: 'intra' },
} as unknown as InvoiceDetail
vi.mock('@/lib/queries/invoices', () => ({ getInvoice: vi.fn(async () => INVOICE) }))

const BRAND_VARS = ['BRAND_NAME', 'BRAND_LEGAL_NAME', 'BRAND_LOGO_URL']
const LOGO_SRC = /^\/branding\/logo-light-[0-9a-f]{16}\.png$/

describe.skipIf(!process.env.DATABASE_URL)('printed documents read the stored brand (DB)', () => {
  const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const ACTOR = `TEST-WL-T10-PRINT-${RUN}`
  const session: Session = { role: 'admin', name: ACTOR, userId: null }

  const blank = (over: Partial<BrandSettingsInput> = {}): BrandSettingsInput => ({
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
    printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null, ...over,
  })

  beforeEach(() => {
    for (const k of BRAND_VARS) vi.stubEnv(k, '')
    vi.resetModules()
    state.role = 'admin'
  })

  afterEach(async () => {
    cleanup()
    const { resetBrandSettings } = await import('@/lib/queries/brand-settings')
    await resetBrandSettings(null)
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { auditLog } = await import('@/db/schema')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(auditLog).where(eq(auditLog.userName, ACTOR))
  })

  async function storeSunrise() {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const r = await q.updateBrandSettings(blank({
      displayName: 'Sunrise', printHeaderText: 'Sunrise Hospital, Pune', printFooterText: 'NABH accredited. Emergency: 020 4000 1000',
      printSignatureLine: 'Medical Superintendent',
    }), 0, session)
    expect(r.ok).toBe(true)
    await q.putBrandAsset('logo_light', {
      source: 'upload', blobUrl: `local:branding/test-${RUN}.png`, sha256: 'd4'.repeat(32), width: 400, height: 100, byteSize: 1234,
    }, session)
  }

  async function reset() {
    const q = await import('@/lib/queries/brand-settings')
    await q.resetBrandSettings(null)
    const { getBrand } = await import('@/lib/brand-server')
    return getBrand()
  }

  function expectBranded(container: HTMLElement) {
    expect(screen.getByText('Sunrise Hospital, Pune')).toBeInTheDocument()
    expect(screen.getByText('NABH accredited. Emergency: 020 4000 1000')).toBeInTheDocument()
    expect(screen.getByText('Medical Superintendent')).toBeInTheDocument()
    const logos = container.querySelectorAll('img')
    expect(logos.length).toBe(1)
    expect(logos[0].getAttribute('src')).toMatch(LOGO_SRC)
    expect(container.innerHTML).not.toContain('local:')
  }

  function expectUnbranded(container: HTMLElement) {
    expect(screen.queryByText('Sunrise Hospital, Pune')).toBeNull()
    expect(screen.queryByText('Medical Superintendent')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
  }

  it('token slip: stored header, logo, footer and signature line; none of them with no stored brand', async () => {
    await storeSunrise()
    const TokenSlipPage = (await import('@/app/print/token/[encounterId]/page')).default
    const first = render(await TokenSlipPage({ params: Promise.resolve({ encounterId: '55' }) }))
    expectBranded(first.container)
    first.unmount()

    const b = await reset()
    const { container } = render(await TokenSlipPage({ params: Promise.resolve({ encounterId: '55' }) }))
    expect(screen.getByText(b.print.headerText)).toBeInTheDocument()
    expectUnbranded(container)
  })

  it('registration slip: stored header, logo, footer and signature line', async () => {
    await storeSunrise()
    const RegistrationSlipPage = (await import('@/app/print/registration/[anonId]/page')).default
    const { container } = render(await RegistrationSlipPage({ params: Promise.resolve({ anonId: 'RD-0042' }) }))
    expectBranded(container)
  })

  it('prescription print: stored header, logo with a /branding/ src, footer and signature line', async () => {
    state.role = 'pi'
    await storeSunrise()
    const PrescriptionPrintPage = (await import('@/app/prescriptions/print/page')).default
    const { container } = render(await PrescriptionPrintPage({ searchParams: Promise.resolve({ ids: '1' }) }))
    expectBranded(container)
    expect(screen.getByText(/This printout is a record of a prescription entered in Sunrise\./)).toBeInTheDocument()
  })

  it('prescription print with no stored brand: the resolved header, no logo, no footer or signature line', async () => {
    state.role = 'pi'
    const b = await reset()
    const PrescriptionPrintPage = (await import('@/app/prescriptions/print/page')).default
    const { container } = render(await PrescriptionPrintPage({ searchParams: Promise.resolve({ ids: '1' }) }))
    expect(screen.getByText(b.print.headerText)).toBeInTheDocument()
    expect(screen.getByText(`This printout is a record of a prescription entered in ${b.name}. It was not transmitted electronically to a pharmacy.`)).toBeInTheDocument()
    expectUnbranded(container)
  })

  it('invoice print keeps the billing legal name and adds the logo, footer and signature line', async () => {
    await storeSunrise()
    const PrintInvoicePage = (await import('@/app/print/invoices/[id]/page')).default
    const { container } = render(await PrintInvoicePage({ params: Promise.resolve({ id: '7' }) }))
    const header = container.querySelector('header')!
    expect(within(header).getByText('Sunrise Hospital Pvt Ltd')).toBeInTheDocument()
    expect(screen.queryByText('Sunrise Hospital, Pune')).toBeNull()
    expect(screen.getByText('For Sunrise Hospital Pvt Ltd')).toBeInTheDocument()
    expect(screen.getByText('NABH accredited. Emergency: 020 4000 1000')).toBeInTheDocument()
    expect(screen.getByText('Medical Superintendent')).toBeInTheDocument()
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(LOGO_SRC)
  })

  it('invoice print with no stored brand is today\'s document: authorised signatory, no logo, no footer text', async () => {
    await reset()
    const PrintInvoicePage = (await import('@/app/print/invoices/[id]/page')).default
    const { container } = render(await PrintInvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(screen.getByText('Authorised signatory')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
