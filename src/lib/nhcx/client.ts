import type { AbdmConfig, NhcxConfig } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { AbdmHttpError, abdmHeaders, getGatewayToken, invalidateGatewayToken, timeoutSignal } from '@/lib/abdm/session'
import { NHCX_ACTIONS, NHCX_API_VERSION_PREFIX, NHCX_TOKEN_HEADER, type NhcxAction } from './constants'
import { envelope } from './jwe'

// The NHCX HTTP client: one sealed POST per attempt. Authentication is the
// ABDM gateway session token in the `bearer_auth` header (S3, UNVERIFIED U1
// and U3), plus the ABDM standard headers. The request body is the S4 JWE
// envelope. A retry (by the outbox, Task 11) resends the same stored JWE, so
// the same api_call_id and correlation id reach NHCX (ruling 5; whether NHCX
// dedupes is UNVERIFIED U11). Response bodies are read only for the S4
// SuccessResponse ids and a sanitised error code; nothing else is kept or
// logged.

export interface NhcxDeps {
  fetch: typeof fetch
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export const defaultNhcxDeps = (): NhcxDeps => ({
  fetch: globalThis.fetch.bind(globalThis),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
})

export const NHCX_TIMEOUT_MS = 30_000

export type PostOutcome =
  | { kind: 'accepted'; httpStatus: number; apiCallId: string; correlationId: string }
  | { kind: 'rejected'; httpStatus: number; errorCode: string | null }
  | { kind: 'retryable'; httpStatus: number | null; errorCode: string | null }

const ERROR_CODE = /^[A-Z][A-Z0-9_-]{2,40}$/
const REJECTED = new Set([400, 401, 403, 404, 409, 422])

/** The error code from an S4 ErrorResponse (`{ error: { code } }`) or an NHCX body (`{ code }`), only if it looks like a code. */
export function sanitisedErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { error?: unknown; code?: unknown }
  const candidates = [b.error && typeof b.error === 'object' ? (b.error as { code?: unknown }).code : undefined, b.code]
  for (const c of candidates) if (typeof c === 'string' && ERROR_CODE.test(c)) return c
  return null
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** One send of a sealed message. A 401 refreshes the gateway token and retries once, within this attempt. */
export async function postSealed(cfg: NhcxConfig, abdm: AbdmConfig, action: NhcxAction, compactJwe: string, deps: NhcxDeps = defaultNhcxDeps()): Promise<PostOutcome> {
  const url = `${cfg.apiBaseUrl}${NHCX_API_VERSION_PREFIX}/${NHCX_ACTIONS[action].path}`
  const started = Date.now()
  const log = (o: PostOutcome) => {
    safeLog('nhcx', { action, outcome: o.kind, httpStatus: o.httpStatus ?? undefined, errorCode: 'errorCode' in o ? (o.errorCode ?? undefined) : undefined, durationMs: Date.now() - started })
    return o
  }

  for (let round = 0; round < 2; round++) {
    let token: string
    try {
      token = await getGatewayToken(abdm, { fetch: deps.fetch, now: deps.now })
    } catch (e) {
      const status = e instanceof AbdmHttpError ? e.status : null
      // Our own credentials refused: resending will not help.
      if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return log({ kind: 'rejected', httpStatus: status, errorCode: 'GATEWAY_AUTH' })
      return log({ kind: 'retryable', httpStatus: status, errorCode: 'GATEWAY_SESSION' })
    }

    let res: Response
    try {
      const std = abdmHeaders({ 'X-CM-ID': abdm.cmId }, deps.now())
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { ...std, 'Content-Type': 'application/json', [NHCX_TOKEN_HEADER]: `Bearer ${token}` },
        body: JSON.stringify(envelope(compactJwe)),
        signal: timeoutSignal(NHCX_TIMEOUT_MS),
      })
    } catch {
      return log({ kind: 'retryable', httpStatus: null, errorCode: null })
    }

    if (res.status === 401 && round === 0) {
      invalidateGatewayToken(abdm)
      continue
    }
    const body = await readJson(res)
    if (res.status >= 200 && res.status < 300) {
      const b = (body ?? {}) as { api_call_id?: unknown; correlation_id?: unknown }
      return log({
        kind: 'accepted', httpStatus: res.status,
        apiCallId: typeof b.api_call_id === 'string' ? b.api_call_id : '',
        correlationId: typeof b.correlation_id === 'string' ? b.correlation_id : '',
      })
    }
    if (REJECTED.has(res.status)) return log({ kind: 'rejected', httpStatus: res.status, errorCode: sanitisedErrorCode(body) })
    return log({ kind: 'retryable', httpStatus: res.status, errorCode: sanitisedErrorCode(body) })
  }
  return log({ kind: 'rejected', httpStatus: 401, errorCode: null })
}

/** Outbox backoff: 1 min, 5 min, 15 min, 1 h, 6 h, then give up. */
export const RETRY_SCHEDULE_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const
export const MAX_SEND_ATTEMPTS = 5

/** When attempt `attempts + 1` may run, with up to 20% jitter; null once the attempts are used up. */
export function nextAttemptAt(attempts: number, now: Date, jitter: () => number = Math.random): Date | null {
  if (attempts < 1 || attempts > MAX_SEND_ATTEMPTS) return null
  const base = RETRY_SCHEDULE_MS[attempts - 1]
  return new Date(now.getTime() + Math.round(base * (1 + jitter() * 0.2)))
}
