import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'rcm'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Farah', userId: 3 })) }
})
const logAudit = vi.fn(async () => undefined)
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => (logAudit as (...x: unknown[]) => Promise<undefined>)(...a) }))
const poll = vi.fn()
const sweep = vi.fn(async () => ({ dispatched: 1, failed: 0, polled: 0, noResponse: 0, sharesExpired: 2, inboundPurged: 3 }))
vi.mock('@/lib/queries/nhcx-exchanges', () => ({ pollExchangeStatus: (...a: unknown[]) => poll(...a), runNhcxSweep: () => sweep() }))
let configured = true
vi.mock('@/lib/integrations/config', () => ({ readNhcxConfig: () => (configured ? { state: 'configured', config: {} } : { state: 'not_configured', missing: [] }) }))

import { POST as status } from '@/app/api/rcm/nhcx/exchanges/[id]/status/route'
import { GET as cron } from '@/app/api/cron/nhcx-sweep/route'

const statusReq = (body = '{}') => status(new NextRequest('http://localhost/api/rcm/nhcx/exchanges/9/status', { method: 'POST', body }), { params: Promise.resolve({ id: '9' }) })
const cronReq = (auth?: string) => cron(new NextRequest('http://localhost/api/cron/nhcx-sweep', { headers: auth ? { authorization: auth } : {} }))

beforeEach(() => { sessionRole = 'rcm'; configured = true; poll.mockReset(); sweep.mockClear(); logAudit.mockClear() })
afterEach(() => vi.unstubAllEnvs())

describe('NHCX status check and cron', () => {
  it('the cron route needs the secret and never reveals it', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await cronReq('Bearer x')).status).toBe(503)
    vi.stubEnv('CRON_SECRET', 'cron-secret-value')
    const wrong = await cronReq('Bearer nope')
    expect(wrong.status).toBe(401); expect(await wrong.text()).not.toContain('cron-secret-value')
    expect((await cronReq()).status).toBe(401)
    const ok = await cronReq('Bearer cron-secret-value')
    expect(ok.status).toBe(200); expect(await ok.json()).toEqual({ dispatched: 1, failed: 0, polled: 0, noResponse: 0, sharesExpired: 2, inboundPurged: 3 })
    expect(sweep).toHaveBeenCalledTimes(1)
  })
  it('status check is gated, rate limited per exchange and 503 when unconfigured', async () => {
    for (const r of ['frontdesk', 'billing', 'crc', 'coder'] as Role[]) {
      sessionRole = r
      const res = await statusReq('{not json')
      expect(res.status).toBe(403); expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    sessionRole = 'admin'
    configured = false
    expect((await statusReq()).status).toBe(503)
    configured = true
    poll.mockResolvedValueOnce('too_soon')
    const soon = await statusReq()
    expect(soon.status).toBe(429); expect(await soon.json()).toEqual({ error: 'Status was checked less than 15 minutes ago' })
    poll.mockResolvedValueOnce('sent')
    const ok = await statusReq()
    expect(await ok.json()).toEqual({ result: 'sent' })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'nhcx: requested status', null, 'exchange=9')
    poll.mockResolvedValueOnce('disabled')
    expect((await statusReq()).status).toBe(409)
  })
})
