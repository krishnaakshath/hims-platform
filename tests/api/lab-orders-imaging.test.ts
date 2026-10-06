// @vitest-environment node
//
// This route reads a real multipart FormData body via `request.formData()`.
// Under this project's default jsdom test environment, `File`/`FormData` are
// jsdom's own realm-specific classes, but the `Request` used to construct
// the test request falls through to Node's native (undici) implementation
// (jsdom doesn't provide one). undici's FormData-body serialization does a
// strict webidl brand check on each value, which a jsdom File fails even
// though it's a genuine File -- see tests/api/documents-receive.test.ts and
// tests/api/patients-insurance-card.test.ts for the same class of
// jsdom/Node realm mismatch.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { POST as attachImaging } from '@/app/api/lab-orders/[id]/imaging/route'
import { getDb } from '@/db/client'
import { documents, labOrders, labResults, labTests, patients, providers } from '@/db/schema'

type Role = 'admin' | 'pi' | 'crc' | 'frontdesk'
let sessionRole: Role = 'admin'
let sessionName = 'Test User'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: sessionName })) }))
vi.mock('@vercel/blob', () => ({
  put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })),
}))

import { put as mockedPut } from '@vercel/blob'

const createdOrderIds: number[] = []
const createdDocumentIds: number[] = []

afterEach(async () => {
  sessionRole = 'admin'
  sessionName = 'Test User'
  vi.mocked(mockedPut).mockClear()
  const db = getDb()
  while (createdDocumentIds.length > 0) {
    await db.delete(documents).where(eq(documents.id, createdDocumentIds.pop()!))
  }
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await db.delete(documents).where(eq(documents.labOrderId, id))
    await db.delete(labResults).where(eq(labResults.labOrderId, id))
    await db.delete(labOrders).where(eq(labOrders.id, id))
  }
})

async function seedOrder(status: 'ordered' | 'collected' | 'resulted' | 'cancelled') {
  const db = getDb()
  const [test] = await db.select({ id: labTests.id }).from(labTests).limit(1)
  const [patientRow] = await db.select({ id: patients.id }).from(patients).limit(1)
  const [providerRow] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [order] = await db.insert(labOrders).values({
    patientId: patientRow.id,
    labTestId: test.id,
    orderedByProviderId: providerRow.id,
    status,
    collectedAt: status === 'collected' || status === 'resulted' ? new Date() : null,
  }).returning()
  createdOrderIds.push(order.id)

  if (status === 'resulted') {
    await db.insert(labResults).values({
      labOrderId: order.id,
      value: '5',
      flag: 'normal',
      resultedByName: 'Seed Setup',
    })
  }

  return order
}

function jpegFile(name = 'chest-ap.jpg') {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' })
}

async function attach(orderId: number, file?: File, extraFields: Record<string, string> = {}) {
  const fd = new FormData()
  if (file) fd.set('file', file)
  for (const [key, value] of Object.entries(extraFields)) fd.set(key, value)
  const req = new Request('http://localhost', { method: 'POST', body: fd })
  return attachImaging(req as never, { params: Promise.resolve({ id: String(orderId) }) })
}

async function getDocumentRow(id: number) {
  const [row] = await getDb().select().from(documents).where(eq(documents.id, id))
  return row
}

async function countDocumentsFor(orderId: number) {
  const rows = await getDb().select({ id: documents.id }).from(documents).where(eq(documents.labOrderId, orderId))
  return rows.length
}

describe('POST /api/lab-orders/[id]/imaging', () => {
  it('lets admin attach an image', async () => {
    sessionRole = 'admin'
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)
  })

  it('lets pi attach an image', async () => {
    sessionRole = 'pi'
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)
  })

  it('returns 403 for crc', async () => {
    sessionRole = 'crc'
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(403)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('returns 403 for frontdesk', async () => {
    sessionRole = 'frontdesk'
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(403)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('creates the document and transitions an "ordered" order to collected', async () => {
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(after.status).toBe('collected')
    expect(after.collectedAt).not.toBeNull()
  })

  it("leaves an already-collected order's status and collectedAt untouched", async () => {
    const order = await seedOrder('collected') // collectedAt stamped at seed time
    const res = await attach(order.id, jpegFile())
    createdDocumentIds.push((await res.json()).id)
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(after.status).toBe('collected')
    expect(after.collectedAt!.getTime()).toBe(order.collectedAt!.getTime())
  })

  it('accepts an attachment on a resulted order (addendum) without changing its status', async () => {
    const order = await seedOrder('resulted')
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(201)
    createdDocumentIds.push((await res.json()).id)
    const [after] = await getDb().select().from(labOrders).where(eq(labOrders.id, order.id))
    expect(after.status).toBe('resulted')
  })

  it('returns 409 on a cancelled order and writes no document row', async () => {
    const order = await seedOrder('cancelled')
    const before = await countDocumentsFor(order.id)
    const res = await attach(order.id, jpegFile())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Cannot attach an image to a cancelled order')
    expect(await countDocumentsFor(order.id)).toBe(before)
    expect(vi.mocked(mockedPut)).not.toHaveBeenCalled()
  })

  it('returns 404 for an order id that does not exist', async () => {
    const res = await attach(2_000_000_000, jpegFile())
    expect(res.status).toBe(404)
  })

  it('returns 400 for a non-integer order id', async () => {
    const fd = new FormData()
    fd.set('file', jpegFile())
    const req = new Request('http://localhost', { method: 'POST', body: fd })
    const res = await attachImaging(req as never, { params: Promise.resolve({ id: 'abc' }) })
    expect(res.status).toBe(400)
  })

  it("sets labOrderId, documentType, the order's patientId, and the session filing trail", async () => {
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile())
    const body = await res.json()
    createdDocumentIds.push(body.id)
    const row = await getDocumentRow(body.id)
    expect(row.labOrderId).toBe(order.id)
    expect(row.documentType).toBe('imaging_result')
    expect(row.patientId).toBe(order.patientId)
    expect(row.filedByName).toBe(sessionName)
    expect(row.filedAt).not.toBeNull()
    expect(row.status).toBe('new')
    expect(row.fileType).toBe('JPG')
    expect(row.fileUrl).toContain('https://blob.test/imaging/')
    expect(row.name).toBe('chest-ap.jpg')
  })

  it('accepts application/pdf (a radiology report)', async () => {
    const order = await seedOrder('ordered')
    const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', { type: 'application/pdf' })
    const res = await attach(order.id, file)
    expect(res.status).toBe(201)
    const body = await res.json()
    createdDocumentIds.push(body.id)
    const row = await getDocumentRow(body.id)
    expect(row.fileType).toBe('PDF')
  })

  it('rejects application/dicom before calling put', async () => {
    const order = await seedOrder('ordered')
    const file = new File([new Uint8Array([1, 2, 3])], 'scan.dcm', { type: 'application/dicom' })
    const res = await attach(order.id, file)
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('rejects a zero-byte file before calling put', async () => {
    const order = await seedOrder('ordered')
    const file = new File([], 'empty.jpg', { type: 'image/jpeg' })
    const res = await attach(order.id, file)
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('rejects a file over 16MB before calling put', async () => {
    const order = await seedOrder('ordered')
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'huge.jpg', { type: 'image/jpeg' })
    const res = await attach(order.id, file)
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('rejects an unrecognized form field', async () => {
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile(), { patientId: 'X' })
    expect(res.status).toBe(400)
    expect(mockedPut).not.toHaveBeenCalled()
  })

  it('uses an explicit name field over the uploaded filename', async () => {
    const order = await seedOrder('ordered')
    const res = await attach(order.id, jpegFile(), { name: 'Chest AP view' })
    const body = await res.json()
    createdDocumentIds.push(body.id)
    const row = await getDocumentRow(body.id)
    expect(row.name).toBe('Chest AP view')
  })

  it('produces two rows for two successive uploads against one order', async () => {
    const order = await seedOrder('ordered')
    const res1 = await attach(order.id, jpegFile('view1.jpg'))
    createdDocumentIds.push((await res1.json()).id)
    const res2 = await attach(order.id, jpegFile('view2.jpg'))
    createdDocumentIds.push((await res2.json()).id)
    expect(await countDocumentsFor(order.id)).toBe(2)
  })
})
