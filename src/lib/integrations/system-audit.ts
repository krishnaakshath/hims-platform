import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import type { AuditExecutor } from '@/lib/audit'
import { redactAadhaarLike } from '@/lib/india/aadhaar'

// Audit rows for writes the ABDM or NHCX gateway originates (callbacks,
// dispatch outcomes). No Session is ever fabricated: the row names the
// gateway and carries a null role, the same pattern as logIntegrationEvent
// in patient-portal-audit.ts. `details` must carry only internal ids, enum
// values and correlation prefixes; Aadhaar-like strings are redacted as
// defence in depth.

export type GatewaySource = 'ABDM gateway' | 'NHCX gateway'

export async function logGatewayEvent(
  source: GatewaySource,
  action: string,
  patientId: string | null,
  details: string | null,
  executor: AuditExecutor = getDb(),
): Promise<void> {
  await executor.insert(auditLog).values({
    userName: source,
    role: null,
    action: redactAadhaarLike(action),
    patientId,
    details: details == null ? null : redactAadhaarLike(details),
  })
}
