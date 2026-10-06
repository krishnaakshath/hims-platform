import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBookingRequestById, confirmBookingRequest } from '@/lib/queries/booking-requests'
import { visitReasonSchema } from '@/lib/visit-reason-schema'

const confirmBookingRequestSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  visitReason: visitReasonSchema,
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const requestId = Number(id)
  if (!Number.isInteger(requestId)) return NextResponse.json({ error: 'Invalid booking request id' }, { status: 400 })

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = confirmBookingRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid confirm payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  const existing = await getBookingRequestById(requestId)
  if (!existing) return NextResponse.json({ error: 'Booking request not found' }, { status: 404 })

  // Validate patientId refers to a real patient BEFORE calling
  // confirmBookingRequest -- that function flips the request's status to
  // 'confirmed' and only then inserts the appointments row, so a bad
  // patientId (e.g. a staff typo in this free-text field) discovered by a
  // FK violation at insert time would leave the request permanently stuck
  // 'confirmed' with no appointment and no retry path (a retry just 409s
  // "already resolved"). Same "does not reference a real X" pattern already
  // used for preferredProviderId on the public submission route.
  const [patientRow] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, parsed.data.patientId))
  if (!patientRow) return NextResponse.json({ error: 'patientId does not reference a real patient' }, { status: 400 })

  const result = await confirmBookingRequest(requestId, {
    patientId: parsed.data.patientId,
    providerId: parsed.data.providerId,
    startsAt,
    endsAt,
    visitReason: parsed.data.visitReason,
    reviewedByName: session.name,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'confirmed booking request', parsed.data.patientId)
  return NextResponse.json(result)
}
