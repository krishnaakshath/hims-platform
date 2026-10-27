// WS8 T13 (spec D17): "Delete" becomes archive. An archived chart keeps every record but is hidden
// from lists, search, pickers, broadcasts, the queue and portal sign-in; an admin can still open it
// (with a banner) and restore it. Hard delete (deletePatient) is reachable only from DPDP erasure.
import { and, eq, isNotNull, isNull, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { admissions, patients } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCachePrefix, dashboardCacheKey, workbookListCacheKey } from '@/lib/cache'

/** The active-chart filter every patient list, search, picker and audience query applies. */
export function notArchived(): SQL {
  return isNull(patients.archivedAt)
}

export const ARCHIVE_REASON_MIN = 10
export const ARCHIVE_REASON_MAX = 500

export type ArchiveResult = { ok: true } | { ok: false; error: 'not_found' | 'uhid_mismatch' | 'already_archived' | 'active_admission' }
export type RestoreResult = { ok: true } | { ok: false; error: 'not_found' | 'not_archived' }

/** The identifier the admin must type: the UHID, or the chart id for a legacy chart without one. */
function confirmationIdOf(p: { id: string; uhid: string | null }): string {
  return (p.uhid ?? p.id).trim().toUpperCase()
}

async function invalidatePatientCaches(anonId: string): Promise<void> {
  await invalidateCache(patientDetailCacheKey(anonId))
  await invalidateCacheByPrefix(patientListCachePrefix())
  await invalidateCache(dashboardCacheKey())
  await invalidateCache(workbookListCacheKey())
}

/**
 * Archives a chart in one transaction with its audit row (`archived patient`, details carry only
 * `reason_length=<n>`, never the reason text). Refuses a wrong typed UHID, an already-archived chart
 * and a patient who is currently admitted.
 */
export async function archivePatient(anonId: string, input: { reason: string; confirmUhid: string }, session: Session): Promise<ArchiveResult> {
  const reason = input.reason.trim()
  const result = await getDb().transaction(async (tx): Promise<ArchiveResult> => {
    const [p] = await tx
      .select({ id: patients.id, uhid: patients.uhid, archivedAt: patients.archivedAt })
      .from(patients)
      .where(eq(patients.id, anonId))
      .for('update')
    if (!p) return { ok: false, error: 'not_found' }
    if (input.confirmUhid.trim().toUpperCase() !== confirmationIdOf(p)) return { ok: false, error: 'uhid_mismatch' }
    if (p.archivedAt) return { ok: false, error: 'already_archived' }
    const [admitted] = await tx
      .select({ id: admissions.id })
      .from(admissions)
      .where(and(eq(admissions.patientId, anonId), eq(admissions.status, 'admitted')))
      .limit(1)
    if (admitted) return { ok: false, error: 'active_admission' }
    await tx
      .update(patients)
      .set({ archivedAt: new Date(), archivedByName: session.name, archiveReason: reason })
      .where(eq(patients.id, anonId))
    await logAudit(session, 'archived patient', anonId, `reason_length=${reason.length}`, tx)
    return { ok: true }
  })
  if (result.ok) await invalidatePatientCaches(anonId)
  return result
}

/** Restores an archived chart in one transaction with its audit row (`restored patient`). */
export async function restorePatient(anonId: string, session: Session): Promise<RestoreResult> {
  const result = await getDb().transaction(async (tx): Promise<RestoreResult> => {
    const [p] = await tx
      .select({ id: patients.id, archivedAt: patients.archivedAt })
      .from(patients)
      .where(eq(patients.id, anonId))
      .for('update')
    if (!p) return { ok: false, error: 'not_found' }
    if (!p.archivedAt) return { ok: false, error: 'not_archived' }
    await tx
      .update(patients)
      .set({ archivedAt: null, archivedByName: null, archiveReason: null })
      .where(and(eq(patients.id, anonId), isNotNull(patients.archivedAt)))
    await logAudit(session, 'restored patient', anonId, null, tx)
    return { ok: true }
  })
  if (result.ok) await invalidatePatientCaches(anonId)
  return result
}

export interface PatientArchiveState {
  archivedAt: Date
  archivedByName: string | null
  archiveReason: string | null
}

/** The chart's archive state, or null when the chart is active (or does not exist). */
export async function getPatientArchiveState(anonId: string): Promise<PatientArchiveState | null> {
  const [row] = await getDb()
    .select({ archivedAt: patients.archivedAt, archivedByName: patients.archivedByName, archiveReason: patients.archiveReason })
    .from(patients)
    .where(eq(patients.id, anonId))
  return row?.archivedAt ? { archivedAt: row.archivedAt, archivedByName: row.archivedByName, archiveReason: row.archiveReason } : null
}
