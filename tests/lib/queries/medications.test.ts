import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import {
  listMedicationsWithInventory,
  getMedicationById,
  listActiveMedicationEpisodeSummary,
  createMedicationWithInventory,
} from '@/lib/queries/medications'
import { getDb } from '@/db/client'
import { patients, medications, medicationInventory, medicationEpisodes } from '@/db/schema'

const createdEpisodeIds: number[] = []
const createdMedIds: number[] = []
afterEach(async () => {
  while (createdEpisodeIds.length > 0) await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
  while (createdMedIds.length > 0) {
    const id = createdMedIds.pop()!
    await getDb().delete(medicationInventory).where(eq(medicationInventory.medicationId, id))
    await getDb().delete(medications).where(eq(medications.id, id))
  }
})

describe('medications queries', () => {
  it('lists medications with their inventory joined', async () => {
    const all = await listMedicationsWithInventory()
    expect(all.length).toBeGreaterThanOrEqual(15)
    expect(all.every((m) => typeof m.quantityOnHand === 'number')).toBe(true)
    expect(all.some((m) => m.name === 'Sertraline')).toBe(true)
  })

  it('gets a single medication by id', async () => {
    const all = await listMedicationsWithInventory()
    const byId = await getMedicationById(all[0].id)
    expect(byId?.name).toBe(all[0].name)
  })
})

describe('listActiveMedicationEpisodeSummary', () => {
  it('counts only active episodes and groups by class', async () => {
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const [active1] = await getDb().insert(medicationEpisodes).values({
      patientId: patientRow.id, name: 'Zztestdrug', medicationClass: 'Test Class', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(active1.id)
    const [active2] = await getDb().insert(medicationEpisodes).values({
      patientId: patientRow.id, name: 'Zztestdrug', medicationClass: 'Test Class', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(active2.id)
    const [inactive] = await getDb().insert(medicationEpisodes).values({
      patientId: patientRow.id, name: 'Zztestdrug', medicationClass: 'Test Class', startDate: '2025-01-01', stopDate: '2025-06-01', status: 'inactive',
    }).returning()
    createdEpisodeIds.push(inactive.id)

    const summary = await listActiveMedicationEpisodeSummary()
    const row = summary.find((r) => r.name === 'Zztestdrug')
    expect(row?.activeEpisodeCount).toBe(2)
    expect(row?.medicationClass).toBe('Test Class')
  })

  it('flags a prescribed drug name with no catalog row', async () => {
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const [active] = await getDb().insert(medicationEpisodes).values({
      patientId: patientRow.id, name: 'Zztestdrug', medicationClass: 'Test Class', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(active.id)

    const summary = await listActiveMedicationEpisodeSummary()
    expect(summary.find((r) => r.name === 'Zztestdrug')?.inCatalog).toBe(false)
  })

  it('does not flag a prescribed name that matches a catalog row case-insensitively', async () => {
    const [patientRow] = await getDb().select({ id: patients.id }).from(patients).limit(1)
    const [active] = await getDb().insert(medicationEpisodes).values({
      patientId: patientRow.id, name: 'sertraline', medicationClass: 'SSRI', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(active.id)

    const summary = await listActiveMedicationEpisodeSummary()
    expect(summary.find((r) => r.name.toLowerCase() === 'sertraline')?.inCatalog).toBe(true)
  })
})

describe('createMedicationWithInventory', () => {
  it('creates both the catalog row and its inventory row', async () => {
    const result = await createMedicationWithInventory({
      name: `Zz New Drug ${Date.now()}`, genericName: null, medicationClass: 'Test Class',
      commonDose: null, form: 'tablet', quantityOnHand: 40, reorderThreshold: 10, unit: 'tablets',
    })
    expect(result.ok).toBe(true)
    createdMedIds.push(result.medicationId!)

    const all = await listMedicationsWithInventory()
    const created = all.find((m) => m.id === result.medicationId)
    expect(created?.quantityOnHand).toBe(40) // innerJoin means an orphan catalog row would be invisible here
  })

  it('rejects a case-insensitive duplicate name', async () => {
    const result = await createMedicationWithInventory({
      name: 'sertraline', genericName: null, medicationClass: 'SSRI',
      commonDose: null, form: 'tablet', quantityOnHand: 10, reorderThreshold: 5, unit: 'tablets',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already/i)
  })

  it('leaves no orphan catalog row when the transaction cannot complete', async () => {
    const name = `Zz Concurrent Drug ${Date.now()}`
    const input = {
      name, genericName: null, medicationClass: 'Test Class',
      commonDose: null, form: 'tablet' as const, quantityOnHand: 10, reorderThreshold: 5, unit: 'tablets',
    }

    const results = await Promise.allSettled([
      createMedicationWithInventory(input),
      createMedicationWithInventory(input),
    ])

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.ok && result.value.medicationId) {
        createdMedIds.push(result.value.medicationId)
      }
    }

    const rows = await getDb().select().from(medications).where(eq(medications.name, name))
    expect(rows).toHaveLength(1)

    const inventoryRows = await getDb().select().from(medicationInventory).where(eq(medicationInventory.medicationId, rows[0].id))
    expect(inventoryRows).toHaveLength(1)
  })
})
