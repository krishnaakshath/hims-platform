import { describe, it, expect, vi, afterEach } from 'vitest'
import { DELETE } from '@/app/api/documents/[id]/route'
import { getDb } from '@/db/client'
import { documents } from '@/db/schema'
import { eq } from 'drizzle-orm'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'admin'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Jamie Ruiz' })) }))
vi.mock('@vercel/blob', () => ({ del: vi.fn(async () => {}) }))

import { del as mockedDel } from '@vercel/blob'

const createdDocumentIds: number[] = []

afterEach(async () => {
  sessionRole = 'admin'
  vi.mocked(mockedDel).mockReset()
  vi.mocked(mockedDel).mockImplementation(async () => {})
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
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

function deleteReq(id: number) {
  return new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' })
}

async function getDocumentRow(id: number) {
  const [row] = await getDb().select().from(documents).where(eq(documents.id, id))
  return row
}

describe('DELETE /api/documents/[id]', () => {
  it('admin deletes a document with a fileUrl, and Blob del is called with it', async () => {
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/some-file.pdf' })

    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row).toBeUndefined()
    expect(mockedDel).toHaveBeenCalledTimes(1)
    expect(mockedDel).toHaveBeenCalledWith('https://blob.test/documents/some-file.pdf')

    // Row is gone -- nothing left to clean up via createdDocumentIds.
    createdDocumentIds.splice(createdDocumentIds.indexOf(doc.id), 1)
  })

  it('admin deletes a legacy document with fileUrl: null, and Blob del is never called', async () => {
    const doc = await createThrowawayDocument({ fileUrl: null })

    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row).toBeUndefined()
    expect(mockedDel).not.toHaveBeenCalled()

    createdDocumentIds.splice(createdDocumentIds.indexOf(doc.id), 1)
  })

  it('a Blob del that rejects does not fail the request or reverse the DB delete', async () => {
    vi.mocked(mockedDel).mockImplementationOnce(async () => {
      throw new Error('blob store unavailable')
    })
    const doc = await createThrowawayDocument({ fileUrl: 'https://blob.test/documents/flaky.pdf' })

    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(200)

    const row = await getDocumentRow(doc.id)
    expect(row).toBeUndefined()

    createdDocumentIds.splice(createdDocumentIds.indexOf(doc.id), 1)
  })

  it('rejects role "crc"', async () => {
    sessionRole = 'crc'
    const doc = await createThrowawayDocument()
    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects role "frontdesk"', async () => {
    sessionRole = 'frontdesk'
    const doc = await createThrowawayDocument()
    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(403)
  })

  it('rejects role "pi"', async () => {
    sessionRole = 'pi'
    const doc = await createThrowawayDocument()
    const res = await DELETE(deleteReq(doc.id) as never, { params: Promise.resolve({ id: String(doc.id) }) })
    expect(res.status).toBe(403)
  })

  it('returns 404 for a non-existent id', async () => {
    const res = await DELETE(deleteReq(999999) as never, { params: Promise.resolve({ id: '999999' }) })
    expect(res.status).toBe(404)
  })
})
