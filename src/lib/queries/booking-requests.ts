import { getDb } from '@/db/client'
import { bookingRequests, appointments } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { hasSchedulingConflict, lockProviderSchedule } from '@/lib/queries/appointments'

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
