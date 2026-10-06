import { notFound } from 'next/navigation'
import { CalendarClock } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'
import type { AppointmentStatus } from '@/lib/queries/appointments'
import { normalizeVisitReason } from '@/lib/notification-templates'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function AppointmentRow({ visitReason, providerName, status, dateLabel }: { visitReason: string; providerName: string; status: AppointmentStatus; dateLabel: string }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
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
    </li>
  )
}

export default async function PatientPortalAppointmentsPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

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
                dateLabel={new Date(a.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
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
                dateLabel={new Date(a.startsAt).toLocaleDateString()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
