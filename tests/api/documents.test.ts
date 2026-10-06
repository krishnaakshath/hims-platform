import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { PATCH } from '@/app/api/documents/[id]/route'
import { getDb } from '@/db/client'
import { documents, admissions, providers } from '@/db/schema'
import { eq } from 'drizzle-orm'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))

// This suite mutates a real seeded row (id 3) against the shared dev
// database -- restore its original 'new' status afterward, same pattern as
// Phase 3/5's shared-DB test cleanup, so repeated runs stay idempotent and
// this task's own manual-verification pass isn't left looking at stale data.
afterAll(async () => {
  await getDb().update(documents).set({ status: 'new' }).where(eq(documents.id, 3))
})

const createdDocumentIds: number[] = []
const createdAdmissionIds: number[] = []

afterEach(async () => {
  sessionRole = 'crc'
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdAdmissionIds.length > 0) {
    await db.delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  }
})

async function createThrowawayDocument(overrides: Partial<typeof documents.$inferInsert> = {}) {
  const [row] = await getDb()
    .insert(documents)
    .values({
      name: 'Throwaway Doc.pdf',
      documentDate: '2026-09-29',
      receivedFrom: 'Fax',
      documentType: 'other',
      fileType: 'PDF',
      fileUrl: null,
      patientId: null,
      admissionId: null,
      filedByName: null,
      filedAt: null,
      ...overrides,
    })
    .returning()
  createdDocumentIds.push(row.id)
  return row
}

async function createAdmission(patientId: string) {
  const db = getDb()
  const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [admission] = await db
    .insert(admissions)
    .values({ patientId, attendingProviderId: providerRow.id })
    .returning()
  createdAdmissionIds.push(admission.id)
  return admission
}

function patchReq(id: number, body: unknown) {
  return new Request(`http://localhost/api/documents/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

async function getDocumentRow(id: number) {
  const [row] = await getDb().select().from(documents).where(eq(documents.id, id))
  return row
}

describe('PATCH /api/documents/[id]', () => {
  it('rejects an invalid status value', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects an unknown field (mass-assignment guard)', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ status: 'processed', name: 'Renamed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('returns 404 for a non-existent document', async () => {
    const req = new Request('http://localhost/api/documents/999999', { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('marks a seeded document processed', async () => {
    const req = new Request('http://localhost/api/documents/3', { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '3' }) })
    expect(res.status).toBe(200)
  })

  it('files an unfiled document to a patient, stamping filedByName and filedAt', async () => {
    const doc = await createThrowawayDocument()
    const res = await PATCH(patchReq(doc.id, { patientId: 'RD-0001' }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row.patientId).toBe('RD-0001')
    expect(row.filedByName).toBe('Jamie Ruiz')
    expect(row.filedAt).not.toBeNull()
  })

  it('unfiling a document (patientId: null) clears filedByName, filedAt, and admissionId', async () => {
    const admission = await createAdmission('RD-0001')
    const doc = await createThrowawayDocument({
      patientId: 'RD-0001',
      admissionId: admission.id,
      filedByName: 'Some Prior Staffer',
      filedAt: new Date(),
    })

    const res = await PATCH(patchReq(doc.id, { patientId: null }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row.patientId).toBeNull()
    expect(row.filedByName).toBeNull()
    expect(row.filedAt).toBeNull()
    expect(row.admissionId).toBeNull()
  })

  it('re-filing to a different patient clears an admissionId that belonged to the previous patient', async () => {
    const admission = await createAdmission('RD-0001')
    const doc = await createThrowawayDocument({
      patientId: 'RD-0001',
      admissionId: admission.id,
      filedByName: 'Jamie Ruiz',
      filedAt: new Date(),
    })

    const res = await PATCH(patchReq(doc.id, { patientId: 'RD-0002' }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row.patientId).toBe('RD-0002')
    expect(row.admissionId).toBeNull()
  })

  it('rejects an admissionId that belongs to a different patient than the effective patientId, leaving the row unchanged', async () => {
    const admission = await createAdmission('RD-0001')
    const doc = await createThrowawayDocument({ patientId: 'RD-0002', documentType: 'other' })

    const res = await PATCH(patchReq(doc.id, { admissionId: admission.id }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(400)

    const row = await getDocumentRow(doc.id)
    expect(row.admissionId).toBeNull()
    expect(row.documentType).toBe('other')
  })

  it('retypes a document', async () => {
    const doc = await createThrowawayDocument({ documentType: 'other' })

    const res = await PATCH(patchReq(doc.id, { documentType: 'insurance_authorization' }) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row.documentType).toBe('insurance_authorization')
  })

  it('rejects an empty body', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({}) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects a client-supplied filedByName (server-set fields are not client-settable)', async () => {
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ filedByName: 'Forged Name' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })

  it('rejects role "pi"', async () => {
    sessionRole = 'pi'
    const req = new Request('http://localhost/api/documents/1', { method: 'PATCH', body: JSON.stringify({ status: 'processed' }) })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(403)
  })

  it('rejects labOrderId as an unknown field (.strict() mass-assignment guard)', async () => {
    const res = await PATCH(patchReq(1, { labOrderId: 1 }) as never, { params: Promise.resolve({ id: '1' }) })
    expect(res.status).toBe(400)
  })
})
