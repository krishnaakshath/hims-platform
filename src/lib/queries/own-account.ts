import { and, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { getAdminMfaState } from '@/lib/queries/settings'

export type MfaMethod = 'totp' | 'sms' | 'email'
export interface OwnAccount { email: string; mfaMethod: MfaMethod; phone: string | null }

const UNKNOWN: OwnAccount = { email: '', mfaMethod: 'totp', phone: null }

/** The signed-in staff member's own account, for /account and the Settings
 *  Account tab. Resolved from the session only: the env admin (userId null)
 *  lives on app settings; everyone else by `users.id`. A legacy cookie minted
 *  before `userId` existed falls back to name + role. A row whose role
 *  disagrees with the session is never returned. Never selects password or
 *  MFA secret columns. */
export async function getOwnAccount(session: Session): Promise<OwnAccount> {
  if (session.role === 'admin' && session.userId === null) {
    const adminMfa = await getAdminMfaState()
    return { email: process.env.ADMIN_EMAIL ?? '', mfaMethod: adminMfa.mfaMethod, phone: adminMfa.phone }
  }
  const cols = { email: users.email, role: users.role, mfaMethod: users.mfaMethod, phone: users.phone }
  const where = session.userId !== null
    ? eq(users.id, session.userId)
    : and(eq(users.name, session.name), eq(users.role, session.role))
  const [row] = await getDb().select(cols).from(users).where(where)
  if (!row || row.role !== session.role) return UNKNOWN
  return { email: row.email, mfaMethod: row.mfaMethod, phone: row.phone }
}
