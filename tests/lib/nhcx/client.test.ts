import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MAX_SEND_ATTEMPTS, nextAttemptAt, postSealed, RETRY_SCHEDULE_MS, sanitisedErrorCode, type NhcxDeps } from '@/lib/nhcx/client'
import { resetGatewayTokenCache } from '@/lib/abdm/session'
import type { AbdmConfig, NhcxConfig } from '@/lib/integrations/config'

const A = '0b6c7c5e-6d3f-4d4c-9a51-2f7d4f0d9f11'
const C = '6d8f9a3e-1b2c-4d5e-8f90-123456789abc'
const ACFG: AbdmConfig = { gatewayBaseUrl: 'https://gw.example', abhaBaseUrl: 'https://abha.example', clientId: 'cid', clientSecret: 'csec', cmId: 'sbx', hipId: null, gatewayJwksUrl: null, consentTextPath: null }
const NCFG: NhcxConfig = {
  apiBaseUrl: 'https://hcx.example', participantServiceUrl: 'https://hcx.example/participant', participantCode: 'P1@sbx', encryptionPrivateKeyPem: 'K',
  previousEncryptionPrivateKeyPem: null, encryptionCertPem: 'C', gatewaySigningCertPem: null, callbackIpAllowlist: [], maxAttachmentBytes: 10_000_000,
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let tokens = 0
function fakeFetch(...responses: (Response | Error)[]) {
  const queue = [...responses]
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/api/hiecm/gateway/v3/sessions')) { tokens++; return json(202, { accessToken: tokens === 1 ? 'GW' : `GW${tokens}`, expiresIn: 1200 }) }
    void init
    const next = queue.shift() ?? json(500, {})
    if (next instanceof Error) throw next
    return next
  })
}
const deps = (fetch: ReturnType<typeof fakeFetch>): NhcxDeps => ({ fetch, now: () => new Date('2026-10-08T00:00:00Z'), sleep: async () => {} })
const sendCalls = (fetch: ReturnType<typeof fakeFetch>) => fetch.mock.calls.filter(([u]) => !String(u).endsWith('/sessions'))

let info: ReturnType<typeof vi.spyOn>
beforeEach(() => { resetGatewayTokenCache(); tokens = 0; info = vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())

describe('postSealed', () => {
  it('posts the JWE envelope with the token header and parses the 202', async () => {
    const fetch = fakeFetch(json(202, { timestamp: 't', api_call_id: A, correlation_id: C }))
    expect(await postSealed(NCFG, ACFG, 'claim/submit', 'a.b.c.d.e', deps(fetch))).toEqual({ kind: 'accepted', httpStatus: 202, apiCallId: A, correlationId: C })
    const [url, init] = sendCalls(fetch).at(-1)!
    expect(url).toBe('https://hcx.example/v1/claim/submit'); expect(JSON.parse(String(init!.body))).toEqual({ payload: 'a.b.c.d.e' })
    const headers = init!.headers as Record<string, string>
    expect(headers.bearer_auth).toBe('Bearer GW'); expect(headers['X-CM-ID']).toBe('sbx'); expect(headers['REQUEST-ID']).toMatch(/^[0-9a-f-]{36}$/)
    expect(init!.method).toBe('POST'); expect(init!.signal).toBeInstanceOf(AbortSignal)
  })
  it('classifies 4xx as rejected with a sanitised code and 5xx/timeouts as retryable', async () => {
    expect(await postSealed(NCFG, ACFG, 'claim/submit', 'x', deps(fakeFetch(json(400, { error: { code: 'ERR_INVALID_PAYLOAD', message: 'patient 234123412346' } })))))
      .toEqual({ kind: 'rejected', httpStatus: 400, errorCode: 'ERR_INVALID_PAYLOAD' })
    expect(await postSealed(NCFG, ACFG, 'claim/submit', 'x', deps(fakeFetch(json(422, { error: { code: 'bad code with spaces' } })))))
      .toEqual({ kind: 'rejected', httpStatus: 422, errorCode: null })
    expect((await postSealed(NCFG, ACFG, 'claim/submit', 'x', deps(fakeFetch(json(503, {}))))).kind).toBe('retryable')
    expect((await postSealed(NCFG, ACFG, 'claim/submit', 'x', deps(fakeFetch(json(429, {}))))).kind).toBe('retryable')
    expect(await postSealed(NCFG, ACFG, 'claim/submit', 'x', deps(fakeFetch(new TypeError('fetch failed'))))).toEqual({ kind: 'retryable', httpStatus: null, errorCode: null })
    expect(JSON.stringify(info.mock.calls)).not.toContain('234123412346')
  })
  it('a 401 refreshes the gateway token once', async () => {
    const fetch = fakeFetch(json(401, {}), json(202, { api_call_id: A, correlation_id: C }))
    expect((await postSealed(NCFG, ACFG, 'preauth/submit', 'x', deps(fetch))).kind).toBe('accepted')
    const calls = sendCalls(fetch)
    expect(calls).toHaveLength(2)
    expect((calls[0][1]!.headers as Record<string, string>).bearer_auth).toBe('Bearer GW')
    expect((calls[1][1]!.headers as Record<string, string>).bearer_auth).toBe('Bearer GW2')
    resetGatewayTokenCache(); tokens = 0
    const again = fakeFetch(json(401, {}), json(401, {}))
    expect(await postSealed(NCFG, ACFG, 'preauth/submit', 'x', deps(again))).toEqual({ kind: 'rejected', httpStatus: 401, errorCode: null })
    expect(sendCalls(again)).toHaveLength(2)
  })
  it('a gateway session refusal is rejected; an outage is retryable', async () => {
    const refused = vi.fn(async () => json(401, {}))
    expect(await postSealed(NCFG, ACFG, 'claim/submit', 'x', { fetch: refused, now: () => new Date(), sleep: async () => {} })).toEqual({ kind: 'rejected', httpStatus: 401, errorCode: 'GATEWAY_AUTH' })
    resetGatewayTokenCache()
    const down = vi.fn(async () => json(502, {}))
    expect((await postSealed(NCFG, ACFG, 'claim/submit', 'x', { fetch: down, now: () => new Date(), sleep: async () => {} })).kind).toBe('retryable')
  })
})

describe('sanitisedErrorCode', () => {
  it('keeps only code-shaped values', () => {
    expect(sanitisedErrorCode({ error: { code: 'PAYR-1001' } })).toBe('PAYR-1001')
    expect(sanitisedErrorCode({ code: 'NHCX-1004' })).toBe('NHCX-1004')
    expect(sanitisedErrorCode({ error: { code: '<script>' } })).toBeNull()
    expect(sanitisedErrorCode('x')).toBeNull()
  })
})

describe('nextAttemptAt', () => {
  it('backs off 1 m, 5 m, 15 m, 1 h, 6 h then gives up', () => {
    const now = new Date(0)
    expect(nextAttemptAt(1, now, () => 0)!.getTime()).toBe(60_000); expect(nextAttemptAt(5, now, () => 0)!.getTime()).toBe(21_600_000); expect(nextAttemptAt(6, now, () => 0)).toBeNull()
    expect(RETRY_SCHEDULE_MS.map((_, i) => nextAttemptAt(i + 1, now, () => 0)!.getTime())).toEqual([60_000, 300_000, 900_000, 3_600_000, 21_600_000])
    expect(MAX_SEND_ATTEMPTS).toBe(5)
  })
  it('adds at most 20% jitter', () => {
    expect(nextAttemptAt(2, new Date(0), () => 1)!.getTime()).toBe(360_000)
  })
})
