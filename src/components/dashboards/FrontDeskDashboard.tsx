import Link from 'next/link'
import { ClipboardCheck, BedDouble, CalendarClock, IdCard, ArrowRight } from 'lucide-react'
import type { Session } from '@/lib/auth'
import { PortalTileLink } from '@/components/PortalTileLink'
import { CountUp } from '@/components/CountUp'
import { listAvailableRooms } from '@/lib/queries/rooms'
import { listTodaysAssignments, countAllPendingAssignments } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { listBookingRequests } from '@/lib/queries/booking-requests'
import { listExpiringOrExpiredCredentials } from '@/lib/queries/staff-credentials'
import { CheckInButton } from '@/components/CheckInButton'
import { AssignmentStatusChip } from '@/components/AssignmentStatusChip'
import { PatientAvatar } from '@/components/PatientAvatar'

const URGENCY_ORDER = { emergency: 0, urgent: 1, routine: 2 } as const

const CARD_SURFACE = 'rounded-md border border-border bg-card shadow-none'

const MINI_TILE_BASE = 'flex items-center gap-3 rounded-md border border-border bg-card p-4'
const MINI_TILE_LINK_CLASS = `${MINI_TILE_BASE} transition-colors duration-200 hover:bg-muted/40`

// `href` is optional: a tile for a page this role cannot open (e.g. the staff
// directory, which front desk is not allowed into) renders as a plain div.
function MiniStatTile({ value, label, href, icon: Icon }: { value: number; label: string; href?: string; icon: React.ComponentType<{ className?: string }> }) {
  const content = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary" aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-primary"><CountUp to={value} /></p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </>
  )
  if (!href) return <div className={MINI_TILE_BASE}>{content}</div>
  return (
    <PortalTileLink href={href} spotlightColor="rgba(61, 79, 143, 0.1)" className={MINI_TILE_LINK_CLASS}>
      {content}
    </PortalTileLink>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

function EmptyRow({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

export async function FrontDeskDashboard({ session }: { session: Session }) {
  // The table lists today's assignments only -- listAllAssignments() (used
  // by the full /front-desk/assignments history page) would list every
  // assignment ever created. The "Pending Assignments" tile, though, links
  // to that page and counts every still-pending one regardless of the day it
  // was created (Task 17: a pending assignment from yesterday read as 0).
  const [rooms, assignments, pendingCount, providers, bookingRequests, expiringCredentials] = await Promise.all([
    listAvailableRooms(),
    listTodaysAssignments(),
    countAllPendingAssignments(),
    listActiveProviders(),
    listBookingRequests(),
    listExpiringOrExpiredCredentials(),
  ])
  const providerName = (id: number) => providers.find((p) => p.id === id)?.name ?? `Provider #${id}`
  const sortedAssignments = [...assignments].sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency])
  // Count every pending request; only the preview list is capped at 5.
  const pendingBookingRequests = bookingRequests.filter((r) => r.status === 'pending')
  const pendingBookingPreview = pendingBookingRequests.slice(0, 5)

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s what needs your attention today.</p>
        </div>
        <div className="flex gap-3">
          <CheckInButton providers={providers} rooms={rooms} />
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <MiniStatTile value={pendingCount} label="Pending Assignments" href="/front-desk/assignments" icon={ClipboardCheck} />
        <MiniStatTile value={rooms.length} label="Rooms Available" href="/inpatient/beds" icon={BedDouble} />
        <MiniStatTile value={pendingBookingRequests.length} label="Pending Booking Requests" href="/booking-requests" icon={CalendarClock} />
        <MiniStatTile value={expiringCredentials.length} label="Expiring / Expired Credentials" icon={IdCard} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <section className={`${CARD_SURFACE} p-5 lg:col-span-3`}>
          <SectionHeading>Today&apos;s Assignments ({assignments.length})</SectionHeading>
          {sortedAssignments.length === 0 ? <EmptyRow text="No assignments checked in yet today." /> : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/40 text-left">
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Doctor</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Urgency</th>
                    <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedAssignments.map((a, i) => (
                    <tr key={a.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                      <td className="p-3 text-foreground">{a.patientId}</td>
                      <td className="p-3 text-foreground">{providerName(a.providerId)}</td>
                      <td className="p-3 text-foreground">{a.reason}</td>
                      <td className="p-3 capitalize text-foreground">{a.urgency}</td>
                      <td className="p-3"><AssignmentStatusChip status={a.status} declineReason={a.declineReason} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="flex flex-col gap-4 lg:col-span-2">
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

          <section className={`${CARD_SURFACE} p-5`}>
            <SectionHeading>Expiring or Expired Credentials</SectionHeading>
            {expiringCredentials.length === 0 ? <EmptyRow text="Nothing expiring or expired." /> : (
              <ul className="divide-y divide-border">
                {expiringCredentials.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <div className="flex items-center gap-3 -mx-2 rounded-lg px-2 py-2.5">
                      <PatientAvatar name={c.staffMemberName} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{c.staffMemberName}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.credentialType}</p>
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${c.status === 'expired' ? 'bg-destructive/10 text-destructive' : 'bg-warning/10 text-warning'}`}>
                        {c.status === 'expired' ? 'Expired' : `${c.daysUntilExpiry}d left`}
                      </span>
                    </div>
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
