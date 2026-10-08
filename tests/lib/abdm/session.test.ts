import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { abdmHeaders, AbdmHttpError, getAbhaPublicKey, getGatewayToken, mapAbdmFailure, resetGatewayTokenCache } from '@/lib/abdm/session'
import { ABDM_PATHS, ABHA_ENCRYPTION_ALGORITHM } from '@/lib/abdm/constants'
import type { AbdmConfig } from '@/lib/integrations/config'

const CFG: AbdmConfig = {
  gatewayBaseUrl: 'https://dev.abdm.example', abhaBaseUrl: 'https://abhasbx.example', clientId: 'cid', clientSecret: 'csec', cmId: 'sbx',
  hipId: null, gatewayJwksUrl: null, consentTextPath: null,
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => resetGatewayTokenCache())
afterEach(() => vi.restoreAllMocks())

describe('abdmHeaders', () => {
  it('carries a fresh REQUEST-ID, an ISO timestamp and JSON content type', () => {
    const h = abdmHeaders({ 'X-CM-ID': 'sbx' }, new Date('2026-10-08T06:02:26.605Z'))
    expect(h).toEqual({ 'REQUEST-ID': expect.stringMatching(UUID), TIMESTAMP: '2026-10-08T06:02:26.605Z', 'Content-Type': 'application/json', 'X-CM-ID': 'sbx' })
    expect(abdmHeaders()['REQUEST-ID']).not.toBe(h['REQUEST-ID'])
  })
})

describe('getGatewayToken', () => {
  it('fetches one token for concurrent callers and refreshes 60 s before expiry', async () => {
    const fetch = vi.fn().mockResolvedValue(json(202, { accessToken: 'T1', expiresIn: 1200 }))
    let t = new Date('2026-10-08T00:00:00Z'); const deps = { fetch, now: () => t }
    expect(await Promise.all([getGatewayToken(CFG, deps), getGatewayToken(CFG, deps)])).toEqual(['T1', 'T1']); expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe('https://dev.abdm.example' + ABDM_PATHS.session)
    expect(init.method).toBe('POST')
    expect(init.headers['X-CM-ID']).toBe('sbx'); expect(JSON.parse(init.body)).toEqual({ clientId: 'cid', clientSecret: 'csec', grantType: 'client_credentials' })
    t = new Date(t.getTime() + 1_139_000); expect(await getGatewayToken(CFG, deps)).toBe('T1'); expect(fetch).toHaveBeenCalledTimes(1)
    t = new Date(t.getTime() + 2_000); fetch.mockResolvedValue(json(202, { accessToken: 'T2', expiresIn: 1200 })); expect(await getGatewayToken(CFG, deps)).toBe('T2')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('accepts 200 as well as 202', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { accessToken: 'T9', expiresIn: 600 }))
    expect(await getGatewayToken(CFG, { fetch, now: () => new Date() })).toBe('T9')
  })
  it('ABDM error bodies are mapped to fixed messages', async () => {
    const fetch = vi.fn().mockResolvedValue(json(401, { error: 'clientSecret csec is wrong' }))
    await expect(getGatewayToken(CFG, { fetch, now: () => new Date() })).rejects.toThrow(/^ABDM HTTP 401$/)
    expect(mapAbdmFailure(401, { otpStep: true })).toBe('otp_invalid'); expect(mapAbdmFailure(500)).toBe('abdm_unavailable')
    expect(mapAbdmFailure(401)).toBe('abdm_unavailable'); expect(mapAbdmFailure(400)).toBe('invalid_input'); expect(mapAbdmFailure(422)).toBe('invalid_input')
    expect(mapAbdmFailure(429)).toBe('rate_limited'); expect(mapAbdmFailure(null)).toBe('abdm_unavailable')
  })
  it('a failed fetch is not cached, and a network error never carries its cause', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('connect ECONNREFUSED with csec')).mockResolvedValue(json(202, { accessToken: 'T3', expiresIn: 1200 }))
    const err = await getGatewayToken(CFG, { fetch, now: () => new Date() }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(AbdmHttpError)
    expect(String(err) + String((err as Error).cause ?? '')).not.toContain('csec')
    expect(await getGatewayToken(CFG, { fetch, now: () => new Date() })).toBe('T3')
  })
  it('a malformed token response is an error', async () => {
    const fetch = vi.fn().mockResolvedValue(json(202, { token: 'x' }))
    await expect(getGatewayToken(CFG, { fetch, now: () => new Date() })).rejects.toBeInstanceOf(AbdmHttpError)
  })
})

describe('getAbhaPublicKey', () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const routes = (cert: unknown) => vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith(ABDM_PATHS.session)) return json(202, { accessToken: 'GW', expiresIn: 1200 })
    if (url.endsWith(ABDM_PATHS.publicCert)) return json(200, cert)
    return json(404, {})
  })
  it('reads the public key with the gateway token and caches it', async () => {
    const fetch = routes({ publicKey: 'SPKI', encryptionAlgorithm: ABHA_ENCRYPTION_ALGORITHM })
    const deps = { fetch, now: () => new Date('2026-10-08T00:00:00Z') }
    expect(await getAbhaPublicKey(CFG, deps)).toBe('SPKI')
    expect(await getAbhaPublicKey(CFG, deps)).toBe('SPKI')
    const certCalls = fetch.mock.calls.filter(([u]) => String(u).endsWith(ABDM_PATHS.publicCert))
    expect(certCalls).toHaveLength(1)
    expect(certCalls[0][0]).toBe('https://abhasbx.example' + ABDM_PATHS.publicCert)
    const init = certCalls[0][1] as RequestInit & { headers: Record<string, string> }
    expect(init.headers.Authorization).toBe('Bearer GW'); expect(init.headers['REQUEST-ID']).toMatch(UUID)
  })
  it('refuses an unexpected encryption algorithm', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const fetch = routes({ publicKey: 'SPKI', encryptionAlgorithm: 'RSA/ECB/PKCS1Padding' })
    await expect(getAbhaPublicKey(CFG, { fetch, now: () => new Date() })).rejects.toThrow(/^ABDM HTTP 502$/)
    expect(JSON.stringify(info.mock.calls)).toContain('unexpected_algorithm')
  })
})
