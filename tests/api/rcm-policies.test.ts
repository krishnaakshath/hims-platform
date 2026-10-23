// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/blob-store', () => ({ streamPrivateBlob: vi.fn(async () => new Response('img', { status: 200 })), putPrivateBlob: vi.fn() }))
vi.mock('@/lib/queries/rcm-policies', () => ({
  createPolicy: vi.fn(async () => ({ ok: true, value: { policyId: 5 } })),
  updatePolicy: vi.fn(async () => ({ ok: false, error: 'primary_exists' })),
  uploadPolicyCard: vi.fn(async () => ({ ok: true, value: null })),
  getPolicyCardBlob: vi.fn(async () => ({ url: 'https://blob.test/secret', patientId: 'P-1', contentType: 'image/png' })),
}))
// WS12 T4: the auto eligibility check after a policy is added.
vi.mock('@/lib/queries/coverage', () => ({
  defaultEligibilityProviderId: vi.fn(async () => 9),
  maybeStartEligibility: vi.fn(async () => ({ started: true, checkId: 77 })),
}))

import { POST as postPolicy } from '@/app/api/rcm/policies/route'
import { PATCH as patchPolicy } from '@/app/api/rcm/policies/[id]/route'
import { POST as postCard } from '@/app/api/rcm/policies/[id]/card/route'
import { GET as getCard } from '@/app/api/rcm/policies/[id]/card/[side]/route'
import { createPolicy, uploadPolicyCard, getPolicyCardBlob } from '@/lib/queries/rcm-policies'
import { streamPrivateBlob } from '@/lib/blob-store'
import { logAudit } from '@/lib/audit'
import { defaultEligibilityProviderId, maybeStartEligibility } from '@/lib/queries/coverage'

const POLICY = {
  patientId: 'P-1', insurerPayerId: 1, policyNumber: 'POL/1', memberId: 'M-1', policyType: 'individual', holderName: 'Asha',
  relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', priority: 'primary',
}
const json = (method: string, path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const multipart = (file: File | null, side = 'front') => {
  const fd = new FormData(); fd.set('side', side); if (file) fd.set('file', file)
  return new NextRequest('http://localhost/api/rcm/policies/5/card', { method: 'POST', body: fd })
}
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) }) as never

beforeEach(() => { sessionRole = 'frontdesk'; vi.clearAllMocks() })

describe('/api/rcm/policies', () => {
  it('frontdesk can add a policy; billing reads but gets 403 on POST', async () => {
    const ok = await postPolicy(json('POST', '/api/rcm/policies', POLICY))
    expect(ok.status).toBe(201); expect(await ok.json()).toEqual({ policyId: 5, eligibility: { started: true, checkId: 77 } })
    sessionRole = 'billing'
    const denied = await postPolicy(json('POST', '/api/rcm/policies', '{not json'))
    expect(denied.status).toBe(403); expect(createPolicy).toHaveBeenCalledTimes(1)
    const read = await getCard(new NextRequest('http://localhost/x'), ctx({ id: '5', side: 'front' }))
    expect(read.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rcm: viewed policy card', 'P-1', 'policy=5 side=front')
  })
  it('an Aadhaar-like member number is a 400 with the authored message; primary_exists is a 409', async () => {
    const res = await postPolicy(json('POST', '/api/rcm/policies', { ...POLICY, memberId: '234123412346' }))
    expect(res.status).toBe(400); expect((await res.json()).error).toMatch(/national ID/)
    const p = await patchPolicy(json('PATCH', '/api/rcm/policies/5', { status: 'active' }), ctx({ id: '5' }))
    expect(p.status).toBe(409); expect(await p.json()).toEqual({ error: 'This patient already has an active primary policy' })
  })
  it('a non-multipart card upload is a 400; a 5 MB file is a 400 with the authored message', async () => {
    const notMultipart = await postCard(json('POST', '/api/rcm/policies/5/card', '{}'), ctx({ id: '5' }))
    expect(notMultipart.status).toBe(400); expect(await notMultipart.json()).toEqual({ error: 'Send the file as multipart form data' })
    const big = await postCard(multipart(new File([new Uint8Array(5_000_000)], 'card.png', { type: 'image/png' })), ctx({ id: '5' }))
    expect(big.status).toBe(400); expect(await big.json()).toEqual({ error: 'Upload a PDF, JPEG or PNG file of at most 4 MB' })
    const gif = await postCard(multipart(new File(['x'], 'card.gif', { type: 'image/gif' })), ctx({ id: '5' }))
    expect(gif.status).toBe(400)
    const badSide = await postCard(multipart(new File(['x'], 'card.png', { type: 'image/png' }), 'top'), ctx({ id: '5' }))
    expect(badSide.status).toBe(400)
    expect(uploadPolicyCard).not.toHaveBeenCalled()
    const ok = await postCard(multipart(new File(['x'], 'card.png', { type: 'image/png' })), ctx({ id: '5' }))
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ ok: true })
  })
  it('card GET: 404s for a missing card or stored file; never returns the URL', async () => {
    vi.mocked(getPolicyCardBlob).mockResolvedValueOnce(null)
    expect(await (await getCard(new NextRequest('http://localhost/x'), ctx({ id: '5', side: 'back' }))).json()).toEqual({ error: 'Card image not found' })
    vi.mocked(streamPrivateBlob).mockResolvedValueOnce(null)
    expect(await (await getCard(new NextRequest('http://localhost/x'), ctx({ id: '5', side: 'front' }))).json()).toEqual({ error: 'Stored file is missing' })
    expect(logAudit).not.toHaveBeenCalled()
    sessionRole = 'labs'
    expect((await getCard(new NextRequest('http://localhost/x'), ctx({ id: '5', side: 'front' }))).status).toBe(403)
  })
})

describe('POST /api/rcm/policies: validity and the auto eligibility check (WS12 T4)', () => {
  it('an already-expired active policy is a 422 policy_not_in_force with the dates, and no check is attempted', async () => {
    const message = 'This policy is not valid on 23 Oct 2026 (valid 1 Apr 2025–22 Oct 2026)'
    vi.mocked(createPolicy).mockResolvedValueOnce({ ok: false, error: 'policy_not_in_force', message })
    const res = await postPolicy(json('POST', '/api/rcm/policies', { ...POLICY, validFrom: '2025-04-01', validTo: '2026-10-22' }))
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: message })
    expect(maybeStartEligibility).not.toHaveBeenCalled()
  })
  it('after the create, starts a registration check with the latest encounter doctor', async () => {
    const res = await postPolicy(json('POST', '/api/rcm/policies', POLICY))
    expect(res.status).toBe(201)
    expect(defaultEligibilityProviderId).toHaveBeenCalledWith('P-1')
    expect(maybeStartEligibility).toHaveBeenCalledWith({ policyId: 5, context: 'registration', providerId: 9, purpose: 'validation' }, expect.objectContaining({ role: 'frontdesk' }))
  })
  it('a skipped check is reported with its message and the create still succeeds', async () => {
    vi.mocked(maybeStartEligibility).mockResolvedValueOnce({ started: false, reason: 'nhcx_not_configured', message: 'NHCX not configured: record a manual verification' })
    const res = await postPolicy(json('POST', '/api/rcm/policies', POLICY))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ policyId: 5, eligibility: { started: false, message: 'NHCX not configured: record a manual verification' } })
  })
  it('an unexpected failure of the check never fails the create', async () => {
    vi.mocked(defaultEligibilityProviderId).mockRejectedValueOnce(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const res = await postPolicy(json('POST', '/api/rcm/policies', POLICY))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.policyId).toBe(5); expect(body.eligibility.started).toBe(false)
    expect(spy.mock.calls.flat().join(' ')).not.toContain('boom')
    spy.mockRestore()
  })
})
