// WS7 T8 (spec D14): portal "Pay now" by UPI QR and the patient-reported UTR, against the real
// database. The portal creates a UPI request for a finalised invoice's outstanding amount; a
// patient-reported UTR is stored on the request only and never posts to the ledger. The cashier
// confirms it through the existing confirm route, which posts the one receipt. No response or
// audit row ever carries a UTR.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, invoices, patientPayments, patients, paymentRequests } from '@/db/schema'
import { purgeBillingFixtures } from '../db/billing-fixtures'

const h = vi.hoisted(() => ({ patient: null as string | null, allowed: true }))
vi.mock('@/lib/patient-session', () => ({
  requirePatientSession: vi.fn(async () => (h.patient ? { patientId: h.patient } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/rate-limit', () => ({ checkPortalPaymentRequestRateLimit: vi.fn(async () => ({ allowed: h.allowed })) }))
// The cashier's confirm route is the only caller of requireSession here; the portal routes must never call it.
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Desk Cashier', userId: null })) }))

import { POST as payNow } from '@/app/api/patient-portal/payments/upi-request/route'
import { POST as reportUtr } from '@/app/api/patient-portal/payments/[id]/reported-utr/route'
import { POST as confirmRoute } from '@/app/api/billing/payments/upi-request/[id]/confirm/route'
import { requireSession } from '@/lib/auth'
import { checkPortalPaymentRequestRateLimit } from '@/lib/rate-limit'
import { recordPayment } from '@/lib/queries/patient-ledger'
import { listPortalInvoices } from '@/lib/queries/patient-portal-records'
import { listPendingUpiRequests } from '@/lib/payments/manual-upi'
import { maskUtr } from '@/lib/payments/upi'
import type { InvoiceSnapshot } from '@/lib/billing/gst'

const TAG = `WS7T8${process.pid}`
const A = `${TAG}-A`
const B = `${TAG}-B`
const DESK = { role: 'frontdesk' as const, name: 'Desk Cashier', userId: null }
const utr = (n: number) => `${String(Date.now()).slice(-8)}${String(n).padStart(4, '0')}`

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' },
})
const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) })
const callPayNow = (body: unknown) => payNow(post('/api/patient-portal/payments/upi-request', body))
const callReport = (id: number | string, body: unknown) => reportUtr(post(`/api/patient-portal/payments/${id}/reported-utr`, body), ctx(id))

function snapshot(pid: string): InvoiceSnapshot {
  return {
    hospital: { legalName: 'Test Hospital', gstin: null, stateCode: 'IN-KA', gstStateCode: '29', address: null },
    patient: { id: pid, name: pid, uhid: null, addressLine1: null, addressLine2: null, city: null, district: null, stateCode: null, pinCode: null },
    payer: null,
    context: { encounterId: null, admissionId: null, label: 'OPD' },
  }
}
let invSeq = 0
async function finalisedInvoice(pid: string, totalPaise: number): Promise<number> {
  invSeq += 1
  const [row] = await getDb().insert(invoices).values({
    patientId: pid, status: 'finalised', createdByName: 'test', invoiceNumber: `${TAG}-${invSeq}`, invoiceDate: '2099-06-01', snapshot: snapshot(pid),
    totalPaise, taxablePaise: totalPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, supplyType: 'intra', finalisedAt: new Date(), financialYear: '2099-00',
  }).returning({ id: invoices.id })
  return row.id
}
const requestsOf = (pid: string) => getDb().select().from(paymentRequests).where(eq(paymentRequests.patientId, pid))
const receiptsOf = (pid: string) => getDb().select().from(patientPayments).where(eq(patientPayments.patientId, pid))
const auditsOf = (pid: string) => getDb().select().from(auditLog).where(eq(auditLog.patientId, pid))

async function purge() {
  await getDb().delete(paymentRequests).where(inArray(paymentRequests.patientId, [A, B]))
  await purgeBillingFixtures([A, B])
  await getDb().delete(auditLog).where(inArray(auditLog.patientId, [A, B]))
}

beforeAll(async () => {
  await getDb().insert(patients).values([
    { id: A, name: 'Portal Pay A', dob: '1980-01-01' },
    { id: B, name: 'Portal Pay B', dob: '1981-01-01' },
  ])
})

beforeEach(async () => {
  h.patient = A
  h.allowed = true
  vi.stubEnv('HOSPITAL_UPI_VPA', 'sunrise.hospital@icici')
  vi.stubEnv('HOSPITAL_UPI_PAYEE', 'Sunrise Hospital')
  vi.mocked(requireSession).mockClear()
  await purge()
})

afterAll(async () => {
  await purge()
  await getDb().delete(patients).where(inArray(patients.id, [A, B]))
  vi.unstubAllEnvs()
})

describe('maskUtr', () => {
  it('shows only the last four characters', () => {
    expect(maskUtr('412345671234')).toBe('••••1234')
    expect(maskUtr('UTR9876')).toBe('••••9876')
  })
})

describe('POST /api/patient-portal/payments/upi-request', () => {
  it('no patient session -> 401 before the rate limiter or any read', async () => {
    h.patient = null
    vi.mocked(checkPortalPaymentRequestRateLimit).mockClear()
    expect((await callPayNow({ invoiceId: 1 })).status).toBe(401)
    expect(checkPortalPaymentRequestRateLimit).not.toHaveBeenCalled()
  })

  it('rate limited -> 429 with nothing written', async () => {
    const inv = await finalisedInvoice(A, 50000)
    h.allowed = false
    expect((await callPayNow({ invoiceId: inv })).status).toBe(429)
    expect(await requestsOf(A)).toEqual([])
  })

  it('a strict body: unknown keys, a string or non-positive id are 400', async () => {
    for (const body of [{ invoiceId: 1, amountPaise: 5 }, { invoiceId: '1' }, { invoiceId: 0 }, {}, '{not json']) {
      expect((await callPayNow(body)).status).toBe(400)
    }
  })

  it('creates one portal request for the outstanding amount and reuses it on a second click', async () => {
    const inv = await finalisedInvoice(A, 50000)
    expect((await recordPayment({ patientId: A, kind: 'receipt', mode: 'cash', amountPaise: 20000, invoiceId: inv }, DESK)).ok).toBe(true)
    const res = await callPayNow({ invoiceId: inv })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['amountPaise', 'qrDataUrl', 'requestId', 'upiUri'])
    expect(body.amountPaise).toBe(30000)
    expect(body.upiUri).toMatch(/^upi:\/\/pay\?pa=sunrise\.hospital@icici&pn=Sunrise%20Hospital&am=300\.00&cu=INR&tn=/)
    expect(body.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    const rows = await requestsOf(A)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: body.requestId, source: 'portal', createdBy: 'Patient portal', createdByUserId: null, invoiceId: inv, amountPaise: 30000, status: 'pending', reportedUtr: null })
    const again = await callPayNow({ invoiceId: inv })
    expect(again.status).toBe(201)
    expect((await again.json()).requestId).toBe(body.requestId)
    expect(await requestsOf(A)).toHaveLength(1)
    const audits = (await auditsOf(A)).filter((a) => a.action === 'patient portal: created UPI payment request')
    expect(audits.length).toBeGreaterThan(0)
    expect(audits[0]).toMatchObject({ userName: 'Patient (self-service)', details: `request=${body.requestId} invoice=${inv} amount=30000` })
    expect(requireSession).not.toHaveBeenCalled()
  })

  it("another patient's invoice is a 404 with nothing written", async () => {
    const invB = await finalisedInvoice(B, 50000)
    const res = await callPayNow({ invoiceId: invB })
    expect([res.status, await res.json()]).toEqual([404, { error: 'Bill not found' }])
    expect(await requestsOf(A)).toEqual([])
    expect(await requestsOf(B)).toEqual([])
  })

  it('a fully paid bill is a 409', async () => {
    const inv = await finalisedInvoice(A, 50000)
    expect((await recordPayment({ patientId: A, kind: 'receipt', mode: 'cash', amountPaise: 50000, invoiceId: inv }, DESK)).ok).toBe(true)
    const res = await callPayNow({ invoiceId: inv })
    expect([res.status, await res.json()]).toEqual([409, { error: 'This bill is already paid' }])
    expect(await requestsOf(A)).toEqual([])
  })

  it('UPI not configured -> 503 with the UPI message', async () => {
    const inv = await finalisedInvoice(A, 50000)
    vi.stubEnv('HOSPITAL_UPI_VPA', '')
    const res = await callPayNow({ invoiceId: inv })
    expect([res.status, await res.json()]).toEqual([503, { error: 'UPI is not set up. Ask your administrator.' }])
    expect(await requestsOf(A)).toEqual([])
  })
})

describe('POST /api/patient-portal/payments/[id]/reported-utr', () => {
  async function portalRequest(totalPaise = 50000): Promise<{ invoiceId: number; requestId: number }> {
    const invoiceId = await finalisedInvoice(A, totalPaise)
    const res = await callPayNow({ invoiceId })
    expect(res.status).toBe(201)
    return { invoiceId, requestId: (await res.json()).requestId }
  }

  it('stores the normalised UTR on the request only: no receipt, no UTR in the response or the audit', async () => {
    const { requestId } = await portalRequest()
    const ref = utr(1)
    const spaced = `${ref.slice(0, 4)} ${ref.slice(4, 8)}-${ref.slice(8)}`
    const res = await callReport(requestId, { utr: spaced })
    const text = await res.text()
    expect([res.status, JSON.parse(text)]).toEqual([200, { ok: true }])
    expect(text).not.toContain(ref.slice(-4))
    const [row] = await requestsOf(A)
    expect(row).toMatchObject({ reportedUtr: ref, utr: null, status: 'pending', paymentId: null })
    expect(row.reportedAt).toBeInstanceOf(Date)
    expect(await receiptsOf(A)).toEqual([])
    const audits = await auditsOf(A)
    expect(audits.some((a) => a.action === 'patient portal: reported UPI payment' && a.details === `request=${requestId}`)).toBe(true)
    for (const a of audits) expect(`${a.action} ${a.details ?? ''}`).not.toContain(ref)
    expect(requireSession).not.toHaveBeenCalled()
  })

  it("the patient cannot report on another patient's request (404, nothing stored); bad ids are 404", async () => {
    const { requestId } = await portalRequest()
    h.patient = B
    const res = await callReport(requestId, { utr: utr(2) })
    expect([res.status, await res.json()]).toEqual([404, { error: 'Payment request not found' }])
    const [row] = await requestsOf(A)
    expect(row.reportedUtr).toBeNull()
    expect((await callReport('abc', { utr: utr(2) })).status).toBe(404)
    expect((await callReport(2_147_483_647, { utr: utr(2) })).status).toBe(404)
  })

  it('a malformed UTR or an extra key is a 400 that never echoes the input', async () => {
    const { requestId } = await portalRequest()
    for (const body of [{ utr: 'x!' }, { utr: utr(3), amountPaise: 1 }, {}]) {
      const res = await callReport(requestId, body)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('x!')
    }
  })

  it('a confirmed or cancelled request is a 409', async () => {
    const { requestId } = await portalRequest()
    await getDb().update(paymentRequests).set({ status: 'cancelled' }).where(eq(paymentRequests.id, requestId))
    expect((await callReport(requestId, { utr: utr(4) })).status).toBe(409)
  })

  it("the cashier's confirm with the reported UTR posts one receipt and the portal bill shows paid", async () => {
    const { invoiceId, requestId } = await portalRequest(75000)
    const ref = utr(5)
    expect((await callReport(requestId, { utr: ref })).status).toBe(200)
    // The Cash Desk list shows the reported UTR masked, never in full.
    const pending = await listPendingUpiRequests(A)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ id: requestId, source: 'portal', amountPaise: 75000, reportedUtrMasked: maskUtr(ref) })
    expect(JSON.stringify(pending)).not.toContain(ref)
    const confirmed = await confirmRoute(post(`/api/billing/payments/upi-request/${requestId}/confirm`, { utr: ref }), ctx(requestId))
    expect(confirmed.status).toBe(201)
    const receipts = await receiptsOf(A)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ mode: 'upi', reference: ref, amountPaise: 75000, invoiceId })
    const [bill] = (await listPortalInvoices(A)).filter((i) => i.id === invoiceId)
    expect(bill).toMatchObject({ totalPaise: 75000, paidPaise: 75000, outstandingPaise: 0 })
    expect(await listPendingUpiRequests(A)).toEqual([])
    expect((await callPayNow({ invoiceId })).status).toBe(409)
  })

  it('a UTR already used on another receipt is refused at confirm (409) with no extra receipt', async () => {
    const ref = utr(6)
    expect((await recordPayment({ patientId: B, kind: 'receipt', mode: 'upi', reference: ref, amountPaise: 1000 }, DESK)).ok).toBe(true)
    const { requestId } = await portalRequest()
    expect((await callReport(requestId, { utr: ref })).status).toBe(200)
    const res = await confirmRoute(post(`/api/billing/payments/upi-request/${requestId}/confirm`, { utr: ref }), ctx(requestId))
    expect([res.status, await res.json()]).toEqual([409, { error: 'This UTR has already been recorded' }])
    expect(await receiptsOf(A)).toEqual([])
  })
})
