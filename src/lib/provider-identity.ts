import type { Session } from '@/lib/auth'
import { getProviderForUserId } from '@/lib/queries/staff-members'

export interface SessionProvider { id: number; name: string; credentials: string | null; specialty: string }

/** Resolves the `providers` row this session *is*, via the real
 *  users -> staffMembers -> providers link. Returns null when the session
 *  has no userId (env admin), no staff_members row, no providerId on it,
 *  the staff member is not `active`, or the provider row is not `isActive`.
 *  There is deliberately NO fuzzy-name fallback here: it returns the real
 *  link or nothing, so a caller that wants best-effort behavior makes that
 *  fail-open choice visibly, at its own call site. */
export async function resolveSessionProvider(session: Session): Promise<SessionProvider | null> {
  // `== null` deliberately catches `undefined` too: a Session object built
  // before this claim existed -- including the `{ role, name }` literals
  // that several route tests' vi.mock factories return -- has no userId
  // property at all, and must resolve to "no provider" rather than throw.
  if (session.userId == null) return null
  return getProviderForUserId(session.userId)
}
