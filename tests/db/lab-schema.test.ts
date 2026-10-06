import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults } from '@/db/schema'

const createdOrderIds: number[] = []
const createdTestIds: number[] = []
afterEach(async () => {
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
  while (createdTestIds.length > 0) await getDb().delete(labTests).where(eq(labTests.id, createdTestIds.pop()!))
})

describe('lab schema', () => {
  it('creates an order and attaches a one-to-one result', async () => {
    const db = getDb()
    const [test] = await db.insert(labTests).values({ name: 'Test Panel', code: 'TP-1', defaultUnit: 'mg/dL', referenceRange: '0-10' }).returning()
    createdTestIds.push(test.id)
    const [patientRow] = await db.select().from(patients).limit(1)
    const [providerRow] = await db.select().from(providers).limit(1)

    const [order] = await db.insert(labOrders).values({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(order.id)
    expect(order.status).toBe('ordered')
    expect(order.collectedAt).toBeNull()

    const [result] = await db.insert(labResults).values({ labOrderId: order.id, value: '5.2', unit: 'mg/dL', flag: 'normal', resultedByName: 'Test Staff' }).returning()
    expect(result.flag).toBe('normal')
  })

  it('enforces one result per order via the unique constraint', async () => {
    const db = getDb()
    const [test] = await db.insert(labTests).values({ name: 'Test Panel 2', code: 'TP-2' }).returning()
    createdTestIds.push(test.id)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [providerRow] = await getDb().select().from(providers).limit(1)
    const [order] = await getDb().insert(labOrders).values({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(order.id)

    await getDb().insert(labResults).values({ labOrderId: order.id, value: '1', flag: 'normal', resultedByName: 'A' })
    await expect(getDb().insert(labResults).values({ labOrderId: order.id, value: '2', flag: 'normal', resultedByName: 'B' })).rejects.toThrow()
  })
})
