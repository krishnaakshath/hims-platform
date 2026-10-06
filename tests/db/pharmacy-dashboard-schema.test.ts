import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationDispenses, charges, users } from '@/db/schema'

const createdDispenseIds: number[] = []
const createdChargeIds: number[] = []
const createdMedIds: number[] = []
const createdUserIds: number[] = []

afterEach(async () => {
  while (createdDispenseIds.length > 0) await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, createdDispenseIds.pop()!))
  while (createdChargeIds.length > 0) await getDb().delete(charges).where(eq(charges.id, createdChargeIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
  while (createdUserIds.length > 0) await getDb().delete(users).where(eq(users.id, createdUserIds.pop()!))
})

async function makeMed() {
  const db = getDb()
  const [med] = await db.insert(medications).values({ name: `Dashboard Schema Test Med ${Date.now()}-${Math.random()}`, medicationClass: 'Test', form: 'tablet' }).returning()
  createdMedIds.push(med.id)
  return med
}

async function makeCharge(patientId: string) {
  const db = getDb()
  const [charge] = await db.insert(charges).values({
    patientId,
    providerName: 'Dr. Test',
    dateOfService: '2026-01-01',
    diagnosisCodes: [],
    procedureCodes: [],
    amountCents: 1000,
  }).returning()
  createdChargeIds.push(charge.id)
  return charge
}

describe('pharmacy dashboard schema', () => {
  it('defaults medicationDispenses.chargeId to null', async () => {
    const db = getDb()
    const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
    const med = await makeMed()
    const [dispense] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 1, dispensedByName: 'Test Staff' }).returning()
    createdDispenseIds.push(dispense.id)
    expect(dispense.chargeId).toBeNull()
  })

  it('links a dispense to a charge and rejects a second dispense claiming the same charge', async () => {
    const db = getDb()
    const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
    const med = await makeMed()
    const charge = await makeCharge(patientRow.id)
    const [dispenseA] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 1, dispensedByName: 'Test Staff A' }).returning()
    createdDispenseIds.push(dispenseA.id)
    const [dispenseB] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 1, dispensedByName: 'Test Staff B' }).returning()
    createdDispenseIds.push(dispenseB.id)

    const [updated] = await db.update(medicationDispenses).set({ chargeId: charge.id }).where(eq(medicationDispenses.id, dispenseA.id)).returning()
    expect(updated.chargeId).toBe(charge.id)

    await expect(
      db.update(medicationDispenses).set({ chargeId: charge.id }).where(eq(medicationDispenses.id, dispenseB.id))
    ).rejects.toThrow()
  })

  it('allows many dispenses to share a null chargeId', async () => {
    const db = getDb()
    const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
    const med = await makeMed()
    const [dispenseA] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 1, dispensedByName: 'Test Staff A' }).returning()
    createdDispenseIds.push(dispenseA.id)
    const [dispenseB] = await db.insert(medicationDispenses).values({ patientId: patientRow.id, medicationId: med.id, quantity: 1, dispensedByName: 'Test Staff B' }).returning()
    createdDispenseIds.push(dispenseB.id)
    expect(dispenseA.chargeId).toBeNull()
    expect(dispenseB.chargeId).toBeNull()
  })

  it('accepts pharmacy as a users.role value', async () => {
    const [user] = await getDb().insert(users).values({ name: 'Schema Test Pharmacist', email: `pharm.${Date.now()}@example.com`, role: 'pharmacy' }).returning()
    createdUserIds.push(user.id)
    expect(user.role).toBe('pharmacy')
  })
})
