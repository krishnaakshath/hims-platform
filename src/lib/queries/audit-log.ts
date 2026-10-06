import { getDb } from '@/db/client'
import { auditLog } from '@/db/schema'
import { desc } from 'drizzle-orm'

export type AuditLogEntry = typeof auditLog.$inferSelect

/**
 * Shared by the /api/audit-log route handler and the Audit Log Server
 * Component page — see the comment on `listPatientsWithStatus` in
 * `src/lib/queries/patients.ts` for why Server Components must call this
 * directly rather than fetching the app's own API route.
 */
export async function listAuditLog(limit = 200): Promise<AuditLogEntry[]> {
  return getDb().select().from(auditLog).orderBy(desc(auditLog.timestamp)).limit(Math.min(limit, 200))
}
