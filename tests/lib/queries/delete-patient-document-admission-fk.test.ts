import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getDb } from '@/db/client'
import { documents, admissions, patients, providers } from '@/db/schema'

// Proves, against the real Postgres FK constraint (not by eyeballing
// deletePatient()'s statement ordering in src/lib/queries/patients.ts), that
// documents must be deleted (or have admission_id nulled) before admissions
// -- the FK-ordering fix applied to deletePatient() for Review Focus #1.
//
// This does NOT call deletePatient(): that would really delete a seeded
// patient from this shared dev database. Instead this test creates its own
// throwaway rows and issues the same scoped statements deletePatient() now
// issues, to exercise the identical FK constraint safely.

let admissionId: number | undefined
let documentId: number | undefined

afterEach(async () => {
  const db = getDb()
  if (documentId != null) {
    await db.delete(documents).where(eq(documents.id, documentId))
    documentId = undefined
  }
  if (admissionId != null) {
    await db.delete(admissions).where(eq(admissions.id, admissionId))
    admissionId = undefined
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

describe('deletePatient document/admission FK ordering', () => {
  it("deleting an admission fails while a document references it, and succeeds once the document is gone", async () => {
    const db = getDb()
    // Narrow selects only -- the live `patients` table has columns from other
    // in-flight branches not yet reflected in this branch's schema.ts, so a
    // bare select().from(patients) can 42703 on an unrelated column. Only the
    // id is needed here.
    const [patient] = await db.select({ id: patients.id }).from(patients).limit(1)
    const [provider] = await db.select({ id: providers.id }).from(providers).limit(1)

    const [admission] = await db.insert(admissions).values({
      patientId: patient.id,
      attendingProviderId: provider.id,
    }).returning()
    admissionId = admission.id

    const [document] = await db.insert(documents).values({
      name: 'FK order test doc.pdf', documentDate: '2026-09-21', receivedFrom: 'Fax',
      documentType: 'other', fileType: 'PDF', admissionId: admission.id,
    }).returning()
    documentId = document.id

    await expectForeignKeyViolation(db.delete(admissions).where(eq(admissions.id, admission.id)))

    await db.delete(documents).where(eq(documents.id, document.id))
    documentId = undefined

    await expect(db.delete(admissions).where(eq(admissions.id, admission.id))).resolves.not.toThrow()
    admissionId = undefined
  })

  it("deletePatient's source deletes documents before admissions", () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/queries/patients.ts'), 'utf-8')
    const documentsDeleteIndex = source.indexOf('.delete(documents)')
    const admissionsDeleteIndex = source.indexOf('.delete(admissions)')
    expect(documentsDeleteIndex).toBeGreaterThan(-1)
    expect(admissionsDeleteIndex).toBeGreaterThan(-1)
    expect(documentsDeleteIndex).toBeLessThan(admissionsDeleteIndex)
  })
})
