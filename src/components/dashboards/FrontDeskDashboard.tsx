import Link from 'next/link'
import { ClipboardCheck, ArrowRight, MonitorPlay, Calculator, UserX } from 'lucide-react'
import type { Session } from '@/lib/auth'
import { listAvailableRooms } from '@/lib/queries/rooms'
import { listTodaysAssignments, countAllPendingAssignments, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { listBookingRequests } from '@/lib/queries/booking-requests'
import { getHospitalSnapshot, listPatientLabels } from '@/lib/queries/hospital-kpis'
import { hospitalTiles } from '@/lib/dashboard-tiles'
import { REGISTRATION_ROLES, TARIFF_LOOKUP_ROLES } from '@/lib/role-policy'
import { CheckInButton } from '@/components/CheckInButton'
import { AddPatientButton } from '@/components/AddPatientButton'
import { AssignmentStatusChip } from '@/components/AssignmentStatusChip'
import { PatientAvatar } from '@/components/PatientAvatar'
import { DashSection, KpiGrid, KpiTile, WardOccupancy } from '@/components/dashboards/KpiTile'

const URGENCY_ORDER = { emergency: 0, urgent: 1, routine: 2 } as const

const CARD_SURFACE = 'rounded-md border border-border bg-card shadow-none'
const ACTION_LINK = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-secondary'

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

// Wave E (P1-06): the front desk's home. Live OPD/IPD/cash-desk/recall KPIs
// (hospitalTiles, scoped to frontdesk), the assignment queue by patient name,
// UHID and token, quick actions (register, check in, queue display, price
// lookup). No staff credential data: frontdesk is barred from /staff.
export async function FrontDeskDashboard({ session }: { session: Session }) {
  // The table lists today's assignments only; the "Pending Assignments" tile
  // counts every still-pending one (what /front-desk/assignments lists), and
  // "Declines to acknowledge" is the same count as that nav entry's badge.
  const [rooms, assignments, pendingCount, declineCount, providers, bookingRequests, hospital] = await Promise.all([
    listAvailableRooms(),
    listTodaysAssignments(),
    countAllPendingAssignments(),
    countUnacknowledgedDeclines(),
    listActiveProviders(),
    listBookingRequests(),
    getHospitalSnapshot(session.role),
  ])
  const labels = new Map((await listPatientLabels(assignments.map((a) => a.patientId))).map((p) => [p.id, p]))
  const providerName = (id: number) => providers.find((p) => p.id === id)?.name ?? `Provider #${id}`
  const sortedAssignments = [...assignments].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])
  const pendingBookingPreview = bookingRequests.filter((r) => r.status === 'pending').slice(0, 5)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what needs your attention today.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {REGISTRATION_ROLES.includes(session.role) && <AddPatientButton />}
          <CheckInButton providers={providers} rooms={rooms} />
          <Link href="/display/queue" className={ACTION_LINK}><MonitorPlay className="h-4 w-4" aria-hidden="true" />Queue display</Link>
          {TARIFF_LOOKUP_ROLES.includes(session.role) && <Link href="/price-lookup" className={ACTION_LINK}><Calculator className="h-4 w-4" aria-hidden="true" />Price lookup</Link>}
        </div>
      </div>

      <KpiGrid>
        {hospitalTiles(session.role, hospital).map(({ id, ...t }) => <KpiTile key={id} {...t} />)}
        <KpiTile label="Pending Assignments" value={pendingCount} sub="Waiting for a doctor" href="/front-desk/assignments" icon={ClipboardCheck} />
        <KpiTile label="Declines to acknowledge" value={declineCount} sub="Doctor declined, patient to re-route" href="/front-desk/assignments" icon={UserX} tone={declineCount > 0 ? 'danger' : 'muted'} />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Today&apos;s Assignments ({assignments.length})</SectionHeading>
          {sortedAssignments.length === 0 ? <EmptyRow text="No assignments checked in yet today." /> : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/40 text-left">
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Token</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Urgency</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAssignments.map((a, i) => {
                    const label = labels.get(a.patientId)
                    return (
                      <tr key={a.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                        <td className="p-3 tabular-nums text-foreground">{a.queueTicketNumber > 0 ? `#${a.queueTicketNumber}` : '—'}</td>
                        <td className="p-3">
                          <p className="font-medium text-foreground">{label?.name ?? 'Unknown patient'}</p>
                          {label?.uhid && <p className="text-xs text-muted-foreground">{label.uhid}</p>}
                        </td>
                        <td className="p-3 text-foreground">{providerName(a.providerId)}</td>
                        <td className="p-3 text-foreground">{a.reason}</td>
                        <td className="p-3 capitalize text-foreground">{a.urgency}</td>
                        <td className="p-3"><AssignmentStatusChip status={a.status} declineReason={a.declineReason} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-4 lg:col-span-2">
          <DashSection title="Bed availability by ward" href="/inpatient/beds" linkLabel="Bed board">
            <WardOccupancy wards={hospital.ipd.wards} />
          </DashSection>

          <section className={`${CARD_SURFACE} p-5`}>
            <SectionHeading>Pending Booking Requests</SectionHeading>
            {pendingBookingPreview.length === 0 ? <EmptyRow text="No pending booking requests." /> : (
              <ul className="divide-y divide-border">
                {pendingBookingPreview.map((r) => (
                  <li key={r.id}>
                    <Link href="/booking-requests" className="flex items-center gap-3 -mx-2 rounded-lg px-2 py-2.5 transition-colors hover:bg-secondary/40">
                      <PatientAvatar name={r.requesterName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{r.requesterName}</p>
                        <p className="truncate text-xs text-muted-foreground">{r.reason}</p>
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
    </div>
  )
}
