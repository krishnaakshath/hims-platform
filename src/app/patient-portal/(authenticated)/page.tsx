import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Pill, Stethoscope, CalendarCheck, FileText, MessageSquare, ArrowRight, Megaphone, Users, Stamp } from 'lucide-react'
import { requirePatientSessionOrRedirect } from '@/lib/patient-session'
import { getPatientPortalData } from '@/lib/queries/patient-portal'
import { listBroadcastsForPatient } from '@/lib/queries/broadcasts'
import { logPatientPortalAction } from '@/lib/patient-portal-audit'
import { normalizeVisitReason } from '@/lib/notification-templates'

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const HEADING = 'mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const TILE_COLOR: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  accent: 'bg-accent/10 text-accent',
  warning: 'bg-warning/10 text-warning',
  success: 'bg-success/10 text-success',
}

// Each tile links to the page it summarizes -- a real, functional
// navigation shortcut, not a decorative stat, matching how the report
// tables elsewhere in the app made rows clickable rather than inert.
function SummaryTile({ icon: Icon, value, label, color, href }: { icon: React.ComponentType<{ className?: string }>; value: string | number; label: string; color: keyof typeof TILE_COLOR; href?: string }) {
  const content = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE_COLOR[color]}`} aria-hidden="true">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-bold text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </>
  )
  const className = 'flex items-center gap-3 rounded-xl border border-primary/10 bg-card/80 p-3.5 shadow-sm backdrop-blur-sm transition-all duration-200 hover:border-primary/25 hover:shadow-md'
  return href ? <Link href={href} className={`${className} hover:-translate-y-0.5`}>{content}</Link> : <div className={className}>{content}</div>
}

export default async function PatientPortalOverviewPage() {
  const session = await requirePatientSessionOrRedirect()
  const data = await getPatientPortalData(session.patientId)
  if (!data) notFound()

  const broadcasts = await listBroadcastsForPatient(session.patientId)
  await logPatientPortalAction('viewed patient portal overview', session.patientId)

  const nextAppointment = data.upcomingAppointments[0]
  const formsToComplete = data.forms.filter((f) => f.status !== 'completed')
  const hasActionItems = Boolean(nextAppointment) || formsToComplete.length > 0

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Welcome back</h1>

      {hasActionItems && (
        <div data-testid="patient-action-items" className="grid gap-4 sm:grid-cols-2">
          {nextAppointment && (
            <Link href="/patient-portal/appointments" className={`${SECTION} group flex items-center justify-between transition-all duration-200 hover:border-primary/25 hover:shadow-md`}>
              <div>
                <h2 className={HEADING}>Your next visit</h2>
                <p className="text-sm font-medium text-foreground">{normalizeVisitReason(nextAppointment.visitReason)} with {nextAppointment.providerName}</p>
                <p className="text-xs text-muted-foreground">{new Date(nextAppointment.startsAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          )}
          {formsToComplete.length > 0 && (
            <Link href="/patient-portal/forms" className={`${SECTION} group flex items-center justify-between transition-all duration-200 hover:border-primary/25 hover:shadow-md`}>
              <div>
                <h2 className={HEADING}>Needs your attention</h2>
                <p className="text-sm font-medium text-foreground">{formsToComplete.length} form{formsToComplete.length === 1 ? '' : 's'} waiting on you</p>
                <p className="text-xs text-muted-foreground">{formsToComplete[0].templateName}{formsToComplete.length > 1 ? ` and ${formsToComplete.length - 1} more` : ''}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      )}

      <div data-testid="patient-summary-tiles" className="grid grid-cols-2 gap-3 sm:grid-cols-6">
        <SummaryTile icon={Stethoscope} value={data.currentProvider ?? 'Unassigned'} label="Care team" color="primary" />
        <SummaryTile icon={Pill} value={data.activeMedications.length} label="Current meds" color="accent" href="/patient-portal/medications" />
        <SummaryTile icon={FileText} value={formsToComplete.length} label="Forms to complete" color="warning" href="/patient-portal/forms" />
        <SummaryTile icon={CalendarCheck} value={data.upcomingAppointments.length} label="Upcoming visits" color="accent" href="/patient-portal/appointments" />
        <SummaryTile icon={MessageSquare} value={data.unreadMessageCount} label="New messages" color="success" href="/patient-portal/messages" />
        <SummaryTile icon={Megaphone} value={broadcasts.length} label="Announcements" color="accent" href="/patient-portal/broadcasts" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className={SECTION}>
          <h2 className={HEADING}>Your care team</h2>
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
              <Users className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-foreground">{data.currentProvider ?? 'Not yet assigned'}</p>
          </div>
        </section>
        <section className={SECTION}>
          <h2 className={HEADING}>Diagnoses on file</h2>
          {data.diagnoses.length === 0 ? (
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
                <Stamp className="h-5 w-5" />
              </span>
              <p className="text-sm text-muted-foreground">No diagnoses on file.</p>
            </div>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {data.diagnoses.map((d, i) => (
                <li key={i} className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1.5 text-xs font-medium text-foreground">
                  <span className="text-primary">{d.code}</span> — {d.description}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
