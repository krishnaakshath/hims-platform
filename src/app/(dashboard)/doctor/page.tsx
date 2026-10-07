import { formatIstDate, formatIstDateTime, istDayBounds } from '@/lib/india-time'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Clock, AlertCircle, Activity } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { matchProviderByName } from '@/lib/provider-match'
import { listActiveProviders } from '@/lib/queries/providers'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listPendingAssignmentsForProvider } from '@/lib/queries/doctor-assignments'
import { listAppointmentsInRange } from '@/lib/queries/appointments'
import { listWorklist } from '@/lib/queries/lab-orders'
import { listFormSubmissions } from '@/lib/queries/form-submissions'
import { AssignmentUrgencyChip } from '@/components/AssignmentUrgencyChip'
import { AssignmentScheduleModalTrigger } from '@/components/AssignmentScheduleModal'
import { DashboardAppointmentsTable, type DashboardAppointmentRow } from '@/components/DashboardAppointmentsTable'
import { PatientsTable } from '@/components/PatientsTable'
import { DoctorScheduleTimeline } from '@/components/DoctorScheduleTimeline'
// SP6
import { listOpenCodingQueriesForProvider } from '@/lib/queries/coding-queries'
import { DoctorCodingQueries } from '@/components/coding/DoctorCodingQueries'
// end SP6

// Enterprise EMR dense layout
export default async function DoctorPortalPage() {
  const session = await requireSessionOrRedirect()
  if (session.role !== 'pi') redirect('/')

  const patients = await listPatientsWithStatus(null)
  const lastName = session.name.trim().split(/\s+/).pop() ?? session.name

  const providerMatch = await resolveDoctorQueueProvider(session)
  // `currentProvider` is free text, so it is resolved against the roster with
  // the same strict exact-surname match (never substring; ambiguous -> no
  // match) and kept only when it lands on this pi's own provider row.
  const roster = providerMatch ? await listActiveProviders() : []
  const myPatients = providerMatch
    ? patients.filter((p) => matchProviderByName(p.currentProvider ?? '', roster)?.id === providerMatch.id)
    : []
  const pendingAssignments = providerMatch ? await listPendingAssignmentsForProvider(providerMatch.id) : []
  // SP6: coding queries addressed to this doctor's own provider row (none without a match).
  const codingQueries = providerMatch ? await listOpenCodingQueriesForProvider(providerMatch.id) : []

  const now = new Date()
  // Today's IST business day, whatever zone the server runs in.
  const { start: todayStart, end: todayEnd } = istDayBounds(now)
  const rangeStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const rangeEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const myAppointments = await listAppointmentsInRange(rangeStart, rangeEnd, providerMatch ? [providerMatch.id] : [])
  const todaysCheckups = myAppointments.filter((a) => {
    const d = new Date(a.startsAt)
    return d >= todayStart && d < todayEnd
  })

  // Lab reports pending review
  const labWorklist = await listWorklist()
  const myPatientIds = new Set(myPatients.map((p) => p.id))
  const pendingLabs = labWorklist.filter((l) => myPatientIds.has(l.patientId) && l.status === 'ordered')

  // Client forms
  const completedForms = await listFormSubmissions({ status: 'completed' })
  const myForms = completedForms.filter((f) => myPatientIds.has(f.patientId)).slice(0, 10)

  await logAudit(session, 'viewed My Patients (doctor portal)', null)

  const highAcuityCount = pendingLabs.length + pendingAssignments.filter(a => a.urgency === 'urgent' || a.urgency === 'emergency').length
  const initials = session.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()

  return (
    <div className="flex flex-col gap-6">
      {/* Top EMR Header Bar */}
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-6 py-4 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="text-lg font-bold">{initials}</span>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground">Dr. {lastName}, MD</h1>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success"></span> On Shift</span>
              <span>•</span>
              <span>Principal Investigator</span>
            </div>
          </div>
        </div>
        <div className="flex gap-6">
          <div className="flex flex-col items-end border-r border-border pr-6">
            <span className="text-2xl font-bold tabular-nums text-foreground">{myPatients.length}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total Panel</span>
          </div>
          <div className="flex flex-col items-end border-r border-border pr-6">
            <span className="text-2xl font-bold tabular-nums text-foreground">{todaysCheckups.length}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Today&apos;s Visits</span>
          </div>
          <div className="flex flex-col items-end">
            <span className={`text-2xl font-bold tabular-nums ${highAcuityCount > 0 ? 'text-destructive' : 'text-foreground'}`}>{highAcuityCount}</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Action Needed</span>
          </div>
        </div>
      </div>

      {/* Main EMR Grid - 3 Columns for high density */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        
        {/* LEFT COLUMN: Urgent Clinical Action Items (Labs, Forms, Assignments) */}
        <div className="col-span-1 flex flex-col gap-6 lg:col-span-4">
          
          {/* Pending Triage / Assignments */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-warning" />
                <h3 className="text-sm font-semibold text-foreground">Triage Queue</h3>
              </div>
              {providerMatch && (
                <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-bold text-warning-foreground">{pendingAssignments.length}</span>
              )}
            </div>
            <div className="p-0">
              {!providerMatch ? (
                <p role="alert" className="p-4 text-sm text-destructive">We couldn&apos;t match your account to a provider record, so your assignment queue can&apos;t be shown. Ask an administrator to check your provider record.</p>
              ) : pendingAssignments.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">Queue clear.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {pendingAssignments.map((a) => (
                    <li key={a.id} className="flex flex-col gap-2 p-4 transition-colors hover:bg-muted/20">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-bold text-foreground">{a.patientName}</span>
                          <span className="text-xs text-muted-foreground">{a.patientId}</span>
                          {a.queueTicketNumber > 0 && <span className="text-xs text-muted-foreground">#{a.queueTicketNumber}</span>}
                        </div>
                        <AssignmentUrgencyChip urgency={a.urgency} />
                      </div>
                      <p className="text-xs text-foreground/80">{a.reason}</p>
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {a.visitType} · Assigned by {a.assignedByName} · {formatIstDateTime(a.createdAt)}
                        </span>
                        <AssignmentScheduleModalTrigger assignment={a} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* SP6: coding queries for this doctor; hidden when none are open */}
          <DoctorCodingQueries queries={codingQueries} />

          {/* Pending Lab Results */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-destructive" />
                <h3 className="text-sm font-semibold text-foreground">Lab Reports for Review</h3>
              </div>
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-bold text-destructive">{pendingLabs.length}</span>
            </div>
            <div className="p-0">
              {pendingLabs.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No pending labs.</div>
              ) : (
                <ul className="divide-y divide-border">
                  {pendingLabs.slice(0, 5).map((l) => (
                    <li key={l.id} className="flex flex-col gap-1.5 p-4 transition-colors hover:bg-muted/20">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-foreground">{l.patientName || l.patientId}</span>
                        <span className="text-[10px] font-bold uppercase text-muted-foreground">{formatIstDate(l.orderedAt)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">{l.testName}</span>
                        <Link href="/labs" className="rounded bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase text-primary hover:bg-primary/20">Review</Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {pendingLabs.length > 5 && (
                <div className="border-t border-border px-4 py-3 text-center">
                  <Link href="/labs" className="text-xs font-medium text-primary hover:underline">View all {pendingLabs.length} pending labs</Link>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* MIDDLE & RIGHT COLUMNS: Schedule & Patient Panel */}
        <div className="col-span-1 flex flex-col gap-6 lg:col-span-8">
          
          {/* Today's Schedule - Timeline View */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                <h3 className="text-base font-semibold text-foreground">Today&apos;s Schedule</h3>
              </div>
              <Link href="/calendar" className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20">
                Full Calendar
              </Link>
            </div>

            <div className="p-0">
              <DoctorScheduleTimeline appointments={todaysCheckups} />
            </div>
          </div>

          {/* Full Patient Panel */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h3 className="text-base font-semibold text-foreground">Assigned Patient Panel</h3>
            </div>
            <div className="p-0">
              <PatientsTable patients={myPatients.map((p) => ({
                id: p.id,
                overallStatus: p.overallStatus,
                name: p.name,
                dob: p.dob,
                currentProvider: p.currentProvider,
                referralType: p.referralType,
                lastCommunication: p.lastCommunication,
                criteriaSummary: p.criteriaSummary,
              }))} />
            </div>
          </div>

          {/* My Appointments -- the telemedicine start entry point lives here,
              scoped to this pi's own matched provider row, not the
              same-day-only timeline above. */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card p-5 shadow-sm">
            <h3 className="mb-3 text-base font-semibold text-foreground">My Appointments</h3>
            <DashboardAppointmentsTable
              appointments={myAppointments.map((a): DashboardAppointmentRow => ({
                id: a.id,
                patientId: a.patientId,
                patientName: a.patientName,
                providerName: a.providerName,
                visitReason: a.visitReason,
                status: a.status,
                startsAt: a.startsAt.toISOString(),
              }))}
              canStartTelemedicine={Boolean(providerMatch)}
            />
          </div>

        </div>
      </div>
    </div>
  )
}
