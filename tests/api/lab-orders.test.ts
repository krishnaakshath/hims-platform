// SP5: the old markCollected / enterResult / cancelOrder were replaced by the lifecycle
// transitions (src/lib/queries/lab-lifecycle.ts); an order reaches `resulted` via collect →
// receive → result. Fixtures use a TEST-SP5 patient and a probe session name, so every audit row
// written here is deleted by name (staff) or by that patient id (LIS).
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults, documents, auditLog } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { listWorklist, listOrdersForPatient } from '@/lib/queries/lab-orders'
import { cancelLabOrder, collectLabOrder, receiveLabSample, recordLabResult } from '@/lib/queries/lab-lifecycle'

// The LIS audit write can be made to fail, to prove the whole result transaction rolls back.
let failLisAudit = false
vi.mock('@/lib/patient-portal-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/patient-portal-audit')>('@/lib/patient-portal-audit')
  return {
    ...actual,
    logIntegrationEvent: async (...a: Parameters<typeof actual.logIntegrationEvent>) => {
      if (failLisAudit) throw new Error('audit down')
      return actual.logIntegrationEvent(...a)
    },
  }
})

const RUN = `${Date.now()}`
const PROBE = `TEST_SP5_LO-${RUN}`
const PATIENT = `TEST-SP5-${RUN}-LO`
const S: Session = { role: 'admin', name: PROBE, userId: null }
const RESULT = { value: '5.2', unit: 'mg/dL', flag: 'normal' as const }

const createdOrderIds: number[] = []
const createdDocumentIds: number[] = []
beforeAll(async () => {
  await getDb().insert(patients).values({ id: PATIENT, name: 'TEST_SP5 lab orders', dob: '1980-01-01' })
})
afterEach(async () => {
  failLisAudit = false
  while (createdDocumentIds.length > 0) {
    await getDb().delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
})
afterAll(async () => {
  await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  await getDb().delete(auditLog).where(and(eq(auditLog.userName, 'LIS integration'), eq(auditLog.patientId, PATIENT)))
  await getDb().delete(patients).where(eq(patients.id, PATIENT))
})

async function makeOrder() {
  const db = getDb()
  const [test] = await db.select({ id: labTests.id }).from(labTests).limit(1)
  const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [order] = await db.insert(labOrders).values({ patientId: PATIENT, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
  createdOrderIds.push(order.id)
  return order
}

async function collected() {
  const order = await makeOrder()
  const c = await collectLabOrder(order.id, S)
  if (!c.ok) throw new Error('collect failed')
  return { order, sampleId: c.sampleId }
}

async function received() {
  const { order, sampleId } = await collected()
  const r = await receiveLabSample(sampleId, S)
  if (!r.ok) throw new Error('receive failed')
  return order
}

async function state(id: number) {
  const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
  const results = await getDb().select().from(labResults).where(eq(labResults.labOrderId, id))
  return { status: row.status, results: results.length }
}

async function attachDocument(orderId: number, patientId: string, name: string) {
  const [doc] = await getDb().insert(documents).values({
    name,
    documentDate: '2026-09-29',
    receivedFrom: 'Test Imaging Center',
    documentType: 'imaging_result',
    patientId,
    admissionId: null,
    labOrderId: orderId,
    fileUrl: `https://blob.test/${name}`,
    fileType: 'JPG',
    filedByName: 'Tester',
    filedAt: new Date(),
  }).returning()
  createdDocumentIds.push(doc.id)
  return doc
}

describe('lab order lifecycle — query layer', () => {
  it('a new order starts in status ordered', async () => {
    const order = await makeOrder()
    expect(order.status).toBe('ordered')
  })

  it('collect transitions ordered -> collected with a sample ID; a second collect does not re-stamp (Review Focus #2)', async () => {
    const order = await makeOrder()
    const first = await collectLabOrder(order.id, S)
    expect(first.ok).toBe(true)
    const [afterFirst] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(afterFirst.status).toBe('collected')
    expect(afterFirst.collectedAt).not.toBeNull()
    expect(afterFirst.sampleId).toBe(first.ok ? first.sampleId : null)

    expect(await collectLabOrder(order.id, S)).toEqual({ ok: false, error: 'invalid_status' })
    const [afterSecond] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(afterSecond.collectedAt?.getTime()).toBe(afterFirst.collectedAt?.getTime())
  })

  it('a staff result is refused before the sample is received (Review Focus #1)', async () => {
    const order = await makeOrder()
    expect(await recordLabResult(order.id, RESULT, { kind: 'staff', session: S })).toEqual({ ok: false, error: 'invalid_status' })
    const { order: c } = await collected()
    expect(await recordLabResult(c.id, RESULT, { kind: 'staff', session: S })).toEqual({ ok: false, error: 'invalid_status' })
    expect(await state(order.id)).toEqual({ status: 'ordered', results: 0 })
    expect(await state(c.id)).toEqual({ status: 'collected', results: 0 })
  })

  it('collect -> receive -> result lands as resulted with the result row', async () => {
    const order = await received()
    const result = await recordLabResult(order.id, RESULT, { kind: 'staff', session: S })
    expect(result.ok).toBe(true)
    expect(await state(order.id)).toEqual({ status: 'resulted', results: 1 })
    const [resultRow] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, order.id))
    expect(resultRow.value).toBe('5.2')
    expect(resultRow.unit).toBe('mg/dL')
  })

  it('cancels an ordered and a collected order', async () => {
    const order = await makeOrder()
    expect((await cancelLabOrder(order.id, 'Patient declined the draw', S)).ok).toBe(true)
    expect((await state(order.id)).status).toBe('cancelled')
    const { order: c } = await collected()
    expect((await cancelLabOrder(c.id, 'Sample lost in transit', S)).ok).toBe(true)
    expect((await state(c.id)).status).toBe('cancelled')
  })

  it('refuses to cancel a resulted order (Review Focus #3 — a result exists)', async () => {
    const order = await received()
    await recordLabResult(order.id, RESULT, { kind: 'staff', session: S })
    expect(await cancelLabOrder(order.id, 'too late now', S)).toEqual({ ok: false, error: 'not_cancellable' })
    expect((await state(order.id)).status).toBe('resulted')
  })

  it('refuses to cancel an already-cancelled order (Review Focus #3 — terminal state)', async () => {
    const order = await makeOrder()
    expect((await cancelLabOrder(order.id, 'first cancellation', S)).ok).toBe(true)
    expect(await cancelLabOrder(order.id, 'second cancellation', S)).toEqual({ ok: false, error: 'not_cancellable' })
  })

  it('exposes the test category on every worklist row', async () => {
    const order = await makeOrder()
    const rows = await listWorklist()
    const row = rows.find((r) => r.id === order.id)!
    expect(['lab', 'imaging']).toContain(row.category)
  })

  it('returns attachments as an empty array, never null, for an order with no images', async () => {
    const order = await makeOrder()
    expect((await listWorklist()).find((r) => r.id === order.id)!.attachments).toEqual([])
    expect((await listOrdersForPatient(order.patientId)).find((r) => r.id === order.id)!.attachments).toEqual([])
  })

  it('returns an imaging order\'s own attachments on both surfaces, and no other order\'s', async () => {
    const orderA = await makeOrder()
    const orderB = await makeOrder()
    const docA1 = await attachDocument(orderA.id, orderA.patientId, 'chest-ap.jpg')
    const docA2 = await attachDocument(orderA.id, orderA.patientId, 'chest-lateral.jpg')
    const docB = await attachDocument(orderB.id, orderB.patientId, 'knee-ap.jpg')

    const worklistRows = await listWorklist()
    const worklistRowA = worklistRows.find((r) => r.id === orderA.id)!
    const worklistRowB = worklistRows.find((r) => r.id === orderB.id)!
    expect(worklistRowA.attachments.map((a) => a.id).sort()).toEqual([docA1.id, docA2.id].sort())
    expect(worklistRowB.attachments.map((a) => a.id)).toEqual([docB.id])

    const patientRowA = (await listOrdersForPatient(orderA.patientId)).find((r) => r.id === orderA.id)!
    expect(patientRowA.attachments).toHaveLength(2)
  })

  it('resolves the patient name on the worklist without selecting retired patient columns', async () => {
    const order = await makeOrder()
    const row = (await listWorklist()).find((r) => r.id === order.id)!
    expect(typeof row.patientName).toBe('string')
    expect(row.patientName.length).toBeGreaterThan(0)
  })
})

describe('LIS result — transactional atomicity and patient binding (real DB)', () => {
  it('rolls back the receipt, status change and result row when the audit write fails', async () => {
    const { order } = await collected()
    failLisAudit = true
    await expect(recordLabResult(order.id, RESULT, { kind: 'lis' }, { expectedPatientId: PATIENT })).rejects.toThrow('audit down')
    expect(await state(order.id)).toEqual({ status: 'collected', results: 0 })
    const [row] = await getDb().select({ receivedAt: labOrders.receivedAt }).from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.receivedAt).toBeNull()
  })

  it('commits the status, the result and one integration audit row together', async () => {
    const { order } = await collected()
    const res = await recordLabResult(order.id, RESULT, { kind: 'lis' }, { expectedPatientId: PATIENT })
    expect(res.ok).toBe(true)
    expect(await state(order.id)).toEqual({ status: 'resulted', results: 1 })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, `accepted LIS lab result for order ${order.id}`))
    expect(rows).toHaveLength(1)
    expect(rows[0].userName).toBe('LIS integration')
    expect(rows[0].patientId).toBe(PATIENT)
  })

  it('expectedPatientId mismatch returns ok:false and writes nothing; the owner succeeds', async () => {
    const { order } = await collected()
    expect(await recordLabResult(order.id, RESULT, { kind: 'lis' }, { expectedPatientId: 'NOT-THE-OWNER' })).toEqual({ ok: false, error: 'patient_mismatch' })
    expect(await state(order.id)).toEqual({ status: 'collected', results: 0 })
    expect((await recordLabResult(order.id, RESULT, { kind: 'lis' }, { expectedPatientId: PATIENT })).ok).toBe(true)
    expect(await state(order.id)).toEqual({ status: 'resulted', results: 1 })
  })
})
