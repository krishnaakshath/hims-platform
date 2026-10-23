// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/blob-store', () => ({ streamPrivateBlob: vi.fn(async () => new Response('pdf')), putPrivateBlob: vi.fn() }))
vi.mock('@/lib/queries/preauths', () => ({
  createPreauth: vi.fn(async () => ({ ok: true, value: { preauthId: 3, preauthNumber: 'PA-2026-000003' } })),
  estimateForPolicy: vi.fn(async () => ({ ok: true, value: { lines: [], totalPaise: 100 } })),
  applyPreauthAction: vi.fn(async () => ({ ok: false, error: 'invalid_transition' })),
  uploadPreauthDocument: vi.fn(async () => ({ ok: true, value: { documentId: 8 } })),
  getPreauthDocumentBlob: vi.fn(async () => ({ url: 'https://blob.test/secret', preauthId: 3, patientId: 'P-1', contentType: 'application/pdf', title: 'x' })),
}))
vi.mock('@/lib/queries/coverage', () => ({
  maybeStartEligibility: vi.fn(async () => ({ started: true, checkId: 41 })),
}))
vi.mock('@/lib/queries/preauth-reference', () => ({
  listApprovedPreauthsForPatient: vi.fn(async () => [{ id: 3, preauthNumber: 'PA-2026-000003', approvalReference: 'AR/1', approvedPaise: 100, validUntil: '2026-10-31', payerIds: [1] }]),
}))

import { POST as postPreauth } from '@/app/api/rcm/preauths/route'
import { POST as postAction } from '@/app/api/rcm/preauths/[id]/actions/route'
import { POST as postDoc } from '@/app/api/rcm/preauths/[id]/documents/route'
import { GET as getDoc } from '@/app/api/rcm/preauth-documents/[id]/route'
import { GET as getApproved } from '@/app/api/rcm/patients/[anonId]/approved-preauths/route'
import { POST as postEstimate } from '@/app/api/rcm/preauths/estimate/route'
import { applyPreauthAction, createPreauth, estimateForPolicy } from '@/lib/queries/preauths'
import { maybeStartEligibility } from '@/lib/queries/coverage'

const json = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) }) as never
const CREATE = { policyId: 1, claimType: 'opd', encounterId: 2, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 1, treatingProviderId: 4, diagnosisCodeIds: [9], procedureCodeIds: [], estimate: [{ serviceId: 1, quantity: 1 }] }

beforeEach(() => { sessionRole = 'rcm'; vi.clearAllMocks() })

describe('/api/rcm pre-auth routes', () => {
  it('billing can list approved pre-auths but gets 403 on POST /api/rcm/preauths', async () => {
    sessionRole = 'billing'
    expect((await postPreauth(json('/api/rcm/preauths', '{not json'))).status).toBe(403)
    expect(createPreauth).not.toHaveBeenCalled()
    const res = await getApproved(new NextRequest('http://localhost/api/rcm/patients/P-1/approved-preauths?onDate=2026-10-20'), ctx({ anonId: 'P-1' }))
    expect(res.status).toBe(200); expect((await res.json()).preauths[0].preauthNumber).toBe('PA-2026-000003')
    expect((await getApproved(new NextRequest('http://localhost/api/rcm/patients/P-1/approved-preauths?onDate=2026-13-01'), ctx({ anonId: 'P-1' }))).status).toBe(400)
  })
  it('rcm creates a pre-auth: 201', async () => {
    const res = await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(res.status).toBe(201); expect(await res.json()).toEqual({ preauthId: 3, preauthNumber: 'PA-2026-000003', eligibility: { started: true, checkId: 41 } })
  })
  // ---- WS12 T8 -------------------------------------------------------------------------------
  it('after the create, starts an auth-requirements check for the treating doctor in the preauth context', async () => {
    await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(maybeStartEligibility).toHaveBeenCalledWith({ policyId: 1, context: 'preauth', providerId: 4, purpose: 'auth-requirements' }, expect.objectContaining({ role: 'rcm' }))
  })
  it('a skipped check says why; a failing check never fails the create', async () => {
    vi.mocked(maybeStartEligibility).mockResolvedValueOnce({ started: false, reason: 'nhcx_not_configured', message: 'NHCX not configured: record a manual verification' })
    const skipped = await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(skipped.status).toBe(201)
    expect((await skipped.json()).eligibility).toEqual({ started: false, message: 'NHCX not configured: record a manual verification' })
    vi.mocked(maybeStartEligibility).mockRejectedValueOnce(new Error('boom'))
    const failed = await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(failed.status).toBe(201)
    expect((await failed.json()).eligibility).toMatchObject({ started: false })
  })
  it('a refused create starts no check: policy_not_in_force is 422 with the dates, coverage_inactive is 409', async () => {
    vi.mocked(createPreauth).mockResolvedValueOnce({ ok: false, error: 'policy_not_in_force', message: 'This policy is not valid on 1 Oct 2026 (valid 1 Apr 2025–31 Mar 2026)' })
    const r1 = await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(r1.status).toBe(422); expect(await r1.json()).toEqual({ error: 'This policy is not valid on 1 Oct 2026 (valid 1 Apr 2025–31 Mar 2026)' })
    vi.mocked(createPreauth).mockResolvedValueOnce({ ok: false, error: 'coverage_inactive' })
    const r2 = await postPreauth(json('/api/rcm/preauths', CREATE))
    expect(r2.status).toBe(409); expect(await r2.json()).toEqual({ error: 'The last verification says this policy is not in force' })
    expect(maybeStartEligibility).not.toHaveBeenCalled()
  })
  it('the estimate route returns the indicative split and accepts the expected stay', async () => {
    const coverage = { insurerPaise: 60, patientPaise: 40, warnings: ['Room charge over the limit'] }
    vi.mocked(estimateForPolicy).mockResolvedValueOnce({ ok: true, value: { lines: [], totalPaise: 100, coverage } })
    const res = await postEstimate(json('/api/rcm/preauths/estimate', { policyId: 1, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 3, roomCategoryCode: 'DLX', estimate: [{ serviceId: 1, quantity: 3 }] }))
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ lines: [], totalPaise: 100, coverage })
    expect(estimateForPolicy).toHaveBeenCalledWith({ policyId: 1, plannedAdmissionDate: '2026-10-01', expectedLengthOfStayDays: 3, roomCategoryCode: 'DLX', estimate: [{ serviceId: 1, quantity: 3 }] })
  })
  it('an unknown action is a 400; invalid_transition is a 409 with the catalogue message', async () => {
    expect((await postAction(json('/api/rcm/preauths/3/actions', { action: 'fly' }), ctx({ id: '3' }))).status).toBe(400)
    const res = await postAction(json('/api/rcm/preauths/3/actions', { action: 'request' }), ctx({ id: '3' }))
    expect(res.status).toBe(409); expect(await res.json()).toEqual({ error: 'That step is not possible from the current status' })
  })
  it('a 40001 from the query is a 409 with the retry message', async () => {
    vi.mocked(applyPreauthAction).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40001' }))
    const res = await postAction(json('/api/rcm/preauths/3/actions', { action: 'request' }), ctx({ id: '3' }))
    expect(res.status).toBe(409); expect((await res.json()).error).toMatch(/try again/)
  })
  it('uploads a document (201) and streams it back with an audit', async () => {
    const fd = new FormData(); fd.set('kind', 'preauth_approval'); fd.set('title', 'Approval'); fd.set('file', new File(['%PDF'], 'a.pdf', { type: 'application/pdf' }))
    const up = await postDoc(new NextRequest('http://localhost/api/rcm/preauths/3/documents', { method: 'POST', body: fd }), ctx({ id: '3' }))
    expect(up.status).toBe(201); expect(await up.json()).toEqual({ documentId: 8 })
    const res = await getDoc(new NextRequest('http://localhost/x'), ctx({ id: '8' }))
    expect(res.status).toBe(200)
    sessionRole = 'billing'
    expect((await getDoc(new NextRequest('http://localhost/x'), ctx({ id: '8' }))).status).toBe(403)
  })
})
