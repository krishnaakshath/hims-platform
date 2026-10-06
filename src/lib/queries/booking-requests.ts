import { getDb } from '@/db/client'
import { bookingRequests, appointments } from '@/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { hasSchedulingConflict } from '@/lib/queries/appointments'

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

// Order matters and is deliberate: check the real scheduling conflict
// first (no DB write either way), then the conditional UPDATE guarding the
// pending->confirmed transition (WHERE status = 'pending' -- only one of
// two racing calls can win it), and only create the real appointments row
// -- and point resultingAppointmentId at it -- after that UPDATE actually
// succeeded. This codebase has no established db.transaction() convention
// (see the lab-orders and pharmacy plans' own UPDATE-then-insert ordering),
// so ordering the writes this way, rather than wrapping them, is what keeps
// a losing/racing caller from ever creating an orphaned appointment.
export async function confirmBookingRequest(id: number, input: ConfirmBookingRequestInput): Promise<BookingRequestActionResult> {
  const db = getDb()

  if (await hasSchedulingConflict(input.providerId, input.startsAt, input.endsAt)) {
    return { ok: false, error: 'This provider already has an appointment during that time.' }
  }

  const updated = await db.update(bookingRequests)
    .set({ status: 'confirmed', reviewedByName: input.reviewedByName, reviewedAt: new Date() })
    .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
    .returning({ id: bookingRequests.id })
  if (updated.length === 0) return { ok: false, error: 'This request has already been resolved.' }

  const [appointment] = await db.insert(appointments).values({
    patientId: input.patientId,
    providerId: input.providerId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    visitReason: input.visitReason,
    status: 'scheduled',
  }).returning()

  await db.update(bookingRequests).set({ resultingAppointmentId: appointment.id }).where(eq(bookingRequests.id, id))

  return { ok: true, appointmentId: appointment.id }
}

export async function declineBookingRequest(id: number, input: { reason: string; reviewedByName: string }): Promise<BookingRequestActionResult> {
  const updated = await getDb().update(bookingRequests)
    .set({ status: 'declined', declineReason: input.reason, reviewedByName: input.reviewedByName, reviewedAt: new Date() })
    .where(and(eq(bookingRequests.id, id), eq(bookingRequests.status, 'pending')))
    .returning({ id: bookingRequests.id })
  if (updated.length === 0) return { ok: false, error: 'This request has already been resolved.' }
  return { ok: true }
}
