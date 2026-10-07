// Server-side request parsing shared by every API route. The role gate is NOT
// here: each route still runs requireSession() and its allowlist inline, and
// only then calls these helpers, so a forbidden caller never learns whether its
// body or id would have parsed.
import { NextResponse } from 'next/server'

export const INVALID_JSON_MESSAGE = 'Invalid JSON'
export const INVALID_ID_MESSAGE = 'Invalid id'

/** Largest value a Postgres int4 / serial column can hold. */
export const INT4_MAX = 2_147_483_647

export type JsonBodyResult = { ok: true; body: unknown } | { ok: false; response: NextResponse }

/**
 * The request body as JSON, or a fixed 400 `{ error: 'Invalid JSON' }` for a
 * body that is empty or not JSON -- never a 500, and never an echo of the
 * input. A route whose body is optional passes `emptyAs` (e.g. `{}`) to accept
 * an empty body as that value; malformed JSON is still a 400.
 */
export async function readJsonBody(request: Request, options?: { emptyAs?: unknown }): Promise<JsonBodyResult> {
  let text: string
  try {
    text = await request.text()
  } catch {
    return { ok: false, response: invalidJsonResponse() }
  }
  if (text.trim() === '') {
    if (options && 'emptyAs' in options) return { ok: true, body: options.emptyAs }
    return { ok: false, response: invalidJsonResponse() }
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: invalidJsonResponse() }
  }
}

export function invalidJsonResponse() {
  return NextResponse.json({ error: INVALID_JSON_MESSAGE }, { status: 400 })
}

/**
 * A positive int4 path id written as plain digits ('1'..'2147483647'), or
 * null. Rejects signs, decimals, exponents, hex, whitespace and anything past
 * the int4 range, so a stray id can never reach Postgres as NaN or overflow.
 */
export function parseId(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d{1,10}$/.test(raw)) return null
  const id = Number(raw)
  return id > 0 && id <= INT4_MAX ? id : null
}

export function invalidIdResponse() {
  return NextResponse.json({ error: INVALID_ID_MESSAGE }, { status: 400 })
}
