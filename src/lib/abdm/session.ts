import { randomUUID } from 'node:crypto'
import type { AbdmConfig } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { ABDM_ERROR_COPY, ABDM_PATHS, ABHA_ENCRYPTION_ALGORITHM } from './constants'

// ABDM gateway session (S1 hiecm-gateway.yaml POST /api/hiecm/gateway/v3/sessions)
// and the standard headers every ABDM call carries. The session token is
// shared with NHCX (UNVERIFIED U3). Errors carry only an HTTP status, never a
// response body, a credential or a cause.

export interface SessionDeps {
  fetch: typeof fetch
  now: () => Date
}

export const defaultSessionDeps = (): SessionDeps => ({ fetch: globalThis.fetch.bind(globalThis), now: () => new Date() })

export const ABDM_TIMEOUT_MS = 15_000

/**
 * An AbortSignal that fires after `ms`. A plain timer (not AbortSignal.timeout)
 * so tests can drive it with fake timers; unref'd so it never holds the
 * process open.
 */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('The operation timed out', 'TimeoutError')), ms)
  ;(timer as { unref?: () => void }).unref?.()
  return controller.signal
}

export class AbdmHttpError extends Error {
  readonly status: number | null
  constructor(status: number | null) {
    super(`ABDM HTTP ${status ?? 'unreachable'}`)
    this.name = 'AbdmHttpError'
    this.status = status
  }
}

export function abdmHeaders(extra: Record<string, string> = {}, now: Date = new Date()): Record<string, string> {
  return { 'REQUEST-ID': randomUUID(), TIMESTAMP: now.toISOString(), 'Content-Type': 'application/json', ...extra }
}

/**
 * The fixed failure for an ABDM HTTP status. ABDM bodies are never read into
 * a message. A 401 is a wrong OTP only on an OTP verification step.
 */
export function mapAbdmFailure(status: number | null, opts: { otpStep?: boolean } = {}): keyof typeof ABDM_ERROR_COPY {
  if (status === 400 || status === 422) return 'invalid_input'
  if (status === 401) return opts.otpStep ? 'otp_invalid' : 'abdm_unavailable'
  if (status === 429) return 'rate_limited'
  return 'abdm_unavailable'
}

type CachedToken = { token: string; refreshAt: number }
const tokenCache = new Map<string, CachedToken>()
const tokenInFlight = new Map<string, Promise<string>>()
type CachedKey = { publicKey: string; expiresAt: number }
const publicKeyCache = new Map<string, CachedKey>()

const PUBLIC_KEY_TTL_MS = 6 * 60 * 60 * 1000
const TOKEN_REFRESH_MARGIN_S = 60

/** Tests only: forget cached tokens and public keys. */
export function resetGatewayTokenCache(): void {
  tokenCache.clear()
  tokenInFlight.clear()
  publicKeyCache.clear()
}

/** Drops the cached token for this client (e.g. after a 401 from NHCX). */
export function invalidateGatewayToken(cfg: AbdmConfig): void {
  tokenCache.delete(tokenKey(cfg))
}

const tokenKey = (cfg: AbdmConfig) => `${cfg.gatewayBaseUrl}|${cfg.clientId}`

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

async function fetchToken(cfg: AbdmConfig, deps: SessionDeps): Promise<{ token: string; expiresIn: number }> {
  let res: Response
  try {
    res = await deps.fetch(`${cfg.gatewayBaseUrl}${ABDM_PATHS.session}`, {
      method: 'POST',
      headers: abdmHeaders({ 'X-CM-ID': cfg.cmId }, deps.now()),
      body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, grantType: 'client_credentials' }),
      signal: timeoutSignal(ABDM_TIMEOUT_MS),
    })
  } catch {
    throw new AbdmHttpError(null)
  }
  if (res.status !== 200 && res.status !== 202) throw new AbdmHttpError(res.status)
  const body = (await readJson(res)) as { accessToken?: unknown; expiresIn?: unknown } | null
  const token = body?.accessToken
  const expiresIn = Number(body?.expiresIn)
  if (typeof token !== 'string' || token.length === 0 || !Number.isFinite(expiresIn) || expiresIn <= 0) throw new AbdmHttpError(502)
  const refreshInS = Math.max(expiresIn - TOKEN_REFRESH_MARGIN_S, 0)
  tokenCache.set(tokenKey(cfg), { token, refreshAt: deps.now().getTime() + refreshInS * 1000 })
  return { token, expiresIn }
}

/** The gateway access token, cached until 60 s before expiry; concurrent callers share one fetch. */
export async function getGatewayToken(cfg: AbdmConfig, deps: SessionDeps = defaultSessionDeps()): Promise<string> {
  const key = tokenKey(cfg)
  const cached = tokenCache.get(key)
  if (cached && deps.now().getTime() < cached.refreshAt) return cached.token
  const pending = tokenInFlight.get(key)
  if (pending) return pending
  const p = fetchToken(cfg, deps).then((t) => t.token).finally(() => tokenInFlight.delete(key))
  tokenInFlight.set(key, p)
  return p
}

/** Test connection: drops the cached token, fetches a new one and reports its life in seconds. */
export async function refreshGatewayToken(cfg: AbdmConfig, deps: SessionDeps = defaultSessionDeps()): Promise<{ expiresIn: number }> {
  invalidateGatewayToken(cfg)
  const { expiresIn } = await fetchToken(cfg, deps)
  return { expiresIn }
}

/** The ABHA public key (base64 SPKI) used to encrypt national ID numbers, OTPs and login ids. Cached 6 h. */
export async function getAbhaPublicKey(cfg: AbdmConfig, deps: SessionDeps = defaultSessionDeps()): Promise<string> {
  const cached = publicKeyCache.get(cfg.abhaBaseUrl)
  if (cached && deps.now().getTime() < cached.expiresAt) return cached.publicKey
  const token = await getGatewayToken(cfg, deps)
  let res: Response
  try {
    res = await deps.fetch(`${cfg.abhaBaseUrl}${ABDM_PATHS.publicCert}`, {
      method: 'GET',
      headers: abdmHeaders({ Authorization: `Bearer ${token}` }, deps.now()),
      signal: timeoutSignal(ABDM_TIMEOUT_MS),
    })
  } catch {
    throw new AbdmHttpError(null)
  }
  if (!res.ok) throw new AbdmHttpError(res.status)
  const body = (await readJson(res)) as { publicKey?: unknown; encryptionAlgorithm?: unknown } | null
  if (body?.encryptionAlgorithm !== ABHA_ENCRYPTION_ALGORITHM) {
    safeLog('abdm', { action: 'public_certificate', errorCode: 'unexpected_algorithm' })
    throw new AbdmHttpError(502)
  }
  if (typeof body.publicKey !== 'string' || body.publicKey.length === 0) throw new AbdmHttpError(502)
  publicKeyCache.set(cfg.abhaBaseUrl, { publicKey: body.publicKey, expiresAt: deps.now().getTime() + PUBLIC_KEY_TTL_MS })
  return body.publicKey
}
