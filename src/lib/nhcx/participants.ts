import type { AbdmConfig, NhcxConfig } from '@/lib/integrations/config'
import { certificateSummary } from '@/lib/integrations/certs'
import { safeLog } from '@/lib/integrations/safe-log'
import { getRedis } from '@/lib/cache'
import { abdmHeaders, getGatewayToken, timeoutSignal } from '@/lib/abdm/session'
import { NHCX_TOKEN_HEADER } from './constants'

// Recipient encryption certificates from the NHCX participant service.
// Request body is the HCX registry shape (S4 openapi_hcx_registry.yml); that
// the same filter works on the NHCX participant service (S2 lists
// /participant/search) is UNVERIFIED U10. A certificate is cached for 24 h
// per participant code (S3) and dropped when the recipient reports an
// encryption error. Only an active participant with an unexpired certificate
// is usable.

export type CertError = 'participant_not_found' | 'participant_inactive' | 'cert_unavailable'
export type CertResult = { ok: true; certPem: string } | { ok: false; error: CertError }

export interface CertCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
  del(key: string): Promise<void>
}

/** Redis-backed; without Redis there is simply no cache. */
export const redisCertCache: CertCache = {
  async get(key) {
    try {
      const v = await getRedis().get<string>(key)
      return typeof v === 'string' ? v : null
    } catch {
      return null
    }
  },
  async set(key, value, ttlSeconds) {
    try {
      await getRedis().set(key, value, { ex: ttlSeconds })
    } catch {
      // No cache available; the next send looks the certificate up again.
    }
  },
  async del(key) {
    try {
      await getRedis().del(key)
    } catch {
      // Nothing cached.
    }
  },
}

export interface ParticipantDeps {
  fetch: typeof fetch
  now: () => Date
  cache: CertCache
}

const defaultDeps = (): ParticipantDeps => ({ fetch: globalThis.fetch.bind(globalThis), now: () => new Date(), cache: redisCertCache })
export const CERT_CACHE_TTL_SECONDS = 24 * 60 * 60
const TIMEOUT_MS = 15_000
const cacheKey = (code: string) => `nhcx:cert:${code}`

/** Error codes on which the recipient's certificate is looked up again (S4 / S3). */
export const CERT_REFRESH_ERROR_CODES = ['ERR_INVALID_ENCRYPTION', 'PAYR-1001'] as const

function usable(pem: string, now: Date): boolean {
  try {
    return !certificateSummary(pem, now).expired
  } catch {
    return false
  }
}

async function resolveCertValue(value: unknown, deps: ParticipantDeps): Promise<string | null> {
  if (typeof value !== 'string' || value.length === 0) return null
  const v = value.trim()
  if (v.startsWith('https://')) {
    try {
      const res = await deps.fetch(v, { method: 'GET', signal: timeoutSignal(TIMEOUT_MS) })
      if (!res.ok) return null
      const text = (await res.text()).trim()
      return text.includes('-----BEGIN CERTIFICATE-----') ? text : null
    } catch {
      return null
    }
  }
  if (/^[a-z]+:\/\//i.test(v)) return null // http:// and anything else: refused
  if (v.includes('-----BEGIN CERTIFICATE-----')) return v
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8')
    return decoded.includes('-----BEGIN CERTIFICATE-----') ? decoded : null
  } catch {
    return null
  }
}

export async function getRecipientCert(cfg: NhcxConfig, abdm: AbdmConfig, participantCode: string, deps: ParticipantDeps = defaultDeps()): Promise<CertResult> {
  const cached = await deps.cache.get(cacheKey(participantCode))
  if (cached && usable(cached, deps.now())) return { ok: true, certPem: cached }

  let body: unknown
  try {
    const token = await getGatewayToken(abdm, { fetch: deps.fetch, now: deps.now })
    const res = await deps.fetch(`${cfg.participantServiceUrl}/participant/search`, {
      method: 'POST',
      headers: { ...abdmHeaders({ 'X-CM-ID': abdm.cmId }, deps.now()), [NHCX_TOKEN_HEADER]: `Bearer ${token}` },
      body: JSON.stringify({ filters: { participant_code: { eq: participantCode } } }),
      signal: timeoutSignal(TIMEOUT_MS),
    })
    safeLog('nhcx', { action: 'participant_search', httpStatus: res.status })
    if (!res.ok) return { ok: false, error: 'cert_unavailable' }
    body = await res.json()
  } catch {
    safeLog('nhcx', { action: 'participant_search', outcome: 'unreachable' })
    return { ok: false, error: 'cert_unavailable' }
  }

  const list = body && typeof body === 'object' && Array.isArray((body as { participants?: unknown }).participants)
    ? ((body as { participants: unknown[] }).participants)
    : []
  const p = list.find((x) => x && typeof x === 'object' && (x as { participant_code?: unknown }).participant_code === participantCode) as Record<string, unknown> | undefined
  if (!p) return { ok: false, error: 'participant_not_found' }
  if (p.status !== 'Active') return { ok: false, error: 'participant_inactive' }
  const pem = await resolveCertValue(p.encryption_cert, deps)
  if (!pem || !usable(pem, deps.now())) return { ok: false, error: 'cert_unavailable' }
  await deps.cache.set(cacheKey(participantCode), pem, CERT_CACHE_TTL_SECONDS)
  return { ok: true, certPem: pem }
}

export async function invalidateRecipientCert(participantCode: string, cache: CertCache = redisCertCache): Promise<void> {
  await cache.del(cacheKey(participantCode))
}
