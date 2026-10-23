// @vitest-environment node
// WS12 T3: POST /api/rcm/policies/[id]/verifications (multipart, manual verification with an
// optional document) and GET /api/rcm/verification-documents/[id], against the real query
// layer, real audit, real Postgres and the local blob driver in a temp dir. Only the session is faked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { and, eq, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, coverageVerifications, patientPolicies } from '@/db/schema'
import type { Role } from '@/lib/auth'
import { ALL_ROLES, COVERAGE_READ_ROLES, COVERAGE_VERIFY_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../db/rcm-fixtures'
import { purgeCoverageFixtures } from '../db/ws12-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const PROBE_USER = `TEST-WS12-manual-${RUN}`
let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: PROBE_USER, userId: null })) }
})
const readUploadSpy = vi.fn()
vi.mock('@/lib/rcm/route-responses', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rcm/route-responses')>('@/lib/rcm/route-responses')
  return { ...actual, readUpload: (...a: Parameters<typeof actual.readUpload>) => { readUploadSpy(); return actual.readUpload(...a) } }
})

import { POST } from '@/app/api/rcm/policies/[id]/verifications/route'
import { GET as getDocument } from '@/app/api/rcm/verification-documents/[id]/route'

const PDF = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 37, 37, 69, 79, 70])
const REFERENCE = `SECRETREF${RUN}`
const addDays = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

function form(fields: Record<string, string | undefined>, file?: { bytes: Uint8Array; type: string } | null) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) f.set(k, v)
  if (file) f.set('file', new File([Buffer.from(file.bytes)], 'letter.pdf', { type: file.type }))
  return f
}
const post = (policyId: number | string, body: FormData | string) =>
  POST(new NextRequest(`http://localhost/api/rcm/policies/${policyId}/verifications`, { method: 'POST', body }), { params: Promise.resolve({ id: String(policyId) }) })
const getDoc = (id: number | string) =>
  getDocument(new NextRequest(`http://localhost/api/rcm/verification-documents/${id}`), { params: Promise.resolve({ id: String(id) }) })

describe.skipIf(!process.env.DATABASE_URL)('manual coverage verification (DB)', () => {
  let b: RcmBase
  let shortPolicyId = 0
  let dir = ''
  const today = todayIsoIn()
  const fields = (over: Record<string, string | undefined> = {}) => ({
    result: 'active', method: 'tpa_portal', reference: REFERENCE, verifiedOn: today, validUntil: addDays(today, 7), ...over,
  })
  const rowsOf = (policyId: number) => getDb().select().from(coverageVerifications).where(eq(coverageVerifications.policyId, policyId))

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12M')
    const [p] = await getDb().insert(patientPolicies).values({
      patientId: b.patientId, insurerPayerId: b.insurerId, policyNumber: 'POL-SHORT', memberId: 'MEM-SHORT', policyType: 'individual', priority: 'secondary',
      holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: addDays(today, 5), createdByName: 'Test',
    }).returning()
    shortPolicyId = p.id
  })
  afterAll(async () => {
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await purgeCoverageFixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hims-ws12-'))
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '')
    vi.stubEnv('BLOB_STORE_ID', '')
    vi.stubEnv('BLOB_DRIVER', 'local')
    vi.stubEnv('BLOB_LOCAL_DIR', dir)
    readUploadSpy.mockClear()
    sessionRole = 'frontdesk'
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }) })

  it('records an active manual verification with a PDF: source manual, document triple, valid until the chosen IST day end', async () => {
    const validUntil = addDays(today, 7)
    const res = await post(b.policyId, form(fields({ validUntil, sumInsuredPaise: '50000000', copayBp: '1000', note: 'Desk call' }), { bytes: PDF, type: 'application/pdf' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['verificationId'])
    const text = JSON.stringify(body)
    expect(text).not.toMatch(/blob|local:|http|insurance\//i)
    expect(text).not.toContain(REFERENCE)

    const [row] = (await rowsOf(b.policyId)).filter((r) => r.id === body.verificationId)
    expect(row).toMatchObject({
      patientId: b.patientId, policyId: b.policyId, source: 'manual', result: 'active', context: 'manual', method: 'tpa_portal',
      insurerReference: REFERENCE, documentContentType: 'application/pdf', verifiedByName: PROBE_USER, sumInsuredPaise: 50_000_000, copayBp: 1000, note: 'Desk call', nhcxCheckId: null,
    })
    expect(row.documentBlobUrl).toMatch(new RegExp(`insurance/verifications/${b.policyId}/[0-9a-f-]{36}\\.pdf$`))
    expect(row.documentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(row.validUntil.toISOString()).toBe(new Date(`${addDays(validUntil, 1)}T00:00:00+05:30`).toISOString())
    expect(row.verifiedAt.getTime()).toBeLessThanOrEqual(Date.now())

    const [a] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), eq(auditLog.action, 'insurance: recorded manual verification')))
    expect(a).toMatchObject({ patientId: b.patientId, details: `policy=${b.policyId} verification=${row.id} result=active method=tpa_portal document=yes` })
    expect(a.details).not.toContain(REFERENCE)
    expect(a.details).not.toMatch(/blob|local:|insurance\//)

    // The document streams back to a read role, audited; pi is refused.
    sessionRole = 'rcm'
    const doc = await getDoc(row.id)
    expect(doc.status).toBe(200)
    expect(new Uint8Array(await doc.arrayBuffer())).toEqual(PDF)
    expect(doc.headers.get('content-type')).toBe('application/pdf')
    expect(doc.headers.get('content-disposition')).toBe(`inline; filename="verification-${row.id}.pdf"`)
    const [viewed] = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), eq(auditLog.action, 'insurance: viewed verification document')))
    expect(viewed).toMatchObject({ patientId: b.patientId, details: `verification=${row.id} policy=${b.policyId}` })
    sessionRole = 'pi'
    expect((await getDoc(row.id)).status).toBe(403)
  })

  it('records without a file (document=no); the document route then answers 404', async () => {
    const res = await post(b.policyId, form(fields({ result: 'inactive', method: 'phone' })))
    expect(res.status).toBe(201)
    const { verificationId } = await res.json()
    const [row] = (await rowsOf(b.policyId)).filter((r) => r.id === verificationId)
    expect(row).toMatchObject({ result: 'inactive', method: 'phone', documentBlobUrl: null, documentSha256: null, documentContentType: null })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_USER), like(auditLog.details, `%verification=${verificationId} %`)))
    expect(audits.map((x) => x.details)).toEqual([`policy=${b.policyId} verification=${verificationId} result=inactive method=phone document=no`])
    sessionRole = 'rcm'
    expect((await getDoc(verificationId)).status).toBe(404)
  })

  it('refuses a missing method with a field message, and a patientId sent by the client', async () => {
    const before = (await rowsOf(b.policyId)).length
    const res = await post(b.policyId, form(fields({ method: undefined })))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Choose how the cover was verified' })
    const sneaky = await post(b.policyId, form({ ...fields(), patientId: 'SOMEONE-ELSE' }))
    expect(sneaky.status).toBe(400)
    expect((await rowsOf(b.policyId)).length).toBe(before)
  })

  it('refuses valid-until beyond 30 days and beyond the policy end, writing nothing', async () => {
    const tooFar = await post(b.policyId, form(fields({ validUntil: addDays(today, 31) })))
    expect(tooFar.status).toBe(400)
    expect((await tooFar.json()).error).toMatch(/^Valid until can be at most 30 days from today/)
    const pastPolicy = await post(shortPolicyId, form(fields({ validUntil: addDays(today, 6) })))
    expect(pastPolicy.status).toBe(422)
    expect((await pastPolicy.json()).error).toMatch(/^Valid until cannot be after the policy ends/)
    expect(await rowsOf(shortPolicyId)).toHaveLength(0)
    const ok = await post(shortPolicyId, form(fields({ validUntil: addDays(today, 5) })))
    expect(ok.status).toBe(201)
  })

  it('answers 503 storage_not_configured with a file and no driver, writing no row', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('BLOB_DRIVER', '')
    const before = (await rowsOf(b.policyId)).length
    const res = await post(b.policyId, form(fields(), { bytes: PDF, type: 'application/pdf' }))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
    expect((await rowsOf(b.policyId)).length).toBe(before)
  })

  it('answers 404 for an unknown policy, 400 for a bad file type and a non-multipart body', async () => {
    expect((await post(2147483000, form(fields()))).status).toBe(404)
    const exe = await post(b.policyId, form(fields(), { bytes: PDF, type: 'application/x-msdownload' }))
    expect(exe.status).toBe(400)
    expect((await post(b.policyId, '{not multipart')).status).toBe(400)
  })

  it('gates POST to COVERAGE_VERIFY_ROLES before the body is read, and GET to COVERAGE_READ_ROLES', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      readUploadSpy.mockClear()
      const res = await post(2147483000, form(fields()))
      if (COVERAGE_VERIFY_ROLES.includes(role)) {
        expect(res.status, role).toBe(404)
        expect(readUploadSpy).toHaveBeenCalledTimes(1)
      } else {
        expect(res.status, role).toBe(403)
        expect(await res.json()).toEqual({ error: 'Forbidden' })
        expect(readUploadSpy, role).not.toHaveBeenCalled()
      }
      const doc = await getDoc(2147483000)
      expect(doc.status, role).toBe(COVERAGE_READ_ROLES.includes(role) ? 404 : 403)
    }
  })
})
