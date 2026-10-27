// @vitest-environment node
//
// WS7 T3: POST /api/intake/[token]/files -- a patient's file answer. Token
// possession is the only credential, so an unknown, expired or completed token
// stores nothing. Size and type are checked on the bytes (magic numbers), the
// file goes only through the blob driver, and the response carries the answer
// reference and the file name -- never a blob URL or path.
// (node environment: real multipart FormData, see tests/api/documents-receive.test.ts.)
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, documents, formSubmissions, formTemplates } from '@/db/schema'
import type { FormQuestion } from '@/lib/forms/question-model'

const h = vi.hoisted(() => ({ allowed: true }))
vi.mock('@/lib/rate-limit', () => ({ checkIntakeFileUploadRateLimit: vi.fn(async () => ({ allowed: h.allowed })) }))
vi.mock('@/lib/blob-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob-store')>()
  return { ...actual, putPrivateBlob: vi.fn(actual.putPrivateBlob) }
})

import { POST as uploadFile } from '@/app/api/intake/[token]/files/route'
import { putPrivateBlob } from '@/lib/blob-store'
import { checkIntakeFileUploadRateLimit } from '@/lib/rate-limit'
import { withTempBlobDir } from '../helpers/temp-blob-dir'

const blobDir = withTempBlobDir()
const PATIENT_ID = 'RD-0001'
const suiteStart = new Date()

const QUESTIONS: FormQuestion[] = [
  { id: 'q1', label: 'Your name', type: 'text', hipaaSensitive: false, required: false },
  { id: 'scan', label: 'Upload your referral letter', type: 'file', hipaaSensitive: false, required: true },
]

const templateIds: number[] = []
const submissionIds: number[] = []

beforeEach(() => { h.allowed = true })
afterEach(async () => {
  vi.mocked(putPrivateBlob).mockClear()
  vi.mocked(checkIntakeFileUploadRateLimit).mockClear()
  const db = getDb()
  await db.delete(documents).where(and(eq(documents.patientId, PATIENT_ID), eq(documents.receivedFrom, 'Patient form')))
  if (submissionIds.length) await db.delete(formSubmissions).where(inArray(formSubmissions.id, submissionIds))
  if (templateIds.length) await db.delete(formTemplates).where(inArray(formTemplates.id, templateIds))
  await db.delete(auditLog).where(and(eq(auditLog.action, 'uploaded form file'), eq(auditLog.patientId, PATIENT_ID)))
  submissionIds.length = 0
  templateIds.length = 0
})

async function makeSubmission(over: { status?: 'sent' | 'completed'; expired?: boolean } = {}) {
  const db = getDb()
  const [t] = await db.insert(formTemplates).values({ name: `Intake Files Test ${Date.now()}`, category: 'Uncategorized', diagnosisTag: 'test', questions: QUESTIONS }).returning()
  templateIds.push(t.id)
  const accessToken = `intake-files-${crypto.randomUUID()}`
  const [s] = await db.insert(formSubmissions).values({
    templateId: t.id, patientId: PATIENT_ID, status: over.status ?? 'sent', accessToken,
    tokenExpiresAt: new Date(Date.now() + (over.expired ? -1000 : 86_400_000)),
  }).returning()
  submissionIds.push(s.id)
  return { id: s.id, accessToken }
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x45, 0x4f, 0x46])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])

function post(token: string, fields: Record<string, string>, file?: File) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  if (file) fd.set('file', file)
  return uploadFile(new Request('http://localhost', { method: 'POST', body: fd }) as never, { params: Promise.resolve({ token }) })
}

const ourDocs = () => getDb().select().from(documents).where(and(eq(documents.patientId, PATIENT_ID), eq(documents.receivedFrom, 'Patient form')))

describe('POST /api/intake/[token]/files', () => {
  it('an unknown, expired or completed token answers 404 like the other intake routes and stores nothing', async () => {
    const expired = await makeSubmission({ expired: true })
    const completed = await makeSubmission({ status: 'completed' })
    for (const token of ['no-such-token', expired.accessToken, completed.accessToken]) {
      const res = await post(token, { questionId: 'scan' }, new File([PDF], 'letter.pdf', { type: 'application/pdf' }))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'This link is no longer valid.' })
    }
    expect(putPrivateBlob).not.toHaveBeenCalled()
    expect(checkIntakeFileUploadRateLimit).not.toHaveBeenCalled()
    expect(await ourDocs()).toHaveLength(0)
  })

  it('a file over 5 MB is 413 and stores nothing', async () => {
    const { accessToken } = await makeSubmission()
    const big = new Uint8Array(6 * 1024 * 1024)
    big.set(PDF)
    const res = await post(accessToken, { questionId: 'scan' }, new File([big], 'big.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(413)
    expect(putPrivateBlob).not.toHaveBeenCalled()
  })

  it('an .exe renamed .pdf is 400 (the bytes decide, not the name or declared type)', async () => {
    const { accessToken } = await makeSubmission()
    const res = await post(accessToken, { questionId: 'scan' }, new File([EXE], 'letter.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(400)
    expect(putPrivateBlob).not.toHaveBeenCalled()
    expect(await ourDocs()).toHaveLength(0)
  })

  it('an empty file, a missing file, a non-file question and an extra field are 400', async () => {
    const { accessToken } = await makeSubmission()
    expect((await post(accessToken, { questionId: 'scan' }, new File([], 'x.pdf', { type: 'application/pdf' }))).status).toBe(400)
    expect((await post(accessToken, { questionId: 'scan' })).status).toBe(400)
    expect((await post(accessToken, { questionId: 'q1' }, new File([PDF], 'x.pdf'))).status).toBe(400)
    expect((await post(accessToken, { questionId: 'nope' }, new File([PDF], 'x.pdf'))).status).toBe(400)
    expect((await post(accessToken, { questionId: 'scan', patientId: 'RD-0002' }, new File([PDF], 'x.pdf'))).status).toBe(400)
    expect(putPrivateBlob).not.toHaveBeenCalled()
  })

  it('a valid PDF is stored through the blob driver as a new patient document; the answer is doc:<id>, never a URL', async () => {
    const { id, accessToken } = await makeSubmission()
    const res = await post(accessToken, { questionId: 'scan' }, new File([PDF], 'referral letter.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(201)
    const text = await res.text()
    const body = JSON.parse(text) as { answer: string; fileName: string }
    expect(Object.keys(body).sort()).toEqual(['answer', 'fileName'])
    expect(body.answer).toMatch(/^doc:[1-9]\d*$/)
    expect(body.fileName).toBe('referral letter.pdf')
    expect(text).not.toContain(blobDir())
    expect(text).not.toMatch(/url|blob|\//i)

    expect(putPrivateBlob).toHaveBeenCalledTimes(1)
    expect(vi.mocked(putPrivateBlob).mock.calls[0][2]).toBe('application/pdf')
    const [doc] = await getDb().select().from(documents).where(eq(documents.id, Number(body.answer.slice(4))))
    expect(doc).toMatchObject({ patientId: PATIENT_ID, receivedFrom: 'Patient form', status: 'new', fileType: 'PDF' })
    expect(doc.fileUrl).toBeTruthy()

    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.action, 'uploaded form file'), eq(auditLog.patientId, PATIENT_ID)))
    expect(audits.filter((a) => a.timestamp >= suiteStart).map((a) => a.details)).toEqual([`submission=${id}`])
    expect(checkIntakeFileUploadRateLimit).toHaveBeenCalledWith(id)
  })

  it('stores the sniffed content type, not the declared one', async () => {
    const { accessToken } = await makeSubmission()
    const res = await post(accessToken, { questionId: 'scan' }, new File([PNG], 'photo.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(201)
    expect(vi.mocked(putPrivateBlob).mock.calls[0][2]).toBe('image/png')
  })

  it('rate-limited by the token\'s submission: 429 and nothing stored', async () => {
    const { accessToken } = await makeSubmission()
    h.allowed = false
    const res = await post(accessToken, { questionId: 'scan' }, new File([PDF], 'x.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(429)
    expect(putPrivateBlob).not.toHaveBeenCalled()
  })

  it('no file store configured: 503 with the storage body, nothing stored', async () => {
    const { accessToken } = await makeSubmission()
    vi.stubEnv('BLOB_DRIVER', 's3')
    const res = await post(accessToken, { questionId: 'scan' }, new File([PDF], 'x.pdf', { type: 'application/pdf' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
    expect(await ourDocs()).toHaveLength(0)
  })
})
