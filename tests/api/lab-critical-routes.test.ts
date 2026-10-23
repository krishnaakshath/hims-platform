// WS4 T12 (spec 3.4 / 3.5): the critical-value call log and acknowledgement routes, and the verify
// route's critical gate (real DB, session mocked). A pathologist (labs) linked to the test's
// department, an ordering doctor and another doctor (pi) in General Medicine.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'
import type { Session } from '@/lib/auth'

const h = vi.hoisted(() => ({ session: null as unknown as Session }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => h.session) }))
vi.mock('@/lib/queries/hospital-kpis', () => ({
  invalidateLabKpis: vi.fn(async () => undefined),
  invalidateDoctorWorkloadCache: vi.fn(async () => undefined),
}))

import { getDb } from '@/db/client'
import { auditLog, labCriticalAlerts, labOrders, labResultSignoffs, labResults, labTests, patients, users } from '@/db/schema'
import { invalidateDoctorWorkloadCache, invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { recordLabResult } from '@/lib/queries/lab-lifecycle'
import { CRITICAL_MESSAGES, SIGNOFF_MESSAGES } from '@/lib/labs/route-responses'
import { POST as VERIFY } from '@/app/api/lab-orders/[id]/verify/route'
import { POST as NOTIFY } from '@/app/api/lab-orders/[id]/critical/notify/route'
import { POST as ACK } from '@/app/api/lab-orders/[id]/critical/acknowledge/route'
import { POST as REVIEW_ACK } from '@/app/api/lab-orders/[id]/acknowledge/route'
import { createLabDepartmentFixture, type LabDepartmentFixture } from '../db/lab-verifier-fixtures'

const TAG = randomBytes(4).toString('hex').toUpperCase()
const PID = `TEST-WS4T12R-${TAG}`
const N = {
  tech: `TEST_WS4T12R Tech ${TAG}`,
  pathologist: `TEST_WS4T12R Dr Pathologist ${TAG}`,
  ordering: `TEST_WS4T12R Dr Ordering ${TAG}`,
  other: `TEST_WS4T12R Dr Other ${TAG}`,
}
const ROLE: Record<keyof typeof N, Session['role']> = { tech: 'labs', pathologist: 'labs', ordering: 'pi', other: 'pi' }
const uid: Partial<Record<keyof typeof N, number>> = {}
const as = (who: keyof typeof N) => { h.session = { role: ROLE[who], name: N[who], userId: uid[who]! } }
const asRole = (role: Session['role']) => { h.session = { role, name: `TEST_WS4T12R ${role} ${TAG}`, userId: null } }

let lab: LabDepartmentFixture
let gen: LabDepartmentFixture
let testId = 0
let orderingProvider = 0
const orderIds: number[] = []

const post = (body?: unknown) => new NextRequest('http://localhost/api/lab-orders/x', { method: 'POST', ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const CALL = { notifiedToName: 'Dr Rao', channel: 'phone', readBack: true }

/** A potassium result entered as critical by the technician: the alert is open. */
async function criticalOrder() {
  const [o] = await getDb().insert(labOrders).values({ patientId: PID, labTestId: testId, orderedByProviderId: orderingProvider, status: 'received' }).returning()
  orderIds.push(o.id)
  const r = await recordLabResult(o.id, { value: '6.9', unit: 'mmol/L', flag: 'critical' }, { kind: 'staff', session: { role: 'labs', name: N.tech, userId: uid.tech! } })
  if (!r.ok) throw new Error('result failed')
  return o.id
}
const alertOf = async (id: number) => (await getDb().select().from(labCriticalAlerts).where(eq(labCriticalAlerts.labOrderId, id)))[0]

beforeEach(() => {
  vi.mocked(invalidateLabKpis).mockClear()
  vi.mocked(invalidateDoctorWorkloadCache).mockClear()
})

describe.skipIf(!process.env.DATABASE_URL)('critical-value routes (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS4T12R Patient', dob: '1980-01-01' })
    const keys = Object.keys(N) as (keyof typeof N)[]
    const us = await db.insert(users).values(keys.map((k) => ({ name: N[k], email: `test-ws4t12r-${TAG.toLowerCase()}-${k}@example.invalid`, role: ROLE[k] }))).returning()
    for (const k of keys) uid[k] = us.find((u) => u.name === N[k])!.id
    lab = await createLabDepartmentFixture(`TL${TAG}`)
    gen = await createLabDepartmentFixture(`TG${TAG}`)
    const [t] = await db.insert(labTests).values({ name: `TEST_WS4T12R Potassium ${TAG}`, code: `TEST-WS4T12R-K-${TAG}` }).returning()
    testId = t.id
    await lab.mapTests([testId])
    await lab.linkUsers([uid.pathologist!], `TEST_WS4T12R Dr Path prov ${TAG}`)
    orderingProvider = await gen.linkUsers([uid.ordering!], `TEST_WS4T12R Dr Ordering prov ${TAG}`)
    await gen.linkUsers([uid.other!], `TEST_WS4T12R Dr Other prov ${TAG}`)
  }, 60_000)

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds)) // alerts and sign-offs cascade
    }
    await db.delete(auditLog).where(inArray(auditLog.userName, Object.values(N)))
    for (const f of [lab, gen]) await f?.cleanup()
    await db.delete(labTests).where(eq(labTests.id, testId))
    await db.delete(users).where(inArray(users.id, Object.values(uid) as number[]))
    await db.delete(patients).where(eq(patients.id, PID))
  }, 60_000)

  it('verify while the alert is open is 409 critical_not_notified', async () => {
    const id = await criticalOrder()
    expect((await alertOf(id)).summary).toBe(`TEST_WS4T12R Potassium ${TAG} 6.9 mmol/L`)
    as('pathologist')
    const res = await VERIFY(post(), ctx(id))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: CRITICAL_MESSAGES.critical_not_notified, code: 'critical_not_notified' })
    expect(invalidateLabKpis).not.toHaveBeenCalled()
  })

  it('front desk (and crc) are refused before the body is read', async () => {
    const id = await criticalOrder()
    for (const role of ['frontdesk', 'crc'] as const) {
      asRole(role)
      expect((await NOTIFY(post('{not json'), ctx(id))).status).toBe(403)
      expect((await ACK(post('{not json'), ctx(id))).status).toBe(403)
    }
    // The lab logs calls but never acknowledges.
    as('tech')
    expect((await ACK(post({}), ctx(id))).status).toBe(403)
    expect((await alertOf(id)).status).toBe('open')
  })

  it('notify: strict body, phone needs read-back (422), another department\'s doctor is 403, then 201 and the log is stored', async () => {
    const id = await criticalOrder()
    as('tech')
    expect((await NOTIFY(post({ ...CALL, extra: 1 }), ctx(id))).status).toBe(400)
    expect((await NOTIFY(post({ ...CALL, notifiedToName: '' }), ctx(id))).status).toBe(400)
    const noReadBack = await NOTIFY(post({ ...CALL, readBack: false }), ctx(id))
    expect(noReadBack.status).toBe(422)
    expect(await noReadBack.json()).toEqual({ error: CRITICAL_MESSAGES.read_back_required, code: 'read_back_required' })

    as('other') // pi in General Medicine: may not verify a lab test, so may not log its call
    const denied = await NOTIFY(post(CALL), ctx(id))
    expect(denied.status).toBe(403)
    expect((await denied.json()).code).toBe('wrong_department')
    expect((await alertOf(id)).status).toBe('open')

    as('tech')
    const ok = await NOTIFY(post(CALL), ctx(id))
    expect(ok.status).toBe(201)
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
    expect(await alertOf(id)).toMatchObject({ status: 'notified', notifiedToName: 'Dr Rao', notifyChannel: 'phone', readBack: true, notifiedByName: N.tech })
    const again = await NOTIFY(post(CALL), ctx(id))
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('not_open')

    as('pathologist')
    expect((await VERIFY(post(), ctx(id))).status).toBe(200)
  })

  it('acknowledge: another doctor 403, the ordering doctor 201 with a sign-off, a repeat 409', async () => {
    const id = await criticalOrder()
    as('other')
    const denied = await ACK(post({}), ctx(id))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: CRITICAL_MESSAGES.not_owner, code: 'not_owner' })

    as('ordering')
    expect((await ACK(post({ note: 'x'.repeat(301) }), ctx(id))).status).toBe(400)
    // The call is not logged yet: acknowledging is refused and verification still waits.
    const early = await ACK(post({}), ctx(id))
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: CRITICAL_MESSAGES.not_notified, code: 'not_notified' })
    expect((await alertOf(id)).status).toBe('open')
    expect(invalidateLabKpis).not.toHaveBeenCalled()
    as('pathologist')
    expect((await (await VERIFY(post(), ctx(id))).json()).code).toBe('critical_not_notified')
    as('tech')
    expect((await NOTIFY(post(CALL), ctx(id))).status).toBe(201)
    vi.mocked(invalidateLabKpis).mockClear()

    as('ordering')
    const ok = await ACK(post({ note: 'Repeat K+ in 2 h' }), ctx(id))
    expect(ok.status).toBe(201)
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
    expect(invalidateDoctorWorkloadCache).toHaveBeenCalledWith(orderingProvider, N.ordering)
    expect((await alertOf(id)).status).toBe('acknowledged')
    const s = await getDb().select().from(labResultSignoffs).where(and(eq(labResultSignoffs.labOrderId, id), eq(labResultSignoffs.kind, 'acknowledge')))
    expect(s).toHaveLength(1)
    const again = await ACK(post(), ctx(id))
    expect(again.status).toBe(409)
    expect((await again.json()).code).toBe('already_acknowledged')
  })

  it('the review acknowledgement refuses an open alert (409 not_notified) and closes a notified one', async () => {
    const id = await criticalOrder()
    as('ordering')
    const early = await REVIEW_ACK(post({}), ctx(id))
    expect(early.status).toBe(409)
    expect(await early.json()).toEqual({ error: SIGNOFF_MESSAGES.not_notified, code: 'not_notified' })
    expect((await alertOf(id)).status).toBe('open')
    expect(await getDb().select().from(labResultSignoffs).where(eq(labResultSignoffs.labOrderId, id))).toEqual([])

    as('tech')
    expect((await NOTIFY(post(CALL), ctx(id))).status).toBe(201)
    vi.mocked(invalidateLabKpis).mockClear()
    as('ordering')
    const ok = await REVIEW_ACK(post({ note: 'Seen' }), ctx(id))
    expect(ok.status).toBe(201)
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
    expect(await alertOf(id)).toMatchObject({ status: 'acknowledged', acknowledgedByName: N.ordering, acknowledgedByUserId: uid.ordering, ackNote: 'Seen' })
    // The critical acknowledgement now finds the alert closed.
    expect((await (await ACK(post({}), ctx(id))).json()).code).toBe('already_acknowledged')
  })

  it('an unknown order is 404 on both routes', async () => {
    as('tech')
    expect((await NOTIFY(post(CALL), ctx(2147483000))).status).toBe(404)
    as('ordering')
    expect((await ACK(post({}), ctx(2147483000))).status).toBe(404)
  })
})
