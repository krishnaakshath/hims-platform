import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, labTests, labOrders, providers, documents } from '@/db/schema'

// Real DB, following tests/db/lab-schema.test.ts's shape: throwaway labTests/
// labOrders/documents rows rather than seeded ones, cleaned up per test.

const createdTestIds: number[] = []
const createdOrderIds: number[] = []
const createdDocumentIds: number[] = []

afterEach(async () => {
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdOrderIds.length > 0) {
    await db.delete(labOrders).where(eq(labOrders.id, createdOrderIds.pop()!))
  }
  while (createdTestIds.length > 0) {
    await db.delete(labTests).where(eq(labTests.id, createdTestIds.pop()!))
  }
})

describe('imaging schema — labTests.category, imaging_result, documents.labOrderId', () => {
  it('defaults a new labTests row to category "lab"', async () => {
    const db = getDb()
    const [row] = await db.insert(labTests).values({ name: 'Throwaway Lab Test', code: 'IMG-SCHEMA-1' }).returning()
    createdTestIds.push(row.id)
    expect(row.category).toBe('lab')
  })

  it('stores category "imaging" on a labTests row with null unit and reference range', async () => {
    const db = getDb()
    const [row] = await db.insert(labTests).values({
      name: 'Throwaway Imaging Test', code: 'IMG-SCHEMA-2', category: 'imaging',
    }).returning()
    createdTestIds.push(row.id)
    expect(row.category).toBe('imaging')
    expect(row.defaultUnit).toBeNull()
    expect(row.referenceRange).toBeNull()
  })

  it('rejects a category outside the enum', async () => {
    const db = getDb()
    await expect(
      db.insert(labTests).values({ name: 'Bad Category Test', code: 'IMG-SCHEMA-3', category: 'radiology' as never })
    ).rejects.toThrow()
  })

  it("inserts an imaging_result document carrying a labOrderId and the order's patientId", async () => {
    const db = getDb()
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)
    const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)
    const [test] = await db.insert(labTests).values({ name: 'Throwaway Imaging Order Test', code: 'IMG-SCHEMA-4', category: 'imaging' }).returning()
    createdTestIds.push(test.id)
    const [order] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: test.id, orderedByProviderId: provider.id }).returning()
    createdOrderIds.push(order.id)

    const [doc] = await db.insert(documents).values({
      name: 'Chest XR.pdf', documentDate: '2026-09-29', receivedFrom: 'Radiology',
      documentType: 'imaging_result', fileType: 'PDF', patientId: order.patientId, labOrderId: order.id,
    }).returning()
    createdDocumentIds.push(doc.id)

    expect(doc.documentType).toBe('imaging_result')
    expect(doc.labOrderId).toBe(order.id)
    expect(doc.admissionId).toBeNull()
  })

  it('defaults labOrderId to null on a document with no order', async () => {
    const db = getDb()
    const [doc] = await db.insert(documents).values({
      name: 'Unrelated Doc.pdf', documentDate: '2026-09-29', receivedFrom: 'Fax',
      documentType: 'other', fileType: 'PDF',
    }).returning()
    createdDocumentIds.push(doc.id)
    expect(doc.labOrderId).toBeNull()
  })

  it('rejects a labOrderId that references no lab order', async () => {
    const db = getDb()
    await expect(
      db.insert(documents).values({
        name: 'Bad Order Ref.pdf', documentDate: '2026-09-29', receivedFrom: 'Fax',
        documentType: 'other', fileType: 'PDF', labOrderId: 2_000_000_000,
      })
    ).rejects.toThrow()
  })
})
