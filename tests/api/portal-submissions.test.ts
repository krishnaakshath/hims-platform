// @vitest-environment node
//
// WS7 T9 (spec D15): portal self-service policy and ABHA submissions through the routes, against
// the real database. The patient's multipart POST lands a pending row (and a documents row for the
// card); the front desk approves it into the real policy / chart ABHA or rejects it with a reason
// the patient sees. The portal route takes only a patient session; the decision route only the
// review roles. No response carries a blob URL or path.
// (node environment: real multipart FormData, see tests/api/intake-files.test.ts.)
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, documents, patientPolicies, patients, payerProfiles, payers, portalSubmissions } from '@/db/schema'
import type { Session } from '@/lib/auth'

const h = vi.hoisted(() => ({ patient: null as string | null, staff: null as Session | null }))
vi.mock('@/lib/patient-session', () => ({
  requirePatientSession: vi.fn(async () => (h.patient ? { patientId: h.patient } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => h.staff ?? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })),
}))
vi.mock('@/lib/blob-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob-store')>()
  return { ...actual, putPrivateBlob: vi.fn(actual.putPrivateBlob) }
})

import { POST as submit } from '@/app/api/patient-portal/self-service/route'
import { GET as listPending } from '@/app/api/front-desk/portal-submissions/route'
import { POST as decide } from '@/app/api/front-desk/portal-submissions/[id]/decision/route'
import { requireSession } from '@/lib/auth'
import { putPrivateBlob } from '@/lib/blob-store'
import { listPortalPolicies } from '@/lib/queries/patient-portal-records'
import { listPortalSubmissionsForPatient } from '@/lib/queries/portal-submissions'
import { withTempBlobDir } from '../helpers/temp-blob-dir'

withTempBlobDir()
const RUN = `${process.pid}`
const A = `WS7T9-R-${RUN}-A`
const B = `WS7T9-R-${RUN}-B`
const DESK: Session = { role: 'frontdesk', name: 'Desk Reviewer', userId: null }
const BILLING: Session = { role: 'billing', name: 'Billing Clerk', userId: null }
const ABHA = `92${RUN.padStart(8, '0').slice(-8)}5678`
const ABHA_FORMATTED = `${ABHA.slice(0, 2)}-${ABHA.slice(2, 6)}-${ABHA.slice(6, 10)}-${ABHA.slice(10)}`
const POLICY_NO = `SH/${RUN}/77`
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9])
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
let insurerId = 0

function form(fields: Record<string, string>, card?: File) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  if (card) fd.set('card', card)
  return submit(new Request('http://localhost/api/patient-portal/self-service', { method: 'POST', body: fd }) as never)
}
const policyFields = { kind: 'policy', insurerName: 'Star Health', policyNumber: POLICY_NO, validFrom: '2026-04-01', validTo: '2099-03-31', sumInsuredPaise: '50000000' }
const decideReq = (id: number | string, body: unknown) => decide(
  new NextRequest(`http://localhost/api/front-desk/portal-submissions/${id}/decision`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  { params: Promise.resolve({ id: String(id) }) },
)
const subsOf = (pid: string) => getDb().select().from(portalSubmissions).where(eq(portalSubmissions.patientId, pid))

async function purge() {
  const db = getDb()
  const subs = await db.select({ documentId: portalSubmissions.documentId }).from(portalSubmissions).where(inArray(portalSubmissions.patientId, [A, B]))
  await db.delete(portalSubmissions).where(inArray(portalSubmissions.patientId, [A, B]))
  const docIds = subs.map((s) => s.documentId).filter((x): x is number => x !== null)
  if (docIds.length) await db.delete(documents).where(inArray(documents.id, docIds))
  await db.update(patients).set({ primaryPayerId: null, abhaNumber: null, abhaAddress: null }).where(inArray(patients.id, [A, B]))
  await db.delete(patientPolicies).where(inArray(patientPolicies.patientId, [A, B]))
  await db.delete(auditLog).where(inArray(auditLog.patientId, [A, B]))
}

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values([{ id: A, name: 'Portal Self A', dob: '1985-01-01' }, { id: B, name: 'Portal Self B', dob: '1986-01-01' }])
  const [ins] = await db.insert(payers).values({ name: `WS7T9R Insurer ${RUN}`, payerId: `W79R${RUN}`, payerType: 'other' }).returning()
  await db.insert(payerProfiles).values({ payerId: ins.id, kind: 'insurer', empanelmentStatus: 'empanelled', updatedByName: 'Test' })
  insurerId = ins.id
})
beforeEach(async () => {
  h.patient = A
  h.staff = DESK
  vi.mocked(requireSession).mockClear()
  vi.mocked(putPrivateBlob).mockClear()
  await purge()
})
afterAll(async () => {
  await purge()
  const db = getDb()
  await db.delete(payerProfiles).where(eq(payerProfiles.payerId, insurerId))
  await db.delete(payers).where(eq(payers.id, insurerId))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
})

describe('POST /api/patient-portal/self-service', () => {
  it('refuses a staff session (no patient session) before reading anything', async () => {
    h.patient = null
    const res = await form(policyFields, new File([PNG], 'card.png', { type: 'image/png' }))
    expect(res.status).toBe(401)
    expect(requireSession).not.toHaveBeenCalled()
    expect(putPrivateBlob).not.toHaveBeenCalled()
    expect(await subsOf(A)).toEqual([])
  })

  it('a policy with a card image -> 201 { id }, a pending row and a documents row; no path in the response', async () => {
    const res = await form(policyFields, new File([PNG], 'my card.png', { type: 'image/png' }))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['id'])
    const [row] = await subsOf(A)
    expect(row).toMatchObject({ id: body.id, kind: 'policy', status: 'pending', payload: { insurerName: 'Star Health', policyNumber: POLICY_NO, sumInsuredPaise: 50000000 } })
    const [doc] = await getDb().select().from(documents).where(eq(documents.id, row.documentId!))
    expect(doc).toMatchObject({ patientId: A, fileType: 'PNG', status: 'new' })
    expect(requireSession).not.toHaveBeenCalled()
  })

  it('a second pending policy -> 409 with no new file stored', async () => {
    expect((await form(policyFields)).status).toBe(201)
    vi.mocked(putPrivateBlob).mockClear()
    expect((await form(policyFields, new File([PNG], 'c.png'))).status).toBe(409)
    expect(putPrivateBlob).not.toHaveBeenCalled()
    expect(await subsOf(A)).toHaveLength(1)
  })

  it('refuses a non-image card, unknown fields, a bad ABHA, an ended policy and an unknown kind', async () => {
    expect((await form(policyFields, new File([EXE], 'card.png', { type: 'image/png' }))).status).toBe(400)
    expect((await form({ ...policyFields, patientId: B })).status).toBe(400)
    expect((await form({ kind: 'abha', abhaNumber: '12-3456' })).status).toBe(400)
    expect((await form({ ...policyFields, validFrom: '2020-01-01', validTo: '2021-01-01' })).status).toBe(400)
    expect((await form({ kind: 'other' })).status).toBe(400)
    expect(await subsOf(A)).toEqual([])
  })
})

describe('front-desk review', () => {
  it('lists pending submissions for the review roles; billing -> 403', async () => {
    await form({ kind: 'abha', abhaNumber: ABHA_FORMATTED })
    const res = await listPending()
    expect(res.status).toBe(200)
    const { submissions } = await res.json()
    const mine = submissions.filter((s: { patientId: string }) => s.patientId === A)
    expect(mine).toHaveLength(1)
    expect(mine[0].details).toContainEqual({ label: 'ABHA number', value: ABHA_FORMATTED })
    h.staff = BILLING
    expect((await listPending()).status).toBe(403)
  })

  it('approve creates the real policy and the portal shows it', async () => {
    const { id } = await (await form(policyFields, new File([PNG], 'c.png'))).json()
    const res = await decideReq(id, { decision: 'approve', insurerPayerId: insurerId })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, policyId: expect.any(Number) })
    const portal = await listPortalPolicies(A)
    expect(portal).toHaveLength(1)
    expect(portal[0]).toMatchObject({ policyNumber: POLICY_NO, status: 'active', priority: 'primary' })
    expect((await listPortalSubmissionsForPatient(A))[0].status).toBe('approved')
    // Audit carries ids and the kind only.
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, A))
    expect(audits.find((a) => a.action === 'approved portal submission')?.details).toMatch(/^submission=\d+ kind=policy policy=\d+$/)
    expect(JSON.stringify(audits)).not.toContain(POLICY_NO)
  })

  it('reject shows the reason to the patient', async () => {
    const { id } = await (await form(policyFields)).json()
    expect((await decideReq(id, { decision: 'reject', reason: 'Policy dates do not match the card' })).status).toBe(200)
    const mine = await listPortalSubmissionsForPatient(A)
    expect(mine[0]).toMatchObject({ status: 'rejected', rejectReason: 'Policy dates do not match the card' })
    expect(await listPortalPolicies(A)).toEqual([])
  })

  it('an ABHA already on another chart -> 409 at approval, nothing changes', async () => {
    await getDb().update(patients).set({ abhaNumber: ABHA }).where(eq(patients.id, B))
    const { id } = await (await form({ kind: 'abha', abhaNumber: ABHA_FORMATTED })).json()
    const res = await decideReq(id, { decision: 'approve' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('This ABHA number is already registered to another patient')
    expect((await subsOf(A))[0].status).toBe('pending')
  })

  it('an ABHA approval records it on the chart', async () => {
    const { id } = await (await form({ kind: 'abha', abhaNumber: ABHA_FORMATTED })).json()
    expect((await decideReq(id, { decision: 'approve' })).status).toBe(200)
    const [p] = await getDb().select({ abhaNumber: patients.abhaNumber, abhaVerifiedAt: patients.abhaVerifiedAt }).from(patients).where(eq(patients.id, A))
    expect(p).toEqual({ abhaNumber: ABHA, abhaVerifiedAt: null })
  })

  it('billing -> 403 on decision before the body is read; nothing decided', async () => {
    const { id } = await (await form(policyFields)).json()
    h.staff = BILLING
    expect((await decideReq(id, { decision: 'reject', reason: 'Not allowed here' })).status).toBe(403)
    expect((await subsOf(A))[0].status).toBe('pending')
  })

  it('a strict body: unknown keys, a short reason and a policy approval with no insurer are 400; a bad id is 404', async () => {
    const { id } = await (await form(policyFields)).json()
    expect((await decideReq(id, { decision: 'reject', reason: 'no' })).status).toBe(400)
    expect((await decideReq(id, { decision: 'approve', insurerPayerId: insurerId, extra: 1 })).status).toBe(400)
    expect((await decideReq(id, { decision: 'approve' })).status).toBe(400)
    expect((await decideReq('abc', { decision: 'approve' })).status).toBe(404)
    expect((await subsOf(A))[0].status).toBe('pending')
  })
})
