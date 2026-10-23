// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients } from '@/db/schema'
import { POST, GET } from '@/app/api/patients/[anonId]/photo/route'
import { withTempBlobDir } from '../helpers/temp-blob-dir'

// WS6 T8: POST/GET /api/patients/[anonId]/photo against the real local-disk file store in a temp dir.
let sessionRole = 'frontdesk'
const SESSION_NAME = `TEST-WS6T8-photo-${Date.now()}`
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: SESSION_NAME, userId: null })) }))
vi.mock('@/lib/cache', () => ({ invalidateCache: vi.fn(async () => undefined), patientDetailCacheKey: (id: string) => `patient:${id}` }))

const PATIENT = `RD-PHOTO-${Date.now()}`
const ctx = { params: Promise.resolve({ anonId: PATIENT }) }

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')
const PDF = new TextEncoder().encode('%PDF-1.7\n%fake pdf body')

function upload(bytes: Uint8Array, name = 'photo.jpg', type = 'image/jpeg', extra?: Record<string, string>) {
  const form = new FormData()
  form.append('file', new File([bytes as BlobPart], name, { type }))
  for (const [k, v] of Object.entries(extra ?? {})) form.append(k, v)
  return new NextRequest(`http://localhost/api/patients/${PATIENT}/photo`, { method: 'POST', body: form })
}
const view = () => new NextRequest(`http://localhost/api/patients/${PATIENT}/photo`)
const storedPath = async () => (await getDb().select({ p: patients.photoBlobPath }).from(patients).where(eq(patients.id, PATIENT)))[0]?.p ?? null

withTempBlobDir()

describe.skipIf(!process.env.DATABASE_URL)('/api/patients/[anonId]/photo', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PATIENT, name: 'Photo Test Patient', dob: '1990-01-01' })
  })
  afterAll(async () => {
    await getDb().delete(auditLog).where(eq(auditLog.userName, SESSION_NAME))
    await getDb().delete(patients).where(eq(patients.id, PATIENT))
  })
  afterEach(async () => {
    sessionRole = 'frontdesk'
    vi.unstubAllEnvs()
    await getDb().update(patients).set({ photoBlobPath: null }).where(eq(patients.id, PATIENT))
  })

  it('stores a JPEG, sets photo_blob_path and answers 201 { ok: true } without the URL', async () => {
    const res = await POST(upload(JPEG), ctx)
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ ok: true })
    const path = await storedPath()
    expect(path).toMatch(/^local:patient-photos\//)
    expect(text).not.toContain('patient-photos')
  })

  it('accepts PNG and WebP by their bytes', async () => {
    expect((await POST(upload(PNG, 'p.png', 'image/png'), ctx)).status).toBe(201)
    expect((await POST(upload(WEBP, 'p.webp', 'image/webp'), ctx)).status).toBe(201)
  })

  it('400s a PDF renamed .jpg (magic bytes, not the declared type)', async () => {
    const res = await POST(upload(PDF, 'scan.jpg', 'image/jpeg'), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The photo must be a JPEG, PNG or WebP image' })
    expect(await storedPath()).toBeNull()
  })

  it('400s a 3 MB photo', async () => {
    const big = new Uint8Array(3 * 1024 * 1024)
    big.set(JPEG)
    const res = await POST(upload(big), ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'The photo must be 2 MB or smaller' })
  })

  it('400s a missing file, a JSON body and an extra form field', async () => {
    const form = new FormData()
    form.append('note', 'x')
    expect((await POST(new NextRequest('http://localhost/x', { method: 'POST', body: form }), ctx)).status).toBe(400)
    expect((await POST(new NextRequest('http://localhost/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), ctx)).status).toBe(400)
    expect((await POST(upload(JPEG, 'a.jpg', 'image/jpeg', { path: '../../etc' }), ctx)).status).toBe(400)
  })

  it('404s an unknown patient', async () => {
    const res = await POST(upload(JPEG), { params: Promise.resolve({ anonId: 'RD-NOPE-PHOTO' }) })
    expect(res.status).toBe(404)
  })

  it('403s roles outside registration / profile edit, before reading the body', async () => {
    for (const role of ['pi', 'pharmacy', 'billing', 'labs']) {
      sessionRole = role
      expect((await POST(upload(JPEG), ctx)).status, role).toBe(403)
    }
    sessionRole = 'crc'
    expect((await POST(upload(JPEG), ctx)).status).toBe(201)
  })

  it('GET streams the stored bytes, never a URL, and audits the view', async () => {
    await POST(upload(JPEG), ctx)
    const res = await GET(view(), ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('location')).toBeNull()
    const body = new Uint8Array(await res.arrayBuffer())
    expect([...body]).toEqual([...JPEG])
    const audits = await getDb().select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.userName, SESSION_NAME))
    expect(audits.map((a) => a.action)).toContain('viewed patient photo')
  })

  it('GET 404s when no photo is on file and 403s roles outside the patient directory', async () => {
    expect((await GET(view(), ctx)).status).toBe(404)
    sessionRole = 'pharmacy'
    expect((await GET(view(), ctx)).status).toBe(403)
  })

  it('answers 503 with the blob body when there is no file store', async () => {
    vi.stubEnv('BLOB_DRIVER', 'nope')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await POST(upload(JPEG), ctx)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
    spy.mockRestore()
  })
})
