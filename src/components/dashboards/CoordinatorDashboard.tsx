import Link from 'next/link'
import { FileClock, ClipboardCheck, LayoutTemplate, Clock, Users, Star, Send, CheckCircle2, Fingerprint, Sparkles, ArrowRight } from 'lucide-react'
import { resolveTotalPatients, type DashboardPageProps } from '@/components/dashboards/AdminDashboard'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
import { DashboardAppointmentsTable, type DashboardAppointmentRow } from '@/components/DashboardAppointmentsTable'
import { PatientsByMonthChart } from '@/components/PatientsByMonthChart'
import { ScreeningBreakdownChart } from '@/components/ScreeningBreakdownChart'
import { PatientAvatar } from '@/components/PatientAvatar'
import { PortalTileLink } from '@/components/PortalTileLink'
import { CountUp } from '@/components/CountUp'

const FORM_STATUS_STYLE: Record<string, string> = {
  sent: 'bg-warning/10 text-warning',
  partial: 'bg-accent/10 text-accent',
  completed: 'bg-success/10 text-success',
}

const EVENT_ICON: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string }> = {
  'sent intake form': { icon: Send, color: 'bg-accent/10 text-accent' },
  'completed intake form': { icon: CheckCircle2, color: 'bg-success/10 text-success' },
  'verified identity': { icon: Fingerprint, color: 'bg-primary/10 text-primary' },
  'ran classification': { icon: Sparkles, color: 'bg-accent/10 text-accent' },
}
const EVENT_ICON_FALLBACK = { icon: Clock, color: 'bg-muted text-muted-foreground' }

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

const CARD_SURFACE = 'rounded-md border border-border bg-card shadow-none'

function MiniStatTile({ value, label, href, icon: Icon }: { value: number; label: string; href: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <PortalTileLink href={href} spotlightColor="rgba(61, 79, 143, 0.1)" className="flex items-center gap-3 rounded-md border border-border bg-card p-4 transition-colors duration-200 hover:bg-muted/40">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-primary"><CountUp to={value} /></p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </PortalTileLink>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

export function CoordinatorDashboard({ session, data, templates, patients, appointmentsInRange, canStartTelemedicine }: DashboardPageProps) {
  const totalPatients = resolveTotalPatients(data, patients)
  const screenedCount = data.screeningBreakdown.green + data.screeningBreakdown.yellow + data.screeningBreakdown.red
  const unscreenedCount = Math.max(totalPatients - screenedCount, 0)
  const screenedPct = totalPatients > 0 ? Math.round((screenedCount / totalPatients) * 100) : 0
  const now = new Date()
  const currentMonthLabel = data.patientsByMonth[now.getMonth()]?.month

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what needs your attention today.</p>
        </div>
        <DashboardHomeClient templates={templates} patients={patients} canAddPatient={false} />
      </div>

      {/* Queues first -- a coordinator's job is triage, not analytics. */}
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStatTile value={data.pendingFormsTotal} label="Pending Forms" href="/client-forms" icon={FileClock} />
        <MiniStatTile value={data.pendingClassification.length} label="Pending Classifications" href="/patients" icon={ClipboardCheck} />
        <MiniStatTile value={templates.length} label="Form Templates" href="/forms" icon={LayoutTemplate} />
        <MiniStatTile value={totalPatients} label="Total Patients" href="/patients" icon={Users} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Forms</SectionHeading>
          {data.pendingForms.length === 0 ? <EmptyRow text="No pending forms." /> : (
            <ul className="divide-y divide-border">
              {data.pendingForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${FORM_STATUS_STYLE[f.status] ?? 'bg-muted text-muted-foreground'}`}>{f.status}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Pending Classifications</SectionHeading>
          {data.pendingClassification.length === 0 ? <EmptyRow text="Everything's been classified." /> : (
            <ul className="divide-y divide-border">
              {data.pendingClassification.map((p) => {
                const name = p.name
                return (
                  <li key={p.id}>
                    <Link href={`/patients/${p.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                      <PatientAvatar name={name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{name}</p>
                        <p className="truncate text-xs text-muted-foreground">Intake complete, awaiting classification</p>
                      </div>
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Forms Received</SectionHeading>
          {data.latestForms.length === 0 ? <EmptyRow text="No forms received yet." /> : (
            <ul className="divide-y divide-border">
              {data.latestForms.map((f) => (
                <li key={f.id}>
                  <Link href={`/client-forms/${f.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={f.patientName} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{f.patientName}</p>
                      <p className="truncate text-xs text-muted-foreground">{f.templateName}</p>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={`${CARD_SURFACE} p-5`}>
          <SectionHeading>Latest Account Events</SectionHeading>
          {data.recentEvents.length === 0 ? <EmptyRow text="No recent activity." /> : (
            <ul className="divide-y divide-border">
              {data.recentEvents.map((e) => {
                const { icon: Icon, color } = EVENT_ICON[e.action] ?? EVENT_ICON_FALLBACK
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2.5">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${color}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{e.action}</p>
                      <p className="text-xs text-muted-foreground">{e.userName}</p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      <section className={`${CARD_SURFACE} my-6 p-5`}>
        {/* DashboardPageProps (Task 6) widens `status` to `string` so this
            component doesn't need to import the appointments query's
            AppointmentStatus union; DashboardAppointmentsTable requires that
            narrower type. The page.tsx caller always sources this array from
            listAppointmentsInRange(), whose rows are already real
            AppointmentStatus values, so this narrowing is safe. */}
        <DashboardAppointmentsTable appointments={appointmentsInRange as DashboardAppointmentRow[]} canStartTelemedicine={canStartTelemedicine} />
      </section>

      {/* Stats and charts, secondary to the queues above. */}
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Peak Scheduling Hours</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true"><Clock className="h-4 w-4" /></span>
          </div>
          <p className="text-xl font-bold text-foreground">{data.peakHourRange ?? 'Not enough data yet'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Busiest 2-hour window across scheduled appointments</p>
        </div>
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total Patients</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><Users className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">{totalPatients}</p>
          <div className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${screenedPct}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">{screenedCount} screened · {unscreenedCount} not yet screened</p>
        </div>
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Avg. Patient Experience</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-warning/10 text-warning" aria-hidden="true"><Star className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">{data.avgExperienceRating !== null ? data.avgExperienceRating.toFixed(1) : '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{data.completedReviewCount} completed experience survey{data.completedReviewCount === 1 ? '' : 's'}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Patients Added ({now.getFullYear()})</SectionHeading>
          <PatientsByMonthChart data={data.patientsByMonth} highlightMonth={currentMonthLabel} />
        </section>
        <section className={`${CARD_SURFACE} p-5 lg:col-span-2`}>
          <SectionHeading>Screening Status Breakdown</SectionHeading>
          <ScreeningBreakdownChart breakdown={data.screeningBreakdown} />
        </section>
      </div>
    </div>
  )
}
