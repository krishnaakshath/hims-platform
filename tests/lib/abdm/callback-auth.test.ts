// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose'
import { verifyAbdmCallback } from '@/lib/abdm/callback-auth'
import type { AbdmConfig } from '@/lib/integrations/config'

const CFG: AbdmConfig = {
  gatewayBaseUrl: 'https://gw.example', abhaBaseUrl: 'https://abha.example', clientId: 'c', clientSecret: 's', cmId: 'sbx',
  hipId: 'HFR-1', gatewayJwksUrl: 'https://gw.example/certs', consentTextPath: null,
}
let jwks: JWTVerifyGetKey
let good = ''
let foreign = ''
let expired = ''

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const other = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }
  jwks = createLocalJWKSet({ keys: [jwk] })
  good = await new SignJWT({ clientId: 'gateway' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(privateKey)
  foreign = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('5m').sign(other.privateKey)
  expired = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt(1_000).setExpirationTime(2_000).sign(privateKey)
})

const req = (headers: Record<string, string>) => new Request('https://app.example/api/abdm/api/v3/hip/patient/share', { method: 'POST', headers })

describe('verifyAbdmCallback', () => {
  it('503 without a JWKS URL; 401 without or with a bad bearer; 403 for another HIP', async () => {
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${good}`, 'X-HIP-ID': 'HFR-1' }), { ...CFG, gatewayJwksUrl: null }, { jwks })).toEqual({ ok: false, status: 503 })
    expect(await verifyAbdmCallback(req({ 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: false, status: 401 })
    expect(await verifyAbdmCallback(req({ Authorization: 'Bearer not-a-jwt', 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: false, status: 401 })
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${foreign}`, 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: false, status: 401 })
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${expired}`, 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: false, status: 401 })
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${good}`, 'X-HIP-ID': 'HFR-2' }), CFG, { jwks })).toEqual({ ok: false, status: 403 })
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${good}`, 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: true })
  })
  it('refuses an HS256 token even with a valid shape', async () => {
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('x'.repeat(32)))
    expect(await verifyAbdmCallback(req({ Authorization: `Bearer ${hs}`, 'X-HIP-ID': 'HFR-1' }), CFG, { jwks })).toEqual({ ok: false, status: 401 })
  })
})
