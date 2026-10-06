import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getDb } from '@/db/client'
import { documents, labTests, labOrders, patients, providers } from '@/db/schema'

// Proves, against the real Postgres FK constraint (not by eyeballing
// deletePatient()'s statement ordering in src/lib/queries/patients.ts), that
// documents.lab_order_id must be nulled out before lab_orders can be deleted
// -- the FK-ordering fix applied to deletePatient() for Review Focus #2.
//
// This does NOT call deletePatient(): that would really delete a seeded
// patient from this shared dev database. Instead this test creates its own
// throwaway rows and issues the same scoped statements deletePatient() now
// issues, to exercise the identical FK constraint safely.

let labTestId: number | undefined
let labOrderId: number | undefined
let documentId: number | undefined

afterEach(async () => {
  const db = getDb()
  if (documentId != null) {
    await db.delete(documents).where(eq(documents.id, documentId))
    documentId = undefined
  }
  if (labOrderId != null) {
    await db.delete(labOrders).where(eq(labOrders.id, labOrderId))
    labOrderId = undefined
  }
  if (labTestId != null) {
    await db.delete(labTests).where(eq(labTests.id, labTestId))
    labTestId = undefined
  }
})

async function expectForeignKeyViolation(promise: Promise<unknown>) {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(Error)
  const cause = (caught as { cause?: { code?: string; message?: string } }).cause
  expect(cause?.code).toBe('23503')
}

describe('deletePatient lab order/document FK ordering', () => {
  it('deleting a lab order fails while a document references it, and succeeds once the reference is cleared', async () => {
    const db = getDb()
    // Narrow selects only -- the live `patients` table has columns from other
    // in-flight branches not yet reflected in this branch's schema.ts, so a
    // bare select().from(patients) can 42703 on an unrelated column.
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)
    const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)

    const [test] = await db.insert(labTests).values({ name: 'FK order test imaging', code: 'FK-ORDER-DOC-TEST', category: 'imaging' }).returning()
    labTestId = test.id

    const [order] = await db.insert(labOrders).values({
      patientId: patient.id, labTestId: test.id, orderedByProviderId: provider.id,
    }).returning()
    labOrderId = order.id

    const [document] = await db.insert(documents).values({
      name: 'FK order test doc.pdf', documentDate: '2026-09-21', receivedFrom: 'Radiology',
      documentType: 'imaging_result', fileType: 'PDF', patientId: null, labOrderId: order.id,
    }).returning()
    documentId = document.id

    await expectForeignKeyViolation(db.delete(labOrders).where(eq(labOrders.id, order.id)))

    await db.update(documents).set({ labOrderId: null }).where(eq(documents.id, document.id))

    await expect(db.delete(labOrders).where(eq(labOrders.id, order.id))).resolves.not.toThrow()
    labOrderId = undefined
  })

  it("deletePatient's source nulls out documents.labOrderId before deleting labOrders", () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/queries/patients.ts'), 'utf-8')
    const nullOutIndex = source.indexOf('set({ labOrderId: null })')
    const deleteLabOrdersIndex = source.indexOf('.delete(labOrders)')
    expect(nullOutIndex).toBeGreaterThan(-1)
    expect(deleteLabOrdersIndex).toBeGreaterThan(-1)
    expect(nullOutIndex).toBeLessThan(deleteLabOrdersIndex)
  })
})
