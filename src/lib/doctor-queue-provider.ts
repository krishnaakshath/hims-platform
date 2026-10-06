import type { Session } from '@/lib/auth'
import { resolveSessionProvider } from '@/lib/provider-identity'
import { matchProviderByName } from '@/lib/provider-match'
import { listActiveProviders } from '@/lib/queries/providers'

/** Resolves which provider a session acts as -- the single resolver behind
 *  every pi ownership check (telemedicine create/signal/end and call page,
 *  inpatient discharge/transfer, lab-order attribution, Front Desk
 *  schedule/decline) and the doctor page / nav badge queue, so they all agree.
 *
 *  Order: the real users -> staffMembers -> providers link first; otherwise
 *  the strict name fallback in provider-match.ts (exact surname equality,
 *  null on zero or multiple matches). This fallback is the deliberate choice
 *  provider-identity.ts says belongs at the call site. Returns null when
 *  neither resolves; ownership callers must treat null as a denial, and
 *  display callers must show it as "unknown", never as an empty queue. */
export async function resolveDoctorQueueProvider(session: Session): Promise<{ id: number; name: string } | null> {
  const resolved = await resolveSessionProvider(session)
  if (resolved) return resolved
  return matchProviderByName(session.name, await listActiveProviders())
}
