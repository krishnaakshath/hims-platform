import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidIdResponse, parseId } from '@/lib/http'
import { SCHEDULING_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { buildSlots } from '@/lib/scheduling/slots'
import { getProviderScheduleForDate, hasWorkingHours, listBookedIntervals } from '@/lib/queries/provider-schedules'

// WS6 T6 (spec D5): a doctor's slots for one IST day, computed on read.

const DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS_AHEAD = 90
const DAY_MS = 24 * 60 * 60 * 1000

const dayNumber = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const providerId = parseId((await params).id)
  if (providerId === null) return invalidIdResponse()
  const date = request.nextUrl.searchParams.get('date') ?? ''
  if (!DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return NextResponse.json({ error: 'Use a date in YYYY-MM-DD form' }, { status: 400 })
  }
  const now = new Date()
  if (dayNumber(date) - dayNumber(todayIsoIn(undefined, now)) > MAX_DAYS_AHEAD) {
    return NextResponse.json({ error: `Slots can be viewed up to ${MAX_DAYS_AHEAD} days ahead` }, { status: 400 })
  }

  const schedule = await getProviderScheduleForDate(providerId, date)
  if (!schedule) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  const [booked, hoursSet] = await Promise.all([
    schedule.onLeave ? [] : listBookedIntervals(providerId, date),
    hasWorkingHours(providerId), // WS6 T7: no hours set up at all -> the booking form takes any time
  ])
  const slots = buildSlots({ dateIso: date, sessions: schedule.sessions, slotMinutes: schedule.slotMinutes, onLeave: schedule.onLeave, booked, now })
  await logAudit(session, 'viewed provider slots', null, `provider=${providerId} date=${date}`)
  return NextResponse.json({ date, slotMinutes: schedule.slotMinutes, onLeave: schedule.onLeave, hoursSet, slots })
}
