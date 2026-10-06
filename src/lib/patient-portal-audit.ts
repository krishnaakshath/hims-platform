import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'

// The TWO sanctioned places in this codebase that write an audit row with no
// real Session behind it. A patient filling out their own intake form has no
// staff session -- that's the entire point of this feature -- so it cannot
// go through logAudit(), which deliberately requires one. Every other write
// in this app still must go through logAudit() with a real session; this
// function exists so that requirement is never silently bypassed anywhere
// else, only here, for exactly these two legitimate cases: a patient acting
// on their own record (logPatientPortalAction) and the token-authenticated LIS
// webhook (logIntegrationEvent).
export async function logPatientPortalAction(action: string, patientId: string, details?: string): Promise<void> {
  await getDb().insert(auditLog).values({
    userName: 'Patient (self-service)',
    role: null,
    action,
    patientId,
    details,
  })
}

// Second sanctioned session-less writer: the LIS lab-result webhook has no staff
// session, only a verified integration token. Call it for ACCEPTED results only --
// rejected (unauthenticated) calls must never cause a database write.
// Pass `executor` (a transaction) to make the audit row commit or roll back with the work it records.
export async function logIntegrationEvent(action: string, patientId: string | null, details?: string, executor: Pick<ReturnType<typeof getDb>, 'insert'> = getDb()): Promise<void> {
  await executor.insert(auditLog).values({
    userName: 'LIS integration',
    role: null,
    action,
    patientId,
    details,
  })
}
