// Browser-side fetch helpers shared by every mutating client component, so a
// failed request is always surfaced to the user (never swallowed) with a
// human message, and server internals are never shown.
//
// Message policy: for 400/404/409/422 the route's own `error` string is shown
// when present (routes author these texts and never echo input -- e.g. "That
// slot is already booked"); otherwise, and always for 401/403/429/5xx and
// network failures, a fixed message from CLIENT_ERROR_MESSAGES is used.

export const CLIENT_ERROR_MESSAGES = {
  badRequest: 'Some details are missing or invalid. Please check and try again.',
  unauthorized: 'Your session has expired. Please sign in again.',
  forbidden: 'You do not have permission to do that.',
  notFound: 'That record could not be found. It may have been removed.',
  conflict: 'This was changed by someone else at the same time. Please refresh and try again.',
  tooMany: 'Too many attempts. Please wait a moment and try again.',
  server: 'Something went wrong on our side. Please try again.',
  network: 'Could not reach the server. Check your connection and try again.',
} as const

export type FetchResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string }

const PASS_THROUGH = new Set([400, 404, 409, 422])
const MAX_MESSAGE_LENGTH = 200

/** The fixed message for an HTTP status (0 = the request never reached the server). */
export function messageForStatus(status: number): string {
  if (status === 0) return CLIENT_ERROR_MESSAGES.network
  if (status === 401) return CLIENT_ERROR_MESSAGES.unauthorized
  if (status === 403) return CLIENT_ERROR_MESSAGES.forbidden
  if (status === 404) return CLIENT_ERROR_MESSAGES.notFound
  if (status === 409) return CLIENT_ERROR_MESSAGES.conflict
  if (status === 429) return CLIENT_ERROR_MESSAGES.tooMany
  if (status >= 500) return CLIENT_ERROR_MESSAGES.server
  return CLIENT_ERROR_MESSAGES.badRequest
}

function authoredMessage(status: number, data: unknown): string | null {
  if (!PASS_THROUGH.has(status) || !data || typeof data !== 'object') return null
  const error = (data as { error?: unknown }).error
  if (typeof error !== 'string') return null
  const trimmed = error.trim()
  return trimmed && trimmed.length <= MAX_MESSAGE_LENGTH ? trimmed : null
}

async function parseBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text()
    return text ? (JSON.parse(text) as unknown) : null
  } catch {
    return null
  }
}

/** The human message for a failed (non-2xx) Response. Consumes the body. */
export async function readError(res: Response): Promise<string> {
  return authoredMessage(res.status, await parseBody(res)) ?? messageForStatus(res.status)
}

/**
 * fetch() that never throws: `{ ok: true, data }` for a 2xx (data is the parsed
 * JSON body, or null when empty), otherwise `{ ok: false, error }` with a
 * human message. Network failures come back as status 0.
 */
export async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<FetchResult<T>> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    return { ok: false, status: 0, error: CLIENT_ERROR_MESSAGES.network }
  }
  const data = await parseBody(res)
  if (res.ok) return { ok: true, status: res.status, data: data as T }
  return { ok: false, status: res.status, error: authoredMessage(res.status, data) ?? messageForStatus(res.status) }
}

/** A JSON mutation (body omitted when undefined). See fetchJson. */
export function sendJson<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<FetchResult<T>> {
  return fetchJson<T>(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
