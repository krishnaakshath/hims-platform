import { formatIstDayMonth, istYearMonthOf } from '@/lib/india-time'
import Link from 'next/link'
import { FileClock, ClipboardCheck, LayoutTemplate, Clock, Users, Star, Send, CheckCircle2, Fingerprint, Sparkles, ArrowRight, AlertTriangle, XCircle } from 'lucide-react'
import type { Session } from '@/lib/auth'
import { PortalTileLink } from '@/components/PortalTileLink'
import { CountUp } from '@/components/CountUp'
import { DashboardHomeClient } from '@/components/DashboardHomeClient'
import { DashboardAppointmentsTable, type DashboardAppointmentRow } from '@/components/DashboardAppointmentsTable'
import { PatientsByMonthChart } from '@/components/PatientsByMonthChart'
import { ScreeningBreakdownChart } from '@/components/ScreeningBreakdownChart'
import { PatientAvatar } from '@/components/PatientAvatar'
import type { ExpiringCredential } from '@/lib/queries/staff-credentials'
import type { HospitalSnapshot } from '@/lib/dashboard-tiles' // Wave E
import { HospitalOverview } from '@/components/dashboards/HospitalOverview' // Wave E
import { Tabs } from '@/components/Tabs' // Wave E
import { Tags, Building2, IdCard, History, BedDouble, CalendarSync, SlidersHorizontal, Settings2 } from 'lucide-react' // Wave E

export interface DashboardData {
  latestForms: { id: number; status: string; sentDate: Date | string | null; completedDate: Date | string | null; templateName: string; patientName: string }[]
  pendingForms: { id: number; status: string; sentDate: Date | string | null; completedDate: Date | string | null; templateName: string; patientName: string }[]
  pendingFormsTotal: number
  pendingClassification: { id: string; name: string }[]
  recentEvents: { id: number; action: string; userName: string; timestamp: Date | string }[]
  patientsByMonth: { month: string; count: number }[]
  screeningBreakdown: { green: number; yellow: number; red: number }
  peakHourRange: string | null
  avgExperienceRating: number | null
  completedReviewCount: number
  // Shared "Total Patients" definition (see getDashboardData) -- both the
  // admin and coordinator dashboards render this, never the length of the
  // `patients` picker list.
  totalPatients: number
}

export interface DashboardPageProps {
  session: Session
  data: DashboardData
  templates: { id: number; name: string }[]
  patients: { id: string; name: string }[]
  appointmentsInRange: { id: number; patientId: string; patientName: string; providerName: string; visitReason: string; status: string; startsAt: string }[]
  staffByRole: { role: string; count: number }[]
  // Optional (not just AdminDashboard-only) because this interface is
  // shared with CoordinatorDashboard, which destructures its own named
  // subset of DashboardPageProps and is never passed this field -- page.tsx
  // fetches listExpiringOrExpiredCredentials() once and hands it only to
  // AdminDashboard, per this task's brief (Task 4 §Step 2/3).
  expiringCredentials?: ExpiringCredential[]
  canStartTelemedicine: boolean
  // Wave E: live hospital KPIs, scoped to the viewing role (getHospitalSnapshot).
  hospital: HospitalSnapshot
}

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

// "expires in 12 days" / "expired 5 days ago", per this task's brief --
// daysUntilExpiry is already negative once expired (see
// listExpiringOrExpiredCredentials), so this is the one place that turns
// that signed integer into the two human-readable phrasings.
function formatExpiryPhrase(daysUntilExpiry: number): string {
  if (daysUntilExpiry < 0) {
    const daysAgo = Math.abs(daysUntilExpiry)
    return `expired ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago`
  }
  if (daysUntilExpiry === 0) return 'expires today'
  return `expires in ${daysUntilExpiry} day${daysUntilExpiry === 1 ? '' : 's'}`
}

// getDashboardData() is cached for 15s, so for a moment after a deploy the
// cached object can predate `totalPatients`. Fall back to the distinct
// patient ids in the picker list (a patient x screening join, so deduped)
// rather than rendering NaN or a blank tile.
export function resolveTotalPatients(data: { totalPatients?: number }, patients: { id: string }[]): number {
  return data.totalPatients ?? new Set(patients.map((p) => p.id)).size
}

// Wave E P1-07: hospital configuration shortcuts (every page here is admin-only or admits admin).
const CONFIG_LINKS: { href: string; label: string; sub: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { href: '/tariffs', label: 'Tariffs', sub: 'Service catalogue and price lists', icon: Tags },
  { href: '/settings', label: 'Departments & UHID', sub: 'Departments, UHID prefix, practice settings', icon: Building2 },
  { href: '/inpatient/beds', label: 'Beds & wards', sub: 'Block, unblock and clean beds', icon: BedDouble },
  { href: '/front-desk/check-in', label: 'Check-in', sub: 'OPD tokens and inpatient admits', icon: ClipboardCheck },
  { href: '/front-desk/follow-ups', label: 'Follow-up recall', sub: 'Due and overdue return visits', icon: CalendarSync },
  { href: '/billing/rules', label: 'Billing rules', sub: 'GST, rule configuration', icon: SlidersHorizontal },
  { href: '/rcm/settings', label: 'RCM settings', sub: 'ROHINI and HFR identifiers', icon: Settings2 },
  { href: '/audit-log', label: 'Audit log', sub: 'Who did what, when', icon: History },
]

function ConfigurationCard({ staffByRole }: { staffByRole: { role: string; count: number }[] }) {
  const staffTotal = staffByRole.reduce((sum, r) => sum + r.count, 0)
  return (
    <section className={`${CARD_SURFACE} p-5`}>
      <SectionHeading>Configuration</SectionHeading>
      <Link href="/staff" className="mb-2 flex items-center gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted/40">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><IdCard className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">Staff roster ({staffTotal})</span>
          <span className="block truncate text-xs text-muted-foreground">{staffByRole.filter((r) => r.count > 0).map((r) => `${r.count} ${r.role}`).join(' · ')}</span>
        </span>
      </Link>
      <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-1">
        {CONFIG_LINKS.map(({ href, label, sub, icon: Icon }) => (
          <li key={href}>
            <Link href={href} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/40">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm text-foreground">{label}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function AdminDashboard({ session, data, templates, patients, appointmentsInRange, staffByRole, expiringCredentials = [], canStartTelemedicine, hospital }: DashboardPageProps) {
  const totalPatients = resolveTotalPatients(data, patients)
  const screenedCount = data.screeningBreakdown.green + data.screeningBreakdown.yellow + data.screeningBreakdown.red
  const unscreenedCount = Math.max(totalPatients - screenedCount, 0)
  const screenedPct = totalPatients > 0 ? Math.round((screenedCount / totalPatients) * 100) : 0
  const now = new Date()
  const currentMonthLabel = data.patientsByMonth[istYearMonthOf(now).month]?.month

  const research = (
    <div>
      <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Peak Scheduling Hours</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent" aria-hidden="true"><Clock className="h-4 w-4" /></span>
          </div>
          <p className="text-2xl font-bold text-foreground">{data.peakHourRange ?? 'Not enough data yet'}</p>
          <p className="mt-1 text-xs text-muted-foreground">Busiest 2-hour window across scheduled appointments</p>
        </div>

        <div className={`${CARD_SURFACE} p-5`}>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Total Patients</span>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true"><Users className="h-4 w-4" /></span>
          </div>
          <p className="text-3xl font-bold tabular-nums text-foreground">{totalPatients}</p>
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
          <p className="text-3xl font-bold tabular-nums text-foreground">{data.avgExperienceRating !== null ? data.avgExperienceRating.toFixed(1) : '—'}</p>
          <p className="mt-1 text-xs text-muted-foreground">{data.completedReviewCount} completed experience survey{data.completedReviewCount === 1 ? '' : 's'}</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Patients Added ({istYearMonthOf(now).year})</SectionHeading>
          <PatientsByMonthChart data={data.patientsByMonth} highlightMonth={currentMonthLabel} />
        </section>
        <section className={`${CARD_SURFACE} p-5 lg:col-span-2`}>
          <SectionHeading>Screening Status Breakdown</SectionHeading>
          <ScreeningBreakdownChart breakdown={data.screeningBreakdown} />
        </section>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStatTile value={data.pendingFormsTotal} label="Pending Forms" href="/client-forms" icon={FileClock} />
        <MiniStatTile value={data.pendingClassification.length} label="Pending Classifications" href="/patients" icon={ClipboardCheck} />
        <MiniStatTile value={templates.length} label="Form Templates" href="/forms" icon={LayoutTemplate} />
        <MiniStatTile value={totalPatients} label="Total Patients" href="/patients" icon={Users} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
              {data.pendingClassification.map((p) => (
                <li key={p.id}>
                  <Link href={`/patients/${p.id}`} className="flex items-center gap-3 py-2.5 transition-colors hover:bg-secondary/40 -mx-2 px-2 rounded-lg">
                    <PatientAvatar name={p.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      <p className="truncate text-xs text-muted-foreground">Intake complete, awaiting classification</p>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )

  const operations = (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                  <span className="shrink-0 text-xs text-muted-foreground">{formatIstDayMonth(e.timestamp)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className={`${CARD_SURFACE} p-5`}>
        <SectionHeading>Credential Expiry</SectionHeading>
        {expiringCredentials.length === 0 ? <EmptyRow text="No credentials expiring soon." /> : (
          <ul className="divide-y divide-border">
            {expiringCredentials.map((c) => {
              const expired = c.status === 'expired'
              const Icon = expired ? XCircle : AlertTriangle
              const iconColor = expired ? 'bg-destructive/10 text-destructive' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              return (
                <li key={c.id} className="flex items-center gap-3 py-2.5">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconColor}`} aria-hidden="true"><Icon className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{c.staffMemberName}</p>
                    <p className="truncate text-xs text-muted-foreground">{c.credentialType}</p>
                  </div>
                  <span className={`shrink-0 text-xs font-medium ${expired ? 'text-destructive' : 'text-amber-600 dark:text-amber-400'}`}>
                    {expired ? 'Expired · ' : 'Expiring · '}{formatExpiryPhrase(c.daysUntilExpiry)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what&apos;s happening across the hospital today.</p>
        </div>
        <DashboardHomeClient templates={templates} patients={patients} />
      </div>

      {/* Wave E P1-07: live hospital KPIs first; the trial widgets move to the Research tab. */}
      <HospitalOverview role={session.role} hospital={hospital} />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-2`}>
          {/* DashboardPageProps widens `status` to `string`; listAppointmentsInRange() rows are real AppointmentStatus values. */}
          <DashboardAppointmentsTable appointments={appointmentsInRange as DashboardAppointmentRow[]} canStartTelemedicine={canStartTelemedicine} />
        </section>
        <ConfigurationCard staffByRole={staffByRole} />
      </div>

      <Tabs tabs={[
        { id: 'operations', label: 'Operations', content: operations },
        { id: 'research', label: 'Research', content: research },
      ]} />
    </div>
  )
}
