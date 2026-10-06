import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses } from '@/db/schema'

const createdMedIds: number[] = []
const createdDispenseIds: number[] = []
afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

describe('pharmacy schema', () => {
  it('inserts a medication with inventory and a dispense record', async () => {
    const db = getDb()
    const [med] = await db.insert(medications).values({ name: 'Test Med', medicationClass: 'Test Class', form: 'tablet' }).returning()
    createdMedIds.push(med.id)
    const [inv] = await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 50, reorderThreshold: 10, unit: 'tablets' }).returning()
    expect(inv.quantityOnHand).toBe(50)

    const [patientRow] = await db.select().from(patients).limit(1)
    const [dispense] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 5, dispensedByName: 'Test Staff' }).returning()
    createdDispenseIds.push(dispense.id)
    expect(dispense.medicationEpisodeId).toBeNull()
    expect(dispense.quantity).toBe(5)
  })

  it('enforces one inventory row per medication via the unique constraint', async () => {
    const db = getDb()
    const [med] = await db.insert(medications).values({ name: 'Test Med 2', medicationClass: 'Test Class', form: 'tablet' }).returning()
    createdMedIds.push(med.id)
    await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 10, reorderThreshold: 5, unit: 'tablets' })
    await expect(db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: 20, reorderThreshold: 5, unit: 'tablets' })).rejects.toThrow()
  })
})
