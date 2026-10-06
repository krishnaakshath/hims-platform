import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults } from '@/db/schema'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'

const createdOrderIds: number[] = []
afterEach(async () => {
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
})

describe('lab order patient scoping', () => {
  it('two patients lab histories stay independent', async () => {
    const db = getDb()
    const [test] = await db.select().from(labTests).limit(1)
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    const patientsRows = await db.select({ id: patients.id }).from(patients).limit(2)
    const [patientA, patientB] = patientsRows

    const [orderA] = await db.insert(labOrders).values({ patientId: patientA.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(orderA.id)
    const [orderB] = await db.insert(labOrders).values({ patientId: patientB.id, labTestId: test.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(orderB.id)

    const historyA = await listOrdersForPatient(patientA.id)
    const historyB = await listOrdersForPatient(patientB.id)
    expect(historyA.some((o) => o.id === orderB.id)).toBe(false)
    expect(historyB.some((o) => o.id === orderA.id)).toBe(false)
  })
})
