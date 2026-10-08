// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { checkCallerIp, verifyNhcxBearer } from '@/lib/nhcx/callback-auth'
import { makeCallbackKit } from '../../helpers/nhcx-callback'

const kit = makeCallbackKit()
const req = (h: Record<string, string>) => new Request('https://app.example/x', { method: 'POST', headers: h })

describe('NHCX callback auth', () => {
  it('an empty allowlist admits any caller; a set one only listed first hops', () => {
    expect(checkCallerIp(req({ 'x-forwarded-for': '1.2.3.4' }), [])).toBe(true)
    expect(checkCallerIp(req({ 'x-forwarded-for': '3.109.99.210, 10.0.0.1' }), ['3.109.99.210'])).toBe(true)
    expect(checkCallerIp(req({ 'x-forwarded-for': '10.0.0.1, 3.109.99.210' }), ['3.109.99.210'])).toBe(false)
    expect(checkCallerIp(req({}), ['3.109.99.210'])).toBe(false)
  })
  it('verifies the bearer JWT against the NHCX signing certificate only', async () => {
    expect(await verifyNhcxBearer(req({ authorization: `Bearer ${await kit.bearer()}` }), kit.cfg.gatewaySigningCertPem)).toBe(true)
    expect(await verifyNhcxBearer(req({ authorization: `Bearer ${await kit.bearer(kit.stranger.privateKeyPem)}` }), kit.cfg.gatewaySigningCertPem)).toBe(false)
    expect(await verifyNhcxBearer(req({ authorization: `Bearer ${await kit.bearer()}` }), null)).toBe(false)
    expect(await verifyNhcxBearer(req({}), kit.cfg.gatewaySigningCertPem)).toBe(false)
    expect(await verifyNhcxBearer(req({ authorization: 'Bearer x.y.z' }), kit.cfg.gatewaySigningCertPem)).toBe(false)
  })
})
