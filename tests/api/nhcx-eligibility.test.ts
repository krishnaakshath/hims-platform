import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Desk', userId: 2 })) }
})
const requestEligibility = vi.fn()
const getEligibilityCheck = vi.fn()
vi.mock('@/lib/queries/nhcx-eligibility', () => ({ requestEligibility: (...a: unknown[]) => requestEligibility(...a), getEligibilityCheck: (...a: unknown[]) => getEligibilityCheck(...a) }))
let state = 'mock'
vi.mock('@/lib/integrations/config', () => ({ readNhcxConfig: () => ({ state }) }))

import { POST } from '@/app/api/nhcx/eligibility/route'
import { GET } from '@/app/api/nhcx/eligibility/[id]/route'

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/nhcx/eligibility', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))
const get = (id: string) => GET(new NextRequest(`http://localhost/api/nhcx/eligibility/${id}`), { params: Promise.resolve({ id }) })
const BODY = { policyId: 4, context: 'manual', providerId: 9 }

beforeEach(() => { sessionRole = 'frontdesk'; state = 'mock'; requestEligibility.mockReset(); getEligibilityCheck.mockReset() })

describe('NHCX eligibility routes', () => {
  it('pharmacy, labs, coder, pi get 403 before the body; 503 when unconfigured; 202 queued', async () => {
    for (const r of ['pharmacy', 'labs', 'coder', 'pi', 'collector'] as Role[]) {
      sessionRole = r
      expect((await post('{not json')).status).toBe(403)
      expect((await get('1')).status).toBe(403)
    }
    sessionRole = 'billing'
    state = 'not_configured'
    const off = await post(BODY)
    expect(off.status).toBe(503); expect(await off.json()).toEqual({ error: 'NHCX is not configured' })
    state = 'mock'
    requestEligibility.mockResolvedValue({ ok: true, value: { checkId: 12, exchangeId: 3 } })
    const ok = await post(BODY)
    expect(ok.status).toBe(202); expect(await ok.json()).toEqual({ checkId: 12 })
    expect(requestEligibility).toHaveBeenCalledWith({ ...BODY, purpose: 'validation' }, expect.objectContaining({ name: 'Desk' }))
  })
  it('validates the body strictly and maps refusals', async () => {
    expect((await post({ ...BODY, extra: 1 })).status).toBe(400)
    expect((await post({ ...BODY, context: 'somewhere' })).status).toBe(400)
    requestEligibility.mockResolvedValue({ ok: false, error: 'gateway_not_configured', message: 'This insurer or TPA has no NHCX participant code' })
    const r = await post(BODY)
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'This insurer or TPA has no NHCX participant code' })
  })
  it('the check view carries status only', async () => {
    getEligibilityCheck.mockResolvedValue({ id: 12, status: 'eligible', inforce: true, requestedAt: 'x', respondedAt: 'y', payerName: 'TPA', isMock: true, patientId: 'RD-1' })
    const r = await get('12')
    expect(await r.json()).toEqual({ id: 12, status: 'eligible', inforce: true, requestedAt: 'x', respondedAt: 'y', payerName: 'TPA', isMock: true })
    getEligibilityCheck.mockResolvedValue(null)
    expect((await get('13')).status).toBe(404)
    expect((await get('abc')).status).toBe(400)
  })
})
