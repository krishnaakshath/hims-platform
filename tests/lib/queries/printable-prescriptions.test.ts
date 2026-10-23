import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, medications, medicationEpisodes, prescriptions } from '@/db/schema'
import { getPrintablePrescriptions } from '@/lib/queries/prescriptions'

let patientId: string
let providerId: number
let med: { id: number; genericName: string | null }
const episodeIds: number[] = []
const headerIds: number[] = []
afterEach(async () => {
  const db = getDb()
  while (episodeIds.length) await db.delete(medicationEpisodes).where(eq(medicationEpisodes.id, episodeIds.pop()!))
  while (headerIds.length) await db.delete(prescriptions).where(eq(prescriptions.id, headerIds.pop()!))
})

beforeAll(async () => {
  const db = getDb()
  ;[{ id: patientId }] = await db.select({ id: patients.id }).from(patients).limit(1)
  ;[{ id: providerId }] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [m] = await db.select().from(medications).limit(1)
  const [withGeneric] = await db.select().from(medications).where(eq(medications.id, m.id))
  med = { id: withGeneric.id, genericName: withGeneric.genericName }
})

const base = () => ({ patientId, name: 'Brand', medicationClass: 'Antibiotic', startDate: '2026-10-24', status: 'active' as const, prescribedByProviderId: providerId, prescribedAt: new Date() })

describe('getPrintablePrescriptions (WS1 T7)', () => {
  it('a v2 row carries pattern, route, food timing, quantity, generic name and header advice', async () => {
    const db = getDb()
    const [header] = await db.insert(prescriptions).values({ patientId, prescribedByProviderId: providerId, advice: 'Drink plenty of water', enteredByName: 'Dr T' }).returning()
    headerIds.push(header.id)
    const [ep] = await db.insert(medicationEpisodes).values({
      ...base(), medicationId: med.id, prescriptionId: header.id,
      dose: '500 mg', dosePattern: '1-0-1', route: 'oral', foodTiming: 'after_food', isSos: false,
      quantityPrescribed: 10, frequencyPerDay: 2, durationDays: 5,
    }).returning()
    episodeIds.push(ep.id)

    const [row] = (await getPrintablePrescriptions([ep.id]))!
    expect(row.dosePattern).toBe('1-0-1')
    expect(row.route).toBe('oral')
    expect(row.foodTiming).toBe('after_food')
    expect(row.isSos).toBe(false)
    expect(row.quantityPrescribed).toBe(10)
    expect(row.genericName).toBe(med.genericName)
    expect(row.advice).toBe('Drink plenty of water')
  })

  it('a legacy row (no pattern, no header, no catalogue link) still prints', async () => {
    const [ep] = await getDb().insert(medicationEpisodes).values({ ...base(), dose: '5 mg', frequencyPerDay: 2, durationDays: 7 }).returning()
    episodeIds.push(ep.id)
    const [row] = (await getPrintablePrescriptions([ep.id]))!
    expect(row.dosePattern).toBeNull()
    expect(row.genericName).toBeNull()
    expect(row.advice).toBeNull()
    expect(row.frequencyPerDay).toBe(2)
    expect(row.isSos).toBe(false)
  })
})
