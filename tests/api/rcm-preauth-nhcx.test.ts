import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Farah', userId: 3 })) }
})
const create = vi.fn()
vi.mock('@/lib/queries/nhcx-exchanges', () => ({ createPreauthExchange: (...a: unknown[]) => create(...a) }))
let configured = true
vi.mock('@/lib/integrations/config', () => ({ readNhcxConfig: () => (configured ? { state: 'mock' } : { state: 'not_configured', missing: ['NHCX_API_BASE_URL'] }) }))

import { POST } from '@/app/api/rcm/preauths/[id]/nhcx/route'

const call = (body: string | undefined = '{}', id = '7') => POST(new NextRequest(`http://localhost/api/rcm/preauths/${id}/nhcx`, { method: 'POST', body }), { params: Promise.resolve({ id }) })

beforeEach(() => { sessionRole = 'rcm'; configured = true; create.mockReset() })

describe('POST /api/rcm/preauths/[id]/nhcx', () => {
  it('frontdesk/billing/coder get 403 before the body; 503 when unconfigured; 202 when queued', async () => {
    for (const r of ['frontdesk', 'billing', 'coder', 'crc', 'pi'] as Role[]) {
      sessionRole = r
      const res = await call('{not json')
      expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    sessionRole = 'rcm'
    configured = false
    expect((await call()).status).toBe(503)
    configured = true
    create.mockResolvedValue({ ok: true, value: { exchangeId: 5, correlationId: '6d8f9a3e-1b2c-4d5e-8f90-123456789abc' } })
    const ok = await call()
    expect(ok.status).toBe(202); expect(await ok.json()).toEqual({ exchangeId: 5, correlationPrefix: '6d8f9a3e' })
    expect(create).toHaveBeenCalledWith(7, expect.objectContaining({ name: 'Farah' }))
    expect((await call(undefined)).status).toBe(202)
  })
  it('sending the same request event twice is refused', async () => {
    create.mockResolvedValue({ ok: false, error: 'duplicate_reference', message: 'Already sent through NHCX' })
    const r = await call()
    expect(r.status).toBe(409); expect(await r.json()).toEqual({ error: 'Already sent through NHCX' })
  })
  it('a body with keys or a bad id is a 400', async () => {
    expect((await call('{"x":1}')).status).toBe(400)
    expect((await call('{}', 'abc')).status).toBe(400)
  })
})
