// Wave E (P1-06, P1-07): the hospital KPI row on the admin, coordinator and
// front-desk homes. Pure (no DB): a snapshot of live KPIs in, tiles out.
//
// Each tile is shown only when the viewing role may open the page it links
// to -- the scope below mirrors those pages' own gates -- so a dashboard never
// offers a number the role cannot drill into.
import { BedDouble, CalendarClock, CalendarSync, FileText, FlaskConical, IndianRupee, Landmark, Stethoscope, Timer } from 'lucide-react'
import type { Role } from '@/lib/auth'
import {
  CASH_DESK_ROLES, CHARGE_CAPTURE_ROLES, ENCOUNTER_REGISTER_ROLES, FOLLOW_UP_WORKLIST_ROLES, LAB_WORKLIST_ROLES, RCM_ROLES,
} from '@/lib/role-policy'
import { formatPaise } from '@/lib/format'
import type { KpiTileProps } from '@/components/dashboards/KpiTile'
import { formatMinutes, formatPct } from '@/components/dashboards/KpiTile'
import type {
  BillingQueueKpi, ClaimAgeingKpi, CollectionsTodayKpi, FollowUpBucketsKpi, IpdCensusKpi, LabKpi, OpdTodayKpi,
} from '@/lib/queries/hospital-kpis'

// Gates of pages that have no named role-policy constant (inpatient/beds/page.tsx,
// booking-requests/page.tsx); dashboard-tiles.test.ts checks them against PAGE_GATES.
export const BED_BOARD_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc', 'pi']
export const BOOKING_REQUEST_ROLES: readonly Role[] = ['frontdesk', 'admin', 'crc', 'pi']
/** Roles whose home is the hospital overview (the others have their own homes). */
export const HOSPITAL_OVERVIEW_ROLES: readonly Role[] = ['admin', 'crc', 'frontdesk']

export interface HospitalSnapshot {
  opd: OpdTodayKpi
  ipd: IpdCensusKpi
  followUps: FollowUpBucketsKpi | null
  labs: LabKpi | null
  collections: CollectionsTodayKpi | null
  billing: BillingQueueKpi | null
  claims: ClaimAgeingKpi | null
  bookingRequestsPending: number | null
}

export interface SnapshotScope { opd: boolean; beds: boolean; followUps: boolean; labs: boolean; collections: boolean; billing: boolean; claims: boolean; bookingRequests: boolean }

/** Which snapshot sections a role may see: exactly the roles the linked pages admit. */
export function snapshotScope(role: Role): SnapshotScope {
  return {
    opd: ENCOUNTER_REGISTER_ROLES.includes(role),
    beds: BED_BOARD_ROLES.includes(role),
    followUps: FOLLOW_UP_WORKLIST_ROLES.includes(role),
    labs: LAB_WORKLIST_ROLES.includes(role),
    collections: CASH_DESK_ROLES.includes(role),
    billing: CHARGE_CAPTURE_ROLES.includes(role),
    claims: RCM_ROLES.includes(role),
    bookingRequests: BOOKING_REQUEST_ROLES.includes(role),
  }
}

export type HospitalTile = KpiTileProps & { id: string }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Insurer money outstanding for more than 90 days (the 91-180 and 181+ ageing buckets). */
export function over90Paise(aging: { label: string; paise: number }[]): number {
  return aging.filter((b) => b.label === '91-180' || b.label === '181+').reduce((s, b) => s + b.paise, 0)
}

export function hospitalTiles(role: Role, s: HospitalSnapshot): HospitalTile[] {
  if (!HOSPITAL_OVERVIEW_ROLES.includes(role)) return []
  const scope = snapshotScope(role)
  const tiles: HospitalTile[] = []
  if (scope.opd) {
    tiles.push({ id: 'opd', label: 'OPD tokens today', value: s.opd.tokens, sub: `${s.opd.waiting} waiting · ${s.opd.inConsultation} in consultation`, href: '/encounters', icon: Stethoscope })
  }
  if (scope.beds) {
    tiles.push({ id: 'inpatients', label: 'Inpatients', value: s.ipd.admitted, sub: `${formatPct(s.ipd.occupancyPct)} occupied · ${plural(s.ipd.available, 'bed')} free`, href: '/inpatient/beds', icon: BedDouble })
  }
  if (scope.collections && s.collections) {
    tiles.push({
      id: 'collections', label: 'Collected today', value: formatPaise(s.collections.netPaise),
      sub: `${plural(s.collections.receiptCount, 'receipt')}${s.collections.refundedPaise > 0 ? ` · ${formatPaise(s.collections.refundedPaise)} refunded` : ''}`,
      href: '/cash-desk', icon: IndianRupee, tone: 'success',
    })
  }
  if (scope.billing && s.billing) {
    tiles.push({
      id: 'billing-queue', label: 'Draft invoices', value: s.billing.draftInvoices,
      sub: `${plural(s.billing.uninvoicedLines, 'line')} not invoiced (${formatPaise(s.billing.uninvoicedPaise)})`,
      href: '/billing/invoices?status=draft', icon: FileText, tone: s.billing.draftInvoices > 0 ? 'warning' : 'primary',
    })
  }
  if (scope.followUps && s.followUps) {
    const f = s.followUps
    tiles.push({
      id: 'follow-ups', label: 'Follow-ups to recall', value: f.due + f.overdue, sub: `${f.overdue} overdue · ${f.due} due`,
      href: `/front-desk/follow-ups?bucket=${f.overdue > 0 ? 'overdue' : 'due'}`, icon: CalendarSync, tone: f.overdue > 0 ? 'warning' : 'primary',
    })
  }
  if (scope.labs && s.labs) {
    const l = s.labs
    tiles.push({
      id: 'labs-pending', label: 'Lab orders open', value: l.awaitingCollection + l.inTransit + l.atBench,
      sub: l.criticalUnverified > 0 ? `${l.criticalUnverified} critical to verify` : `${l.toVerify} to verify`,
      href: '/labs', icon: FlaskConical, tone: l.criticalUnverified > 0 ? 'danger' : 'primary',
    })
    tiles.push({ id: 'lab-tat', label: 'Median lab TAT today', value: formatMinutes(l.medianTatMinutes), sub: `${plural(l.resultedToday, 'result')} today`, href: '/labs', icon: Timer, tone: 'muted' })
  }
  if (scope.bookingRequests && s.bookingRequestsPending !== null) {
    tiles.push({ id: 'booking-requests', label: 'Booking requests', value: s.bookingRequestsPending, sub: 'Waiting to be confirmed', href: '/booking-requests', icon: CalendarClock })
  }
  if (scope.claims && s.claims) {
    tiles.push({ id: 'claims', label: 'Insurer outstanding', value: formatPaise(s.claims.outstandingPaise), sub: `${formatPaise(over90Paise(s.claims.aging))} over 90 days`, href: '/rcm', icon: Landmark, tone: 'warning' })
  }
  return tiles
}
