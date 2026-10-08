import { NextResponse } from 'next/server'

// The backing services a request can depend on, and what a route answers when
// one is missing or unreachable: a generic 503 for the client, and ONE log
// line for the operator naming exactly what is wrong. No env var value, no
// error text (it can carry the connection string or user name) is ever logged
// or returned; only the service, the error code and the feature affected.
//
// Rate limiting stays fail-closed: without Redis, login and the other
// limited routes are unavailable. There is deliberately no in-memory fallback
// (it would reset per serverless instance and stop protecting anything).

export type Service = 'database' | 'redis' | 'blob'

export const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable'

const SERVICE_LABEL: Record<Service, string> = { database: 'DATABASE_URL', redis: 'REDIS', blob: 'BLOB_READ_WRITE_TOKEN' }

export class ServiceNotConfiguredError extends Error {
  constructor(public service: Service) {
    super(`${SERVICE_LABEL[service]} is not configured`)
    this.name = 'ServiceNotConfiguredError'
  }
}

// Driver-level codes that mean "cannot reach / log in to the database at all"
// (as opposed to a bad query): network, DNS, TLS-less refusal, auth, missing
// database, server starting up or out of connections.
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  '28P01', '28000', '3D000', '57P03', '53300', '08001', '08006',
])

/** The driver error code when `e` (or a cause it wraps) means the database is unreachable. */
export function databaseUnavailableCode(e: unknown): string | null {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const err = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof err.code === 'string' && DB_UNAVAILABLE_CODES.has(err.code)) return err.code
    if (typeof err.message === 'string' && /timeout exceeded when trying to connect|Connection terminated due to connection timeout/.test(err.message)) {
      return 'CONNECT_TIMEOUT'
    }
    cur = err.cause
  }
  return null
}

/**
 * The private file store (Vercel Blob): a read-write token, or a store id for
 * OIDC auth on Vercel. Without either, every stored-file read and write fails.
 */
export function isBlobConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BLOB_READ_WRITE_TOKEN ?? '').trim() !== '' || (env.BLOB_STORE_ID ?? '').trim() !== ''
}

/** Throws ServiceNotConfiguredError('blob') before any stored-file read or write when there is no store. */
export function requireBlobStore(): void {
  if (!isBlobConfigured()) throw new ServiceNotConfiguredError('blob')
}

export function serviceUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: SERVICE_UNAVAILABLE_MESSAGE }, { status: 503, headers: { 'Retry-After': '30' } })
}

/**
 * Wraps a route handler so a missing or unreachable database/Redis/blob store answers
 * 503 instead of an unhandled 500. `feature` names what is unavailable in the
 * log line ("login", "patient login", ...). Every other error is rethrown.
 */
export function withServiceGuard<A extends unknown[], R extends Response>(
  feature: string,
  handler: (...args: A) => Promise<R>,
): (...args: A) => Promise<R | NextResponse> {
  return async (...args: A) => {
    try {
      return await handler(...args)
    } catch (e) {
      const unavailable = serviceErrorResponse(e, feature)
      if (unavailable) return unavailable
      throw e
    }
  }
}

/**
 * The 503 (after its one [config] log line) when `e` means a backing service is
 * missing or unreachable, else null. For routes that already catch every error
 * into their own 500 (the lab and RCM routes): call this first.
 */
export function serviceErrorResponse(e: unknown, feature: string): NextResponse | null {
  if (e instanceof ServiceNotConfiguredError) {
    console.error(`[config] ${SERVICE_LABEL[e.service]} not configured: ${feature} is unavailable`)
    return serviceUnavailableResponse()
  }
  const code = databaseUnavailableCode(e)
  if (code) {
    console.error(`[config] database unreachable (${code}): ${feature} is unavailable`)
    return serviceUnavailableResponse()
  }
  return null
}
