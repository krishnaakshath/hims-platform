import { getDb } from '@/db/client'
import { appointments, doctorAssignments, patients } from '@/db/schema'
import { and, asc, desc, eq, getTableColumns, gte, isNull, sql } from 'drizzle-orm'
import { sendMessage } from './messages'
import { SYSTEM_SENDER_NAME } from './eligibility'
import { buildVisitConfirmationBody } from '@/lib/notification-templates'

// Assignments are created only by checkInVisit (src/lib/queries/encounters.ts),
// in one transaction with the OPD token that is also the lobby ticket.
export type DoctorAssignmentRow = typeof doctorAssignments.$inferSelect

export type PendingAssignmentRow = DoctorAssignmentRow & { patientName: string }

export async function listPendingAssignmentsForProvider(providerId: number): Promise<PendingAssignmentRow[]> {
  return getDb()
    .select({ ...getTableColumns(doctorAssignments), patientName: patients.name })
    .from(doctorAssignments)
    .innerJoin(patients, eq(patients.id, doctorAssignments.patientId))
    .where(and(eq(doctorAssignments.providerId, providerId), eq(doctorAssignments.status, 'pending')))
    .orderBy(
      sql`CASE ${doctorAssignments.urgency} WHEN 'emergency' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END`,
      asc(doctorAssignments.createdAt),
      asc(doctorAssignments.id),
    )
}

export async function countPendingAssignmentsForProvider(providerId: number): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(doctorAssignments)
    .where(and(eq(doctorAssignments.providerId, providerId), eq(doctorAssignments.status, 'pending')))
  return row?.count ?? 0
}

/**
 * Every assignment still awaiting a doctor's decision, whatever day it was
 * created -- the same rows /front-desk/assignments shows as Pending. The
 * front-desk "Pending Assignments" tile uses this (Task 17): it previously
 * counted only today's rows, so a pending assignment from yesterday showed
 * as 0 on the tile while the page it links to listed it.
 */
export async function countAllPendingAssignments(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(doctorAssignments)
    .where(eq(doctorAssignments.status, 'pending'))
  return row?.count ?? 0
}

export async function countUnacknowledgedDeclines(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(doctorAssignments)
    .where(and(eq(doctorAssignments.status, 'declined'), isNull(doctorAssignments.declineAcknowledgedAt)))
  return row?.count ?? 0
}

export async function acknowledgeDecline(assignmentId: number, acknowledgedByName: string): Promise<DoctorAssignmentRow | null> {
  const [updated] = await getDb()
    .update(doctorAssignments)
    .set({ declineAcknowledgedAt: new Date(), declineAcknowledgedByName: acknowledgedByName })
    .where(and(eq(doctorAssignments.id, assignmentId), eq(doctorAssignments.status, 'declined'), isNull(doctorAssignments.declineAcknowledgedAt)))
    .returning()
  return updated ?? null
}

/** Transitions a PENDING assignment to scheduled. The status condition is in
 *  the UPDATE itself, so of two concurrent callers only one can win; the
 *  other gets null (the row is no longer pending) and must not keep its
 *  appointment. */
export async function scheduleAssignment(assignmentId: number, appointmentId: number): Promise<DoctorAssignmentRow | null> {
  const [updated] = await getDb()
    .update(doctorAssignments)
    .set({ status: 'scheduled', appointmentId })
    .where(and(eq(doctorAssignments.id, assignmentId), eq(doctorAssignments.status, 'pending')))
    .returning()
  return updated ?? null
}

/** Transitions a PENDING assignment to declined. The status condition is in
 *  the UPDATE itself, so a schedule that commits between a caller's read and
 *  this write wins: this returns null and the scheduled row (and its
 *  appointment and patient confirmation) stays intact. */
export async function declineAssignment(assignmentId: number, reason: string): Promise<DoctorAssignmentRow | null> {
  const [updated] = await getDb()
    .update(doctorAssignments)
    .set({ status: 'declined', declineReason: reason })
    .where(and(eq(doctorAssignments.id, assignmentId), eq(doctorAssignments.status, 'pending')))
    .returning()
  return updated ?? null
}

export async function listAllAssignments(): Promise<DoctorAssignmentRow[]> {
  return getDb()
    .select()
    .from(doctorAssignments)
    .orderBy(
      sql`CASE WHEN ${doctorAssignments.status} = 'declined' AND ${doctorAssignments.declineAcknowledgedAt} IS NULL THEN 0 ELSE 1 END`,
      desc(doctorAssignments.createdAt),
    )
}

/**
 * Restricts the KPI/queue view to assignments created today (calendar day,
 * server-local time) -- listAllAssignments() itself is intentionally left
 * alone since /front-desk/assignments shows the full history, not just
 * today.
 */
export async function listTodaysAssignments(): Promise<DoctorAssignmentRow[]> {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  return getDb()
    .select()
    .from(doctorAssignments)
    .where(gte(doctorAssignments.createdAt, startOfToday))
    .orderBy(desc(doctorAssignments.createdAt))
}

/**
 * Sends the patient the fixed "Your visit is confirmed." notice (spec §5) at
 * most once per assignment. `patientNotifiedAt` is the send-guard (spec §8)
 * and is never cleared by anything.
 *
 * Divergence D7 (plan): the spec describes read-check, send, then set; the
 * eligibility precedent (confirmScreeningSelection) instead claims the
 * timestamp first and never un-claims it, so a failed send there leaves the
 * patient marked notified when they were not. Here the conditional claim
 * (`... WHERE patient_notified_at IS NULL RETURNING id`) and the message
 * insert run in ONE transaction on the same `tx`:
 *   - concurrent callers serialize on the row lock taken by the UPDATE; the
 *     loser re-evaluates the predicate after the winner commits, matches no
 *     row, and returns without sending;
 *   - if the insert (or anything after the claim) throws, the transaction
 *     rolls back, so `patientNotifiedAt` stays NULL and no message exists
 *     (spec §5.1 failure rule).
 * Errors are deliberately NOT caught: the caller (schedule route) reports
 * the failure so the front desk can message the patient manually.
 *
 * The body comes only from the fixed template, with server-side values.
 */
export async function notifyPatientOfScheduledAssignment(
  assignment: DoctorAssignmentRow,
  appointment: typeof appointments.$inferSelect,
  providerName: string,
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const claimed = await tx
      .update(doctorAssignments)
      .set({ patientNotifiedAt: new Date() })
      .where(and(eq(doctorAssignments.id, assignment.id), isNull(doctorAssignments.patientNotifiedAt)))
      .returning({ id: doctorAssignments.id })
    if (claimed.length === 0) return

    const body = buildVisitConfirmationBody({
      providerName,
      startsAt: appointment.startsAt,
      visitReason: appointment.visitReason,
      visitType: assignment.visitType,
    })
    await sendMessage(assignment.patientId, 'system', SYSTEM_SENDER_NAME, body, false, tx)
  })
}
