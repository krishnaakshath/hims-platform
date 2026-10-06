// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medications, medicationDispenses } from '@/db/schema'
import { listAllDispensesWithBilling } from '@/lib/queries/medication-dispenses'

const TEST_PATIENT_ID = 'RD-PHARMBILL-TEST-01'
let medicationId: number
let dispenseId: number

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Pharmacy Billing Test Patient', dob: '1990-01-01' })
  ;[{ id: medicationId }] = await getDb().select({ id: medications.id }).from(medications).limit(1)
  const [created] = await getDb().insert(medicationDispenses).values({
    patientId: TEST_PATIENT_ID, medicationId, quantity: 5, dispensedByName: 'Test Pharmacist',
  }).returning()
  dispenseId = created.id
})

afterAll(async () => {
  await getDb().delete(medicationDispenses).where(eq(medicationDispenses.id, dispenseId))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('listAllDispensesWithBilling', () => {
  it('includes an unbilled dispense with charge: null, scoped to dispenses only (not the general charges table)', async () => {
    const rows = await listAllDispensesWithBilling()
    const row = rows.find((r) => r.dispenseId === dispenseId)
    expect(row).toBeDefined()
    expect(row?.patientName).toBe('Pharmacy Billing Test Patient')
    expect(row?.quantity).toBe(5)
    expect(row?.charge).toBeNull()
  })
})
