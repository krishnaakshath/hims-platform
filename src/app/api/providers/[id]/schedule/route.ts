import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { MASTER_DATA_ADMIN_ROLES, SCHEDULING_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
import { minutesOf } from '@/lib/scheduling/slots'
import { getProviderSchedule, replaceProviderSchedule } from '@/lib/queries/provider-schedules'

// WS6 T6 (spec D5): a doctor's weekly working hours, slot length and leave days.

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const isRealDate = (s: string) => {
  const t = Date.parse(`${s}T00:00:00Z`)
  return DATE.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s
}

const sessionSchema = z.object({
  weekday: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  start: z.string().regex(HHMM, 'Use HH:MM'),
  end: z.string().regex(HHMM, 'Use HH:MM'),
}).strict().refine((s) => minutesOf(s.end) > minutesOf(s.start), { message: 'A session must end after it starts', path: ['end'] })

const scheduleSchema = z.object({
  slotMinutes: z.number().int().min(5).max(60).multipleOf(5),
  sessions: z.array(sessionSchema).max(21),
  leave: z.array(z.object({
    date: z.string().refine(isRealDate, 'Use YYYY-MM-DD'),
    reason: z.string().trim().min(1).max(120),
  }).strict()).max(60),
}).strict().superRefine((v, ctx) => {
  for (let weekday = 0; weekday <= 6; weekday++) {
    const day = v.sessions.filter((s) => s.weekday === weekday).sort((a, b) => minutesOf(a.start) - minutesOf(b.start))
    for (let i = 1; i < day.length; i++) {
      if (minutesOf(day[i].start) < minutesOf(day[i - 1].end)) {
        ctx.addIssue({ code: 'custom', path: ['sessions'], message: 'Sessions on the same day must not overlap' })
        return
      }
    }
  }
  const dates = v.leave.map((l) => l.date)
  if (new Set(dates).size !== dates.length) ctx.addIssue({ code: 'custom', path: ['leave'], message: 'Each leave date can be listed once' })
})

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const providerId = parseId((await params).id)
  if (providerId === null) return invalidIdResponse()
  const schedule = await getProviderSchedule(providerId, todayIsoIn())
  if (!schedule) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  await logAudit(session, 'viewed provider schedule', null, `provider=${providerId}`)
  return NextResponse.json(schedule)
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!MASTER_DATA_ADMIN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const providerId = parseId((await params).id)
  if (providerId === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = scheduleSchema.safeParse(json.body)
  if (!parsed.success) {
    const message = parsed.error.issues.find((i) => i.code === 'custom')?.message ?? 'Invalid working hours'
    return NextResponse.json({ error: message, details: parsed.error.flatten() }, { status: 400 })
  }

  const today = todayIsoIn()
  if (parsed.data.leave.some((l) => l.date < today)) {
    return NextResponse.json({ error: 'Leave can only be set for today or later' }, { status: 400 })
  }

  const found = await replaceProviderSchedule(providerId, parsed.data, today)
  if (!found) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
  // Ids and counts only: the leave reason is free text and never goes into the audit log.
  await logAudit(session, 'updated provider schedule', null,
    `provider=${providerId} slotMinutes=${parsed.data.slotMinutes} sessions=${parsed.data.sessions.length} leaveDays=${parsed.data.leave.length}`)
  return NextResponse.json({ ok: true })
}
