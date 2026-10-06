import { describe, it, expect, vi, afterEach } from 'vitest'
import { GET } from '@/app/api/documents/[id]/download/route'
import { getDb } from '@/db/client'
import { documents, auditLog, labOrders, labTests, patients, providers } from '@/db/schema'
import { eq } from 'drizzle-orm'

import type { Role } from '@/lib/auth'
import { get as mockedGet } from '@vercel/blob'

let sessionRole: Role = 'crc'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))

// The blob store is private -- the download route can no longer redirect to
// the stored URL (a browser can't authenticate to it), it streams the bytes
// itself via @vercel/blob's get(). Mocked the same way as the upload routes
// mock put().
vi.mock('@vercel/blob', () => ({
  get: vi.fn(async (urlOrPathname: string) => ({
    statusCode: 200 as const,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('fake-file-bytes'))
        controller.close()
      },
    }),
    headers: new Headers(),
    blob: {
      url: urlOrPathname,
      downloadUrl: urlOrPathname,
      pathname: urlOrPathname,
      contentDisposition: '',
      cacheControl: '',
      uploadedAt: new Date(),
      etag: 'test-etag',
      contentType: 'application/pdf',
      size: 15,
    },
  })),
}))

const createdDocumentIds: number[] = []
const createdOrderIds: number[] = []

afterEach(async () => {
  sessionRole = 'crc'
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    const id = createdDocumentIds.pop()!
    await db.delete(auditLog).where(eq(auditLog.action, `downloaded document ${id}`))
    await db.delete(documents).where(eq(documents.id, id))
  }
  while (createdOrderIds.length > 0) {
    await db.delete(labOrders).where(eq(labOrders.id, createdOrderIds.pop()!))
  }
  vi.mocked(mockedGet).mockClear()
})

async function createThrowawayLabOrder() {
  const db = getDb()
  const [test] = await db.select({ id: labTests.id }).from(labTests).limit(1)
  const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
  const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [order] = await db
    .insert(labOrders)
    .values({ patientId: patientRow.id, labTestId: test.id, orderedByProviderId: providerRow.id })
    .returning()
  createdOrderIds.push(order.id)
  return order
}

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

function downloadReq(id: number) {
  return new Request(`http://localhost/api/documents/${id}/download`)
}

describe('GET /api/documents/[id]/download', () => {
  it('streams the file bytes for a crc', async () => {
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/some-file.pdf' })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(await res.text()).toBe('fake-file-bytes')
  })

  it('returns 404 for a metadata-only row with no stored file', async () => {
    const doc = await createThrowawayDocument({ fileUrl: null })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(404)
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await GET(downloadReq(999999) as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })

  it('writes an audit row on a successful download', async () => {
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/audited.pdf' })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const [row] = await getDb().select().from(auditLog).where(eq(auditLog.action, `downloaded document ${doc.id}`))
    expect(row).toBeDefined()
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk'] as const)('streams the file bytes for %s', async (role) => {
    sessionRole = role
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/some-file.pdf' })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fake-file-bytes')
  })

  it.each(['pharmacy', 'billing'] as const)('403s %s without touching the blob store', async (role) => {
    sessionRole = role
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/some-file.pdf' })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(mockedGet).not.toHaveBeenCalled()
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, `downloaded document ${doc.id}`))
    expect(rows).toHaveLength(0)
  })

  it('admits labs for a document attached to a lab order', async () => {
    sessionRole = 'labs'
    const order = await createThrowawayLabOrder()
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/imaging.pdf', labOrderId: order.id })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('fake-file-bytes')
  })

  it('403s labs for a document with no lab order, without touching the blob store', async () => {
    sessionRole = 'labs'
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/some-file.pdf', labOrderId: null })

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(mockedGet).not.toHaveBeenCalled()
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, `downloaded document ${doc.id}`))
    expect(rows).toHaveLength(0)
  })

  it('404s with "Stored file is missing" when the blob SDK throws (non-Blob URL), with no audit row and no URL logged', async () => {
    const doc = await createThrowawayDocument({ fileUrl: 'https://not-a-blob.example/secret-path/file.pdf' })
    const err = new Error('Vercel Blob: Invalid URL: https://not-a-blob.example/secret-path/file.pdf')
    err.name = 'BlobError'
    vi.mocked(mockedGet).mockRejectedValueOnce(err)
    const logs: unknown[][] = []
    const spies = (['error', 'warn', 'log'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a) }))

    const res = await GET(downloadReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    spies.forEach((s) => s.mockRestore())

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Stored file is missing' })
    const rows = await getDb().select().from(auditLog).where(eq(auditLog.action, `downloaded document ${doc.id}`))
    expect(rows).toHaveLength(0)
    expect(JSON.stringify(logs)).not.toContain('secret-path')
    expect(JSON.stringify(logs)).toContain('BlobError')
  })
})
