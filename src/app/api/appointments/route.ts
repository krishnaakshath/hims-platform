import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { SCHEDULING_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { insertAppointmentIfFree, listAppointmentsInRange } from '@/lib/queries/appointments'
import { visitReasonSchema } from '@/lib/visit-reason-schema'
import { appointmentInstantSchema, invalidAppointmentTime, isTimeFieldError } from '@/lib/appointment-time'

const createAppointmentSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  startsAt: appointmentInstantSchema,
  endsAt: appointmentInstantSchema,
  visitReason: visitReasonSchema,
  status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (!from || !to) return NextResponse.json({ error: 'from and to query parameters are required' }, { status: 400 })

  const providerIdsParam = url.searchParams.get('providerIds')
  const providerIds = providerIdsParam !== null
    ? (providerIdsParam === '' ? [] : providerIdsParam.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))
    : undefined

  const results = await listAppointmentsInRange(new Date(from), new Date(to), providerIds)
  await logAudit(session, 'viewed appointments', null)
  return NextResponse.json(results)
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = createAppointmentSchema.safeParse(await request.json())
  if (!parsed.success && isTimeFieldError(parsed.error)) return invalidAppointmentTime()
  if (!parsed.success) return NextResponse.json({ error: 'Invalid appointment payload', details: parsed.error.flatten() }, { status: 400 })

  const startsAt = new Date(parsed.data.startsAt)
  const endsAt = new Date(parsed.data.endsAt)
  if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
    return NextResponse.json({ error: 'endsAt must be a valid time after startsAt' }, { status: 400 })
  }

  // I7: lock the doctor's schedule, check and insert in one transaction.
  const result = await insertAppointmentIfFree({
    patientId: parsed.data.patientId,
    providerId: parsed.data.providerId,
    startsAt,
    endsAt,
    visitReason: parsed.data.visitReason,
    status: parsed.data.status ?? 'scheduled',
  })
  if (!result.ok) {
    return NextResponse.json({ error: 'This provider already has an appointment during that time.' }, { status: 409 })
  }
  const created = result.appointment

  await logAudit(session, 'scheduled appointment', parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}
