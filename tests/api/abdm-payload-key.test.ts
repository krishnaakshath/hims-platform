import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { sealPayload } from '@/lib/integrations/payload-vault'
import { MOCK_CONSENT_TEXT, sha256Hex } from '@/lib/abdm/consent'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: 'frontdesk', name: 'Desk One', userId: null })) }
})
vi.mock('@/lib/rate-limit', () => ({ checkAbhaRateLimit: vi.fn(async () => ({ allowed: true })) }))
// The real flow store seals its entries with the payload key; reproduce that step.
vi.mock('@/lib/abdm/flow-store', () => ({
  createFlow: vi.fn(async () => { sealPayload('{}'); return { flowId: 'f' } }),
  getFlow: vi.fn(), saveFlow: vi.fn(), deleteFlow: vi.fn(),
}))
vi.mock('@/lib/abdm/registry', () => ({ getAbdmGateway: vi.fn(() => ({ source: 'abdm_sandbox_mock', status: () => ({ state: 'configured', label: 'x' }) })) }))

import { POST } from '@/app/api/abdm/abha/consent/route'

const body = { purpose: 'abha_enrolment', givenBy: 'patient', textSha256: sha256Hex(MOCK_CONSENT_TEXT) }
const call = () => POST(new NextRequest('http://localhost/api/abdm/abha/consent', { method: 'POST', body: JSON.stringify(body) }))

const saved = process.env.INTEGRATION_PAYLOAD_KEY
let spies: ReturnType<typeof vi.spyOn>[] = []
beforeEach(() => { spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {})) })
afterEach(() => {
  for (const s of spies) s.mockRestore()
  if (saved === undefined) delete process.env.INTEGRATION_PAYLOAD_KEY
  else process.env.INTEGRATION_PAYLOAD_KEY = saved
})

describe('ABHA consent with the payload key unset', () => {
  it('answers 503 with the payload-key message, not "ABDM is not configured"', async () => {
    delete process.env.INTEGRATION_PAYLOAD_KEY
    const r = await call()
    expect(r.status).toBe(503)
    const j = await r.json()
    expect(j.error).toMatch(/encryption key is not set/i)
    expect(j.error).not.toMatch(/ABDM is not configured/)
    expect(j.error).not.toMatch(/INTEGRATION_PAYLOAD_KEY/)
  })
  it('a wrong-length key gets the same message and never leaks the value', async () => {
    process.env.INTEGRATION_PAYLOAD_KEY = Buffer.from('short-secret-value').toString('base64')
    const r = await call()
    expect(r.status).toBe(503)
    expect(JSON.stringify(await r.json())).not.toContain('short-secret-value')
  })
})
