import { NextResponse } from 'next/server'
import type { Session } from '@/lib/auth'
import { formatAbhaNumber } from '@/lib/india/abha'
import { safeLog } from '@/lib/integrations/safe-log'
import { checkAbhaRateLimit } from '@/lib/rate-limit'
import { ServiceNotConfiguredError } from '@/lib/service-config'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { ABDM_ERROR_COPY } from './constants'
import type { AbdmFailure, AbhaProfileView } from './gateway'
import { compareAbhaIdentity, IDENTITY_MISMATCH_MESSAGE, type AbhaIdentityProfile, type IdentityComparison, type IdentityField } from './identity-match'
import { readChartIdentity } from '@/lib/queries/abha-link'

// Shared responses for the ABHA staff routes (SP8 Task 5). Every body a
// browser sees is a fixed string from ABDM_ERROR_COPY; nothing from a request
// or an ABDM response is echoed. Responses never carry tokens or txnIds.

const STATUS: Record<AbdmFailure, number> = {
  not_configured: 503,
  payload_key_missing: 503,
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

/** WS12 T5: the part of a verified ABDM profile kept in the sealed flow for the identity check. */
export function identityProfileOf(p: Pick<AbhaProfileView, 'name' | 'gender' | 'yearOfBirth'>): AbhaIdentityProfile {
  return { name: p.name, gender: p.gender, yearOfBirth: p.yearOfBirth, monthOfBirth: null, dayOfBirth: null }
}

/**
 * WS12 T5: the chart-vs-ABDM comparison for a flow started on a patient, for
 * the dialog of the staff member who ran it (never logged). Undefined when the
 * flow has no patient or the patient is gone.
 */
export async function comparisonForFlow(patientId: string | null, profile: AbhaIdentityProfile): Promise<IdentityComparison | undefined> {
  if (!patientId) return undefined
  const chart = await readChartIdentity(patientId)
  return chart ? compareAbhaIdentity(chart, profile) : undefined
}

/** WS12 T5: 409 with the mismatched field names only. */
export function identityMismatchResponse(fields: IdentityField[]): NextResponse {
  return NextResponse.json({ error: IDENTITY_MISMATCH_MESSAGE, code: 'identity_mismatch', fields }, { status: 409 })
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
    // A deadlock or serialization failure wrote nothing: the staff member can simply try again.
    if (isRetryableConflict(e)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    if (e instanceof Error && /INTEGRATION_PAYLOAD_KEY/.test(e.message)) return abdmErrorResponse('payload_key_missing')
    if (e instanceof ServiceNotConfiguredError) return notConfiguredResponse()
    return abdmErrorResponse('abdm_unavailable')
  }
}

export const flowPrefix = (flowId: string) => flowId.slice(0, 8)
