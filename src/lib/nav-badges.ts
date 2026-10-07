import type { Session } from '@/lib/auth'
import type { NavBadges } from '@/components/LeftNav'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { countPendingAssignmentsForProvider, countUnacknowledgedDeclines } from '@/lib/queries/doctor-assignments'
import { getUnreadCountForProvider } from '@/lib/queries/messages'
import { countPendingBookingRequests } from '@/lib/queries/booking-requests'

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
    entries.push((async (): Promise<[string, number | null]> => {
      const provider = await resolveDoctorQueueProvider(session)
      return ['/doctor', provider ? await countPendingAssignmentsForProvider(provider.id) : null]
    })())
  }
  if (DECLINE_BADGE_ROLES.includes(role)) entries.push(countUnacknowledgedDeclines().then((n) => ['/front-desk/assignments', n]))
  if (MESSAGES_BADGE_ROLES.includes(role)) entries.push(getUnreadCountForProvider().then((n) => ['/messages', n]))
  if (BOOKING_BADGE_ROLES.includes(role)) entries.push(countPendingBookingRequests().then((n) => ['/booking-requests', n]))
  return Object.fromEntries(await Promise.all(entries))
}
