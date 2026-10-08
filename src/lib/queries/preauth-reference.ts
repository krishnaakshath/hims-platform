// SP7 (ruling 7): the interface SP4 charge capture validates a typed pre-auth reference against.
// A reference matches the insurer's approval reference or the hospital's PA- number of one of
// the patient's pre-auths, case-insensitively.
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { preauths } from '@/db/schema'
import { LIVE_APPROVED_PREAUTH_STATUSES, preauthReferenceStatus, type PreauthReferenceStatus } from '@/lib/rcm/preauth-status'
import type { WriteExecutor } from './executor'

export async function validatePreauthReference(
  executor: WriteExecutor,
  input: { patientId: string; payerId: number | null; reference: string; serviceDate: string },
): Promise<{ status: PreauthReferenceStatus; preauthId: number | null }> {
  const ref = input.reference.trim().toLowerCase()
  if (ref === '') return { status: 'not_found', preauthId: null }
  const candidates = await executor.select({
    id: preauths.id, status: preauths.status, insurerPayerId: preauths.insurerPayerId, tpaPayerId: preauths.tpaPayerId, validUntil: preauths.validUntil,
  }).from(preauths).where(and(
    eq(preauths.patientId, input.patientId),
    or(sql`lower(${preauths.approvalReference}) = ${ref}`, sql`lower(${preauths.preauthNumber}) = ${ref}`),
  )).orderBy(asc(preauths.id))
  if (candidates.length === 0) return { status: 'not_found', preauthId: null }
  const scored = candidates.map((c) => ({
    id: c.id,
    status: preauthReferenceStatus(
      { status: c.status, payerIds: c.tpaPayerId === null ? [c.insurerPayerId] : [c.insurerPayerId, c.tpaPayerId], validUntil: c.validUntil },
      { payerId: input.payerId, serviceDate: input.serviceDate },
    ),
  }))
  const valid = scored.find((s) => s.status === 'valid')
  const pick = valid ?? scored[0]
  return { status: pick.status, preauthId: pick.id }
}

/** The patient's live-approved pre-auths still valid on `onDate` (the charge-capture picker). */
export async function listApprovedPreauthsForPatient(patientId: string, onDate: string, executor: WriteExecutor = getDb()): Promise<{
  id: number; preauthNumber: string; approvalReference: string; approvedPaise: number; validUntil: string; payerIds: number[]
}[]> {
  const rows = await executor.select({
    id: preauths.id, preauthNumber: preauths.preauthNumber, approvalReference: preauths.approvalReference, approvedPaise: preauths.approvedPaise,
    validUntil: preauths.validUntil, insurerPayerId: preauths.insurerPayerId, tpaPayerId: preauths.tpaPayerId,
  }).from(preauths).where(and(
    eq(preauths.patientId, patientId), inArray(preauths.status, [...LIVE_APPROVED_PREAUTH_STATUSES]), gte(preauths.validUntil, onDate),
  )).orderBy(asc(preauths.validUntil), asc(preauths.id))
  return rows.flatMap((r) => r.approvalReference === null || r.approvedPaise === null || r.validUntil === null ? [] : [{
    id: r.id, preauthNumber: r.preauthNumber, approvalReference: r.approvalReference, approvedPaise: r.approvedPaise, validUntil: r.validUntil,
    payerIds: r.tpaPayerId === null ? [r.insurerPayerId] : [r.insurerPayerId, r.tpaPayerId],
  }])
}
