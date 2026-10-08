import { getDb } from '@/db/client'
import { bookingRequests, appointments } from '@/db/schema'
import { and, desc, eq, sql } from 'drizzle-orm'
import { hasSchedulingConflict, lockProviderSchedule } from '@/lib/queries/appointments'
import { logAudit } from '@/lib/audit' // Wave J
import type { Session } from '@/lib/auth' // Wave J

export type BookingRequestRow = typeof bookingRequests.$inferSelect

export interface CreateBookingRequestInput {
  requesterName: string
  requesterDob: string
  requesterEmail: string | null
  requesterPhone: string | null
  preferredProviderId: number | null
  preferredDateRangeStart: string
  preferredDateRangeEnd: string
  reason: string
}

export async function createBookingRequest(input: CreateBookingRequestInput) {
  const [created] = await getDb().insert(bookingRequests).values(input).returning()
  return created
}

export async function listBookingRequests() {
  return getDb().select().from(bookingRequests).orderBy(desc(bookingRequests.submittedAt))
}

/** Pending public booking requests -- the /booking-requests nav badge (Wave B P1-25). */
export async function countPendingBookingRequests(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(bookingRequests)
    .where(eq(bookingRequests.status, 'pending'))
  return row?.count ?? 0
}

export async function getBookingRequestById(id: number) {
  const [row] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, id))
  return row ?? null
}

export interface ConfirmBookingRequestInput {
  patientId: string
  providerId: number
  startsAt: Date
  endsAt: Date
  visitReason: string
  reviewedByName: string
  /** Wave J: a portal reschedule request -- this (still scheduled) appointment is cancelled in the same transaction. */
  rescheduleFromAppointmentId?: number | null
}

export interface BookingRequestActionResult {
  ok: boolean
  error?: string
  appointmentId?: number
}

class AlreadyResolved extends Error {}

// I7: ONE transaction behind the provider schedule lock: the conflict check
// (which then sees every booking committed before it), the conditional UPDATE
// guarding the pending->confirmed transition (WHERE status = 'pending' -- only
// one of two racing calls can win it), the appointment insert and the link
// back to it. A lost race or a conflict rolls everything back, so no orphaned
// appointment and no half-confirmed request is ever left.
export async function confirmBookingRequest(id: number, input: ConfirmBookingRequestInput): Promise<BookingRequestActionResult> {
  try {
    return await getDb().transaction(async (tx): Promise<BookingRequestActionResult> => {
      await lockProviderSchedule(tx, input.providerId)
      if (await hasSchedulingConflict(input.providerId, input.startsAt, input.endsAt, undefined, tx)) {
        return { ok: false, error: 'This provider already has an appointment during that time.' }
      }

      const updated = await tx.update(bookingRequests)
        .set({ status: 'confirmed', reviewedByName: input.reviewedByName, reviewedAt: new Date() })
        .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
        .returning({ id: bookingRequests.id })
      if (updated.length === 0) throw new AlreadyResolved()

      const [appointment] = await tx.insert(appointments).values({
        patientId: input.patientId,
        providerId: input.providerId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        visitReason: input.visitReason,
        status: 'scheduled',
      }).returning()

      await tx.update(bookingRequests).set({ resultingAppointmentId: appointment.id }).where(eq(bookingRequests.id, id))
      // Wave J: the appointment being moved is released only once its replacement exists.
      if (input.rescheduleFromAppointmentId) {
        await tx.update(appointments).set({ status: 'cancelled' })
          .where(and(eq(appointments.id, input.rescheduleFromAppointmentId), eq(appointments.patientId, input.patientId), eq(appointments.status, 'scheduled')))
      }
      // end Wave J
      return { ok: true, appointmentId: appointment.id }
    })
  } catch (err) {
    if (err instanceof AlreadyResolved) return { ok: false, error: 'This request has already been resolved.' }
    throw err
  }
}

export async function declineBookingRequest(id: number, input: { reason: string; reviewedByName: string }): Promise<BookingRequestActionResult> {
  const updated = await getDb().update(bookingRequests)
    .set({ status: 'declined', declineReason: input.reason, reviewedByName: input.reviewedByName, reviewedAt: new Date() })
    .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
    .returning({ id: bookingRequests.id })
  if (updated.length === 0) return { ok: false, error: 'This request has already been resolved.' }
  return { ok: true }
}

// Wave J (P1-20): confirming a portal cancellation request cancels the patient's appointment.
// One transaction: the pending->confirmed transition (lost races see "already resolved")
// and the cancellation of the named appointment, only while it is still scheduled.
export async function confirmCancelRequest(id: number, session: Session): Promise<BookingRequestActionResult> {
  return getDb().transaction(async (tx) => {
    const [req] = await tx.update(bookingRequests)
      .set({ status: 'confirmed', reviewedByName: session.name, reviewedAt: new Date() })
      .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending'), eq(bookingRequests.requestKind, 'cancel')))
      .returning({ appointmentId: bookingRequests.appointmentId, patientId: bookingRequests.patientId })
    if (!req || req.appointmentId === null || req.patientId === null) return { ok: false, error: 'This request has already been resolved.' }
    await tx.update(appointments).set({ status: 'cancelled' })
      .where(and(eq(appointments.id, req.appointmentId), eq(appointments.patientId, req.patientId), eq(appointments.status, 'scheduled')))
    await logAudit(session, 'confirmed appointment cancellation request', req.patientId, `request=${id} appointment=${req.appointmentId}`, tx)
    return { ok: true, appointmentId: req.appointmentId }
  })
}
