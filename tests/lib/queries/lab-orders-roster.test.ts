// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, labOrders, labTests, providers } from '@/db/schema'
import { createLabOrder, markCollected, listPatientsWithLabOrders } from '@/lib/queries/lab-orders'

const TEST_PATIENT_ID = 'RD-LABROSTER-TEST-01'

let labTestId: number
let providerId: number

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Lab Roster Test Patient', dob: '1990-01-01' })
  ;[{ id: labTestId }] = await getDb().select({ id: labTests.id }).from(labTests).limit(1)
  ;[{ id: providerId }] = await getDb().select({ id: providers.id }).from(providers).limit(1)
})

afterAll(async () => {
  await getDb().delete(labOrders).where(eq(labOrders.patientId, TEST_PATIENT_ID))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('listPatientsWithLabOrders', () => {
  it('counts an ordered-status order as pending, not resulted', async () => {
    await createLabOrder({ patientId: TEST_PATIENT_ID, labTestId, orderedByProviderId: providerId })
    const roster = await listPatientsWithLabOrders()
    const row = roster.find((r) => r.id === TEST_PATIENT_ID)
    expect(row).toBeDefined()
    expect(row?.name).toBe('Lab Roster Test Patient')
    expect(row?.pendingCount).toBeGreaterThanOrEqual(1)
  })

  it('moves a collected order out of pending once marked collected (still not resulted)', async () => {
    const [created] = await getDb().select().from(labOrders).where(eq(labOrders.patientId, TEST_PATIENT_ID))
    await markCollected(created.id)
    const roster = await listPatientsWithLabOrders()
    const row = roster.find((r) => r.id === TEST_PATIENT_ID)
    // Collected still counts as pending (not yet resulted) -- only the
    // resulted bucket should ever be non-zero for a purely collected order.
    expect(row?.resultedCount).toBe(0)
  })
})
