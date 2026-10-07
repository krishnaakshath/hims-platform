import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { appointments } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { SCHEDULING_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { getAppointment, rescheduleAppointmentIfFree } from '@/lib/queries/appointments'
import { visitReasonSchema } from '@/lib/visit-reason-schema'

const updateAppointmentSchema = z.object({
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
  visitReason: visitReasonSchema.optional(),
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().min(1).optional(),
  notes: z.string().optional(),
}).strict()

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = updateAppointmentSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid appointment update', details: parsed.error.flatten() }, { status: 400 })

  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = await getAppointment(numericId)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const patch: Record<string, unknown> = { ...parsed.data }
  if (parsed.data.startsAt) patch.startsAt = new Date(parsed.data.startsAt)
  if (parsed.data.endsAt) patch.endsAt = new Date(parsed.data.endsAt)

  // Validate the resulting range (new value if the caller is changing it,
  // existing value otherwise) the same way POST validates a new appointment
  // -- a partial update that only sends one of the two fields must not be
  // allowed to flip the range backwards or write an unparseable date.
  const resultingStartsAt = (patch.startsAt as Date | undefined) ?? existing.startsAt
  const resultingEndsAt = (patch.endsAt as Date | undefined) ?? existing.endsAt
  if (isNaN(resultingStartsAt.getTime()) || isNaN(resultingEndsAt.getTime()) || resultingEndsAt <= resultingStartsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  // Only re-check for a double-booking when the reschedule actually moves
  // the time range -- excludes this appointment's own id so it never
  // conflicts with itself.
  // I7: a move takes the doctor's schedule lock; check and update are one transaction.
  if (parsed.data.startsAt || parsed.data.endsAt) {
    const moved = await rescheduleAppointmentIfFree(existing.id, existing.providerId, resultingStartsAt, resultingEndsAt, patch)
    if (!moved.ok) {
      return NextResponse.json({ error: 'This provider already has an appointment during that time.' }, { status: 409 })
    }
  } else {
    await getDb().update(appointments).set(patch).where(eq(appointments.id, numericId))
  }

  const action = parsed.data.status ? `marked appointment ${id} as ${parsed.data.status}` : `updated appointment ${id}`
  await logAudit(session, action, existing.patientId)

  return NextResponse.json({ ok: true })
}
