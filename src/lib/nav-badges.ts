import type { Session } from '@/lib/auth'
import type { NavBadges } from '@/components/LeftNav'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { countPendingAssignmentsForProvider, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'
import { getUnreadCountForProvider } from '@/lib/queries/messages'
import { countPendingBookingRequests } from '@/lib/queries/booking-requests'
// Wave E P1-25: work-queue badges. Each reuses the KPI loader behind the tile on the
// page it points to (cached a few seconds), so the badge and the tile agree.
import {
  countResultsToVerifyForProvider, getBillingQueue, getClaimAgeing, getFollowUpBuckets, getLabKpis, getPharmacyKpis,
} from '@/lib/queries/hospital-kpis'
import { listCodingWorklist } from '@/lib/queries/coding-worklist'
import { parseCodingWorklistParams } from '@/lib/coding/worklist'
import { listCollectorRoute } from '@/lib/queries/home-collections'
import { FOLLOW_UP_WORKLIST_ROLES } from '@/lib/role-policy'
import { todayIsoIn } from '@/lib/india-time'
// end Wave E

// Each badge only for the roles whose LeftNav shows that href (and whose page
// gate admits them); every count is an existing single count(*) query.
const DECLINE_BADGE_ROLES: Session['role'][] = ['frontdesk', 'admin', 'crc']
// Wave B P1-25 -- LeftNav /messages and /booking-requests roles.
const MESSAGES_BADGE_ROLES: Session['role'][] = ['crc', 'pi', 'admin', 'pharmacy']
const BOOKING_BADGE_ROLES: Session['role'][] = ['frontdesk', 'admin', 'crc', 'pi']

export interface NavBadgesResult {
  badges: NavBadges
  /** True when computing failed: `badges` is then {} and says nothing about
   *  the real counts (callers should keep what they last showed). */
  degraded: boolean
}

/** Count pills for the dashboard LeftNav, keyed by nav href.
 *
 *  A key's value is the count, or an explicit `null` when that badge is
 *  intentionally suppressed -- a doctor whose session resolves to no
 *  provider gets `{'/doctor': null}` rather than a misleading 0 (the /doctor
 *  page shows the explicit "couldn't match" warning instead). Roles with no
 *  badge get {} and run no query.
 *
 *  Never throws: this runs in the dashboard layout, where an error would
 *  500 every dashboard page (an error.tsx below the layout can't catch it).
 *  On failure the result is `{badges: {}, degraded: true}` -- never a
 *  guessed number. */
export async function loadNavBadges(session: Session): Promise<NavBadgesResult> {
  try {
    return { badges: await computeNavBadges(session), degraded: false }
  } catch (err) {
    console.error('Failed to compute nav badges', err)
    return { badges: {}, degraded: true }
  }
}

/** loadNavBadges without the degraded flag, for the layout's initial render. */
export async function getNavBadges(session: Session): Promise<NavBadges> {
  return (await loadNavBadges(session)).badges
}

async function computeNavBadges(session: Session): Promise<NavBadges> {
  const role = session.role
  const entries: Promise<[string, number | null]>[] = []
  if (role === 'pi') {
    // Both pi badges hang off the matched provider row; unmatched = suppressed (null), never 0.
    const provider = resolveDoctorQueueProvider(session)
    entries.push(provider.then(async (p): Promise<[string, number | null]> => ['/doctor', p ? await countPendingAssignmentsForProvider(p.id) : null]))
    // Wave E: results on this doctor's own orders waiting for verification (doctor home "Results to verify").
    entries.push(provider.then(async (p): Promise<[string, number | null]> => ['/labs', p ? await countResultsToVerifyForProvider(p.id) : null]))
  }
  if (DECLINE_BADGE_ROLES.includes(role)) entries.push(countUnacknowledgedDeclines().then((n) => ['/front-desk/assignments', n]))
  if (MESSAGES_BADGE_ROLES.includes(role)) entries.push(getUnreadCountForProvider().then((n) => ['/messages', n]))
  if (BOOKING_BADGE_ROLES.includes(role)) entries.push(countPendingBookingRequests().then((n) => ['/booking-requests', n]))
  // Wave E P1-25: role work queues (same numbers as the tiles on the target page).
  // Recall: due + overdue (the "Follow-ups to recall" tile on the overview homes).
  if (FOLLOW_UP_WORKLIST_ROLES.includes(role)) entries.push(getFollowUpBuckets().then((b) => ['/front-desk/follow-ups', b.due + b.overdue]))
  // Labs bench: orders before a result (awaiting collection + in transit + at the bench tiles).
  if (role === 'labs') entries.push(getLabKpis().then((l) => ['/labs', l.awaitingCollection + l.inTransit + l.atBench]))
  if (role === 'pharmacy') {
    entries.push(getPharmacyKpis().then((p) => ['/pharmacy', p.outOfStock]))
    entries.push(getPharmacyKpis().then((p) => ['/pharmacy/billing', p.unbilledDispenses]))
  }
  if (role === 'billing') {
    entries.push(getBillingQueue().then((q) => ['/billing/charges', q.pendingApprovalCharges]))
    entries.push(getBillingQueue().then((q) => ['/billing/invoices', q.draftInvoices]))
  }
  // Coder: the /coding worklist's default (pending) total, scoped exactly as the page scopes it.
  if (role === 'coder') entries.push(listCodingWorklist(parseCodingWorklistParams({}), session).then((w) => ['/coding', w.total]))
  // Collector: own stops still to collect today. A session without a user id has no route (0).
  if (role === 'collector') {
    entries.push(session.userId === null
      ? Promise.resolve(['/collections', 0])
      : listCollectorRoute(session.userId, todayIsoIn()).then((stops) => ['/collections', stops.filter((s) => s.status === 'booked').length]))
  }
  if (role === 'rcm') {
    entries.push(getClaimAgeing().then((c) => ['/rcm/claims', c.queried]))
    entries.push(getClaimAgeing().then((c) => ['/rcm/preauths', c.preauthsOverdue]))
  }
  // end Wave E
  return Object.fromEntries(await Promise.all(entries))
}
