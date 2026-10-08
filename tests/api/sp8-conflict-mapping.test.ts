import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Final review: a deadlock or serialization failure (nothing written) is a 409 "try again" on the
// SP8 staff writes, never a misleading 502 or a 500.
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'admin', name: 'Admin', userId: 1 })) }
})
vi.mock('@/lib/rate-limit', () => ({ checkAbhaRateLimit: vi.fn(async () => ({ allowed: true })) }))
vi.mock('@/lib/abdm/registry', () => ({ getAbdmGateway: () => ({ source: 'abdm' }) }))
const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' })
vi.mock('@/lib/abdm/flow-store', () => ({
  getFlow: vi.fn(async () => ({ flowId: '11111111-1111-4111-8111-111111111111', staffName: 'Admin', patientId: null, consentId: null, verified: { abhaNumber: '91123456789012', abhaAddress: null, via: 'mobile_otp', source: 'abdm' } })),
  deleteFlow: vi.fn(),
}))
vi.mock('@/lib/queries/abha-link', () => ({ applyVerifiedAbha: vi.fn(async () => { throw deadlock }) }))
vi.mock('@/lib/queries/abdm-profile-shares', () => ({ resolveShare: vi.fn(async () => { throw Object.assign(new Error('could not serialize'), { code: '40001' }) }), getSharePrefill: vi.fn() }))

import { POST as link } from '@/app/api/patients/[anonId]/abha/link/route'
import { POST as resolve } from '@/app/api/abdm/shares/[id]/route'
import { RETRY_MESSAGE } from '@/lib/db-errors'

describe('SP8 retryable conflicts', () => {
  it('ABHA link maps a deadlock to 409 with the retry message', async () => {
    const r = await link(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ flowId: '11111111-1111-4111-8111-111111111111' }) }), { params: Promise.resolve({ anonId: 'RD-1' }) })
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: RETRY_MESSAGE })
  })
  it('share resolution maps a serialization failure to 409', async () => {
    const r = await resolve(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'dismissed' }) }), { params: Promise.resolve({ id: '4' }) })
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: RETRY_MESSAGE })
  })
})
