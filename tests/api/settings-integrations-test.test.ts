import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Admin', userId: 1 })) }
})
const logAudit = vi.fn<(...a: unknown[]) => Promise<undefined>>(async () => undefined)
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }))
let allowed = true
vi.mock('@/lib/rate-limit', () => ({ checkIntegrationTestRateLimit: vi.fn(async () => ({ allowed })) }))
const refresh = vi.fn()
vi.mock('@/lib/abdm/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abdm/session')>('@/lib/abdm/session')
  return { ...actual, refreshGatewayToken: (...a: unknown[]) => refresh(...a), resetGatewayTokenCache: vi.fn() }
})

import { POST } from '@/app/api/settings/integrations/test/route'
import { AbdmHttpError } from '@/lib/abdm/session'

const FULL = { ABDM_GATEWAY_BASE_URL: 'https://gw.example', ABHA_BASE_URL: 'https://abha.example', ABDM_CLIENT_ID: 'cid', ABDM_CLIENT_SECRET: 'super-secret', ABDM_CM_ID: 'sbx' }
const call = (body: unknown) => POST(new NextRequest('http://localhost/api/settings/integrations/test', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }))

beforeEach(() => { sessionRole = 'admin'; allowed = true; refresh.mockReset(); logAudit.mockClear() })
afterEach(() => vi.unstubAllEnvs())

describe('POST /api/settings/integrations/test', () => {
  it('admin-only, token fetch only, fixed messages, rate limited', async () => {
    for (const r of ['rcm', 'frontdesk', 'crc', 'billing', 'pi'] as Role[]) { sessionRole = r; expect((await call('{not json')).status).toBe(403) }
    sessionRole = 'admin'
    expect(await (await call({ capability: 'abdm' })).json()).toEqual({ ok: false, message: 'ABDM is not configured' })
    for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, v)
    refresh.mockResolvedValueOnce({ expiresIn: 1200 })
    expect(await (await call({ capability: 'abdm' })).json()).toEqual({ ok: true, expiresInSeconds: 1200 })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'abdm: tested connection', null, 'ok=true')
    refresh.mockRejectedValueOnce(new AbdmHttpError(401))
    const failed = await (await call({ capability: 'abdm' })).text()
    expect(JSON.parse(failed)).toEqual({ ok: false, message: 'ABDM did not respond; try again shortly' }); expect(failed).not.toContain('super-secret')
    expect(await (await call({ capability: 'nhcx' })).json()).toEqual({ ok: false, message: 'NHCX is not configured' })
    allowed = false
    expect((await call({ capability: 'abdm' })).status).toBe(429)
  })
  it('the mock answers without a network call', async () => {
    vi.stubEnv('ABDM_USE_MOCKS', '1'); vi.stubEnv('NODE_ENV', 'development')
    expect(await (await call({ capability: 'nhcx' })).json()).toEqual({ ok: true, mock: true })
    expect(refresh).not.toHaveBeenCalled()
    expect((await call({ capability: 'other' })).status).toBe(400)
  })
})
