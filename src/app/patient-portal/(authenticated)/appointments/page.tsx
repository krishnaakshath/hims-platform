import { formatCalendarDate, formatIstDate, formatIstDateTime, todayIsoIn } from '@/lib/india-time'
import { notFound } from 'next/navigation'
import { CalendarClock, BellRing } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'
import type { AppointmentStatus } from '@/lib/queries/appointments'
import { normalizeVisitReason } from '@/lib/notification-templates'
// Wave J (P1-20): booking / reschedule / cancel requests and follow-up reminders.
import { getPortalFollowUps } from '@/lib/queries/follow-ups'
import { listPortalAppointmentRequests, listPortalBookableProviders, pendingRequestAppointmentIds } from '@/lib/queries/patient-portal-records'
import { PORTAL_FOLLOW_UP_LABEL } from '@/lib/follow-ups/rules'
import { PortalAppointmentActions } from '@/components/portal/PortalAppointmentActions'
import { PortalAppointmentRequestForm } from '@/components/portal/PortalAppointmentRequestForm'

const REQUEST_KIND_LABEL = { new: 'New appointment', reschedule: 'Reschedule', cancel: 'Cancellation' } as const
const REQUEST_STATUS_LABEL = { pending: 'Waiting for the hospital', confirmed: 'Confirmed', declined: 'Not possible, please call the hospital' } as const
// end Wave J

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function AppointmentRow({ visitReason, providerName, status, dateLabel, actions }: { visitReason: string; providerName: string; status: AppointmentStatus; dateLabel: string; actions?: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true">
        <CalendarClock className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        {/* Display-only normalization: legacy stored reasons may be long or multi-line. */}
        <p className="truncate text-sm font-medium text-foreground">{normalizeVisitReason(visitReason)}</p>
        <p className="truncate text-xs text-muted-foreground">with {providerName} · {dateLabel}</p>
      </div>
      <div className="shrink-0">
        <AppointmentStatusChip status={status} />
      </div>
      {actions}
    </li>
  )
}

export default async function PatientPortalAppointmentsPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  // Wave J
  const today = todayIsoIn()
  const [followUps, requests, providers, pending] = await Promise.all([
    getPortalFollowUps(session.patientId, today),
    listPortalAppointmentRequests(session.patientId),
    listPortalBookableProviders(),
    pendingRequestAppointmentIds(session.patientId, data.upcomingAppointments.map((a) => a.id)),
  ])
  // A due or missed follow-up prefills the request form with its window (from today at the earliest).
  const toBook = followUps.find((f) => f.status === 'planned' || f.status === 'missed')
  const prefillStart = toBook ? (toBook.windowStart > today ? toBook.windowStart : today) : undefined
  const prefillEnd = toBook && prefillStart ? (toBook.windowEnd >= prefillStart ? toBook.windowEnd : prefillStart) : undefined
  // end Wave J

  await logPatientPortalAction('viewed patient portal appointments', session.patientId)

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-foreground">Appointments</h1>

      <section className={SECTION}>
        <h2 className={HEADING}>Upcoming appointments</h2>
        {data.upcomingAppointments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming appointments.</p>
        ) : (
          <ul className="space-y-2">
            {data.upcomingAppointments.map((a) => (
              <AppointmentRow
                key={a.id}
                visitReason={a.visitReason}
                providerName={a.providerName}
                status={a.status}
                dateLabel={formatIstDateTime(a.startsAt)}
                actions={a.status !== 'scheduled' ? undefined : pending.has(a.id)
                  ? <span className="w-full text-xs text-muted-foreground sm:w-auto">Change requested</span>
                  : <PortalAppointmentActions appointmentId={a.id} minDate={today} label={`appointment on ${formatIstDateTime(a.startsAt)}`} />}
              />
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION}>
        <h2 className={HEADING}>Past visits</h2>
        {data.pastAppointments.length === 0 ? (
          <p className="text-sm text-muted-foreground">No past visits on file.</p>
        ) : (
          <ul className="space-y-2">
            {data.pastAppointments.map((a) => (
              <AppointmentRow
                key={a.id}
                visitReason={a.visitReason}
                providerName={a.providerName}
                status={a.status}
                dateLabel={formatIstDate(a.startsAt)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Wave J (P1-20) */}
      <section className={SECTION} aria-labelledby="follow-up-reminders">
        <h2 id="follow-up-reminders" className={HEADING}>Follow-up reminders</h2>
        {followUps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No follow-up visits due.</p>
        ) : (
          <ul className="space-y-2">
            {followUps.map((f, i) => (
              <li key={`${f.dueDate}-${i}`} className="flex items-start gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning" aria-hidden="true">
                  <BellRing className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{PORTAL_FOLLOW_UP_LABEL[f.status]}</p>
                  <p className="text-xs text-muted-foreground">
                    {f.status === 'scheduled' && f.appointmentStartsAt
                      ? `${formatIstDateTime(f.appointmentStartsAt)} with ${f.doctorName ?? 'your doctor'}`
                      : `Please visit between ${formatCalendarDate(f.windowStart)} and ${formatCalendarDate(f.windowEnd)}${f.doctorName ? ` (${f.doctorName})` : ''}`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={SECTION} aria-labelledby="your-requests">
        <h2 id="your-requests" className={HEADING}>Your requests</h2>
        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No requests yet.</p>
        ) : (
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{REQUEST_KIND_LABEL[r.kind]}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.kind === 'cancel' ? `For ${formatCalendarDate(r.preferredDateRangeStart)}` : `Between ${formatCalendarDate(r.preferredDateRangeStart)} and ${formatCalendarDate(r.preferredDateRangeEnd)}`} · sent {formatIstDate(r.submittedAt)}
                  </p>
                </div>
                <span className="text-xs font-medium text-muted-foreground">{REQUEST_STATUS_LABEL[r.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section id="request-appointment" className={SECTION} aria-labelledby="request-heading">
        <h2 id="request-heading" className={HEADING}>Request an appointment</h2>
        {toBook && <p className="mb-3 text-sm text-foreground">Your follow-up visit is due. The dates below match your doctor&apos;s advice.</p>}
        <PortalAppointmentRequestForm providers={providers} minDate={today} defaultStart={prefillStart} defaultEnd={prefillEnd} defaultReason={toBook ? 'Follow-up visit' : ''} />
        <p className="mt-3 text-xs text-muted-foreground">This sends a request. The hospital confirms the exact time with you.</p>
      </section>
      {/* end Wave J */}
    </div>
  )
}
