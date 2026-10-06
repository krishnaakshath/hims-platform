import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { documents, admissions } from '@/db/schema'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(documents).where(eq(documents.id, createdIds.pop()!))
})

describe('documents schema — documentType, admissionId, fileUrl, filing audit', () => {
  it('inserts an insurance_eob document with a blob URL and no patient (Unfiled)', async () => {
    const [row] = await getDb().insert(documents).values({
      name: 'EOB - Aetna 2026-09.pdf', documentDate: '2026-09-20', receivedFrom: 'Mail',
      documentType: 'insurance_eob', fileType: 'PDF', fileUrl: 'https://blob.test/documents/x.pdf',
    }).returning()
    createdIds.push(row.id)
    expect(row.status).toBe('new')
    expect(row.patientId).toBeNull()
    expect(row.admissionId).toBeNull()
    expect(row.filedByName).toBeNull()
    expect(row.filedAt).toBeNull()
  })

  it('accepts every new insurance_* documentType value', async () => {
    for (const documentType of ['insurance_card_primary_front', 'insurance_card_primary_back', 'insurance_card_secondary_front', 'insurance_card_secondary_back', 'insurance_eob', 'insurance_authorization'] as const) {
      const [row] = await getDb().insert(documents).values({
        name: `${documentType}.pdf`, documentDate: '2026-09-20', receivedFrom: 'Fax', documentType, fileType: 'PDF',
      }).returning()
      createdIds.push(row.id)
      expect(row.documentType).toBe(documentType)
    }
  })

  it('stores an admissionId referencing a real admission, alongside its patient and filing trail', async () => {
    const [admission] = await getDb().select().from(admissions).limit(1)
    const [row] = await getDb().insert(documents).values({
      name: 'Inpatient consent.pdf', documentDate: '2026-09-21', receivedFrom: 'Ward B',
      documentType: 'legal_document', fileType: 'PDF', patientId: admission.patientId,
      admissionId: admission.id, filedByName: 'Jamie Ruiz', filedAt: new Date(),
    }).returning()
    createdIds.push(row.id)
    expect(row.admissionId).toBe(admission.id)
    expect(row.filedByName).toBe('Jamie Ruiz')
  })

  it('rejects a documentType outside the enum', async () => {
    await expect(getDb().insert(documents).values({
      name: 'x', documentDate: '2026-09-21', receivedFrom: 'Fax',
      documentType: 'not_a_real_type' as never, fileType: 'PDF',
    })).rejects.toThrow()
  })

  it('leaves the pre-existing seeded rows readable with their original type values and a null filing trail', async () => {
    const rows = await getDb().select().from(documents).where(eq(documents.id, 1))
    expect(['other', 'drivers_license', 'legal_document']).toContain(rows[0].documentType)
    expect(rows[0].fileUrl).toBeNull()
    expect(rows[0].filedByName).toBeNull() // Scope Decision 1: no synthetic backfill
  })
})
