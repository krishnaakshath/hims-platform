import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses, medicationEpisodes } from '@/db/schema'
import { dispenseMedication, listDispensesForPatient } from '@/lib/queries/medication-dispenses'

const createdDispenseIds: number[] = []
const createdEpisodeIds: number[] = []
const createdMedIds: number[] = []
afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdEpisodeIds.length > 0) await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

async function makeMedWithStock(qty: number) {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Test Dispense Med ${Date.now()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  await db.insert(medicationInventory).values({ medicationId: med.id, quantityOnHand: qty, reorderThreshold: 5, unit: 'tablets' })
  return med
}

describe('medication dispenses', () => {
  it('dispenses and decrements stock', async () => {
    const med = await makeMedWithStock(50)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(true)
    createdDispenseIds.push(result.dispenseId!)

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(40)

    const history = await listDispensesForPatient(patientRow.id)
    expect(history.some((d) => d.id === result.dispenseId)).toBe(true)
  })

  it('rejects dispensing more than is on hand', async () => {
    const med = await makeMedWithStock(5)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(false)
    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(5) // unchanged
  })

  it('two patients dispense histories stay independent', async () => {
    const med = await makeMedWithStock(100)
    const patientsRows = await getDb().select().from(patients).limit(2)
    const [patientA, patientB] = patientsRows
    const resultA = await dispenseMedication({ patientId: patientA.id, medicationId: med.id, medicationEpisodeId: null, quantity: 5, dispensedByName: 'Staff A', notes: null })
    createdDispenseIds.push(resultA.dispenseId!)
    const resultB = await dispenseMedication({ patientId: patientB.id, medicationId: med.id, medicationEpisodeId: null, quantity: 7, dispensedByName: 'Staff B', notes: null })
    createdDispenseIds.push(resultB.dispenseId!)

    const historyA = await listDispensesForPatient(patientA.id)
    const historyB = await listDispensesForPatient(patientB.id)
    expect(historyA.some((d) => d.id === resultB.dispenseId)).toBe(false)
    expect(historyB.some((d) => d.id === resultA.dispenseId)).toBe(false)
  })

  it('rejects a medicationEpisodeId that belongs to a different patient', async () => {
    const med = await makeMedWithStock(50)
    const [patientA, patientB] = await getDb().select().from(patients).limit(2)
    const [episode] = await getDb().insert(medicationEpisodes).values({
      patientId: patientA.id, name: 'Test Episode Med', medicationClass: 'Test', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(episode.id)

    // patientB's dispense request forges patientA's episode id.
    const result = await dispenseMedication({ patientId: patientB.id, medicationId: med.id, medicationEpisodeId: episode.id, quantity: 5, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/does not belong/)

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(50) // stock untouched -- rejected before the decrement

    if (result.dispenseId) createdDispenseIds.push(result.dispenseId)
  })

  it('rejects an unknown patientId and leaves stock untouched (no orphaned dispense row)', async () => {
    const med = await makeMedWithStock(50)
    const result = await dispenseMedication({ patientId: 'rd-does-not-exist', medicationId: med.id, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Unknown patient')
    expect(result.dispenseId).toBeUndefined()

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(50)

    const dispensesForMed = await getDb().select().from(medicationDispenses).where(eq(medicationDispenses.medicationId, med.id))
    expect(dispensesForMed.length).toBe(0)
  })

  it('rejects an unknown medicationId (not a misleading "not enough stock" result)', async () => {
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const result = await dispenseMedication({ patientId: patientRow.id, medicationId: 999999999, medicationEpisodeId: null, quantity: 10, dispensedByName: 'Test Staff', notes: null })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Unknown medication')
  })

  it('is race-safe: two concurrent dispenses cannot both succeed past actual stock', async () => {
    // Exactly enough stock for one of the two requests, not both. A
    // read-then-write implementation would let both read qty=10 and both
    // decide they have enough, driving stock negative; the real conditional
    // UPDATE (quantity_on_hand >= requested in the WHERE) can only let one
    // of these two concurrent requests win.
    const med = await makeMedWithStock(10)
    const [patientRow] = await getDb().select().from(patients).limit(1)
    const [resultA, resultB] = await Promise.all([
      dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 6, dispensedByName: 'Staff A', notes: null }),
      dispenseMedication({ patientId: patientRow.id, medicationId: med.id, medicationEpisodeId: null, quantity: 6, dispensedByName: 'Staff B', notes: null }),
    ])
    if (resultA.dispenseId) createdDispenseIds.push(resultA.dispenseId)
    if (resultB.dispenseId) createdDispenseIds.push(resultB.dispenseId)

    const succeeded = [resultA, resultB].filter((r) => r.ok)
    expect(succeeded.length).toBe(1)

    const [inv] = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, med.id))
    expect(inv.quantityOnHand).toBe(4) // 10 - 6, never negative
  })
})
