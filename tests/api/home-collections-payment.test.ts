// WS6 T12: payment at the door -- POST /api/home-collections/[id]/payment and .../payment/confirm,
// against the test DB (real ledger, real UPI request/confirm) with only the session mocked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Session } from '@/lib/auth'

let session: Session = { role: 'collector', name: 'placeholder', userId: null }
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => session) }))

import { POST as PAY } from '@/app/api/home-collections/[id]/payment/route'
import { POST as CONFIRM } from '@/app/api/home-collections/[id]/payment/confirm/route'
import { getDb } from '@/db/client'
import { auditLog, homeCollectionVisits, homeCollectionWindows, patientPayments, patients, paymentRequests, users } from '@/db/schema'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { todayIsoIn } from '@/lib/india-time'

const RUN = `${Date.now()}`
const TAG = RUN.slice(-6)
const PROBE_COL = `TEST_WS6_PAY_COL-${RUN}`
const PROBE_COL2 = `TEST_WS6_PAY_COL2-${RUN}`
const P = Array.from({ length: 12 }, (_, i) => `TEST-WS6-PAY-${RUN}-${i}`)
let nextP = 0
const fresh = () => P[nextP++]
/** Random 12-digit UTRs (not derived from RUN, which appears in names and audit rows). */
const randomUtr = () => String(100_000_000_000 + Math.floor(Math.random() * 899_999_999_999))
const UTR = randomUtr()
const UTR2 = randomUtr()

let windowId = 0
let colUser = 0
let colUser2 = 0
let COL: Session
let COL2: Session
const TODAY = todayIsoIn()

const post = (handler: typeof PAY, path: string, id: number | string, body: unknown) =>
  handler(new NextRequest(`http://localhost/api/home-collections/${id}/${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) })
const pay = (id: number | string, body: unknown) => post(PAY, 'payment', id, body)
const confirm = (id: number | string, body: unknown) => post(CONFIRM, 'payment/confirm', id, body)

async function visitFor(patientId: string, over: Partial<typeof homeCollectionVisits.$inferInsert> = {}) {
  const [v] = await getDb().insert(homeCollectionVisits).values({
    patientId, visitDate: TODAY, windowId, windowLabel: `TEST-WS6-${TAG}-w`, windowStart: '10:00', windowEnd: '12:00',
    addressLine1: '12 Test Road', city: 'Test City', stateCode: 'IN-KA', pinCode: '990001',
    contactPhone: '+919845013210', bookedByName: PROBE_COL, collectorUserId: colUser, ...over,
  }).returning()
  return v
}
const paymentsOf = (patientId: string) => getDb().select().from(patientPayments).where(eq(patientPayments.patientId, patientId))

const savedVpa = process.env.HOSPITAL_UPI_VPA
const logSpies: ReturnType<typeof vi.spyOn>[] = []

describe.skipIf(!process.env.DATABASE_URL)('home collection payment at the door (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values(P.map((id, i) => ({
      id, name: `Meena Iyer${TAG}x${i}`, dob: '1975-01-09', gender: 'female' as const, phone: '+919845013210',
      addressLine1: 'Reg line', city: 'Reg City', stateCode: 'IN-KA', pinCode: '990001', uhid: `TWS6PY${TAG}${i}`,
    })))
    const [w] = await db.insert(homeCollectionWindows).values({ label: `TEST-WS6-${TAG}-w`, startTime: '10:00', endTime: '12:00', capacity: 50 }).returning()
    windowId = w.id
    const us = await db.insert(users).values([
      { name: PROBE_COL, email: `test-ws6-pay-col-${RUN}@example.invalid`, role: 'collector' },
      { name: PROBE_COL2, email: `test-ws6-pay-col2-${RUN}@example.invalid`, role: 'collector' },
    ]).returning()
    ;[colUser, colUser2] = us.map((u) => u.id)
    COL = { role: 'collector', name: PROBE_COL, userId: colUser }
    COL2 = { role: 'collector', name: PROBE_COL2, userId: colUser2 }
  })

  afterAll(async () => {
    const db = getDb()
    if (savedVpa === undefined) delete process.env.HOSPITAL_UPI_VPA
    else process.env.HOSPITAL_UPI_VPA = savedVpa
    // Receipts are immutable; the purge switch is the test-only path (as in manual-upi.test.ts).
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      await tx.delete(paymentRequests).where(inArray(paymentRequests.patientId, P))
      await tx.delete(patientPayments).where(inArray(patientPayments.patientId, P))
    })
    await db.delete(homeCollectionVisits).where(inArray(homeCollectionVisits.patientId, P))
    await db.delete(homeCollectionWindows).where(eq(homeCollectionWindows.id, windowId))
    await db.delete(auditLog).where(inArray(auditLog.userName, [PROBE_COL, PROBE_COL2]))
    await db.delete(users).where(inArray(users.id, [colUser, colUser2]))
    await db.delete(patients).where(inArray(patients.id, P))
  })

  beforeEach(() => {
    session = COL
    process.env.HOSPITAL_UPI_VPA = 'hospital.test@ybl'
    for (const m of ['log', 'warn', 'error', 'info'] as const) logSpies.push(vi.spyOn(console, m))
  })
  afterEach(() => {
    // The UTR never reaches a log line.
    for (const spy of logSpies) expect(JSON.stringify(spy.mock.calls)).not.toMatch(new RegExp(`${UTR}|${UTR2}`))
    for (const spy of logSpies.splice(0)) spy.mockRestore()
  })

  it('cash posts exactly one receipt (mode cash, RCT number) with the visit note', async () => {
    const visit = await visitFor(fresh())
    const res = await pay(visit.id, { mode: 'cash', amountPaise: 45000 })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['receiptNumber'])
    expect(body.receiptNumber).toMatch(/^RCT\//)
    const rows = await paymentsOf(visit.patientId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ receiptNumber: body.receiptNumber, kind: 'receipt', mode: 'cash', amountPaise: 45000, reference: `Home collection visit #${visit.id}`, receivedByName: PROBE_COL })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_COL), eq(auditLog.patientId, visit.patientId)))
    expect(audits.map((a) => a.details)).toContain(`visit=${visit.id} mode=cash receipt=${body.receiptNumber} amount=45000`)
  })

  it('UPI shows a QR; confirm with a UTR posts one receipt; the same UTR again is a 409 with no second row', async () => {
    const visit = await visitFor(fresh())
    const res = await pay(visit.id, { mode: 'upi', amountPaise: 30000 })
    expect(res.status).toBe(201)
    const qr = await res.json()
    expect(Object.keys(qr).sort()).toEqual(['amountPaise', 'qrDataUrl', 'requestId'])
    expect(qr.qrDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(qr.amountPaise).toBe(30000)
    const [request] = await getDb().select().from(paymentRequests).where(eq(paymentRequests.id, qr.requestId))
    expect(request).toMatchObject({ patientId: visit.patientId, amountPaise: 30000, note: `Home collection visit #${visit.id}`, status: 'pending' })
    expect(await paymentsOf(visit.patientId)).toHaveLength(0)

    const ok = await confirm(visit.id, { requestId: qr.requestId, utr: UTR })
    expect(ok.status).toBe(201)
    const receipt = await ok.json()
    expect(Object.keys(receipt)).toEqual(['receiptNumber'])
    expect(JSON.stringify(receipt)).not.toContain(UTR)
    const rows = await paymentsOf(visit.patientId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ receiptNumber: receipt.receiptNumber, mode: 'upi', amountPaise: 30000 })

    // A second QR for the same visit, confirmed with the UTR already used.
    const again = await (await pay(visit.id, { mode: 'upi', amountPaise: 30000 })).json()
    const dup = await confirm(visit.id, { requestId: again.requestId, utr: UTR })
    expect([dup.status, await dup.json()]).toEqual([409, { error: 'This UTR has already been recorded' }])
    expect(await paymentsOf(visit.patientId)).toHaveLength(1)

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, visit.patientId))
    expect(JSON.stringify(audits)).not.toContain(UTR)
  })

  it("a request raised for another patient cannot be confirmed on this visit (404, nothing posted)", async () => {
    const mine = await visitFor(fresh())
    const other = await visitFor(fresh())
    const qr = await (await pay(other.id, { mode: 'upi', amountPaise: 20000 })).json()
    const res = await confirm(mine.id, { requestId: qr.requestId, utr: UTR2 })
    expect([res.status, await res.json()]).toEqual([404, { error: 'Payment request not found' }])
    expect(await paymentsOf(mine.patientId)).toHaveLength(0)
    expect(await paymentsOf(other.patientId)).toHaveLength(0)
  })

  it("another collector's visit is 403 on both routes; tomorrow's visit is 409; an unknown visit is 404", async () => {
    const visit = await visitFor(fresh())
    session = COL2
    expect([(await pay(visit.id, { mode: 'cash', amountPaise: 10000 })).status]).toEqual([403])
    expect((await confirm(visit.id, { requestId: 1, utr: UTR2 })).status).toBe(403)
    session = COL
    const tomorrow = addDaysIso(TODAY, 1)
    const later = await visitFor(fresh(), { visitDate: tomorrow })
    const res = await pay(later.id, { mode: 'cash', amountPaise: 10000 })
    expect(res.status).toBe(409)
    const [y, m, d] = tomorrow.split('-').map(Number)
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
    expect((await res.json()).error).toBe(`This visit is on ${d} ${month} ${y}. It can be collected on that day.`)
    expect((await pay(2147483000, { mode: 'cash', amountPaise: 10000 })).status).toBe(404)
    expect(await paymentsOf(visit.patientId)).toHaveLength(0)
    expect(await paymentsOf(later.patientId)).toHaveLength(0)
  })

  it('a collected or cancelled visit is 409', async () => {
    const visit = await visitFor(fresh(), { status: 'cancelled', cancelledAt: new Date(), cancelledByName: PROBE_COL, cancelReason: 'other' })
    expect((await pay(visit.id, { mode: 'cash', amountPaise: 10000 })).status).toBe(409)
  })

  it('amount 0, under ₹1, over ₹1,00,000, a float, an unknown mode or key is 400 before anything is written', async () => {
    const visit = await visitFor(fresh())
    for (const body of [
      { mode: 'cash', amountPaise: 0 }, { mode: 'cash', amountPaise: 99 }, { mode: 'cash', amountPaise: 10_000_001 }, { mode: 'cash', amountPaise: 100.5 },
      { mode: 'card', amountPaise: 10000 }, { mode: 'cash', amountPaise: 10000, patientId: 'X' }, '{not json',
    ]) {
      expect((await pay(visit.id, body)).status).toBe(400)
    }
    expect((await confirm(visit.id, { requestId: 1, utr: 'x' })).status).toBe(400)
    expect((await confirm(visit.id, { requestId: 1, utr: UTR2, amountPaise: 1 })).status).toBe(400)
    expect(await paymentsOf(visit.patientId)).toHaveLength(0)
  })

  it('HOSPITAL_UPI_VPA unset is a 503 with the UPI message; cash still works', async () => {
    delete process.env.HOSPITAL_UPI_VPA
    const visit = await visitFor(fresh())
    const res = await pay(visit.id, { mode: 'upi', amountPaise: 10000 })
    expect([res.status, await res.json()]).toEqual([503, { error: 'UPI is not set up. Ask your administrator.' }])
    expect(await getDb().select().from(paymentRequests).where(eq(paymentRequests.patientId, visit.patientId))).toHaveLength(0)
    expect((await pay(visit.id, { mode: 'cash', amountPaise: 10000 })).status).toBe(201)
  })

  it('roles outside COLLECTOR_ROUTE_ROLES are 403 before the body is read', async () => {
    for (const role of ['frontdesk', 'billing', 'labs'] as const) {
      session = { role, name: PROBE_COL, userId: colUser }
      expect((await pay(1, '{not json')).status).toBe(403)
      expect((await confirm(1, '{not json')).status).toBe(403)
    }
  })
})
