import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Session } from './auth'
import { redactAadhaarLike } from './india/aadhaar'

// Defence in depth: callers must never put an Aadhaar number into an audit
// row (identity entries carry only actions and reason codes), but if one
// slips through it is redacted before it reaches the DB (detector and its
// documented false positives: redactAadhaarLike in india/aadhaar.ts).

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
// `executor` lets a caller write the audit row inside its own transaction
// (e.g. registerPatient), so the row commits or rolls back with the change it
// records; omitted -> the shared db.
export type AuditExecutor = Pick<ReturnType<typeof getDb>, 'insert'>

export async function logAudit(session: Session, action: string, patientId: string | null, details?: string | null, executor: AuditExecutor = getDb()): Promise<void> {
  await executor.insert(auditLog).values({
    userName: session.name,
    role: session.role,
    action: redactAadhaarLike(action),
    patientId,
    details: details == null ? null : redactAadhaarLike(details),
  })
}
