import { formatIstDate, formatIstDateTime, istDayBounds } from '@/lib/india-time'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Clock, AlertCircle, Activity, BedDouble, CalendarSync, FileSignature, Stethoscope } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { matchProviderByName } from '@/lib/provider-match'
import { listActiveProviders } from '@/lib/queries/providers'
import { logAudit } from '@/lib/audit'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { listPendingAssignmentsForProvider } from '@/lib/queries/doctor-assignments'
import { listAppointmentsInRange } from '@/lib/queries/appointments'
import { AssignmentUrgencyChip } from '@/components/AssignmentUrgencyChip'
import { AssignmentScheduleModalTrigger } from '@/components/AssignmentScheduleModal'
import { DashboardAppointmentsTable, type DashboardAppointmentRow } from '@/components/DashboardAppointmentsTable'
import { PatientsTable } from '@/components/PatientsTable'
import { DoctorScheduleTimeline } from '@/components/DoctorScheduleTimeline'
// SP6
import { listOpenCodingQueriesForProvider } from '@/lib/queries/coding-queries'
import { DoctorCodingQueries } from '@/components/coding/DoctorCodingQueries'
// end SP6
// Wave E P1-02/P1-03: the doctor's own workload (orders they placed, their OPD, inpatients, recalls, notes).
import { getDoctorWorkload, type DoctorWorkload } from '@/lib/queries/hospital-kpis'
import { ENCOUNTER_STATUS_LABEL } from '@/lib/encounters/register'
import type { EncounterStatus } from '@/lib/encounters/status'
import { formatIsoDate } from '@/lib/india-time'
// end Wave E

// Wave E: a compact titled list card for the doctor's own work queues.
function DoctorList({ title, icon: Icon, count, empty, href, linkLabel, children }: {
  title: string; icon: React.ComponentType<{ className?: string }>; count: number; empty: string; href?: string; linkLabel?: string; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">{count}</span>
        </div>
        {href && <Link href={href} className="text-xs font-medium text-primary hover:underline">{linkLabel ?? 'Open'}</Link>}
      </div>
      {count === 0 ? <div className="p-6 text-center text-sm text-muted-foreground">{empty}</div> : <ul className="max-h-80 divide-y divide-border overflow-y-auto">{children}</ul>}
    </div>
  )
}

function PatientCell({ name, uhid, href }: { patientId: string; name: string; uhid: string | null; href: string }) {
  return (
    <div className="min-w-0">
      <Link href={href} className="block truncate text-sm font-medium text-foreground hover:underline">{name}</Link>
      {uhid && <p className="text-xs text-muted-foreground">{uhid}</p>}
    </div>
  )
}

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

  // Wave E P1-02: lab work comes from the orders this doctor placed (orderedByProviderId),
  // never from the free-text panel match, and "pending" is no longer merely-ordered tests.
  const workload: DoctorWorkload | null = providerMatch ? await getDoctorWorkload(providerMatch.id, session.name) : null
  const resultsToVerify = workload?.resultsToVerify ?? []
  const criticalToVerify = resultsToVerify.filter((r) => r.flag === 'critical').length

  await logAudit(session, 'viewed My Patients (doctor portal)', null)

  const highAcuityCount = criticalToVerify + pendingAssignments.filter(a => a.urgency === 'urgent' || a.urgency === 'emergency').length
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

          {/* SP5 + Wave E P1-02: results on my own orders waiting for verification, critical first. */}
          <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center gap-2">
                <Activity className={`h-4 w-4 ${criticalToVerify > 0 ? 'text-destructive' : 'text-warning'}`} />
                <h3 className="text-sm font-semibold text-foreground">Results to verify</h3>
              </div>
              <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-bold text-warning-foreground">{resultsToVerify.length}</span>
            </div>
            {resultsToVerify.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">No results awaiting verification.</div>
            ) : (
              <ul className="divide-y divide-border">
                {resultsToVerify.slice(0, 8).map((l) => (
                  <li key={l.orderId} className="flex items-center justify-between gap-2 p-4">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        <Link href={`/patients/${l.patientId}/medical-record`} className="hover:underline">{l.patientName}</Link>
                        {l.flag === 'critical' && <span className="ml-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-destructive">Critical</span>}
                        {l.flag === 'abnormal' && <span className="ml-2 rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-bold uppercase text-warning">Abnormal</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">{l.testName} · Resulted {formatIstDateTime(l.resultedAt)}</p>
                    </div>
                    <Link href="/labs?stage=to-verify" className="rounded bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase text-primary hover:bg-primary/20">Verify</Link>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-border px-4 py-2.5 text-center text-xs text-muted-foreground">
              {workload ? `${workload.labsAwaitingResult} orders awaiting results` : 'No provider record matched'}
              {' · '}<Link href="/labs?stage=to-verify" className="font-medium text-primary hover:underline">Open lab worklist</Link>
            </div>
          </div>

          {/* Wave E P1-03: my draft (unsigned) notes. */}
          {workload && (
            <DoctorList title="Unsigned notes" icon={FileSignature} count={workload.unsignedNotes} empty="No unsigned notes.">
              {workload.draftNotes.map((n) => (
                <li key={n.noteId} className="flex items-center justify-between gap-2 px-4 py-3">
                  <PatientCell patientId={n.patientId} name={n.patientName} uhid={n.uhid} href={`/patients/${n.patientId}/medical-record`} />
                  <span className="shrink-0 text-xs text-muted-foreground">Draft · {formatIstDate(n.createdAt)}</span>
                </li>
              ))}
            </DoctorList>
          )}
          {/* end SP5 */}

        </div>

        {/* MIDDLE & RIGHT COLUMNS: Schedule & Patient Panel */}
        <div className="col-span-1 flex flex-col gap-6 lg:col-span-8">
          
          {/* Wave E P1-03: today's OPD (open tokens), my inpatients, my due/overdue recalls. */}
          {workload && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
              <DoctorList title="Today's OPD" icon={Stethoscope} count={workload.encountersToday.length} empty="No patients waiting." href={`/encounters?doctor=${providerMatch!.id}`} linkLabel="OPD register">
                {workload.encountersToday.map((e) => (
                  <li key={e.encounterId} className="flex items-center justify-between gap-2 px-4 py-3">
                    <PatientCell patientId={e.patientId} name={e.patientName} uhid={e.uhid} href={`/patients/${e.patientId}`} />
                    <span className="shrink-0 text-right text-xs text-muted-foreground">
                      <span className="block font-semibold tabular-nums text-foreground">{e.opdToken !== null ? `#${e.opdToken}` : '—'}</span>
                      {ENCOUNTER_STATUS_LABEL[e.status as EncounterStatus] ?? e.status}
                    </span>
                  </li>
                ))}
              </DoctorList>
              <DoctorList title="My inpatients" icon={BedDouble} count={workload.inpatients.length} empty="No inpatients under your care." href="/inpatient/beds" linkLabel="Bed board">
                {workload.inpatients.map((a) => (
                  <li key={a.admissionId} className="flex items-center justify-between gap-2 px-4 py-3">
                    <PatientCell patientId={a.patientId} name={a.patientName} uhid={a.uhid} href={`/patients/${a.patientId}`} />
                    <span className="shrink-0 text-right text-xs text-muted-foreground">{a.ward ?? 'No bed'}{a.bed ? ` · ${a.bed}` : ''}</span>
                  </li>
                ))}
              </DoctorList>
              <DoctorList title="Follow-ups due" icon={CalendarSync} count={workload.followUps.length} empty="No follow-ups due.">
                {workload.followUps.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2 px-4 py-3">
                    <PatientCell patientId={f.patientId} name={f.patientName} uhid={f.uhid} href={`/patients/${f.patientId}`} />
                    <span className="shrink-0 text-right text-xs">
                      <span className={`block font-semibold ${f.bucket === 'overdue' ? 'text-destructive' : 'text-warning'}`}>{f.bucket === 'overdue' ? 'Overdue' : 'Due'}</span>
                      <span className="text-muted-foreground">{formatIsoDate(f.dueDate)}</span>
                    </span>
                  </li>
                ))}
              </DoctorList>
            </div>
          )}

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
