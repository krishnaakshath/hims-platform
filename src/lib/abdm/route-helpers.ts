import { NextResponse } from 'next/server'
import type { Session } from '@/lib/auth'
import { formatAbhaNumber } from '@/lib/india/abha'
import { safeLog } from '@/lib/integrations/safe-log'
import { checkAbhaRateLimit } from '@/lib/rate-limit'
import { ServiceNotConfiguredError } from '@/lib/service-config'
import { ABDM_ERROR_COPY } from './constants'
import type { AbdmFailure, AbhaProfileView } from './gateway'

// Shared responses for the ABHA staff routes (SP8 Task 5). Every body a
// browser sees is a fixed string from ABDM_ERROR_COPY; nothing from a request
// or an ABDM response is echoed. Responses never carry tokens or txnIds.

const STATUS: Record<AbdmFailure, number> = {
  not_configured: 503,
  otp_invalid: 400,
  rate_limited: 429,
  abdm_unavailable: 502,
  invalid_input: 400,
  flow_expired: 410,
  consent_missing: 400,
  consent_text_missing: 409,
  abha_conflict: 409,
  account_choice_required: 400,
}

export function abdmErrorResponse(error: AbdmFailure): NextResponse {
  return NextResponse.json({ error: ABDM_ERROR_COPY[error] }, { status: STATUS[error] })
}

export const notConfiguredResponse = () => abdmErrorResponse('not_configured')
export const flowExpiredResponse = () => abdmErrorResponse('flow_expired')

/** The per-staff and hospital-wide ABHA limits; null when allowed. Fails closed without Redis (503). */
export async function abhaRateLimitResponse(session: Session): Promise<NextResponse | null> {
  try {
    const { allowed } = await checkAbhaRateLimit(session.name)
    return allowed ? null : abdmErrorResponse('rate_limited')
  } catch {
    return notConfiguredResponse()
  }
}

/** XX-XXXX-XXXX-1234 */
export function maskAbhaNumber(digits: string): string {
  return `XX-XXXX-XXXX-${digits.slice(-4)}`
}

/** What a browser may see of a verified profile: no mobile, no token, no status internals. */
export function profileForBrowser(p: Pick<AbhaProfileView, 'name' | 'gender' | 'yearOfBirth' | 'abhaNumber'>, abhaAddress: string | null) {
  return { name: p.name, gender: p.gender, yearOfBirth: p.yearOfBirth, abhaNumber: formatAbhaNumber(p.abhaNumber), abhaAddress }
}

/**
 * Runs a route body; an unexpected failure (Redis or the payload key missing,
 * a database error) becomes a fixed response. Only the error class name is
 * logged: a message could carry request data.
 */
export async function withAbdmErrors(action: string, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn()
  } catch (e) {
    const name = e instanceof Error ? e.name : 'UnknownError'
    safeLog('abdm', { action, errorCode: name })
    if (e instanceof ServiceNotConfiguredError || (e instanceof Error && /INTEGRATION_PAYLOAD_KEY/.test(e.message))) return notConfiguredResponse()
    return abdmErrorResponse('abdm_unavailable')
  }
}

export const flowPrefix = (flowId: string) => flowId.slice(0, 8)
