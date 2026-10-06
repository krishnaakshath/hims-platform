import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { documents, admissions, patients, providers, labTests, labOrders } from '@/db/schema'
import {
  listDocuments,
  getDocument,
  createDocument,
  listDocumentsForPatient,
  isAdmissionForPatient,
  listImagingForOrders,
} from '@/lib/queries/documents'

describe('listDocuments', () => {
  it('returns the seeded documents joined with patient info', async () => {
    const rows = await listDocuments()
    expect(rows.length).toBeGreaterThanOrEqual(10)
    const linked = rows.find((d) => d.patientId === 'RD-0001')
    expect(linked?.patientName).toBeTruthy()
  })
})

describe('getDocument', () => {
  it('returns null for a non-existent id', async () => {
    const result = await getDocument(999999)
    expect(result).toBeNull()
  })
})

const createdDocumentIds: number[] = []
const createdAdmissionIds: number[] = []

afterEach(async () => {
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdAdmissionIds.length > 0) {
    await db.delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  }
})

describe('createDocument', () => {
  it('creates a document with patientId: null and leaves filing/admission fields null', async () => {
    const created = await createDocument({
      name: 'Unassigned scan.pdf',
      documentDate: '2026-09-29',
      receivedFrom: 'Fax',
      documentType: 'other',
      patientId: null,
      admissionId: null,
      labOrderId: null,
      fileUrl: 'https://blob.test/documents/abc-unassigned-scan.pdf',
      fileType: 'PDF',
      filedByName: null,
      filedAt: null,
    })
    createdDocumentIds.push(created.id)

    expect(created.status).toBe('new')
    expect(created.patientId).toBeNull()
    expect(created.filedByName).toBeNull()
    expect(created.filedAt).toBeNull()
    expect(created.admissionId).toBeNull()
    expect(created.fileUrl).toBe('https://blob.test/documents/abc-unassigned-scan.pdf')
  })

  it('creates a document with a real patientId and supplied filing info', async () => {
    const filedAt = new Date('2026-09-29T12:00:00Z')
    const created = await createDocument({
      name: 'Filed consent.pdf',
      documentDate: '2026-09-29',
      receivedFrom: 'Jamie Ruiz (CRC)',
      documentType: 'legal_document',
      patientId: 'RD-0001',
      admissionId: null,
      labOrderId: null,
      fileUrl: 'https://blob.test/documents/xyz-filed-consent.pdf',
      fileType: 'PDF',
      filedByName: 'Jamie Ruiz',
      filedAt,
    })
    createdDocumentIds.push(created.id)

    expect(created.patientId).toBe('RD-0001')
    expect(created.filedByName).toBe('Jamie Ruiz')
    expect(created.filedAt).toEqual(filedAt)
  })
})

describe('listDocumentsForPatient', () => {
  it("returns only RD-0001's documents, each with an admissionId property", async () => {
    const rows = await listDocumentsForPatient('RD-0001')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.patientId).toBe('RD-0001')
      expect(row).toHaveProperty('admissionId')
    }
  })

  it('returns [] for a patient id with no documents', async () => {
    const rows = await listDocumentsForPatient('RD-0001-no-such-suffix')
    expect(rows).toEqual([])
  })
})

describe('isAdmissionForPatient', () => {
  it('is true for the admission paired with its own patient, false for another patient, and false for a non-existent admission', async () => {
    const db = getDb()
    // Narrow selects only -- the live `patients` table has columns from other
    // in-flight branches not yet reflected in this branch's schema.ts, so a
    // bare select().from(patients) can 42703 on an unrelated column.
    const patientRows = await db.select({ id: patients.id }).from(patients).limit(2)
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    const [patientA, patientB] = patientRows

    const [admission] = await db
      .insert(admissions)
      .values({ patientId: patientA.id, attendingProviderId: providerRow.id })
      .returning()
    createdAdmissionIds.push(admission.id)

    await expect(isAdmissionForPatient(admission.id, patientA.id)).resolves.toBe(true)
    await expect(isAdmissionForPatient(admission.id, patientB.id)).resolves.toBe(false)
    await expect(isAdmissionForPatient(999999, patientA.id)).resolves.toBe(false)
  })
})

describe('listImagingForOrders', () => {
  let testRow: { id: number }
  let orderA: { id: number }
  let orderB: { id: number }
  let orderWithNoImages: { id: number }
  let docA1: { id: number }
  let docA2: { id: number }
  let docB: { id: number }
  let unattachedDoc: { id: number }

  beforeAll(async () => {
    const db = getDb()
    // Narrow selects only -- the live `patients` table has columns from other
    // in-flight branches not yet reflected in this branch's schema.ts, so a
    // bare select().from(patients) can 42703 on an unrelated column.
    const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    ;[testRow] = await db
      .insert(labTests)
      .values({ name: 'listImagingForOrders test imaging', code: 'LIST-IMG-TEST', category: 'imaging' })
      .returning()

    ;[orderA] = await db
      .insert(labOrders)
      .values({ patientId: patientRow.id, labTestId: testRow.id, orderedByProviderId: providerRow.id })
      .returning()
    ;[orderB] = await db
      .insert(labOrders)
      .values({ patientId: patientRow.id, labTestId: testRow.id, orderedByProviderId: providerRow.id })
      .returning()
    ;[orderWithNoImages] = await db
      .insert(labOrders)
      .values({ patientId: patientRow.id, labTestId: testRow.id, orderedByProviderId: providerRow.id })
      .returning()

    ;[docA1] = await db
      .insert(documents)
      .values({
        name: 'chest-ap.jpg',
        documentDate: '2026-09-29',
        receivedFrom: 'Radiology',
        documentType: 'imaging_result',
        fileType: 'JPG',
        fileUrl: 'https://blob.test/imaging/x.jpg',
        patientId: null,
        labOrderId: orderA.id,
        filedByName: 'Dr. Chen',
        filedAt: new Date('2026-09-29T12:00:00Z'),
      })
      .returning()
    ;[docA2] = await db
      .insert(documents)
      .values({
        name: 'chest-lat.jpg',
        documentDate: '2026-09-29',
        receivedFrom: 'Radiology',
        documentType: 'imaging_result',
        fileType: 'JPG',
        fileUrl: 'https://blob.test/imaging/y.jpg',
        patientId: null,
        labOrderId: orderA.id,
        filedByName: 'Dr. Chen',
        filedAt: new Date('2026-09-29T12:05:00Z'),
      })
      .returning()
    ;[docB] = await db
      .insert(documents)
      .values({
        name: 'knee-ap.jpg',
        documentDate: '2026-09-29',
        receivedFrom: 'Radiology',
        documentType: 'imaging_result',
        fileType: 'JPG',
        fileUrl: 'https://blob.test/imaging/z.jpg',
        patientId: null,
        labOrderId: orderB.id,
        filedByName: 'Dr. Chen',
        filedAt: new Date('2026-09-29T12:10:00Z'),
      })
      .returning()
    ;[unattachedDoc] = await db
      .insert(documents)
      .values({
        name: 'unrelated.pdf',
        documentDate: '2026-09-29',
        receivedFrom: 'Fax',
        documentType: 'other',
        fileType: 'PDF',
        fileUrl: null,
        patientId: null,
        labOrderId: null,
        filedByName: null,
        filedAt: null,
      })
      .returning()
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(documents).where(inArray(documents.id, [docA1.id, docA2.id, docB.id, unattachedDoc.id]))
    await db.delete(labOrders).where(inArray(labOrders.id, [orderA.id, orderB.id, orderWithNoImages.id]))
    await db.delete(labTests).where(eq(labTests.id, testRow.id))
  })

  it('returns an empty Map for an empty orderIds array without querying', async () => {
    expect(await listImagingForOrders([])).toEqual(new Map())
  })

  it("groups each order's attachments under its own id and excludes other orders' documents", async () => {
    const map = await listImagingForOrders([orderA.id, orderB.id])
    expect(map.get(orderA.id)!.map((a) => a.id).sort()).toEqual([docA1.id, docA2.id].sort())
    expect(map.get(orderB.id)!.map((a) => a.id)).toEqual([docB.id])
    expect([...map.values()].flat().some((a) => a.id === unattachedDoc.id)).toBe(false)
  })

  it('omits an order that has no attachments from the Map entirely', async () => {
    const map = await listImagingForOrders([orderA.id, orderWithNoImages.id])
    expect(map.has(orderWithNoImages.id)).toBe(false)
  })

  it('carries name, fileUrl, fileType and the filing trail on each attachment', async () => {
    const [attachment] = (await listImagingForOrders([orderA.id])).get(orderA.id)!
    expect(attachment.name).toBe('chest-ap.jpg')
    expect(attachment.fileUrl).toBe('https://blob.test/imaging/x.jpg')
    expect(attachment.fileType).toBe('JPG')
    expect(attachment.filedByName).toBe('Dr. Chen')
    expect(attachment.filedAt).toBeInstanceOf(Date)
  })
})
