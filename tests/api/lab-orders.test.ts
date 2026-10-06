import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults, documents, auditLog } from '@/db/schema'
import { logIntegrationEvent } from '@/lib/patient-portal-audit'
import { createLabOrder, markCollected, enterResult, cancelOrder, listWorklist, listOrdersForPatient } from '@/lib/queries/lab-orders'

const createdOrderIds: number[] = []
const createdDocumentIds: number[] = []
const createdAuditActions: string[] = []
afterEach(async () => {
  // Only audit rows whose action is a unique probe string created by these tests.
  while (createdAuditActions.length > 0) {
    await getDb().delete(auditLog).where(eq(auditLog.action, createdAuditActions.pop()!))
  }
  while (createdDocumentIds.length > 0) {
    await getDb().delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
})

async function makeOrder() {
  const db = getDb()
  const [test] = await db.select({ id: labTests.id }).from(labTests).limit(1)
  const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
  const order = await createLabOrder({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id })
  createdOrderIds.push(order.id)
  return order
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
  it('createLabOrder sets initial status ordered', async () => {
    const order = await makeOrder()
    expect(order.status).toBe('ordered')
  })

  it('markCollected transitions ordered -> collected and sets collectedAt; a second call does not double-apply (Review Focus #2)', async () => {
    const order = await makeOrder()

    const first = await markCollected(order.id)
    expect(first.ok).toBe(true)

    const [afterFirst] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(afterFirst.status).toBe('collected')
    expect(afterFirst.collectedAt).not.toBeNull()
    const collectedAtAfterFirst = afterFirst.collectedAt

    const second = await markCollected(order.id)
    expect(second.ok).toBe(false)

    const [afterSecond] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(afterSecond.status).toBe('collected')
    expect(afterSecond.collectedAt?.getTime()).toBe(collectedAtAfterFirst?.getTime())
  })

  it('enterResult rejects an order that has never been collected (Review Focus #1)', async () => {
    const order = await makeOrder()

    const result = await enterResult(order.id, { value: '5', flag: 'normal', resultedByName: 'Tester' })
    expect(result.ok).toBe(false)

    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.status).toBe('ordered')
    const resultRows = await getDb().select().from(labResults).where(eq(labResults.labOrderId, order.id))
    expect(resultRows.length).toBe(0)
  })

  it('enterResult transitions collected -> resulted and inserts the result row', async () => {
    const order = await makeOrder()
    const collect = await markCollected(order.id)
    expect(collect.ok).toBe(true)

    const result = await enterResult(order.id, { value: '5.2', unit: 'mg/dL', flag: 'normal', resultedByName: 'Tester' })
    expect(result.ok).toBe(true)

    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.status).toBe('resulted')
    const [resultRow] = await getDb().select().from(labResults).where(eq(labResults.labOrderId, order.id))
    expect(resultRow.value).toBe('5.2')
    expect(resultRow.unit).toBe('mg/dL')
  })

  it('cancelOrder transitions an ordered order to cancelled', async () => {
    const order = await makeOrder()
    const result = await cancelOrder(order.id, 'Patient declined the draw')
    expect(result.ok).toBe(true)

    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.status).toBe('cancelled')
  })

  it('cancelOrder transitions a collected order to cancelled', async () => {
    const order = await makeOrder()
    await markCollected(order.id)
    const result = await cancelOrder(order.id, 'Sample lost in transit')
    expect(result.ok).toBe(true)

    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.status).toBe('cancelled')
  })

  it('cancelOrder rejects a resulted order (Review Focus #3 — terminal state)', async () => {
    const order = await makeOrder()
    await markCollected(order.id)
    await enterResult(order.id, { value: '1', flag: 'normal', resultedByName: 'Tester' })

    const result = await cancelOrder(order.id, 'too late now')
    expect(result.ok).toBe(false)

    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(row.status).toBe('resulted')
  })

  it('cancelOrder rejects an already-cancelled order (Review Focus #3 — terminal state)', async () => {
    const order = await makeOrder()
    const firstCancel = await cancelOrder(order.id, 'first cancellation')
    expect(firstCancel.ok).toBe(true)

    const secondCancel = await cancelOrder(order.id, 'second cancellation')
    expect(secondCancel.ok).toBe(false)
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

describe('enterResult — transactional atomicity and patient binding (real DB)', () => {
  async function state(id: number) {
    const [row] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
    const results = await getDb().select().from(labResults).where(eq(labResults.labOrderId, id))
    return { status: row.status, results: results.length }
  }
  const input = { value: '3', flag: 'normal' as const, resultedByName: 'Tester' }

  it('rolls back the status UPDATE and result INSERT when afterEntered throws', async () => {
    const order = await makeOrder()
    await markCollected(order.id)
    await expect(enterResult(order.id, input, { afterEntered: async () => { throw new Error('boom') } })).rejects.toThrow('boom')
    expect(await state(order.id)).toEqual({ status: 'collected', results: 0 })
  })

  it('rolls back the audit row too when the real audit hook is followed by a failure; commits all three on success', async () => {
    const action = `test-probe lab rollback ${Date.now()}-${Math.random()}`
    createdAuditActions.push(action)
    const failing = await makeOrder()
    await markCollected(failing.id)
    await expect(enterResult(failing.id, input, {
      afterEntered: async (tx, patientId) => {
        await logIntegrationEvent(action, patientId, undefined, tx)
        throw new Error('after audit')
      },
    })).rejects.toThrow('after audit')
    expect(await state(failing.id)).toEqual({ status: 'collected', results: 0 })
    expect((await getDb().select().from(auditLog).where(eq(auditLog.action, action))).length).toBe(0)

    const ok = await makeOrder()
    await markCollected(ok.id)
    const res = await enterResult(ok.id, input, {
      afterEntered: (tx, patientId) => logIntegrationEvent(action, patientId, undefined, tx),
    })
    expect(res.ok).toBe(true)
    expect(await state(ok.id)).toEqual({ status: 'resulted', results: 1 })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, action))
    expect(rows.length).toBe(1)
    expect(rows[0].userName).toBe('LIS integration')
    expect(rows[0].patientId).toBe(ok.patientId)
  })

  it('expectedPatientId mismatch returns ok:false and writes nothing; the owner succeeds', async () => {
    const order = await makeOrder()
    await markCollected(order.id)
    const bad = await enterResult(order.id, input, { expectedPatientId: 'NOT-THE-OWNER' })
    expect(bad.ok).toBe(false)
    expect(await state(order.id)).toEqual({ status: 'collected', results: 0 })
    const good = await enterResult(order.id, input, { expectedPatientId: order.patientId })
    expect(good.ok).toBe(true)
    expect(await state(order.id)).toEqual({ status: 'resulted', results: 1 })
  })
})
