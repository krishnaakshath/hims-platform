// Wave J (P1-20): a signed-in patient asks for a new appointment, or to reschedule or cancel
// one of their own upcoming appointments. Nothing is booked or cancelled here: the request
// lands in the staff booking-requests queue, where the front desk confirms or declines it.
// An appointment that is not the patient's own, already past or not scheduled is a 404
// (never a 403). Rate limited per patient; audited on the same transaction as the insert.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { providers } from '@/db/schema'
import { requirePatientSession } from '@/lib/patient-session'
import { readJsonBody } from '@/lib/http'
import { checkPortalAppointmentRequestRateLimit } from '@/lib/rate-limit'
import { istDateOf, todayIsoIn } from '@/lib/india-time'
import { daysBetweenIso } from '@/lib/follow-ups/rules'
import { createPortalAppointmentRequest, getPortalChangeableAppointment, type PortalAppointmentRequestInput } from '@/lib/queries/patient-portal-records'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Invalid date')
const appointmentId = z.number().int().positive().max(2_147_483_647)
const reason = z.string().trim().max(500)

const schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), preferredProviderId: z.number().int().positive().max(2_147_483_647).nullable().optional(), preferredDateRangeStart: isoDate, preferredDateRangeEnd: isoDate, reason: reason.min(1) }).strict(),
  z.object({ kind: z.literal('reschedule'), appointmentId, preferredDateRangeStart: isoDate, preferredDateRangeEnd: isoDate, reason: reason.optional() }).strict(),
  z.object({ kind: z.literal('cancel'), appointmentId, reason: reason.optional() }).strict(),
])

const MAX_RANGE_DAYS = 90
const MAX_LEAD_DAYS = 365

export async function POST(request: NextRequest) {
  const session = await requirePatientSession()
  if (session instanceof NextResponse) return session

  if (!(await checkPortalAppointmentRequestRateLimit(session.patientId)).allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again later or call the hospital.' }, { status: 429 })
  }

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid appointment request', details: parsed.error.flatten() }, { status: 400 })
  const body = parsed.data

  const today = todayIsoIn()
  if (body.kind !== 'cancel') {
    const { preferredDateRangeStart: start, preferredDateRangeEnd: end } = body
    if (start < today) return NextResponse.json({ error: 'Preferred dates must be today or later' }, { status: 400 })
    if (end < start) return NextResponse.json({ error: 'The end date must be on or after the start date' }, { status: 400 })
    if (daysBetweenIso(start, end) > MAX_RANGE_DAYS || daysBetweenIso(today, end) > MAX_LEAD_DAYS) {
      return NextResponse.json({ error: 'Choose dates within the next year, at most 90 days apart' }, { status: 400 })
    }
  }

  let input: PortalAppointmentRequestInput
  if (body.kind === 'new') {
    const providerId = body.preferredProviderId ?? null
    if (providerId !== null) {
      const [p] = await getDb().select({ id: providers.id }).from(providers).where(and(eq(providers.id, providerId), eq(providers.isActive, true)))
      if (!p) return NextResponse.json({ error: 'Choose a doctor from the list' }, { status: 400 })
    }
    input = { kind: 'new', preferredProviderId: providerId, preferredDateRangeStart: body.preferredDateRangeStart, preferredDateRangeEnd: body.preferredDateRangeEnd, reason: body.reason }
  } else {
    const appt = await getPortalChangeableAppointment(session.patientId, body.appointmentId)
    if (!appt) return NextResponse.json({ error: 'Appointment not found' }, { status: 404 })
    if (body.kind === 'reschedule') {
      input = { kind: 'reschedule', appointmentId: appt.id, preferredDateRangeStart: body.preferredDateRangeStart, preferredDateRangeEnd: body.preferredDateRangeEnd, reason: body.reason || `Reschedule: ${appt.visitReason}` }
    } else {
      const day = istDateOf(appt.startsAt)
      input = { kind: 'cancel', appointmentId: appt.id, preferredDateRangeStart: day, preferredDateRangeEnd: day, reason: body.reason || 'Cancellation requested by the patient' }
    }
  }

  const result = await createPortalAppointmentRequest(session.patientId, input)
  if (!result.ok) {
    if (result.error === 'duplicate') return NextResponse.json({ error: 'You already have a pending request for this appointment' }, { status: 409 })
    return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
  }
  return NextResponse.json({ id: result.id }, { status: 201 })
}
