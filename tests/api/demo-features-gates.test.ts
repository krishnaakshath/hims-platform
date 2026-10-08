import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

// Wave B P1-21/P1-22: simulated features answer 503 'Not configured' when
// DEMO_FEATURES is off. The role gate still runs first (a denied role gets
// the plain 403), and neither answer reads the body.
let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: `Test ${sessionRole}`, userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { POST as postMockPayment } from '@/app/api/mock-payments/route'
import { POST as postBroadcast } from '@/app/api/broadcasts/route'
import { POST as postReview } from '@/app/api/reviews/route'
import { PUT as putReview } from '@/app/api/reviews/[id]/route'

const NOT_JSON = '{not json'
const req = (method: string, path: string) => new NextRequest(`http://localhost${path}`, { method, body: NOT_JSON })
const ctx = { params: Promise.resolve({ id: '2147483000' }) }

const CASES: { name: string; call: () => Promise<Response>; allowed: Role; denied: Role }[] = [
  { name: 'POST /api/mock-payments', call: () => postMockPayment(req('POST', '/api/mock-payments')), allowed: 'billing', denied: 'frontdesk' },
  { name: 'POST /api/broadcasts', call: () => postBroadcast(req('POST', '/api/broadcasts')), allowed: 'crc', denied: 'pi' },
  { name: 'POST /api/reviews', call: () => postReview(req('POST', '/api/reviews')), allowed: 'crc', denied: 'pi' },
  { name: 'PUT /api/reviews/[id]', call: () => putReview(req('PUT', '/api/reviews/2147483000'), ctx), allowed: 'admin', denied: 'labs' },
  // SP8: the simulated eligibility check is retired (410 regardless of DEMO_FEATURES).
]

const saved = process.env.DEMO_FEATURES
beforeEach(() => { process.env.DEMO_FEATURES = 'false' })
afterEach(() => { process.env.DEMO_FEATURES = saved; sessionRole = 'admin' })

describe.each(CASES)('$name with DEMO_FEATURES off', (c) => {
  it('answers 503 Not configured to an allowed role, before reading the body', async () => {
    sessionRole = c.allowed
    const res = await c.call()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Not configured' })
  })
  it('still answers a denied role with the plain 403', async () => {
    sessionRole = c.denied
    const res = await c.call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })
  it('reaches body parsing again when DEMO_FEATURES is on', async () => {
    process.env.DEMO_FEATURES = 'true'
    sessionRole = c.allowed
    const res = await c.call().catch(() => new Response(null, { status: 500 }))
    expect(res.status).not.toBe(503)
  })
})
