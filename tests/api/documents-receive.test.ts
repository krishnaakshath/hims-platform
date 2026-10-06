// @vitest-environment node
//
// This route reads a real multipart FormData body via `request.formData()`.
// Under this project's default jsdom test environment, `File`/`FormData` are
// jsdom's own realm-specific classes, but the `Request` used to construct
// the test request falls through to Node's native (undici) implementation
// (jsdom doesn't provide one). undici's FormData-body serialization does a
// strict webidl brand check on each value, which a jsdom File fails even
// though it's a genuine File -- see tests/api/patients-insurance-card.test.ts
// for the same class of jsdom/Node realm mismatch.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as receiveDocument } from '@/app/api/documents/route'
import { getDb } from '@/db/client'
import { documents, admissions, providers } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })),
  del: vi.fn(async () => {}),
}))

import { put as mockedPut } from '@vercel/blob'

const createdDocumentIds: number[] = []
const createdAdmissionIds: number[] = []

afterEach(async () => {
  sessionRole = 'crc'
  vi.mocked(mockedPut).mockClear()
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdAdmissionIds.length > 0) {
    await db.delete(admissions).where(eq(admissions.id, createdAdmissionIds.pop()!))
  }
})

function formDataReq(fields: Record<string, string>, file?: File) {
  const fd = new FormData()
  for (const [key, value] of Object.entries(fields)) fd.set(key, value)
  if (file) fd.set('file', file)
  return new Request('http://localhost', { method: 'POST', body: fd })
}

function baseFields(overrides: Record<string, string> = {}) {
  return {
    name: 'Test Document.pdf',
    documentDate: '2026-09-29',
    receivedFrom: 'Fax',
    documentType: 'other',
    ...overrides,
  }
}

async function getDocumentRow(id: number) {
  const [row] = await getDb().select().from(documents).where(eq(documents.id, id))
  return row
}

describe('POST /api/documents', () => {
  it('accepts a JPEG with no patientId', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.jpg', { type: 'image/jpeg' })
    const res = await receiveDocument(formDataReq(baseFields(), file) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)

    const row = await getDocumentRow(body.id)
    expect(row.patientId).toBeNull()
    expect(row.status).toBe('new')
    expect(row.filedByName).toBeNull()
    expect(row.fileUrl).toContain('https://blob.test/documents/')
    expect(row.fileType).toBe('JPG')
  })

  it('accepts an application/pdf upload', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(formDataReq(baseFields(), file) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)

    const row = await getDocumentRow(body.id)
    expect(row.fileType).toBe('PDF')
  })

  it('sets filedByName and filedAt from the server session when a patientId is supplied', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(formDataReq(baseFields({ patientId: 'RD-0001' }), file) as never)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)

    const row = await getDocumentRow(body.id)
    expect(row.patientId).toBe('RD-0001')
    expect(row.filedByName).toBe('Jamie Ruiz')
    expect(row.filedAt).not.toBeNull()
  })

  it('stores a matching admissionId when both patientId and admissionId are supplied', async () => {
    const db = getDb()
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    const [admission] = await db
      .insert(admissions)
      .values({ patientId: 'RD-0001', attendingProviderId: providerRow.id })
      .returning()
    createdAdmissionIds.push(admission.id)

    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(
      formDataReq(baseFields({ patientId: 'RD-0001', admissionId: String(admission.id) }), file) as never
    )
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)

    const row = await getDocumentRow(body.id)
    expect(row.admissionId).toBe(admission.id)
  })

  it('rejects an admissionId belonging to a different patient, and creates no row', async () => {
    const db = getDb()
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    const [admission] = await db
      .insert(admissions)
      .values({ patientId: 'RD-0001', attendingProviderId: providerRow.id })
      .returning()
    createdAdmissionIds.push(admission.id)

    const marker = `Mismatched admission doc ${Date.now()}.pdf`
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(
      formDataReq(
        baseFields({ name: marker, patientId: 'RD-0002', admissionId: String(admission.id) }),
        file
      ) as never
    )
    expect(res.status).toBe(400)

    const [existing] = await db.select().from(documents).where(eq(documents.name, marker))
    expect(existing).toBeUndefined()
  })

  it('rejects an admissionId with no patientId', async () => {
    const db = getDb()
    const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
    const [admission] = await db
      .insert(admissions)
      .values({ patientId: 'RD-0001', attendingProviderId: providerRow.id })
      .returning()
    createdAdmissionIds.push(admission.id)

    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(
      formDataReq(baseFields({ admissionId: String(admission.id) }), file) as never
    )
    expect(res.status).toBe(400)
  })

  it('rejects a patientId that does not exist, with a 400 not a 500', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(
      formDataReq(baseFields({ patientId: 'RD-NO-SUCH-PATIENT' }), file) as never
    )
    expect(res.status).toBe(400)
  })

  it('rejects text/plain and never calls put', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'notes.txt', { type: 'text/plain' })
    const res = await receiveDocument(formDataReq(baseFields(), file) as never)
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('rejects a file over 8MB and never calls put', async () => {
    const file = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(formDataReq(baseFields(), file) as never)
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('rejects a missing file', async () => {
    const res = await receiveDocument(formDataReq(baseFields()) as never)
    expect(res.status).toBe(400)
  })

  it('rejects a documentType outside the enum', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(
      formDataReq(baseFields({ documentType: 'not_a_real_type' }), file) as never
    )
    expect(res.status).toBe(400)
  })

  it('rejects sessionRole "pi"', async () => {
    sessionRole = 'pi'
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(formDataReq(baseFields(), file) as never)
    expect(res.status).toBe(403)
  })

  it('rejects a labOrderId form field (.strict() mass-assignment guard)', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.pdf', { type: 'application/pdf' })
    const res = await receiveDocument(formDataReq(baseFields({ labOrderId: '1' }), file) as never)
    expect(res.status).toBe(400)
    expect(vi.mocked(mockedPut)).not.toHaveBeenCalled()
  })
})
