// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: 5 })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/blob-store', () => ({
  putPrivateBlob: vi.fn(),
  streamPrivateBlob: vi.fn(async (_url: string, o: { filename: string; disposition: string }) => new Response('pdf', { headers: { 'Content-Disposition': `${o.disposition}; filename="${o.filename}"`, 'Cache-Control': 'private, no-store' } })),
}))
vi.mock('@/lib/queries/claims', () => ({ createClaimDraft: vi.fn(async () => ({ ok: true, value: { claimId: 4, claimNumber: 'CLM-2026-000004' } })), setClaimInvoices: vi.fn() }))
vi.mock('@/lib/queries/claim-documents', () => ({ uploadClaimDocument: vi.fn(), attachLabReport: vi.fn(), waiveClaimDocument: vi.fn(), removeClaimDocument: vi.fn(), getClaimDocumentBlob: vi.fn() }))
vi.mock('@/lib/queries/claim-submissions', () => ({
  submitClaimVersion: vi.fn(async () => ({ ok: false, error: 'not_ready', items: [{ code: 'document_missing', severity: 'block', message: 'Missing document: Claim form', documentKind: 'claim_form' }] })),
  acknowledgeDispatch: vi.fn(), renderDraftCopy: vi.fn(),
  getSubmissionCopy: vi.fn(async () => ({ url: 'https://blob.test/secret', claimId: 4, claimNumber: 'CLM-2026-000004', version: 1, patientId: 'P-1' })),
  verifySubmission: vi.fn(),
}))
vi.mock('@/lib/queries/claim-updates', () => ({
  applyClaimUpdate: vi.fn(), recordSettlement: vi.fn(), requestWriteOff: vi.fn(), reconcileSettlement: vi.fn(),
  decideWriteOff: vi.fn(async () => ({ ok: true, value: null })),
}))

import { POST as postClaim } from '@/app/api/rcm/claims/route'
import { POST as postSubmission } from '@/app/api/rcm/claims/[id]/submissions/route'
import { POST as postDecision } from '@/app/api/rcm/write-offs/[id]/decision/route'
import { GET as getCopy } from '@/app/api/rcm/submissions/[id]/copy/[copy]/route'
import { createClaimDraft, setClaimInvoices } from '@/lib/queries/claims'
import { submitClaimVersion } from '@/lib/queries/claim-submissions'
import { logAudit } from '@/lib/audit'

const json = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) }) as never

beforeEach(() => { sessionRole = 'rcm'; vi.clearAllMocks() })

describe('/api/rcm claim routes', () => {
  it('billing, crc and frontdesk get 403 before the body is read', async () => {
    for (const role of ['billing', 'crc', 'frontdesk'] as Role[]) {
      sessionRole = role
      expect((await postClaim(json('/api/rcm/claims', '{not json'))).status).toBe(403)
      expect((await postSubmission(json('/api/rcm/claims/4/submissions', '{not json'), ctx({ id: '4' }))).status).toBe(403)
    }
    expect(createClaimDraft).not.toHaveBeenCalled(); expect(setClaimInvoices).not.toHaveBeenCalled()
  })
  it('creates a claim: 201', async () => {
    const res = await postClaim(json('/api/rcm/claims', { policyId: 1, claimType: 'opd', encounterId: 2, invoices: [{ invoiceId: 3 }] }))
    expect(res.status).toBe(201); expect(await res.json()).toEqual({ claimId: 4, claimNumber: 'CLM-2026-000004' })
  })
  it('a not-ready submission is a 422 carrying the readiness items', async () => {
    const res = await postSubmission(json('/api/rcm/claims/4/submissions', { action: 'submit', channel: 'portal' }), ctx({ id: '4' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'This claim is not ready to submit', items: [expect.objectContaining({ code: 'document_missing' })] })
  })
  it('a 40P01 from submitClaimVersion is a 409 with the retry message', async () => {
    vi.mocked(submitClaimVersion).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    const res = await postSubmission(json('/api/rcm/claims/4/submissions', { action: 'submit', channel: 'portal' }), ctx({ id: '4' }))
    expect(res.status).toBe(409); expect((await res.json()).error).toMatch(/try again/)
  })
  it('rcm gets 403 on the write-off decision; admin gets 200', async () => {
    expect((await postDecision(json('/api/rcm/write-offs/9/decision', { decision: 'approve' }), ctx({ id: '9' }))).status).toBe(403)
    sessionRole = 'admin'
    expect((await postDecision(json('/api/rcm/write-offs/9/decision', { decision: 'approve' }), ctx({ id: '9' }))).status).toBe(200)
  })
  it('a copy download sets attachment and no-store, and never returns the blob URL; an unknown copy is a 400', async () => {
    const res = await getCopy(new NextRequest('http://localhost/x'), ctx({ id: '7', copy: 'insurer' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="CLM-2026-000004-v1-insurer.pdf"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await res.text()).not.toContain('blob.test')
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rcm: downloaded claim copy', 'P-1', 'claim=4 version=1 copy=insurer')
    const bad = await getCopy(new NextRequest('http://localhost/x'), ctx({ id: '7', copy: 'patient' }))
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: 'Unknown copy' })
  })
})
