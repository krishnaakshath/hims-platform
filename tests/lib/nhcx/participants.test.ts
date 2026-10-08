// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getRecipientCert, invalidateRecipientCert, CERT_CACHE_TTL_SECONDS, type CertCache, type ParticipantDeps } from '@/lib/nhcx/participants'
import { resetGatewayTokenCache } from '@/lib/abdm/session'
import type { AbdmConfig, NhcxConfig } from '@/lib/integrations/config'
import { hasOpenssl, makeTestKeyPairAndCert } from '../../helpers/selfsigned'

const OPENSSL = hasOpenssl()
const CERT = OPENSSL ? makeTestKeyPairAndCert('TPA1@sbx', 30) : null
const SHORT = OPENSSL ? makeTestKeyPairAndCert('TPA2@sbx', 1) : null
const ACFG: AbdmConfig = { gatewayBaseUrl: 'https://gw.example', abhaBaseUrl: 'https://abha.example', clientId: 'cid', clientSecret: 'csec', cmId: 'sbx', hipId: null, gatewayJwksUrl: null, consentTextPath: null }
const NCFG: NhcxConfig = {
  apiBaseUrl: 'https://hcx.example', participantServiceUrl: 'https://hcx.example/participant', participantCode: 'P1@sbx', encryptionPrivateKeyPem: 'K',
  previousEncryptionPrivateKeyPem: null, encryptionCertPem: 'C', gatewaySigningCertPem: null, callbackIpAllowlist: [], maxAttachmentBytes: 10_000_000,
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function memoryCache(): CertCache & { store: Map<string, { v: string; ttl: number }> } {
  const store = new Map<string, { v: string; ttl: number }>()
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k)?.v ?? null),
    set: vi.fn(async (k: string, v: string, ttl: number) => { store.set(k, { v, ttl }) }),
    del: vi.fn(async (k: string) => { store.delete(k) }),
  }
}
function participants(list: unknown[], certUrlBody?: string) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input)
    if (u.endsWith('/sessions')) return json(202, { accessToken: 'GW', expiresIn: 1200 })
    if (u.endsWith('/participant/search')) { void init; return json(200, { participants: list }) }
    if (u.startsWith('https://certs.example/')) return new Response(certUrlBody ?? '', { status: certUrlBody ? 200 : 404 })
    return json(404, {})
  })
}
const deps = (fetch: ReturnType<typeof participants>, cache: CertCache, now = new Date()): ParticipantDeps => ({ fetch, now: () => now, cache })

beforeEach(() => resetGatewayTokenCache())
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!OPENSSL)('getRecipientCert', () => {
  it('looks up an active participant cert and caches it for 24 h', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const cache = memoryCache()
    const fetch = participants([{ participant_code: 'TPA1@sbx', status: 'Active', encryption_cert: 'https://certs.example/tpa1.pem' }], CERT!.certPem)
    expect(await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(fetch, cache))).toEqual({ ok: true, certPem: CERT!.certPem.trim() })
    const search = fetch.mock.calls.find(([u]) => String(u).endsWith('/participant/search'))!
    expect(JSON.parse(String(search[1]!.body))).toEqual({ filters: { participant_code: { eq: 'TPA1@sbx' } } })
    expect((search[1]!.headers as Record<string, string>).bearer_auth).toBe('Bearer GW')
    expect(cache.store.get('nhcx:cert:TPA1@sbx')!.ttl).toBe(CERT_CACHE_TTL_SECONDS)
    fetch.mockClear()
    expect((await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(fetch, cache))).ok).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    await invalidateRecipientCert('TPA1@sbx', cache)
    expect(cache.store.has('nhcx:cert:TPA1@sbx')).toBe(false)
  })
  it('accepts an inline base64 PEM and refuses an http URL', async () => {
    const inline = participants([{ participant_code: 'TPA1@sbx', status: 'Active', encryption_cert: Buffer.from(CERT!.certPem).toString('base64') }])
    expect((await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(inline, memoryCache()))).ok).toBe(true)
    const http = participants([{ participant_code: 'TPA1@sbx', status: 'Active', encryption_cert: 'http://certs.example/tpa1.pem' }])
    expect(await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(http, memoryCache()))).toEqual({ ok: false, error: 'cert_unavailable' })
  })
  it('an inactive or unknown participant is refused', async () => {
    expect(await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(participants([]), memoryCache()))).toEqual({ ok: false, error: 'participant_not_found' })
    const inactive = participants([{ participant_code: 'TPA1@sbx', status: 'Inactive', encryption_cert: CERT!.certPem }])
    expect(await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(inactive, memoryCache()))).toEqual({ ok: false, error: 'participant_inactive' })
  })
  it('an expired recipient cert is unavailable, and an expired cached one is looked up again', async () => {
    const later = new Date(Date.now() + 3 * 86_400_000)
    const fetch = participants([{ participant_code: 'TPA2@sbx', status: 'Active', encryption_cert: SHORT!.certPem }])
    expect(await getRecipientCert(NCFG, ACFG, 'TPA2@sbx', deps(fetch, memoryCache(), later))).toEqual({ ok: false, error: 'cert_unavailable' })
    const cache = memoryCache()
    cache.store.set('nhcx:cert:TPA2@sbx', { v: SHORT!.certPem, ttl: 1 })
    expect(await getRecipientCert(NCFG, ACFG, 'TPA2@sbx', deps(fetch, cache, later))).toEqual({ ok: false, error: 'cert_unavailable' })
    expect(fetch.mock.calls.some(([u]) => String(u).endsWith('/participant/search'))).toBe(true)
  })
  it('a participant service outage is cert_unavailable', async () => {
    const down = vi.fn(async (input: string | URL | Request) => (String(input).endsWith('/sessions') ? json(202, { accessToken: 'GW', expiresIn: 1200 }) : json(503, {})))
    expect(await getRecipientCert(NCFG, ACFG, 'TPA1@sbx', deps(down as never, memoryCache()))).toEqual({ ok: false, error: 'cert_unavailable' })
  })
})
