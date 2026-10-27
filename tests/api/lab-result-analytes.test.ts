// WS4 T9: the result route and the LIS webhook against per-analyte tests (real DB, session mocked).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { randomBytes } from 'node:crypto'

vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role: 'labs', name: PROBE, userId: null })),
}))
vi.mock('@/lib/queries/hospital-kpis', () => ({ invalidateLabKpis: vi.fn(async () => undefined) }))

import { getDb } from '@/db/client'
import { auditLog, labOrders, labResultValues, labResults, labTestAnalytes, labTests, patients, providers } from '@/db/schema'
import { LAB_ANALYTE_SEED } from '@/db/seed-india-data'
import { replaceAnalytesForTest } from '@/lib/queries/lab-analytes'
import { invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { POST as RESULT } from '@/app/api/lab-orders/[id]/result/route'
import { POST as WEBHOOK } from '@/app/api/webhooks/fhir-labs/route'

const TAG = randomBytes(4).toString('hex').toUpperCase()
const PROBE = `TEST_WS4T9R-${TAG}`
const PID = `TEST-WS4T9R-${TAG}`
const TOKEN = 'lis-test-secret-ws4t9'
let providerId = 0
let cbcTestId = 0
let plainTestId = 0
const orderIds: number[] = []
const ids = new Map<string, number>()

const post = (body: unknown) => new NextRequest('http://localhost/api/lab-orders/x', { method: 'POST', body: JSON.stringify(body) })
const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })
const NORMAL: Record<string, string> = {
  HGB: '13.1', WBC: '7.2', NEUT: '60', LYMPH: '30', MONO: '6', EOS: '3', BASO: '1', PLT: '250', RBC: '4.6', HCT: '40', MCV: '88', MCH: '29', MCHC: '33',
}
const analytes = (values: Record<string, string>) => Object.entries(values).map(([code, value]) => ({ analyteId: ids.get(code)!, value }))

async function order(labTestId: number, status: 'received' | 'collected') {
  const [o] = await getDb().insert(labOrders).values({
    patientId: PID, labTestId, orderedByProviderId: providerId, status, collectedAt: new Date('2099-05-01T05:00:00Z'),
    ...(status === 'received' ? { receivedAt: new Date('2099-05-01T05:30:00Z') } : {}),
  }).returning()
  orderIds.push(o.id)
  return o.id
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.LIS_INTEGRATION_TOKEN
  process.env.LIS_INTEGRATION_TOKEN = TOKEN
  vi.mocked(invalidateLabKpis).mockClear()
})
afterEach(() => {
  if (saved === undefined) delete process.env.LIS_INTEGRATION_TOKEN
  else process.env.LIS_INTEGRATION_TOKEN = saved
})

describe.skipIf(!process.env.DATABASE_URL)('per-analyte result routes (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'TEST_WS4T9 Route', dob: '2069-05-01', gender: 'female' })
    const [pr] = await db.insert(providers).values({ name: `TEST_WS4T9R Dr ${TAG}`, specialty: 'Pathology', colorTag: '#000000' }).returning()
    providerId = pr.id
    const [cbc, plain] = await db.insert(labTests).values([
      { name: `TEST WS4T9R CBC ${TAG}`, code: `TEST-WS4T9R-CBC-${TAG}` },
      { name: `TEST WS4T9R plain ${TAG}`, code: `TEST-WS4T9R-PLN-${TAG}` },
    ]).returning()
    cbcTestId = cbc.id
    plainTestId = plain.id
    expect(await replaceAnalytesForTest(cbcTestId, LAB_ANALYTE_SEED['CBC-DIFF'], { role: 'admin', name: PROBE, userId: null })).toEqual({ ok: true })
    for (const a of await db.select().from(labTestAnalytes).where(eq(labTestAnalytes.labTestId, cbcTestId))) ids.set(a.code, a.id)
  })

  afterAll(async () => {
    const db = getDb()
    if (orderIds.length) {
      await db.delete(labResultValues).where(inArray(labResultValues.labOrderId, orderIds))
      await db.delete(labResults).where(inArray(labResults.labOrderId, orderIds))
      await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    }
    await db.delete(labTestAnalytes).where(inArray(labTestAnalytes.labTestId, [cbcTestId, plainTestId]))
    await db.delete(labTests).where(inArray(labTests.id, [cbcTestId, plainTestId]))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(patients).where(eq(patients.id, PID))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE))
    await db.delete(auditLog).where(eq(auditLog.patientId, PID))
  })

  it('records a CBC per analyte and invalidates the lab KPIs', async () => {
    const id = await order(cbcTestId, 'received')
    const res = await RESULT(post({ analytes: analytes({ ...NORMAL, HGB: '6.5', PLT: '38' }) }), ctx(id))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
    const [s] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, id))
    expect(s).toMatchObject({ value: '13 analytes', flag: 'critical' })
  })

  it('422s with a stable code and a fixed message, writing nothing', async () => {
    const id = await order(cbcTestId, 'received')
    const rest = analytes(NORMAL).slice(1)
    const missing = await RESULT(post({ analytes: rest }), ctx(id))
    expect(missing.status).toBe(422)
    expect(await missing.json()).toEqual({ error: 'Enter a value for every analyte of this test.', code: 'analyte_missing', analyteId: ids.get('HGB') })

    const single = await RESULT(post({ value: '13.1', flag: 'normal' }), ctx(id))
    expect(single.status).toBe(422)
    expect(await single.json()).toMatchObject({ code: 'analytes_required' })

    const lowered = await RESULT(post({ analytes: analytes({ ...NORMAL, HGB: '6.5' }).map((a) => (a.analyteId === ids.get('HGB') ? { ...a, flagOverride: { flag: 'normal', reason: 'SECRET-REASON' } } : a)) }), ctx(id))
    expect(lowered.status).toBe(422)
    const lb = await lowered.json()
    expect(lb.code).toBe('flag_below_computed')
    expect(JSON.stringify(lb)).not.toContain('SECRET')

    const plain = await order(plainTestId, 'received')
    const unknown = await RESULT(post({ analytes: analytes({ HGB: '13' }) }), ctx(plain))
    expect(unknown.status).toBe(422)
    expect(await unknown.json()).toMatchObject({ code: 'analyte_unknown' })

    expect(await getDb().select().from(labResults).where(inArray(labResults.labOrderId, [id, plain]))).toHaveLength(0)
    expect(invalidateLabKpis).not.toHaveBeenCalled()
  })

  it('400s an analyte body that breaks the schema (duplicate ids, short reason, both shapes)', async () => {
    const id = await order(cbcTestId, 'received')
    const hgb = ids.get('HGB')!
    expect((await RESULT(post({ analytes: [{ analyteId: hgb, value: '1' }, { analyteId: hgb, value: '2' }] }), ctx(id))).status).toBe(400)
    expect((await RESULT(post({ analytes: [{ analyteId: hgb, value: '1', flagOverride: { flag: 'critical', reason: 'abc' } }] }), ctx(id))).status).toBe(400)
    expect((await RESULT(post({ value: '1', flag: 'normal', analytes: [{ analyteId: hgb, value: '1' }] }), ctx(id))).status).toBe(400)
    expect((await RESULT(post({ analytes: [{ analyteId: hgb, value: 'x'.repeat(61) }] }), ctx(id))).status).toBe(400)
  })

  it('the FHIR webhook refuses a single Observation for a CBC with 422 analytes_required', async () => {
    const id = await order(cbcTestId, 'collected')
    const res = await WEBHOOK(new Request('http://localhost/api/webhooks/fhir-labs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        resourceType: 'Observation', status: 'final', code: { coding: [{ code: '718-7' }] }, subject: { reference: `Patient/${PID}` },
        valueQuantity: { value: 13.1, unit: 'g/dL' }, basedOn: [{ reference: `ServiceRequest/${id}` }],
      }),
    }) as never)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ code: 'analytes_required' })
    const [o] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
    expect(o.status).toBe('collected')
    expect(await getDb().select().from(labResults).where(eq(labResults.labOrderId, id))).toHaveLength(0)
  })

  it('the FHIR webhook still records a test without analytes and invalidates the lab KPIs', async () => {
    const id = await order(plainTestId, 'collected')
    const res = await WEBHOOK(new Request('http://localhost/api/webhooks/fhir-labs', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        resourceType: 'Observation', status: 'final', code: { coding: [{ code: '1558-6' }] }, subject: { reference: `Patient/${PID}` },
        valueQuantity: { value: 92, unit: 'mg/dL' }, basedOn: [{ reference: `ServiceRequest/${id}` }],
      }),
    }) as never)
    expect(res.status).toBe(200)
    expect(invalidateLabKpis).toHaveBeenCalledTimes(1)
  })
})
