import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Session } from './auth'
import { isValidAadhaar } from './india/aadhaar'

// Defence in depth: callers must never put an Aadhaar number into an audit
// row (identity entries carry only actions and reason codes), but if one
// slips through -- 12 digits, optionally grouped 4-4-4 by spaces or hyphens,
// with a valid Verhoeff checksum -- it is redacted before it reaches the DB.
const AADHAAR_SHAPED = /(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)/g

function redactAadhaar(text: string): string {
  return text.replace(AADHAAR_SHAPED, (m) => (isValidAadhaar(m) ? '[redacted]' : m))
}

// Takes a real, non-null Session -- not `Session | null` -- so it's a
// compile-time error to attribute an audit entry to a request that hasn't
// actually been authenticated. A prior version defaulted to `role: 'crc'`
// for a null session, which fabricated a real staff role for an unknown or
// unauthenticated principal in the exact compliance artifact this product's
// pitch rests on. Every caller must resolve a real session first (via
// `requireSession()` or `requireSessionOrRedirect()`), which is now also
// enforced structurally, not just by convention.
//
// `details` is optional free text (e.g. `reason: emergency`); omitted -> NULL.
export async function logAudit(session: Session, action: string, patientId: string | null, details?: string | null): Promise<void> {
  await getDb().insert(auditLog).values({
    userName: session.name,
    role: session.role,
    action: redactAadhaar(action),
    patientId,
    details: details == null ? null : redactAadhaar(details),
  })
}
