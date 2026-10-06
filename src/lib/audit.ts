import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { Session } from './auth'

// Takes a real, non-null Session -- not `Session | null` -- so it's a
// compile-time error to attribute an audit entry to a request that hasn't
// actually been authenticated. A prior version defaulted to `role: 'crc'`
// for a null session, which fabricated a real staff role for an unknown or
// unauthenticated principal in the exact compliance artifact this product's
// pitch rests on. Every caller must resolve a real session first (via
// `requireSession()` or `requireSessionOrRedirect()`), which is now also
// enforced structurally, not just by convention.
export async function logAudit(session: Session, action: string, patientId: string | null) {
  await getDb().insert(auditLog).values({
    userName: session.name,
    role: session.role,
    action,
    patientId,
  })
}
