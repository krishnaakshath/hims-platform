import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { SCHEDULING_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listActiveProviders } from '@/lib/queries/providers'
import { listAppointmentsInRange, type AppointmentWithDetails } from '@/lib/queries/appointments'
import { getPickedPatient } from '@/lib/queries/search' // Wave C
import { addDays, addMonths, formatDateParam, getMonthGridDays, getViewRange, getWeekDays, isSameDay, istDayOfMonth, istMonthIndex, parseDateParam, type CalendarView } from '@/lib/calendar-dates'
import { formatIstDate, formatIstMonthYear, formatIstTime, formatIstWeekdayDay } from '@/lib/india-time'
import { MiniCalendar } from '@/components/MiniCalendar'
import { CalendarProviderFilter } from '@/components/CalendarProviderFilter'
import { CalendarNewEventButton } from '@/components/CalendarNewEventButton'
import { AppointmentStatusSelect } from '@/components/AppointmentStatusSelect'
import { ProviderDot } from '@/components/ProviderDot'

function parseView(param: string | undefined): CalendarView {
  return param === 'day' || param === 'week' || param === 'month' ? param : 'week'
}

function parseProviderIdsParam(param: string | undefined): number[] | undefined {
  if (param === undefined) return undefined
  if (param === '') return []
  return param.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

function buildCalendarHref(view: CalendarView, date: Date, providerIdsParam: string | undefined): string {
  const params = new URLSearchParams()
  params.set('view', view)
  params.set('date', formatDateParam(date))
  if (providerIdsParam !== undefined) params.set('providerIds', providerIdsParam)
  return `/calendar?${params.toString()}`
}

// All calendar times and day groupings are IST (src/lib/calendar-dates.ts).
function formatTime(date: Date | string): string {
  return formatIstTime(date)
}

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ view?: string; date?: string; providerIds?: string; book?: string }> }) {
  // Must be the first statement — see the comment in patients/page.tsx.
  const session = await requireSessionOrRedirect()
  if (!SCHEDULING_ROLES.includes(session.role)) redirect('/')

  const { view: viewParam, date: dateParam, providerIds: providerIdsParam, book: bookParam } = await searchParams
  const view = parseView(viewParam)
  const anchor = parseDateParam(dateParam)
  const explicitProviderIds = parseProviderIdsParam(providerIdsParam)

  // Wave C: no whole patient list for the New Event modal (it uses the
  // PatientPicker); ?book=<chart id> preselects one patient (quick path).
  const bookId = typeof bookParam === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(bookParam) ? bookParam : null
  const [allProviders, bookPatient] = await Promise.all([listActiveProviders(), bookId ? getPickedPatient(bookId) : Promise.resolve(null)])
  const selectedProviderIds = explicitProviderIds ?? allProviders.map((p) => p.id)

  const { start, end } = getViewRange(view, anchor)
  const appointmentsInRange = await listAppointmentsInRange(start, end, explicitProviderIds)

  await logAudit(session, 'viewed calendar', null)

  const providerOptions = allProviders.map((p) => ({ id: p.id, name: p.name, colorTag: p.colorTag }))

  const today = new Date()
  const prevAnchor = view === 'day' ? addDays(anchor, -1) : view === 'week' ? addDays(anchor, -7) : addMonths(anchor, -1)
  const nextAnchor = view === 'day' ? addDays(anchor, 1) : view === 'week' ? addDays(anchor, 7) : addMonths(anchor, 1)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
        <CalendarNewEventButton providers={providerOptions} defaultDate={formatDateParam(anchor)} initialPatient={bookPatient} />
      </div>

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Link href={buildCalendarHref(view, prevAnchor, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Previous</Link>
          <Link href={buildCalendarHref(view, today, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Today</Link>
          <Link href={buildCalendarHref(view, nextAnchor, providerIdsParam)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">Next</Link>
          <span className="ml-2 text-sm font-medium text-foreground">
            {view === 'month' ? formatIstMonthYear(anchor) : view === 'day' ? formatIstDate(start) : `${formatIstDate(start)} – ${formatIstDate(end)}`} <span className="text-xs font-normal text-muted-foreground">(IST)</span>
          </span>
        </div>
        <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
          {(['day', 'week', 'month'] as const).map((v) => (
            <Link key={v} href={buildCalendarHref(v, anchor, providerIdsParam)} className={`rounded-md px-3 py-1.5 font-medium capitalize transition-colors ${view === v ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>{v}</Link>
          ))}
        </div>
      </div>

      <div className="flex gap-6">
        <aside className="w-56 shrink-0 space-y-6">
          <MiniCalendar anchor={anchor} providerIdsParam={providerIdsParam} />
          <CalendarProviderFilter providers={providerOptions} selectedIds={selectedProviderIds} />
        </aside>

        <div className="flex-1">
          {view === 'day' && <DayView date={anchor} appointments={appointmentsInRange} />}
          {view === 'week' && <WeekView anchor={anchor} appointments={appointmentsInRange} providerIdsParam={providerIdsParam} />}
          {view === 'month' && <MonthView anchor={anchor} appointments={appointmentsInRange} providerIdsParam={providerIdsParam} />}
        </div>
      </div>
    </div>
  )
}

function DayView({ date, appointments }: { date: Date; appointments: AppointmentWithDetails[] }) {
  const dayAppointments = appointments
    .filter((a) => isSameDay(new Date(a.startsAt), date))
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())

  if (dayAppointments.length === 0) {
    return <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No appointments to show.</p>
  }

  return (
    <div className="space-y-2">
      {dayAppointments.map((a) => (
        <div key={a.id} className="flex items-center justify-between gap-4 rounded-md border border-border bg-card p-4 shadow-none">
          <div className="flex items-center gap-4">
            <div className="w-24 shrink-0 text-sm font-semibold tabular-nums text-foreground">{formatTime(a.startsAt)}</div>
            <div>
              <Link href={`/patients/${a.patientId}`} className="font-medium text-primary hover:underline">{a.patientName}</Link>
              <p className="text-xs text-muted-foreground">{a.visitReason}</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-2 text-sm text-foreground"><ProviderDot colorTag={a.providerColorTag} />{a.providerName}</span>
            <AppointmentStatusSelect appointmentId={a.id} status={a.status} />
          </div>
        </div>
      ))}
    </div>
  )
}

function WeekView({ anchor, appointments, providerIdsParam }: { anchor: Date; appointments: AppointmentWithDetails[]; providerIdsParam: string | undefined }) {
  const days = getWeekDays(anchor)
  return (
    <div className="grid grid-cols-7 gap-3">
      {days.map((day) => {
        const dayAppointments = appointments
          .filter((a) => isSameDay(new Date(a.startsAt), day))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        return (
          <div key={day.toISOString()} className="rounded-lg border border-border bg-card p-2">
            <Link href={buildCalendarHref('day', day, providerIdsParam)} className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-primary">
              {formatIstWeekdayDay(day)}
            </Link>
            {dayAppointments.length === 0 ? (
              <p className="text-xs text-muted-foreground">No appointments to show.</p>
            ) : (
              <ul className="space-y-1.5">
                {dayAppointments.map((a) => (
                  <li key={a.id} className="rounded-md border border-border p-1.5 text-xs">
                    <div className="font-medium text-foreground">{formatTime(a.startsAt)}</div>
                    <Link href={`/patients/${a.patientId}`} className="text-primary hover:underline">{a.patientName}</Link>
                    <div className="flex items-center gap-1 text-muted-foreground"><ProviderDot colorTag={a.providerColorTag} />{a.providerName}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

function MonthView({ anchor, appointments, providerIdsParam }: { anchor: Date; appointments: AppointmentWithDetails[]; providerIdsParam: string | undefined }) {
  const days = getMonthGridDays(anchor)
  const currentMonth = istMonthIndex(anchor)
  const MAX_VISIBLE = 3

  return (
    <div className="grid grid-cols-7 gap-1">
      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
        <div key={d} className="p-1 text-center text-xs font-semibold uppercase tracking-wide text-muted-foreground">{d}</div>
      ))}
      {days.map((day) => {
        const inMonth = istMonthIndex(day) === currentMonth
        const dayAppointments = appointments
          .filter((a) => isSameDay(new Date(a.startsAt), day))
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
        const visible = dayAppointments.slice(0, MAX_VISIBLE)
        const overflow = dayAppointments.length - visible.length

        return (
          <Link
            key={day.toISOString()}
            href={buildCalendarHref('day', day, providerIdsParam)}
            className={`min-h-24 rounded-md border border-border p-1.5 text-xs transition-colors hover:border-primary ${inMonth ? 'bg-card' : 'bg-muted/40 text-muted-foreground'}`}
          >
            <div className="mb-1 font-medium">{istDayOfMonth(day)}</div>
            <ul className="space-y-0.5">
              {visible.map((a) => (
                <li key={a.id} className="flex items-center gap-1 truncate">
                  <ProviderDot colorTag={a.providerColorTag} />
                  <span className="truncate">{formatTime(a.startsAt)} {a.patientName}</span>
                </li>
              ))}
            </ul>
            {overflow > 0 && <div className="text-muted-foreground">+{overflow} more</div>}
          </Link>
        )
      })}
    </div>
  )
}
