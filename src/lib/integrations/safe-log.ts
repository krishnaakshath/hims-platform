import { redactAadhaarLike } from '@/lib/india/aadhaar'

// The only logging path for ABDM / NHCX code (SP8 Global Constraints, Logs).
// It keeps allowlisted keys holding ids, codes, statuses, counts and
// durations, and drops everything else, so a token, an OTP, an Aadhaar
// number, a name or a payload cannot reach a log line even when a caller
// passes a whole object.

export const SAFE_LOG_KEYS = [
  'exchangeId', 'claimId', 'preauthId', 'patientId', 'checkId', 'shareId', 'action', 'state', 'httpStatus',
  'errorCode', 'attempt', 'durationMs', 'correlationPrefix', 'count', 'capability', 'outcome',
] as const

const SAFE_STRING = /^[A-Za-z0-9_.:/-]{1,64}$/
const DROPPED = '[dropped]'

export function safeLogFields(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const key of SAFE_LOG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) continue
    const v = fields[key]
    if (typeof v === 'boolean') out[key] = v
    else if (typeof v === 'number') out[key] = Number.isFinite(v) ? v : DROPPED
    else if (typeof v === 'string' && SAFE_STRING.test(v)) out[key] = redactAadhaarLike(v)
    else out[key] = DROPPED
  }
  return out
}

export function safeLog(tag: string, fields: Record<string, unknown>): void {
  console.info(`[${tag}]`, JSON.stringify(safeLogFields(fields)))
}
