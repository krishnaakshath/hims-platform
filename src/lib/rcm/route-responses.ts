// SP7: server-only response helpers for the /api/rcm routes. The role gate is NOT here: every
// handler checks its allowlist inline, right after requireSession(), before any body read.
import { NextResponse } from 'next/server'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { serviceErrorResponse } from '@/lib/service-config'
import { RCM_ERROR_MESSAGE, RCM_ERROR_STATUS, type RcmWriteResult } from './errors'
import { RCM_UPLOAD_MAX_BYTES, RCM_UPLOAD_TYPES } from './constants'

export { readJsonBody, parseId } from '@/lib/http'
export { invalid } from '@/lib/tariff/route-responses'

export function rcmError(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** Maps a refused RcmWriteResult to its status and catalogue message (or the computed message). */
export function rcmErrorResponse(r: Extract<RcmWriteResult<unknown>, { ok: false }>): NextResponse {
  const body: { error: string; items?: unknown[] } = { error: r.message ?? RCM_ERROR_MESSAGE[r.error] }
  if (r.items) body.items = r.items
  return NextResponse.json(body, { status: RCM_ERROR_STATUS[r.error] })
}

/**
 * A thrown error: a missing blob store or unreachable database is a 503 (one [config] log
 * line); a deadlock or serialization failure (nothing was written) is a 409 asking to try
 * again; anything else a generic 500. Logs only the pg code and constraint, never the message or input.
 */
export function rcmServerError(tag: string, err: unknown, message: string) {
  const unavailable = serviceErrorResponse(err, tag)
  if (unavailable) return unavailable
  if (isRetryableConflict(err)) return rcmError(409, RETRY_MESSAGE)
  console.error(`[rcm] ${tag} failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
  return rcmError(500, message)
}

export const MULTIPART_MESSAGE = 'Send the file as multipart form data'

/**
 * The uploaded `file` plus every other string field, or a 400. Called only after the role gate.
 * The file must be a PDF, JPEG or PNG of at most RCM_UPLOAD_MAX_BYTES (ruling 15).
 */
export async function readUpload(request: Request): Promise<{ ok: true; file: File; fields: Record<string, string> } | { ok: false; response: NextResponse }> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return { ok: false, response: rcmError(400, MULTIPART_MESSAGE) }
  }
  const file = form.get('file')
  if (!(file instanceof File) || !(RCM_UPLOAD_TYPES as readonly string[]).includes(file.type) || file.size === 0 || file.size > RCM_UPLOAD_MAX_BYTES) {
    return { ok: false, response: rcmError(400, RCM_ERROR_MESSAGE.upload_invalid) }
  }
  const fields: Record<string, string> = {}
  for (const [k, v] of form.entries()) if (k !== 'file' && typeof v === 'string') fields[k] = v
  return { ok: true, file, fields }
}
